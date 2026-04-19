// Run with: npx tsx --test tests/claudeTokenUsageStore.regression.test.ts
//
// QA: Claude 토큰 사용량 스토어 순수 함수 계약 회귀 테스트.
//  - mergeUsage: delta 누적·음수/NaN 방어·모델별 브레이크다운
//  - estimateCostUsd: 모델 접두 매칭·미지 모델 보수 폴백
//  - cacheHitRate: 분모 0 방어·비율 정확성
//
// 모듈 레벨 싱글톤 상태는 본 테스트에서 직접 다루지 않고, 순수 함수만 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TOTALS,
  mergeUsage,
  estimateCostUsd,
  cacheHitRate,
} from '../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../src/types.ts';

function usage(partial: Partial<ClaudeTokenUsage>): ClaudeTokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...partial,
  };
}

test('EMPTY_TOTALS 는 모든 수치 0·callCount 0·빈 byModel 을 돌려준다', () => {
  assert.equal(EMPTY_TOTALS.inputTokens, 0);
  assert.equal(EMPTY_TOTALS.outputTokens, 0);
  assert.equal(EMPTY_TOTALS.cacheReadTokens, 0);
  assert.equal(EMPTY_TOTALS.cacheCreationTokens, 0);
  assert.equal(EMPTY_TOTALS.callCount, 0);
  assert.equal(EMPTY_TOTALS.estimatedCostUsd, 0);
  assert.deepEqual(EMPTY_TOTALS.byModel, {});
});

test('mergeUsage 는 단일 호출의 네 필드를 모두 누적한다', () => {
  const next = mergeUsage(EMPTY_TOTALS, usage({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
    model: 'claude-sonnet-4-6',
  }));
  assert.equal(next.inputTokens, 100);
  assert.equal(next.outputTokens, 50);
  assert.equal(next.cacheReadTokens, 20);
  assert.equal(next.cacheCreationTokens, 10);
  assert.equal(next.callCount, 1);
  assert.ok(next.estimatedCostUsd > 0, '비용은 양수여야 한다');
  assert.ok(next.byModel['claude-sonnet-4-6'], '모델별 브레이크다운에 키가 추가되어야 한다');
  assert.equal(next.byModel['claude-sonnet-4-6'].callCount, 1);
});

test('mergeUsage 는 여러 호출을 숫자·호출 횟수·모델별로 모두 더한다', () => {
  let t = EMPTY_TOTALS;
  t = mergeUsage(t, usage({ input_tokens: 100, output_tokens: 50, model: 'claude-sonnet-4-6' }));
  t = mergeUsage(t, usage({ input_tokens: 200, output_tokens: 80, model: 'claude-sonnet-4-6' }));
  t = mergeUsage(t, usage({ input_tokens: 10, output_tokens: 5, model: 'claude-opus-4-7' }));
  assert.equal(t.inputTokens, 310);
  assert.equal(t.outputTokens, 135);
  assert.equal(t.callCount, 3);
  assert.equal(t.byModel['claude-sonnet-4-6'].inputTokens, 300);
  assert.equal(t.byModel['claude-sonnet-4-6'].outputTokens, 130);
  assert.equal(t.byModel['claude-sonnet-4-6'].callCount, 2);
  assert.equal(t.byModel['claude-opus-4-7'].inputTokens, 10);
  assert.equal(t.byModel['claude-opus-4-7'].callCount, 1);
});

test('mergeUsage 는 음수·NaN·undefined 필드를 0 으로 클램프한다', () => {
  // 방어 동작을 검증하기 위해 의도적으로 잘못된 값을 주입한다.
  const bad = { input_tokens: -50, output_tokens: Number.NaN, cache_read_input_tokens: undefined, cache_creation_input_tokens: -10 } as unknown as ClaudeTokenUsage;
  const next = mergeUsage(EMPTY_TOTALS, bad);
  assert.equal(next.inputTokens, 0);
  assert.equal(next.outputTokens, 0);
  assert.equal(next.cacheReadTokens, 0);
  assert.equal(next.cacheCreationTokens, 0);
  assert.equal(next.callCount, 1, '잘못된 값이어도 호출 자체는 카운트된다(드라이런 방지)');
});

test('mergeUsage 의 반환은 입력 totals 를 mutate 하지 않는다', () => {
  const base = mergeUsage(EMPTY_TOTALS, usage({ input_tokens: 100, model: 'claude-sonnet-4-6' }));
  const snapshot = JSON.parse(JSON.stringify(base));
  const next = mergeUsage(base, usage({ input_tokens: 200, model: 'claude-sonnet-4-6' }));
  assert.notEqual(next, base, '새 객체가 반환되어야 한다');
  assert.deepEqual(base, snapshot, '원본 totals 가 변경되면 상태 예측이 깨진다');
});

test('estimateCostUsd 는 모델 접두 매칭으로 단가를 선택한다 (opus > sonnet > haiku)', () => {
  const opusCost = estimateCostUsd(usage({ input_tokens: 1_000_000, model: 'claude-opus-4-7' }));
  const sonnetCost = estimateCostUsd(usage({ input_tokens: 1_000_000, model: 'claude-sonnet-4-6' }));
  const haikuCost = estimateCostUsd(usage({ input_tokens: 1_000_000, model: 'claude-haiku-4-5' }));
  assert.ok(opusCost > sonnetCost, 'opus 는 sonnet 보다 비싸야 한다');
  assert.ok(sonnetCost > haikuCost, 'sonnet 은 haiku 보다 비싸야 한다');
});

test('estimateCostUsd 는 미지 모델에 대해 보수적 폴백(=Sonnet 단가) 을 적용한다', () => {
  const unknown = estimateCostUsd(usage({ input_tokens: 1_000_000, model: 'claude-future-99' }));
  const sonnet = estimateCostUsd(usage({ input_tokens: 1_000_000, model: 'claude-sonnet-4-6' }));
  assert.equal(unknown, sonnet, '미지 claude-* 모델은 sonnet 단가로 폴백');
});

test('estimateCostUsd 는 캐시 읽기·쓰기 단가를 각각 반영한다', () => {
  const readOnly = estimateCostUsd(usage({ cache_read_input_tokens: 1_000_000, model: 'claude-sonnet-4-6' }));
  const writeOnly = estimateCostUsd(usage({ cache_creation_input_tokens: 1_000_000, model: 'claude-sonnet-4-6' }));
  assert.ok(writeOnly > readOnly, '캐시 쓰기(1회 비용) 가 읽기(할인) 보다 비싸야 한다');
});

test('cacheHitRate 는 cache_read / (cache_read + input) 공식을 돌려준다', () => {
  const totals: ClaudeTokenUsageTotals = {
    inputTokens: 100,
    outputTokens: 0,
    cacheReadTokens: 300,
    cacheCreationTokens: 0,
    callCount: 1,
    estimatedCostUsd: 0,
    byModel: {},
    updatedAt: new Date(0).toISOString(),
  };
  assert.equal(cacheHitRate(totals), 0.75);
});

test('cacheHitRate 는 분모가 0 이면 0 을 돌려준다', () => {
  assert.equal(cacheHitRate(EMPTY_TOTALS), 0);
});

test('mergeUsage 는 model 미상 호출을 "알 수 없음" 버킷에 넣는다', () => {
  const t = mergeUsage(EMPTY_TOTALS, usage({ input_tokens: 10 }));
  assert.ok(t.byModel['알 수 없음']);
  assert.equal(t.byModel['알 수 없음'].inputTokens, 10);
});
