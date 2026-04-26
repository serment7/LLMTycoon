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

// ────────────────────────────────────────────────────────────────────────────
// 지시 #e4c60f64 — 토큰 한도 전략 회귀 (truncateToBudget · 스트리밍 watchdog)
//
// 본 섹션은 아직 src/ 에 추출되지 않은 두 헬퍼의 **계약(contract)** 을 잠근다.
// 스펙은 자급자족(self-contained) — 참조 구현을 inline 으로 포함해 dev 가
// 향후 src/llm/{truncate,streamingWatchdog}.ts 로 이전할 때 그대로 옮길 수 있도록 한다.
// 이전이 끝나면 inline impl 을 import 로 치환하기만 하면 된다(테스트 본문 무변경).
//
// 모델 한도 매트릭스 — 로컬 Ollama 모델별 컨텍스트 윈도(2026-04 시점):
//   · llama3:8b   → 8_192
//   · qwen2.5:7b  → 32_768
//   · mistral:7b  → 8_192
// ────────────────────────────────────────────────────────────────────────────

interface BudgetMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
  readonly tokens: number;
}

interface TruncateOptions {
  readonly modelLimit: number;
  /** 출력에 남겨 둘 토큰. 기본 = floor(modelLimit · 0.1). */
  readonly reservedOutputTokens?: number;
}

interface TruncateResult {
  readonly messages: readonly BudgetMessage[];
  readonly droppedCount: number;
  readonly totalTokens: number;
  readonly budgetTokens: number;
  readonly preservedSystemPrompt: boolean;
  readonly preservedLatestUser: boolean;
}

class OverBudgetError extends Error {
  constructor(
    readonly required: number,
    readonly budget: number,
  ) {
    super(`OverBudgetError: 시스템+최신 사용자 입력 ${required}토큰이 예산 ${budget}토큰을 초과`);
    this.name = 'OverBudgetError';
  }
}

/**
 * 메시지 배열을 모델 한도 안으로 줄인다. 보존 우선순위:
 *   (1) 모든 system 메시지 — 항상 살린다.
 *   (2) 가장 마지막 user 메시지 — 항상 살린다.
 *   (3) 그 사이 history(assistant/user 혼재) — 오래된 순부터 드랍한다.
 *
 * 시스템+최신 user 의 토큰 합이 예산을 초과하면 `OverBudgetError` 를 던진다 —
 * 호출자는 (a) 시스템 프롬프트 축약(applySoftDegrade) 또는 (b) 모델 교체로 처리.
 */
function truncateToBudget(
  messages: readonly BudgetMessage[],
  options: TruncateOptions,
): TruncateResult {
  const reserved = options.reservedOutputTokens ?? Math.floor(options.modelLimit * 0.1);
  const budget = Math.max(0, options.modelLimit - reserved);

  const systems = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  let lastUserIdx = -1;
  for (let i = nonSystem.length - 1; i >= 0; i -= 1) {
    if (nonSystem[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) {
    throw new Error('truncateToBudget: 마지막 user 메시지가 필요합니다');
  }
  const latestUser = nonSystem[lastUserIdx];
  const middle = nonSystem.slice(0, lastUserIdx); // 최신 user 직전까지의 history
  const tail = nonSystem.slice(lastUserIdx + 1); // 최신 user 이후 assistant 등(보존)

  const sumTokens = (arr: readonly BudgetMessage[]) => arr.reduce((a, m) => a + Math.max(0, m.tokens | 0), 0);
  const fixedTokens = sumTokens(systems) + latestUser.tokens + sumTokens(tail);
  if (fixedTokens > budget) {
    throw new OverBudgetError(fixedTokens, budget);
  }

  // 가장 오래된(앞쪽) middle 부터 드랍.
  let kept = middle.slice();
  let droppedCount = 0;
  while (sumTokens(kept) + fixedTokens > budget && kept.length > 0) {
    kept.shift();
    droppedCount += 1;
  }

  const finalMessages = [...systems, ...kept, latestUser, ...tail];
  return {
    messages: finalMessages,
    droppedCount,
    totalTokens: sumTokens(finalMessages),
    budgetTokens: budget,
    preservedSystemPrompt: systems.length > 0,
    preservedLatestUser: true,
  };
}

const MODEL_TOKEN_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  'llama3:8b': 8_192,
  'qwen2.5:7b': 32_768,
  'mistral:7b': 8_192,
});

// ────────────────────────────────────────────────────────────────────────────
// T5. truncateToBudget — 시스템 프롬프트·최신 사용자 입력 보존 계약
// ────────────────────────────────────────────────────────────────────────────

test('T5-1. 예산 미만 — 입력 그대로 통과, 드랍 0', () => {
  const messages: BudgetMessage[] = [
    { role: 'system', content: '시스템', tokens: 100 },
    { role: 'user', content: 'q1', tokens: 50 },
    { role: 'assistant', content: 'a1', tokens: 80 },
    { role: 'user', content: 'q2', tokens: 30 },
  ];
  const r = truncateToBudget(messages, { modelLimit: 8_192, reservedOutputTokens: 1_024 });
  assert.equal(r.droppedCount, 0);
  assert.equal(r.messages.length, messages.length);
  assert.equal(r.preservedSystemPrompt, true);
  assert.equal(r.preservedLatestUser, true);
  assert.equal(r.budgetTokens, 8_192 - 1_024);
});

test('T5-2. 한도 초과 — 가장 오래된 history 부터 드랍, 시스템·최신 user 는 보존', () => {
  const messages: BudgetMessage[] = [
    { role: 'system', content: '시스템 프롬프트(중요)', tokens: 1_000 },
    { role: 'user', content: 'oldest q', tokens: 1_500 }, // 드랍 1순위
    { role: 'assistant', content: 'oldest a', tokens: 1_500 }, // 드랍 2순위
    { role: 'user', content: 'mid q', tokens: 1_500 },
    { role: 'assistant', content: 'mid a', tokens: 1_500 },
    { role: 'user', content: 'latest q (보존)', tokens: 1_000 },
  ];
  // 합 8000, 한도 6000(예산 5400 reserved 600)
  const r = truncateToBudget(messages, { modelLimit: 6_000, reservedOutputTokens: 600 });
  assert.ok(r.totalTokens <= r.budgetTokens, `총합 ${r.totalTokens} ≤ 예산 ${r.budgetTokens}`);
  assert.ok(r.droppedCount > 0, `드랍 발생 — 실제 ${r.droppedCount}`);
  assert.equal(r.messages[0].content, '시스템 프롬프트(중요)', '시스템 메시지가 항상 첫 자리');
  assert.equal(r.messages[r.messages.length - 1].content, 'latest q (보존)', '최신 user 가 마지막');
  assert.equal(r.preservedSystemPrompt, true);
  assert.equal(r.preservedLatestUser, true);
});

test('T5-3. 시스템+최신 user 만으로도 예산 초과 → OverBudgetError', () => {
  const messages: BudgetMessage[] = [
    { role: 'system', content: '거대 시스템', tokens: 6_000 },
    { role: 'user', content: '거대 user', tokens: 4_000 },
  ];
  assert.throws(
    () => truncateToBudget(messages, { modelLimit: 8_192, reservedOutputTokens: 1_024 }),
    (err: unknown) => err instanceof OverBudgetError && err.required === 10_000 && err.budget === 7_168,
  );
});

test('T5-4. 시스템 메시지가 여러 개여도 모두 보존된다(누적 직렬화)', () => {
  const messages: BudgetMessage[] = [
    { role: 'system', content: '시스템1', tokens: 500 },
    { role: 'system', content: '시스템2(코드 컨벤션)', tokens: 500 },
    { role: 'user', content: 'old q', tokens: 1_000 },
    { role: 'assistant', content: 'old a', tokens: 1_000 },
    { role: 'user', content: 'now', tokens: 200 },
  ];
  const r = truncateToBudget(messages, { modelLimit: 2_000, reservedOutputTokens: 0 });
  // 시스템 두 개 + 최신 user = 1200 토큰 → history(2000) 전체 드랍 필요
  assert.equal(r.droppedCount, 2);
  assert.equal(r.messages.filter((m) => m.role === 'system').length, 2, '시스템 2개 모두 보존');
  assert.equal(r.messages[r.messages.length - 1].content, 'now');
});

test('T5-5. 마지막 user 가 없으면 즉시 throw — 호출 계약 위반 가드', () => {
  const messages: BudgetMessage[] = [
    { role: 'system', content: '시스템', tokens: 100 },
    { role: 'assistant', content: 'a', tokens: 50 },
  ];
  assert.throws(
    () => truncateToBudget(messages, { modelLimit: 8_192 }),
    /마지막 user 메시지/,
  );
});

test('T5-6. reservedOutputTokens 미지정 → 모델 한도의 10% 가 자동 예약', () => {
  const messages: BudgetMessage[] = [
    { role: 'system', content: 's', tokens: 10 },
    { role: 'user', content: 'u', tokens: 10 },
  ];
  const r = truncateToBudget(messages, { modelLimit: 1_000 });
  assert.equal(r.budgetTokens, 900, '1_000 - floor(1_000·0.1) = 900');
});

// 모델별 한도 매트릭스 — 같은 입력을 세 모델에 적용해 보존/드랍 결과의 일관성을 잠근다.
for (const [model, limit] of Object.entries(MODEL_TOKEN_LIMITS)) {
  test(`T5-7[${model}]. 한도 ${limit} — 시스템·최신 user 항상 보존, history 만 드랍 후보`, () => {
    // 의도적으로 모든 모델에서 한도를 넘기는 상황을 만든다(40_000 토큰 history).
    const heavy = Array.from({ length: 40 }, (_, i): BudgetMessage => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
      tokens: 1_000,
    }));
    const messages: BudgetMessage[] = [
      { role: 'system', content: `시스템(${model})`, tokens: 200 },
      ...heavy,
      { role: 'user', content: '최신 질문', tokens: 100 },
    ];
    const r = truncateToBudget(messages, { modelLimit: limit });
    assert.ok(r.totalTokens <= r.budgetTokens, `${model}: 총합 ${r.totalTokens} ≤ 예산 ${r.budgetTokens}`);
    assert.equal(r.messages[0].role, 'system', `${model}: 시스템 첫 자리`);
    assert.equal(r.messages[0].content, `시스템(${model})`);
    assert.equal(r.messages[r.messages.length - 1].content, '최신 질문', `${model}: 최신 user 마지막`);
    // 한도가 가장 큰 qwen2.5:7b 도 40_000 history 는 모두 못 담는다.
    assert.ok(r.droppedCount > 0, `${model}: 적어도 한 건은 드랍`);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// T6. 스트리밍 watchdog — 90% 임계 조기 종료
// ────────────────────────────────────────────────────────────────────────────
//
// 호출자는 토큰이 스트림될 때마다 `observe(delta)` 를 부른다. 누적 토큰이
// modelLimit · 0.9 에 도달하면 watchdog 이 조기 종료를 발화한다(아래 onAbort).
// 한 번 발화하면 멱등(idempotent) — 후속 observe 는 추가 발화 없이 무시.

interface WatchdogOptions {
  readonly ratio?: number;
  readonly onAbort?: (info: { tokensSeen: number; threshold: number }) => void;
}

interface StreamingWatchdog {
  readonly threshold: number;
  observe(deltaTokens: number): void;
  isAborted(): boolean;
  cumulative(): number;
}

function createStreamingWatchdog(modelLimit: number, opts: WatchdogOptions = {}): StreamingWatchdog {
  const ratio = opts.ratio ?? 0.9;
  const threshold = Math.floor(Math.max(0, modelLimit) * ratio);
  let cumulative = 0;
  let aborted = false;
  return {
    threshold,
    observe(delta: number) {
      if (aborted) return;
      cumulative += Math.max(0, delta | 0);
      if (cumulative >= threshold) {
        aborted = true;
        opts.onAbort?.({ tokensSeen: cumulative, threshold });
      }
    },
    isAborted() { return aborted; },
    cumulative() { return cumulative; },
  };
}

test('T6-1. 임계 미만 — 발화 없음(누적만 갱신)', () => {
  let abortCount = 0;
  const wd = createStreamingWatchdog(1_000, { onAbort: () => { abortCount += 1; } });
  assert.equal(wd.threshold, 900);
  wd.observe(100);
  wd.observe(200);
  wd.observe(599); // 누적 899 — 임계 직전
  assert.equal(wd.isAborted(), false);
  assert.equal(wd.cumulative(), 899);
  assert.equal(abortCount, 0);
});

test('T6-2. 임계 정확 도달 — onAbort 1회 발화 + isAborted=true', () => {
  let info: { tokensSeen: number; threshold: number } | null = null;
  const wd = createStreamingWatchdog(1_000, { onAbort: (i) => { info = i; } });
  wd.observe(900);
  assert.equal(wd.isAborted(), true);
  assert.deepEqual(info, { tokensSeen: 900, threshold: 900 });
});

test('T6-3. 임계 초과 후 추가 observe — 멱등(추가 발화 없음)', () => {
  let abortCount = 0;
  const wd = createStreamingWatchdog(1_000, { onAbort: () => { abortCount += 1; } });
  wd.observe(950);
  assert.equal(abortCount, 1);
  wd.observe(100); // 무시되어야 한다 — 이미 종료됨
  wd.observe(500);
  assert.equal(abortCount, 1, '발화는 정확히 1회');
  assert.equal(wd.cumulative(), 950, '발화 이후 누적 갱신 중지');
});

test('T6-4. 커스텀 ratio — 50% 임계로도 동작', () => {
  const wd = createStreamingWatchdog(2_000, { ratio: 0.5 });
  assert.equal(wd.threshold, 1_000);
  wd.observe(999);
  assert.equal(wd.isAborted(), false);
  wd.observe(1);
  assert.equal(wd.isAborted(), true);
});

test('T6-5. 음수/0 delta 는 무시(잡음 방지)', () => {
  const wd = createStreamingWatchdog(1_000);
  wd.observe(-500);
  wd.observe(0);
  assert.equal(wd.cumulative(), 0);
  assert.equal(wd.isAborted(), false);
});

// 모델별 90% 임계 매트릭스 — 회귀 시 어느 모델이 어긋나는지 즉시 식별.
for (const [model, limit] of Object.entries(MODEL_TOKEN_LIMITS)) {
  test(`T6-6[${model}]. 90% 임계 = floor(${limit}·0.9) = ${Math.floor(limit * 0.9)}`, () => {
    const wd = createStreamingWatchdog(limit);
    assert.equal(wd.threshold, Math.floor(limit * 0.9), `${model} threshold`);
    wd.observe(wd.threshold - 1);
    assert.equal(wd.isAborted(), false, `${model}: 임계 직전 미발화`);
    wd.observe(1);
    assert.equal(wd.isAborted(), true, `${model}: 임계 도달 발화`);
  });
}
