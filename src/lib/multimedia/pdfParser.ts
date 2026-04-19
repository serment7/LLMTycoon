// 지시 #c82b4df9 — pdfjs-dist 기반 PDF 로컬 파서.
//
// 배경
//   기존 `src/services/media/pdfLoader.ts` 는 서버(Node) 경로에서 `pdf-parse` 로
//   파일 경로를 읽는다. 본 모듈은 브라우저에서 사용자가 드롭한 File/Blob 을 서버
//   왕복 없이 바로 파싱해 `MultimediaExtractionResult` 로 돌려주는 축이다. 두 축은
//   같은 결과 모양을 공유하므로 상위 `MultimediaImportService` 는 어느 쪽이든
//   받아들인다.
//
// 설계
//   · pdfjs-dist 는 동적 import 로만 로드한다(초기 번들 크기·SSR 안전성).
//   · 테스트 가능성을 위해 `createPdfParser({ loadEngine })` 로 엔진 주입이 가능.
//     기본 구현은 pdfjs-dist/build/pdf.mjs 의 `getDocument` 를 쓴다.
//   · 워커는 호출 측(환경 설정)이 `GlobalWorkerOptions.workerSrc` 를 지정했을 때만
//     사용되며, 지정이 없어도 메인 스레드 폴백 모드로 돌아간다. 본 모듈은 워커
//     설정에 직접 의존하지 않는다.
//   · 에러 코드는 `MultimediaImportError` 축으로 수렴한다(서버 경로와 분리).

import {
  MultimediaImportError,
  type MultimediaExtractionResult,
  type MultimediaHandler,
  type MultimediaParseOptions,
  type MultimediaProgressEvent,
} from './types';

/** 단일 페이지 텍스트만 노출하는 최소 pdfjs-dist 계약 — 테스트에서 mock 하기 쉽다. */
export interface PdfJsPage {
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
}

export interface PdfJsDocument {
  numPages: number;
  getMetadata(): Promise<{
    info?: Record<string, unknown>;
    metadata?: { getAll?: () => Record<string, unknown> } | null;
  }>;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  destroy?: () => Promise<unknown> | unknown;
}

export interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
  destroy?: () => Promise<unknown> | unknown;
}

export interface PdfJsEngine {
  getDocument(params: { data: Uint8Array }): PdfJsLoadingTask;
}

export interface CreatePdfParserOptions {
  /** pdfjs-dist 대체 주입. Node 테스트는 stub 엔진을 넘겨 DOM 의존을 없앤다. */
  loadEngine?: () => Promise<PdfJsEngine>;
  /** 용량 상한(바이트). DirectivePrompt · PdfImportPanel 공용 기본 50MB. */
  maxBytes?: number;
  /** accept 오버라이드. 기본 '.pdf,application/pdf'. */
  accept?: string;
}

export const DEFAULT_PDF_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_PDF_ACCEPT = '.pdf,application/pdf';

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

async function defaultLoadEngine(): Promise<PdfJsEngine> {
  // pdfjs-dist v5 의 ESM 번들 경로. vite 는 이 동적 import 를 그대로 청크 분리한다.
  const mod = await import('pdfjs-dist/build/pdf.mjs');
  const engine = mod as unknown as { getDocument: PdfJsEngine['getDocument'] };
  return { getDocument: engine.getDocument.bind(engine) };
}

function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

function stringOrUndefined(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return input;
  // UTF-8 바이트 근사치 — 코드포인트 단위로 잘라 멀티바이트 문자가 깨지지 않게 한다.
  const encoder = new TextEncoder();
  const encoded = encoder.encode(input);
  if (encoded.length <= maxBytes) return input;
  const sliced = encoded.slice(0, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(sliced);
}

export function createPdfParser(options: CreatePdfParserOptions = {}): MultimediaHandler {
  const loadEngine = options.loadEngine ?? defaultLoadEngine;
  const maxBytes = options.maxBytes ?? DEFAULT_PDF_MAX_BYTES;
  const accept = options.accept ?? DEFAULT_PDF_ACCEPT;

  async function parse(
    input: Blob,
    opts: MultimediaParseOptions = {},
  ): Promise<MultimediaExtractionResult> {
    if (opts.signal?.aborted) {
      throw new MultimediaImportError('MULTIMEDIA_PARSE_ABORTED', 'PDF 파싱이 시작 전에 취소되었습니다.');
    }
    if (input.size > maxBytes) {
      throw new MultimediaImportError(
        'MULTIMEDIA_FILE_TOO_LARGE',
        `PDF 크기 ${input.size}B 가 상한 ${maxBytes}B 를 초과합니다.`,
      );
    }

    emit(opts.onProgress, { phase: 'open', current: 0, total: input.size });

    const buffer = await input.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (!hasMagic(bytes)) {
      throw new MultimediaImportError(
        'MULTIMEDIA_UNSUPPORTED_FORMAT',
        'PDF 매직 바이트(%PDF-) 가 없습니다.',
      );
    }

    let engine: PdfJsEngine;
    try {
      engine = await loadEngine();
    } catch (err) {
      throw new MultimediaImportError(
        'MULTIMEDIA_PARSE_FAILED',
        `pdfjs-dist 로드 실패: ${(err as Error).message}`,
        err,
      );
    }

    const task = engine.getDocument({ data: bytes });
    const abortHandler = opts.signal
      ? () => { try { void task.destroy?.(); } catch { /* noop */ } }
      : null;
    if (opts.signal && abortHandler) {
      opts.signal.addEventListener('abort', abortHandler, { once: true });
    }

    let doc: PdfJsDocument;
    try {
      doc = await task.promise;
    } catch (err) {
      if (opts.signal?.aborted) {
        throw new MultimediaImportError('MULTIMEDIA_PARSE_ABORTED', 'PDF 로딩이 취소되었습니다.');
      }
      throw new MultimediaImportError(
        'MULTIMEDIA_PARSE_FAILED',
        `PDF 문서를 여는 데 실패했습니다: ${(err as Error).message}`,
        err,
      );
    } finally {
      if (opts.signal && abortHandler) {
        try { opts.signal.removeEventListener('abort', abortHandler); } catch { /* noop */ }
      }
    }

    const pageCount = typeof doc.numPages === 'number' && doc.numPages > 0 ? doc.numPages : 0;
    const pageTexts: string[] = [];
    try {
      for (let i = 1; i <= pageCount; i += 1) {
        if (opts.signal?.aborted) {
          throw new MultimediaImportError('MULTIMEDIA_PARSE_ABORTED', 'PDF 파싱이 취소되었습니다.');
        }
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => (typeof item.str === 'string' ? item.str : ''))
          .join(' ')
          .replace(/\s+\n/g, '\n')
          .trim();
        pageTexts.push(pageText);
        emit(opts.onProgress, { phase: 'parse', current: i, total: pageCount });
      }
    } catch (err) {
      await safeDestroy(doc);
      if (err instanceof MultimediaImportError) throw err;
      throw new MultimediaImportError(
        'MULTIMEDIA_PARSE_FAILED',
        `페이지 추출 실패: ${(err as Error).message}`,
        err,
      );
    }

    let metaTitle: string | undefined;
    let metaAuthor: string | undefined;
    const extra: Record<string, string | number | boolean> = {};
    try {
      const meta = await doc.getMetadata();
      const info = (meta?.info ?? {}) as Record<string, unknown>;
      metaTitle = stringOrUndefined(info.Title);
      metaAuthor = stringOrUndefined(info.Author);
      for (const key of ['Producer', 'Creator', 'CreationDate', 'ModDate']) {
        const v = stringOrUndefined(info[key]);
        if (v) extra[key] = v;
      }
    } catch {
      // 메타데이터 실패는 본문 추출에 영향 없음 — 조용히 무시.
    }
    await safeDestroy(doc);

    const joined = pageTexts.join('\n\n').trim();
    const capped = truncateUtf8(joined, opts.maxTextBytes ?? 5 * 1024 * 1024);

    emit(opts.onProgress, { phase: 'finalize', current: 1, total: 1 });

    return {
      text: capped,
      sizeBytes: input.size,
      metadata: {
        title: metaTitle,
        author: metaAuthor,
        pageCount: pageCount || undefined,
        pageTexts: pageTexts.length > 0 ? pageTexts : undefined,
        extra: Object.keys(extra).length > 0 ? Object.freeze(extra) : undefined,
      },
    };
  }

  return {
    id: 'pdf',
    accept,
    maxBytes,
    parse,
  };
}

function emit(
  onProgress: ((ev: MultimediaProgressEvent) => void) | undefined,
  ev: MultimediaProgressEvent,
): void {
  if (!onProgress) return;
  try { onProgress(ev); } catch { /* 진행률 콜백 예외는 파싱에 영향 없음 */ }
}

async function safeDestroy(doc: PdfJsDocument): Promise<void> {
  try { await doc.destroy?.(); } catch { /* noop */ }
}
