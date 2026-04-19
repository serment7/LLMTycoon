// Run with: npx tsx --test tests/claudeTokenUsageStoreSaveFallback.regression.test.ts
//
// QA 자율 회귀(#3f586e66) — claudeTokenUsageStore 의 커버리지 공백 6건을 잠근다.
//
// 배경: 기존 회귀 묶음은 순수 누적(mergeUsage)·자정 롤오버·serialize 왕복까지는
// 촘촘하나, 다음 3가지 경로에 구멍이 있다. 본 파일은 jsdom 환경에서 실제 끝단을
// 실행해 계약을 고정한다.
//   · saveToStorage 의 **쿼터 초과 폴백**: 1차 실패 → truncateByModelForQuota(5)
//     재시도 → 그것도 실패하면 조용히 무시. (기존 Truncate 회귀 파일은 "jsdom 이
//     없어 끝단 실행 불가" 를 스스로 선언한 상태.)
//   · truncateByModelForQuota 의 **상위 totals 총합 불변량**: byModel 을 재구성해도
//     네 토큰 축·callCount·estimatedCostUsd **합계 자체는 변경되지 않는다**.
//   · resetAllToZero 의 **history 초기화**: 현재 구현은 emptyState 를 돌려주지만
//     "history 도 비운다" 가 명시적으로 잠겨 있지 않아, 리팩터 시 회귀 위험.
//   · selectRange('week') 의 **6일 상한선**: history 가 7개 이상이어도 최근 6일만
//     오늘과 함께 합산(총 7일) 되는 경계 계약.
//
// 본 파일은 jsdom 을 필요로 하므로 global-jsdom 을 가장 먼저 등록한다.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TOTALS,
  HISTORY_LIMIT,
  TOKEN_USAGE_STORAGE_KEY,
  applyDeltaToState,
  emptyErrorCounters,
  resetAllToZero,
  saveToStorage,
  selectRange,
  toLocalDateKey,
  truncateByModelForQuota,
  type TokenUsageStoreState,
} from '../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsage, ClaudeTokenUsageTotals } from '../src/types.ts';

// ────────────────────────────────────────────────────────────────────────────
// 공용 헬퍼
// ────────────────────────────────────────────────────────────────────────────

function baseState(dateKey = '2026-04-19'): TokenUsageStoreState {
  return {
    all: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: dateKey,
    history: [],
    loadError: null,
  };
}

function usage(model: string, input: number, output: number): ClaudeTokenUsage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model,
    at: '2026-04-19T10:00:00.000Z',
  };
}

/** N 개의 서로 다른 모델 이름으로 byModel 을 채운 상태를 만든다. */
function stateWithManyModels(count: number, dateKey = '2026-04-19'): TokenUsageStoreState {
  let s = baseState(dateKey);
  const ts = new Date(2026, 3, 19, 10);
  for (let i = 0; i < count; i++) {
    s = applyDeltaToState(s, usage(`model-${String(i).padStart(2, '0')}`, 100 + i, 50 + i), ts);
  }
  return s;
}

/** totals 의 네 토큰 축·callCount·estimatedCostUsd 만 뽑아 비교용 튜플로. */
function totalsSummary(t: ClaudeTokenUsageTotals) {
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    callCount: t.callCount,
    estimatedCostUsd: Number(t.estimatedCostUsd.toFixed(9)),
  };
}

/**
 * Storage.prototype.setItem 을 스파이로 대체. 키가 `TOKEN_USAGE_STORAGE_KEY` 인
 * 호출만 특정 조건에서 throw 하도록 한다. 다른 키는 원본으로 통과.
 */
function installSetItemSpy(opts: { failUntilCall?: number; alwaysFail?: boolean } = {}) {
  const orig = Storage.prototype.setItem;
  const calls: Array<{ key: string; value: string }> = [];
  Storage.prototype.setItem = function patched(key: string, value: string) {
    if (key === TOKEN_USAGE_STORAGE_KEY) {
      calls.push({ key, value });
      const shouldFail =
        opts.alwaysFail === true ||
        (typeof opts.failUntilCall === 'number' && calls.length <= opts.failUntilCall);
      if (shouldFail) {
        const err = new Error('QuotaExceededError');
        (err as Error & { name: string }).name = 'QuotaExceededError';
        throw err;
      }
    }
    return orig.call(this, key, value);
  };
  return {
    calls,
    restore() {
      Storage.prototype.setItem = orig;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. saveToStorage — 정상 경로(쿼터 여유) 1회 쓰기
// ────────────────────────────────────────────────────────────────────────────

test('saveToStorage — 쿼터 여유 상황에서는 setItem 을 정확히 1회 호출한다', () => {
  window.localStorage.clear();
  const spy = installSetItemSpy();
  const s = stateWithManyModels(3);
  saveToStorage(s, '2026-04-19T10:00:00.000Z');
  assert.equal(spy.calls.length, 1, '정상 경로 1회');
  const payload = JSON.parse(spy.calls[0].value) as { schemaVersion: number };
  assert.equal(payload.schemaVersion, 1);
  spy.restore();
  window.localStorage.clear();
});

// ────────────────────────────────────────────────────────────────────────────
// 2. saveToStorage — 1차 실패 → truncate(5) 로 2차 성공
// ────────────────────────────────────────────────────────────────────────────

test('saveToStorage — 1차 실패 시 byModel 상위 5 로 잘라 2차 쓰기로 폴백한다', () => {
  window.localStorage.clear();
  const spy = installSetItemSpy({ failUntilCall: 1 });
  const s = stateWithManyModels(10); // 10개 모델 → truncate 후 5 + 기타 = 6개
  saveToStorage(s, '2026-04-19T10:00:00.000Z');
  assert.equal(spy.calls.length, 2, '정확히 2회 시도: 1차 실패 + 2차 성공');
  const payload = JSON.parse(spy.calls[1].value) as {
    all: ClaudeTokenUsageTotals;
    today: ClaudeTokenUsageTotals;
  };
  const keys = Object.keys(payload.all.byModel);
  assert.equal(keys.length, 6, '상위 5 + "기타" 합산 = 6 키');
  assert.ok(keys.includes('기타'), '"기타" 버킷이 존재해야 한다');
  // today 축도 동일한 truncate 가 적용되어야 한다(모든 호출이 같은 날짜라 today==all 패턴).
  assert.ok(Object.keys(payload.today.byModel).includes('기타'), 'today 축도 truncate 됨');
  spy.restore();
  window.localStorage.clear();
});

// ────────────────────────────────────────────────────────────────────────────
// 3. saveToStorage — 2차도 실패하면 조용히 무시(throw 없음)
// ────────────────────────────────────────────────────────────────────────────

test('saveToStorage — 2차 재시도도 실패하면 예외를 바깥으로 던지지 않는다', () => {
  window.localStorage.clear();
  const spy = installSetItemSpy({ alwaysFail: true });
  const s = stateWithManyModels(10);
  assert.doesNotThrow(() => saveToStorage(s, '2026-04-19T10:00:00.000Z'));
  // 1차 + 2차(truncate) = 2회 시도 후 포기. 3회 이상 재시도하지 않는다.
  assert.equal(spy.calls.length, 2, '최대 2회까지만 시도하고 포기');
  // 저장이 실패했으므로 localStorage 에는 아무 것도 남지 않아야 한다.
  assert.equal(
    window.localStorage.getItem(TOKEN_USAGE_STORAGE_KEY),
    null,
    '저장 실패 시 키는 null 유지',
  );
  spy.restore();
  window.localStorage.clear();
});

// ────────────────────────────────────────────────────────────────────────────
// 4. truncateByModelForQuota — 상위 totals 총합 불변량
// ────────────────────────────────────────────────────────────────────────────

test('truncateByModelForQuota — byModel 재구성은 totals 의 네 토큰 축/callCount/비용 총합을 변경하지 않는다', () => {
  const s = stateWithManyModels(12);
  const before = totalsSummary(s.all);
  const afterAll = truncateByModelForQuota(s, 3);
  const after = totalsSummary(afterAll.all);
  assert.deepEqual(after, before, '상위 totals 불변량 위반');
  // byModel 합은 상위 totals 와 정확히 일치해야 한다(상실 없음).
  const rebuild = Object.values(afterAll.all.byModel).reduce(
    (acc, m) => ({
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + m.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + m.cacheCreationTokens,
      callCount: acc.callCount + m.callCount,
      estimatedCostUsd: acc.estimatedCostUsd + m.estimatedCostUsd,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, callCount: 0, estimatedCostUsd: 0 },
  );
  assert.equal(rebuild.inputTokens, before.inputTokens, '입력 합 = 상위 totals 입력');
  assert.equal(rebuild.callCount, before.callCount, 'callCount 합 = 상위 totals callCount');
  assert.ok(
    Math.abs(rebuild.estimatedCostUsd - before.estimatedCostUsd) < 1e-9,
    '비용 합 = 상위 totals 비용(부동소수 오차 내)',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 5. resetAllToZero — history 까지 비우는 계약
// ────────────────────────────────────────────────────────────────────────────

test('resetAllToZero — history 도 빈 배열로 초기화되어야 한다(회귀 안전망)', () => {
  let s = baseState('2026-04-18');
  s = applyDeltaToState(s, usage('claude-sonnet-4-6', 100, 50), new Date(2026, 3, 18, 10));
  // 자정 롤오버로 history 에 한 건 push.
  s = applyDeltaToState(s, usage('claude-sonnet-4-6', 200, 100), new Date(2026, 3, 19, 1));
  assert.ok(s.history.length > 0, '롤오버로 history 가 1건 이상 있어야 전제가 성립');

  const reset = resetAllToZero(s, new Date(2026, 3, 19, 2));
  assert.deepEqual(reset.history, [], 'history 는 빈 배열');
  assert.equal(reset.all.callCount, 0);
  assert.equal(reset.today.callCount, 0);
  assert.equal(reset.loadError, null, 'loadError 도 초기화');
  // HISTORY_LIMIT 자체는 상수로 유지되어 있는지(공개 상수 회귀).
  assert.equal(HISTORY_LIMIT, 30, 'HISTORY_LIMIT 공개 상수는 30 유지');
});

// ────────────────────────────────────────────────────────────────────────────
// 6. selectRange('week') — history 가 7+개여도 최근 6일만 오늘과 함께 합산
// ────────────────────────────────────────────────────────────────────────────

test('selectRange(week) — history 10개가 있어도 최근 6일만 합산해 오늘 포함 총 7일 경계를 지킨다', () => {
  // 2026-04-08 ~ 2026-04-18 까지 매일 1건씩 총 11일의 누적을 만든다.
  // applyDeltaToState 가 자정 롤오버를 수행하므로 history 에 10건이 쌓인다.
  let s = baseState(toLocalDateKey(new Date(2026, 3, 8, 10)));
  for (let d = 8; d <= 18; d++) {
    s = applyDeltaToState(
      s,
      usage('claude-sonnet-4-6', 1000, 500),
      new Date(2026, 3, d, 10),
    );
  }
  // 오늘은 2026-04-18, history 에는 10일치(2026-04-17 … 2026-04-08) 가 최신순으로 쌓인다.
  assert.equal(s.todayDate, '2026-04-18');
  assert.equal(s.history.length, 10, '롤오버로 10개 누적 전제');

  const week = selectRange(s, 'week');
  // 오늘(1) + 최근 6일(6) = 7일. 각 일자 callCount 1 이므로 주간 callCount = 7.
  assert.equal(week.callCount, 7, '주간 합계 호출 수 = 7(오늘 + 6일)');
  assert.equal(week.inputTokens, 7 * 1000);
  assert.equal(week.outputTokens, 7 * 500);
  // 총계(all) 는 11일치 전부를 반영해야 한다(대조군).
  assert.equal(s.all.callCount, 11, 'all 축은 11일 전부 반영');
});
