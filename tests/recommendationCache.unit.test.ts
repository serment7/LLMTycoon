// Run with: npx tsx --test tests/recommendationCache.unit.test.ts
//
// 지시 #21a88a06 — 추천 응답 캐시 24h TTL · usageLog 카테고리 라인.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRecommendationCacheStore,
  hashDescription,
  DEFAULT_RECOMMENDATION_TTL_MS,
} from '../src/llm/recommendationCacheStore.ts';
import type { AgentTeamRecommendation } from '../src/project/recommendAgentTeam.ts';
import {
  USAGE_CATEGORY_RECOMMEND_AGENTS,
  createInMemoryUsageLog,
  formatUsageLogLine,
  parseUsageLogLine,
} from '../src/llm/usageLog.ts';
import {
  createRecommendAgentsHandler,
  type HandlerRequest,
  type HandlerResponse,
} from '../src/server/api/recommendAgents.ts';

function team(name: string, locale: 'en' | 'ko' = 'en'): AgentTeamRecommendation {
  return {
    items: [{ role: 'Leader', name, rationale: 'r', skills: ['planning'] }],
    source: 'claude',
    locale,
  };
}

function recordingResponse(): { res: HandlerResponse; status: number; body: unknown } {
  const out: { res: HandlerResponse; status: number; body: unknown } = {
    res: null as unknown as HandlerResponse,
    status: 0,
    body: undefined,
  };
  const res: HandlerResponse = {
    status(code) {
      out.status = code;
      return res;
    },
    json(body) {
      out.body = body;
    },
  };
  out.res = res;
  return out;
}

// ─── C: 캐시 스토어 자체 ──────────────────────────────────────────────────

test('C1. hashDescription — 공백 정규화 무관하게 동일 값이면 동일 해시', () => {
  assert.equal(hashDescription('abc'), hashDescription('abc'));
  assert.notEqual(hashDescription('abc'), hashDescription('abd'));
});

test('C2. set/get — 같은 description·locale 에서 히트', () => {
  const store = createRecommendationCacheStore();
  store.set('보안 강화', 'ko', team('Kai', 'ko'));
  const got = store.get('보안 강화', 'ko');
  assert.ok(got);
  assert.equal(got?.items[0].name, 'Kai');
});

test('C3. locale 분리 — en 에 저장한 것은 ko 로 조회되지 않는다', () => {
  const store = createRecommendationCacheStore();
  store.set('x', 'en', team('X', 'en'));
  assert.equal(store.get('x', 'ko'), null);
});

test('C4. TTL 만료 — 24h 경과 후 get 은 null 을 돌려주고 항목은 제거', () => {
  let t = 1_000_000;
  const store = createRecommendationCacheStore({ now: () => t });
  store.set('desc', 'en', team('T'));
  assert.ok(store.get('desc', 'en'));
  t += DEFAULT_RECOMMENDATION_TTL_MS + 1;
  assert.equal(store.get('desc', 'en'), null);
  assert.equal(store.size(), 0);
});

test('C5. invalidateAll — 전체 비우기', () => {
  const store = createRecommendationCacheStore();
  store.set('a', 'en', team('A'));
  store.set('b', 'ko', team('B', 'ko'));
  store.invalidateAll();
  assert.equal(store.size(), 0);
});

test('C6. invalidatePrefix("en") — 해당 로캘만 제거', () => {
  const store = createRecommendationCacheStore();
  store.set('a', 'en', team('A'));
  store.set('a', 'ko', team('A', 'ko'));
  store.invalidatePrefix('en');
  assert.equal(store.get('a', 'en'), null);
  assert.ok(store.get('a', 'ko'));
});

// ─── U: usageLog 카테고리 확장 ────────────────────────────────────────────

test('U1. formatUsageLogLine — options.category 가 있으면 라인에 포함', () => {
  const line = formatUsageLogLine(
    { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    'c1',
    { category: USAGE_CATEGORY_RECOMMEND_AGENTS },
  );
  const parsed = parseUsageLogLine(line);
  assert.equal(parsed?.category, USAGE_CATEGORY_RECOMMEND_AGENTS);
});

test('U2. 카테고리 없는 기존 라인은 여전히 파싱되고 category 는 undefined', () => {
  const line = formatUsageLogLine({
    input_tokens: 1,
    output_tokens: 2,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  const parsed = parseUsageLogLine(line);
  assert.ok(parsed);
  assert.equal(parsed?.category, undefined);
});

// ─── H: 핸들러 + 캐시 통합 ───────────────────────────────────────────────

test('H1. 첫 호출은 invoker 로, 두 번째는 캐시에서 응답(source=cache)', async () => {
  const store = createRecommendationCacheStore();
  const log = createInMemoryUsageLog();
  let invocations = 0;
  const handler = createRecommendAgentsHandler({
    invoker: async () => {
      invocations += 1;
      return JSON.stringify({
        items: [{ role: 'Leader', name: 'Kai', rationale: 'lead' }],
      });
    },
    cacheStore: store,
    usageLog: log,
  });

  const first = recordingResponse();
  await handler(
    { body: { description: 'payments hardening', locale: 'en' } } as HandlerRequest,
    first.res,
  );
  assert.equal((first.body as { source: string }).source, 'claude');

  const second = recordingResponse();
  await handler(
    { body: { description: 'payments hardening', locale: 'en' } } as HandlerRequest,
    second.res,
  );
  assert.equal((second.body as { source: string }).source, 'cache');
  assert.equal(invocations, 1, 'LLM 은 한 번만 호출돼야 한다');

  // usageLog 에는 miss / hit 두 라인이 category 를 달고 남는다.
  const lines = log.snapshot().map((l) => parseUsageLogLine(l));
  const categorized = lines.filter((l) => l?.category === USAGE_CATEGORY_RECOMMEND_AGENTS);
  assert.equal(categorized.length, 2);
  assert.ok(categorized.some((l) => l?.callId === 'miss'));
  assert.ok(categorized.some((l) => l?.callId === 'hit'));
});

test('H2. invalidateAll 후 다음 호출은 다시 invoker 로', async () => {
  const store = createRecommendationCacheStore();
  let invocations = 0;
  const handler = createRecommendAgentsHandler({
    invoker: async () => {
      invocations += 1;
      return JSON.stringify({ items: [{ role: 'Leader', name: 'K', rationale: 'r' }] });
    },
    cacheStore: store,
  });
  await handler({ body: { description: 'x' } } as HandlerRequest, recordingResponse().res);
  store.invalidateAll();
  await handler({ body: { description: 'x' } } as HandlerRequest, recordingResponse().res);
  assert.equal(invocations, 2);
});
