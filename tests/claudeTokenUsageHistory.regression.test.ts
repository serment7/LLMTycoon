// Run with: npx tsx --test tests/claudeTokenUsageHistory.regression.test.ts
//
// QA: 지시 #176df2b8 의 (3) '일/주/전체' 집계에 필요한 일별 history 축과
//   selectRange 순수 함수, 영속 v1 → v2 (history 포함) 왕복을 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TOTALS,
  applyDeltaToState,
  maybeRollOverDay,
  selectRange,
  serializePersistedTotals,
  deserializePersistedTotals,
  recordErrorInState,
  HISTORY_LIMIT,
  type TokenUsageStoreState,
} from '../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage } from '../src/types.ts';

function makeEmpty(date = '2026-04-19'): TokenUsageStoreState {
  return {
    all: { ...EMPTY_TOTALS, byModel: {} },
    today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: date,
    history: [],
    loadError: null,
  };
}

const USAGE: ClaudeTokenUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'claude-sonnet-4-6',
};

test('maybeRollOverDay — 이전 today 가 의미 있는 경우 history 맨 앞으로 push', () => {
  let s = makeEmpty('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  const rolled = maybeRollOverDay(s, new Date(2026, 3, 20, 9));
  assert.equal(rolled.history.length, 1);
  assert.equal(rolled.history[0].date, '2026-04-19');
  assert.equal(rolled.history[0].totals.inputTokens, 100);
  assert.equal(rolled.todayDate, '2026-04-20');
  assert.equal(rolled.today.callCount, 0);
});

test('maybeRollOverDay — 텅 빈 today 는 history 에 남기지 않는다', () => {
  const s = makeEmpty('2026-04-19');
  const rolled = maybeRollOverDay(s, new Date(2026, 3, 20, 0, 1));
  assert.equal(rolled.history.length, 0, '호출 0회 today 를 push 하면 엑셀 열에 빈 행이 생긴다');
});

test('maybeRollOverDay — 연속 롤오버 시 history 는 최대 HISTORY_LIMIT 으로 순환', () => {
  let s = makeEmpty('2026-04-01');
  const base = new Date(2026, 3, 1, 10);
  s = applyDeltaToState(s, USAGE, base);
  for (let d = 2; d <= 45; d++) {
    const day = new Date(2026, 3, d, 10);
    s = applyDeltaToState(s, USAGE, day); // applyDelta 내부가 롤오버 수행
  }
  assert.equal(s.history.length, HISTORY_LIMIT);
});

test('selectRange(today) — state.today 를 그대로 돌려준다', () => {
  let s = makeEmpty('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  assert.deepEqual(selectRange(s, 'today'), s.today);
});

test('selectRange(all) — state.all 을 그대로 돌려준다', () => {
  let s = makeEmpty('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  assert.deepEqual(selectRange(s, 'all'), s.all);
});

test('selectRange(week) — 오늘 + 최근 6일 history 의 합계를 돌려준다', () => {
  let s = makeEmpty('2026-04-13');
  // 13 → 19 까지 7일간 매일 usage 1건씩 누적 (2026-04-13 은 오늘 → 롤오버로 history 로 이동)
  for (let d = 13; d <= 19; d++) {
    s = applyDeltaToState(s, USAGE, new Date(2026, 3, d, 10));
  }
  const week = selectRange(s, 'week');
  // 최근 7일 전체: 오늘(19) + history 6건(14~18 + 13). history 는 최대 6개를 week 에 포함.
  assert.equal(week.callCount, 7);
  assert.equal(week.inputTokens, 700);
});

test('serialize → deserialize — v1 persisted 에 history 가 있어도 왕복 동등', () => {
  let s = makeEmpty('2026-04-13');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 13, 10));
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 14, 10));
  const json = JSON.stringify(serializePersistedTotals(s, '2026-04-14T11:00:00.000Z'));
  const back = deserializePersistedTotals(json, new Date(2026, 3, 14, 12));
  assert.ok(back);
  assert.equal(back!.history.length, 1);
  assert.equal(back!.history[0].date, '2026-04-13');
});

test('deserialize — 구 v1 저장본(history 누락) 은 history=[] 로 복원', () => {
  const legacy = JSON.stringify({
    schemaVersion: 1,
    all: { callCount: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 0.001, byModel: {}, updatedAt: '2026-04-19T10:00:00.000Z' },
    today: { callCount: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, estimatedCostUsd: 0.001, byModel: {}, updatedAt: '2026-04-19T10:00:00.000Z' },
    todayDate: '2026-04-19',
    savedAt: '2026-04-19T10:00:00.000Z',
  });
  const back = deserializePersistedTotals(legacy, new Date(2026, 3, 19, 11));
  assert.ok(back);
  assert.deepEqual(back!.history, []);
  assert.equal(back!.today.callCount, 1);
});

// ─── 지시 #59376fef 보강 ──────────────────────────────────────────────────────

test('maybeRollOverDay — 같은 날짜 재호출은 동일 참조 반환(idempotent, 불필요 리렌더 차단)', () => {
  let s = makeEmpty('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  // 동일 날짜(2026-04-19) 의 다른 시각을 두 번 연속 통과해도 state 객체는 교체되지 않는다.
  const a = maybeRollOverDay(s, new Date(2026, 3, 19, 11));
  const b = maybeRollOverDay(a, new Date(2026, 3, 19, 23, 59, 59));
  assert.strictEqual(a, s, '같은 날짜에서는 원본 그대로');
  assert.strictEqual(b, a, '연속 호출에서도 동일 참조');
});

test('selectRange(week) — history 가 비어 있을 때는 today 단독 값으로 수렴', () => {
  let s = makeEmpty('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  const week = selectRange(s, 'week');
  assert.equal(week.callCount, 1, 'history 0건이면 today 의 callCount 가 주간 합계');
  assert.equal(week.inputTokens, 100);
});

test('history 내부 totals 는 serialize → deserialize 왕복에서 errors 카운터를 보존한다', () => {
  // history 에 쌓인 이전 날짜 totals 의 errors 필드가 복원 중 사라지면 범위 집계나
  // 내보내기에서 해당 날짜 에러 통계가 유실된다. 자정 롤오버 + errors 누적 경로를
  // 함께 걸어 왕복을 확인한다.
  let s = makeEmpty('2026-04-18');
  // 2026-04-18 에 usage 1건 + network 에러 2건 누적.
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 18, 10));
  s = recordErrorInState(s, 'network', new Date(2026, 3, 18, 11));
  s = recordErrorInState(s, 'network', new Date(2026, 3, 18, 12));
  // 자정 넘김 → 2026-04-18 이 history 로 이동.
  s = maybeRollOverDay(s, new Date(2026, 3, 19, 0, 5));
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].date, '2026-04-18');
  assert.equal(s.history[0].totals.errors?.network, 2, '롤오버 직후 history 에 errors 가 따라가야 한다');

  // 직렬화 후 복원 — history[0].totals.errors.network 가 그대로 복원.
  const json = JSON.stringify(serializePersistedTotals(s, '2026-04-19T00:10:00.000Z'));
  const back = deserializePersistedTotals(json, new Date(2026, 3, 19, 0, 11));
  assert.ok(back);
  assert.equal(back!.history[0].totals.errors?.network, 2,
    '직렬화 왕복에서도 history 안의 errors 카운터는 보존되어야 한다');
});
