// Run with: npx tsx --test tests/claudeTokenUsagePersistence.regression.test.ts
//
// QA: 지시 #3b8038c7 회귀 테스트. 순수 함수 축만 검증 — claudeTokenUsageStore 의
//   (1) localStorage 직렬화·복원(키 llmtycoon.tokenUsage.v1)
//   (2) 로컬 자정 경계 롤오버(today 만 0 으로, all 유지)
//   (3) 에러 상태 getter/setter 의 no-op 최적화
// 를 모두 잠근다. 실제 window.localStorage 가 없는 Node 환경에서도 돌 수 있도록
// 문자열 직렬화 계층을 직접 다룬다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TOTALS,
  mergeUsage,
  toLocalDateKey,
  maybeRollOverDay,
  applyDeltaToState,
  hydrateAllFromServer,
  resetAllToZero,
  resetTodayOnly,
  setLoadError,
  serializePersistedTotals,
  deserializePersistedTotals,
  TOKEN_USAGE_STORAGE_KEY,
  type TokenUsageStoreState,
} from '../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../src/types.ts';

function makeState(date = '2026-04-19'): TokenUsageStoreState {
  return {
    all: { ...EMPTY_TOTALS, byModel: {} },
    today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: date,
    history: [],
    loadError: null,
  };
}

const USAGE: ClaudeTokenUsage = {
  input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  model: 'claude-sonnet-4-6',
};

test('저장 키는 llmtycoon.tokenUsage.v1 로 고정되어야 한다', () => {
  assert.equal(TOKEN_USAGE_STORAGE_KEY, 'llmtycoon.tokenUsage.v1');
});

test('toLocalDateKey 는 로컬 YYYY-MM-DD 형식을 돌려준다', () => {
  const d = new Date(2026, 3, 19, 10, 0, 0); // 월은 0-based → 4월
  assert.equal(toLocalDateKey(d), '2026-04-19');
});

test('applyDeltaToState 는 all/today 양쪽에 누적한다', () => {
  const s0 = makeState();
  const s1 = applyDeltaToState(s0, USAGE, new Date(2026, 3, 19, 10));
  assert.equal(s1.all.inputTokens, 100);
  assert.equal(s1.today.inputTokens, 100);
  assert.equal(s1.all.callCount, 1);
  assert.equal(s1.today.callCount, 1);
});

test('maybeRollOverDay 는 날짜가 그대로면 같은 참조를 돌려준다(no-op)', () => {
  const s0 = makeState('2026-04-19');
  const s1 = maybeRollOverDay(s0, new Date(2026, 3, 19, 23, 59));
  assert.equal(s1, s0, '같은 날짜면 참조까지 동일');
});

test('자정 경계 — today 는 0 으로 리셋되고 all 은 그대로 유지된다', () => {
  // 2026-04-19 에 누적 → 자정 넘어 2026-04-20 이 된 상태로 롤오버.
  let s = makeState('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 23));
  assert.equal(s.today.inputTokens, 100);
  const rolled = maybeRollOverDay(s, new Date(2026, 3, 20, 0, 5));
  assert.equal(rolled.today.inputTokens, 0, '오늘 축은 0 으로 떨어져야 한다');
  assert.equal(rolled.all.inputTokens, 100, '전체 축은 유지되어야 한다');
  assert.equal(rolled.todayDate, '2026-04-20');
});

test('applyDeltaToState 는 자정을 넘어 도착한 델타를 새 날짜에 귀속시킨다', () => {
  let s = makeState('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 23)); // 어제
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 20, 0, 5)); // 오늘 00:05
  assert.equal(s.today.inputTokens, 100, '새 날짜의 today 는 방금 한 건만 반영');
  assert.equal(s.all.inputTokens, 200, 'all 은 두 건 누적');
});

test('hydrateAllFromServer 는 all 축만 서버 값으로 교체하고 today 는 유지한다', () => {
  let s = makeState('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  const serverTotals: ClaudeTokenUsageTotals = mergeUsage({ ...EMPTY_TOTALS, byModel: {} }, { ...USAGE, input_tokens: 500 });
  const next = hydrateAllFromServer(s, serverTotals, new Date(2026, 3, 19, 11));
  assert.equal(next.all.inputTokens, 500, 'all 은 서버가 권위');
  assert.equal(next.today.inputTokens, 100, 'today 는 이전 로컬 누적 유지');
});

test('resetAllToZero 는 전부 0 으로 되돌린다', () => {
  let s = makeState('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  const reset = resetAllToZero(s, new Date(2026, 3, 19, 12));
  assert.equal(reset.all.callCount, 0);
  assert.equal(reset.today.callCount, 0);
  assert.equal(reset.todayDate, '2026-04-19');
});

test('resetTodayOnly 는 today 만 0 으로, all 은 유지한다', () => {
  let s = makeState('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  const reset = resetTodayOnly(s, new Date(2026, 3, 19, 12));
  assert.equal(reset.today.callCount, 0);
  assert.equal(reset.all.callCount, 1, 'all 은 건드리지 않는다');
});

test('setLoadError 는 같은 값에 대해 참조 동일성을 유지한다(리렌더 최소화)', () => {
  const s0 = makeState();
  const s1 = setLoadError(s0, null);
  assert.equal(s1, s0, 'null→null 은 참조 동일');
  const s2 = setLoadError(s0, 'HTTP 503');
  assert.notEqual(s2, s0);
  assert.equal(s2.loadError, 'HTTP 503');
});

test('serialize → deserialize 는 왕복 동등해야 한다(같은 날짜)', () => {
  let s = makeState('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  const json = JSON.stringify(serializePersistedTotals(s, '2026-04-19T10:00:00.000Z'));
  const back = deserializePersistedTotals(json, new Date(2026, 3, 19, 11));
  assert.ok(back);
  assert.equal(back!.all.inputTokens, 100);
  assert.equal(back!.today.inputTokens, 100);
  assert.equal(back!.todayDate, '2026-04-19');
});

test('deserialize 는 저장 시점 이후 자정을 넘겼으면 today 만 리셋하고 all 은 유지한다', () => {
  let s = makeState('2026-04-19');
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  const json = JSON.stringify(serializePersistedTotals(s, '2026-04-19T10:00:00.000Z'));
  const back = deserializePersistedTotals(json, new Date(2026, 3, 20, 8));
  assert.ok(back);
  assert.equal(back!.today.inputTokens, 0, '자정 넘김 → today 리셋');
  assert.equal(back!.all.inputTokens, 100, 'all 은 유지');
  assert.equal(back!.todayDate, '2026-04-20');
});

test('deserialize — 스키마 버전 불일치/필드 누락/손상 JSON 은 모두 null', () => {
  assert.equal(deserializePersistedTotals(null), null);
  assert.equal(deserializePersistedTotals(''), null);
  assert.equal(deserializePersistedTotals('{"schemaVersion":2,"all":{},"today":{},"todayDate":"2026-04-19"}'), null);
  assert.equal(deserializePersistedTotals('{"schemaVersion":1}'), null);
  assert.equal(deserializePersistedTotals('{not json'), null);
});

test('deserialize 는 숫자 필드의 음수/NaN/문자열을 0 으로 정규화한다', () => {
  const corrupted = JSON.stringify({
    schemaVersion: 1,
    all: { inputTokens: -5, outputTokens: 'oops', callCount: Number.NaN, byModel: null },
    today: { inputTokens: 10 },
    todayDate: '2026-04-19',
    savedAt: '2026-04-19T10:00:00.000Z',
  });
  const back = deserializePersistedTotals(corrupted, new Date(2026, 3, 19, 11));
  assert.ok(back);
  assert.equal(back!.all.inputTokens, 0);
  assert.equal(back!.all.outputTokens, 0);
  assert.equal(back!.all.callCount, 0);
  assert.deepEqual(back!.all.byModel, {}, 'null byModel 도 빈 객체로 정규화');
  assert.equal(back!.today.inputTokens, 10);
});
