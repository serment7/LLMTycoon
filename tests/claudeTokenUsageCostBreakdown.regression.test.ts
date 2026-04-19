// Run with: npx tsx --test tests/claudeTokenUsageCostBreakdown.regression.test.ts
//
// QA: 지시 #00919032 — `estimateCostBreakdownUsd` 축별 비용 분해 회귀.
// 기존 `estimateCostUsd` 는 total 과 동일해야 하며, 축별 값이 0 이하/비숫자에
// 대해 모두 0 으로 수렴하는지 · 모델별 단가가 정확히 반영되는지를 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateCostUsd,
  estimateCostBreakdownUsd,
} from '../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage } from '../src/types.ts';

function usage(patch: Partial<ClaudeTokenUsage>): ClaudeTokenUsage {
  return {
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    ...patch,
  };
}

test('네 축 모두 0 → 분해 결과 전부 0', () => {
  const b = estimateCostBreakdownUsd(usage({}));
  assert.equal(b.input, 0);
  assert.equal(b.output, 0);
  assert.equal(b.cacheRead, 0);
  assert.equal(b.cacheWrite, 0);
  assert.equal(b.total, 0);
});

test('sonnet 1M input → input 축 = $3, 다른 축 0', () => {
  const b = estimateCostBreakdownUsd(usage({ input_tokens: 1_000_000, model: 'claude-sonnet-4-6' }));
  assert.equal(b.input, 3);
  assert.equal(b.output, 0);
  assert.equal(b.cacheRead, 0);
  assert.equal(b.cacheWrite, 0);
  assert.equal(b.total, 3);
});

test('opus 모델 — 네 축 단가 매칭', () => {
  const b = estimateCostBreakdownUsd(usage({
    input_tokens: 1_000_000, output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
    model: 'claude-opus-4-7',
  }));
  assert.equal(b.input, 15);
  assert.equal(b.output, 75);
  assert.equal(b.cacheRead, 1.5);
  assert.equal(b.cacheWrite, 18.75);
  // 총합은 네 축의 합
  assert.equal(b.total, 15 + 75 + 1.5 + 18.75);
});

test('estimateCostUsd 와 estimateCostBreakdownUsd.total 은 정확히 동일', () => {
  const u = usage({
    input_tokens: 12_345, output_tokens: 6_789,
    cache_read_input_tokens: 500, cache_creation_input_tokens: 10,
    model: 'claude-sonnet-4-6',
  });
  assert.equal(estimateCostUsd(u), estimateCostBreakdownUsd(u).total);
});

test('음수·NaN·undefined 필드는 해당 축만 0 으로 정리되고 다른 축 계산은 유지', () => {
  // @ts-expect-error — 방어 동작 검증
  const b = estimateCostBreakdownUsd({
    input_tokens: -50,
    output_tokens: Number.NaN,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
    model: 'claude-sonnet-4-6',
  });
  assert.equal(b.input, 0);
  assert.equal(b.output, 0);
  assert.equal(b.cacheRead, 0);
  assert.equal(b.cacheWrite, 3.75, 'sonnet 의 cacheWrite 단가 매칭');
  assert.equal(b.total, 3.75);
});

test('미지 모델은 sonnet 단가로 폴백(보수적 과대계상)', () => {
  const unknown = estimateCostBreakdownUsd(usage({ input_tokens: 1_000_000, model: 'claude-future-99' }));
  const sonnet = estimateCostBreakdownUsd(usage({ input_tokens: 1_000_000, model: 'claude-sonnet-4-6' }));
  assert.deepEqual(unknown, sonnet);
});

test('반환 객체는 항상 5 개 필드를 포함한다(shape 계약)', () => {
  const b = estimateCostBreakdownUsd(usage({ input_tokens: 1, model: 'claude-haiku-4-5' }));
  assert.deepEqual(Object.keys(b).sort(), ['cacheRead', 'cacheWrite', 'input', 'output', 'total']);
});
