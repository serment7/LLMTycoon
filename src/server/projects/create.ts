// 지시 #fdee74ae · 프로젝트 생성 + 추천 에이전트 팀 seed 경로.
//
// CreateProjectDialog (UI) 가 `{name, description, recommendedAgents?}` 를 제출하면
// 서버는 다음 순서로 동작한다.
//   (1) `recommendedAgents` 가 비어 있고 description 이 충분히 짧다면, description 을
//       근거로 추천을 **프리페치** 해 seed 후보를 만든다. description 이 비어 있으면
//       프리페치 없이 0명.
//   (2) 프로젝트 문서를 DB 에 삽입 (주입된 `persistProject` 콜백 위임).
//   (3) 생성된 projectId 로 `seedRecommendedAgents` — `applyRecommendedTeam` 위임 —
//       를 호출해 추천 팀원을 프로젝트에 첨부한다.
//
// 설계 원칙
//   · DB/HTTP 결합 없음. 테스트는 `persistProject`, `seed`, `recommender` 를 stub 으로
//     주입해 순수하게 계약을 검증한다.
//   · 부분 실패 허용 — seed 일부가 실패해도 프로젝트는 생성된 상태로 유지. 결과의
//     `seeded.items[]` 에 성공/실패가 담겨 UI 가 실패 항목만 재시도 가능.
//   · Leader 중복 방지 — `applyRecommendedTeam` 는 서버 라우트가 신규 프로젝트에
//     Leader 를 자동 합류시키는 것을 모른다. 생성 경로가 `skipRoles` 로 Leader 를
//     필터링해 중복 attach 요청을 회피한다.

import type { AgentRole } from '../../types';
import {
  applyRecommendedTeam,
  type ApplyRecommendedTeamOptions,
  type AppliedTeamResult,
} from '../../project/api';
import {
  recommendAgentTeam,
  type AgentRecommendation,
  type AgentTeamRecommendation,
  type RecommendationLocale,
} from '../../project/recommendAgentTeam';

// ────────────────────────────────────────────────────────────────────────────
// 입출력 타입
// ────────────────────────────────────────────────────────────────────────────

export interface CreateProjectInput {
  readonly name: string;
  readonly description: string;
  readonly workspacePath?: string;
  readonly locale?: RecommendationLocale;
  /** UI 가 이미 선택한 추천 목록. 비어 있으면 서버가 description 으로 프리페치한다. */
  readonly recommendedAgents?: readonly AgentRecommendation[];
}

export interface PersistedProject {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly workspacePath: string;
}

export interface CreateProjectResult {
  readonly project: PersistedProject;
  readonly seeded: AppliedTeamResult;
  /** 서버가 프리페치한 경우 추천 출처를 UI 에 알려 디버깅/배지에 사용. null = 프리페치 생략. */
  readonly recommendation: AgentTeamRecommendation | null;
}

export interface CreateProjectWithRecommendationsDeps {
  /** 프로젝트 문서를 DB 에 저장. PersistedProject 를 반환해야 한다. */
  readonly persistProject: (input: CreateProjectInput) => Promise<PersistedProject>;
  /** 추천 seed 를 실제로 팀에 첨부하는 함수. 기본 `applyRecommendedTeam`. */
  readonly seed?: (
    projectId: string,
    items: readonly AgentRecommendation[],
    options?: ApplyRecommendedTeamOptions,
  ) => Promise<AppliedTeamResult>;
  /**
   * 추천 프리페치 함수. 미주입 시 `recommendAgentTeam` 휴리스틱 경로로 폴백.
   * 운영은 `claudeClient` 어댑터를 주입해 실 LLM 호출.
   */
  readonly recommender?: (
    description: string,
    locale: RecommendationLocale,
  ) => Promise<AgentTeamRecommendation>;
  /** seed 시 추가 옵션(예: baseUrl, fetch stub) 을 `applyRecommendedTeam` 에 전달. */
  readonly applyOptions?: ApplyRecommendedTeamOptions;
  /** Leader 등 자동 합류 역할을 seed 에서 제외. 기본 ['Leader']. */
  readonly skipRoles?: readonly AgentRole[];
}

// ────────────────────────────────────────────────────────────────────────────
// 추천 프리페치
// ────────────────────────────────────────────────────────────────────────────

/**
 * description 에 맞춰 추천 팀을 생성. description 이 비어 있으면 null.
 * recommender 미주입 시 휴리스틱 폴백으로 수렴 — 네트워크 없이도 결정론적.
 */
export async function prefetchRecommendedAgents(
  description: string,
  locale: RecommendationLocale,
  recommender?: CreateProjectWithRecommendationsDeps['recommender'],
): Promise<AgentTeamRecommendation | null> {
  const trimmed = typeof description === 'string' ? description.trim() : '';
  if (trimmed.length === 0) return null;
  if (recommender) return recommender(trimmed, locale);
  return recommendAgentTeam(trimmed, { locale });
}

// ────────────────────────────────────────────────────────────────────────────
// seed — 생성 직후 추천을 프로젝트에 첨부
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_SKIP_ROLES: readonly AgentRole[] = ['Leader'];

/**
 * 추천 목록을 프로젝트에 첨부. Leader 는 서버 라우트가 신규 프로젝트 생성 시 자동
 * 합류시키므로 기본 skip 대상. 빈 목록이면 네트워크 호출 없이 0명 결과를 반환한다.
 */
export async function seedRecommendedAgents(
  projectId: string,
  items: readonly AgentRecommendation[],
  deps: Pick<CreateProjectWithRecommendationsDeps, 'seed' | 'applyOptions' | 'skipRoles'> = {},
): Promise<AppliedTeamResult> {
  const skip = new Set<AgentRole>(deps.skipRoles ?? DEFAULT_SKIP_ROLES);
  const filtered = items.filter((item) => !skip.has(item.role));
  if (filtered.length === 0) {
    return { projectId, items: [], appliedCount: 0 };
  }
  const seedFn = deps.seed ?? applyRecommendedTeam;
  return seedFn(projectId, filtered, deps.applyOptions);
}

// ────────────────────────────────────────────────────────────────────────────
// 메인 엔트리 — 프리페치 + 생성 + seed
// ────────────────────────────────────────────────────────────────────────────

/**
 * 프로젝트 생성 플로우 하나로 묶기.
 *   · UI 가 `recommendedAgents` 를 함께 제출 → 그대로 seed.
 *   · UI 가 제출하지 않음 + description 비어 있지 않음 → 서버가 프리페치 후 seed.
 *   · description 도 비어 있음 → seed 건너뜀, 프로젝트만 생성.
 */
export async function createProjectWithRecommendations(
  input: CreateProjectInput,
  deps: CreateProjectWithRecommendationsDeps,
): Promise<CreateProjectResult> {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new Error('name 은 비어 있지 않은 문자열이어야 합니다.');
  }
  const locale: RecommendationLocale = input.locale ?? 'en';

  // 1) seed 후보 확정 — UI 입력이 있으면 우선, 없으면 프리페치.
  let recommendation: AgentTeamRecommendation | null = null;
  let seedItems: readonly AgentRecommendation[] = input.recommendedAgents ?? [];
  if (seedItems.length === 0) {
    recommendation = await prefetchRecommendedAgents(
      input.description,
      locale,
      deps.recommender,
    );
    seedItems = recommendation?.items ?? [];
  }

  // 2) 프로젝트 문서 삽입 — DB 결합은 persistProject 로 격리.
  const project = await deps.persistProject(input);

  // 3) seed — Leader 는 라우트가 자동 합류시키므로 스킵.
  const seeded = await seedRecommendedAgents(project.id, seedItems, {
    seed: deps.seed,
    applyOptions: deps.applyOptions,
    skipRoles: deps.skipRoles,
  });

  return { project, seeded, recommendation };
}
