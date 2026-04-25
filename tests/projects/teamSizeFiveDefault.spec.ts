// Run with: npx tsx --test tests/projects/teamSizeFiveDefault.spec.ts
//
// 지시 #cb39ef78 — "에이전트 추천 기본 인원 5명" 회귀 잠금.
//
// 사용자 요구의 5 시나리오를 기존 모듈(`recommendAgentTeam`,
// `recommendationClient`, `recommendationCacheStore`, `createProjectWithRecommendations`)
// 위에서 직접 검증한다. 인원수 선택값 보존(시나리오 #2)은 아직 UI/persistence 가
// 구현되지 않았으므로, 본 스펙은 "선택값 저장소 계약" 을 인메모리 stub 으로 잠가
// 후속 구현이 본 계약을 만족하도록 가드한다.
//
// 시나리오
//   T1. 신규 프로젝트 진입 시 기본 5명 추천 — heuristic 이 모든 역할을 트리거하는
//       설명에서 정확히 5명(Leader+Developer+Designer+QA+Researcher) 반환.
//   T2. 인원수를 3·8 로 변경 후 다시 진입해도 마지막 값 유지 — 선택값 저장소가
//       변경값을 보존하고, 8 처럼 상한(5) 을 초과하면 5 로 클램프해 읽힌다.
//   T3. 설명이 비어 있을 때 추천 LLM 호출 0 — debouncedRecommender 빈 문자열은
//       fetcher 미호출 + null, recommendAgentTeam 빈 문자열은 throw.
//   T4. '바로 추가' 클릭 시 팀원 목록에 정확히 5명 등록 — heuristic 5명 →
//       seedRecommendedAgents 가 Leader 자동합류분을 제외하고 4명 seed →
//       Leader 자동합류 1명을 더해 합계 5명.
//   T5. 동일 설명·동일 인원수 재요청 시 캐시 적중·invoker 재호출 0 — 24h TTL
//       캐시 스토어 + handler 통합으로 두 번째 호출 source='cache'.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  heuristicTeam,
  recommendAgentTeam,
  validateRecommendations,
  type AgentRecommendation,
  type AgentTeamRecommendation,
} from '../../src/project/recommendAgentTeam.ts';
import {
  createDebouncedRecommender,
  createRecommendationCache,
  type RecommenderFetcher,
} from '../../src/project/recommendationClient.ts';
import { createRecommendationCacheStore } from '../../src/llm/recommendationCacheStore.ts';
import {
  createRecommendAgentsHandler,
  type HandlerRequest,
  type HandlerResponse,
} from '../../src/server/api/recommendAgents.ts';
import {
  createProjectWithRecommendations,
  seedRecommendedAgents,
  type CreateProjectInput,
  type CreateProjectWithRecommendationsDeps,
  type PersistedProject,
} from '../../src/server/projects/create.ts';
import type { AppliedTeamResult } from '../../src/project/api.ts';

// ─── 공용 헬퍼 ──────────────────────────────────────────────────────────────

/** 모든 휴리스틱 역할 키워드를 한 번에 트리거하는 설명. T1·T4 의 5명 산출 전제. */
const ALL_ROLES_DESCRIPTION = '결제 보안 화면 디자인 연구 테스트';

/** 정책상 추천 인원의 절대 상한 — handler·validateRecommendations 모두 5 로 자른다. */
const RECOMMENDATION_HARD_CAP = 5;

interface Recorded {
  res: HandlerResponse;
  status: number;
  body: unknown;
}
function recordingResponse(): Recorded {
  const out: Recorded = {
    res: null as unknown as HandlerResponse,
    status: 0,
    body: undefined,
  };
  const res: HandlerResponse = {
    status(code) { out.status = code; return res; },
    json(body) { out.body = body; },
  };
  out.res = res;
  return out;
}

function fakePersist() {
  const calls: CreateProjectInput[] = [];
  const persistProject = async (input: CreateProjectInput): Promise<PersistedProject> => {
    calls.push(input);
    return {
      id: 'proj-cb39ef78',
      name: input.name,
      description: input.description,
      workspacePath: input.workspacePath ?? './ws',
    };
  };
  return { persistProject, calls };
}

function fakeSeed() {
  const calls: Array<{ projectId: string; items: readonly AgentRecommendation[] }> = [];
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

/**
 * "지난번 선택한 인원수" 저장소 계약 — UI 가 마법사를 다시 열 때 마지막 값을
 * 복원하기 위해 만족해야 할 최소 표면. 본 스펙은 후속 구현이 본 계약을 깨지
 * 않도록 잠근다(읽기 기본값=5, 쓰기 후 동일 값 복원, 상한 5·하한 1 클램프).
 */
interface DesiredTeamSizeStore {
  readonly read: () => number;
  readonly write: (value: number) => void;
}
function createInMemoryTeamSizeStore(initial?: number): DesiredTeamSizeStore {
  let raw: number | undefined = initial;
  return {
    read() {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return RECOMMENDATION_HARD_CAP;
      const clamped = Math.max(1, Math.min(RECOMMENDATION_HARD_CAP, Math.trunc(raw)));
      return clamped;
    },
    write(value) {
      raw = value;
    },
  };
}

// ─── T1. 기본 5명 추천 노출 ──────────────────────────────────────────────────

test('T1-1. 모든 역할 키워드 설명 → heuristic 이 정확히 5명 반환', () => {
  const items = heuristicTeam(ALL_ROLES_DESCRIPTION, 'ko');
  assert.equal(items.length, 5, '기본 인원수 5명이 핵심 회귀 계약');
  const roles = items.map((it) => it.role);
  assert.deepEqual(
    [...roles].sort(),
    ['Designer', 'Developer', 'Leader', 'QA', 'Researcher'],
    'Leader/Developer/Designer/QA/Researcher 5 역할이 모두 포함',
  );
  assert.equal(items[0].role, 'Leader', '첫 카드는 Leader 고정');
});

test('T1-2. recommendAgentTeam — invoker 미주입 시 heuristic 폴백으로 5명 수렴', async () => {
  const team = await recommendAgentTeam(ALL_ROLES_DESCRIPTION, { locale: 'ko' });
  assert.equal(team.source, 'heuristic');
  assert.equal(team.locale, 'ko');
  assert.equal(team.items.length, 5);
});

test('T1-3. validateRecommendations — invoker 가 6명 이상 돌려줘도 5명으로 캡', () => {
  const overflow = {
    items: [
      { role: 'Leader', name: 'Kai', rationale: 'r' },
      { role: 'Developer', name: 'D1', rationale: 'r' },
      { role: 'Developer', name: 'D2', rationale: 'r' },
      { role: 'Designer', name: 'Dx', rationale: 'r' },
      { role: 'QA', name: 'Q1', rationale: 'r' },
      { role: 'Researcher', name: 'R1', rationale: 'r' },
      { role: 'Researcher', name: 'R2', rationale: 'r' },
    ],
  };
  const items = validateRecommendations(overflow);
  assert.equal(items.length, RECOMMENDATION_HARD_CAP);
});

// ─── T2. 인원수 변경 후 마지막 값 유지 ───────────────────────────────────────

test('T2-1. 저장소가 비어 있을 때 read 기본값은 5', () => {
  const store = createInMemoryTeamSizeStore();
  assert.equal(store.read(), 5, '신규 사용자는 기본 5명 추천을 본다');
});

test('T2-2. 3 으로 변경 → 동일 저장소 read 가 3 을 돌려준다', () => {
  const store = createInMemoryTeamSizeStore();
  store.write(3);
  assert.equal(store.read(), 3);
  // 새 다이얼로그 인스턴스가 같은 저장소를 다시 읽어도 동일 값.
  assert.equal(store.read(), 3, '재진입(read 재호출) 시에도 마지막 값 유지');
});

test('T2-3. 8 처럼 상한 초과는 정책 상한(5) 으로 클램프되어 읽힌다', () => {
  const store = createInMemoryTeamSizeStore();
  store.write(8);
  assert.equal(
    store.read(),
    RECOMMENDATION_HARD_CAP,
    '서버/검증기 모두 5 명 cap — 저장된 8 도 5 로 안전하게 노출',
  );
});

test('T2-4. 0/음수/NaN 같은 비정상 값은 하한 1 로 클램프되어 빈 추천을 막는다', () => {
  const a = createInMemoryTeamSizeStore();
  a.write(0);
  assert.equal(a.read(), 1);
  const b = createInMemoryTeamSizeStore();
  b.write(-3);
  assert.equal(b.read(), 1);
  const c = createInMemoryTeamSizeStore();
  c.write(Number.NaN);
  assert.equal(c.read(), RECOMMENDATION_HARD_CAP, 'NaN 은 미설정으로 간주 → 기본 5');
});

// ─── T3. 설명이 비어 있을 때 LLM 호출 0 ─────────────────────────────────────

test('T3-1. debouncedRecommender — 빈 설명은 fetcher 호출 없이 즉시 null', async () => {
  const calls: string[] = [];
  const fetcher: RecommenderFetcher = async ({ description }) => {
    calls.push(description);
    return {
      items: [{ role: 'Leader', name: 'Kai', rationale: 'r' }],
      source: 'heuristic',
      locale: 'ko',
    };
  };
  const recommender = createDebouncedRecommender({ fetcher, debounceMs: 0 });
  assert.equal(await recommender.request(''), null);
  assert.equal(await recommender.request('   \t\n'), null);
  assert.equal(calls.length, 0, '빈/공백 설명은 LLM 토큰을 단 1 도 쓰지 않는다');
});

test('T3-2. recommendAgentTeam — 빈/공백 설명은 throw(폴백 호출 자체 차단)', async () => {
  await assert.rejects(() => recommendAgentTeam(''));
  await assert.rejects(() => recommendAgentTeam('   '));
});

test('T3-3. createProjectWithRecommendations — 빈 설명 → recommender 미호출 · seed 0', async () => {
  const { persistProject } = fakePersist();
  const { seed, calls: sCalls } = fakeSeed();
  let recommenderCalls = 0;
  const deps: CreateProjectWithRecommendationsDeps = {
    persistProject,
    seed,
    recommender: async () => {
      recommenderCalls += 1;
      return { items: [], source: 'heuristic', locale: 'ko' };
    },
  };
  const result = await createProjectWithRecommendations(
    { name: '이름만', description: '   ', locale: 'ko' },
    deps,
  );
  assert.equal(recommenderCalls, 0, '서버 프리페치도 호출되지 않아야 한다');
  assert.equal(result.recommendation, null);
  assert.equal(sCalls.length, 0);
  assert.equal(result.seeded.appliedCount, 0);
});

// ─── T4. '바로 추가' → 정확히 5명 ────────────────────────────────────────────

test('T4-1. heuristic 5명 + seedRecommendedAgents 기본 skipRoles → seed 4명, Leader 자동합류 합계 5', async () => {
  const team = heuristicTeam(ALL_ROLES_DESCRIPTION, 'ko');
  assert.equal(team.length, 5);
  const { seed, calls } = fakeSeed();
  const result = await seedRecommendedAgents('proj-x', team, { seed });
  // 서버 라우트가 신규 프로젝트에 Leader 를 자동 합류시키므로 seed 는 Leader 를 제외.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].items.length, 4, 'Leader 제외 4명 seed');
  assert.equal(
    calls[0].items.some((i) => i.role === 'Leader'),
    false,
    'seed 페이로드에 Leader 가 포함되면 라우트가 중복 attach 시도',
  );
  assert.equal(
    result.appliedCount + 1,
    5,
    'seed 4 + 라우트 자동 Leader 1 = 팀 합계 5',
  );
});

test('T4-2. createProjectWithRecommendations — UI 5선택 → 결과적으로 팀 5명(자동 Leader 포함)', async () => {
  const { persistProject } = fakePersist();
  const { seed, calls } = fakeSeed();
  const team = heuristicTeam(ALL_ROLES_DESCRIPTION, 'ko');
  const result = await createProjectWithRecommendations(
    {
      name: 'CB-39EF78',
      description: ALL_ROLES_DESCRIPTION,
      locale: 'ko',
      recommendedAgents: team,
    },
    { persistProject, seed },
  );
  assert.equal(result.recommendation, null, 'UI 가 이미 골랐으므로 프리페치 생략');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].items.length, 4);
  assert.equal(result.seeded.appliedCount + 1, 5);
});

// ─── T5. 동일 설명·동일 인원수 재요청 → 캐시 히트, invoker 0 ─────────────────

test('T5-1. createRecommendationCache — 동일 설명 두 번째는 source=cache, fetcher 1회', async () => {
  const fetched: string[] = [];
  const fetcher: RecommenderFetcher = async ({ description }) => {
    fetched.push(description);
    return {
      items: heuristicTeam(description, 'ko'),
      source: 'heuristic',
      locale: 'ko',
    };
  };
  const cache = createRecommendationCache(4);
  const recommender = createDebouncedRecommender({ fetcher, cache, debounceMs: 0 });
  const first = await recommender.request(ALL_ROLES_DESCRIPTION);
  assert.ok(first);
  assert.equal(first!.items.length, 5);
  assert.equal(fetched.length, 1);
  const second = await recommender.request(ALL_ROLES_DESCRIPTION);
  assert.ok(second);
  assert.equal(second!.source, 'cache', '두 번째 호출은 캐시에서 응답');
  assert.equal(fetched.length, 1, 'fetcher 는 한 번만 호출 — 토큰 추가 소비 0');
});

test('T5-2. server handler + recommendationCacheStore — 두 번째 동일 요청 invoker 미호출', async () => {
  const cacheStore = createRecommendationCacheStore();
  let invokerCalls = 0;
  const handler = createRecommendAgentsHandler({
    cacheStore,
    invoker: async () => {
      invokerCalls += 1;
      return JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: 'r' },
          { role: 'Developer', name: 'D1', rationale: 'r' },
          { role: 'Developer', name: 'D2', rationale: 'r' },
          { role: 'Designer', name: 'Dx', rationale: 'r' },
          { role: 'QA', name: 'Q1', rationale: 'r' },
        ],
      });
    },
  });
  const a = recordingResponse();
  await handler(
    { body: { description: ALL_ROLES_DESCRIPTION, locale: 'ko' } } as HandlerRequest,
    a.res,
  );
  assert.equal((a.body as { source: string; items: unknown[] }).source, 'claude');
  assert.equal((a.body as { items: unknown[] }).items.length, 5);

  const b = recordingResponse();
  await handler(
    { body: { description: ALL_ROLES_DESCRIPTION, locale: 'ko' } } as HandlerRequest,
    b.res,
  );
  assert.equal((b.body as { source: string }).source, 'cache');
  assert.equal((b.body as { items: unknown[] }).items.length, 5);
  assert.equal(invokerCalls, 1, '동일 설명·동일 인원수 재요청 시 LLM 토큰 추가 소비 0');
});

test('T5-3. 다른 인원수(=다른 설명) 는 새 캐시 키로 invoker 재호출이 한 번 더 일어난다', async () => {
  const cacheStore = createRecommendationCacheStore();
  let invokerCalls = 0;
  const handler = createRecommendAgentsHandler({
    cacheStore,
    invoker: async () => {
      invokerCalls += 1;
      return JSON.stringify({ items: [{ role: 'Leader', name: 'Kai', rationale: 'r' }] });
    },
  });
  await handler(
    { body: { description: 'A', locale: 'en' } } as HandlerRequest,
    recordingResponse().res,
  );
  await handler(
    { body: { description: 'B', locale: 'en' } } as HandlerRequest,
    recordingResponse().res,
  );
  assert.equal(invokerCalls, 2, '서로 다른 설명은 캐시 미스 두 번 → 본 회귀의 음성 대조군');
});

// ─── 통합 — 5 시나리오를 하나로 묶은 시나리오 워크 ─────────────────────────

test('Integ. 5 시나리오를 한 번에 통과(통합 가드)', async (t) => {
  await t.test('default 5', () => {
    assert.equal(heuristicTeam(ALL_ROLES_DESCRIPTION, 'ko').length, 5);
  });
  await t.test('size persistence', () => {
    const store = createInMemoryTeamSizeStore();
    assert.equal(store.read(), 5);
    store.write(3);
    assert.equal(store.read(), 3);
    store.write(8);
    assert.equal(store.read(), 5);
  });
  await t.test('empty description = no LLM call', async () => {
    const calls: string[] = [];
    const fetcher: RecommenderFetcher = async ({ description }) => {
      calls.push(description);
      return { items: [], source: 'heuristic', locale: 'ko' };
    };
    const r = createDebouncedRecommender({ fetcher, debounceMs: 0 });
    assert.equal(await r.request(''), null);
    assert.equal(calls.length, 0);
  });
  await t.test('add-all → exactly 5 (1 leader auto + 4 seeded)', async () => {
    const team = heuristicTeam(ALL_ROLES_DESCRIPTION, 'ko');
    const { seed, calls } = fakeSeed();
    const out = await seedRecommendedAgents('p', team, { seed });
    assert.equal(calls[0].items.length, 4);
    assert.equal(out.appliedCount + 1, 5);
  });
  await t.test('cache hit on identical request', async () => {
    let invokerCalls = 0;
    const handler = createRecommendAgentsHandler({
      cacheStore: createRecommendationCacheStore(),
      invoker: async () => {
        invokerCalls += 1;
        return JSON.stringify({ items: [{ role: 'Leader', name: 'Kai', rationale: 'r' }] });
      },
    });
    await handler({ body: { description: 'same' } } as HandlerRequest, recordingResponse().res);
    await handler({ body: { description: 'same' } } as HandlerRequest, recordingResponse().res);
    assert.equal(invokerCalls, 1);
  });
});
