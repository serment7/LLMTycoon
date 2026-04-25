// 지시 #797538d6 · "추천 인원수" 영속 스토어 — UI/상태/저장소 3 계층 정합.
//
// 신규 프로젝트 생성 다이얼로그(`CreateProjectDialog`) 와 기존 프로젝트용 마법사
// (`NewProjectWizard`) 가 공유하는 단일 진실원. 다음 두 계약을 묶어 둔다:
//   (1) 초기값 5 — `DEFAULT_RECOMMEND_COUNT` 가 최초 렌더 시 슬롯 개수와 LLM 요청
//       카운트를 동시에 결정한다. 본 스토어를 거치지 않고 컴포넌트가 임의의 기본값을
//       하드코딩하면 UI 와 토큰 캐시 키가 어긋난다.
//   (2) 마지막 선택값 복원 — `localStorage` 의 `user_preferences.recommendCount` 키로
//       세션 간 유지. 서버 동기화는 차후(언어 토글과 동일한 패턴) 확장.
//
// 구독 모델은 `useSyncExternalStore` 친화 — i18n 모듈과 동일한 모듈 레벨 listener Set.
// 컴포넌트는 `useRecommendCount()` 훅으로 reactive 하게 구독하고, 비-React 호출자
// (예: 디바운스된 fetcher) 는 `getRecommendCount()` 동기 함수로 즉시 읽는다.

import { useSyncExternalStore } from 'react';

// ────────────────────────────────────────────────────────────────────────────
// 상수
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_RECOMMEND_COUNT = 5;

// 시스템 프롬프트(SYSTEM_PROMPTS) 가 "2~5명" 을 강제하므로 클라이언트 입력도 동일
// 범위로 클램프한다. 상한을 늘리려면 SYSTEM_PROMPTS 의 정책 문장도 함께 수정해야 한다.
export const MIN_RECOMMEND_COUNT = 2;
export const MAX_RECOMMEND_COUNT = 5;

export const RECOMMEND_COUNT_STORAGE_KEY = 'user_preferences.recommendCount';

// ────────────────────────────────────────────────────────────────────────────
// 저장소 추상화 — 테스트 주입용. 기본은 globalThis.localStorage.
// ────────────────────────────────────────────────────────────────────────────

export interface RecommendCountStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

function defaultStorage(): RecommendCountStorage | null {
  const g = globalThis as { localStorage?: RecommendCountStorage };
  return g.localStorage ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// 정규화 — 외부 입력을 [MIN, MAX] 정수로 강제. 저장 직전·읽기 직후 동시에 적용.
// ────────────────────────────────────────────────────────────────────────────

export function clampRecommendCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RECOMMEND_COUNT;
  const rounded = Math.round(n);
  if (rounded < MIN_RECOMMEND_COUNT) return MIN_RECOMMEND_COUNT;
  if (rounded > MAX_RECOMMEND_COUNT) return MAX_RECOMMEND_COUNT;
  return rounded;
}

export function readRecommendCount(
  storage: RecommendCountStorage | null = defaultStorage(),
): number {
  if (!storage) return DEFAULT_RECOMMEND_COUNT;
  try {
    const raw = storage.getItem(RECOMMEND_COUNT_STORAGE_KEY);
    if (raw === null || raw === '') return DEFAULT_RECOMMEND_COUNT;
    return clampRecommendCount(raw);
  } catch {
    return DEFAULT_RECOMMEND_COUNT;
  }
}

export function persistRecommendCount(
  count: number,
  storage: RecommendCountStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(RECOMMEND_COUNT_STORAGE_KEY, String(clampRecommendCount(count)));
  } catch {
    // QuotaExceeded · SecurityError 등 — 다음 세션은 기본값으로 폴백.
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 모듈 레벨 reactive 스토어
// ────────────────────────────────────────────────────────────────────────────

let currentCount: number = readRecommendCount();
const listeners = new Set<() => void>();

export function getRecommendCount(): number {
  return currentCount;
}

export function setRecommendCount(next: number): void {
  const clamped = clampRecommendCount(next);
  if (clamped === currentCount) return;
  currentCount = clamped;
  persistRecommendCount(clamped);
  listeners.forEach((l) => l());
}

export function subscribeRecommendCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 테스트 전용 — 모듈 상태를 초기화. 외부 storage 를 갈아끼울 때만 사용.
export function _resetRecommendCountForTests(
  storage: RecommendCountStorage | null = defaultStorage(),
): void {
  currentCount = readRecommendCount(storage);
  listeners.forEach((l) => l());
}

// ────────────────────────────────────────────────────────────────────────────
// React 훅
// ────────────────────────────────────────────────────────────────────────────

export function useRecommendCount(): {
  readonly count: number;
  readonly setCount: (next: number) => void;
} {
  const count = useSyncExternalStore(
    subscribeRecommendCount,
    getRecommendCount,
    getRecommendCount,
  );
  return { count, setCount: setRecommendCount };
}
