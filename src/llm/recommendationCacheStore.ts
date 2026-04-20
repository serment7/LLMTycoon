// 지시 #21a88a06 · 추천 응답 캐시(24h TTL) — 서버측 설명 해시 기반.
//
// 프런트의 `createRecommendationCache` 는 브라우저 세션 내 LRU 였고, 본 모듈은 서버 쪽
// 프로세스 수명 동안 유지되는 TTL 캐시다. 동일 description·locale 이 24시간 안에 다시
// 들어오면 LLM 왕복을 생략한다.
//
// 정책
//   · 키: `locale|hash(description)` — 해시는 결정론적 FNV-1a 32bit(외부 의존 X).
//   · TTL: 기본 24*60*60*1000ms. set 시점에 expiresAt 을 계산.
//   · `invalidateAll()` — `client.ts::invalidateCachePrefix` 와 배선해 시스템 프롬프트
//     변화 등 상위 이벤트에서 전체 비우기.
//   · `invalidatePrefix(locale?)` — locale 단위 비우기(프롬프트만 바뀌고 언어는 살아 있는 경우).

import type { AgentTeamRecommendation } from '../project/recommendAgentTeam';

export const DEFAULT_RECOMMENDATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface RecommendationCacheEntry {
  readonly value: AgentTeamRecommendation;
  readonly storedAt: number;
  readonly expiresAt: number;
}

export interface RecommendationCacheStore {
  readonly get: (description: string, locale: string) => AgentTeamRecommendation | null;
  readonly set: (description: string, locale: string, value: AgentTeamRecommendation) => void;
  readonly invalidateAll: () => void;
  readonly invalidatePrefix: (locale?: string) => void;
  readonly size: () => number;
}

export interface RecommendationCacheStoreOptions {
  readonly ttlMs?: number;
  /** 테스트 주입 — 시각 훅. */
  readonly now?: () => number;
}

/** 해시: FNV-1a 32bit. 충돌 확률은 캐시 오염보다 훨씬 낮고 외부 의존 없음. */
export function hashDescription(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function normalize(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

function keyFor(description: string, locale: string): string {
  return `${locale}|${hashDescription(normalize(description))}`;
}

export function createRecommendationCacheStore(
  options: RecommendationCacheStoreOptions = {},
): RecommendationCacheStore {
  const ttl = options.ttlMs ?? DEFAULT_RECOMMENDATION_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const map = new Map<string, RecommendationCacheEntry>();

  function purgeExpired(at: number): void {
    for (const [k, entry] of map.entries()) {
      if (entry.expiresAt <= at) map.delete(k);
    }
  }

  return {
    get(description, locale) {
      const at = now();
      purgeExpired(at);
      const entry = map.get(keyFor(description, locale));
      if (!entry) return null;
      if (entry.expiresAt <= at) {
        map.delete(keyFor(description, locale));
        return null;
      }
      return entry.value;
    },
    set(description, locale, value) {
      const at = now();
      map.set(keyFor(description, locale), {
        value,
        storedAt: at,
        expiresAt: at + ttl,
      });
    },
    invalidateAll() {
      map.clear();
    },
    invalidatePrefix(locale) {
      if (!locale) {
        map.clear();
        return;
      }
      const prefix = `${locale}|`;
      for (const k of map.keys()) {
        if (k.startsWith(prefix)) map.delete(k);
      }
    },
    size() {
      purgeExpired(now());
      return map.size;
    },
  };
}
