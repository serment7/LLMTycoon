// Run with: npx tsx --test tests/claudeTokenUsageWeekErrors.regression.test.ts
//
// QA: 지시 #af3c8877 — `aggregateWeek` / `selectRange('week')` / `buildExportRows('week')`
// 합계 행이 errors 카운터를 **합산** 해야 한다는 계약을 잠근다. 이전 구현은
// `addTotals` 가 errors 를 놓쳐 week 합계의 모든 err_* 가 0 으로 고정되던 버그가 있었다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TOTALS,
  emptyErrorCounters,
  applyDeltaToState,
  recordErrorInState,
  selectRange,
  type TokenUsageStoreState,
} from '../src/utils/claudeTokenUsageStore.ts';
import { buildExportRows } from '../src/utils/claudeTokenUsageExport.ts';
import type { ClaudeTokenUsage } from '../src/types.ts';

function makeEmpty(date = '2026-04-19'): TokenUsageStoreState {
  return {
    all: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: date,
    history: [],
    loadError: null,
  };
}

const USAGE: ClaudeTokenUsage = {
  input_tokens: 10, output_tokens: 5,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  model: 'claude-sonnet-4-6',
};

test('selectRange(week) — today 에만 있는 에러가 week 합계에 반영된다', () => {
  let s = makeEmpty('2026-04-19');
  s = recordErrorInState(s, 'rate_limit', new Date(2026, 3, 19, 10));
  s = recordErrorInState(s, 'timeout', new Date(2026, 3, 19, 11));
  const weekly = selectRange(s, 'week');
  assert.ok(weekly.errors, 'week 합계에 errors 필드가 존재해야 한다');
  assert.equal(weekly.errors!.rate_limit, 1);
  assert.equal(weekly.errors!.timeout, 1);
});

test('selectRange(week) — today + history 양쪽 에러가 합산된다', () => {
  let s = makeEmpty('2026-04-13');
  // 2026-04-13 ~ 2026-04-19 동안 매일 다른 에러 기록
  for (let d = 13; d <= 19; d++) {
    s = applyDeltaToState(s, USAGE, new Date(2026, 3, d, 10));
    s = recordErrorInState(s, 'rate_limit', new Date(2026, 3, d, 11));
    if (d % 2 === 0) s = recordErrorInState(s, 'timeout', new Date(2026, 3, d, 12));
  }
  const weekly = selectRange(s, 'week');
  assert.ok(weekly.errors);
  // rate_limit 은 7일 모두 — 단, week 집계는 today(1) + history[0..6-1] 이므로 6 + today = 7
  assert.equal(weekly.errors!.rate_limit, 7);
  // timeout 은 짝수일 — 14,16,18 = 3일
  assert.equal(weekly.errors!.timeout, 3);
});

test('buildExportRows(week) — 합계 행의 err_* 컬럼이 실제 합산값을 가진다', () => {
  let s = makeEmpty('2026-04-13');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 13, 10));
  s = recordErrorInState(s, 'auth', new Date(2026, 3, 13, 11));
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 14, 10));
  s = recordErrorInState(s, 'auth', new Date(2026, 3, 14, 11));
  s = recordErrorInState(s, 'network', new Date(2026, 3, 14, 12));
  const rows = buildExportRows(s, 'week');
  const summary = rows[rows.length - 1];
  assert.equal(summary.date, '합계');
  assert.equal(summary.err_auth, 2, '버그 이전에는 0 으로 고정되던 값');
  assert.equal(summary.err_network, 1);
  assert.equal(summary.err_rate_limit, 0);
});

test('buildExportRows(week) — 일별 행은 이전부터 올바르게 errors 가 찍혀 있었다(회귀 유지)', () => {
  let s = makeEmpty('2026-04-13');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 13, 10));
  s = recordErrorInState(s, 'bad_request', new Date(2026, 3, 13, 11));
  const rows = buildExportRows(s, 'week');
  // 첫 행은 오늘(2026-04-13), 에러 반영
  const todayRow = rows.find(r => r.date === '2026-04-13');
  assert.ok(todayRow, '오늘 날짜 행이 있어야 한다');
  assert.equal(todayRow!.err_bad_request, 1);
});

test('selectRange(today) 와 selectRange(all) 은 기존처럼 errors 를 그대로 반환한다(회귀 유지)', () => {
  let s = makeEmpty('2026-04-19');
  s = recordErrorInState(s, 'overloaded', new Date(2026, 3, 19, 10));
  assert.equal(selectRange(s, 'today').errors?.overloaded, 1);
  assert.equal(selectRange(s, 'all').errors?.overloaded, 1);
});

test('addTotals 합산 순서 무관 — a+b 와 b+a 결과 errors 가 동일', () => {
  // aggregateWeek 내부적으로 누적식이므로 순서 무관성이 중요한 불변이다.
  let s1 = makeEmpty('2026-04-19');
  s1 = recordErrorInState(s1, 'rate_limit', new Date(2026, 3, 19, 10));
  s1 = recordErrorInState(s1, 'network', new Date(2026, 3, 19, 11));
  const weekly1 = selectRange(s1, 'week');

  let s2 = makeEmpty('2026-04-19');
  s2 = recordErrorInState(s2, 'network', new Date(2026, 3, 19, 11));
  s2 = recordErrorInState(s2, 'rate_limit', new Date(2026, 3, 19, 10));
  const weekly2 = selectRange(s2, 'week');

  assert.deepEqual(weekly1.errors, weekly2.errors);
});
