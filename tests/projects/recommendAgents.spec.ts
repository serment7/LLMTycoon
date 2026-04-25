// Run with: npx tsx --test tests/projects/recommendAgents.spec.ts
//
// 지시 #e72d7d21 (QA) · 추천 팀 엔드투엔드 회귀.
//
// 본 스펙은 신규 프로젝트 마법사의 3단계 흐름 — "설명 입력 → 추천 수신 → 일괄 추가
// → 팀 반영" — 을 한 파일에 엮어 잠근다. 기존 `recommendAgentsApi.unit.test.ts`,
// `projectRecommendationClient.unit.test.ts` 가 각 계층을 독립 잠금했다면 본 스펙은
// HTTP 핸들러 → 클라이언트 → applyRecommendedTeam 을 한 프로세스 안에서 직접 연결해
// 스냅샷을 만든다. 네트워크는 fetch stub 이 대체.
//
// 시나리오
//   E1. 기본 경로 — description 입력 → POST /api/recommendAgents → 추천 3~5명 →
//       일괄 추가(POST /api/agents/hire + /api/projects/:id/agents) → appliedCount
//       가 추천 수와 일치.
//   E2. invoker 실패 폴백 — LLM 호출이 예외를 던지면 recommendAgentTeam 은 휴리스틱
//       폴백으로 응답하고, 응답 source='heuristic' 가 클라이언트까지 전달된다.
//   E3. 캐시 히트 경로 — cacheStore 히트 시 invoker 호출 0·응답 source='cache'.
//   E4. 부분 실패 — hire 한 건이 실패해도 나머지는 반영되며 appliedCount < total.
//   E5. 응답 items 최대 5 — LLM 이 6+ 을 반환해도 서버가 잘라 UI 가 과적재되지 않음.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRecommendAgentsHandler,
  type HandlerRequest,
  type HandlerResponse,
} from '../../src/server/api/recommendAgents.ts';
import { applyRecommendedTeam } from '../../src/project/api.ts';
import { createRecommendationCacheStore } from '../../src/llm/recommendationCacheStore.ts';
import {
  DEFAULT_ROLE_SKILLS,
  type AgentRecommendation,
  type AgentTeamRecommendation,
} from '../../src/project/recommendAgentTeam.ts';
import { createInMemoryUsageLog } from '../../src/llm/usageLog.ts';

// ────────────────────────────────────────────────────────────────────────────
// 유틸 — 기록형 응답 · fetch stub
// ────────────────────────────────────────────────────────────────────────────

interface Recorded {
  res: HandlerResponse;
  status: number;
  body: unknown;
}

function recordingResponse(): Recorded {
  const out = { res: null as unknown as HandlerResponse, status: 0, body: undefined as unknown };
  const res: HandlerResponse = {
    status(code) { out.status = code; return res; },
    json(body) { out.body = body; },
  };
  out.res = res;
  return out;
}

interface FetchCall { readonly url: string; readonly init?: RequestInit }

/**
 * 프로젝트 생성 플로우의 두 엔드포인트 — `/api/agents/hire`,
 * `/api/projects/:id/agents` — 를 동시에 처리하는 테스트용 fetch.
 * hireFailOn 에 이름이 있으면 그 항목은 500 응답 → 부분 실패 경로 재현.
 */
function makeTeamFetchStub(opts: { hireFailOn?: string[] } = {}) {
  const calls: FetchCall[] = [];
  let hireSeq = 0;
  const failOn = new Set(opts.hireFailOn ?? []);
  const impl: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    calls.push({ url, init });
    if (url.endsWith('/api/agents/hire')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
      if (body.name && failOn.has(body.name)) {
        return new Response('nope', { status: 500 });
      }
      hireSeq += 1;
      return new Response(JSON.stringify({ id: `agent-${hireSeq}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (/\/api\/projects\/[^/]+\/agents$/.test(url)) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: impl, calls };
}

/**
 * E2E 엔드포인트 흐름을 한 프로세스 안에서 시뮬레이션. 서버 핸들러를 직접 호출해
 * 응답 body 를 그대로 클라이언트 경로(applyRecommendedTeam) 로 넘긴다.
 */
async function runE2e(params: {
  description: string;
  locale?: 'en' | 'ko';
  invoker?: (messages: unknown) => Promise<string | object>;
  cacheSeed?: { description: string; locale: 'en' | 'ko'; value: AgentTeamRecommendation };
  teamFetch?: ReturnType<typeof makeTeamFetchStub>;
}) {
  const cacheStore = createRecommendationCacheStore();
  if (params.cacheSeed) {
    // 지시 #797538d6 — 핸들러는 요청 body 의 count 가 미주입이면 기본 5 로 찾는다. 캐시 키도
    // `(description, locale, count)` 3 축이라 사전 seed 에서 동일 count 를 명시해야 히트.
    cacheStore.set(params.cacheSeed.description, params.cacheSeed.locale, params.cacheSeed.value, 5);
  }
  const usageLog = createInMemoryUsageLog();
  let invokerCalls = 0;
  const handler = createRecommendAgentsHandler({
    cacheStore,
    usageLog,
    invoker: params.invoker
      ? async (msgs) => { invokerCalls += 1; return params.invoker!(msgs); }
      : undefined,
  });
  const rec = recordingResponse();
  await handler(
    { body: { description: params.description, locale: params.locale } } as HandlerRequest,
    rec.res,
  );
  const body = rec.body as {
    ok: true;
    source: AgentTeamRecommendation['source'];
    locale: 'en' | 'ko';
    items: AgentRecommendation[];
  };
  const teamFetch = params.teamFetch ?? makeTeamFetchStub();
  const applied = await applyRecommendedTeam('proj-42', body.items, { fetch: teamFetch.fetch });
  return {
    status: rec.status,
    body,
    applied,
    invokerCalls,
    usageLog,
    fetchCalls: teamFetch.calls,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// E1. 기본 경로
// ────────────────────────────────────────────────────────────────────────────

test('E1-1. 설명 입력 → 추천 수신 → 일괄 추가 → 팀 반영(appliedCount 일치)', async () => {
  const out = await runE2e({
    description: '블로그 CMS — 인증, 게시글 CRUD, 댓글, 이미지 업로드, 보안/QA 감사',
    locale: 'ko',
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: '범위를 분해합니다.' },
          { role: 'Developer', name: 'Dev', rationale: '핵심 기능 구현.' },
          { role: 'QA', name: 'QA', rationale: '보안/회귀 테스트.' },
        ],
      }),
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.source, 'claude');
  assert.equal(out.body.locale, 'ko');
  assert.equal(out.body.items.length, 3);
  assert.equal(out.body.items[0].role, 'Leader');
  // skills 가 UI 카드용으로 채워져야 — 누락 항목은 기본값 보강.
  for (const it of out.body.items) {
    assert.ok(it.skills && it.skills.length > 0);
  }
  // 일괄 추가 — 각 추천당 hire 1 + attach 1 = 2회 호출.
  assert.equal(out.applied.appliedCount, 3);
  assert.equal(out.applied.items.length, 3);
  assert.equal(out.fetchCalls.filter((c) => c.url.endsWith('/api/agents/hire')).length, 3);
  assert.equal(
    out.fetchCalls.filter((c) => /\/api\/projects\/proj-42\/agents$/.test(c.url)).length,
    3,
  );
  for (const item of out.applied.items) {
    assert.equal(item.ok, true);
    assert.match(item.agentId!, /^agent-\d+$/);
  }
});

test('E1-2. hire 요청 본문에 추천 name/role/persona 가 그대로 전달된다', async () => {
  const teamFetch = makeTeamFetchStub();
  const out = await runE2e({
    description: '결제 모듈 보안 강화',
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: 'scope split' },
          { role: 'Developer', name: 'Dev', rationale: 'implement' },
        ],
      }),
    teamFetch,
  });
  assert.equal(out.applied.appliedCount, 2);
  const hireCalls = teamFetch.calls.filter((c) => c.url.endsWith('/api/agents/hire'));
  const first = JSON.parse(String(hireCalls[0].init!.body)) as Record<string, unknown>;
  assert.equal(first.name, 'Kai');
  assert.equal(first.role, 'Leader');
  assert.equal(first.persona, 'scope split');
  assert.equal(typeof first.spriteTemplate, 'string');
});

// ────────────────────────────────────────────────────────────────────────────
// E2. 추천 실패 시 폴백
// ────────────────────────────────────────────────────────────────────────────

test('E2-1. invoker 가 throw → 휴리스틱 폴백, source="heuristic", 최소 2명 반환', async () => {
  const out = await runE2e({
    description: '반응형 UI 디자인 리뉴얼과 보안 감사',
    locale: 'ko',
    invoker: async () => { throw new Error('claude-timeout'); },
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.source, 'heuristic');
  assert.ok(out.body.items.length >= 2);
  assert.equal(out.body.items[0].role, 'Leader');
  // 휴리스틱이어도 skills 는 기본값으로 채워져 UI 가 비지 않는다.
  assert.deepEqual(
    [...out.body.items[0].skills!],
    [...DEFAULT_ROLE_SKILLS.Leader],
  );
  // "UI 디자인"·"보안" 키워드로 Designer/QA 가 함께 추천되는지.
  const roles = out.body.items.map((i) => i.role);
  assert.ok(roles.includes('Designer'));
  assert.ok(roles.includes('QA'));
  // 폴백 경로에서도 전원 반영.
  assert.equal(out.applied.appliedCount, out.body.items.length);
});

test('E2-2. invoker 가 빈 items({}) 를 돌려줘도 휴리스틱 폴백(0명 응답 방지)', async () => {
  const out = await runE2e({
    description: '시장 조사와 연구 분석 프로젝트',
    locale: 'en',
    invoker: async () => JSON.stringify({ items: [] }),
  });
  assert.equal(out.body.source, 'heuristic');
  assert.ok(out.body.items.length >= 2);
});

test('E2-3. invoker 응답이 깨진 JSON 이어도 폴백 경로로 복구', async () => {
  const out = await runE2e({
    description: '디자인 시스템 정비',
    invoker: async () => 'not-a-json-at-all',
  });
  assert.equal(out.body.source, 'heuristic');
  assert.ok(out.body.items.length >= 2);
});

// ────────────────────────────────────────────────────────────────────────────
// E3. 캐시 히트
// ────────────────────────────────────────────────────────────────────────────

test('E3-1. 캐시 히트 시 invoker 미호출 · source="cache" · usageLog 에 cache 라인', async () => {
  const description = '동일 설명 반복 요청';
  const seed: AgentTeamRecommendation = {
    items: [
      { role: 'Leader', name: 'Kai', rationale: 'seed-lead' },
      { role: 'Developer', name: 'Dev', rationale: 'seed-dev' },
    ],
    source: 'claude',
    locale: 'en',
  };
  const out = await runE2e({
    description,
    locale: 'en',
    cacheSeed: { description, locale: 'en', value: seed },
    invoker: async () => { throw new Error('must-not-be-called'); },
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.source, 'cache');
  assert.equal(out.invokerCalls, 0);
  // 팀 반영 경로는 캐시 여부와 무관하게 동일하게 동작.
  assert.equal(out.applied.appliedCount, 2);
  // usageLog 에 recommend_agents 카테고리 라인 1건(히트 마커).
  await new Promise((r) => setTimeout(r, 0));
  const lines = out.usageLog.snapshot();
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as { model?: string; category?: string; callId?: string };
  assert.equal(parsed.model, 'cache');
  assert.equal(parsed.category, 'recommend_agents');
  assert.equal(parsed.callId, 'hit');
});

// ────────────────────────────────────────────────────────────────────────────
// E4. 부분 실패
// ────────────────────────────────────────────────────────────────────────────

test('E4-1. hire 한 건이 500 이어도 나머지는 반영된다(부분 실패 허용)', async () => {
  const teamFetch = makeTeamFetchStub({ hireFailOn: ['Dev'] });
  const out = await runE2e({
    description: '블로그 CMS — UI · 보안',
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: 'lead' },
          { role: 'Developer', name: 'Dev', rationale: 'impl' },
          { role: 'QA', name: 'QA', rationale: 'tests' },
        ],
      }),
    teamFetch,
  });
  assert.equal(out.body.items.length, 3);
  assert.equal(out.applied.appliedCount, 2, 'Dev 만 실패 → 2 명 반영');
  const failed = out.applied.items.find((i) => i.recommendation.name === 'Dev');
  assert.ok(failed);
  assert.equal(failed!.ok, false);
  assert.match(failed!.error!, /hire 실패/);
  const ok = out.applied.items.filter((i) => i.ok);
  assert.equal(ok.length, 2);
  assert.ok(ok.every((i) => typeof i.agentId === 'string' && i.agentId!.length > 0));
});

// ────────────────────────────────────────────────────────────────────────────
// E5. 응답 items 상한
// ────────────────────────────────────────────────────────────────────────────

test('E5-1. LLM 이 10 명을 돌려줘도 서버 응답은 최대 5 명으로 제한', async () => {
  const out = await runE2e({
    description: '대규모 스튜디오 시뮬레이션',
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: 'Kai', rationale: 'r' },
          { role: 'Developer', name: 'D1', rationale: 'r' },
          { role: 'Developer', name: 'D2', rationale: 'r' },
          { role: 'Developer', name: 'D3', rationale: 'r' },
          { role: 'Designer', name: 'Dx', rationale: 'r' },
          { role: 'QA', name: 'Q1', rationale: 'r' },
          { role: 'Researcher', name: 'R1', rationale: 'r' },
        ],
      }),
  });
  assert.equal(out.body.items.length, 5);
  assert.equal(out.applied.appliedCount, 5, '일괄 추가도 상한된 5명만 수행');
});
