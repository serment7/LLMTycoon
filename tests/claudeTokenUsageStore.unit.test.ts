// Run with: npx tsx --test tests/claudeTokenUsageStore.unit.test.ts
//
// 단위 테스트: src/utils/claudeTokenUsageStore.ts 의 순수 함수 + 스토어 동작.
// 지시 #b17802a6 — 누적·일별 리셋·localStorage 직렬화/복원·errors 카운터 증가.
//
// 외부 I/O(localStorage) 는 global-jsdom 으로 window 를 등록해 주입한다. jsdom 은
// 이미 devDeps 에 있으므로 추가 설치는 필요 없다.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../src/types.ts';
import {
  EMPTY_TOTALS,
  HISTORY_LIMIT,
  TOKEN_USAGE_STORAGE_KEY,
  applyDeltaToState,
  cacheHitRate,
  claudeTokenUsageStore,
  deserializePersistedTotals,
  emptyErrorCounters,
  ensureErrorCounters,
  estimateCostUsd,
  hydrateAllFromServer,
  loadFromStorage,
  maybeRollOverDay,
  mergeUsage,
  recordErrorInState,
  recordErrorToTotals,
  resetAllToZero,
  resetTodayOnly,
  resolveUsageSeverity,
  saveToStorage,
  selectRange,
  serializePersistedTotals,
  setLoadError,
  toLocalDateKey,
} from '../src/utils/claudeTokenUsageStore.ts';

function mkUsage(partial: Partial<ClaudeTokenUsage> = {}): ClaudeTokenUsage {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model: 'claude-sonnet-4-6',
    at: '2026-04-19T12:00:00.000Z',
    ...partial,
  } as ClaudeTokenUsage;
}

// ─── 누적(mergeUsage) ──────────────────────────────────────────────────────────

test('mergeUsage — 빈 totals 에 한 번 누적하면 호출 1, 입력/출력이 정확히 더해진다', () => {
  const totals = mergeUsage(EMPTY_TOTALS, mkUsage({ input_tokens: 120, output_tokens: 30 }));
  assert.equal(totals.callCount, 1);
  assert.equal(totals.inputTokens, 120);
  assert.equal(totals.outputTokens, 30);
  assert.ok(totals.estimatedCostUsd > 0, '비용이 0 초과여야 한다');
});

test('mergeUsage — 음수/NaN 입력은 0 으로 클램프한다(감소 유발 금지)', () => {
  const t1 = mergeUsage(EMPTY_TOTALS, mkUsage({ input_tokens: -50, output_tokens: Number.NaN }));
  assert.equal(t1.inputTokens, 0);
  assert.equal(t1.outputTokens, 0);
  assert.equal(t1.callCount, 1);
});

test('mergeUsage — 연속 누적 시 totals 와 byModel 이 동일 증분으로 늘어난다', () => {
  let t: ClaudeTokenUsageTotals = EMPTY_TOTALS;
  t = mergeUsage(t, mkUsage({ input_tokens: 10, output_tokens: 5 }));
  t = mergeUsage(t, mkUsage({ input_tokens: 20, output_tokens: 10, model: 'claude-opus-4-7' }));
  assert.equal(t.callCount, 2);
  assert.equal(t.inputTokens, 30);
  assert.equal(t.outputTokens, 15);
  assert.equal(t.byModel['claude-sonnet-4-6'].callCount, 1);
  assert.equal(t.byModel['claude-opus-4-7'].callCount, 1);
});

test('cacheHitRate — 분모 0 일 때 0 반환, 그 외 비율 정확', () => {
  assert.equal(cacheHitRate(EMPTY_TOTALS), 0);
  const custom: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, inputTokens: 800, cacheReadTokens: 200 };
  assert.equal(cacheHitRate(custom), 0.2);
});

test('estimateCostUsd — 알려지지 않은 모델은 기본 단가(sonnet) 로 폴백', () => {
  const unknown = estimateCostUsd(mkUsage({ model: 'gpt-5-non-claude' }));
  const sonnet = estimateCostUsd(mkUsage({ model: 'claude-sonnet-4-6' }));
  assert.equal(unknown, sonnet);
});

// ─── 일별 리셋 (maybeRollOverDay) ─────────────────────────────────────────────

test('maybeRollOverDay — 날짜 동일이면 같은 참조 반환(불필요 리렌더 차단)', () => {
  const state = applyDeltaToState({
    all: { ...EMPTY_TOTALS }, today: { ...EMPTY_TOTALS },
    todayDate: toLocalDateKey(new Date('2026-04-19T10:00:00')),
    history: [], loadError: null,
  }, mkUsage(), new Date('2026-04-19T10:00:00'));
  const same = maybeRollOverDay(state, new Date('2026-04-19T23:59:59'));
  assert.strictEqual(same, state, '같은 날짜에서는 동일 객체 반환');
});

test('maybeRollOverDay — 자정 넘으면 today 가 history 앞쪽으로 이동하고 today 는 0 으로', () => {
  const start = new Date('2026-04-19T23:00:00');
  let state = applyDeltaToState({
    all: { ...EMPTY_TOTALS, byModel: {} },
    today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: toLocalDateKey(start),
    history: [], loadError: null,
  }, mkUsage({ input_tokens: 500 }), start);
  assert.equal(state.today.inputTokens, 500);
  const next = maybeRollOverDay(state, new Date('2026-04-20T00:00:10'));
  assert.equal(next.today.inputTokens, 0, 'today 는 0 으로 초기화');
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].totals.inputTokens, 500);
  assert.equal(next.todayDate, toLocalDateKey(new Date('2026-04-20T00:00:10')));
});

test('maybeRollOverDay — 의미 없는 today(모든 0) 는 history 에 쌓이지 않는다', () => {
  const state = {
    all: { ...EMPTY_TOTALS, byModel: {} },
    today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: '2026-04-19',
    history: [], loadError: null,
  };
  const rolled = maybeRollOverDay(state, new Date('2026-04-20T00:00:05'));
  assert.equal(rolled.history.length, 0);
});

test('applyDeltaToState — 자정 직후 도착한 delta 는 "새 today" 에 기록된다', () => {
  let state = {
    all: { ...EMPTY_TOTALS, byModel: {} },
    today: { ...mergeUsage(EMPTY_TOTALS, mkUsage({ input_tokens: 200 })), byModel: {} },
    todayDate: '2026-04-19',
    history: [], loadError: null,
  };
  state = applyDeltaToState(state, mkUsage({ input_tokens: 30 }), new Date('2026-04-20T00:05:00'));
  assert.equal(state.today.inputTokens, 30, '새 today 에 30만 있어야 한다(어제의 200 은 히스토리)');
  assert.equal(state.history[0].totals.inputTokens, 200);
});

// ─── errors 카운터 ────────────────────────────────────────────────────────────

test('emptyErrorCounters — 7 카테고리 전부 0 으로 초기화된다', () => {
  const c = emptyErrorCounters();
  for (const k of ['rate_limit', 'overloaded', 'api_error', 'bad_request', 'auth', 'timeout', 'network']) {
    assert.equal(c[k as keyof typeof c], 0);
  }
});

test('ensureErrorCounters — 유효 숫자만 받아들이고 음수/문자/누락은 0 으로 보정', () => {
  const out = ensureErrorCounters({ rate_limit: 3, auth: -1, timeout: 'x' as any, overloaded: undefined as any, api_error: 2, bad_request: 0, network: 5.9 } as any);
  assert.equal(out.rate_limit, 3);
  assert.equal(out.auth, 0);
  assert.equal(out.timeout, 0);
  assert.equal(out.overloaded, 0);
  assert.equal(out.api_error, 2);
  assert.equal(out.bad_request, 0);
  assert.equal(out.network, 5, 'Math.floor 정책');
});

test('recordErrorToTotals / recordErrorInState — 호출마다 해당 카테고리 1 증가, all/today 양축 동기화', () => {
  const base = { all: { ...EMPTY_TOTALS, byModel: {} }, today: { ...EMPTY_TOTALS, byModel: {} }, todayDate: '2026-04-19', history: [], loadError: null };
  const next = recordErrorInState(base, 'rate_limit', new Date('2026-04-19T12:00:00'));
  assert.equal(next.all.errors.rate_limit, 1);
  assert.equal(next.today.errors.rate_limit, 1);
  const next2 = recordErrorInState(next, 'rate_limit', new Date('2026-04-19T12:05:00'));
  assert.equal(next2.all.errors.rate_limit, 2);
  assert.equal(next2.today.errors.rate_limit, 2);
  assert.equal(next2.today.errors.auth, 0, '다른 카테고리는 건드리지 않음');
});

test('recordErrorToTotals — errors 가 undefined 여도 안전하게 기본 카운터로 복원 후 증가', () => {
  const broken = { ...EMPTY_TOTALS, errors: undefined as any };
  const t = recordErrorToTotals(broken, 'timeout');
  assert.equal(t.errors.timeout, 1);
});

// ─── localStorage 직렬화/복원 ────────────────────────────────────────────────

test('serialize → deserialize 왕복이 항상 동치이다(schemaVersion 1)', () => {
  const state = applyDeltaToState({
    all: { ...EMPTY_TOTALS, byModel: {} }, today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: '2026-04-19', history: [], loadError: null,
  }, mkUsage({ input_tokens: 77, output_tokens: 33 }), new Date('2026-04-19T08:00:00'));
  const json = JSON.stringify(serializePersistedTotals(state, '2026-04-19T08:00:00.000Z'));
  const restored = deserializePersistedTotals(json, new Date('2026-04-19T08:10:00'));
  assert.ok(restored, '복원 실패');
  assert.equal(restored!.today.inputTokens, 77);
  assert.equal(restored!.all.outputTokens, 33);
});

test('deserializePersistedTotals — 잘못된 JSON·미지 schemaVersion·빈 값은 null 반환', () => {
  assert.equal(deserializePersistedTotals(null), null);
  assert.equal(deserializePersistedTotals(''), null);
  assert.equal(deserializePersistedTotals('not json'), null);
  assert.equal(deserializePersistedTotals(JSON.stringify({ schemaVersion: 99 })), null);
  assert.equal(deserializePersistedTotals(JSON.stringify({ schemaVersion: 1 })), null,
    'all/today 가 없으면 null');
});

test('load/saveToStorage — jsdom localStorage 왕복 + 키 고정', () => {
  window.localStorage.clear();
  const state = applyDeltaToState({
    all: { ...EMPTY_TOTALS, byModel: {} }, today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: '2026-04-19', history: [], loadError: null,
  }, mkUsage({ input_tokens: 44 }), new Date('2026-04-19T08:00:00'));
  saveToStorage(state, '2026-04-19T08:00:00.000Z');
  const raw = window.localStorage.getItem(TOKEN_USAGE_STORAGE_KEY);
  assert.ok(raw, '저장된 raw 가 있어야 한다');
  const loaded = loadFromStorage(new Date('2026-04-19T08:10:00'));
  assert.ok(loaded);
  assert.equal(loaded!.today.inputTokens, 44);
});

test('load — 자정 넘긴 상태를 복원하면 today 가 0 으로 롤오버된다', () => {
  window.localStorage.clear();
  const state = applyDeltaToState({
    all: { ...EMPTY_TOTALS, byModel: {} }, today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: '2026-04-18', history: [], loadError: null,
  }, mkUsage({ input_tokens: 60 }), new Date('2026-04-18T20:00:00'));
  saveToStorage(state, '2026-04-18T20:00:00.000Z');
  const loaded = loadFromStorage(new Date('2026-04-20T01:00:00'));
  assert.ok(loaded);
  assert.equal(loaded!.today.inputTokens, 0, '롤오버 후 today 는 0');
  assert.equal(loaded!.history[0].totals.inputTokens, 60, '이전 today 가 history 에 쌓임');
});

// ─── 스토어(모듈 레벨 pub/sub) ────────────────────────────────────────────────

test('claudeTokenUsageStore — subscribe/getSnapshot · reset · applyDelta', () => {
  claudeTokenUsageStore.__setForTest({
    all: { ...EMPTY_TOTALS, byModel: {} },
    today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: toLocalDateKey(new Date()),
    history: [], loadError: null,
  });
  let emits = 0;
  const unsub = claudeTokenUsageStore.subscribe(() => { emits += 1; });
  claudeTokenUsageStore.applyDelta(mkUsage({ input_tokens: 7 }));
  const snap1 = claudeTokenUsageStore.getSnapshot();
  assert.equal(snap1.all.inputTokens, 7);
  claudeTokenUsageStore.reset();
  const snap2 = claudeTokenUsageStore.getSnapshot();
  assert.equal(snap2.all.inputTokens, 0);
  assert.ok(emits >= 2);
  unsub();
});

test('claudeTokenUsageStore.recordError — 카운터 1 증가 · 다른 카테고리 무변', () => {
  claudeTokenUsageStore.__setForTest({
    all: { ...EMPTY_TOTALS, byModel: {} },
    today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: toLocalDateKey(new Date()),
    history: [], loadError: null,
  });
  claudeTokenUsageStore.recordError('network');
  claudeTokenUsageStore.recordError('network');
  const snap = claudeTokenUsageStore.getSnapshot();
  assert.equal(snap.all.errors.network, 2);
  assert.equal(snap.all.errors.api_error, 0);
});

test('setLoadError — 동일 값이면 동일 참조, 다른 값이면 loadError 갱신', () => {
  const base = { all: { ...EMPTY_TOTALS }, today: { ...EMPTY_TOTALS }, todayDate: '2026-04-19', history: [], loadError: null };
  const same = setLoadError(base, null);
  assert.strictEqual(same, base);
  const next = setLoadError(base, 'boom');
  assert.equal(next.loadError, 'boom');
});

test('selectRange — today/week/all 스위치가 올바르게 집계된다', () => {
  const s = {
    all: { ...EMPTY_TOTALS, inputTokens: 1000, byModel: {} },
    today: { ...EMPTY_TOTALS, inputTokens: 100, byModel: {} },
    todayDate: '2026-04-19',
    history: [{ date: '2026-04-18', totals: { ...EMPTY_TOTALS, inputTokens: 200, byModel: {} } }],
    loadError: null,
  };
  assert.equal(selectRange(s, 'today').inputTokens, 100);
  assert.equal(selectRange(s, 'all').inputTokens, 1000);
  assert.equal(selectRange(s, 'week').inputTokens, 300, 'today + history 최근 6개 합산');
});

test('resolveUsageSeverity — tokens/usd 중 하나만 초과해도 상향', () => {
  const totals = { ...EMPTY_TOTALS, inputTokens: 500, outputTokens: 500, estimatedCostUsd: 0.3 };
  assert.equal(resolveUsageSeverity(totals, { caution: { tokens: 200 }, warning: { tokens: 2000 } }), 'caution');
  assert.equal(resolveUsageSeverity(totals, { caution: {}, warning: { usd: 0.2 } }), 'warning');
  assert.equal(resolveUsageSeverity(totals, { caution: {}, warning: {} }), 'normal');
});

test('HISTORY_LIMIT — 30개 초과 시 오래된 것부터 순환 제거', () => {
  let state = {
    all: { ...EMPTY_TOTALS, byModel: {} },
    today: { ...EMPTY_TOTALS, byModel: {} },
    todayDate: '2026-04-01',
    history: [], loadError: null,
  };
  for (let i = 0; i < HISTORY_LIMIT + 3; i++) {
    state = applyDeltaToState(state, mkUsage({ input_tokens: 1 }), new Date(`2026-04-01T${String(i % 24).padStart(2, '0')}:00:00`));
    state = maybeRollOverDay(state, new Date(`2026-04-${String((i + 2) % 30 + 1).padStart(2, '0')}T00:00:05`));
  }
  assert.ok(state.history.length <= HISTORY_LIMIT, `history 는 최대 ${HISTORY_LIMIT} 개`);
});
