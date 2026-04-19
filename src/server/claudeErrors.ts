// Claude API 호출 에러 분류기 + 재시도 정책. 순수 함수로 서버·테스트에서 공유한다.
// 실제 호출 경로(server.ts::callClaude, agentWorker::spawn, 클라이언트 fetch) 는
// 이 모듈의 `classifyClaudeError` 로 에러 유형을 수렴시키고, `withClaudeRetry` 로
// 재시도·백오프·타임아웃 정책을 한 곳에서 관리한다.
//
// 본 프로젝트는 아직 Anthropic SDK 를 사용하지 않지만, 분류기는 SDK 전환 시의
// 응답 객체(`status`, `headers['retry-after']`, `error.type`) 까지 선제적으로 받아낸다.
// HTTP fetch(`response.status`, Node `Error.code`) 경로도 동일한 분류기로 수렴.

import type { ClaudeErrorCategory } from '../types';

export type { ClaudeErrorCategory } from '../types';
export { CLAUDE_ERROR_CATEGORIES } from '../types';

export interface ClassifiedClaudeError {
  category: ClaudeErrorCategory;
  // rate_limit 응답의 `retry-after` 헤더(초 또는 HTTP-date) 가 있을 때 밀리초로 환산.
  retryAfterMs?: number;
  message: string;
  cause?: unknown;
}

// 구독 세션 폴백(#cdaaabf3) 전용 Error 하위 클래스.
// `classifyClaudeError` 는 status/type/메시지 기반 "분류기" 이고, 본 두 클래스는 내부
// 경로(서버·테스트) 에서 "의미 그대로" 던지고 받아 `instanceof` 분기를 쓸 수 있게 하는
// 용도다. 두 클래스 모두 `category` 속성을 가지고 있어 classifyClaudeError 와 동일한
// 축으로 수렴된다. 상속 순서: `TokenExhaustedError extends Error`, `SubscriptionExpiredError
// extends Error`. 서로 `instanceof` 관계로 엮지 않아 UI 가 두 경우를 분리해 안내할 수 있다.
export class TokenExhaustedError extends Error {
  readonly category: 'token_exhausted' = 'token_exhausted';
  readonly retryAfterMs?: number;
  constructor(message: string = '토큰이 소진되었습니다', options?: { cause?: unknown; retryAfterMs?: number }) {
    super(message);
    this.name = 'TokenExhaustedError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    if (typeof options?.retryAfterMs === 'number') this.retryAfterMs = options.retryAfterMs;
  }
}

export class SubscriptionExpiredError extends Error {
  readonly category: 'subscription_expired' = 'subscription_expired';
  constructor(message: string = '구독이 만료되었습니다', options?: { cause?: unknown }) {
    super(message);
    this.name = 'SubscriptionExpiredError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

interface NormalizedError {
  status?: number;
  code?: string;
  name?: string;
  message?: string;
  // 평문 객체(plain Record) · Web Fetch `Headers` 인스턴스 · Node http `IncomingHttpHeaders`
  // 어떤 형태로 들어와도 본 모듈 내부의 `readHeaderValue` 가 key 조회를 흡수한다.
  headers?: unknown;
  type?: string;
}

function pickNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function normalizeErrorInput(input: unknown): NormalizedError {
  if (!input || typeof input !== 'object') {
    return { message: typeof input === 'string' ? input : undefined };
  }
  const e = input as Record<string, unknown>;
  const response = (e.response as Record<string, unknown> | undefined) ?? undefined;
  const errField = e.error as Record<string, unknown> | undefined;
  // 최상위 → response.* → error.* 순으로 status 를 승계한다. Anthropic SDK 는 오류를
  // `{ status, error: { type, ... }, response: { status, headers } }` 형태로 던지므로
  // 세 경로 모두를 포섭해야 SDK 교체 이후에도 분류 매트릭스가 그대로 유지된다.
  const status = pickNumber(e.status) ?? pickNumber(response?.status) ?? pickNumber(errField?.status);
  const headers = response?.headers ?? e.headers;
  return {
    status,
    code: typeof e.code === 'string' ? e.code : undefined,
    name: typeof e.name === 'string' ? e.name : undefined,
    message: typeof e.message === 'string' ? e.message : undefined,
    headers,
    type: typeof e.type === 'string' ? e.type : (typeof errField?.type === 'string' ? errField.type : undefined),
  };
}

function readHeaderValue(headers: unknown, key: string): string | undefined {
  if (!headers) return undefined;
  // Web Fetch API `Headers` 인스턴스(Anthropic SDK 가 `error.response.headers` 로 던지는 실제 형태).
  // bracket 접근이 안 되므로 `.get()` 을 먼저 시도한다.
  const maybeGet = (headers as { get?: unknown }).get;
  if (typeof maybeGet === 'function') {
    try {
      const v = (maybeGet as (k: string) => unknown).call(headers, key);
      if (typeof v === 'string') return v;
    } catch {
      // 잘못된 Headers-like 객체가 들어왔을 때도 평문 조회로 폴백한다.
    }
  }
  if (typeof headers === 'object') {
    const h = headers as Record<string, unknown>;
    const lower = key.toLowerCase();
    const upperFirst = lower.replace(/\b\w/g, (c) => c.toUpperCase());
    const raw = h[key] ?? h[lower] ?? h[upperFirst];
    if (Array.isArray(raw)) {
      const first = raw[0];
      return typeof first === 'string' ? first : undefined;
    }
    return typeof raw === 'string' ? raw : undefined;
  }
  return undefined;
}

function parseRetryAfter(headers: unknown): number | undefined {
  const value = readHeaderValue(headers, 'retry-after');
  if (!value) return undefined;
  // 초 단위 정수 또는 HTTP-date.
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.floor(asNum * 1000);
  const t = Date.parse(value);
  if (Number.isFinite(t)) {
    const ms = t - Date.now();
    return ms > 0 ? ms : 0;
  }
  return undefined;
}

// CLI stderr 메시지 힌트(#864a097a). `server.ts::callClaude` exit≠0 경로는 status/
// type/code 가 모두 없이 문자열만 들어오므로, 의미 있는 단어가 섞여 있으면 5xx 폴백
// 전에 카테고리를 승격시켜 올바른 재시도 정책이 선택되게 한다. 각 패턴은 범용 영어
// 표현만 매칭(Anthropic CLI·SDK 가 공통으로 쓰는 어휘). 한국어 로컬라이즈 메시지
// 까지 확장하면 오탐이 늘 수 있어 영어 기본 메시지만 잡는다.
//
// `MSG_TOKEN_EXHAUSTED` / `MSG_SUBSCRIPTION_EXPIRED` (#cdaaabf3) 는 구독 세션 폴백용.
// 두 패턴은 rate_limit 보다 **구체적** 이므로 선행 체크한다 — Anthropic CLI/SDK 가
// 일시적 rate limit 과 "영구 소진/만료" 를 서로 다른 문구로 구분해 주기 때문에,
// 메시지 힌트 단계에서도 이 차이를 그대로 유지해야 UI 가 잘못 재시도 안내를 띄우지 않는다.
const MSG_TOKEN_EXHAUSTED      = /token[s]? (have )?(been )?(exhausted|used up|depleted)|credit[s]? (have )?(been )?exhausted|usage limit (reached|exceeded)|insufficient (credit|tokens?|balance)|monthly (quota|allowance) (exceeded|exhausted)|balance depleted/i;
const MSG_SUBSCRIPTION_EXPIRED = /subscription (has |is )?(expired|lapsed|inactive|not active|ended)|subscription required|trial (has )?(expired|ended)|plan (has )?expired|payment required/i;
const MSG_RATE_LIMIT = /rate[\s_-]?limit|quota (exceeded|exhausted)|too many requests/i;
const MSG_OVERLOADED = /overloaded|service unavailable|server busy/i;
const MSG_AUTH       = /invalid api key|unauthorized|forbidden|authentication (failed|error)/i;
const MSG_BAD_REQ    = /invalid (request|parameter|argument)|malformed (request|json|payload)|bad request/i;

/**
 * 공용 퍼블릭 API · 외부 호출 경로(서버·클라·테스트) 가 **동일한 7종 카테고리 집합** 을
 * 공유하도록 강제하는 단일 진입점. 반환값의 `category` 는 `retryPolicyFor` 키와 정확히
 * 1:1 대응하므로 재시도 판정도 이 함수 뒤에서만 내려야 한다.
 *
 * 분류 매트릭스(우선순위 순):
 *   402 | type=payment_required | type=subscription_expired → subscription_expired
 *   type=token_exhausted | type=insufficient_quota          → token_exhausted
 *   429 | type=rate_limit_error         → rate_limit (retry-after 존중)
 *   529 | type=overloaded_error          → overloaded
 *   401 | 403                            → auth
 *   400 | type=invalid_request_error     → bad_request
 *   AbortError | 408 | ETIMEDOUT | /timed? ?out/  → timeout
 *   ECONNRESET | ECONNREFUSED | ENOTFOUND | EAI_AGAIN | EPIPE | ENETUNREACH → network
 *   메시지 힌트: token_exhausted / subscription_expired / rate_limit / overloaded / auth / bad_request
 *   5xx | 그 외                          → api_error
 */
export function classifyClaudeError(input: unknown): ClassifiedClaudeError {
  // 서버 내부 경로가 `throw new TokenExhaustedError(...)` / `SubscriptionExpiredError`
  // 로 의도를 명확히 전달한 경우 그대로 수렴. 메시지 패턴을 거치면 오탐 위험이 있어
  // 최우선 분기로 둔다.
  if (input instanceof TokenExhaustedError) {
    return {
      category: 'token_exhausted',
      retryAfterMs: input.retryAfterMs,
      message: input.message || '토큰이 소진되었습니다',
      cause: input,
    };
  }
  if (input instanceof SubscriptionExpiredError) {
    return { category: 'subscription_expired', message: input.message || '구독이 만료되었습니다', cause: input };
  }

  const raw = normalizeErrorInput(input);
  const msg = (raw.message || '').trim();

  // 구독 만료 — 402 상태 코드 및 SDK 고유 type 을 rate_limit 보다 먼저 잡는다. 만료는
  // 재시도해도 복구되지 않으므로 rate_limit 이나 auth 정책이 덮어쓰면 무용한 재시도가
  // 발생한다.
  if (raw.status === 402
      || raw.type === 'payment_required'
      || raw.type === 'subscription_expired') {
    return { category: 'subscription_expired', message: msg || '구독이 만료되었습니다', cause: input };
  }
  if (raw.type === 'token_exhausted'
      || raw.type === 'insufficient_quota'
      || raw.type === 'credit_exhausted') {
    return { category: 'token_exhausted', message: msg || '토큰이 소진되었습니다', cause: input };
  }
  if (raw.status === 429 || raw.type === 'rate_limit_error') {
    return {
      category: 'rate_limit',
      retryAfterMs: parseRetryAfter(raw.headers),
      message: msg || 'rate limit 초과',
      cause: input,
    };
  }
  if (raw.status === 529 || raw.type === 'overloaded_error') {
    return { category: 'overloaded', message: msg || '서버 과부하', cause: input };
  }
  if (raw.status === 401 || raw.status === 403) {
    return { category: 'auth', message: msg || '인증 실패', cause: input };
  }
  if (raw.status === 400 || raw.type === 'invalid_request_error') {
    return { category: 'bad_request', message: msg || '잘못된 요청', cause: input };
  }
  if (raw.name === 'AbortError'
      || raw.code === 'ETIMEDOUT'
      || raw.status === 408
      || /timed? ?out/i.test(msg)) {
    return { category: 'timeout', message: msg || '타임아웃', cause: input };
  }
  const NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH']);
  if (raw.code && NET_CODES.has(raw.code)) {
    return { category: 'network', message: msg || '네트워크 오류', cause: input };
  }
  // 메시지 힌트 — status/type/code 가 없을 때만 효과가 있다. 두 가지 원칙을 지킨다:
  //   1) timeout 과 동일하게 5xx 폴백보다 "앞" 에 둬 "status 500 + rate_limit 메시지"
  //      같은 케이스가 rate_limit 정책(retry-after 존중·maxRetries=5) 으로 올라가게 한다.
  //   2) 서로 겹치는 패턴이 없도록 가장 구체적 의미
  //      (subscription_expired > token_exhausted > rate_limit > overloaded > auth > bad_request)
  //      순서로 검사한다. subscription_expired 를 가장 먼저 두는 이유는 "subscription
  //      required" 같은 문구가 rate_limit 어휘와 일부 겹치지 않더라도 사용자 조치
  //      순위가 가장 높기 때문.
  if (msg && MSG_SUBSCRIPTION_EXPIRED.test(msg)) {
    return { category: 'subscription_expired', message: msg, cause: input };
  }
  if (msg && MSG_TOKEN_EXHAUSTED.test(msg)) {
    return { category: 'token_exhausted', message: msg, cause: input };
  }
  if (msg && MSG_RATE_LIMIT.test(msg)) {
    return { category: 'rate_limit', retryAfterMs: parseRetryAfter(raw.headers), message: msg, cause: input };
  }
  if (msg && MSG_OVERLOADED.test(msg)) {
    return { category: 'overloaded', message: msg, cause: input };
  }
  if (msg && MSG_AUTH.test(msg)) {
    return { category: 'auth', message: msg, cause: input };
  }
  if (msg && MSG_BAD_REQ.test(msg)) {
    return { category: 'bad_request', message: msg, cause: input };
  }
  if (typeof raw.status === 'number' && raw.status >= 500) {
    return { category: 'api_error', message: msg || 'API 서버 오류', cause: input };
  }
  return { category: 'api_error', message: msg || '알 수 없는 API 오류', cause: input };
}

// ────────────────────────────────────────────────────────────────────────────
// 재시도 정책 — 카테고리별 기본값. 변경 시 docs/claude-api-resilience-2026-04-19.md
// 의 표도 함께 갱신할 것. rate_limit/overloaded 는 retry-after 헤더를 우선한다.
// bad_request·auth 는 재시도 불가(사용자 입력/인증 문제).
// ────────────────────────────────────────────────────────────────────────────

export interface ClaudeRetryPolicy {
  maxRetries: number;
  baseMs: number;
  capMs: number;
  jitterRatio: number;     // 0~1. 계산된 백오프의 ±비율만큼 무작위 흔들림.
  respectRetryAfter: boolean;
  retriable: boolean;
}

const RETRY_POLICIES: Record<ClaudeErrorCategory, ClaudeRetryPolicy> = {
  rate_limit:           { maxRetries: 5, baseMs: 1_000, capMs: 30_000, jitterRatio: 0.25, respectRetryAfter: true,  retriable: true  },
  overloaded:           { maxRetries: 4, baseMs: 2_000, capMs: 30_000, jitterRatio: 0.25, respectRetryAfter: true,  retriable: true  },
  api_error:            { maxRetries: 3, baseMs: 1_000, capMs: 15_000, jitterRatio: 0.25, respectRetryAfter: false, retriable: true  },
  timeout:              { maxRetries: 2, baseMs:   500, capMs:  5_000, jitterRatio: 0.25, respectRetryAfter: false, retriable: true  },
  network:              { maxRetries: 3, baseMs:   500, capMs: 10_000, jitterRatio: 0.25, respectRetryAfter: false, retriable: true  },
  bad_request:          { maxRetries: 0, baseMs:     0, capMs:      0, jitterRatio: 0,    respectRetryAfter: false, retriable: false },
  auth:                 { maxRetries: 0, baseMs:     0, capMs:      0, jitterRatio: 0,    respectRetryAfter: false, retriable: false },
  // 구독 세션 소진·만료는 시간이 지나도 복구되지 않으므로 재시도 금지. UI 가 '읽기 전용' 모드로 전환.
  token_exhausted:      { maxRetries: 0, baseMs:     0, capMs:      0, jitterRatio: 0,    respectRetryAfter: false, retriable: false },
  subscription_expired: { maxRetries: 0, baseMs:     0, capMs:      0, jitterRatio: 0,    respectRetryAfter: false, retriable: false },
};

/** 공용 퍼블릭 API · 카테고리별 고정 재시도 정책. 수치는 `docs/claude-api-resilience-2026-04-19.md` 와 함께만 변경. */
export function retryPolicyFor(category: ClaudeErrorCategory): ClaudeRetryPolicy {
  return RETRY_POLICIES[category];
}

/**
 * 주어진 attempt(1-based: 첫 재시도=1) 에 대한 백오프 대기 시간(밀리초) 을 돌려준다.
 * retryAfterMs 가 있고 정책이 respectRetryAfter 이면 그 값을 우선하되 cap 으로 제한.
 * 그 외에는 `base * 2^(attempt-1)` 에 ±jitterRatio 무작위 흔들림을 더한 값.
 */
export function computeBackoffMs(
  attempt: number,
  policy: ClaudeRetryPolicy,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (policy.respectRetryAfter && typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, policy.capMs || retryAfterMs);
  }
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exp = policy.baseMs * Math.pow(2, safeAttempt - 1);
  const capped = Math.min(exp, policy.capMs);
  const jitter = capped * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.floor(capped + jitter));
}

// ────────────────────────────────────────────────────────────────────────────
// withClaudeRetry — 재시도 오케스트레이터(SDK 전환 대비 공용 실행 경로).
// 현재 프로젝트는 Claude CLI 를 spawn 하므로 아직 직접 호출되지 않지만, SDK 전환
// 시점에 모든 호출을 본 래퍼로 모아 **정책·TODO 앵커·훅이 한 곳에 모이도록** 한다.
// ────────────────────────────────────────────────────────────────────────────

export interface WithRetryOptions {
  signal?: AbortSignal;
  maxTotalRetries?: number;
  onAttempt?: (attemptIndex: number) => void; // 0-based; 0 = 최초 시도
  onError?: (classified: ClassifiedClaudeError) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export async function withClaudeRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  while (true) {
    try {
      opts.onAttempt?.(attempt);
      return await fn();
    } catch (err) {
      const classified = classifyClaudeError(err);
      opts.onError?.(classified);
      const policy = retryPolicyFor(classified.category);
      const maxForCategory = policy.maxRetries;
      const overallCap = opts.maxTotalRetries;
      const effectiveMax = typeof overallCap === 'number'
        ? Math.min(maxForCategory, overallCap)
        : maxForCategory;
      if (!policy.retriable || attempt >= effectiveMax) {
        // TODO(useToast-merge): Joker 가 정비 중인 공통 토스트 API 가 병합되면,
        // 이 지점을 `useToast.error({ category: classified.category, message: classified.message })`
        // 발행으로 치환한다. 지금은 기존 에러 표시 경로(예외 throw → 상단바 배지의
        // claudeTokenUsageStore.setError) 로만 흘린다. 본 앵커는 전 프로젝트에서 유일.
        throw err;
      }
      attempt++;
      const waitMs = computeBackoffMs(attempt, policy, classified.retryAfterMs, opts.random);
      await sleep(waitMs, opts.signal);
    }
  }
}
