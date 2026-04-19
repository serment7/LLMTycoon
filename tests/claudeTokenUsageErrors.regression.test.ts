// Run with: npx tsx --test tests/claudeTokenUsageErrors.regression.test.ts
//
// QA: 지시 #697c4e29 의 (3) tokenUsageStore errors 섹션 · 내보내기 errors 컬럼 회귀.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyErrorCounters,
  ensureErrorCounters,
  recordErrorToTotals,
  recordErrorInState,
  EMPTY_TOTALS,
  applyDeltaToState,
  type TokenUsageStoreState,
} from '../src/utils/claudeTokenUsageStore.ts';
import { buildExportRows, toCsv, toJson } from '../src/utils/claudeTokenUsageExport.ts';
import type { ClaudeTokenUsage } from '../src/types.ts';

function makeState(date = '2026-04-19'): TokenUsageStoreState {
  return {
    all: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: date,
    history: [],
    loadError: null,
  };
}

test('emptyErrorCounters — 7개 카테고리를 모두 0 으로 초기화', () => {
  const c = emptyErrorCounters();
  assert.equal(c.rate_limit, 0);
  assert.equal(c.overloaded, 0);
  assert.equal(c.api_error, 0);
  assert.equal(c.bad_request, 0);
  assert.equal(c.auth, 0);
  assert.equal(c.timeout, 0);
  assert.equal(c.network, 0);
});

test('ensureErrorCounters — undefined/잘못된 값은 빈 카운터로 보정', () => {
  assert.deepEqual(ensureErrorCounters(undefined), emptyErrorCounters());
  // @ts-expect-error — 런타임 방어 검증
  assert.deepEqual(ensureErrorCounters('oops'), emptyErrorCounters());
  assert.deepEqual(ensureErrorCounters({ rate_limit: -1, api_error: 3 } as unknown as ReturnType<typeof emptyErrorCounters>).api_error, 3);
});

test('recordErrorToTotals — 지정 카테고리만 1 증가하고 나머지는 유지', () => {
  const base = { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() };
  const next = recordErrorToTotals(base, 'rate_limit');
  assert.equal(next.errors?.rate_limit, 1);
  assert.equal(next.errors?.api_error, 0);
});

test('recordErrorInState — all/today 양쪽에 카운트', () => {
  let s = makeState('2026-04-19');
  s = recordErrorInState(s, 'timeout', new Date(2026, 3, 19, 10));
  s = recordErrorInState(s, 'timeout', new Date(2026, 3, 19, 11));
  s = recordErrorInState(s, 'network', new Date(2026, 3, 19, 12));
  assert.equal(s.all.errors?.timeout, 2);
  assert.equal(s.today.errors?.timeout, 2);
  assert.equal(s.all.errors?.network, 1);
  assert.equal(s.today.errors?.network, 1);
});

test('recordErrorInState — 자정 롤오버 시 이전 today.errors 는 history 로 이동, 새 today 는 해당 에러만 포함', () => {
  let s = makeState('2026-04-19');
  s = recordErrorInState(s, 'rate_limit', new Date(2026, 3, 19, 22));
  s = recordErrorInState(s, 'timeout', new Date(2026, 3, 20, 0, 5)); // 자정 넘김
  assert.equal(s.today.errors?.timeout, 1, '새 today 는 직전 에러만 반영');
  assert.equal(s.today.errors?.rate_limit, 0);
  assert.equal(s.history[0]?.totals.errors?.rate_limit, 1, 'history 에는 전날 에러 누적이 남는다');
  assert.equal(s.all.errors?.rate_limit, 1);
  assert.equal(s.all.errors?.timeout, 1);
});

test('buildExportRows + toCsv — 행마다 7개 err_* 컬럼이 포함된다', () => {
  let s = makeState('2026-04-19');
  const USAGE: ClaudeTokenUsage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-4-6' };
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  s = recordErrorInState(s, 'rate_limit', new Date(2026, 3, 19, 11));
  const rows = buildExportRows(s, 'today');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].err_rate_limit, 1);
  assert.equal(rows[0].err_api_error, 0);
  const csv = toCsv(rows);
  assert.match(csv, /err_rate_limit,err_overloaded,err_api_error,err_bad_request,err_auth,err_timeout,err_network/);
});

test('toJson — schema 는 기존 v1 유지, 각 row 에 err_* 필드가 직렬화된다', () => {
  let s = makeState('2026-04-19');
  s = recordErrorInState(s, 'auth', new Date(2026, 3, 19, 10));
  const rows = buildExportRows(s, 'today');
  const json = toJson(rows, { range: 'today', exportedAt: '2026-04-19T10:00:00.000Z' });
  const parsed = JSON.parse(json);
  assert.equal(parsed.schema, 'llmtycoon.tokenUsage.export/v1');
  assert.equal(parsed.rows[0].err_auth, 1);
});

// ─── 지시 #66545b0f 보강 ──────────────────────────────────────────────────────

test('range 전환(today ↔ all) 에도 err_* 컬럼 7개 순서는 동일하게 유지된다', () => {
  // range 를 바꿔도 CSV 헤더가 바뀌면 후속 분석 파이프라인(열 인덱스 기반 집계)
  // 이 깨진다. 본 테스트는 두 range 의 헤더 라인이 정확히 같은 문자열이라는
  // "결정적 컬럼 순서" 계약을 잠근다.
  let s = makeState('2026-04-19');
  const USAGE: ClaudeTokenUsage = {
    input_tokens: 10, output_tokens: 5,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    model: 'claude-sonnet-4-6',
  };
  s = applyDeltaToState(s, USAGE, new Date(2026, 3, 19, 10));
  s = recordErrorInState(s, 'network', new Date(2026, 3, 19, 11));

  const csvToday = toCsv(buildExportRows(s, 'today'));
  const csvAll = toCsv(buildExportRows(s, 'all'));
  const headerToday = csvToday.split(/\r?\n/)[0];
  const headerAll = csvAll.split(/\r?\n/)[0];
  assert.equal(headerAll, headerToday, 'today 와 all 의 CSV 헤더가 완전 일치해야 한다');
  assert.match(headerToday, /err_rate_limit,err_overloaded,err_api_error,err_bad_request,err_auth,err_timeout,err_network/);
});

test('recordErrorInState — 빈 today 도 에러 1건만으로는 history 에 쌓이지 않는다(자정 롤오버 전)', () => {
  // errors 만 채워 둔 today 가 자정을 넘기지 않은 상태에서는 history 에 옮겨갈
  // 이유가 없다. 같은 날짜에 누적되는 동작을 잠근다.
  let s = makeState('2026-04-19');
  s = recordErrorInState(s, 'bad_request', new Date(2026, 3, 19, 10));
  s = recordErrorInState(s, 'bad_request', new Date(2026, 3, 19, 18));
  assert.equal(s.today.errors?.bad_request, 2, '같은 날짜에서는 단일 today 에 누적');
  assert.equal(s.history.length, 0, '자정 전에는 history 가 비어 있다');
});
