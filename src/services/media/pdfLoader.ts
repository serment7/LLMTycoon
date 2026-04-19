// Thanos #3a049e55 — PDF 입력 로더.
// `pdf-parse` v2 (PDFParse 클래스) 를 어댑터로 사용한다. fileProcessor.ts 와 같은
// 라이브러리지만, 이쪽은 추출 결과를 PdfDocument 표준 모양으로 돌려주고 청크/타임아웃/
// 에러 코드를 강제하는 "공용 파이프라인" 진입점이다. 추후 fileProcessor 도 이 로더를
// 쓰도록 통합할 수 있다(이번 턴에는 기존 회귀 면을 건드리지 않기 위해 분리 유지).

// node:fs는 브라우저 번들에 포함되면 에러 발생 — 사용 시점에 동적 import
const getFs = () => import('node:fs').then(m => m.promises);
import path from 'node:path';

import {
  MEDIA_LOADER_DEFAULTS,
  type MediaLoaderOptions,
  type MediaPage,
  type PdfDocument,
} from '../../types/media';
import { MediaParseError } from './errors';

const PDF_MAGIC = Buffer.from('%PDF-');

/**
 * 로컬 파일 경로의 PDF 를 텍스트·페이지 단위로 추출한다.
 *
 * 에러 정책:
 *   - 파일 stat 실패 → MEDIA_PARSE_FAILED
 *   - maxBytes 초과 → MEDIA_FILE_TOO_LARGE
 *   - PDF 매직 바이트 없음 → MEDIA_UNSUPPORTED_FORMAT
 *   - timeoutMs 초과 → MEDIA_PARSE_TIMEOUT
 *   - 호출자 abort → MEDIA_PARSE_ABORTED
 *   - 그 외 라이브러리 예외 → MEDIA_PARSE_FAILED (cause 로 원본 보존)
 *
 * 진행률은 phase: 'open' → 'parse'(페이지별) → 'finalize' 로 보고된다.
 */
export async function extractPdf(
  filePath: string,
  opts: MediaLoaderOptions = {},
): Promise<PdfDocument> {
  const maxBytes = opts.maxBytes ?? MEDIA_LOADER_DEFAULTS.maxBytes;
  const maxPages = opts.maxPages ?? MEDIA_LOADER_DEFAULTS.maxPages;
  const timeoutMs = opts.timeoutMs ?? MEDIA_LOADER_DEFAULTS.timeoutMs;
  const onProgress = opts.onProgress;
  const signal = opts.signal;

  if (signal?.aborted) {
    throw new MediaParseError('MEDIA_PARSE_ABORTED', `호출자 취소: ${path.basename(filePath)}`);
  }

  const startedAt = Date.now();

  const fs = await getFs();
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    throw new MediaParseError('MEDIA_PARSE_FAILED', `파일 stat 실패: ${filePath}`, err);
  }

  if (maxBytes > 0 && stat.size > maxBytes) {
    throw new MediaParseError(
      'MEDIA_FILE_TOO_LARGE',
      `PDF 크기 ${stat.size}B 가 최대 ${maxBytes}B 를 초과합니다`,
    );
  }

  onProgress?.({ phase: 'open', current: 0, total: stat.size });

  const buffer = await fs.readFile(filePath) as Buffer;
  if (buffer.length < PDF_MAGIC.length || !buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new MediaParseError(
      'MEDIA_UNSUPPORTED_FORMAT',
      `PDF magic bytes 가 발견되지 않음: ${path.basename(filePath)}`,
    );
  }

  // pdf-parse v2 는 PDFParse 클래스 기반. fileProcessor.ts:43 와 동일 호출 형태.
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  let parseResult: { text?: string; numpages?: number };
  try {
    parseResult = await runWithTimeout(parser.getText(), timeoutMs, signal);
  } catch (err) {
    await safeDestroy(parser);
    if (err instanceof MediaParseError) throw err;
    throw new MediaParseError('MEDIA_PARSE_FAILED', `pdf-parse 실패: ${(err as Error).message}`, err);
  }
  await safeDestroy(parser);

  const pageCount = typeof parseResult?.numpages === 'number' && Number.isFinite(parseResult.numpages)
    ? parseResult.numpages
    : 0;
  const fullText = typeof parseResult?.text === 'string' ? parseResult.text : '';

  // pdf-parse 는 페이지 분리 없이 하나의 문자열로 돌려준다. form feed(\f) 가 박혀
  // 있으면 그것을 페이지 경계로 사용하고, 없으면 통째로 한 페이지로 본다(pageCount
  // 메타는 별도 보존). 이 휴리스틱은 PDF 표준이 페이지 분리자를 강제하지 않기 때문.
  const splitTexts = fullText.includes('\f')
    ? fullText.split('\f')
    : pageCount > 0 ? [fullText] : (fullText ? [fullText] : []);

  const truncated = maxPages > 0 && splitTexts.length > maxPages;
  const limited = maxPages > 0 ? splitTexts.slice(0, maxPages) : splitTexts;

  const pages: MediaPage[] = limited.map((text, idx) => {
    onProgress?.({ phase: 'parse', current: idx + 1, total: limited.length });
    return { index: idx + 1, text };
  });

  onProgress?.({ phase: 'finalize', current: 1, total: 1 });

  const joined = pages.map(p => p.text).join('\n\n').trim();
  return {
    kind: 'pdf',
    source: {
      filePath,
      sizeBytes: stat.size,
      mimeType: 'application/pdf',
      parsedAt: new Date().toISOString(),
      parserId: 'pdf-parse',
      durationMs: Date.now() - startedAt,
    },
    pageCount: pageCount || pages.length,
    pages,
    text: joined,
    truncated: truncated || undefined,
  };
}

async function safeDestroy(parser: { destroy?: () => Promise<unknown> | unknown }): Promise<void> {
  try {
    await parser.destroy?.();
  } catch {
    // destroy 실패는 결과에 영향이 없으므로 조용히 무시.
  }
}

function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && abortHandler) {
        try { signal.removeEventListener('abort', abortHandler); } catch { /* noop */ }
      }
    };
    const abortHandler = signal
      ? () => {
          cleanup();
          reject(new MediaParseError('MEDIA_PARSE_ABORTED', '호출자 취소'));
        }
      : null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new MediaParseError(
        'MEDIA_PARSE_TIMEOUT',
        `파싱이 ${timeoutMs}ms 안에 끝나지 않았습니다`,
      ));
    }, Math.max(1, timeoutMs));
    if (signal && abortHandler) signal.addEventListener('abort', abortHandler, { once: true });
    promise.then(
      value => { cleanup(); resolve(value); },
      err => { cleanup(); reject(err); },
    );
  });
}
