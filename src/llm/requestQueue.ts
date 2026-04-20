// 지시 #5bd4374f · LLM 요청 큐의 공용 이벤트 계약 + 경량 pub/sub.
//
// 본 모듈은 아직 큐의 "실제 전송/재시도" 로직을 담지 않는다 — Thanos 의 `client.ts`·
// `tokenBudget.ts` 가 실제 호출을 수행하고, 그 과정에서 본 이벤트 버스에 emit 한다.
// 본 파일의 역할은 `TokenUsageAlerts` 같은 UI 가 구독할 수 있도록 안정된 타입·
// 인터페이스를 먼저 고정하는 것.
//
// 이벤트 종류
//   · retry: 요청 재시도(n/m). UI 가 "재시도 중…" 토스트로 노출.
//   · rate-limited: 레이트 리밋 대기. `retryAfterSeconds` 동반.
//   · token-threshold: 세션 토큰 사용량이 80%·95% 선을 넘을 때 emit. `level` 두 값.
//
// 설계 원칙
//   · 리스너 실패 격리 — 한 구독자 예외가 다른 구독자에 번지지 않는다.
//   · 모듈 전역 버스 `requestQueueBus` 와, 테스트 친화용 `createRequestQueueBus()` 팩토리.

export type TokenThresholdLevel = 'warn' | 'critical';

export type RequestQueueEvent =
  | {
      readonly kind: 'retry';
      readonly requestId: string;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly reason?: string;
    }
  | {
      readonly kind: 'rate-limited';
      readonly requestId: string;
      readonly retryAfterSeconds: number;
      readonly provider?: string;
    }
  | {
      readonly kind: 'token-threshold';
      readonly level: TokenThresholdLevel;
      /** 0~1 비율. 0.8 / 0.95 에서 주로 발화. */
      readonly ratio: number;
      readonly sessionId?: string;
    };

export type RequestQueueListener = (event: RequestQueueEvent) => void;

export interface RequestQueueBus {
  readonly emit: (event: RequestQueueEvent) => void;
  readonly subscribe: (listener: RequestQueueListener) => () => void;
  readonly __resetForTest: () => void;
}

export function createRequestQueueBus(): RequestQueueBus {
  const listeners = new Set<RequestQueueListener>();
  return {
    emit(event) {
      for (const l of listeners) {
        try {
          l(event);
        } catch {
          // 한 구독자 예외는 다른 구독자를 막지 않는다.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    __resetForTest() {
      listeners.clear();
    },
  };
}

/** 앱 전역 버스. 서버 사이드 emit 과 클라이언트 구독이 이 하나를 공유한다. */
export const requestQueueBus: RequestQueueBus = createRequestQueueBus();

// ────────────────────────────────────────────────────────────────────────────
// 임계값 감시 — recordUsageRatio(0~1) 를 호출할 때마다 직전 값과 비교해 80/95 선을
// "상향 교차" 할 때만 한 번 emit. 계속 같은 구간이면 중복 발화하지 않는다.
// ────────────────────────────────────────────────────────────────────────────

export interface ThresholdWatcher {
  readonly record: (ratio: number, sessionId?: string) => void;
  readonly reset: () => void;
}

export function createThresholdWatcher(bus: RequestQueueBus = requestQueueBus): ThresholdWatcher {
  let last = 0;
  return {
    record(ratio, sessionId) {
      const clamped = Number.isFinite(ratio) && ratio >= 0 ? Math.min(ratio, 1) : 0;
      if (last < 0.8 && clamped >= 0.8 && clamped < 0.95) {
        bus.emit({ kind: 'token-threshold', level: 'warn', ratio: clamped, sessionId });
      } else if (last < 0.95 && clamped >= 0.95) {
        bus.emit({ kind: 'token-threshold', level: 'critical', ratio: clamped, sessionId });
      }
      last = clamped;
    },
    reset() {
      last = 0;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 지시 #4cc1a134 — 요청 회복층 엔진
//
// 기존 이벤트 버스 위에 실제 "요청 실행 큐" 를 올린다. 장시간 세션이 API 실패·
// 레이트 리밋에 휘둘리지 않도록 네 축을 제공한다.
//   1) 우선순위 큐 — 낮은 priority 가 먼저 처리된다(숫자 기준). 기본 0.
//   2) 재시도 — 429 · 529 · 네트워크/timeout 분류에 한해 지수 백오프(1·2·4·8·16)
//              + ±20% jitter. 최대 5회. 4xx(400·401) 은 즉시 실패.
//   3) dedup — 동일 `callId` 로 들어온 두 번째 enqueue 는 기존 Promise 를 그대로
//              돌려준다. 새로 고침·복원 직후 같은 요청이 두 번 나가는 것을 차단.
//   4) 취소 — 호출자 `AbortSignal` 을 존중하며, 대기 중이면 즉시 제거·inflight 중
//              이면 execute(signal) 으로 전파. 취소 직후 refundedUsage 가 있으면
//              usageLog 에 `refund:true` 라인으로 남겨 감사 가능.
// ────────────────────────────────────────────────────────────────────────────

import type { ClaudeTokenUsage } from '../types';
import type { UsageLogSink } from './usageLog';

export type RequestFailureReason = '429' | '529' | 'network' | 'timeout' | 'aborted' | 'other';

export interface RequestQueueOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitter?: boolean;
  /** 동시 실행 수. 기본 1(순차). 장기 세션에서는 직렬화가 합리적. */
  readonly concurrency?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** jitter 계산용 0~1 난수 — 테스트는 고정값 주입. */
  readonly random?: () => number;
  readonly bus?: RequestQueueBus;
  readonly usageLog?: UsageLogSink;
  /** 취소되어 refund 가 발생할 때 호출자에게 알리는 훅. */
  readonly onRefund?: (callId: string, usage: ClaudeTokenUsage) => void;
}

export interface EnqueueInput<T> {
  readonly callId: string;
  readonly priority?: number;
  readonly signal?: AbortSignal;
  /** 실제 SDK 호출. signal 이 abort 되면 throw. usage 를 동반해 반환할 수 있다. */
  readonly execute: (signal: AbortSignal) => Promise<{ result: T; usage?: ClaudeTokenUsage }>;
  /**
   * 취소 시 refund 기준 사용량. 상위가 이미 usageLog 에 청구분을 기록한 경우,
   * 취소 즉시 반대 부호로 감사 라인을 추가해 "실제 남은 소비분" 을 추적할 수 있게 한다.
   */
  readonly refundedUsage?: ClaudeTokenUsage;
}

export interface RequestHandle<T> {
  readonly callId: string;
  readonly promise: Promise<T>;
}

export class RequestQueueError extends Error {
  readonly reason: RequestFailureReason;
  readonly attempts: number;
  readonly cause?: unknown;
  constructor(reason: RequestFailureReason, message: string, attempts: number, cause?: unknown) {
    super(message);
    this.name = 'RequestQueueError';
    this.reason = reason;
    this.attempts = attempts;
    this.cause = cause;
  }
}

interface InternalJob<T> {
  readonly input: EnqueueInput<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
  cancelled: boolean;
}

interface AbortErrorLike { name?: string; code?: string }

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const e = err as AbortErrorLike;
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

function classifyError(err: unknown): RequestFailureReason {
  if (isAbortError(err)) return 'aborted';
  const e = err as { status?: number; name?: string; code?: string; message?: string };
  if (e?.status === 429) return '429';
  if (e?.status === 529) return '529';
  if (e?.name === 'TimeoutError' || /timeout/i.test(e?.message ?? '')) return 'timeout';
  if (e?.name === 'TypeError') return 'network';
  if (typeof e?.code === 'string' && /ECONN|ETIMEOUT|ENETWORK|EAI_AGAIN/.test(e.code)) return 'network';
  return 'other';
}

function isRetryable(reason: RequestFailureReason): boolean {
  return reason === '429' || reason === '529' || reason === 'network' || reason === 'timeout';
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('aborted', 'AbortError')); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface QueueSize {
  readonly waiting: number;
  readonly inflight: number;
}

export class RequestQueue {
  private readonly opts: Required<Pick<RequestQueueOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'jitter' | 'concurrency' | 'sleep' | 'random'>>;
  private readonly bus: RequestQueueBus;
  private readonly usageLog?: UsageLogSink;
  private readonly onRefund?: (callId: string, usage: ClaudeTokenUsage) => void;
  private readonly waiting: InternalJob<unknown>[] = [];
  private readonly pending = new Map<string, Promise<unknown>>();
  private inflight = 0;

  constructor(options: RequestQueueOptions = {}) {
    this.opts = {
      maxRetries: options.maxRetries ?? 5,
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 15_000,
      jitter: options.jitter ?? true,
      concurrency: Math.max(1, options.concurrency ?? 1),
      sleep: options.sleep ?? defaultSleep,
      random: options.random ?? Math.random,
    };
    this.bus = options.bus ?? requestQueueBus;
    this.usageLog = options.usageLog;
    this.onRefund = options.onRefund;
  }

  size(): QueueSize {
    return { waiting: this.waiting.length, inflight: this.inflight };
  }

  enqueue<T>(input: EnqueueInput<T>): Promise<T> {
    const existing = this.pending.get(input.callId) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = new Promise<T>((resolve, reject) => {
      const job: InternalJob<T> = { input, resolve, reject, cancelled: false };
      // 우선순위 삽입 — priority 오름차순(숫자 작을수록 먼저).
      const priority = input.priority ?? 0;
      let i = 0;
      while (i < this.waiting.length && ((this.waiting[i] as InternalJob<unknown>).input.priority ?? 0) <= priority) i += 1;
      this.waiting.splice(i, 0, job as InternalJob<unknown>);

      // 호출자 abort 가 대기 중에 발생하면 즉시 제거 · refund · reject.
      if (input.signal) {
        const onAbort = () => {
          job.cancelled = true;
          const idx = this.waiting.indexOf(job as InternalJob<unknown>);
          if (idx >= 0) this.waiting.splice(idx, 1);
          this.handleRefund(input);
          this.bus.emit({ kind: 'retry', requestId: input.callId, attempt: 0, maxAttempts: this.opts.maxRetries, reason: 'aborted' });
          reject(new RequestQueueError('aborted', `요청 ${input.callId} 가 취소되었습니다.`, 0));
        };
        if (input.signal.aborted) { onAbort(); return; }
        input.signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    this.pending.set(input.callId, promise);
    // `promise` 가 reject 될 때 `.finally` 가 만드는 파생 Promise 가 미처리
    // rejection 으로 떠돌지 않도록 명시적으로 삼킨다(호출자는 원본 promise 로
    // reason 을 그대로 받는다).
    promise
      .finally(() => this.pending.delete(input.callId))
      .catch(() => undefined);
    // 비동기 drain 유도 — 호출자 Promise 반환 직전 큐 처리를 시작.
    queueMicrotask(() => { void this.drain(); });
    return promise;
  }

  cancel(callId: string): boolean {
    const idx = this.waiting.findIndex((j) => j.input.callId === callId);
    if (idx >= 0) {
      const job = this.waiting[idx];
      this.waiting.splice(idx, 1);
      job.cancelled = true;
      this.handleRefund(job.input);
      job.reject(new RequestQueueError('aborted', `요청 ${callId} 가 취소되었습니다.`, 0));
      return true;
    }
    return false;
  }

  private handleRefund(input: EnqueueInput<unknown>): void {
    if (!input.refundedUsage) return;
    this.onRefund?.(input.callId, input.refundedUsage);
    // usageLog 에는 별도 "refund:true" 라인으로 기록 — parseUsageLogLine 이 양수만 받도록 설계돼 있으므로
    // 감사 라인은 별도 스키마로 남기고, 정규 파서에서는 무시된다.
    if (!this.usageLog) return;
    const u = input.refundedUsage;
    const line = JSON.stringify({
      ts: u.at ?? new Date().toISOString(),
      model: u.model ?? 'unknown',
      refund: true,
      input: u.input_tokens, output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens, cacheCreation: u.cache_creation_input_tokens,
      callId: input.callId,
    });
    // fire-and-forget — 감사 로그 실패가 취소 흐름을 막지 않게 한다.
    void this.usageLog.appendLine(line).catch(() => undefined);
  }

  private async drain(): Promise<void> {
    while (this.waiting.length > 0 && this.inflight < this.opts.concurrency) {
      const job = this.waiting.shift();
      if (!job || job.cancelled) continue;
      this.inflight += 1;
      // runJob 내부에서 호출자 Promise 는 이미 job.resolve/reject 로 처리된다.
      // runJob 자체의 Promise 에 unhandled rejection 이 남지 않도록 catch 로 삼킨다.
      this.runJob(job)
        .catch(() => undefined)
        .finally(() => {
          this.inflight -= 1;
          void this.drain();
        });
    }
  }

  private async runJob(job: InternalJob<unknown>): Promise<void> {
    const { input } = job;
    const { maxRetries, baseDelayMs, maxDelayMs, jitter, random, sleep } = this.opts;
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt <= maxRetries) {
      attempt += 1;
      if (job.cancelled || input.signal?.aborted) {
        job.reject(new RequestQueueError('aborted', `요청 ${input.callId} 가 취소되었습니다.`, attempt - 1));
        return;
      }
      this.bus.emit({ kind: 'retry', requestId: input.callId, attempt, maxAttempts: maxRetries + 1, reason: attempt > 1 ? `attempt-${attempt}` : 'initial' });
      try {
        const signal = input.signal ?? new AbortController().signal;
        const outcome = await input.execute(signal);
        job.resolve(outcome.result);
        return;
      } catch (err) {
        lastError = err;
        const reason = classifyError(err);
        if (reason === 'aborted') {
          this.handleRefund(input);
          job.reject(new RequestQueueError('aborted', `요청 ${input.callId} 가 취소되었습니다.`, attempt, err));
          return;
        }
        if (!isRetryable(reason) || attempt > maxRetries) {
          job.reject(new RequestQueueError(reason, describeError(err), attempt, err));
          return;
        }
        // 레이트 리밋은 공용 이벤트에 별도 emit.
        if (reason === '429' || reason === '529') {
          const retryAfter = extractRetryAfterSeconds(err);
          this.bus.emit({
            kind: 'rate-limited',
            requestId: input.callId,
            retryAfterSeconds: retryAfter ?? Math.round((baseDelayMs * (2 ** (attempt - 1))) / 1_000),
          });
        }
        const raw = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
        const delay = jitter ? Math.max(0, raw + (random() * 2 - 1) * raw * 0.2) : raw;
        try {
          await sleep(delay, input.signal);
        } catch (e) {
          if (isAbortError(e)) {
            this.handleRefund(input);
            job.reject(new RequestQueueError('aborted', `요청 ${input.callId} 가 취소되었습니다.`, attempt, e));
            return;
          }
          throw e;
        }
      }
    }
    // 여기에 도달하면 루프 밖 — 보통 위에서 reject 되지만 방어적 코드.
    job.reject(new RequestQueueError('other', describeError(lastError), attempt, lastError));
  }
}

function extractRetryAfterSeconds(err: unknown): number | null {
  const e = err as { headers?: Record<string, string | undefined>; retryAfterSeconds?: unknown };
  if (typeof e?.retryAfterSeconds === 'number') return e.retryAfterSeconds;
  const v = e?.headers?.['retry-after'];
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

export function createRequestQueue(options: RequestQueueOptions = {}): RequestQueue {
  return new RequestQueue(options);
}
