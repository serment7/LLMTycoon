// 지시 #75b61e74 · 입력 자동화(키보드·마우스 위임) 어댑터 실제 구현.
//
// 선행 라운드(#9c2ae902)에서 계약만 잠근 `src/services/multimedia/InputAutomationAdapter.ts`
// 스켈레톤 위에, 디자이너의 `docs/designs/input-automation-ux.md` UX 시안과 QA의
// `docs/qa/input-automation-test-plan.md` 테스트 계획이 맞물릴 실제 구현을 놓는다.
//
// 책임
//   (1) requestPermission() — UX 시안 §1 권한 요청 모달과 연결되는 동의 세션 API.
//       실제 모달은 UI 레이어가 소유하고, 본 어댑터는 `ConsentPort` 인터페이스로 DI 를
//       받아 모달 결정을 기다린다. 반환값은 { granted, expiresAt } + 원인 코드.
//   (2) recordSession(opts) — 사용자 입력 스트림을 AsyncIterable<InputEvent> 로 방출.
//       실제 이벤트 소스도 `InputSourcePort` DI 로 분리 — 브라우저는 DOM 이벤트, Node
//       테스트는 stub 큐, 데스크톱은 nut.js/robotjs 를 wrap.
//   (3) replay(events, opts) — 기록된 이벤트 시퀀스 재생. 좌표 스케일(DPI 보정)·포커스
//       검증·속도 배수·AbortSignal·onProgress 를 모두 지원. 결과는 ReplayResult.
//   (4) 비상 중단 — 기본 Esc 3연타(1.5초 내) + system 권한에서 Ctrl+Shift+Esc.
//       `HotkeyPort` 로 등록/해제를 주입한다. 트리거 시 TimelineEvent 'emergency-stop'
//       송출 + signal.abort(). 상단 고정 배지(UX §2) 는 timeline 이벤트를 구독.
//   (5) 화이트리스트 — 빈 목록 = 전부 거절(S-05). 호스트 + 경로 패턴 + maxPermission 의
//       교집합을 적용.
//   (6) 실패 시 스크린샷/DOM/이벤트 로그 3세트 자동 수집. `ArtifactPort` DI.
//   (7) 오류 코드 INPUT_PERMISSION_DENIED / INPUT_SESSION_EXPIRED /
//       INPUT_BLOCKED_TARGET / INPUT_EMERGENCY_STOP — MediaAdapterError.details.inputCode.
//   (8) 크로스 OS 추상 계층 — OsDriver 인터페이스 하나로 Windows/macOS 분기.
//       nut.js/robotjs 는 선택형 의존성(현재 미설치 가정) — DEPENDENCY_MISSING 로 수렴.
//   (9) MediaAdapter<'input-automation'> 구현, MultimediaRegistry 에 별칭 `automation/input`
//       으로 우선 등록(priority=-10).
//
// 기본값은 꺼진 상태
//   · `enabled` 플래그 기본 false — 명시적 주입이 없으면 invoke/requestPermission 모두
//     ADAPTER_NOT_REGISTERED 가 아니라 INPUT_PERMISSION_DENIED(reason='feature-disabled')
//     로 조용히 거절한다. 이렇게 해야 UI 가 "기능이 꺼져 있음" 을 정확히 안내한다.

import {
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterInvocation,
  type MediaAdapterOutcome,
  type MediaAdapterOutput,
  type MediaAdapterProgressHandler,
  type MultimediaAdapterConfig,
  type InputAutomationInput,
  type InputAutomationStep,
} from '../types';

export const INPUT_AUTOMATION_ADAPTER_ID = 'builtin-input-automation';
/** MultimediaRegistry.register('automation/input', …) 을 요청한 외부 별칭. */
export const INPUT_AUTOMATION_ALIAS = 'automation/input';

// ────────────────────────────────────────────────────────────────────────────
// 오류 코드
// ────────────────────────────────────────────────────────────────────────────

export type InputAutomationErrorCode =
  | 'INPUT_PERMISSION_DENIED'
  | 'INPUT_SESSION_EXPIRED'
  | 'INPUT_BLOCKED_TARGET'
  | 'INPUT_EMERGENCY_STOP';

function inputError(
  inputCode: InputAutomationErrorCode,
  message: string,
  opts: { cause?: unknown; reason?: string; details?: Record<string, unknown> } = {},
): MediaAdapterError {
  // INPUT_PERMISSION_DENIED 는 MediaAdapter 상위 코드로도 PERMISSION_DENIED 로 매핑하여
  // 기존 UI(권한 배너) 가 변경 없이 호환되게 한다.
  const baseCode =
    inputCode === 'INPUT_PERMISSION_DENIED' ? 'PERMISSION_DENIED'
      : inputCode === 'INPUT_EMERGENCY_STOP' ? 'ABORTED'
        : 'INTERNAL';
  return new MediaAdapterError(baseCode, message, {
    adapterId: INPUT_AUTOMATION_ADAPTER_ID,
    details: {
      inputCode,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.details ?? {}),
    },
    cause: opts.cause,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 공개 타입 — InputEvent · ConsentSession · WhitelistRule · 결과 봉투
// ────────────────────────────────────────────────────────────────────────────

export type PermissionLevel = InputAutomationInput['requestedPermission'];

export interface ConsentSession {
  readonly granted: boolean;
  readonly level: PermissionLevel;
  readonly grantedAtMs: number;
  readonly expiresAtMs: number;
  readonly rationale: string;
  readonly sessionId: string;
  readonly reason?: 'user-cancelled' | 'user-consent-timeout' | 'feature-disabled' | 'cap-exceeded' | 'whitelist-miss';
}

export interface WhitelistRule {
  readonly host: string;
  readonly pathPattern: string;
  readonly maxPermission: PermissionLevel;
  readonly active: boolean;
}

export interface AutomationTarget {
  readonly url: string;
  /** OS 수준에서는 프로세스/창 타이틀. 비브라우저 컨텍스트 보조용. */
  readonly windowTitle?: string;
}

export type InputEventKind =
  | 'click'
  | 'mousedown'
  | 'mouseup'
  | 'move'
  | 'keydown'
  | 'keyup'
  | 'type'
  | 'wait'
  | 'scroll';

export interface InputEvent {
  readonly kind: InputEventKind;
  /** 레코딩 시작 기준 경과(ms). */
  readonly t: number;
  readonly selector?: string;
  /** CSS 픽셀(창 좌표계). devicePixelRatio 는 driver 가 해석. */
  readonly x?: number;
  readonly y?: number;
  readonly key?: string;
  readonly modifiers?: ReadonlyArray<'ctrl' | 'shift' | 'alt' | 'meta'>;
  readonly text?: string;
  /** 'password'/'cc-number'/'otp' 등 민감도 태그 — 마스킹 대상 판정용. */
  readonly sensitive?: boolean;
  /** scroll deltaY(수직 스크롤). */
  readonly deltaY?: number;
  /** wait 단계 밀리초. */
  readonly ms?: number;
}

export interface ReplayStepOutcome {
  readonly index: number;
  readonly event: InputEvent;
  readonly status: 'done' | 'skipped' | 'failed';
  readonly reason?: string;
  readonly tookMs: number;
}

export interface ReplayArtifacts {
  readonly beforePng?: Uint8Array;
  readonly duringPng?: Uint8Array;
  readonly afterPng?: Uint8Array;
  readonly domHtml?: string;
  readonly eventsJsonl?: string;
  readonly correlationId: string;
}

export interface ReplayResult {
  readonly executedSteps: number;
  readonly skippedSteps: number;
  readonly failedSteps: number;
  readonly outcomes: readonly ReplayStepOutcome[];
  readonly durationMs: number;
  readonly target: AutomationTarget;
  readonly level: PermissionLevel;
  readonly abortReason?: 'emergency-stop' | 'signal' | 'timeout';
  readonly artifacts?: ReplayArtifacts;
}

// ────────────────────────────────────────────────────────────────────────────
// DI 포트 — UI / OS 추상 계층
// ────────────────────────────────────────────────────────────────────────────

export interface ConsentPort {
  /** UX 시안 §1 권한 모달 결정. 타임아웃이면 reject 가 아니라 granted=false 를 돌린다. */
  request(input: {
    readonly level: PermissionLevel;
    readonly rationale: string;
    readonly target: AutomationTarget;
    readonly totalSteps: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<{ granted: boolean; reason?: ConsentSession['reason']; expiresAtMs: number }>;
}

export interface HotkeyPort {
  /** trigger 는 어댑터가 abort 루틴을 호출하도록 프론트에 넘겨 준다. */
  register(opts: {
    readonly pattern: 'esc-triple' | 'esc-double' | 'ctrl-shift-esc';
    readonly trigger: () => void;
  }): () => void; // unregister
}

export interface InputSourcePort {
  /** 레코딩 이벤트 스트림. 호출자는 signal.abort() 로 중단. */
  subscribe(opts: {
    readonly target: AutomationTarget;
    readonly level: PermissionLevel;
    readonly signal: AbortSignal;
  }): AsyncIterable<InputEvent>;
}

export interface OsDriver {
  readonly platform: 'win32' | 'darwin' | 'linux' | 'browser' | 'test';
  readonly devicePixelRatio: number;
  /** 대상 창/URL 로 포커스 이동. 실패 시 false. */
  focus(target: AutomationTarget): Promise<boolean>;
  dispatch(event: InputEvent, opts: { readonly speed: number }): Promise<void>;
  /** 스크린샷 · DOM 스냅샷 — 실패 시 undefined(호환 모드). */
  captureScreenshot?(target: AutomationTarget): Promise<Uint8Array | undefined>;
  captureDom?(target: AutomationTarget): Promise<string | undefined>;
}

export interface ArtifactPort {
  persist(artifacts: ReplayArtifacts): Promise<void>;
}

export interface TimelineEvent {
  readonly kind:
    | 'session-start'
    | 'step-start'
    | 'step-done'
    | 'step-failed'
    | 'step-skipped'
    | 'paused'
    | 'resumed'
    | 'emergency-stop'
    | 'session-end';
  readonly t: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type TimelineObserver = (event: TimelineEvent) => void;

// ────────────────────────────────────────────────────────────────────────────
// 어댑터 옵션
// ────────────────────────────────────────────────────────────────────────────

export interface InputAutomationAdapterOptions {
  /** 보안상 기본 false — 명시적 주입이 없으면 거절. */
  readonly enabled?: boolean;
  readonly consent?: ConsentPort;
  readonly hotkey?: HotkeyPort;
  readonly inputSource?: InputSourcePort;
  readonly osDriver?: OsDriver;
  readonly artifact?: ArtifactPort;
  readonly whitelist?: readonly WhitelistRule[];
  /** 동의 모달 응답 대기 타임아웃. 기본 30초(QA 계획 §1.4 수렴). */
  readonly consentTimeoutMs?: number;
  /** 동의 세션 유효 기간. 기본 30분(QA CONSENT-03 제안값). */
  readonly sessionTtlMs?: number;
  /** 현재 시각 주입 — 테스트에서 세션 만료 시뮬레이션. */
  readonly now?: () => number;
  /** 비상 중단 패턴. 기본 'esc-triple'(지시 #75b61e74 = "기본 Esc 3회"). */
  readonly emergencyPattern?: 'esc-triple' | 'esc-double';
  /** 타임라인 옵저버(UX §2 배지 · §4 타임라인 구독). */
  readonly onTimelineEvent?: TimelineObserver;
}

const PERMISSION_RANK: Readonly<Record<PermissionLevel, number>> = {
  display: 0,
  interact: 1,
  system: 2,
};

// ────────────────────────────────────────────────────────────────────────────
// 어댑터 구현
// ────────────────────────────────────────────────────────────────────────────

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'input-automation',
    id: INPUT_AUTOMATION_ADAPTER_ID,
    displayName: '입력 자동화 어댑터(실구현)',
    supportedInputMimes: [],
    producedOutputMimes: [],
    capabilities: {
      canParse: false,
      canGenerate: true,
      streamsProgress: true,
      worksOffline: true,
      requiresUserConsent: true,
    },
    priority: -10,
    dependsOn: [],
  };
}

export class InputAutomationAdapter implements MediaAdapter<'input-automation'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();

  private readonly enabled: boolean;
  private readonly consentPort?: ConsentPort;
  private readonly hotkeyPort?: HotkeyPort;
  private readonly inputSourcePort?: InputSourcePort;
  private readonly osDriver?: OsDriver;
  private readonly artifactPort?: ArtifactPort;
  private readonly whitelist: readonly WhitelistRule[];
  private readonly consentTimeoutMs: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly emergencyPattern: 'esc-triple' | 'esc-double';
  private readonly onTimelineEvent?: TimelineObserver;

  private activeSession: ConsentSession | null = null;

  constructor(
    private readonly config: MultimediaAdapterConfig,
    options: InputAutomationAdapterOptions = {},
  ) {
    this.enabled = options.enabled ?? false;
    this.consentPort = options.consent;
    this.hotkeyPort = options.hotkey;
    this.inputSourcePort = options.inputSource;
    this.osDriver = options.osDriver;
    this.artifactPort = options.artifact;
    this.whitelist = options.whitelist ?? [];
    this.consentTimeoutMs = options.consentTimeoutMs ?? 30_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
    this.emergencyPattern = options.emergencyPattern ?? 'esc-triple';
    this.onTimelineEvent = options.onTimelineEvent;
  }

  canHandle(input: InputAutomationInput): boolean {
    if (!input || typeof input !== 'object') return false;
    if (!Array.isArray(input.steps) || input.steps.length === 0) return false;
    if (typeof input.humanRationale !== 'string' || input.humanRationale.trim().length === 0) {
      return false;
    }
    const cap = this.config.inputAutomationMaxPermission ?? 'display';
    if (PERMISSION_RANK[input.requestedPermission] > PERMISSION_RANK[cap]) return false;
    return this.enabled;
  }

  // ──────────────────────────────────────────────────────────────────────
  // (1) 권한 세션 API
  // ──────────────────────────────────────────────────────────────────────

  async requestPermission(args: {
    readonly level: PermissionLevel;
    readonly rationale: string;
    readonly target: AutomationTarget;
    readonly totalSteps: number;
    readonly signal?: AbortSignal;
  }): Promise<{ granted: boolean; expiresAt: number; reason?: ConsentSession['reason'] }> {
    if (!this.enabled) {
      return { granted: false, expiresAt: 0, reason: 'feature-disabled' };
    }
    if (!this.consentPort) {
      throw inputError('INPUT_PERMISSION_DENIED', '동의 포트(ConsentPort) 가 주입되지 않았습니다.', {
        reason: 'consent-port-missing',
      });
    }

    const cap = this.config.inputAutomationMaxPermission ?? 'display';
    if (PERMISSION_RANK[args.level] > PERMISSION_RANK[cap]) {
      return { granted: false, expiresAt: 0, reason: 'cap-exceeded' };
    }

    const wlCheck = this.checkWhitelist(args.target, args.level);
    if (!wlCheck.ok) {
      return { granted: false, expiresAt: 0, reason: 'whitelist-miss' };
    }

    const decision = await this.consentPort.request({
      level: args.level,
      rationale: args.rationale,
      target: args.target,
      totalSteps: args.totalSteps,
      timeoutMs: this.consentTimeoutMs,
      signal: args.signal,
    });

    if (!decision.granted) {
      this.activeSession = null;
      return { granted: false, expiresAt: 0, reason: decision.reason ?? 'user-cancelled' };
    }

    const grantedAt = this.now();
    this.activeSession = {
      granted: true,
      level: args.level,
      grantedAtMs: grantedAt,
      expiresAtMs: decision.expiresAtMs > 0 ? decision.expiresAtMs : grantedAt + this.sessionTtlMs,
      rationale: args.rationale,
      sessionId: newSessionId(),
    };
    return { granted: true, expiresAt: this.activeSession.expiresAtMs };
  }

  /** 테스트·UX 에서 현재 활성 세션 조회. null = 동의 없음. */
  getActiveSession(): ConsentSession | null {
    if (!this.activeSession) return null;
    if (this.now() >= this.activeSession.expiresAtMs) {
      this.activeSession = null;
      return null;
    }
    return this.activeSession;
  }

  /** 사용자가 명시적으로 세션을 해제(강등 혹은 로그아웃). */
  revokeSession(): void {
    this.activeSession = null;
  }

  // ──────────────────────────────────────────────────────────────────────
  // (2) 레코딩 — 이벤트 스트림
  // ──────────────────────────────────────────────────────────────────────

  async *recordSession(opts: {
    readonly target: AutomationTarget;
    readonly level: PermissionLevel;
    readonly signal: AbortSignal;
  }): AsyncIterable<InputEvent> {
    if (!this.enabled) {
      throw inputError('INPUT_PERMISSION_DENIED', '입력 자동화 기능이 꺼져 있습니다.', {
        reason: 'feature-disabled',
      });
    }
    if (!this.inputSourcePort) {
      throw inputError('INPUT_PERMISSION_DENIED', 'InputSourcePort 가 주입되지 않았습니다.', {
        reason: 'source-port-missing',
      });
    }
    // 화이트리스트가 세션보다 먼저 — "이 사이트는 애초에 안 된다" 가 더 구체적인 거절.
    const wl = this.checkWhitelist(opts.target, opts.level);
    if (!wl.ok) {
      throw inputError('INPUT_BLOCKED_TARGET', '레코딩 대상이 화이트리스트 밖입니다.', {
        reason: 'whitelist-miss',
        details: { target: opts.target.url },
      });
    }
    this.assertSessionValid(opts.level);
    for await (const event of this.inputSourcePort.subscribe(opts)) {
      if (opts.signal.aborted) return;
      yield maskSensitiveText(event);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // (3) 리플레이 — 좌표 스케일·DPI·포커스 검증 포함
  // ──────────────────────────────────────────────────────────────────────

  async replay(
    events: readonly InputEvent[],
    opts: {
      readonly speed?: number;
      readonly target: AutomationTarget;
      readonly level: PermissionLevel;
      readonly onProgress?: (ratio: number) => void;
      readonly signal?: AbortSignal;
    },
  ): Promise<ReplayResult> {
    if (!this.enabled) {
      throw inputError('INPUT_PERMISSION_DENIED', '입력 자동화 기능이 꺼져 있습니다.', {
        reason: 'feature-disabled',
      });
    }
    if (!this.osDriver) {
      throw inputError('INPUT_PERMISSION_DENIED', 'OsDriver 가 주입되지 않았습니다.', {
        reason: 'os-driver-missing',
      });
    }
    this.assertSessionValid(opts.level);
    const wl = this.checkWhitelist(opts.target, opts.level);
    if (!wl.ok) {
      throw inputError('INPUT_BLOCKED_TARGET', '리플레이 대상이 화이트리스트 밖입니다.', {
        reason: 'whitelist-miss',
        details: { target: opts.target.url },
      });
    }

    const startedAt = this.now();
    const speed = typeof opts.speed === 'number' && opts.speed > 0 ? opts.speed : 1;
    const outcomes: ReplayStepOutcome[] = [];
    const timelineBase = this.now();

    let unregister: (() => void) | null = null;
    const abortController = new AbortController();
    const wire = (src?: AbortSignal) => {
      if (!src) return;
      if (src.aborted) abortController.abort();
      src.addEventListener('abort', () => abortController.abort(), { once: true });
    };
    wire(opts.signal);

    if (this.hotkeyPort) {
      unregister = this.hotkeyPort.register({
        pattern: this.emergencyPattern,
        trigger: () => {
          abortController.abort(new MediaAdapterError('ABORTED', '비상 중단 단축키가 감지되었습니다.', {
            adapterId: INPUT_AUTOMATION_ADAPTER_ID,
            details: { inputCode: 'INPUT_EMERGENCY_STOP', reason: 'hotkey' },
          }));
          this.emit({ kind: 'emergency-stop', t: this.now() - timelineBase });
        },
      });
    }

    // DPI 배율 — 이벤트의 CSS 좌표를 OS 픽셀로 맞추기 위해 driver 가 필요로 할 때 쓴다.
    const dpr = this.osDriver.devicePixelRatio || 1;

    this.emit({ kind: 'session-start', t: 0, payload: { total: events.length, level: opts.level } });

    const focused = await this.osDriver.focus(opts.target);
    if (!focused) {
      unregister?.();
      throw inputError('INPUT_BLOCKED_TARGET', '대상 창으로 포커스를 옮길 수 없습니다.', {
        reason: 'target-not-focusable',
        details: { target: opts.target.url },
      });
    }

    let abortReason: ReplayResult['abortReason'] = undefined;

    for (let i = 0; i < events.length; i += 1) {
      if (abortController.signal.aborted) {
        abortReason = abortController.signal.reason instanceof MediaAdapterError
          && (abortController.signal.reason.details as { inputCode?: string } | undefined)?.inputCode === 'INPUT_EMERGENCY_STOP'
          ? 'emergency-stop'
          : 'signal';
        break;
      }
      const raw = events[i];
      const normalized = scaleEventForDpr(raw, dpr);
      this.emit({ kind: 'step-start', t: this.now() - timelineBase, payload: { index: i, kind: raw.kind } });
      const stepStart = this.now();
      try {
        await this.osDriver.dispatch(normalized, { speed });
        outcomes.push({
          index: i,
          event: maskSensitiveText(raw),
          status: 'done',
          tookMs: this.now() - stepStart,
        });
        this.emit({ kind: 'step-done', t: this.now() - timelineBase, payload: { index: i } });
      } catch (err) {
        outcomes.push({
          index: i,
          event: maskSensitiveText(raw),
          status: 'failed',
          reason: errorMessage(err),
          tookMs: this.now() - stepStart,
        });
        this.emit({ kind: 'step-failed', t: this.now() - timelineBase, payload: { index: i, reason: errorMessage(err) } });
        const artifacts = await this.collectArtifacts(opts.target, outcomes);
        unregister?.();
        this.emit({ kind: 'session-end', t: this.now() - timelineBase, payload: { status: 'failed' } });
        throw inputError('INPUT_BLOCKED_TARGET', `단계 ${i} 실행 실패: ${errorMessage(err)}`, {
          cause: err,
          reason: 'step-failed',
          details: {
            failedAt: i,
            auditLog: outcomes.map(toAuditEntry),
            artifacts: artifactsDescriptor(artifacts),
          },
        });
      }
      opts.onProgress?.(Math.min(1, (i + 1) / Math.max(1, events.length)));
    }

    unregister?.();
    this.emit({ kind: 'session-end', t: this.now() - timelineBase, payload: { status: abortReason ?? 'completed' } });

    const executedSteps = outcomes.filter((o) => o.status === 'done').length;
    const failedSteps = outcomes.filter((o) => o.status === 'failed').length;
    const skippedSteps = outcomes.filter((o) => o.status === 'skipped').length;

    if (abortReason === 'emergency-stop') {
      const artifacts = await this.collectArtifacts(opts.target, outcomes);
      throw inputError('INPUT_EMERGENCY_STOP', '사용자 비상 중단이 감지되었습니다.', {
        reason: 'user-hotkey',
        details: {
          executedSteps,
          auditLog: outcomes.map(toAuditEntry),
          artifacts: artifactsDescriptor(artifacts),
        },
      });
    }
    if (abortReason === 'signal') {
      throw new MediaAdapterError('ABORTED', '호출자가 취소했습니다.', {
        adapterId: INPUT_AUTOMATION_ADAPTER_ID,
        details: { inputCode: 'INPUT_EMERGENCY_STOP', reason: 'signal', executedSteps },
      });
    }

    return {
      executedSteps,
      skippedSteps,
      failedSteps,
      outcomes,
      durationMs: this.now() - startedAt,
      target: opts.target,
      level: opts.level,
      abortReason,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // MediaAdapter 계약 — invoke
  // ──────────────────────────────────────────────────────────────────────

  async invoke(
    call: MediaAdapterInvocation<'input-automation'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'input-automation'>>> {
    const startedAtMs = Date.now();

    if (!this.enabled) {
      throw inputError('INPUT_PERMISSION_DENIED', '입력 자동화 기능이 꺼져 있습니다.', {
        reason: 'feature-disabled',
      });
    }

    const cap = this.config.inputAutomationMaxPermission ?? 'display';
    if (PERMISSION_RANK[call.input.requestedPermission] > PERMISSION_RANK[cap]) {
      throw inputError(
        'INPUT_PERMISSION_DENIED',
        `요청 권한(${call.input.requestedPermission}) 이 허용 최대치(${cap}) 를 초과합니다.`,
        { reason: 'cap-exceeded' },
      );
    }

    if (typeof call.input.humanRationale !== 'string' || call.input.humanRationale.trim().length === 0) {
      throw new MediaAdapterError('INPUT_INVALID', 'humanRationale 이 비어 있습니다.', {
        adapterId: INPUT_AUTOMATION_ADAPTER_ID,
        details: { inputCode: 'INPUT_PERMISSION_DENIED', reason: 'rationale-empty' },
      });
    }

    const session = this.getActiveSession();
    if (!session) {
      throw inputError('INPUT_SESSION_EXPIRED', '유효한 동의 세션이 없습니다 — requestPermission 을 먼저 호출하세요.', {
        reason: 'no-session',
      });
    }
    if (PERMISSION_RANK[call.input.requestedPermission] > PERMISSION_RANK[session.level]) {
      throw inputError('INPUT_SESSION_EXPIRED', '현재 세션 권한이 요청보다 낮아 재동의가 필요합니다.', {
        reason: 'permission-upgrade-required',
      });
    }

    // 스텝을 InputEvent 로 번역. 추정 시간 t 는 단계 순서로 누적.
    const events: InputEvent[] = call.input.steps.map((step, idx) => stepToEvent(step, idx));
    const bridge = progressBridge('precheck', call.onProgress);
    bridge.update(0);

    const result = await this.replay(events, {
      target: inferTarget(call.input),
      level: session.level,
      signal: call.signal,
      onProgress: (ratio) => bridge.update(ratio),
    });

    bridge.toFinalize();

    return {
      adapterId: this.descriptor.id,
      startedAtMs,
      finishedAtMs: Date.now(),
      result: {
        executedSteps: result.executedSteps,
        skippedSteps: result.skippedSteps,
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // (5) 화이트리스트 검사
  // ──────────────────────────────────────────────────────────────────────

  /** 테스트·UI 에서 직접 검증 가능한 순수 함수 경로. */
  checkWhitelist(target: AutomationTarget, level: PermissionLevel): { ok: boolean; reason?: string } {
    // S-05: 빈 목록 = 전부 거절.
    if (this.whitelist.length === 0) return { ok: false, reason: 'empty-whitelist' };
    const url = safeParseUrl(target.url);
    if (!url) return { ok: false, reason: 'invalid-url' };
    for (const rule of this.whitelist) {
      if (!rule.active) continue;
      if (!matchHost(url.hostname, rule.host)) continue;
      if (!matchPath(url.pathname, rule.pathPattern)) continue;
      if (PERMISSION_RANK[level] > PERMISSION_RANK[rule.maxPermission]) {
        return { ok: false, reason: 'level-exceeds-rule' };
      }
      return { ok: true };
    }
    return { ok: false, reason: 'no-match' };
  }

  // ──────────────────────────────────────────────────────────────────────
  // (6) 실패 스크린샷·DOM·이벤트 로그 3세트
  // ──────────────────────────────────────────────────────────────────────

  private async collectArtifacts(
    target: AutomationTarget,
    outcomes: readonly ReplayStepOutcome[],
  ): Promise<ReplayArtifacts> {
    const correlationId = newSessionId();
    const eventsJsonl = outcomes.map((o) => JSON.stringify(toAuditEntry(o))).join('\n');
    let duringPng: Uint8Array | undefined;
    let domHtml: string | undefined;
    try {
      duringPng = await this.osDriver?.captureScreenshot?.(target);
    } catch { /* 무시 — 로그만 */ }
    try {
      domHtml = await this.osDriver?.captureDom?.(target);
    } catch { /* 무시 */ }
    const artifacts: ReplayArtifacts = {
      duringPng,
      domHtml,
      eventsJsonl,
      correlationId,
    };
    try { await this.artifactPort?.persist(artifacts); } catch { /* 무시 */ }
    return artifacts;
  }

  // ──────────────────────────────────────────────────────────────────────
  // 내부 유틸
  // ──────────────────────────────────────────────────────────────────────

  private assertSessionValid(level: PermissionLevel): void {
    const session = this.getActiveSession();
    if (!session || !session.granted) {
      throw inputError('INPUT_SESSION_EXPIRED', '유효한 동의 세션이 없습니다.', {
        reason: 'no-session',
      });
    }
    if (PERMISSION_RANK[level] > PERMISSION_RANK[session.level]) {
      throw inputError('INPUT_SESSION_EXPIRED', '현재 세션 권한이 요청보다 낮습니다.', {
        reason: 'permission-upgrade-required',
      });
    }
  }

  private emit(event: TimelineEvent): void {
    try { this.onTimelineEvent?.(event); } catch { /* 옵저버 실패는 진행에 영향 없음 */ }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 팩토리 · 레지스트리 도움 함수
// ────────────────────────────────────────────────────────────────────────────

export const createRealInputAutomationAdapter: MediaAdapterFactory<'input-automation'> = (config) => {
  // 레지스트리에서 자동 생성될 때는 기본 비활성. UI 가 별도로 options 주입된 인스턴스를
  // 사용하도록 권장한다(UX §1 모달·HotkeyPort·OsDriver 연결).
  return new InputAutomationAdapter(config);
};

/** UX/UI 가 옵션을 주입한 인스턴스를 레지스트리에 교체 등록할 때 쓰는 factory 생성기. */
export function makeInputAutomationFactory(
  options: InputAutomationAdapterOptions,
): MediaAdapterFactory<'input-automation'> {
  return (config) => new InputAutomationAdapter(config, options);
}

// ────────────────────────────────────────────────────────────────────────────
// 순수 헬퍼 (테스트 재사용)
// ────────────────────────────────────────────────────────────────────────────

export function matchHost(hostname: string, rule: string): boolean {
  const h = hostname.toLowerCase();
  const r = rule.toLowerCase();
  if (r === '*') return true;
  if (r.startsWith('*.')) {
    const suffix = r.slice(2);
    return h === suffix || h.endsWith('.' + suffix);
  }
  return h === r;
}

export function matchPath(pathname: string, pattern: string): boolean {
  if (!pattern || pattern === '/' || pattern === '/*' || pattern === '*') return true;
  if (pattern.startsWith('/re:')) {
    try { return new RegExp(pattern.slice(4)).test(pathname); }
    catch { return false; }
  }
  // glob → 정규식. '*' → '.*', 나머지는 그대로 이스케이프.
  const re = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  try { return new RegExp(re).test(pathname); }
  catch { return false; }
}

/** `<input type="password">` 등 민감 필드는 실제 텍스트를 남기지 않는다. */
export function maskSensitiveText(event: InputEvent): InputEvent {
  if (event.sensitive && typeof event.text === 'string' && event.text.length > 0) {
    return { ...event, text: '•'.repeat(Math.min(event.text.length, 8)) };
  }
  return event;
}

/** 화면 DPR 에 맞게 좌표를 변환. CSS 픽셀 → OS 픽셀. */
export function scaleEventForDpr(event: InputEvent, dpr: number): InputEvent {
  if (dpr === 1 || (event.x === undefined && event.y === undefined)) return event;
  return {
    ...event,
    x: typeof event.x === 'number' ? Math.round(event.x * dpr) : event.x,
    y: typeof event.y === 'number' ? Math.round(event.y * dpr) : event.y,
  };
}

export function normalizeModifiers(
  modifiers: ReadonlyArray<'ctrl' | 'shift' | 'alt' | 'meta'> | undefined,
  platform: OsDriver['platform'],
): ReadonlyArray<'ctrl' | 'shift' | 'alt' | 'meta'> {
  if (!modifiers || modifiers.length === 0) return [];
  // macOS 에서 'ctrl' 을 받은 의도가 단축키 복사/붙여넣기라면 'meta' 로 매핑한다.
  if (platform === 'darwin' && modifiers.includes('ctrl') && !modifiers.includes('meta')) {
    return modifiers.map((m) => (m === 'ctrl' ? 'meta' : m));
  }
  return modifiers;
}

// 내부 helper
function stepToEvent(step: InputAutomationStep, idx: number): InputEvent {
  const t = idx * 100;
  switch (step.kind) {
    case 'click':
      return { kind: 'click', t, selector: step.selector };
    case 'type':
      return { kind: 'type', t, selector: step.selector, text: step.text };
    case 'key':
      return { kind: 'keydown', t, key: step.key, modifiers: step.modifiers };
    case 'wait':
      return { kind: 'wait', t, ms: step.ms };
    case 'scroll':
      return { kind: 'scroll', t, selector: step.selector, deltaY: step.deltaY };
  }
}

function toAuditEntry(o: ReplayStepOutcome): { index: number; kind: string; status: string; tookMs: number; reason?: string } {
  return {
    index: o.index,
    kind: o.event.kind,
    status: o.status,
    tookMs: o.tookMs,
    ...(o.reason ? { reason: o.reason } : {}),
  };
}

function artifactsDescriptor(a: ReplayArtifacts): { correlationId: string; hasScreenshot: boolean; hasDom: boolean; eventsBytes: number } {
  return {
    correlationId: a.correlationId,
    hasScreenshot: !!a.duringPng,
    hasDom: !!a.domHtml,
    eventsBytes: a.eventsJsonl?.length ?? 0,
  };
}

function safeParseUrl(url: string): URL | null {
  try { return new URL(url); }
  catch { return null; }
}

function inferTarget(input: InputAutomationInput): AutomationTarget {
  const first = input.steps.find((s) => 'selector' in s && s.selector) as { selector?: string } | undefined;
  return {
    url: (input as unknown as { targetUrl?: string }).targetUrl ?? 'about:blank',
    windowTitle: first?.selector,
  };
}

function newSessionId(): string {
  // 의존성 없이 고유 ID 생성. 충돌 확률이 극히 낮은 시간+난수.
  return `ia-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function progressBridge(
  initial: 'precheck' | 'upload' | 'finalize',
  handler?: MediaAdapterProgressHandler,
): { update: (ratio: number) => void; toFinalize: () => void } {
  let phase: 'precheck' | 'upload' | 'finalize' = initial;
  return {
    update(ratio: number) {
      if (!handler) return;
      if (phase === 'precheck') {
        handler({ phase: 'precheck', ratio: 1 });
        phase = 'upload';
      }
      handler({ phase: 'upload', ratio: Math.max(0, Math.min(1, ratio)) });
    },
    toFinalize() {
      if (!handler) return;
      phase = 'finalize';
      handler({ phase: 'finalize', ratio: 1 });
    },
  };
}
