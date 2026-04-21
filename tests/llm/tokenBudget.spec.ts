// Run with: npx tsx --test tests/llm/tokenBudget.spec.ts
//
// 지시 #e72d7d21 (QA) · 토큰 예산 회귀 확장.
//
// 기존 `tests/token-budget/{cacheHitRate.longSession,degrade}.spec.ts` 가 "궤적" 과
// "핸드오프" 를 각각 잠갔다면, 본 스펙은 그 사이의 **경계선(boundary)** 을 한 파일에
// 모은다. 회귀는 대개 궤적 평균이 아니라 경계에서 발생한다.
//
// 축
//   T1. 캐시 히트율 경계 — 웜업 1턴 / 2턴 / 50턴 임계 변화가 회귀 없이 유지.
//   T2. 소프트 디그레이드 발동 경계 — softRatio ± 0 토큰 · hardRatio ± 0 토큰 에서
//       정확히 'soft'/'hard' 로 전이한다. 경계 바로 아래는 'none'/'soft'.
//   T3. applySoftDegrade 경계 — 짧은 시스템 프롬프트(240자 이하) 는 그대로, 긴 프롬프트는
//       1/3 이하로 줄어든다. 큰 assistant 턴(1000 토큰 이상) 만 요약, 작은 턴은 보존.
//   T4. usageRatio · DEFAULT_TOKEN_BUDGET_CAP — 기본 상수 180_000·0.8·1.0 이 흔들리면
//       다른 팀이 쓰는 디그레이드 계산이 연쇄 회귀 → 상수 자체를 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TOKEN_BUDGET_CAP,
  applySoftDegrade,
  shouldDegrade,
  usageRatio,
  type ConversationTurn,
} from '../../src/llm/tokenBudget.ts';
import {
  EMPTY_TOTALS,
  cacheHitRate,
  mergeUsage,
} from '../../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../../src/types.ts';

// ────────────────────────────────────────────────────────────────────────────
// 유틸 — 빈 totals · 턴 생성
// ────────────────────────────────────────────────────────────────────────────

function freshTotals(overrides: Partial<ClaudeTokenUsageTotals> = {}): ClaudeTokenUsageTotals {
  return {
    ...EMPTY_TOTALS,
    byModel: {},
    errors: { ...EMPTY_TOTALS.errors },
    ...overrides,
  };
}

function warmupTurn(n: number): ClaudeTokenUsage {
  return {
    input_tokens: 800,
    output_tokens: 400,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 4_000,
    model: 'claude-opus-4-7',
    at: new Date(1_700_000_000_000 + n * 1_000).toISOString(),
  };
}

function steadyTurn(n: number): ClaudeTokenUsage {
  return {
    input_tokens: 200,
    output_tokens: 400,
    cache_read_input_tokens: 4_000,
    cache_creation_input_tokens: 0,
    model: 'claude-opus-4-7',
    at: new Date(1_700_000_000_000 + n * 1_000).toISOString(),
  };
}

function longText(len: number): string {
  return 'x'.repeat(len);
}

// ────────────────────────────────────────────────────────────────────────────
// T1. 캐시 히트율 경계
// ────────────────────────────────────────────────────────────────────────────

test('T1-1. 웜업 1턴 — 캐시 히트율은 명확히 낮다(< 0.01)', () => {
  let totals = freshTotals();
  totals = mergeUsage(totals, warmupTurn(0));
  assert.ok(cacheHitRate(totals) < 0.01, `웜업 1턴 히트율 기대 <0.01, got ${cacheHitRate(totals).toFixed(4)}`);
});

test('T1-2. 웜업 2턴 후 정상구간 1턴 — 히트율이 명확히 상승(≥ 0.50)', () => {
  let totals = freshTotals();
  totals = mergeUsage(totals, warmupTurn(0));
  totals = mergeUsage(totals, warmupTurn(1));
  const warmRate = cacheHitRate(totals);
  totals = mergeUsage(totals, steadyTurn(2));
  const afterSteady = cacheHitRate(totals);
  assert.ok(afterSteady > warmRate, `히트율 상승 기대 — warm=${warmRate.toFixed(3)} after=${afterSteady.toFixed(3)}`);
  assert.ok(afterSteady >= 0.50, `3턴 시점 누적 히트율 ≥0.50 기대, got ${afterSteady.toFixed(3)}`);
});

test('T1-3. 50턴 — 히트율은 0.80 이상으로 수렴(장시간 세션 회귀 가드)', () => {
  let totals = freshTotals();
  for (let i = 0; i < 50; i += 1) {
    totals = mergeUsage(totals, i < 2 ? warmupTurn(i) : steadyTurn(i));
  }
  const rate = cacheHitRate(totals);
  assert.ok(rate >= 0.80, `50턴 누적 히트율 ≥0.80 기대, got ${rate.toFixed(3)}`);
  assert.equal(totals.callCount, 50);
});

test('T1-4. cacheReadTokens·inputTokens 는 턴마다 단조 비감소(회귀 감시)', () => {
  let totals = freshTotals();
  let prevRead = 0;
  let prevInput = 0;
  for (let i = 0; i < 30; i += 1) {
    totals = mergeUsage(totals, i < 2 ? warmupTurn(i) : steadyTurn(i));
    assert.ok(totals.cacheReadTokens >= prevRead, `turn ${i}: cacheReadTokens 감소`);
    assert.ok(totals.inputTokens >= prevInput, `turn ${i}: inputTokens 감소`);
    prevRead = totals.cacheReadTokens;
    prevInput = totals.inputTokens;
  }
});

test('T1-5. 오프라인/차단 — cache_read 0 · input 0 이면 히트율 0(예외 없음)', () => {
  const zero = freshTotals({ inputTokens: 0, cacheReadTokens: 0 });
  assert.equal(cacheHitRate(zero), 0);
});

// ────────────────────────────────────────────────────────────────────────────
// T2. 소프트 디그레이드 발동 경계
// ────────────────────────────────────────────────────────────────────────────

test('T2-1. soft 경계 바로 아래 — 79,999 토큰(softRatio 0.8·cap 100k) 은 "none"', () => {
  const cap = { capTokens: 100_000, softRatio: 0.8, hardRatio: 1.0 };
  const just = freshTotals({ inputTokens: 60_000, outputTokens: 19_999 });
  assert.equal(usageRatio(just, cap), 79_999 / 100_000);
  assert.equal(shouldDegrade(just, cap), 'none');
});

test('T2-2. soft 경계 정확 — 80,000 토큰은 "soft" 로 전이', () => {
  const cap = { capTokens: 100_000, softRatio: 0.8, hardRatio: 1.0 };
  const atSoft = freshTotals({ inputTokens: 60_000, outputTokens: 20_000 });
  assert.equal(shouldDegrade(atSoft, cap), 'soft');
});

test('T2-3. hard 경계 바로 아래 — 99,999 토큰은 여전히 "soft"', () => {
  const cap = { capTokens: 100_000, softRatio: 0.8, hardRatio: 1.0 };
  const beforeHard = freshTotals({ inputTokens: 80_000, outputTokens: 19_999 });
  assert.equal(shouldDegrade(beforeHard, cap), 'soft');
});

test('T2-4. hard 경계 정확 — 100,000 토큰은 "hard"', () => {
  const cap = { capTokens: 100_000, softRatio: 0.8, hardRatio: 1.0 };
  const atHard = freshTotals({ inputTokens: 70_000, outputTokens: 30_000 });
  assert.equal(shouldDegrade(atHard, cap), 'hard');
});

test('T2-5. 캐시 토큰은 분모에 포함되지 않는다(과도 보수 방지)', () => {
  const cap = { capTokens: 100_000, softRatio: 0.8, hardRatio: 1.0 };
  // cacheRead 50_000 은 계산 무관 — input+output 합만이 보인다.
  const mixed = freshTotals({ inputTokens: 40_000, outputTokens: 30_000, cacheReadTokens: 50_000 });
  assert.equal(usageRatio(mixed, cap), 0.7);
  assert.equal(shouldDegrade(mixed, cap), 'none');
});

test('T2-6. 커스텀 softRatio=0.5 — 절반 경계로 당겨져도 정확히 전이', () => {
  const cap = { capTokens: 10_000, softRatio: 0.5, hardRatio: 0.9 };
  assert.equal(shouldDegrade(freshTotals({ inputTokens: 4_999 }), cap), 'none');
  assert.equal(shouldDegrade(freshTotals({ inputTokens: 5_000 }), cap), 'soft');
  assert.equal(shouldDegrade(freshTotals({ inputTokens: 8_999 }), cap), 'soft');
  assert.equal(shouldDegrade(freshTotals({ inputTokens: 9_000 }), cap), 'hard');
});

// ────────────────────────────────────────────────────────────────────────────
// T3. applySoftDegrade 경계
// ────────────────────────────────────────────────────────────────────────────

test('T3-1. 짧은 시스템 프롬프트(≤240자) 는 원문 보존(불필요한 손실 방지)', () => {
  const short = 'Be concise. Answer in Korean.';
  const out = applySoftDegrade({ systemPrompt: short });
  assert.equal(out.systemPrompt, short);
  assert.equal(out.savedTokens, 0);
});

test('T3-2. 긴 시스템 프롬프트(>240자) 는 1/3 이하로 축약되고 savedTokens>0', () => {
  const sentences: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    sentences.push(`Rule ${i} explains an aspect of the agent's behavior in clear English.`);
  }
  const systemPrompt = sentences.join(' ');
  assert.ok(systemPrompt.length > 240);
  const out = applySoftDegrade({ systemPrompt });
  assert.ok(out.systemPrompt!.length < systemPrompt.length / 3 + 1, '1/3 수준으로 축약');
  assert.ok(out.savedTokens > 0);
});

test('T3-3. 큰 assistant 턴(1000 토큰+·200자+) 만 "(요약) …" 로 치환, 작은 턴은 보존', () => {
  const smallUser: ConversationTurn = { role: 'user', content: '간단 질문', tokens: 8 };
  const smallAssistant: ConversationTurn = { role: 'assistant', content: '짧은 답', tokens: 20 };
  const heavyAssistant: ConversationTurn = {
    role: 'assistant',
    content: longText(3_000),
    tokens: 1_500,
  };
  const out = applySoftDegrade({
    history: [smallUser, smallAssistant, heavyAssistant],
  });
  const [u, a, h] = out.history;
  assert.equal(u.content, smallUser.content, 'user 턴은 변형되지 않음');
  assert.equal(a.content, smallAssistant.content, '작은 assistant 턴은 보존');
  assert.match(h.content, /^\(요약\)/);
  assert.ok(h.tokens < heavyAssistant.tokens, '요약 턴은 토큰 감소');
  assert.ok(out.savedTokens > 0);
});

test('T3-4. assistant 턴이 1000 토큰 미만이면 요약하지 않는다(경계)', () => {
  const border: ConversationTurn = {
    role: 'assistant',
    content: longText(2_000),
    tokens: 999,
  };
  const out = applySoftDegrade({ history: [border] });
  assert.equal(out.history[0].content, border.content, '경계 바로 아래는 그대로');
  assert.equal(out.history[0].tokens, 999);
});

test('T3-5. tools JSON 파싱 성공 — name/description 만 남기고 parameters 상세 제거', () => {
  const toolsSchema = JSON.stringify({
    tools: [
      { name: 'fetch', description: 'fetch a URL', parameters: { url: { type: 'string', description: longText(500) } } },
      { name: 'search', description: 'search web', parameters: { q: { type: 'string' } } },
    ],
  });
  const out = applySoftDegrade({ toolsSchema });
  assert.ok(out.toolsSchema!.length < toolsSchema.length);
  const parsed = JSON.parse(out.toolsSchema!) as { tools: Array<Record<string, unknown>> };
  assert.equal(parsed.tools.length, 2);
  for (const t of parsed.tools) {
    assert.equal(Object.keys(t).sort().join(','), 'description,name');
  }
});

test('T3-6. tools JSON 파싱 실패 — 절반 길이로 잘라 보루 축약', () => {
  const broken = '{tools: [not-valid-json]';
  const out = applySoftDegrade({ toolsSchema: broken });
  assert.ok(out.toolsSchema!.length <= Math.ceil(broken.length / 2));
});

// ────────────────────────────────────────────────────────────────────────────
// T4. 기본 상수 고정
// ────────────────────────────────────────────────────────────────────────────

test('T4-1. DEFAULT_TOKEN_BUDGET_CAP — 180,000·0.8·1.0 상수 고정', () => {
  assert.equal(DEFAULT_TOKEN_BUDGET_CAP.capTokens, 180_000);
  assert.equal(DEFAULT_TOKEN_BUDGET_CAP.softRatio, 0.8);
  assert.equal(DEFAULT_TOKEN_BUDGET_CAP.hardRatio, 1.0);
});

test('T4-2. 기본 cap 에서 144,000 토큰은 soft, 180,000 토큰은 hard 로 전이', () => {
  // 0.8 · 180_000 = 144_000. 경계 정확값을 시각화.
  assert.equal(shouldDegrade(freshTotals({ inputTokens: 143_999 })), 'none');
  assert.equal(shouldDegrade(freshTotals({ inputTokens: 144_000 })), 'soft');
  assert.equal(shouldDegrade(freshTotals({ inputTokens: 179_999 })), 'soft');
  assert.equal(shouldDegrade(freshTotals({ inputTokens: 180_000 })), 'hard');
});
