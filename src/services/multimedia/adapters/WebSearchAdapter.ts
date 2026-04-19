// 지시 #f64dc11e · WebSearchAdapter 실제 구현.
//
// Joker 가 직전 라운드(#9c2ae902) 에서 어댑터 골격(`MediaAdapter` · `MultimediaRegistry`)
// 과 `src/services/multimedia/WebSearchAdapter.ts` 스켈레톤을 잠갔다. 본 파일은
// 그 위에 공급자 비의존 SearchResult 정규화 + 공급자 전략(Bing/Brave/DuckDuckGo) +
// 레이트 리밋 + 지수 백오프 재시도 + AbortSignal 취소 + TTL 캐시를 올린다.
//
// 설계 요약
//   · search(query, options) 최상위 함수는 invoke() 가 감싸는 하드코어 경로. 공급자는
//     옵션으로 주입하며, 미지정 시 설정(settings) 에서 "최초 활성 공급자" 순으로 채택.
//   · RateLimiter 는 슬라이딩 윈도우 카운터. 공급자별 1초/분당 호출 상한을 유지한다.
//   · 재시도는 1-2-4 의 지수 백오프 + ±20% 지터. 재시도 대상은 5xx/네트워크/429 뿐이며,
//     4xx(키 오류 등) 은 즉시 실패.
//   · 취소는 표준 AbortSignal 을 각 단계에 전파. 재시도 대기 중 취소되면 즉시 ABORTED.
//   · 캐시는 Map 기반 TTL. 키는 JSON.stringify({query, ...normalizedOptions}) 의 해시
//     대체(stable string) — 테스트에서 쉽게 확인할 수 있다.
//   · 오류 코드는 WEB_SEARCH_RATE_LIMIT · WEB_SEARCH_PROVIDER_ERROR · WEB_SEARCH_EMPTY
//     3종을 표준화해 `MediaAdapterError.details.webSearchCode` 에 부여한다. 부분 결과는
//     `details.partial: SearchResult[]` 에 담아 호출자가 표시할 수 있게 한다.

import {
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterInvocation,
  type MediaAdapterOutcome,
  type MediaAdapterOutput,
  type MultimediaAdapterConfig,
  type WebSearchInput,
} from '../types';

export const WEB_SEARCH_REAL_ADAPTER_ID = 'webSearch-v1';
export const WEB_SEARCH_ALIAS = 'search/web';

// ────────────────────────────────────────────────────────────────────────────
// 공개 타입
// ────────────────────────────────────────────────────────────────────────────

/** 공급자 비의존 결과. 모든 공급자 응답이 본 모양으로 정규화된다. */
export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** ISO-8601. 공급자가 돌려주지 않으면 undefined. */
  readonly publishedAt?: string;
  /** 공급자 id — 'bing' · 'brave' · 'duckduckgo' 등. 결과 merge 시 출처 추적에 사용. */
  readonly source: string;
}

export type SafeSearchLevel = 'off' | 'moderate' | 'strict';
export type FreshnessFilter = 'day' | 'week' | 'month' | 'year' | 'any';

export interface WebSearchOptions {
  /** 최대 결과 수. 기본 10. 공급자 상한(최대 50) 으로 clamp. */
  readonly maxResults?: number;
  /** 지역 코드(ISO). 공급자별 매핑은 provider 가 해석. 예: 'KR' / 'US'. */
  readonly region?: string;
  readonly safeSearch?: SafeSearchLevel;
  readonly freshness?: FreshnessFilter;
  /** 특정 도메인으로 결과 제한. 공급자가 네이티브로 지원하지 않으면 후처리 필터. */
  readonly site?: string;
  readonly onProgress?: (stage: 'dispatch' | 'fetch' | 'normalize' | 'done', ratio: number) => void;
  readonly signal?: AbortSignal;
}

/**
 * 공급자 어댑터 인터페이스 — 모든 공급자가 같은 입출력 모양으로 동작하도록 강제.
 * 공급자는 아래 search() 한 점을 책임지며, 재시도/레이트/캐시는 WebSearchAdapter 가 감싼다.
 */
export interface SearchProvider {
  readonly id: string;
  /** 공급자가 외부 크레덴셜(API 키) 을 요구하는가? UI 비활성 판정에 사용. */
  readonly requiresCredentials: boolean;
  /** 공급자의 현재 사용 가능 여부(키 존재 등). false 면 레지스트리가 건너뛴다. */
  isEnabled(): boolean;
  /** 실제 네트워크 호출. 공급자 특이 오류는 HttpError(코드 포함) 로 정규화한다. */
  search(query: string, options: WebSearchOptions): Promise<SearchResult[]>;
}

/** 어댑터 표준 오류 코드 — 지시 #f64dc11e 요구. */
export type WebSearchErrorCode =
  | 'WEB_SEARCH_RATE_LIMIT'
  | 'WEB_SEARCH_PROVIDER_ERROR'
  | 'WEB_SEARCH_EMPTY';

/**
 * 공급자 내부에서만 쓰는 HTTP 오류. WebSearchAdapter 가 본 예외를 잡아 적절한
 * MediaAdapterError 로 번역한다 — 공급자는 status 코드만 알려주면 된다.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number, opts: { cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'HttpError';
    this.status = status;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// RateLimiter — 슬라이딩 윈도우 카운터
// ────────────────────────────────────────────────────────────────────────────

export interface RateLimiterOptions {
  /** 윈도우 길이(ms). 예: 1_000 = 초당, 60_000 = 분당. */
  readonly windowMs: number;
  /** 한 윈도우 안에서 허용 호출 수. */
  readonly max: number;
  /** Date.now 대체 — 테스트에서 가짜 시계 주입. */
  readonly now?: () => number;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly hits: number[] = [];

  constructor(options: RateLimiterOptions) {
    this.windowMs = options.windowMs;
    this.max = options.max;
    this.now = options.now ?? Date.now;
  }

  /** 윈도우 안에서 슬롯이 남아 있으면 true 를 돌려주고 내부 카운터에 기록한다. */
  tryAcquire(): boolean {
    const cutoff = this.now() - this.windowMs;
    while (this.hits.length > 0 && this.hits[0] <= cutoff) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(this.now());
    return true;
  }

  /** 가장 오래된 호출이 윈도우 밖으로 나갈 때까지 남은 ms. 음수는 0 으로 clamp. */
  msUntilNextSlot(): number {
    if (this.hits.length === 0) return 0;
    const cutoff = this.now() - this.windowMs;
    const oldest = this.hits[0];
    if (oldest <= cutoff) return 0;
    return Math.max(0, this.windowMs - (this.now() - oldest));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// TTL 캐시
// ────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  readonly expiresAtMs: number;
  readonly value: SearchResult[];
}

export interface TtlCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export class TtlCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 128;
    this.now = options.now ?? Date.now;
  }

  get(key: string): SearchResult[] | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: SearchResult[]): void {
    if (this.store.size >= this.maxEntries) {
      // 가장 먼저 들어온 키부터 축출 — Map 은 insertion order 를 유지한다.
      const first = this.store.keys().next().value;
      if (first !== undefined) this.store.delete(first);
    }
    this.store.set(key, { expiresAtMs: this.now() + this.ttlMs, value });
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

function cacheKey(query: string, options: WebSearchOptions, providerId: string): string {
  const norm = {
    q: query.trim().toLowerCase(),
    max: options.maxResults ?? 10,
    region: options.region ?? '',
    safeSearch: options.safeSearch ?? 'moderate',
    freshness: options.freshness ?? 'any',
    site: options.site ?? '',
    provider: providerId,
  };
  return JSON.stringify(norm);
}

// ────────────────────────────────────────────────────────────────────────────
// 공급자 구현 — Bing · Brave · DuckDuckGo
// ────────────────────────────────────────────────────────────────────────────

export interface WebSearchSettings {
  /** 활성 공급자 우선순위. 미지정 시 ['bing', 'brave', 'duckduckgo']. */
  readonly preferredProviders?: readonly string[];
  readonly bing?: { apiKey?: string; endpoint?: string };
  readonly brave?: { apiKey?: string; endpoint?: string };
  readonly duckduckgo?: { endpoint?: string };
  /** 네트워크 fetch 주입 — 테스트에서 MockAgent/mf 로 교체. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_BING_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search';
const DEFAULT_BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_DUCKDUCKGO_ENDPOINT = 'https://api.duckduckgo.com/';

function applySiteFilter(query: string, site?: string): string {
  if (!site) return query;
  return query.includes('site:') ? query : `${query} site:${site}`;
}

function safeSearchToBingParam(level?: SafeSearchLevel): string {
  if (level === 'off') return 'Off';
  if (level === 'strict') return 'Strict';
  return 'Moderate';
}

function freshnessToBingParam(f?: FreshnessFilter): string | null {
  switch (f) {
    case 'day': return 'Day';
    case 'week': return 'Week';
    case 'month': return 'Month';
    default: return null;
  }
}

export function createBingProvider(settings: WebSearchSettings): SearchProvider {
  const apiKey = settings.bing?.apiKey;
  const endpoint = settings.bing?.endpoint ?? DEFAULT_BING_ENDPOINT;
  const fetchImpl = settings.fetch ?? fetch;
  return {
    id: 'bing',
    requiresCredentials: true,
    isEnabled: () => typeof apiKey === 'string' && apiKey.length > 0,
    async search(query, options) {
      if (!apiKey) throw new HttpError('Bing API key missing', 401);
      const params = new URLSearchParams();
      params.set('q', applySiteFilter(query, options.site));
      params.set('count', String(Math.min(50, options.maxResults ?? 10)));
      params.set('safeSearch', safeSearchToBingParam(options.safeSearch));
      if (options.region) params.set('mkt', options.region);
      const freshness = freshnessToBingParam(options.freshness);
      if (freshness) params.set('freshness', freshness);
      const url = `${endpoint}?${params.toString()}`;
      const res = await fetchImpl(url, {
        headers: { 'Ocp-Apim-Subscription-Key': apiKey },
        signal: options.signal,
      });
      if (!res.ok) throw new HttpError(`Bing ${res.status}`, res.status);
      const body = await res.json() as BingResponse;
      const items = body.webPages?.value ?? [];
      return items.map((it) => ({
        title: String(it.name ?? ''),
        url: String(it.url ?? ''),
        snippet: String(it.snippet ?? ''),
        publishedAt: typeof it.dateLastCrawled === 'string' ? it.dateLastCrawled : undefined,
        source: 'bing',
      }));
    },
  };
}

interface BingResponse {
  webPages?: {
    value?: Array<{ name?: unknown; url?: unknown; snippet?: unknown; dateLastCrawled?: unknown }>;
  };
}

export function createBraveProvider(settings: WebSearchSettings): SearchProvider {
  const apiKey = settings.brave?.apiKey;
  const endpoint = settings.brave?.endpoint ?? DEFAULT_BRAVE_ENDPOINT;
  const fetchImpl = settings.fetch ?? fetch;
  return {
    id: 'brave',
    requiresCredentials: true,
    isEnabled: () => typeof apiKey === 'string' && apiKey.length > 0,
    async search(query, options) {
      if (!apiKey) throw new HttpError('Brave API key missing', 401);
      const params = new URLSearchParams();
      params.set('q', applySiteFilter(query, options.site));
      params.set('count', String(Math.min(20, options.maxResults ?? 10)));
      if (options.region) params.set('country', options.region.toUpperCase());
      if (options.safeSearch) {
        params.set('safesearch', options.safeSearch === 'strict' ? 'strict' : options.safeSearch === 'off' ? 'off' : 'moderate');
      }
      if (options.freshness && options.freshness !== 'any') {
        params.set('freshness', options.freshness === 'day' ? 'pd' : options.freshness === 'week' ? 'pw' : options.freshness === 'month' ? 'pm' : 'py');
      }
      const url = `${endpoint}?${params.toString()}`;
      const res = await fetchImpl(url, {
        headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
        signal: options.signal,
      });
      if (!res.ok) throw new HttpError(`Brave ${res.status}`, res.status);
      const body = await res.json() as BraveResponse;
      const items = body.web?.results ?? [];
      return items.map((it) => ({
        title: String(it.title ?? ''),
        url: String(it.url ?? ''),
        snippet: String(it.description ?? ''),
        publishedAt: typeof it.age === 'string' ? it.age : undefined,
        source: 'brave',
      }));
    },
  };
}

interface BraveResponse {
  web?: {
    results?: Array<{ title?: unknown; url?: unknown; description?: unknown; age?: unknown }>;
  };
}

export function createDuckDuckGoProvider(settings: WebSearchSettings): SearchProvider {
  const endpoint = settings.duckduckgo?.endpoint ?? DEFAULT_DUCKDUCKGO_ENDPOINT;
  const fetchImpl = settings.fetch ?? fetch;
  return {
    id: 'duckduckgo',
    requiresCredentials: false,
    isEnabled: () => true,
    async search(query, options) {
      // DuckDuckGo Instant Answer API — 공개·키 불필요. RelatedTopics 를 결과로 정규화.
      const params = new URLSearchParams();
      params.set('q', applySiteFilter(query, options.site));
      params.set('format', 'json');
      params.set('no_html', '1');
      params.set('skip_disambig', '1');
      if (options.safeSearch === 'strict') params.set('kp', '1');
      else if (options.safeSearch === 'off') params.set('kp', '-2');
      const url = `${endpoint}?${params.toString()}`;
      const res = await fetchImpl(url, { signal: options.signal });
      if (!res.ok) throw new HttpError(`DuckDuckGo ${res.status}`, res.status);
      const body = await res.json() as DuckDuckGoResponse;
      const related = body.RelatedTopics ?? [];
      const results: SearchResult[] = [];
      const limit = Math.min(25, options.maxResults ?? 10);
      for (const r of related) {
        if (results.length >= limit) break;
        if (r && typeof r === 'object' && 'FirstURL' in r && typeof r.FirstURL === 'string') {
          results.push({
            title: typeof r.Text === 'string' ? r.Text.split(' - ')[0] : r.FirstURL,
            url: r.FirstURL,
            snippet: typeof r.Text === 'string' ? r.Text : '',
            source: 'duckduckgo',
          });
        }
      }
      return results;
    },
  };
}

interface DuckDuckGoRelated { FirstURL?: string; Text?: string; Topics?: DuckDuckGoRelated[] }
interface DuckDuckGoResponse { RelatedTopics?: DuckDuckGoRelated[] }

// ────────────────────────────────────────────────────────────────────────────
// 재시도 · 백오프 · 취소
// ────────────────────────────────────────────────────────────────────────────

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter?: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
  jitter: true,
});

function isRetryableError(err: unknown): boolean {
  if (err instanceof HttpError) {
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false;
  }
  if (isAbortError(err)) return false;
  // 네트워크 계통(이름 TypeError 의 fetch 오류) 은 재시도.
  const e = err as { name?: string; code?: string };
  if (e?.name === 'TypeError') return true;
  if (typeof e?.code === 'string' && /ECONN|ETIMEOUT|ENETWORK|EAI_AGAIN/.test(e.code)) return true;
  return false;
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; code?: string };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

function nextDelay(attempt: number, policy: RetryPolicy): number {
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** (attempt - 1)));
  if (!policy.jitter) return raw;
  // ±20% 지터.
  const spread = raw * 0.2;
  return Math.max(0, raw + (Math.random() * 2 - 1) * spread);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MediaAdapterError('ABORTED', '웹 검색 취소', { adapterId: WEB_SEARCH_REAL_ADAPTER_ID }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MediaAdapterError('ABORTED', '웹 검색 취소', { adapterId: WEB_SEARCH_REAL_ADAPTER_ID }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MediaAdapterError('ABORTED', '웹 검색이 취소되었습니다.', {
      adapterId: WEB_SEARCH_REAL_ADAPTER_ID,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// search() — 최상위 공개 함수 · WebSearchAdapter 가 이를 감싼다
// ────────────────────────────────────────────────────────────────────────────

export interface WebSearchRuntimeOptions {
  readonly provider?: SearchProvider;
  readonly providers?: readonly SearchProvider[];
  readonly rateLimiter?: RateLimiter;
  readonly cache?: TtlCache;
  readonly retryPolicy?: RetryPolicy;
  /** 전역 타임아웃(ms). 초과 시 WEB_SEARCH_PROVIDER_ERROR 로 매핑. */
  readonly timeoutMs?: number;
}

function pickFirstEnabledProvider(
  providers: readonly SearchProvider[],
  preferred?: readonly string[],
): SearchProvider | null {
  const ordered = preferred && preferred.length > 0
    ? [...preferred.map((id) => providers.find((p) => p.id === id)).filter(Boolean) as SearchProvider[], ...providers]
    : [...providers];
  for (const p of ordered) if (p.isEnabled()) return p;
  return null;
}

export async function search(
  query: string,
  options: WebSearchOptions = {},
  runtime: WebSearchRuntimeOptions = {},
): Promise<SearchResult[]> {
  if (!query || !query.trim()) {
    throw webSearchError('WEB_SEARCH_EMPTY', '검색어가 비어 있습니다.');
  }
  ensureNotAborted(options.signal);
  options.onProgress?.('dispatch', 0);

  const provider = runtime.provider
    ?? pickFirstEnabledProvider(runtime.providers ?? [], undefined);
  if (!provider) {
    throw webSearchError('WEB_SEARCH_PROVIDER_ERROR', '사용 가능한 웹 검색 공급자가 없습니다.');
  }

  const key = cacheKey(query, options, provider.id);
  const cached = runtime.cache?.get(key);
  if (cached) {
    options.onProgress?.('done', 1);
    return cached;
  }

  if (runtime.rateLimiter && !runtime.rateLimiter.tryAcquire()) {
    throw webSearchError(
      'WEB_SEARCH_RATE_LIMIT',
      '웹 검색 요청 레이트 리밋에 걸렸습니다. 잠시 후 다시 시도하세요.',
      { waitMs: runtime.rateLimiter.msUntilNextSlot(), provider: provider.id },
    );
  }

  const policy = runtime.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const callSignal = combineSignal(options.signal, runtime.timeoutMs);

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    ensureNotAborted(callSignal.signal);
    try {
      options.onProgress?.('fetch', attempt / policy.maxAttempts);
      const results = await provider.search(query, { ...options, signal: callSignal.signal });
      options.onProgress?.('normalize', 0.9);
      const clamped = clampResults(results, options);
      if (clamped.length === 0) {
        // 빈 결과는 캐시에 담아 재시도 비용을 막는다. 하지만 오류로도 노출한다.
        runtime.cache?.set(key, clamped);
        callSignal.cancelTimeout();
        throw webSearchError(
          'WEB_SEARCH_EMPTY',
          '웹 검색 결과가 0건입니다.',
          { provider: provider.id, partial: clamped },
        );
      }
      runtime.cache?.set(key, clamped);
      options.onProgress?.('done', 1);
      callSignal.cancelTimeout();
      return clamped;
    } catch (err) {
      if (err instanceof MediaAdapterError && err.code === 'ABORTED') {
        callSignal.cancelTimeout();
        throw err;
      }
      if (err instanceof MediaAdapterError && err.details?.webSearchCode === 'WEB_SEARCH_EMPTY') {
        // 빈 결과는 재시도하지 않는다.
        callSignal.cancelTimeout();
        throw err;
      }
      lastErr = err;
      if (err instanceof HttpError && err.status === 429) {
        callSignal.cancelTimeout();
        throw webSearchError(
          'WEB_SEARCH_RATE_LIMIT',
          `공급자(${provider.id}) 가 429 로 응답했습니다.`,
          { provider: provider.id, status: 429 },
        );
      }
      if (!isRetryableError(err) || attempt === policy.maxAttempts) break;
      const delay = nextDelay(attempt, policy);
      await sleep(delay, callSignal.signal);
    }
  }

  callSignal.cancelTimeout();
  throw webSearchError(
    'WEB_SEARCH_PROVIDER_ERROR',
    `웹 검색 공급자(${provider.id}) 요청 실패: ${errorMessage(lastErr)}`,
    { provider: provider.id, cause: lastErr },
  );
}

function clampResults(results: SearchResult[], options: WebSearchOptions): SearchResult[] {
  const limit = Math.max(0, Math.min(50, options.maxResults ?? 10));
  let out = results.slice(0, limit);
  if (options.site) {
    // 공급자가 site 필터를 놓친 경우에 대비한 후처리. 도메인 정확 매칭.
    const domain = options.site.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    out = out.filter((r) => {
      try { return new URL(r.url).host.endsWith(domain); } catch { return false; }
    });
  }
  return out;
}

function combineSignal(outer?: AbortSignal, timeoutMs?: number): { signal: AbortSignal; cancelTimeout: () => void } {
  if (!outer && (!timeoutMs || timeoutMs <= 0)) {
    const ac = new AbortController();
    return { signal: ac.signal, cancelTimeout: () => undefined };
  }
  const ac = new AbortController();
  if (outer) {
    if (outer.aborted) ac.abort(outer.reason);
    else outer.addEventListener('abort', () => ac.abort(outer.reason), { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  }
  return {
    signal: ac.signal,
    cancelTimeout: () => { if (timer) clearTimeout(timer); },
  };
}

function webSearchError(
  code: WebSearchErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): MediaAdapterError {
  const mapped = code === 'WEB_SEARCH_RATE_LIMIT' ? 'QUOTA_EXCEEDED'
    : code === 'WEB_SEARCH_EMPTY' ? 'INPUT_INVALID'
    : 'INTERNAL';
  return new MediaAdapterError(mapped, message, {
    adapterId: WEB_SEARCH_REAL_ADAPTER_ID,
    details: { webSearchCode: code, ...details },
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

// ────────────────────────────────────────────────────────────────────────────
// MediaAdapter<'web-search'> 구현 — MultimediaRegistry 등록 대상
// ────────────────────────────────────────────────────────────────────────────

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'web-search',
    id: WEB_SEARCH_REAL_ADAPTER_ID,
    displayName: '웹 검색 어댑터(실구현)',
    supportedInputMimes: [],
    producedOutputMimes: [],
    capabilities: {
      canParse: false,
      canGenerate: true,
      streamsProgress: true,
      worksOffline: false,
      requiresUserConsent: false,
    },
    // 스켈레톤(priority=0) 보다 우선 — resolveByKind('web-search') 가 본 구현을 선택.
    priority: -10,
    dependsOn: [],
  };
}

export interface WebSearchAdapterOptions {
  readonly settings?: WebSearchSettings;
  readonly providers?: readonly SearchProvider[];
  readonly rateLimiter?: RateLimiter;
  readonly cache?: TtlCache;
  readonly retryPolicy?: RetryPolicy;
}

export class WebSearchAdapter implements MediaAdapter<'web-search'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();
  private readonly config: MultimediaAdapterConfig;
  private readonly providers: SearchProvider[];
  private readonly rateLimiter: RateLimiter;
  private readonly cache: TtlCache;
  private readonly retryPolicy: RetryPolicy;

  constructor(config: MultimediaAdapterConfig, options: WebSearchAdapterOptions = {}) {
    this.config = config;
    const settings = options.settings ?? {};
    const built = options.providers ?? defaultProviders(settings);
    this.providers = [...built];
    this.rateLimiter = options.rateLimiter ?? new RateLimiter({ windowMs: 1_000, max: 5 });
    this.cache = options.cache ?? new TtlCache({ ttlMs: 60_000, maxEntries: 128 });
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  canHandle(input: WebSearchInput): boolean {
    return Boolean(input && typeof input.query === 'string' && input.query.trim().length > 0);
  }

  getProviders(): readonly SearchProvider[] {
    return this.providers;
  }

  async search(query: string, options: WebSearchOptions = {}): Promise<SearchResult[]> {
    const provider = pickFirstEnabledProvider(this.providers);
    if (!provider) {
      throw webSearchError('WEB_SEARCH_PROVIDER_ERROR', '활성화된 공급자가 없습니다. API 키를 확인하세요.');
    }
    return search(query, options, {
      provider,
      rateLimiter: this.rateLimiter,
      cache: this.cache,
      retryPolicy: this.retryPolicy,
      timeoutMs: this.config.timeoutMs,
    });
  }

  async invoke(
    call: MediaAdapterInvocation<'web-search'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'web-search'>>> {
    const startedAtMs = Date.now();
    const { query, limit, includeDomains } = call.input;
    const options: WebSearchOptions = {
      maxResults: limit,
      signal: call.signal,
      site: includeDomains && includeDomains.length > 0 ? includeDomains[0] : undefined,
      onProgress: (stage, ratio) => call.onProgress?.({
        phase: stage === 'done' ? 'finalize' : 'upload',
        ratio,
        message: `웹 검색 ${stage}`,
      }),
    };
    const items = await this.search(query, options);
    return {
      adapterId: this.descriptor.id,
      startedAtMs,
      finishedAtMs: Date.now(),
      result: {
        items: items.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      },
    };
  }
}

function defaultProviders(settings: WebSearchSettings): SearchProvider[] {
  return [
    createBingProvider(settings),
    createBraveProvider(settings),
    createDuckDuckGoProvider(settings),
  ];
}

export const createWebSearchRealAdapter: MediaAdapterFactory<'web-search'> =
  (config) => new WebSearchAdapter(config);

/** 레지스트리 등록 편의 — 지시문이 명시한 'search/web' 별칭 경로. */
export function registerWebSearchAdapter(
  register: (factory: MediaAdapterFactory<'web-search'>, descriptor: MediaAdapterDescriptor) => void,
  options: { alias?: string } = {},
): void {
  const probe = new WebSearchAdapter({ maxBytes: 0, timeoutMs: 0 });
  const descriptor: MediaAdapterDescriptor = {
    ...probe.descriptor,
    displayName: `${probe.descriptor.displayName} (${options.alias ?? WEB_SEARCH_ALIAS})`,
  };
  register(createWebSearchRealAdapter, descriptor);
}
