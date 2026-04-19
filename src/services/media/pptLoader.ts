// Thanos #3a049e55 — PPTX 입력 로더.
// PPTX 는 ZIP(PK\x03\x04) 컨테이너 안에 XML 슬라이드/노트가 들어 있는 형식이다.
// 텍스트 추출에는 `officeparser` 또는 동등 라이브러리가 필요하다. 본 턴에는 새로운
// npm 의존성을 추가하지 않으므로, 어댑터 미설치 상태에서는 형식 검증을 통과한 직후
// MEDIA_UNSUPPORTED_FORMAT 으로 빠르게 실패한다. 어댑터를 추가하는 후속 PR 은
// `parsePptxAdapter` 함수만 채워 넣으면 된다(아래 NOTE 블록 참고).

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  MEDIA_LOADER_DEFAULTS,
  type MediaLoaderOptions,
  type PptxDocument,
} from '../../types/media';
import { MediaParseError } from './errors';

const PPTX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

/**
 * 로컬 파일 경로의 PPTX 를 슬라이드/노트 단위로 추출한다.
 *
 * 에러 정책 (PDF 와 동일 코드 패밀리 사용):
 *   - 파일 stat 실패 → MEDIA_PARSE_FAILED
 *   - maxBytes 초과 → MEDIA_FILE_TOO_LARGE
 *   - ZIP 매직 바이트 없음 → MEDIA_UNSUPPORTED_FORMAT
 *   - 어댑터 미설치 → MEDIA_UNSUPPORTED_FORMAT (현재 기본 동작)
 *   - 호출자 abort → MEDIA_PARSE_ABORTED
 *
 * NOTE: officeparser 등 어댑터가 의존성에 들어오면, 본 함수의 throw 직전 위치에서
 *   `await parsePptxAdapter(buffer, opts)` 결과로 PptxDocument 를 채우면 된다.
 *   진행률 콜백은 phase 'open' / 'parse'(슬라이드별) / 'finalize' 순서를 유지한다.
 */
export async function extractPptx(
  filePath: string,
  opts: MediaLoaderOptions = {},
): Promise<PptxDocument> {
  const maxBytes = opts.maxBytes ?? MEDIA_LOADER_DEFAULTS.maxBytes;
  const onProgress = opts.onProgress;
  const signal = opts.signal;

  if (signal?.aborted) {
    throw new MediaParseError('MEDIA_PARSE_ABORTED', `호출자 취소: ${path.basename(filePath)}`);
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    throw new MediaParseError('MEDIA_PARSE_FAILED', `파일 stat 실패: ${filePath}`, err);
  }

  if (maxBytes > 0 && stat.size > maxBytes) {
    throw new MediaParseError(
      'MEDIA_FILE_TOO_LARGE',
      `PPTX 크기 ${stat.size}B 가 최대 ${maxBytes}B 를 초과합니다`,
    );
  }

  onProgress?.({ phase: 'open', current: 0, total: stat.size });

  // 파일 전체를 읽기 전에 헤더 4바이트만 읽어 형식부터 거른다. 큰 비-PPTX 파일이
  // 잘못 들어왔을 때 메모리를 낭비하지 않기 위함.
  const head = Buffer.alloc(PPTX_MAGIC.length);
  const fh = await fs.open(filePath, 'r');
  try {
    await fh.read(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }
  if (!head.equals(PPTX_MAGIC)) {
    throw new MediaParseError(
      'MEDIA_UNSUPPORTED_FORMAT',
      `PPTX(zip) magic bytes 가 발견되지 않음: ${path.basename(filePath)}`,
    );
  }

  // 어댑터가 등록되면 여기에 동적 import + 추출 호출을 끼워 넣는다.
  // 현재는 의존성이 없어 형식 검증만 통과한 뒤 즉시 실패한다.
  throw new MediaParseError(
    'MEDIA_UNSUPPORTED_FORMAT',
    'PPTX 텍스트 추출 어댑터(officeparser 등) 가 등록되지 않았습니다',
  );
}
