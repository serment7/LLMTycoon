// Run with: npx tsx --test tests/token-budget/cacheHitRate.longSession.spec.ts
//
// 지시 #1d6c9ff4 (QA) · 토큰 절약 전략 회귀 — 프롬프트 캐시 적중률.
//
// 장시간 세션(≥ 50 턴) 에서 프롬프트 캐시가 의도대로 누적·재사용되는지
// mergeUsage · cacheHitRate 계약 수준에서 잠근다. 실제 Anthropic 호출은 하지
// 않고, 시뮬레이션한 usage 시퀀스로 총계 추이만 검증한다.
//
// 검증 축
//   A. 초기 웜업(최초 1~2턴) 에서는 cache_creation 비중이 크고, 이후 안정
//      구간에서는 cache_read 가 input 을 지배해 hit rate 가 상승한다.
//   B. 50턴 누적 후 cacheHitRate >= 0.80 (관측 목표치 하한).
//   C. 턴마다 delta 는 단조(monotonic) 누적이어야 한다 — 감소 관측 시 회귀.
//   D. cache_read 와 input 이 둘 다 0 인 경우(오프라인/차단) cacheHitRate 는 0.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TOTALS,
  mergeUsage,
  cacheHitRate,
} from '../../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../../src/types.ts';

function turn(n: number, phase: 'warmup' | 'steady'): ClaudeTokenUsage {
  if (phase === 'warmup') {
    return {
      input_tokens: 800,
      output_tokens: 400,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 4000,
      model: 'claude-opus-4-7',
      at: new Date(1700000000000 + n * 1000).toISOString(),
    };
  }
  return {
    input_tokens: 200,
    output_tokens: 400,
    cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 0,
    model: 'claude-opus-4-7',
    at: new Date(1700000000000 + n * 1000).toISOString(),
  };
}

test('A. 50턴 누적 — 캐시 적중률이 0.80 이상으로 수렴', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  for (let i = 0; i < 50; i++) {
    const phase = i < 2 ? 'warmup' : 'steady';
    totals = mergeUsage(totals, turn(i, phase));
  }
  const rate = cacheHitRate(totals);
  assert.ok(rate >= 0.80, `cacheHitRate expected ≥0.80, got ${rate.toFixed(3)}`);
  assert.equal(totals.callCount, 50);
});

test('B. 단조 누적 — cacheReadTokens·inputTokens 는 턴마다 절대 감소하지 않는다', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  let prevRead = 0;
  let prevInput = 0;
  for (let i = 0; i < 20; i++) {
    totals = mergeUsage(totals, turn(i, i < 2 ? 'warmup' : 'steady'));
    assert.ok(totals.cacheReadTokens >= prevRead, `turn ${i}: cacheReadTokens decreased`);
    assert.ok(totals.inputTokens >= prevInput, `turn ${i}: inputTokens decreased`);
    prevRead = totals.cacheReadTokens;
    prevInput = totals.inputTokens;
  }
});

test('C. 적중률 상승 추세 — 10턴 시점보다 50턴 시점이 더 높다', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  for (let i = 0; i < 10; i++) totals = mergeUsage(totals, turn(i, i < 2 ? 'warmup' : 'steady'));
  const at10 = cacheHitRate(totals);
  for (let i = 10; i < 50; i++) totals = mergeUsage(totals, turn(i, 'steady'));
  const at50 = cacheHitRate(totals);
  assert.ok(at50 > at10, `캐시 적중률은 세션이 길어질수록 높아져야 한다 — 10턴 ${at10.toFixed(3)} vs 50턴 ${at50.toFixed(3)}`);
});

test('D. 오프라인/차단 — cache_read 0 · input 0 상태에서 적중률 0', () => {
  const blank: ClaudeTokenUsageTotals = {
    ...EMPTY_TOTALS,
    byModel: {},
    errors: EMPTY_TOTALS.errors,
    inputTokens: 0,
    cacheReadTokens: 0,
  };
  assert.equal(cacheHitRate(blank), 0);
});

test('E. 웜업 전용 시퀀스 — 적중률이 명확히 낮다(<0.2)', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  for (let i = 0; i < 3; i++) totals = mergeUsage(totals, turn(i, 'warmup'));
  const rate = cacheHitRate(totals);
  assert.ok(rate < 0.2, `웜업 구간에서 cache_read 가 거의 없어야 — got ${rate.toFixed(3)}`);
});
