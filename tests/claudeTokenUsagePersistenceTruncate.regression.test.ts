// Run with: npx tsx --test tests/claudeTokenUsagePersistenceTruncate.regression.test.ts
//
// QA: 지시 #44d297cc — `truncateByModelForQuota` 순수 함수 회귀.
// saveToStorage 의 쿼터 초과 폴백 경로(실제 DOM 쓰기) 는 JSDOM 이 없는 현 노드
// 환경에서 직접 실행되지 않으므로 본 파일은 순수 함수 축만 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TOTALS,
  emptyErrorCounters,
  truncateByModelForQuota,
  type TokenUsageStoreState,
} from '../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsageTotals } from '../src/types.ts';

function modelEntry(costUsd: number, calls = 1): ClaudeTokenUsageTotals['byModel'][string] {
  return {
    inputTokens: 100 * calls,
    outputTokens: 50 * calls,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    callCount: calls,
    estimatedCostUsd: costUsd,
  };
}

function makeState(byModel: ClaudeTokenUsageTotals['byModel']): TokenUsageStoreState {
  const total: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel, errors: emptyErrorCounters() };
  return {
    all: total,
    today: total,
    todayDate: '2026-04-19',
    history: [],
    loadError: null,
  };
}

test('byModel 엔트리가 topN 이하면 원본을 그대로 돌려준다', () => {
  const state = makeState({
    'claude-sonnet-4-6': modelEntry(1.2),
    'claude-opus-4-7': modelEntry(5.5),
  });
  const out = truncateByModelForQuota(state, 5);
  assert.deepEqual(out.all.byModel, state.all.byModel);
});

test('topN 상위 엔트리만 유지하고 나머지는 "기타" 로 합산된다', () => {
  const state = makeState({
    'm-a': modelEntry(1.0, 1),
    'm-b': modelEntry(2.0, 2),
    'm-c': modelEntry(0.5, 3),
    'm-d': modelEntry(0.1, 4),
    'm-e': modelEntry(0.3, 5),
  });
  const out = truncateByModelForQuota(state, 2);
  const keys = Object.keys(out.all.byModel).sort();
  assert.deepEqual(keys, ['m-a', 'm-b', '기타'].sort());
  // 상위 2: m-b(2.0) · m-a(1.0). 나머지 3: m-c(0.5) + m-d(0.1) + m-e(0.3) = 0.9
  assert.equal(out.all.byModel['기타'].estimatedCostUsd, 0.9);
  // callCount 도 보존: 3+4+5 = 12
  assert.equal(out.all.byModel['기타'].callCount, 12);
});

test('이미 "기타" 키가 상위에 있으면 tail 합산이 누적된다', () => {
  const state = makeState({
    'm-a': modelEntry(10),
    '기타': modelEntry(5, 2),
    'm-c': modelEntry(0.3),
    'm-d': modelEntry(0.2),
  });
  const out = truncateByModelForQuota(state, 2);
  // 상위 2 는 m-a(10), 기타(5). tail 은 m-c + m-d = 0.5, callCount = 2
  assert.equal(Object.keys(out.all.byModel).length, 2);
  const etc = out.all.byModel['기타'];
  assert.equal(etc.estimatedCostUsd, 5 + 0.5, '기존 기타 + tail 합산');
  assert.equal(etc.callCount, 2 + 2, 'callCount 도 누적');
});

test('동일 비용이면 호출 횟수 내림차순으로 안정적 정렬된다', () => {
  const state = makeState({
    'm-a': modelEntry(1.0, 1),
    'm-b': modelEntry(1.0, 5),
    'm-c': modelEntry(1.0, 3),
  });
  const out = truncateByModelForQuota(state, 1);
  assert.ok(out.all.byModel['m-b'], 'callCount 가 가장 큰 m-b 가 상위에 남아야 한다');
});

test('topN=0 이면 모든 엔트리가 "기타" 로 합쳐진다', () => {
  const state = makeState({
    'm-a': modelEntry(1),
    'm-b': modelEntry(2),
  });
  const out = truncateByModelForQuota(state, 0);
  assert.deepEqual(Object.keys(out.all.byModel), ['기타']);
  assert.equal(out.all.byModel['기타'].estimatedCostUsd, 3);
});

test('topN 음수/비유한 수이면 원본을 그대로 돌려준다(안전 폴백)', () => {
  const state = makeState({ 'm-a': modelEntry(1), 'm-b': modelEntry(2) });
  assert.equal(truncateByModelForQuota(state, -1), state);
  assert.equal(truncateByModelForQuota(state, Number.NaN), state);
});

test('history 엔트리에도 동일한 truncate 가 적용된다', () => {
  const total = (m: ClaudeTokenUsageTotals['byModel']): ClaudeTokenUsageTotals =>
    ({ ...EMPTY_TOTALS, byModel: m, errors: emptyErrorCounters() });
  const state: TokenUsageStoreState = {
    all: total({ 'm-a': modelEntry(1) }),
    today: total({ 'm-a': modelEntry(1) }),
    todayDate: '2026-04-19',
    history: [
      { date: '2026-04-18', totals: total({ 'x': modelEntry(5), 'y': modelEntry(4), 'z': modelEntry(3) }) },
    ],
    loadError: null,
  };
  const out = truncateByModelForQuota(state, 1);
  assert.equal(Object.keys(out.history[0].totals.byModel).length, 2, 'history 도 상위1 + 기타 구조');
  assert.ok(out.history[0].totals.byModel['x']);
  assert.ok(out.history[0].totals.byModel['기타']);
});
