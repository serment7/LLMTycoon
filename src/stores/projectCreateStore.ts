// 지시 #462fa5ec · 프로젝트 생성 폼의 사용자 상호작용 영속 스토어.
//
// 본 스토어는 신규 프로젝트 생성 다이얼로그(`CreateProjectDialog.tsx`) 와
// 마법사(`NewProjectWizard.tsx`) 가 공유하는 두 가지 사용자 상태를 묶는다:
//   (1) 잠긴 역할 — `lockedRoles`. 사용자가 카드의 "이 역할 고정" 토글을 누른 역할
//       집합. 다음 추천 새로고침(인원수 변경·설명 디바운스 트리거) 시, 응답에 같은
//       역할이 있으면 응답값으로 갱신하고 없으면 직전 잠긴 카드를 그대로 보존한다.
//   (2) 마지막 추천 결과 — `lastRecommendation`. 페이지 새로고침 후에도 사용자가
//       바로 직전에 본 카드를 즉시 복원한다. localStorage 에 JSON 으로 저장하며,
//       서버측 user_preferences 동기화는 후속 PR 범위(현재는 익명 폴백 전용).
//
// 추가 상수:
//   · `MIN_DESCRIPTION_LENGTH = 20` — 설명이 이 미만이면 추천 호출을 차단해 LLM 토큰을
//     낭비하지 않는다. UI 는 안내 문구를 보여 사용자가 "조금 더 자세히 적어주세요" 를
//     알 수 있게 한다. 임계값을 본 모듈 한 곳에서 export 하여 다이얼로그·마법사·테스트가
//     동일 값을 참조한다.
//   · `RECOMMENDATION_DEBOUNCE_MS = 600` — 입력이 멈춘 뒤 600ms 후 호출. 기존 400ms 보다
//     보수적으로 묶어 토큰 절약을 강화. 컴포넌트는 디바운서를 만들 때 본 값을 기본값으로
//     사용하고, 테스트는 props 로 짧은 값을 주입해 결정성을 확보.
//
// 구독 모델은 `recommendCountStore.ts` 와 동일한 모듈 레벨 listener Set + React 의
// `useSyncExternalStore`. Provider 가 필요 없으므로 기존 트리에 사이드이펙트 없음.

import { useSyncExternalStore } from 'react';

import type {
  AgentRecommendation,
  AgentTeamRecommendation,
  RecommendationLocale,
} from '../project/recommendAgentTeam';
import { ROLE_CATALOG } from '../project/recommendAgentTeam';
import type { AgentRole } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// 상수
// ────────────────────────────────────────────────────────────────────────────

export const MIN_DESCRIPTION_LENGTH = 20;
export const RECOMMENDATION_DEBOUNCE_MS = 600;

export const LOCKED_ROLES_STORAGE_KEY = 'user_preferences.projectCreate.lockedRoles';
export const LAST_RECOMMENDATION_STORAGE_KEY = 'user_preferences.projectCreate.lastRecommendation';

// ────────────────────────────────────────────────────────────────────────────
// 저장소 추상화 — 테스트 주입용. 기본은 globalThis.localStorage.
// ────────────────────────────────────────────────────────────────────────────

export interface ProjectCreateStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

function defaultStorage(): ProjectCreateStorage | null {
  const g = globalThis as { localStorage?: ProjectCreateStorage };
  return g.localStorage ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// 직렬화 헬퍼 — 스키마가 망가진 저장값은 기본값으로 폴백.
// ────────────────────────────────────────────────────────────────────────────

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && (ROLE_CATALOG as readonly string[]).includes(value);
}

export function readLockedRoles(
  storage: ProjectCreateStorage | null = defaultStorage(),
): readonly AgentRole[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOCKED_ROLES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: AgentRole[] = [];
    for (const value of parsed) {
      if (isAgentRole(value) && !out.includes(value)) out.push(value);
    }
    return out;
  } catch {
    return [];
  }
}

export function persistLockedRoles(
  roles: readonly AgentRole[],
  storage: ProjectCreateStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LOCKED_ROLES_STORAGE_KEY, JSON.stringify(roles));
  } catch {
    // QuotaExceeded · SecurityError 등 — 다음 세션은 빈 잠금으로 폴백.
  }
}

/**
 * 마지막 추천 스냅샷. AgentTeamRecommendation 의 직렬화 가능한 부분만 보존하고,
 * `messages`(디버그 용) 는 잘라낸다 — 저장 용량을 줄이고 캐시 마커가 stale 해지지
 * 않게 한다.
 */
export interface LastRecommendationSnapshot {
  readonly description: string;
  readonly count: number;
  readonly locale: RecommendationLocale;
  readonly source: AgentTeamRecommendation['source'];
  readonly items: readonly AgentRecommendation[];
  readonly storedAt: string;
}

export function readLastRecommendation(
  storage: ProjectCreateStorage | null = defaultStorage(),
): LastRecommendationSnapshot | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LAST_RECOMMENDATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastRecommendationSnapshot> | null;
    if (
      !parsed
      || typeof parsed.description !== 'string'
      || typeof parsed.count !== 'number'
      || (parsed.locale !== 'en' && parsed.locale !== 'ko')
      || !Array.isArray(parsed.items)
    ) {
      return null;
    }
    // items 의 최소 필드만 검증해 깨진 옛 포맷을 흘리지 않는다.
    const items: AgentRecommendation[] = [];
    for (const it of parsed.items) {
      if (!it || typeof it !== 'object') continue;
      const row = it as Record<string, unknown>;
      if (!isAgentRole(row.role)) continue;
      if (typeof row.name !== 'string' || row.name.length === 0) continue;
      if (typeof row.rationale !== 'string' || row.rationale.length === 0) continue;
      const skills = Array.isArray(row.skills)
        ? row.skills.filter((s): s is string => typeof s === 'string')
        : undefined;
      const reason =
        typeof row.reason === 'string' && row.reason.trim().length > 0
          ? row.reason
          : undefined;
      items.push({
        role: row.role,
        name: row.name,
        rationale: row.rationale,
        ...(skills && skills.length > 0 ? { skills } : {}),
        ...(reason ? { reason } : {}),
      });
    }
    if (items.length === 0) return null;
    return {
      description: parsed.description,
      count: parsed.count,
      locale: parsed.locale,
      source: (parsed.source as AgentTeamRecommendation['source']) ?? 'cache',
      items,
      storedAt: typeof parsed.storedAt === 'string' ? parsed.storedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function persistLastRecommendation(
  snapshot: LastRecommendationSnapshot | null,
  storage: ProjectCreateStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (snapshot === null) {
      storage.removeItem(LAST_RECOMMENDATION_STORAGE_KEY);
      return;
    }
    storage.setItem(LAST_RECOMMENDATION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 무시 — 다음 세션은 빈 스냅샷으로 폴백.
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 모듈 레벨 reactive 스토어
// ────────────────────────────────────────────────────────────────────────────

interface ProjectCreateState {
  readonly lockedRoles: readonly AgentRole[];
  readonly lastRecommendation: LastRecommendationSnapshot | null;
}

let currentState: ProjectCreateState = {
  lockedRoles: readLockedRoles(),
  lastRecommendation: readLastRecommendation(),
};
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function getProjectCreateState(): ProjectCreateState {
  return currentState;
}

export function subscribeProjectCreate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLockedRoles(): readonly AgentRole[] {
  return currentState.lockedRoles;
}

export function setLockedRoles(next: readonly AgentRole[]): void {
  // 정규화: AgentRole 만 통과 + 중복 제거 + ROLE_CATALOG 순서로 정렬해 저장.
  const allowed = new Set(ROLE_CATALOG);
  const seen = new Set<AgentRole>();
  const sanitized: AgentRole[] = [];
  for (const role of next) {
    if (!allowed.has(role)) continue;
    if (seen.has(role)) continue;
    seen.add(role);
    sanitized.push(role);
  }
  // 같은 집합이면 갱신 생략(불필요한 재렌더 방지).
  if (
    sanitized.length === currentState.lockedRoles.length
    && sanitized.every((r) => currentState.lockedRoles.includes(r))
  ) {
    return;
  }
  currentState = { ...currentState, lockedRoles: sanitized };
  persistLockedRoles(sanitized);
  emit();
}

export function toggleLockedRole(role: AgentRole): void {
  const has = currentState.lockedRoles.includes(role);
  if (has) {
    setLockedRoles(currentState.lockedRoles.filter((r) => r !== role));
  } else {
    setLockedRoles([...currentState.lockedRoles, role]);
  }
}

export function clearLockedRoles(): void {
  setLockedRoles([]);
}

export function getLastRecommendation(): LastRecommendationSnapshot | null {
  return currentState.lastRecommendation;
}

export function setLastRecommendation(snapshot: LastRecommendationSnapshot | null): void {
  currentState = { ...currentState, lastRecommendation: snapshot };
  persistLastRecommendation(snapshot);
  emit();
}

// 테스트 전용 — 모듈 상태를 storage 로부터 다시 읽어 초기화.
export function _resetProjectCreateForTests(
  storage: ProjectCreateStorage | null = defaultStorage(),
): void {
  currentState = {
    lockedRoles: readLockedRoles(storage),
    lastRecommendation: readLastRecommendation(storage),
  };
  emit();
}

// ────────────────────────────────────────────────────────────────────────────
// "잠긴 역할 우선 머지" — 응답 items 에 잠긴 역할이 있으면 응답값으로 갱신,
// 없으면 직전 lastRecommendation 의 동일 역할 카드를 그대로 보존해 합친다.
// 결과 길이는 max(count, 잠긴 역할 수) 까지로 슬라이스되어 UI 가 카드 수를 안정시킨다.
// ────────────────────────────────────────────────────────────────────────────

export function mergeLockedRoles(
  fresh: readonly AgentRecommendation[],
  options: {
    readonly lockedRoles: readonly AgentRole[];
    readonly previous?: readonly AgentRecommendation[] | null;
    readonly count: number;
  },
): AgentRecommendation[] {
  const locked = new Set(options.lockedRoles);
  if (locked.size === 0) {
    return [...fresh].slice(0, options.count);
  }
  const out: AgentRecommendation[] = [];
  const usedRoles = new Set<AgentRole>();
  // 잠긴 역할은 우선 보존. fresh 응답에 있으면 응답값(LLM 의 새 카피) 채택, 없으면 previous.
  for (const role of options.lockedRoles) {
    if (usedRoles.has(role)) continue;
    const fromFresh = fresh.find((it) => it.role === role);
    const fromPrev = options.previous?.find((it) => it.role === role);
    const picked = fromFresh ?? fromPrev;
    if (!picked) continue;
    out.push(picked);
    usedRoles.add(role);
  }
  // 나머지 슬롯은 fresh 응답에서 잠긴 역할 외만 채움. 순서 유지.
  for (const item of fresh) {
    if (out.length >= options.count) break;
    if (locked.has(item.role)) continue;
    if (usedRoles.has(item.role)) continue;
    out.push(item);
    usedRoles.add(item.role);
  }
  return out.slice(0, Math.max(options.count, locked.size));
}

// ────────────────────────────────────────────────────────────────────────────
// 가드 — 설명 길이 정책. UI/테스트가 동일 함수를 사용해 일관성을 확보한다.
// ────────────────────────────────────────────────────────────────────────────

export function isDescriptionLongEnough(description: string): boolean {
  return description.trim().length >= MIN_DESCRIPTION_LENGTH;
}

// ────────────────────────────────────────────────────────────────────────────
// React 훅
// ────────────────────────────────────────────────────────────────────────────

export interface UseProjectCreateStore {
  readonly lockedRoles: readonly AgentRole[];
  readonly lastRecommendation: LastRecommendationSnapshot | null;
  readonly toggleLockedRole: (role: AgentRole) => void;
  readonly clearLockedRoles: () => void;
  readonly setLastRecommendation: (snapshot: LastRecommendationSnapshot | null) => void;
}

export function useProjectCreateStore(): UseProjectCreateStore {
  const state = useSyncExternalStore(
    subscribeProjectCreate,
    getProjectCreateState,
    getProjectCreateState,
  );
  return {
    lockedRoles: state.lockedRoles,
    lastRecommendation: state.lastRecommendation,
    toggleLockedRole,
    clearLockedRoles,
    setLastRecommendation,
  };
}
