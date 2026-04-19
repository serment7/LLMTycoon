// 전역 사용자 친화 오류 메시지 매핑(#3773fc8d).
//
// 배경 — 본 저장소는 여러 도메인의 예외 타입을 가진다(`MediaLoaderError` ·
// `MediaParseError` · `MediaExporterError` · 세션 신호 등). UI 쪽 토스트와
// `ErrorBoundary` 가 "원인 코드" 를 매번 if/else 로 분기하면 한 줄 라벨이 파일마다
// 어긋나 접근성 라벨(aria-live) 이 일관되지 않는다. 본 모듈은:
//   1) 각 예외의 `code` 문자열을 받아 `{ title · body · severity · action? }` 형태의
//      공통 UI 메시지로 매핑한다.
//   2) 알 수 없는 예외는 기본 폴백 한 개로 수렴해 사용자가 빈 화면을 보지 않게 한다.
//   3) 네트워크 단절·레이트리밋 같은 "세션 부가 신호" 도 같은 형태로 제공한다.
//
// 본 모듈은 **순수 함수 집합** 이다. React import · window 접근이 없으며 Node 환경의
// tsx --test 단위 테스트로 전부 잠글 수 있다. 톤&매너 지침(디자이너 시안 2026-04-19):
//   · title  — 한 줄, 사용자에게 "무엇이 일어났는지" 를 즉시 알려 준다.
//   · body   — 선택. "어떻게 해소되는지" 를 한 문장으로 안내한다.
//   · severity 는 `ToastVariant` 와 1:1 매핑되어 팔레트·아이콘이 결정된다.

import type { MediaLoaderErrorCode } from './mediaLoaders';
import type { MediaExporterErrorCode } from './mediaExporters';
import type { MediaErrorCode } from '../services/media/errors';

/** 토스트/배너/`ErrorBoundary` 가 공통으로 소비하는 사용자 친화 메시지. */
export interface UserFacingMessage {
  /** 한 줄 제목. 필수. */
  title: string;
  /** 보조 설명(선택). 해소 경로를 짧게 안내. */
  body?: string;
  /** 팔레트·아이콘 결정용. `ToastVariant` 와 동일 축. */
  severity: 'info' | 'warning' | 'error';
  /**
   * UI 가 "조치 버튼" 을 붙일 수 있도록 의미만 실어 보낸다. 실제 클릭 핸들러는
   * 호출자(App.tsx·DirectivePrompt 등) 가 kind 에 맞춰 연결한다.
   */
  action?: {
    label: string;
    kind: 'retry-now' | 'open-settings' | 'dismiss';
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 매핑 테이블 — 코드마다 한국어 메시지 1개
// ────────────────────────────────────────────────────────────────────────────

const MEDIA_LOADER_TABLE: Readonly<Record<MediaLoaderErrorCode, UserFacingMessage>> = {
  UNSUPPORTED_KIND: {
    title: '지원하지 않는 파일 형식입니다',
    body: 'PDF·PPTX·이미지·영상 파일만 업로드할 수 있어요.',
    severity: 'warning',
  },
  FILE_TOO_LARGE: {
    title: '파일 용량이 너무 큽니다',
    body: '파일을 50MB 이하로 줄여 다시 시도해 주세요.',
    severity: 'warning',
  },
  UPLOAD_FAILED: {
    title: '업로드에 실패했어요',
    body: '잠시 후 다시 시도하거나, 파일을 다시 선택해 주세요.',
    severity: 'error',
    action: { label: '다시 시도', kind: 'retry-now' },
  },
  GENERATE_FAILED: {
    title: '생성 요청을 처리하지 못했습니다',
    body: '프롬프트를 다듬어 다시 요청하거나 잠시 후 시도해 주세요.',
    severity: 'error',
    action: { label: '다시 시도', kind: 'retry-now' },
  },
  ADAPTER_NOT_REGISTERED: {
    title: '변환 엔진이 준비되지 않았어요',
    body: '서버 설정에서 해당 형식의 파서를 활성화해 주세요.',
    severity: 'error',
    action: { label: '설정 열기', kind: 'open-settings' },
  },
  SESSION_EXHAUSTED: {
    title: '세션 한도를 초과했습니다',
    body: '5시간 창이 갱신되면 자동으로 이어집니다.',
    severity: 'warning',
    action: { label: '설정 열기', kind: 'open-settings' },
  },
  ABORTED: {
    title: '요청이 취소되었습니다',
    severity: 'info',
  },
  AUDIO_UNSUPPORTED: {
    title: '이 브라우저는 마이크 녹음을 지원하지 않아요',
    body: '최신 브라우저(크롬·엣지·사파리)에서 다시 시도해 주세요.',
    severity: 'warning',
  },
  AUDIO_PERMISSION_DENIED: {
    title: '마이크 권한이 거부되었습니다',
    body: '브라우저 주소창의 자물쇠 아이콘에서 마이크 권한을 허용해 주세요.',
    severity: 'warning',
    action: { label: '설정 열기', kind: 'open-settings' },
  },
};

const MEDIA_EXPORTER_TABLE: Readonly<Record<MediaExporterErrorCode, UserFacingMessage>> = {
  VALIDATION_FAILED: {
    title: '입력값을 다시 확인해 주세요',
    body: '필수 항목이 비어 있거나 형식이 맞지 않습니다.',
    severity: 'warning',
  },
  EXPORT_FAILED: {
    title: '내보내기에 실패했어요',
    body: '잠시 후 다시 시도하거나, 항목을 나눠 다시 시도해 주세요.',
    severity: 'error',
    action: { label: '다시 시도', kind: 'retry-now' },
  },
  ADAPTER_NOT_REGISTERED: {
    title: '내보내기 엔진이 준비되지 않았어요',
    body: '서버 설정에서 출력 어댑터를 활성화해 주세요.',
    severity: 'error',
    action: { label: '설정 열기', kind: 'open-settings' },
  },
  SESSION_EXHAUSTED: {
    title: '세션 한도를 초과했습니다',
    body: '5시간 창이 갱신되면 내보내기를 자동으로 이어갑니다.',
    severity: 'warning',
    action: { label: '설정 열기', kind: 'open-settings' },
  },
  ABORTED: {
    title: '내보내기가 취소되었습니다',
    severity: 'info',
  },
};

const MEDIA_PARSE_TABLE: Readonly<Record<MediaErrorCode, UserFacingMessage>> = {
  MEDIA_PARSE_TIMEOUT: {
    title: '파일 분석이 시간을 초과했어요',
    body: '더 작은 파일로 나누거나 잠시 후 다시 시도해 주세요.',
    severity: 'warning',
  },
  MEDIA_UNSUPPORTED_FORMAT: {
    title: '파일 형식이 올바르지 않습니다',
    body: '정품 PDF·PPTX 파일만 분석할 수 있어요.',
    severity: 'warning',
  },
  MEDIA_FILE_TOO_LARGE: {
    title: '파일 용량이 너무 큽니다',
    body: '50MB 이하로 줄여 다시 시도해 주세요.',
    severity: 'warning',
  },
  MEDIA_PARSE_ABORTED: {
    title: '분석이 취소되었습니다',
    severity: 'info',
  },
  MEDIA_PARSE_FAILED: {
    title: '파일을 읽을 수 없어요',
    body: '파일이 손상되었거나 암호화되어 있을 수 있어요.',
    severity: 'error',
  },
};

/** 알 수 없는 오류 폴백. "빈 토스트" 가 아니라 "원인 미상" 이라고 분명히 말해 준다. */
export const UNKNOWN_ERROR_MESSAGE: UserFacingMessage = Object.freeze({
  title: '예기치 못한 오류가 발생했어요',
  body: '잠시 후 다시 시도해 주세요. 계속되면 설정에서 로그를 확인해 주세요.',
  severity: 'error',
  action: { label: '다시 시도', kind: 'retry-now' },
}) as UserFacingMessage;

// ────────────────────────────────────────────────────────────────────────────
// 매핑 함수 — 코드 문자열 또는 Error 인스턴스로 조회
// ────────────────────────────────────────────────────────────────────────────

function lookup<K extends string>(
  table: Readonly<Record<K, UserFacingMessage>>,
  code: string,
): UserFacingMessage | null {
  return (table as Record<string, UserFacingMessage | undefined>)[code] ?? null;
}

/** `MediaLoaderError.code` 또는 동일 문자열을 받아 메시지로 매핑. 미지 코드는 폴백. */
export function mapMediaLoaderError(code: string): UserFacingMessage {
  return lookup(MEDIA_LOADER_TABLE, code) ?? UNKNOWN_ERROR_MESSAGE;
}

/** `MediaExporterError.code` 매핑. */
export function mapMediaExporterError(code: string): UserFacingMessage {
  return lookup(MEDIA_EXPORTER_TABLE, code) ?? UNKNOWN_ERROR_MESSAGE;
}

/** `MediaParseError.code`(MEDIA_*) 매핑. 서버 라우트/클라이언트 로더 양쪽 공용. */
export function mapMediaParseError(code: string): UserFacingMessage {
  return lookup(MEDIA_PARSE_TABLE, code) ?? UNKNOWN_ERROR_MESSAGE;
}

/**
 * 임의의 `unknown` 예외를 받아 가능한 정보로 매핑한다. 순서:
 *   1) `code` 속성이 MediaLoader/Exporter/Parse 테이블에 존재하면 그 메시지.
 *   2) `name === 'AbortError'` 는 "요청이 취소됨" 으로 수렴.
 *   3) `message` 에 'network' 가 포함되면 네트워크 단절 안내.
 *   4) 그 외 UNKNOWN_ERROR_MESSAGE.
 */
export function mapUnknownError(err: unknown): UserFacingMessage {
  if (!err || (typeof err !== 'object' && typeof err !== 'string')) return UNKNOWN_ERROR_MESSAGE;
  if (typeof err === 'string') {
    return /network|네트워크/i.test(err)
      ? NETWORK_OFFLINE_MESSAGE
      : { ...UNKNOWN_ERROR_MESSAGE, body: err };
  }
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof e.code === 'string') {
    const loader = lookup(MEDIA_LOADER_TABLE, e.code);
    if (loader) return loader;
    const exporter = lookup(MEDIA_EXPORTER_TABLE, e.code);
    if (exporter) return exporter;
    const parse = lookup(MEDIA_PARSE_TABLE, e.code);
    if (parse) return parse;
  }
  if (e.name === 'AbortError') {
    return { title: '요청이 취소되었습니다', severity: 'info' };
  }
  const msg = typeof e.message === 'string' ? e.message : '';
  if (/network|offline|네트워크/i.test(msg)) return NETWORK_OFFLINE_MESSAGE;
  return msg ? { ...UNKNOWN_ERROR_MESSAGE, body: msg } : UNKNOWN_ERROR_MESSAGE;
}

// ────────────────────────────────────────────────────────────────────────────
// 세션 부가 신호(네트워크/레이트리밋) — claudeSubscriptionSession 과 짝을 이룸
// ────────────────────────────────────────────────────────────────────────────

export const NETWORK_OFFLINE_MESSAGE: UserFacingMessage = Object.freeze({
  title: '네트워크가 일시적으로 끊겼어요',
  body: '연결이 복구되면 자동으로 이어집니다.',
  severity: 'info',
}) as UserFacingMessage;

export const RATE_LIMIT_MESSAGE: UserFacingMessage = Object.freeze({
  title: '요청이 잠시 제한되었습니다',
  body: '잠시 후 자동으로 다시 시도합니다.',
  severity: 'warning',
}) as UserFacingMessage;

// ────────────────────────────────────────────────────────────────────────────
// ToastProvider 어댑터 — UserFacingMessage → ToastInput
// ────────────────────────────────────────────────────────────────────────────

/**
 * `UserFacingMessage` 를 `ToastProvider` 가 그대로 `push` 할 수 있는 입력 형태로
 * 변환한다. severity → variant 매핑은 1:1(성공은 본 매핑 대상 아님), action 의
 * `onClick` 은 호출자가 kind 에 맞춰 바인딩한다. 알 수 없는 kind 는 `dismiss` 로
 * 수렴해 클릭 시 조용히 닫힌다.
 *
 * 반환 타입은 토스트 모듈과의 순환 import 를 피하기 위해 구조적 호환 객체로 둔다
 * (ToastInput 과 필드가 일치하지만 import 하지는 않는다).
 */
export interface ToastInputLike {
  variant: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function messageToToastInput(
  msg: UserFacingMessage,
  handlers?: {
    onRetryNow?: () => void;
    onOpenSettings?: () => void;
  },
): ToastInputLike {
  const out: ToastInputLike = {
    variant: msg.severity,
    title: msg.title,
    description: msg.body,
  };
  if (msg.action) {
    const onClick = msg.action.kind === 'retry-now'
      ? (handlers?.onRetryNow ?? (() => { /* 바인딩 없음 — 조용히 닫힘 */ }))
      : msg.action.kind === 'open-settings'
        ? (handlers?.onOpenSettings ?? (() => { /* 바인딩 없음 */ }))
        : (() => { /* dismiss 기본 */ });
    out.action = { label: msg.action.label, onClick };
  }
  return out;
}
