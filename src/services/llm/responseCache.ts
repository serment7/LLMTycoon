// 지시 #65a79466 — LLM 응답 캐싱 레이어.
//
// 동일한 (모델, 프롬프트) 입력에 대해 마지막 LLM 응답을 메모리 LRU 로 재사용해
// 토큰·시간 비용을 줄인다. 본 모듈은 외부 의존이 전혀 없는 순수 데이터 구조이므로
// Node 서버 · 브라우저 모두에서 동작한다.
//
// 정책
//   · 최대 항목 수: 100
//   · TTL: 30분 (초과 시 조회 시점에 만료 처리, 재진입 시 미스 카운트)
//   · LRU: 조회·세팅 시 항목을 Map 의 맨 뒤로 옮긴다 — Map 의 삽입 순서를 그대로
//          최근 사용 순서로 차용한다.
//   · 통계: 누적 hit/miss · cacheHitRate(소수 0~1).
//
// 안전성
//   에이전트가 워크스페이스 파일을 수정하는 등의 부수효과 호출은 절대 캐시하면 안 된다.
//   본 모듈은 그 판단을 호출자(oneshot 등) 에 위임하고, 자체적으로는 (key,value) 쌍만
//   저장한다.

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  value: string;
  /** 절대 시각(epoch ms). now > expiresAt 이면 만료. */
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** 누적 hits / (hits+misses). 호출이 0건이면 0. */
  cacheHitRate: number;
  size: number;
}

export interface ResponseCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  /** 테스트 주입용. 실제 사용은 Date.now 그대로. */
  now?: () => number;
}

export interface ResponseCache {
  getCached(key: string): string | undefined;
  setCached(key: string, value: string): void;
  /** 모든 항목과 통계를 초기화. 테스트·환경 전환 시 사용. */
  clear(): void;
  /** 현재 적중률을 포함한 누적 통계 스냅샷. */
  readonly stats: CacheStats;
}

/**
 * (모델, 프롬프트) 쌍을 결정론적 단일 문자열 키로 환원한다. 프롬프트는 길이가 길 수
 * 있어 그대로 키로 쓰면 메모리 낭비라, FNV-1a 32비트 해시로 줄이고 모델명을 prefix
 * 로 붙여 모델 간 충돌을 방지한다(서로 다른 모델의 같은 프롬프트가 같은 응답을 갖지
 * 않으므로).
 */
export function makeCacheKey(model: string, prompt: string): string {
  return `${model || 'unknown'}::${fnv1a(prompt)}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createResponseCache(options: ResponseCacheOptions = {}): ResponseCache {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
  const now = options.now ?? Date.now;

  const store = new Map<string, CacheEntry>();
  let hits = 0;
  let misses = 0;

  function snapshot(): CacheStats {
    const total = hits + misses;
    return {
      hits,
      misses,
      cacheHitRate: total === 0 ? 0 : hits / total,
      size: store.size,
    };
  }

  return {
    getCached(key) {
      const entry = store.get(key);
      if (!entry) {
        misses += 1;
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        // 만료 — 즉시 제거하고 미스로 집계.
        store.delete(key);
        misses += 1;
        return undefined;
      }
      // LRU 갱신: 삭제 후 재삽입으로 Map 의 끝으로 이동.
      store.delete(key);
      store.set(key, entry);
      hits += 1;
      return entry.value;
    },
    setCached(key, value) {
      // 동일 키 갱신도 최신 항목으로 취급(끝으로 이동).
      if (store.has(key)) store.delete(key);
      store.set(key, { value, expiresAt: now() + ttlMs });
      // 용량 초과 시 가장 오래된 항목부터 제거.
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    clear() {
      store.clear();
      hits = 0;
      misses = 0;
    },
    get stats() {
      return snapshot();
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 모듈 싱글턴 — 호출자(oneshot 등) 가 별도 인스턴스 관리 없이 import 만 하면
// 동일한 캐시를 공유한다. 테스트가 격리를 원하면 createResponseCache 로 별도
// 인스턴스를 만들어 주입하거나 default 인스턴스의 clear() 를 호출한다.
// ────────────────────────────────────────────────────────────────────────────

const defaultCache = createResponseCache();

export function getCached(key: string): string | undefined {
  return defaultCache.getCached(key);
}

export function setCached(key: string, value: string): void {
  defaultCache.setCached(key, value);
}

export function clearCache(): void {
  defaultCache.clear();
}

export const stats: CacheStats = new Proxy({} as CacheStats, {
  get(_target, prop) {
    return defaultCache.stats[prop as keyof CacheStats];
  },
  ownKeys() {
    return Object.keys(defaultCache.stats);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return {
      enumerable: true,
      configurable: true,
      value: defaultCache.stats[prop as keyof CacheStats],
    };
  },
});
