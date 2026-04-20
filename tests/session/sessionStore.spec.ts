// Run with: npx tsx --test tests/session/sessionStore.spec.ts
//
// 지시 #dcaee6a9 — `src/session/sessionStore.ts` 공개 계약 잠금.
//
// 축
//   P1. shallowDiffSnapshot — previous=null 이면 모든 주요 키가 patch 에 포함.
//   P2. shallowDiffSnapshot — 동일 값이면 isNoopPatch=true.
//   P3. shallowDiffSnapshot — history 만 변경되면 history + updatedAt 만 포함.
//   P4. buildSessionSnapshot — BudgetSession 총계와 mcp 를 정확히 반영.
//   P5. 메모리 어댑터 — upsert 후 get 으로 복원, remove 동작.
//   P6. 파일 어댑터 — 주입 read/write 훅으로 왕복 직렬화 검증.
//   P7. SessionPersistor — recordUsage / compact / mcp 세 이벤트만 저장, 무변경 시 skip.
//   P8. restoreBudgetSessionFromSnapshot — 총계·히스토리·compactedSummary 복원.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shallowDiffSnapshot,
  isNoopPatch,
  buildSessionSnapshot,
  createInMemorySessionStore,
  createFileSessionStore,
  createSessionPersistor,
  restoreBudgetSessionFromSnapshot,
  type SessionSnapshot,
} from '../../src/session/sessionStore.ts';
import {
  createBudgetSession,
  recordUsage,
  appendTurn,
  maybeCompact,
  type BudgetSession,
} from '../../src/llm/tokenBudget.ts';
import type { ClaudeTokenUsage } from '../../src/types.ts';

function mkUsage(partial: Partial<ClaudeTokenUsage> = {}): ClaudeTokenUsage {
  return {
    input_tokens: 100, output_tokens: 200,
    cache_read_input_tokens: 300, cache_creation_input_tokens: 400,
    model: 'claude-opus-4-7', at: '2026-04-21T10:00:00.000Z',
    ...partial,
  };
}

function snap(bud: BudgetSession, sessionId = 'S1', userId = 'U1'): SessionSnapshot {
  return buildSessionSnapshot({
    sessionId, userId, budget: bud,
    mcp: { transport: 'http', url: 'https://x', name: 'n' },
    compactions: 0,
    now: () => '2026-04-21T10:00:00.000Z',
  });
}

test('P1. shallowDiffSnapshot — previous=null 이면 주요 키 전부 포함', () => {
  let bud = createBudgetSession('S1');
  bud = recordUsage(bud, mkUsage());
  const n = snap(bud);
  const d = shallowDiffSnapshot(null, n);
  assert.ok(d.patch.history);
  assert.ok(d.patch.budget);
  assert.ok(d.patch.mcp);
  assert.ok(d.patch.compactedSummary !== undefined);
  assert.ok(d.patch.compactions !== undefined);
});

test('P2. shallowDiffSnapshot — 동일 스냅샷이면 isNoopPatch', () => {
  let bud = createBudgetSession('S1');
  bud = recordUsage(bud, mkUsage());
  const n = snap(bud);
  const d = shallowDiffSnapshot(n, n);
  assert.equal(isNoopPatch(d), true);
});

test('P3. shallowDiffSnapshot — history 만 변경되면 history + updatedAt 만 포함', () => {
  let bud = createBudgetSession('S1');
  bud = recordUsage(bud, mkUsage());
  const prev = snap(bud);
  bud = appendTurn(bud, { role: 'user', content: 'q', tokens: 10 });
  const next = buildSessionSnapshot({
    sessionId: 'S1', userId: 'U1', budget: bud,
    mcp: prev.mcp, compactions: 0, now: () => '2026-04-21T10:05:00.000Z',
  });
  const d = shallowDiffSnapshot(prev, next);
  assert.ok(d.patch.history);
  assert.ok(d.patch.updatedAt);
  assert.equal(d.patch.budget, undefined, 'budget 총계는 변경되지 않았으므로 미포함');
  assert.equal(d.patch.mcp, undefined);
});

test('P4. buildSessionSnapshot — budget 총계·mcp 반영', () => {
  let bud = createBudgetSession('S1');
  bud = recordUsage(bud, mkUsage({ input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 4_000 }));
  const s = snap(bud);
  assert.equal(s.budget.inputTokens, 1_000);
  assert.equal(s.budget.outputTokens, 2_000);
  assert.equal(s.budget.cacheReadTokens, 3_000);
  assert.equal(s.budget.cacheCreationTokens, 4_000);
  assert.equal(s.mcp?.transport, 'http');
});

test('P5. 메모리 어댑터 — upsert/get/remove 왕복', async () => {
  const adapter = createInMemorySessionStore();
  let bud = createBudgetSession('S1');
  bud = recordUsage(bud, mkUsage());
  const s = snap(bud);
  await adapter.upsert({ sessionId: s.sessionId, userId: s.userId, patch: {
    history: s.history, compactedSummary: s.compactedSummary, budget: s.budget, mcp: s.mcp, compactions: s.compactions, updatedAt: s.updatedAt,
  } }, s);
  const got = await adapter.get('U1', 'S1');
  assert.ok(got);
  assert.equal(got!.budget.cacheReadTokens, 300);
  assert.equal(await adapter.remove('U1', 'S1'), true);
  assert.equal(await adapter.get('U1', 'S1'), null);
});

test('P6. 파일 어댑터 — 주입 read/write 로 왕복 직렬화 검증', async () => {
  let stored = '';
  const adapter = createFileSessionStore('/tmp/fake.json', {
    readFile: async () => stored || '{}',
    writeFile: async (_p, d) => { stored = d; },
  });
  let bud = createBudgetSession('SF');
  bud = recordUsage(bud, mkUsage());
  const s = snap(bud, 'SF', 'UF');
  await adapter.upsert({ sessionId: s.sessionId, userId: s.userId, patch: {
    history: s.history, compactedSummary: s.compactedSummary, budget: s.budget, mcp: s.mcp, compactions: s.compactions, updatedAt: s.updatedAt,
  } }, s);
  assert.ok(stored.includes('"SF"'), '파일에 sessionId 가 기록');
  const got = await adapter.get('UF', 'SF');
  assert.ok(got);
  assert.equal(got!.schemaVersion, 1);
});

test('P7. SessionPersistor — 세 이벤트에서만 저장, 무변경 시 skip', async () => {
  const adapter = createInMemorySessionStore();
  const persistor = createSessionPersistor({ adapter, sessionId: 'SP', userId: 'UP' });
  let bud = createBudgetSession('SP');
  bud = recordUsage(bud, mkUsage());
  const first = await persistor.onRecordUsage(bud, { transport: 'stdio' });
  assert.equal(first, true, '첫 저장은 실행');
  const again = await persistor.onRecordUsage(bud, { transport: 'stdio' });
  assert.equal(again, false, '동일 스냅샷은 skip');
  // 대화 히스토리 추가 후 다시 호출.
  bud = appendTurn(bud, { role: 'user', content: 'q', tokens: 1 });
  const after = await persistor.onRecordUsage(bud, { transport: 'stdio' });
  assert.equal(after, true);
  // MCP transport 변경 이벤트.
  const mcpChanged = await persistor.onMcpTransportChanged(bud, { transport: 'http', url: 'https://x' });
  assert.equal(mcpChanged, true);
});

test('P8. restoreBudgetSessionFromSnapshot — 총계·히스토리 복원', () => {
  let bud = createBudgetSession('S1');
  bud = recordUsage(bud, mkUsage({ input_tokens: 500, cache_read_input_tokens: 9_000 }));
  bud = appendTurn(bud, { role: 'user', content: 'q', tokens: 10 });
  bud = appendTurn(bud, { role: 'assistant', content: 'a', tokens: 10 });
  const s = snap(bud);
  const restored = restoreBudgetSessionFromSnapshot(s);
  assert.equal(restored.totals.inputTokens, 500);
  assert.equal(restored.totals.cacheReadTokens, 9_000);
  assert.equal(restored.history.length, 2);
  assert.equal(restored.history[1].content, 'a');
});

test('P9. 재접속 시나리오 — 저장 → 파기 → 복원 후 cache_read 유지', async () => {
  const adapter = createInMemorySessionStore();
  const persistor = createSessionPersistor({ adapter, sessionId: 'R1', userId: 'U' });
  let bud = createBudgetSession('R1');
  for (let i = 0; i < 10; i += 1) {
    bud = recordUsage(bud, mkUsage({ input_tokens: 100, cache_read_input_tokens: 4_000 }));
    bud = appendTurn(bud, { role: 'user', content: `u-${i}`, tokens: 2_000 });
    await persistor.onRecordUsage(bud, { transport: 'stdio' });
  }
  const before = bud.totals.cacheReadTokens;
  // 세션 파기 시뮬.
  bud = createBudgetSession('R1');
  assert.equal(bud.totals.cacheReadTokens, 0);
  // 복원.
  const snapshot = await adapter.get('U', 'R1');
  assert.ok(snapshot);
  bud = restoreBudgetSessionFromSnapshot(snapshot!);
  assert.equal(bud.totals.cacheReadTokens, before);
});
