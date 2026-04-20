// 지시 #d5acb8a5 · "신규 프로젝트 마법사" 의 추천 카드 데이터 경로.
//
// UI 는 단순 렌더에 집중할 수 있도록, 아래 세 가지를 본 모듈이 책임진다:
//   (1) sanitizeRationale — 추천 근거 텍스트의 마크다운 중 **bold** 만 허용하고
//       HTML/스크립트는 완전히 제거. UI 는 반환된 `segments` 를 그대로 span 렌더.
//   (2) 디바운스된 요청기(createDebouncedRecommender) — description 입력 타이핑 중
//       과도 호출을 막는다. 기본 400ms, 취소 토큰(AbortController) 으로 구 요청을
//       폐기한다.
//   (3) 동일 description 메모이제이션 — 공백 정규화된 description 을 키로 Map 에
//       최근 결과를 캐시. 재요청 시 LLM 왕복을 건너뛰어 토큰을 아낀다. LRU 크기는
//       작게(8) 설정해 신규 프로젝트 마법사 1회 세션에 맞춤.
//
// 설계 원칙
//   · 순수 + 주입 가능 — fetcher 는 인자로 넣어 테스트·스토리북·실 LLM 경로가 같은
//     인터페이스를 공유. 모듈 전역 상태는 두지 않는다(캐시는 createCache 팩토리로).
//   · AbortSignal 친화 — React 의 useEffect cleanup 에서 controller.abort() 만 불러도
//     보류 중 요청이 안전하게 해제된다.

import type { AgentTeamRecommendation } from './recommendAgentTeam';

// ────────────────────────────────────────────────────────────────────────────
// sanitizer — 마크다운 bold(**…**) 만 허용
// ────────────────────────────────────────────────────────────────────────────

/** UI 가 받아 쓰는 텍스트 세그먼트. `strong: true` 면 <strong> 로 래핑해 렌더. */
export interface RationaleSegment {
  readonly text: string;
  readonly strong: boolean;
}

/**
 * 추천 근거 텍스트 정제. 허용 축:
 *   · `**두꺼운 강조**` → strong 세그먼트.
 *   · 그 외 모든 마크다운(_, `, #, [](), 이미지 등) 은 리터럴 텍스트로 보존하지 않고
 *     제거한다 — 디자이너 합의: "간결한 한 문장" 정책이라 bold 이상은 카드 레이아웃을
 *     깨뜨린다.
 *   · HTML 태그·스크립트는 텍스트 이스케이프 후 전량 제거. XSS 축 완전 차단.
 *   · 홀수 개 `**` 로 닫히지 않은 경우 남은 꼬리는 일반 텍스트로 취급.
 */
export function sanitizeRationale(raw: string): RationaleSegment[] {
  if (typeof raw !== 'string') return [];
  // 1) HTML 태그 통째로 제거(속성 값의 스크립트까지 한 번에).
  const noHtml = raw.replace(/<[^>]*>/g, '');
  // 2) 미허용 마크다운 기호 제거(백틱, 밑줄, 해시, 대괄호/소괄호 URL 링크 내용만 남김).
  //    링크 `[text](url)` 는 `text` 만 남긴다.
  const noLinks = noHtml.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');
  const stripped = noLinks.replace(/[_`#]/g, '');
  // 3) **bold** 파싱. 짝수 개의 ** 가 아닌 경우 마지막 ** 이후는 plain 으로.
  const segments: RationaleSegment[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    if (m.index > cursor) {
      segments.push({ text: stripped.slice(cursor, m.index), strong: false });
    }
    segments.push({ text: m[1], strong: true });
    cursor = m.index + m[0].length;
  }
  if (cursor < stripped.length) {
    segments.push({ text: stripped.slice(cursor), strong: false });
  }
  // 4) 공백만 있는 세그먼트는 유지(텍스트 흐름 보존). 빈 문자열은 제거.
  return segments.filter((s) => s.text.length > 0);
}

// ────────────────────────────────────────────────────────────────────────────
// 메모이제이션 — description 키로 결과 캐시
// ────────────────────────────────────────────────────────────────────────────

export interface RecommendationCache {
  readonly get: (description: string) => AgentTeamRecommendation | undefined;
  readonly set: (description: string, value: AgentTeamRecommendation) => void;
  readonly clear: () => void;
  readonly size: () => number;
}

/** 공백 정규화 — 앞뒤 trim + 내부 연속 공백 단일화. 대소문자는 보존. */
export function normalizeDescription(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** LRU(최근 사용) 캐시 팩토리. 기본 용량 8. */
export function createRecommendationCache(capacity = 8): RecommendationCache {
  const map = new Map<string, AgentTeamRecommendation>();
  return {
    get(description) {
      const key = normalizeDescription(description);
      if (!map.has(key)) return undefined;
      const value = map.get(key)!;
      // LRU 갱신: 재삽입으로 최신화.
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(description, value) {
      const key = normalizeDescription(description);
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > capacity) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 디바운스된 요청기 — 타이핑 중 과도 호출 차단
// ────────────────────────────────────────────────────────────────────────────

export interface RecommenderRequest {
  readonly description: string;
  readonly signal?: AbortSignal;
}

export type RecommenderFetcher = (
  req: RecommenderRequest,
) => Promise<AgentTeamRecommendation>;

export interface DebouncedRecommenderOptions {
  readonly fetcher: RecommenderFetcher;
  readonly cache?: RecommendationCache;
  readonly debounceMs?: number;
  /** 타이머 주입 훅 — 테스트에서 가짜 setTimeout 사용. 기본 globalThis. */
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

export interface DebouncedRecommender {
  /**
   * 최신 요청만 살아남는다. 디바운스 구간 내 재요청은 이전 타이머를 취소하고,
   * 이미 비행 중인 요청은 AbortController 로 폐기한다. 반환되는 Promise 는 resolve
   * 되거나, 새 요청이 override 하면 '요청 자체가 사라진' 상태로 보류(다음 요청 결과로
   * 덮어쓰기를 유도하므로 호출자는 resolve 만 구독한다).
   */
  readonly request: (description: string) => Promise<AgentTeamRecommendation | null>;
  /** 보류 타이머·비행 요청을 즉시 취소. 컴포넌트 unmount 시 호출 권장. */
  readonly cancel: () => void;
}

export function createDebouncedRecommender(
  options: DebouncedRecommenderOptions,
): DebouncedRecommender {
  const debounceMs = options.debounceMs ?? 400;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingController: AbortController | null = null;

  function cancelPending() {
    if (pendingTimer !== null) {
      clearTimeoutFn(pendingTimer);
      pendingTimer = null;
    }
    if (pendingController) {
      pendingController.abort();
      pendingController = null;
    }
  }

  return {
    request(description) {
      cancelPending();
      // 빈 description 은 즉시 null 로 응답(UI 는 empty 상태로 전환).
      if (normalizeDescription(description).length === 0) {
        return Promise.resolve(null);
      }
      // 캐시 히트는 디바운스 없이 즉시 반환(토큰 절약).
      const cached = options.cache?.get(description);
      if (cached) {
        return Promise.resolve({ ...cached, source: 'cache' });
      }
      const controller = new AbortController();
      pendingController = controller;
      return new Promise<AgentTeamRecommendation | null>((resolve, reject) => {
        pendingTimer = setTimeoutFn(() => {
          pendingTimer = null;
          options
            .fetcher({ description, signal: controller.signal })
            .then((value) => {
              if (controller.signal.aborted) {
                resolve(null);
                return;
              }
              options.cache?.set(description, value);
              resolve(value);
            })
            .catch((err) => {
              if (controller.signal.aborted) {
                resolve(null);
                return;
              }
              reject(err);
            });
        }, debounceMs);
      });
    },
    cancel: cancelPending,
  };
}
