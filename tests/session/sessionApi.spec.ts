// Run with: npx tsx --test tests/session/sessionApi.spec.ts
//
// 지시 #dcaee6a9 — `src/server/api/session.ts` GET · PUT · DELETE 핸들러 계약 잠금.
//
// 축
//   A1. GET — 인증 없음 → 401.
//   A2. GET — 잘못된 id → 400.
//   A3. GET — 존재하지 않음 → 404.
//   A4. GET — 성공 → 200 + { ok: true, session } 모양.
//   A5. PUT — 본문이 스키마 불일치 → 400.
//   A6. PUT — userId 가 resolveUser 결과와 다르면 → 403.
//   A7. PUT — 성공 시 adapter.upsert 에 fullSnapshot 전달.
//   A8. DELETE — 존재 → 200, 없음 → 404.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGetSessionHandler,
  createPutSessionHandler,
  createDeleteSessionHandler,
  type HandlerRequest,
  type HandlerResponse,
  type SessionApiDeps,
} from '../../src/server/api/session.ts';
import {
  createInMemorySessionStore,
  buildSessionSnapshot,
} from '../../src/session/sessionStore.ts';
import {
  createBudgetSession,
  recordUsage,
  type BudgetSession,
} from '../../src/llm/tokenBudget.ts';
import type { ClaudeTokenUsage } from '../../src/types.ts';

function makeRes() {
  const state: { status: number; body: unknown } = { status: 0, body: null };
  const res: HandlerResponse = {
    status(code) { state.status = code; return res; },
    json(body) { state.body = body; },
  };
  return { res, state };
}

function makeDeps(userIdResolver: () => string | null = () => 'U'): SessionApiDeps {
  return {
    adapter: createInMemorySessionStore(),
    resolveUser: userIdResolver,
  };
}

function sampleUsage(): ClaudeTokenUsage {
  return {
    input_tokens: 10, output_tokens: 20,
    cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
    model: 'claude-opus-4-7', at: '2026-04-21T10:00:00.000Z',
  };
}

function seedBudget(): BudgetSession {
  let b = createBudgetSession('S1');
  b = recordUsage(b, sampleUsage());
  return b;
}

test('A1. GET — 인증 없음이면 401', async () => {
  const deps = makeDeps(() => null);
  const handler = createGetSessionHandler(deps);
  const { res, state } = makeRes();
  await handler({ params: { id: 'S1' } }, res);
  assert.equal(state.status, 401);
});

test('A2. GET — 잘못된 id 는 400', async () => {
  const deps = makeDeps();
  const handler = createGetSessionHandler(deps);
  const { res, state } = makeRes();
  await handler({ params: {} }, res);
  assert.equal(state.status, 400);
});

test('A3. GET — 존재하지 않으면 404', async () => {
  const deps = makeDeps();
  const handler = createGetSessionHandler(deps);
  const { res, state } = makeRes();
  await handler({ params: { id: 'missing' } }, res);
  assert.equal(state.status, 404);
});

test('A4. GET — 성공 시 { ok:true, session } 반환', async () => {
  const deps = makeDeps();
  const snap = buildSessionSnapshot({
    sessionId: 'S1', userId: 'U', budget: seedBudget(), mcp: null, compactions: 0,
    now: () => '2026-04-21T10:00:00.000Z',
  });
  await deps.adapter.upsert(
    { sessionId: 'S1', userId: 'U', patch: {
      history: snap.history, compactedSummary: snap.compactedSummary, budget: snap.budget,
      mcp: snap.mcp, compactions: snap.compactions, updatedAt: snap.updatedAt,
    } },
    snap,
  );
  const handler = createGetSessionHandler(deps);
  const { res, state } = makeRes();
  await handler({ params: { id: 'S1' } }, res);
  assert.equal(state.status, 200);
  const body = state.body as { ok: true; session: { sessionId: string } };
  assert.equal(body.ok, true);
  assert.equal(body.session.sessionId, 'S1');
});

test('A5. PUT — 본문이 스키마 불일치면 400', async () => {
  const deps = makeDeps();
  const handler = createPutSessionHandler(deps);
  const { res, state } = makeRes();
  await handler({ params: { id: 'S1' }, body: { sessionId: 'S1', foo: 'bar' } }, res);
  assert.equal(state.status, 400);
});

test('A6. PUT — userId 가 resolveUser 결과와 다르면 403', async () => {
  const deps = makeDeps(() => 'A');
  const handler = createPutSessionHandler(deps);
  const snap = buildSessionSnapshot({
    sessionId: 'S1', userId: 'B', budget: seedBudget(), mcp: null, compactions: 0,
    now: () => '2026-04-21T10:00:00.000Z',
  });
  const { res, state } = makeRes();
  await handler({ params: { id: 'S1' }, body: snap }, res);
  assert.equal(state.status, 403);
});

test('A7. PUT — 성공 시 adapter.upsert 호출, 이후 GET 으로 조회 가능', async () => {
  const deps = makeDeps();
  const put = createPutSessionHandler(deps);
  const snap = buildSessionSnapshot({
    sessionId: 'S1', userId: 'U', budget: seedBudget(), mcp: null, compactions: 0,
    now: () => '2026-04-21T10:00:00.000Z',
  });
  const { res: res1, state: s1 } = makeRes();
  await put({ params: { id: 'S1' }, body: snap }, res1);
  assert.equal(s1.status, 200);

  const get = createGetSessionHandler(deps);
  const { res: res2, state: s2 } = makeRes();
  await get({ params: { id: 'S1' } }, res2);
  assert.equal(s2.status, 200);
});

test('A8. DELETE — 존재하면 200, 없으면 404', async () => {
  const deps = makeDeps();
  // 먼저 seed.
  const snap = buildSessionSnapshot({
    sessionId: 'S1', userId: 'U', budget: seedBudget(), mcp: null, compactions: 0,
    now: () => '2026-04-21T10:00:00.000Z',
  });
  await deps.adapter.upsert(
    { sessionId: 'S1', userId: 'U', patch: {
      history: snap.history, compactedSummary: snap.compactedSummary, budget: snap.budget,
      mcp: snap.mcp, compactions: snap.compactions, updatedAt: snap.updatedAt,
    } },
    snap,
  );
  const del = createDeleteSessionHandler(deps);
  const { res: r1, state: s1 } = makeRes();
  await del({ params: { id: 'S1' } }, r1);
  assert.equal(s1.status, 200);

  const { res: r2, state: s2 } = makeRes();
  await del({ params: { id: 'S1' } }, r2);
  assert.equal(s2.status, 404);
});
