// Run with: npx tsx --test tests/projects/createProjectWithRecommendations.unit.test.ts
//
// 지시 #fdee74ae — `src/server/projects/create.ts` 의 프리페치 + seed 오케스트레이션 계약.
//
// 축
//   P1. prefetchRecommendedAgents — 빈 설명은 null, 설명 있으면 휴리스틱 폴백.
//   P2. prefetchRecommendedAgents — recommender 주입 시 그대로 위임.
//   S1. seedRecommendedAgents — Leader 를 기본 skipRoles 로 필터.
//   S2. seedRecommendedAgents — 빈 목록은 네트워크 호출 없이 0명 결과.
//   C1. createProjectWithRecommendations — UI 가 넘긴 recommendedAgents 우선.
//   C2. createProjectWithRecommendations — recommendedAgents 미주입 시 프리페치 → seed.
//   C3. createProjectWithRecommendations — description 비어 있으면 seed 생략.
//   C4. createProjectWithRecommendations — name 공백이면 throw.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProjectWithRecommendations,
  prefetchRecommendedAgents,
  seedRecommendedAgents,
  type CreateProjectInput,
  type CreateProjectWithRecommendationsDeps,
  type PersistedProject,
} from '../../src/server/projects/create.ts';
import type {
  AgentRecommendation,
  AgentTeamRecommendation,
} from '../../src/project/recommendAgentTeam.ts';
import type { AppliedTeamResult } from '../../src/project/api.ts';

// ─── 고정 데이터 ────────────────────────────────────────────────────────────

const SAMPLE_TEAM: AgentTeamRecommendation = {
  source: 'heuristic',
  locale: 'ko',
  items: [
    { role: 'Leader', name: 'Kai', rationale: '분배' },
    { role: 'Developer', name: 'Dev', rationale: '구현' },
    { role: 'QA', name: 'QA', rationale: '검증' },
  ],
};

function fakePersist(overrides: Partial<PersistedProject> = {}) {
  const calls: CreateProjectInput[] = [];
  const persistProject = async (input: CreateProjectInput): Promise<PersistedProject> => {
    calls.push(input);
    return {
      id: overrides.id ?? 'p-1',
      name: overrides.name ?? input.name,
      description: overrides.description ?? input.description,
      workspacePath: overrides.workspacePath ?? input.workspacePath ?? './ws',
    };
  };
  return { persistProject, calls };
}

function fakeSeed() {
  const calls: Array<{
    projectId: string;
    items: readonly AgentRecommendation[];
  }> = [];
  const seed = async (
    projectId: string,
    items: readonly AgentRecommendation[],
  ): Promise<AppliedTeamResult> => {
    calls.push({ projectId, items });
    return {
      projectId,
      items: items.map((rec, i) => ({ recommendation: rec, ok: true, agentId: `a${i}` })),
      appliedCount: items.length,
    };
  };
  return { seed, calls };
}

// ─── P: prefetchRecommendedAgents ───────────────────────────────────────────

test('P1. prefetchRecommendedAgents — 빈 설명은 null, 설명 있으면 heuristic 수렴', async () => {
  assert.equal(await prefetchRecommendedAgents('', 'en'), null);
  assert.equal(await prefetchRecommendedAgents('   ', 'ko'), null);

  const team = await prefetchRecommendedAgents('결제 모듈 보안 강화', 'ko');
  assert.ok(team, '추천 결과가 있어야 한다');
  assert.equal(team!.source, 'heuristic');
  assert.ok(team!.items.length >= 2);
});

test('P2. prefetchRecommendedAgents — recommender 주입 시 그대로 위임', async () => {
  let seen = '';
  const recommender = async (description: string): Promise<AgentTeamRecommendation> => {
    seen = description;
    return SAMPLE_TEAM;
  };
  const out = await prefetchRecommendedAgents('  결제  ', 'ko', recommender);
  assert.equal(seen, '결제');
  assert.equal(out, SAMPLE_TEAM);
});

// ─── S: seedRecommendedAgents ───────────────────────────────────────────────

test('S1. seedRecommendedAgents — Leader 를 기본 skipRoles 로 필터', async () => {
  const { seed, calls } = fakeSeed();
  const result = await seedRecommendedAgents('p-1', SAMPLE_TEAM.items, { seed });
  assert.equal(calls.length, 1, 'seed 1회 호출');
  assert.deepEqual(
    calls[0].items.map((it) => it.role),
    ['Developer', 'QA'],
    'Leader 가 제외되어야 한다',
  );
  assert.equal(result.appliedCount, 2);
});

test('S2. seedRecommendedAgents — 빈 목록은 네트워크 호출 없이 0명', async () => {
  const { seed, calls } = fakeSeed();
  const result = await seedRecommendedAgents('p-1', [], { seed });
  assert.equal(calls.length, 0);
  assert.equal(result.appliedCount, 0);
  assert.equal(result.projectId, 'p-1');
});

test('S3. seedRecommendedAgents — skipRoles 명시 시 해당 role 만 제외', async () => {
  const { seed, calls } = fakeSeed();
  await seedRecommendedAgents('p-1', SAMPLE_TEAM.items, {
    seed,
    skipRoles: ['QA'],
  });
  assert.deepEqual(
    calls[0].items.map((it) => it.role),
    ['Leader', 'Developer'],
  );
});

// ─── C: createProjectWithRecommendations ────────────────────────────────────

test('C1. createProjectWithRecommendations — UI 가 넘긴 recommendedAgents 우선(프리페치 생략)', async () => {
  const { persistProject, calls: pCalls } = fakePersist();
  const { seed, calls: sCalls } = fakeSeed();
  let recommenderCalled = false;
  const deps: CreateProjectWithRecommendationsDeps = {
    persistProject,
    seed,
    recommender: async () => {
      recommenderCalled = true;
      return SAMPLE_TEAM;
    },
  };
  const result = await createProjectWithRecommendations(
    {
      name: '결제 보안',
      description: '설명',
      recommendedAgents: [
        { role: 'Developer', name: 'Dev', rationale: '구현' },
      ],
    },
    deps,
  );
  assert.equal(recommenderCalled, false, '프리페치는 호출되지 않아야 한다');
  assert.equal(result.recommendation, null);
  assert.equal(pCalls.length, 1);
  assert.equal(sCalls.length, 1);
  assert.equal(sCalls[0].items.length, 1);
  assert.equal(result.seeded.appliedCount, 1);
});

test('C2. createProjectWithRecommendations — recommendedAgents 미주입 → 프리페치 후 seed', async () => {
  const { persistProject } = fakePersist();
  const { seed, calls: sCalls } = fakeSeed();
  const deps: CreateProjectWithRecommendationsDeps = {
    persistProject,
    seed,
    recommender: async () => SAMPLE_TEAM,
  };
  const result = await createProjectWithRecommendations(
    { name: '결제', description: '결제 모듈 보안 강화', locale: 'ko' },
    deps,
  );
  assert.equal(result.recommendation, SAMPLE_TEAM);
  assert.equal(sCalls.length, 1);
  assert.deepEqual(
    sCalls[0].items.map((it) => it.role),
    ['Developer', 'QA'],
    'Leader 는 기본 skipRoles 로 제외',
  );
});

test('C3. createProjectWithRecommendations — description 비어 있으면 프리페치·seed 없이 프로젝트만 생성', async () => {
  const { persistProject, calls: pCalls } = fakePersist();
  const { seed, calls: sCalls } = fakeSeed();
  let recommenderCalled = false;
  const deps: CreateProjectWithRecommendationsDeps = {
    persistProject,
    seed,
    recommender: async () => {
      recommenderCalled = true;
      return SAMPLE_TEAM;
    },
  };
  const result = await createProjectWithRecommendations(
    { name: '이름만', description: '   ' },
    deps,
  );
  assert.equal(recommenderCalled, false);
  assert.equal(result.recommendation, null);
  assert.equal(pCalls.length, 1);
  assert.equal(sCalls.length, 0);
  assert.equal(result.seeded.appliedCount, 0);
});

test('C4. createProjectWithRecommendations — name 공백이면 throw', async () => {
  const { persistProject } = fakePersist();
  const { seed } = fakeSeed();
  await assert.rejects(() =>
    createProjectWithRecommendations(
      { name: '   ', description: '설명' },
      { persistProject, seed },
    ),
  );
});

test('C5. createProjectWithRecommendations — recommender 미주입 시 heuristic 폴백으로 수렴', async () => {
  const { persistProject } = fakePersist();
  const { seed, calls: sCalls } = fakeSeed();
  const result = await createProjectWithRecommendations(
    { name: 'P', description: '결제 보안 테스트', locale: 'ko' },
    { persistProject, seed },
  );
  assert.ok(result.recommendation);
  assert.equal(result.recommendation!.source, 'heuristic');
  // Leader 는 스킵, Developer + QA(키워드 '보안·테스트') 가 seed 목록에 남아야 한다.
  const seededRoles = sCalls[0].items.map((it) => it.role).sort();
  assert.deepEqual(seededRoles, ['Developer', 'QA']);
});
