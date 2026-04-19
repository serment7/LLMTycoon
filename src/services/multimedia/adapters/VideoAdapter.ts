// 지시 #804155ce · VideoAdapter 실제 구현.
//
// 영상 생성은 (1) 공급자 큐에 작업을 등록 → (2) 완료까지 폴링 또는 웹훅 통지 →
// (3) 완료 자산 URL 수집 의 3단 파이프라인이다. 본 파일은 세 공급자(Runway · Pika ·
// StabilityVideo) 를 지원하는 실구현과, 스토리보드 샷 분해 헬퍼, JobQueue ·
// BudgetLimiter · 컨텐츠 정책 사전 점검 훅 · 워터마크/메타데이터 기록을 함께 담는다.
//
// 설계 요약
//   · generateVideo(spec, opts) 최상위 함수는 공급자 주입 후 create → poll 또는
//     webhook 수신까지 한 점에서 감싼다. 호출자는 최종 VideoJob(id/status/progress/
//     resultUrl/costEstimate) 하나만 돌려받는다.
//   · JobQueue 는 동시 실행 상한을 두고 pending 작업을 직렬화한다(레이트 리밋 대신
//     "한꺼번에 20 건 쏘지 말라" 는 운영 축).
//   · BudgetLimiter 는 호출 단위 누적 코스트(초당 단가 × durationSec) 를 상한과 비교.
//     호출자 세션 안에서 초과되면 VIDEO_QUOTA_EXCEEDED 즉시 발화.
//   · 컨텐츠 정책 사전 점검은 휴리스틱(금지어·미성년·저작권 키워드) + 훅 주입. UI 가
//     이후 Claude 기반 moderator 로 교체할 수 있도록 policyChecker 를 구성 훅으로 둠.
//   · 워터마크·메타데이터는 완료 이벤트에 붙어 UI 가 렌더할 수 있게 한다(파일 삽입은
//     후속 ffmpeg 단계 — 본 어댑터는 문자열 메타로만 기록).
//   · 표준 오류 코드 4종(VIDEO_QUOTA_EXCEEDED · VIDEO_PROVIDER_ERROR ·
//     VIDEO_POLICY_BLOCKED · VIDEO_RENDER_ERROR) 을 MediaAdapterError.details.videoCode
//     로 부여해 UI 의 "원인별 카피" 매핑이 가능하게 한다.

import {
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterInvocation,
  type MediaAdapterOutcome,
  type MediaAdapterOutput,
  type MultimediaAdapterConfig,
  type VideoGenerationInput,
} from '../types';

export const VIDEO_REAL_ADAPTER_ID = 'video-v1';
export const VIDEO_ALIAS = 'video/generate';

// ────────────────────────────────────────────────────────────────────────────
// 공개 타입 — VideoJob · VideoSpec · VideoProvider
// ────────────────────────────────────────────────────────────────────────────

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '21:9';
export type VideoStyle = 'realistic' | 'cinematic' | 'animation' | 'anime' | 'vintage' | 'claymation';
export type VideoAudioMode = 'silent' | 'music' | 'voiceover' | 'sfx';
export type VideoJobStatus = 'queued' | 'rendering' | 'succeeded' | 'failed' | 'canceled';

export interface VideoSpec {
  readonly prompt: string;
  readonly durationSec: number;
  readonly aspectRatio: AspectRatio;
  readonly fps: number;
  readonly seed?: number;
  readonly style?: VideoStyle;
  readonly audio?: VideoAudioMode;
  /** 스토리보드 샷 분해를 위해 호출자가 힌트로 줄 수 있는 샷 수. 기본 1. */
  readonly shotCount?: number;
  /** 워터마크 텍스트. 공백이면 생략. */
  readonly watermark?: string;
}

export interface VideoJob {
  readonly id: string;
  readonly status: VideoJobStatus;
  /** 0~1. 공급자가 비례 보고하지 않으면 상태 전이 시 0/0.5/1 로 근사. */
  readonly progress: number;
  readonly resultUrl?: string;
  readonly previewUrl?: string;
  readonly costEstimate: number;
  readonly provider: string;
  readonly errorCode?: VideoErrorCode;
  readonly errorMessage?: string;
  readonly metadata: VideoJobMetadata;
}

export interface VideoJobMetadata {
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly prompt: string;
  readonly durationSec: number;
  readonly aspectRatio: AspectRatio;
  readonly fps: number;
  readonly watermark?: string;
  readonly shotCount: number;
  readonly policyChecked: boolean;
  readonly policyFlags?: readonly string[];
}

export type VideoErrorCode =
  | 'VIDEO_QUOTA_EXCEEDED'
  | 'VIDEO_PROVIDER_ERROR'
  | 'VIDEO_POLICY_BLOCKED'
  | 'VIDEO_RENDER_ERROR'
  | 'VIDEO_INVALID_INPUT';

// ────────────────────────────────────────────────────────────────────────────
// 입력 검증 상한 — sanitize 의 clamp 범위보다 넉넉하게 두고, 명백히 비정상인
// 값만 거절한다. "오타 수준" 은 sanitize 가 정규화(clamp)하고, "의도가 불분명한
// 과도한 값" 은 여기서 차단해 공급자 호출 전에 빠르게 실패시키는 것이 축이다.
// ────────────────────────────────────────────────────────────────────────────
export const MAX_PROMPT_LENGTH = 4_000;
export const MIN_DURATION_SEC = 1;
export const MAX_DURATION_SEC = 300;
export const MIN_FPS = 1;
export const MAX_FPS = 240;
export const SUPPORTED_ASPECT_RATIOS: readonly AspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '21:9'];
export const SUPPORTED_RESOLUTIONS: readonly string[] = ['720p', '1080p', '4k'];

export type VideoProgressStage = 'policy' | 'queue' | 'render' | 'compose' | 'finalize';

export interface VideoProgress {
  readonly stage: VideoProgressStage;
  readonly ratio: number;
  readonly message?: string;
  readonly shotIndex?: number;
  readonly shotTotal?: number;
}

export type VideoProgressHandler = (progress: VideoProgress) => void;

export interface VideoGenerateOptions {
  readonly onProgress?: VideoProgressHandler;
  readonly signal?: AbortSignal;
  /** 최대 폴링 시도 횟수. 기본 60 회(= 공급자별 delayMs 반영 총 대기 최대치). */
  readonly maxPollAttempts?: number;
  /** 폴링 간격(ms). 기본 2_000. */
  readonly pollIntervalMs?: number;
}

/**
 * 공급자 어댑터 — Runway/Pika/StabilityVideo 가 같은 모양으로 동작하도록 강제.
 * 실제 공급자는 createJob → pollJob(또는 subscribeWebhook) → cancelJob 3개 메서드로
 * 축약해 드라이버 계층의 단순성을 확보한다.
 */
export interface VideoProvider {
  readonly id: string;
  readonly requiresCredentials: boolean;
  isEnabled(): boolean;
  /** 초당 단가(USD). BudgetLimiter 가 예산 계산에 사용. */
  costPerSecond(): number;
  createJob(spec: VideoSpec, signal?: AbortSignal): Promise<VideoJob>;
  pollJob(jobId: string, signal?: AbortSignal): Promise<VideoJob>;
  cancelJob(jobId: string): Promise<void>;
  /** 선택. 웹훅을 붙일 수 있는 공급자만 구현. 없으면 폴링 경로만 쓴다. */
  attachWebhook?(jobId: string, callback: (job: VideoJob) => void): () => void;
}

// ────────────────────────────────────────────────────────────────────────────
// Content Policy — 사전 점검 훅
// ────────────────────────────────────────────────────────────────────────────

export interface PolicyCheckRequest {
  readonly spec: VideoSpec;
}

export interface PolicyCheckResult {
  readonly ok: boolean;
  readonly flags: readonly string[];
  readonly reason?: string;
}

export type PolicyChecker = (req: PolicyCheckRequest) => Promise<PolicyCheckResult>;

const POLICY_FORBIDDEN_PATTERNS: Array<{ flag: string; pattern: RegExp }> = [
  { flag: 'minor-sexualization', pattern: /\b(minor|child|kid|loli|shota)\b.*\b(nude|sexual|erotic|naked)\b/i },
  { flag: 'explicit-sexual', pattern: /\b(porn|xxx|explicit sex|nsfw)\b/i },
  { flag: 'illegal-violence', pattern: /\b(beheading|terror(ist)?|school shooting|mass murder)\b/i },
  { flag: 'copyright-clone', pattern: /\b(exact copy of|frame-accurate clone of)\b.*\b(disney|marvel|pixar|ghibli|mickey mouse|iron man|spider-?man|pokemon)\b/i },
  { flag: 'non-consensual', pattern: /\b(deepfake|non-?consensual|revenge porn)\b/i },
];

/** 기본 휴리스틱 정책 점검기 — 문자열 매칭 기반. 상위 훅으로 대체 가능. */
export const defaultPolicyChecker: PolicyChecker = async ({ spec }) => {
  const text = `${spec.prompt}`.trim();
  const flags: string[] = [];
  for (const rule of POLICY_FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(text)) flags.push(rule.flag);
  }
  if (flags.length === 0) return { ok: true, flags: [] };
  return {
    ok: false,
    flags,
    reason: `컨텐츠 정책 위반 소지: ${flags.join(', ')}`,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// JobQueue — 동시 실행 상한을 가진 경량 큐
// ────────────────────────────────────────────────────────────────────────────

export interface JobQueueOptions {
  readonly concurrency: number;
}

export class JobQueue {
  private readonly concurrency: number;
  private running = 0;
  private readonly pending: Array<() => void> = [];

  constructor(options: JobQueueOptions) {
    this.concurrency = Math.max(1, options.concurrency);
  }

  async acquire(): Promise<() => void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.pending.push(resolve));
    this.running += 1;
    return () => this.release();
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.pending.shift();
    if (next) next();
  }

  getSize(): { running: number; pending: number } {
    return { running: this.running, pending: this.pending.length };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// BudgetLimiter — 누적 코스트 상한
// ────────────────────────────────────────────────────────────────────────────

export interface BudgetLimiterOptions {
  /** 총 허용 코스트(USD). 초과하면 reserve() 가 false. */
  readonly maxCost: number;
}

export class BudgetLimiter {
  private readonly maxCost: number;
  private used = 0;

  constructor(options: BudgetLimiterOptions) {
    this.maxCost = options.maxCost;
  }

  /** true 를 돌려주면 예산을 예약해 used 를 늘림. false 면 초과. */
  reserve(cost: number): boolean {
    if (cost < 0) return false;
    if (this.used + cost > this.maxCost) return false;
    this.used += cost;
    return true;
  }

  /** 실행 실패 시 예약했던 예산을 되돌린다(부분 결과 정책 — 실제 렌더 실패 복구). */
  refund(cost: number): void {
    this.used = Math.max(0, this.used - cost);
  }

  getUsed(): number { return this.used; }
  getRemaining(): number { return Math.max(0, this.maxCost - this.used); }
}

// ────────────────────────────────────────────────────────────────────────────
// 스토리보드 샷 분해 — composeStoryboard
// ────────────────────────────────────────────────────────────────────────────

export interface Shot {
  readonly index: number;
  readonly prompt: string;
  readonly durationSec: number;
}

/**
 * 대본을 문장 기준으로 쪼개 샷을 만든다. ffmpeg 결합은 호출자(또는 후속 어댑터) 가
 * 책임진다 — 본 함수는 "공급자에 보낼 N 개의 VideoSpec" 을 만들 수 있게 준비만.
 */
export function composeStoryboard(
  script: string,
  opts: { totalDurationSec: number; maxShots?: number } = { totalDurationSec: 10 },
): Shot[] {
  const cleaned = (script ?? '').trim();
  if (!cleaned) return [];
  const maxShots = Math.max(1, opts.maxShots ?? 8);
  const rawSentences = cleaned
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const sentences = rawSentences.length > 0 ? rawSentences : [cleaned];
  const shotCount = Math.min(maxShots, sentences.length);
  const perShotDuration = Math.max(1, Math.floor(opts.totalDurationSec / shotCount));
  const shots: Shot[] = [];
  // 문장 수가 maxShots 보다 많으면 앞에서부터 2개씩 합친다.
  const grouped: string[] = [];
  const groupSize = Math.ceil(sentences.length / shotCount);
  for (let i = 0; i < sentences.length; i += groupSize) {
    grouped.push(sentences.slice(i, i + groupSize).join(' '));
  }
  const final = grouped.slice(0, shotCount);
  for (let i = 0; i < final.length; i += 1) {
    shots.push({ index: i + 1, prompt: final[i], durationSec: perShotDuration });
  }
  // 남은 초는 마지막 샷에 붙인다.
  const totalAssigned = perShotDuration * shots.length;
  if (totalAssigned < opts.totalDurationSec && shots.length > 0) {
    const last = shots[shots.length - 1];
    shots[shots.length - 1] = { ...last, durationSec: last.durationSec + (opts.totalDurationSec - totalAssigned) };
  }
  return shots;
}

// ────────────────────────────────────────────────────────────────────────────
// 공급자 3종 — Runway · Pika · StabilityVideo
// ────────────────────────────────────────────────────────────────────────────

export interface VideoProviderSettings {
  readonly preferredProviders?: readonly string[];
  readonly runway?: { apiKey?: string; endpoint?: string };
  readonly pika?: { apiKey?: string; endpoint?: string };
  readonly stability?: { apiKey?: string; endpoint?: string };
  readonly fetch?: typeof fetch;
}

export class VideoProviderHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number, opts: { cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'VideoProviderHttpError';
    this.status = status;
  }
}

const DEFAULT_RUNWAY_ENDPOINT = 'https://api.runwayml.com/v1';
const DEFAULT_PIKA_ENDPOINT = 'https://api.pika.art/v1';
const DEFAULT_STABILITY_ENDPOINT = 'https://api.stability.ai/v2beta';

function makeJob(partial: Partial<VideoJob> & Pick<VideoJob, 'id' | 'status' | 'provider'>, spec: VideoSpec, costPerSec: number): VideoJob {
  const now = Date.now();
  return {
    id: partial.id,
    status: partial.status,
    progress: partial.progress ?? (partial.status === 'succeeded' ? 1 : partial.status === 'queued' ? 0 : 0.5),
    resultUrl: partial.resultUrl,
    previewUrl: partial.previewUrl,
    costEstimate: partial.costEstimate ?? spec.durationSec * costPerSec,
    provider: partial.provider,
    errorCode: partial.errorCode,
    errorMessage: partial.errorMessage,
    metadata: partial.metadata ?? {
      createdAtMs: now,
      updatedAtMs: now,
      prompt: spec.prompt,
      durationSec: spec.durationSec,
      aspectRatio: spec.aspectRatio,
      fps: spec.fps,
      watermark: spec.watermark,
      shotCount: spec.shotCount ?? 1,
      policyChecked: false,
    },
  };
}

function mapProviderStatusToJob(raw: unknown, provider: string, spec: VideoSpec, costPerSec: number): VideoJob {
  if (!raw || typeof raw !== 'object') {
    throw new VideoProviderHttpError(`${provider} 응답 해석 실패`, 502);
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : typeof o.jobId === 'string' ? o.jobId : '';
  if (!id) throw new VideoProviderHttpError(`${provider} 응답에 jobId 가 없습니다.`, 502);
  const rawStatus = String(o.status ?? '').toLowerCase();
  let status: VideoJobStatus = 'queued';
  if (/succeed|complete|done|ready/.test(rawStatus)) status = 'succeeded';
  else if (/fail|error/.test(rawStatus)) status = 'failed';
  else if (/cancel/.test(rawStatus)) status = 'canceled';
  else if (/render|process|running/.test(rawStatus)) status = 'rendering';
  const progress = typeof o.progress === 'number'
    ? Math.max(0, Math.min(1, o.progress))
    : status === 'succeeded' ? 1 : status === 'queued' ? 0 : 0.5;
  const resultUrl = typeof o.resultUrl === 'string' ? o.resultUrl
    : typeof o.url === 'string' ? o.url
    : typeof o.outputUrl === 'string' ? o.outputUrl
    : undefined;
  const previewUrl = typeof o.previewUrl === 'string' ? o.previewUrl : undefined;
  return makeJob({ id, status, progress, resultUrl, previewUrl, provider }, spec, costPerSec);
}

export function createRunwayProvider(settings: VideoProviderSettings): VideoProvider {
  const apiKey = settings.runway?.apiKey;
  const endpoint = settings.runway?.endpoint ?? DEFAULT_RUNWAY_ENDPOINT;
  const fetchImpl = settings.fetch ?? fetch;
  const costPerSec = 0.05;
  return {
    id: 'runway',
    requiresCredentials: true,
    isEnabled: () => typeof apiKey === 'string' && apiKey.length > 0,
    costPerSecond: () => costPerSec,
    async createJob(spec, signal) {
      if (!apiKey) throw new VideoProviderHttpError('Runway API 키가 설정되어 있지 않습니다.', 401);
      const res = await fetchImpl(`${endpoint}/generate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: spec.prompt,
          duration: spec.durationSec,
          aspect_ratio: spec.aspectRatio,
          fps: spec.fps,
          seed: spec.seed,
          style: spec.style,
        }),
        signal,
      });
      if (!res.ok) throw new VideoProviderHttpError(`Runway 생성 요청 실패(HTTP ${res.status}).`, res.status);
      const body = await res.json();
      return mapProviderStatusToJob(body, 'runway', spec, costPerSec);
    },
    async pollJob(jobId, signal) {
      if (!apiKey) throw new VideoProviderHttpError('Runway API 키가 설정되어 있지 않습니다.', 401);
      const res = await fetchImpl(`${endpoint}/jobs/${encodeURIComponent(jobId)}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal,
      });
      if (!res.ok) throw new VideoProviderHttpError(`Runway 폴링 실패(HTTP ${res.status}).`, res.status);
      const body = await res.json();
      return mapProviderStatusToJob(body, 'runway', {
        prompt: '', durationSec: 0, aspectRatio: '16:9', fps: 24,
      }, costPerSec);
    },
    async cancelJob(jobId) {
      if (!apiKey) return;
      await fetchImpl(`${endpoint}/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      }).catch(() => undefined);
    },
  };
}

export function createPikaProvider(settings: VideoProviderSettings): VideoProvider {
  const apiKey = settings.pika?.apiKey;
  const endpoint = settings.pika?.endpoint ?? DEFAULT_PIKA_ENDPOINT;
  const fetchImpl = settings.fetch ?? fetch;
  const costPerSec = 0.03;
  return {
    id: 'pika',
    requiresCredentials: true,
    isEnabled: () => typeof apiKey === 'string' && apiKey.length > 0,
    costPerSecond: () => costPerSec,
    async createJob(spec, signal) {
      if (!apiKey) throw new VideoProviderHttpError('Pika API 키가 설정되어 있지 않습니다.', 401);
      const res = await fetchImpl(`${endpoint}/videos`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: spec.prompt,
          aspectRatio: spec.aspectRatio,
          fps: spec.fps,
          length: spec.durationSec,
          style: spec.style,
          seed: spec.seed,
        }),
        signal,
      });
      if (!res.ok) throw new VideoProviderHttpError(`Pika 생성 요청 실패(HTTP ${res.status}).`, res.status);
      const body = await res.json();
      return mapProviderStatusToJob(body, 'pika', spec, costPerSec);
    },
    async pollJob(jobId, signal) {
      if (!apiKey) throw new VideoProviderHttpError('Pika API 키가 설정되어 있지 않습니다.', 401);
      const res = await fetchImpl(`${endpoint}/videos/${encodeURIComponent(jobId)}`, {
        headers: { 'x-api-key': apiKey },
        signal,
      });
      if (!res.ok) throw new VideoProviderHttpError(`Pika 폴링 실패(HTTP ${res.status}).`, res.status);
      const body = await res.json();
      return mapProviderStatusToJob(body, 'pika', {
        prompt: '', durationSec: 0, aspectRatio: '16:9', fps: 24,
      }, costPerSec);
    },
    async cancelJob(jobId) {
      if (!apiKey) return;
      await fetchImpl(`${endpoint}/videos/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: { 'x-api-key': apiKey },
      }).catch(() => undefined);
    },
  };
}

export function createStabilityVideoProvider(settings: VideoProviderSettings): VideoProvider {
  const apiKey = settings.stability?.apiKey;
  const endpoint = settings.stability?.endpoint ?? DEFAULT_STABILITY_ENDPOINT;
  const fetchImpl = settings.fetch ?? fetch;
  const costPerSec = 0.04;
  return {
    id: 'stability',
    requiresCredentials: true,
    isEnabled: () => typeof apiKey === 'string' && apiKey.length > 0,
    costPerSecond: () => costPerSec,
    async createJob(spec, signal) {
      if (!apiKey) throw new VideoProviderHttpError('Stability API 키가 설정되어 있지 않습니다.', 401);
      const res = await fetchImpl(`${endpoint}/image-to-video`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: spec.prompt,
          seconds: spec.durationSec,
          aspect_ratio: spec.aspectRatio,
          seed: spec.seed,
        }),
        signal,
      });
      if (!res.ok) throw new VideoProviderHttpError(`Stability 생성 요청 실패(HTTP ${res.status}).`, res.status);
      const body = await res.json();
      return mapProviderStatusToJob(body, 'stability', spec, costPerSec);
    },
    async pollJob(jobId, signal) {
      if (!apiKey) throw new VideoProviderHttpError('Stability API 키가 설정되어 있지 않습니다.', 401);
      const res = await fetchImpl(`${endpoint}/image-to-video/result/${encodeURIComponent(jobId)}`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
        signal,
      });
      if (!res.ok) throw new VideoProviderHttpError(`Stability 폴링 실패(HTTP ${res.status}).`, res.status);
      const body = await res.json();
      return mapProviderStatusToJob(body, 'stability', {
        prompt: '', durationSec: 0, aspectRatio: '16:9', fps: 24,
      }, costPerSec);
    },
    async cancelJob(_jobId) {
      // Stability 는 공개 취소 API 가 없음 — no-op.
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// generateVideo() — 최상위 공개 함수
// ────────────────────────────────────────────────────────────────────────────

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MediaAdapterError('ABORTED', '영상 생성이 취소되었습니다.', {
      adapterId: VIDEO_REAL_ADAPTER_ID,
    });
  }
}

function videoError(
  code: VideoErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): MediaAdapterError {
  const mapped = code === 'VIDEO_QUOTA_EXCEEDED' ? 'QUOTA_EXCEEDED'
    : code === 'VIDEO_POLICY_BLOCKED' ? 'PERMISSION_DENIED'
    : code === 'VIDEO_INVALID_INPUT' ? 'INPUT_INVALID'
    : 'INTERNAL';
  return new MediaAdapterError(mapped, message, {
    adapterId: VIDEO_REAL_ADAPTER_ID,
    details: { videoCode: code, ...details },
  });
}

export interface VideoRuntime {
  readonly provider?: VideoProvider;
  readonly providers?: readonly VideoProvider[];
  readonly policyChecker?: PolicyChecker;
  readonly jobQueue?: JobQueue;
  readonly budgetLimiter?: BudgetLimiter;
  /** 폴링 간 sleep 을 가짜 시계로 대체할 수 있게 주입. 테스트 전용. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function pickProvider(providers: readonly VideoProvider[], preferred?: readonly string[]): VideoProvider | null {
  const ordered = preferred && preferred.length > 0
    ? [...preferred.map((id) => providers.find((p) => p.id === id)).filter(Boolean) as VideoProvider[], ...providers]
    : [...providers];
  for (const p of ordered) if (p.isEnabled()) return p;
  return null;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MediaAdapterError('ABORTED', '영상 생성 취소', { adapterId: VIDEO_REAL_ADAPTER_ID }));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MediaAdapterError('ABORTED', '영상 생성 취소', { adapterId: VIDEO_REAL_ADAPTER_ID }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sanitizeSpec(spec: VideoSpec): VideoSpec {
  const durationSec = Math.max(1, Math.min(60, Math.floor(spec.durationSec || 1)));
  const fps = Math.max(8, Math.min(60, Math.floor(spec.fps || 24)));
  return {
    ...spec,
    durationSec,
    fps,
    aspectRatio: spec.aspectRatio ?? '16:9',
  };
}

/**
 * 입력 검증 — sanitize 전에 호출된다. "명백히 비정상" 인 값만 거절해 공급자에
 * 쓰레기 요청을 보내지 않도록 차단한다. "오타 수준(예: fps=999)" 은 `sanitizeSpec`
 * 이 clamp 로 정규화하는 경로로 남겨 호환성을 유지한다.
 */
export function validateVideoSpec(spec: VideoSpec): void {
  if (!spec || typeof spec !== 'object') {
    throw videoError('VIDEO_INVALID_INPUT', '영상 사양(VideoSpec)이 비어 있습니다.');
  }
  const prompt = typeof spec.prompt === 'string' ? spec.prompt.trim() : '';
  if (!prompt) {
    throw videoError('VIDEO_INVALID_INPUT', '프롬프트가 비어 있습니다. 한 문장 이상 입력해 주세요.', {
      field: 'prompt',
    });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw videoError(
      'VIDEO_INVALID_INPUT',
      `프롬프트가 최대 허용 길이(${MAX_PROMPT_LENGTH}자)를 초과했습니다(${prompt.length}자).`,
      { field: 'prompt', length: prompt.length, max: MAX_PROMPT_LENGTH },
    );
  }
  if (!Number.isFinite(spec.durationSec)) {
    throw videoError('VIDEO_INVALID_INPUT', '영상 길이(durationSec)가 숫자가 아닙니다.', {
      field: 'durationSec', value: spec.durationSec,
    });
  }
  if (spec.durationSec < MIN_DURATION_SEC) {
    throw videoError(
      'VIDEO_INVALID_INPUT',
      `영상 길이는 최소 ${MIN_DURATION_SEC}초 이상이어야 합니다.`,
      { field: 'durationSec', value: spec.durationSec, min: MIN_DURATION_SEC },
    );
  }
  if (spec.durationSec > MAX_DURATION_SEC) {
    throw videoError(
      'VIDEO_INVALID_INPUT',
      `영상 길이는 최대 ${MAX_DURATION_SEC}초를 초과할 수 없습니다(요청 ${spec.durationSec}초).`,
      { field: 'durationSec', value: spec.durationSec, max: MAX_DURATION_SEC },
    );
  }
  if (!Number.isFinite(spec.fps)) {
    throw videoError('VIDEO_INVALID_INPUT', 'fps 가 숫자가 아닙니다.', {
      field: 'fps', value: spec.fps,
    });
  }
  if (spec.fps < MIN_FPS || spec.fps > MAX_FPS) {
    throw videoError(
      'VIDEO_INVALID_INPUT',
      `fps 는 ${MIN_FPS}~${MAX_FPS} 범위여야 합니다(요청 ${spec.fps}).`,
      { field: 'fps', value: spec.fps, min: MIN_FPS, max: MAX_FPS },
    );
  }
  if (!SUPPORTED_ASPECT_RATIOS.includes(spec.aspectRatio as AspectRatio)) {
    throw videoError(
      'VIDEO_INVALID_INPUT',
      `지원하지 않는 화면 비율입니다(요청 "${spec.aspectRatio}"). 허용: ${SUPPORTED_ASPECT_RATIOS.join(', ')}.`,
      { field: 'aspectRatio', value: spec.aspectRatio, supported: SUPPORTED_ASPECT_RATIOS },
    );
  }
}

export async function generateVideo(
  rawSpec: VideoSpec,
  options: VideoGenerateOptions = {},
  runtime: VideoRuntime = {},
): Promise<VideoJob> {
  ensureNotAborted(options.signal);
  // 입력 검증 — 원본 값으로 먼저 점검해 "명백히 과도/비정상" 인 요청을 즉시 거절한다.
  validateVideoSpec(rawSpec);
  const spec = sanitizeSpec(rawSpec);

  const provider = runtime.provider ?? pickProvider(runtime.providers ?? []);
  if (!provider) {
    throw videoError('VIDEO_PROVIDER_ERROR', '사용 가능한 영상 생성 공급자가 없습니다.');
  }
  const sleep = runtime.sleep ?? defaultSleep;

  // 1) 정책 사전 점검. ratio 는 policy→queue→render→finalize 구간에서 단조 증가하도록
  //    policy 0→0.05, queue 0.05→0.1, render 0.1→0.9, finalize 1.0 으로 매핑한다.
  options.onProgress?.({ stage: 'policy', ratio: 0, message: '컨텐츠 정책 점검' });
  const policyChecker = runtime.policyChecker ?? defaultPolicyChecker;
  const policy = await policyChecker({ spec });
  if (!policy.ok) {
    throw videoError(
      'VIDEO_POLICY_BLOCKED',
      policy.reason || '컨텐츠 정책에 의해 요청이 차단되었습니다.',
      { flags: policy.flags },
    );
  }

  // 2) 예산 예약. 예약 성공 여부를 플래그로 추적해 어떤 실패 경로에서도 누수 없이
  //    환불할 수 있게 한다(과거 pollJob 실패·maxAttempts 초과·abort 경로가 누수되던 문제).
  const cost = spec.durationSec * provider.costPerSecond();
  let budgetReserved = false;
  if (runtime.budgetLimiter) {
    if (!runtime.budgetLimiter.reserve(cost)) {
      throw videoError(
        'VIDEO_QUOTA_EXCEEDED',
        `예상 비용 $${cost.toFixed(4)} 가 남은 예산 $${runtime.budgetLimiter.getRemaining().toFixed(4)} 을 초과합니다.`,
        { cost, remaining: runtime.budgetLimiter.getRemaining() },
      );
    }
    budgetReserved = true;
  }
  const refundBudget = (): void => {
    if (budgetReserved && runtime.budgetLimiter) {
      runtime.budgetLimiter.refund(cost);
      budgetReserved = false;
    }
  };

  options.onProgress?.({ stage: 'policy', ratio: 0.05, message: '정책 점검 통과' });

  // 3) 큐잉.
  options.onProgress?.({ stage: 'queue', ratio: 0.05, message: '공급자 큐 대기' });
  const release = runtime.jobQueue ? await runtime.jobQueue.acquire() : () => undefined;
  options.onProgress?.({ stage: 'queue', ratio: 0.1, message: '공급자 큐에 작업 등록' });

  let currentJob: VideoJob;
  try {
    currentJob = await provider.createJob(spec, options.signal);
  } catch (err) {
    release();
    refundBudget();
    throw mapProviderError(err, provider.id, spec, cost);
  }

  // 4) 폴링 루프.
  const maxAttempts = Math.max(1, options.maxPollAttempts ?? 60);
  const pollInterval = Math.max(50, options.pollIntervalMs ?? 2_000);
  let attempt = 0;
  try {
    while (currentJob.status === 'queued' || currentJob.status === 'rendering') {
      ensureNotAborted(options.signal);
      if (attempt >= maxAttempts) {
        throw videoError(
          'VIDEO_RENDER_ERROR',
          `영상 렌더가 최대 폴링 시도(${maxAttempts}) 내에 완료되지 않았습니다.`,
          { partial: currentJob },
        );
      }
      // render 구간은 0.1 → 0.9 로 매핑해 policy/queue 이후 단조 증가를 보장한다.
      options.onProgress?.({
        stage: 'render',
        ratio: 0.1 + 0.8 * Math.max(0, Math.min(1, currentJob.progress)),
        message: `${provider.id} 렌더 진행 ${Math.round(currentJob.progress * 100)}%`,
      });
      await sleep(pollInterval, options.signal);
      attempt += 1;
      try {
        const next = await provider.pollJob(currentJob.id, options.signal);
        // 메타데이터는 초기 값 보존, 공급자 응답의 동적 필드만 병합한다.
        currentJob = {
          ...next,
          metadata: {
            ...currentJob.metadata,
            updatedAtMs: Date.now(),
            policyChecked: true,
            policyFlags: policy.flags.length > 0 ? policy.flags : undefined,
          },
          costEstimate: currentJob.costEstimate,
        };
      } catch (err) {
        throw mapProviderError(err, provider.id, spec, cost, currentJob);
      }
    }

    if (currentJob.status === 'failed') {
      throw videoError(
        'VIDEO_RENDER_ERROR',
        currentJob.errorMessage || `${provider.id} 렌더 실패`,
        { partial: currentJob, provider: provider.id },
      );
    }
    if (currentJob.status === 'canceled') {
      throw new MediaAdapterError('ABORTED', '영상 생성이 공급자에서 취소되었습니다.', {
        adapterId: VIDEO_REAL_ADAPTER_ID,
        details: { partial: currentJob, provider: provider.id },
      });
    }

    options.onProgress?.({ stage: 'finalize', ratio: 1, message: '영상 자산 확보' });
    return {
      ...currentJob,
      metadata: {
        ...currentJob.metadata,
        updatedAtMs: Date.now(),
        policyChecked: true,
        policyFlags: policy.flags.length > 0 ? policy.flags : undefined,
      },
    };
  } catch (err) {
    // 성공 경로가 아닌 모든 종료 — abort/maxAttempts/poll 실패/failed/canceled —
    // 여기서 일괄 환불한다. 이미 환불된 경우는 refundBudget 가 no-op.
    refundBudget();
    throw err;
  } finally {
    release();
  }
}

function mapProviderError(err: unknown, providerId: string, spec: VideoSpec, cost: number, partial?: VideoJob): MediaAdapterError {
  if (err instanceof MediaAdapterError) return err;
  if (err instanceof VideoProviderHttpError) {
    if (err.status === 429 || err.status === 402) {
      return videoError('VIDEO_QUOTA_EXCEEDED', `${providerId} 쿼터/결제 상태 이상(${err.status}).`, { provider: providerId, cost });
    }
    return videoError('VIDEO_PROVIDER_ERROR', `${providerId} 공급자 오류(${err.status}): ${err.message}`, {
      provider: providerId, status: err.status, partial,
    });
  }
  const e = err as { name?: string };
  if (e?.name === 'AbortError') {
    return new MediaAdapterError('ABORTED', '영상 생성이 취소되었습니다.', { adapterId: VIDEO_REAL_ADAPTER_ID });
  }
  return videoError('VIDEO_PROVIDER_ERROR', `${providerId} 공급자 요청 실패: ${errorMessage(err)}`, {
    provider: providerId,
    partial,
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// ────────────────────────────────────────────────────────────────────────────
// MediaAdapter<'video'> 구현
// ────────────────────────────────────────────────────────────────────────────

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'video',
    id: VIDEO_REAL_ADAPTER_ID,
    displayName: '영상 생성 어댑터(실구현)',
    supportedInputMimes: [],
    producedOutputMimes: ['video/mp4', 'video/webm'],
    capabilities: {
      canParse: false,
      canGenerate: true,
      streamsProgress: true,
      worksOffline: false,
      requiresUserConsent: false,
    },
    priority: -10,
    dependsOn: [],
  };
}

export interface VideoAdapterOptions {
  readonly runtime?: VideoRuntime;
  readonly settings?: VideoProviderSettings;
}

export class VideoAdapter implements MediaAdapter<'video'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();
  private readonly runtime: VideoRuntime;

  constructor(_config: MultimediaAdapterConfig, options: VideoAdapterOptions = {}) {
    const settings = options.settings ?? {};
    const providers = options.runtime?.providers ?? [
      createRunwayProvider(settings),
      createPikaProvider(settings),
      createStabilityVideoProvider(settings),
    ];
    this.runtime = {
      ...options.runtime,
      providers,
      jobQueue: options.runtime?.jobQueue ?? new JobQueue({ concurrency: 2 }),
    };
  }

  canHandle(input: VideoGenerationInput): boolean {
    if (!input || typeof input !== 'object') return false;
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) return false;
    if (typeof input.durationSeconds === 'number' && input.durationSeconds <= 0) return false;
    return true;
  }

  async generateVideo(spec: VideoSpec, options: VideoGenerateOptions = {}): Promise<VideoJob> {
    return generateVideo(spec, options, this.runtime);
  }

  async invoke(
    call: MediaAdapterInvocation<'video'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'video'>>> {
    const startedAtMs = Date.now();
    // types.ts 의 VideoGenerationInput.resolution 은 '720p'|'1080p'|'4k' 이라
    // 화면 비율을 담지 않는다. 본 어댑터는 VideoSpec.aspectRatio 를 16:9 기본으로 두고,
    // UI 가 세부 비율을 원하면 generateVideo() 로 직접 호출하도록 안내한다.
    // 런타임에서 타입 밖 값이 들어오면(JS 호출 등) 여기서 명시적으로 거절한다.
    if (
      call.input.resolution !== undefined &&
      !SUPPORTED_RESOLUTIONS.includes(call.input.resolution)
    ) {
      throw videoError(
        'VIDEO_INVALID_INPUT',
        `지원하지 않는 해상도입니다(요청 "${call.input.resolution}"). 허용: ${SUPPORTED_RESOLUTIONS.join(', ')}.`,
        { field: 'resolution', value: call.input.resolution, supported: SUPPORTED_RESOLUTIONS },
      );
    }
    const spec: VideoSpec = {
      prompt: call.input.prompt,
      durationSec: call.input.durationSeconds ?? 6,
      aspectRatio: '16:9',
      fps: 24,
    };
    const job = await this.generateVideo(spec, {
      signal: call.signal,
      onProgress: (p) => call.onProgress?.({
        phase: p.stage === 'finalize' ? 'finalize' : 'upload',
        ratio: p.ratio,
        message: p.message,
      }),
    });
    return {
      adapterId: this.descriptor.id,
      startedAtMs,
      finishedAtMs: Date.now(),
      result: {
        jobId: job.id,
        assetId: job.resultUrl,
        previewUrl: job.previewUrl,
      },
    };
  }
}

export const createVideoRealAdapter: MediaAdapterFactory<'video'> =
  (config) => new VideoAdapter(config);

export function registerVideoAdapter(
  register: (factory: MediaAdapterFactory<'video'>, descriptor: MediaAdapterDescriptor) => void,
  options: { alias?: string } = {},
): void {
  const probe = new VideoAdapter({ maxBytes: 0, timeoutMs: 0 });
  register(createVideoRealAdapter, {
    ...probe.descriptor,
    displayName: `${probe.descriptor.displayName} (${options.alias ?? VIDEO_ALIAS})`,
  });
}
