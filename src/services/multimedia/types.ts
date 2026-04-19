// 지시 #9c2ae902 · 멀티미디어 어댑터 공용 타입.
//
// 본 파일은 `src/services/multimedia/` 하위 어댑터 6종(PDF · PPT · 영상 · 웹검색 ·
// 심층조사 · 입력 자동화) 이 공유하는 최소 공통 인터페이스를 고정한다. 기존
// `src/utils/mediaLoaders.ts` / `src/services/media/*Loader.ts` 는 "이미 업로드된
// 파일을 파싱" 하는 좁은 축만 담당했다. 본 레이어는 그 상위 골격으로,
//   · 입·출력 양방향(파싱 + 생성)
//   · 외부 서비스(영상 생성 큐 · 웹 · 브라우저 자동화) 와의 권한 위임
//   · 취소·진행률 계약
// 을 단일 인터페이스 `MediaAdapter` 로 묶어, UI('미디어 허브' 시안) 가 어댑터 구현을
// 모르더라도 프로미스/이벤트만으로 결합할 수 있게 한다.
//
// 설계 원칙
//   1) 실제 외부 라이브러리 호출은 후속 태스크로 미룬다 — 본 파일의 타입은 "뼈대" 다.
//   2) 어댑터별 입·출력 데이터는 `MediaAdapterInput<K>` · `MediaAdapterOutput<K>`
//      제네릭으로 분기한다. 추가 어댑터가 들어오면 `MediaAdapterKind` 만 확장하면
//      된다(유니온 추가 → 각 축의 I/O 매핑만 선언).
//   3) 취소 토큰은 표준 `AbortSignal` 을 1차로 삼고, 어댑터 내부가 추가 큐/락을
//      필요로 하면 `CancellationTokenSource` 헬퍼를 쓴다(후속 PR 에서 구현).
//   4) `MediaAdapter.describe()` 는 UI 와 레지스트리가 어댑터 능력을 런타임에 조회할
//      수 있게 한다. capabilities 는 "읽기/쓰기/스트리밍/오프라인/권한위임" 5축.

// ────────────────────────────────────────────────────────────────────────────
// 0. 식별 · 분류
// ────────────────────────────────────────────────────────────────────────────

/**
 * 어댑터 종류 태그. 신규 어댑터가 들어오면 유니온만 확장하고 각 I/O 타입을 매핑한다.
 *   · 'pdf'              — PDF 파싱/리포트 생성
 *   · 'pptx'             — PowerPoint 파싱/덱 생성
 *   · 'video'            — Sora/Veo 등 영상 생성 작업 큐
 *   · 'web-search'       — 공개 웹 검색(검색엔진 API 혹은 ADK 도구)
 *   · 'research'         — 다중 소스 요약/심층 조사(Claude + 웹 + 로컬 파일)
 *   · 'input-automation' — 키보드/마우스 위임(브라우저 DOM 혹은 OS 수준, 권한 게이트 포함)
 */
export type MediaAdapterKind =
  | 'pdf'
  | 'pptx'
  | 'video'
  | 'web-search'
  | 'research'
  | 'input-automation';

/** 어댑터별 능력 비트. UI 가 카드 버튼 노출/비활성화를 판정할 때 참조한다. */
export interface MediaAdapterCapabilities {
  /** 입력(업로드/파싱) 지원 여부. */
  readonly canParse: boolean;
  /** 출력(생성) 지원 여부. */
  readonly canGenerate: boolean;
  /** 단계별 progress 콜백을 내보내는가? (영상 생성 장시간 작업은 true). */
  readonly streamsProgress: boolean;
  /** 네트워크 없이 동작 가능(오프라인 모드) 인가? */
  readonly worksOffline: boolean;
  /** OS/브라우저 권한 위임이 필요한가(입력 자동화 등). true 면 사용자 확인 게이트 필수. */
  readonly requiresUserConsent: boolean;
}

/** 어댑터 메타데이터 — 레지스트리가 UI 와 로깅에 노출한다. */
export interface MediaAdapterDescriptor {
  readonly kind: MediaAdapterKind;
  /** 사용자에게 보일 한글 표시명 (예: "PDF 어댑터"). */
  readonly displayName: string;
  /** 내부 식별자 — 로그·텔레메트리 키. 영소문자 + 하이픈. */
  readonly id: string;
  /** 이 어댑터가 소비하는 MIME 목록. 빈 배열이면 MIME 이 없는 kind(예: 'research'). */
  readonly supportedInputMimes: readonly string[];
  /** 이 어댑터가 생성하는 MIME 목록. */
  readonly producedOutputMimes: readonly string[];
  readonly capabilities: MediaAdapterCapabilities;
  /** 동일 kind 에 여러 구현이 공존할 때 우선순위(낮을수록 우선). */
  readonly priority: number;
  /** 의존성 id 목록 — 본 어댑터가 기대하는 다른 어댑터(예: 'research' → 'web-search'). */
  readonly dependsOn: readonly MediaAdapterId[];
}

/** 어댑터 ID 문자열 타입 별칭 — 레지스트리 키. */
export type MediaAdapterId = string;

// ────────────────────────────────────────────────────────────────────────────
// 1. 진행률 · 취소 · 결과 봉투
// ────────────────────────────────────────────────────────────────────────────

/**
 * 3단계 phase — `docs/design/multimedia-ui-spec.md §2` 의 세그먼트 바와 의미 정합성
 * 유지. UI 레이어는 phase 를 색/아이콘 3채널로 번역한다.
 */
export type MediaAdapterPhase = 'precheck' | 'upload' | 'finalize';

export interface MediaAdapterProgress {
  readonly phase: MediaAdapterPhase;
  /** 0~1 사이 비율. 어댑터가 판정 불가능하면 null. */
  readonly ratio: number | null;
  /** 로그·툴팁 용 설명. 한국어. */
  readonly message?: string;
  /** 유입 바이트 기준 총량(업로드 phase 에서 의미 있음). */
  readonly bytesTotal?: number;
  readonly bytesTransferred?: number;
}

export type MediaAdapterProgressHandler = (progress: MediaAdapterProgress) => void;

/**
 * 취소 토큰. 표준 AbortSignal 호환 — fetch/IDB/스트림이 곧바로 받아 쓴다.
 * `CancellationToken` 은 타입 레벨 별칭으로만 두고, 실제 구현은 AbortSignal 을
 * 직접 사용한다. 필요 시 후속 PR 에서 `CancellationTokenSource` 헬퍼 추가.
 */
export type CancellationToken = AbortSignal;

/** 어댑터 공통 오류 코드 — 프리셋. 어댑터 특이 코드는 `MediaAdapterError.details` 에 담는다. */
export type MediaAdapterErrorCode =
  | 'UNSUPPORTED_MIME'
  | 'FILE_TOO_LARGE'
  | 'INPUT_INVALID'
  | 'NETWORK_ERROR'
  | 'PERMISSION_DENIED'
  | 'QUOTA_EXCEEDED'
  | 'ADAPTER_NOT_REGISTERED'
  | 'DEPENDENCY_MISSING'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'INTERNAL';

export class MediaAdapterError extends Error {
  readonly code: MediaAdapterErrorCode;
  readonly adapterId?: MediaAdapterId;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(
    code: MediaAdapterErrorCode,
    message: string,
    opts: { adapterId?: MediaAdapterId; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'MediaAdapterError';
    this.code = code;
    if (opts.adapterId !== undefined) this.adapterId = opts.adapterId;
    if (opts.details !== undefined) this.details = Object.freeze({ ...opts.details });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 2. I/O 매핑 — kind 별 입·출력 바인딩
// ────────────────────────────────────────────────────────────────────────────

/** 파일 기반 어댑터(PDF·PPT) 가 받는 입력 봉투. */
export interface MediaFileInput {
  /** 로컬 파일 경로(Node) 또는 Blob URL(브라우저). 어댑터가 환경별로 분기 처리. */
  readonly source: string | Blob | ArrayBuffer;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
}

/** 영상 생성 입력 — 프롬프트·길이·해상도. */
export interface VideoGenerationInput {
  readonly prompt: string;
  /** 초 단위. 미지정 시 어댑터 기본값. */
  readonly durationSeconds?: number;
  readonly resolution?: '720p' | '1080p' | '4k';
  /** 선호 어댑터 힌트 — 'sora' | 'veo' | 'runway' 등. 레지스트리가 매핑. */
  readonly preferredEngine?: string;
}

/** 웹 검색 입력. */
export interface WebSearchInput {
  readonly query: string;
  /** 최대 결과 수. 기본 10. */
  readonly limit?: number;
  /** 검색 도메인 화이트/블랙리스트. */
  readonly includeDomains?: readonly string[];
  readonly excludeDomains?: readonly string[];
  /** 언어 힌트. 기본 자동. */
  readonly language?: string;
}

/** 심층 조사 입력 — 웹검색 + 요약 체인. */
export interface ResearchInput {
  readonly topic: string;
  /** 조사 깊이(1=요약, 2=다관점, 3=심층 비교). 기본 2. */
  readonly depth?: 1 | 2 | 3;
  /** 인용 필수 여부. true 면 출력의 모든 주장에 출처 URL 을 강제한다. */
  readonly requireCitations?: boolean;
}

/** 입력 자동화 액션 시퀀스. 각 항목은 단일 원자 연산. */
export type InputAutomationStep =
  | { readonly kind: 'click'; readonly selector: string }
  | { readonly kind: 'type'; readonly text: string; readonly selector?: string }
  | { readonly kind: 'key'; readonly key: string; readonly modifiers?: readonly ('ctrl' | 'shift' | 'alt' | 'meta')[] }
  | { readonly kind: 'wait'; readonly ms: number }
  | { readonly kind: 'scroll'; readonly selector?: string; readonly deltaY: number };

export interface InputAutomationInput {
  readonly steps: readonly InputAutomationStep[];
  /** 권한 게이트 확인용 — 호출자가 보유한 최소 권한 레벨. 'display' < 'interact' < 'system'. */
  readonly requestedPermission: 'display' | 'interact' | 'system';
  /** UI 에 노출될 한글 요약 — 사용자가 위임 전 보는 문장. */
  readonly humanRationale: string;
}

/** 결과 봉투 — 어댑터 공통. 세부는 kind 별 `result` 필드에. */
export interface MediaAdapterOutcome<TResult> {
  readonly adapterId: MediaAdapterId;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly result: TResult;
  /** 진행 중 누적된 경고(치명 X). */
  readonly warnings?: readonly string[];
}

/** kind → 입력 타입 매핑. */
export interface MediaAdapterInputMap {
  'pdf': MediaFileInput;
  'pptx': MediaFileInput;
  'video': VideoGenerationInput;
  'web-search': WebSearchInput;
  'research': ResearchInput;
  'input-automation': InputAutomationInput;
}

/** kind → 출력 result 타입 매핑. 실제 결과 스키마는 후속 PR 에서 구체화한다. */
export interface MediaAdapterOutputMap {
  'pdf': { readonly pageCount: number; readonly text: string; readonly assetId?: string };
  'pptx': { readonly slideCount: number; readonly text: string; readonly assetId?: string };
  'video': { readonly jobId: string; readonly assetId?: string; readonly previewUrl?: string };
  'web-search': { readonly items: ReadonlyArray<{ readonly title: string; readonly url: string; readonly snippet: string }> };
  'research': { readonly summary: string; readonly citations: readonly string[] };
  'input-automation': { readonly executedSteps: number; readonly skippedSteps: number };
}

export type MediaAdapterInput<K extends MediaAdapterKind> = MediaAdapterInputMap[K];
export type MediaAdapterOutput<K extends MediaAdapterKind> = MediaAdapterOutputMap[K];

// ────────────────────────────────────────────────────────────────────────────
// 3. MediaAdapter 메인 인터페이스
// ────────────────────────────────────────────────────────────────────────────

export interface MediaAdapterInvocation<K extends MediaAdapterKind> {
  readonly input: MediaAdapterInput<K>;
  readonly signal?: CancellationToken;
  readonly onProgress?: MediaAdapterProgressHandler;
  /** 로깅 · 감사용 상관관계 ID. 미지정 시 어댑터가 생성. */
  readonly correlationId?: string;
}

export interface MediaAdapter<K extends MediaAdapterKind = MediaAdapterKind> {
  readonly descriptor: MediaAdapterDescriptor;
  /**
   * 어댑터 핵심 실행. 진행률·취소·오류 모두 본 메서드 한 점에서 처리한다.
   * 구현체는 반드시 signal 을 존중해 취소 시 MediaAdapterError('ABORTED') 를 던진다.
   */
  invoke(call: MediaAdapterInvocation<K>): Promise<MediaAdapterOutcome<MediaAdapterOutput<K>>>;
  /**
   * 입력이 이 어댑터가 처리 가능한 형태인지 사전 검증. 레지스트리가 dispatch 전에 호출.
   * true 반환이 곧 실제 성공을 보장하진 않는다 — 어댑터는 MIME·크기·권한 수준만 본다.
   */
  canHandle(input: MediaAdapterInput<K>): boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 설정 주입 · 의존성 목록
// ────────────────────────────────────────────────────────────────────────────

/**
 * 어댑터 전역 설정. 레지스트리가 각 어댑터 팩토리에 주입한다. 비밀키는 포함하지
 * 않는다 — 실제 호출은 서버 어댑터가 담당하고, 본 타입은 클라이언트가 보는 축만.
 */
export interface MultimediaAdapterConfig {
  /** 최대 입력 바이트. MediaLoaderOptions.maxBytes 와 의미 동일. */
  readonly maxBytes: number;
  /** 기본 타임아웃(ms). */
  readonly timeoutMs: number;
  /** 영상 생성 작업 큐 URL 또는 id. 미지정 시 어댑터 기본값. */
  readonly videoQueueEndpoint?: string;
  /** 웹검색 API 키 존재 여부 플래그(값 자체는 서버에만). */
  readonly hasWebSearchCredentials?: boolean;
  /** 입력 자동화 허용 최대 권한. 기본 'display'(읽기 전용). */
  readonly inputAutomationMaxPermission?: InputAutomationInput['requestedPermission'];
}

export const DEFAULT_ADAPTER_CONFIG: MultimediaAdapterConfig = Object.freeze({
  maxBytes: 50 * 1024 * 1024,
  timeoutMs: 30_000,
  inputAutomationMaxPermission: 'display',
});

export type MediaAdapterFactory<K extends MediaAdapterKind = MediaAdapterKind> =
  (config: MultimediaAdapterConfig) => MediaAdapter<K>;

/**
 * 어댑터 등록 봉투 — 레지스트리 내부 저장 형태. 외부에 노출하는 이유는 테스트가
 * 등록 상태를 검증할 수 있도록 하기 위함.
 */
export interface MediaAdapterRegistration<K extends MediaAdapterKind = MediaAdapterKind> {
  readonly factory: MediaAdapterFactory<K>;
  readonly descriptor: MediaAdapterDescriptor;
}
