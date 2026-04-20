// Run with: npx tsx --test tests/token-budget/degrade.spec.ts
//
// 지시 #29d56176 — 점진적 디그레이드(graceful degrade) 회귀 잠금.
//
// 축
//   D1. soft/hard 전이 시점 — shouldDegrade 가 softRatio·hardRatio 경계를 정확히 판정.
//   D2. applySoftDegrade — 시스템 프롬프트·툴 스키마·큰 assistant 턴이 실제로 축약된다.
//   D3. handoffToNewSession — 새 세션 스냅샷에 인계 요약이 들어가고 adapter 에 저장된다.
//   D4. 토큰 감소치 — 인계된 세션의 추정 토큰이 원본 대비 30% 이상 줄어든다.
//   D5. hard 단계에서도 "거부" 대신 "새 세션 이어서" 경로가 제공된다(handoff 반환값으로 증명).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldDegrade,
  applySoftDegrade,
  usageRatio,
  DEFAULT_TOKEN_BUDGET_CAP,
  createBudgetSession,
  appendTurn,
  recordUsage,
  type BudgetSession,
  type ConversationTurn,
} from '../../src/llm/tokenBudget.ts';
import {
  createInMemorySessionStore,
  handoffToNewSession,
} from '../../src/session/sessionStore.ts';
import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../../src/types.ts';

function totals(partial: Partial<ClaudeTokenUsageTotals> = {}): ClaudeTokenUsageTotals {
  return {
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    callCount: 0, estimatedCostUsd: 0,
    byModel: {},
    updatedAt: new Date(0).toISOString(),
    errors: { http429: 0, http5xx: 0, sessionReset: 0, providerError: 0, fallback: 0 },
    ...partial,
  };
}

function longText(len: number): string {
  return 'x'.repeat(len);
}

test('D1. shouldDegrade — soft/hard 경계 전이', () => {
  const cap = { capTokens: 100_000, softRatio: 0.8, hardRatio: 1.0 };
  assert.equal(shouldDegrade(totals({ inputTokens: 50_000, outputTokens: 10_000 }), cap), 'none');
  // 60k → 0.6 → none.
  assert.equal(shouldDegrade(totals({ inputTokens: 70_000, outputTokens: 10_000 }), cap), 'soft');
  // 80k → 0.8 → soft 경계 진입.
  assert.equal(shouldDegrade(totals({ inputTokens: 95_000, outputTokens: 10_000 }), cap), 'hard');
  // 105k → 1.05 → hard.
  assert.equal(usageRatio(totals({ inputTokens: 50_000 }), cap), 0.5);
});

test('D2. applySoftDegrade — 시스템/툴/히스토리 축약', () => {
  const heavyBody = longText(2_000);
  const output = applySoftDegrade({
    systemPrompt: [
      '당신은 장시간 동작하는 에이전트입니다.',
      '첫째, 사용자의 말을 그대로 반복하지 마십시오.',
      '둘째, 매 턴 요약을 제시하십시오.',
      '셋째, 필요한 경우 도구를 호출하십시오.',
      '넷째, 오류는 깔끔하게 처리하십시오.',
      '다섯째, 결과는 결정론적이어야 합니다.',
      '여섯째, 불필요한 장황함을 피하십시오.',
    ].join(' '),
    agentDefinition: '[Agents] Leader · Developer · QA',
    toolsSchema: JSON.stringify({
      tools: [
        { name: 'fetch', description: 'URL fetch', parameters: { type: 'object', properties: { url: { type: 'string', description: longText(500) } } } },
        { name: 'search', description: 'search the web', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
      ],
    }),
    history: [
      { role: 'user', content: '요약 부탁', tokens: 10 },
      { role: 'assistant', content: heavyBody, tokens: 2_000 },
      { role: 'user', content: '다음 질문', tokens: 10 },
    ],
  });
  assert.ok((output.systemPrompt?.length ?? 0) < 400, '시스템 프롬프트가 1/3 이하로 줄어야');
  assert.ok((output.toolsSchema?.length ?? 0) < 200, '툴 스키마의 파라미터 상세가 제거되어야');
  // 큰 assistant 턴은 "(요약) ..." 로 치환.
  const summarized = output.history.find((t) => t.role === 'assistant');
  assert.ok(summarized);
  assert.match(summarized!.content, /^\(요약\)/);
  assert.ok(summarized!.tokens < 2_000);
  assert.ok(output.savedTokens > 0, 'savedTokens 는 양수여야');
});

test('D3. handoffToNewSession — 새 세션 스냅샷이 adapter 에 저장되고 인계 요약을 포함', async () => {
  let budget: BudgetSession = createBudgetSession('old-session');
  for (let i = 0; i < 10; i += 1) {
    budget = recordUsage(budget, {
      input_tokens: 2_000, output_tokens: 1_000,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      model: 'claude-opus-4-7', at: '2026-04-21T10:00:00.000Z',
    } satisfies ClaudeTokenUsage);
    budget = appendTurn(budget, { role: 'user', content: `질문-${i}`, tokens: 300 });
    budget = appendTurn(budget, { role: 'assistant', content: longText(400), tokens: 800 });
  }

  const adapter = createInMemorySessionStore();
  const out = await handoffToNewSession({
    previousSessionId: 'old-session',
    userId: 'U',
    budget,
    adapter,
    mcp: { transport: 'http', url: 'https://x' },
    now: () => '2026-04-21T12:00:00.000Z',
  });

  assert.notEqual(out.newSessionId, 'old-session');
  assert.match(out.initialPrompt, /이전 세션 인계/);
  assert.match(out.initialPrompt, /old-session/);
  const saved = await adapter.get('U', out.newSessionId);
  assert.ok(saved, '새 세션 스냅샷이 저장되어야');
  assert.equal(saved!.budget.callCount, 0, '새 세션은 토큰 총계 0 으로 시작');
  assert.equal(saved!.history.length, 0);
  assert.ok(saved!.compactedSummary.includes('이전 세션 인계'));
  assert.equal(saved!.mcp?.transport, 'http');
});

test('D4. 인계 후 carriedTokens 가 sourceTokens 의 70% 이하(즉 30% 이상 절감)', async () => {
  let budget: BudgetSession = createBudgetSession('bulky');
  // 충분히 큰 대화 이력을 만들어 인계 요약의 압축 효과를 가시화한다.
  for (let i = 0; i < 25; i += 1) {
    budget = appendTurn(budget, { role: 'user', content: longText(600), tokens: 200 });
    budget = appendTurn(budget, { role: 'assistant', content: longText(2_000), tokens: 800 });
  }
  const adapter = createInMemorySessionStore();
  const out = await handoffToNewSession({
    previousSessionId: 'bulky',
    userId: 'U',
    budget,
    adapter,
  });
  assert.ok(out.sourceTokensEstimated > 0);
  assert.ok(out.carriedTokensEstimated > 0);
  const saved = out.sourceTokensEstimated - out.carriedTokensEstimated;
  const ratio = saved / out.sourceTokensEstimated;
  assert.ok(
    ratio >= 0.3,
    `인계 토큰 감소율 ${(ratio * 100).toFixed(1)}% — 30% 이상이어야`,
  );
});

test('D5. hard 단계에서도 흐름은 끊기지 않는다 — handoff 결과로 새 세션이 제공됨', async () => {
  const cap = { capTokens: 10_000, softRatio: 0.8, hardRatio: 1.0 };
  const over = totals({ inputTokens: 12_000, outputTokens: 1_000 });
  assert.equal(shouldDegrade(over, cap), 'hard');

  // hard 라도 handoff 를 통해 새 세션이 열려야 — 즉 "거부" 가 아닌 "이어감".
  let budget = createBudgetSession('at-hard-cap');
  budget = appendTurn(budget, { role: 'user', content: '마지막 질문', tokens: 50 });
  budget = appendTurn(budget, { role: 'assistant', content: '마지막 답변', tokens: 50 });
  const adapter = createInMemorySessionStore();
  const out = await handoffToNewSession({
    previousSessionId: 'at-hard-cap',
    userId: 'U',
    budget,
    adapter,
  });
  assert.ok(out.newSessionId);
  assert.ok(out.initialPrompt.length > 0);
});

test('D6. DEFAULT_TOKEN_BUDGET_CAP — softRatio=0.8·hardRatio=1.0·capTokens=180000', () => {
  assert.equal(DEFAULT_TOKEN_BUDGET_CAP.softRatio, 0.8);
  assert.equal(DEFAULT_TOKEN_BUDGET_CAP.hardRatio, 1.0);
  assert.equal(DEFAULT_TOKEN_BUDGET_CAP.capTokens, 180_000);
});
