// Run with: npx tsx --test tests/token-budget/contextCompression.spec.ts
//
// 지시 #1d6c9ff4 (QA) · 토큰 절약 전략 회귀 — 컨텍스트 압축(컴팩션).
//
// 장시간 세션은 주기적으로 대화 기록을 요약해 "압축" 한다. 압축 전후에
// mergeUsage 로 누적되는 총계가 아래 회귀 축을 만족해야 한다.
//
// 검증 축
//   A. 압축 직전 큰 input 스파이크가 와도 총계는 연속 누적(감소 금지).
//   B. 압축 직후 input_tokens 가 급감하면, 신규 턴의 cache_creation 이 한 번 튀고
//      그 다음 턴부터 다시 cache_read 가 지배한다 — 재웜업 패턴.
//   C. 압축 시점의 usage 스냅샷은 callCount 를 1만큼만 증가시킨다(중복 가산 금지).
//   D. 총계의 updatedAt 은 마지막 usage.at 을 반영한다(캐시 시점 역행 금지).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TOTALS,
  mergeUsage,
  cacheHitRate,
} from '../../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../../src/types.ts';

function u(partial: Partial<ClaudeTokenUsage>, atMs?: number): ClaudeTokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model: 'claude-sonnet-4-6',
    at: atMs !== undefined ? new Date(atMs).toISOString() : undefined,
    ...partial,
  };
}

test('A. 압축 직전 input 스파이크 → 총계 단조 누적 보장', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  totals = mergeUsage(totals, u({ input_tokens: 1_000, cache_read_input_tokens: 8_000 }));
  const midInput = totals.inputTokens;
  // 스파이크 턴(압축 직전).
  totals = mergeUsage(totals, u({ input_tokens: 20_000, cache_read_input_tokens: 2_000 }));
  assert.ok(totals.inputTokens >= midInput + 20_000 - 1, 'spike delta 누락');
});

test('B. 압축 후 재웜업 — cache_creation 1회 증가 후 read 지배로 복귀', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  // 안정 구간 5턴.
  for (let i = 0; i < 5; i++) {
    totals = mergeUsage(totals, u({ input_tokens: 200, cache_read_input_tokens: 4_000, output_tokens: 300 }));
  }
  const steadyRate = cacheHitRate(totals);
  const createBefore = totals.cacheCreationTokens;

  // 압축 시점 — cache_creation 스파이크 1회.
  totals = mergeUsage(totals, u({ input_tokens: 600, cache_creation_input_tokens: 3_000, output_tokens: 400 }));
  assert.equal(totals.cacheCreationTokens, createBefore + 3_000);

  // 재안정 5턴.
  for (let i = 0; i < 5; i++) {
    totals = mergeUsage(totals, u({ input_tokens: 200, cache_read_input_tokens: 4_000, output_tokens: 300 }));
  }
  const finalRate = cacheHitRate(totals);
  assert.ok(finalRate >= steadyRate * 0.9,
    `재웜업 후 적중률 재안정 필요 — steady ${steadyRate.toFixed(3)} vs final ${finalRate.toFixed(3)}`);
});

test('C. 압축 스냅샷 usage 는 callCount 를 정확히 +1 증가시킨다(중복 가산 금지)', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  const before = totals.callCount;
  totals = mergeUsage(totals, u({ input_tokens: 500, cache_creation_input_tokens: 3_000 }));
  assert.equal(totals.callCount, before + 1);
});

test('D. updatedAt 은 마지막 usage.at 을 반영하고 이전 시각으로 되돌아가지 않는다', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  totals = mergeUsage(totals, u({ input_tokens: 100 }, 1_700_000_000_000));
  const first = totals.updatedAt;
  totals = mergeUsage(totals, u({ input_tokens: 100 }, 1_700_000_010_000));
  assert.ok(totals.updatedAt > first, `updatedAt 은 전진해야 — first=${first} second=${totals.updatedAt}`);
});

test('E. 압축 누락 시나리오 — input 이 60k 이상으로 누적되면 경고 임계(회귀 감지용 anchor)', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  for (let i = 0; i < 30; i++) {
    totals = mergeUsage(totals, u({ input_tokens: 2_500 }));
  }
  // 현재 설계상 압축 트리거는 상위(claudeClient) 에서 결정 — 본 테스트는 "총계가
  // 이 정도로 커지는 시퀀스가 실제 관측될 수 있다" 는 사실을 anchor 로 고정한다.
  assert.ok(totals.inputTokens >= 60_000, 'input 누적이 60k 이상이어야 — 압축 미호출 회귀 감시 기준점');
});
