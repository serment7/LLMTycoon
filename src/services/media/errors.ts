// Thanos #3a049e55 — 미디어 로더가 던지는 표준 에러 코드.
// 서버/UI 양쪽이 동일 코드 문자열로 분기하므로 enum 대신 readonly union 으로 둔다.
//
// 명명 규칙: `MEDIA_<원인>` — 사용자 노출 메시지는 호출자(서버 핸들러·UI 토스트) 가
// 코드별로 i18n 처리한다. 본 모듈은 "원인" 만 책임진다.

export type MediaErrorCode =
  // 단일 파싱 호출이 timeoutMs 안에 끝나지 않음.
  | 'MEDIA_PARSE_TIMEOUT'
  // 매직 바이트/MIME 가 PDF/PPTX 가 아님, 또는 어댑터가 아직 등록되지 않음.
  | 'MEDIA_UNSUPPORTED_FORMAT'
  // 파일 크기가 maxBytes 한도를 초과.
  | 'MEDIA_FILE_TOO_LARGE'
  // 호출자가 AbortController.abort() 로 중단.
  | 'MEDIA_PARSE_ABORTED'
  // 파서 내부에서 던진 일반 실패(라이브러리 예외 등)를 한 번 감싼 등급.
  | 'MEDIA_PARSE_FAILED';

export const MEDIA_ERROR_CODES: readonly MediaErrorCode[] = Object.freeze([
  'MEDIA_PARSE_TIMEOUT',
  'MEDIA_UNSUPPORTED_FORMAT',
  'MEDIA_FILE_TOO_LARGE',
  'MEDIA_PARSE_ABORTED',
  'MEDIA_PARSE_FAILED',
]);

export class MediaParseError extends Error {
  readonly code: MediaErrorCode;
  // 원인 예외(라이브러리 throw 등). UI 에는 노출하지 않고 로그/디버깅용.
  readonly cause?: unknown;
  constructor(code: MediaErrorCode, message: string, cause?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'MediaParseError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

// 호출자가 unknown 예외를 받았을 때 이 헬퍼로 코드를 일관되게 추출한다.
export function isMediaParseError(err: unknown): err is MediaParseError {
  return err instanceof MediaParseError;
}
