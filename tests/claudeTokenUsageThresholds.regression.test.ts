// Run with: npx tsx --test tests/claudeTokenUsageThresholds.regression.test.ts
//
// QA: 지시 #3b8038c7 임계값 판정 회귀 테스트.
//   (1) resolveUsageSeverity — tokens/usd 중 하나라도 넘으면 승격, warning > caution
//   (2) parseThresholdInput — 빈 문자열/음수/비숫자 방어
//   (3) validateThresholds — caution ≥ warning 이면 reject
//   (4) serialize/deserialize 왕복 — v1 스키마 유지

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TOTALS,
  resolveUsageSeverity,
  EMPTY_THRESHOLDS,
} from '../src/utils/claudeTokenUsageStore.ts';
import {
  parseThresholdInput,
  validateThresholds,
  serializeThresholds,
  deserializeThresholds,
  TOKEN_USAGE_THRESHOLDS_STORAGE_KEY,
} from '../src/utils/claudeTokenUsageThresholds.ts';
import type { ClaudeTokenUsageTotals, ClaudeTokenUsageThresholds } from '../src/types.ts';

function totalsWith(patch: Partial<ClaudeTokenUsageTotals>): ClaudeTokenUsageTotals {
  return { ...EMPTY_TOTALS, byModel: {}, ...patch };
}

test('임계값 저장 키는 llmtycoon.tokenUsage.thresholds.v1 로 고정되어야 한다', () => {
  assert.equal(TOKEN_USAGE_THRESHOLDS_STORAGE_KEY, 'llmtycoon.tokenUsage.thresholds.v1');
});

test('미설정(빈 임계값) 이면 어떤 값에도 severity 는 항상 normal', () => {
  assert.equal(resolveUsageSeverity(totalsWith({ inputTokens: 10_000_000, estimatedCostUsd: 500 }), EMPTY_THRESHOLDS), 'normal');
});

test('caution.tokens 만 설정 — 합계가 임계값을 넘으면 caution', () => {
  const th: ClaudeTokenUsageThresholds = { caution: { tokens: 1000 }, warning: {} };
  assert.equal(resolveUsageSeverity(totalsWith({ inputTokens: 500, outputTokens: 400 }), th), 'normal');
  assert.equal(resolveUsageSeverity(totalsWith({ inputTokens: 600, outputTokens: 400 }), th), 'caution');
  assert.equal(resolveUsageSeverity(totalsWith({ inputTokens: 800, outputTokens: 300 }), th), 'caution');
});

test('warning 이 caution 을 덮는다(승격 우선)', () => {
  const th: ClaudeTokenUsageThresholds = { caution: { tokens: 1000 }, warning: { tokens: 5000 } };
  assert.equal(resolveUsageSeverity(totalsWith({ inputTokens: 3000, outputTokens: 0 }), th), 'caution');
  assert.equal(resolveUsageSeverity(totalsWith({ inputTokens: 4000, outputTokens: 1500 }), th), 'warning');
});

test('usd 축 단독 임계값 — 비용이 넘으면 해당 단계로 승격', () => {
  const th: ClaudeTokenUsageThresholds = { caution: { usd: 1 }, warning: { usd: 5 } };
  assert.equal(resolveUsageSeverity(totalsWith({ estimatedCostUsd: 0.5 }), th), 'normal');
  assert.equal(resolveUsageSeverity(totalsWith({ estimatedCostUsd: 2 }), th), 'caution');
  assert.equal(resolveUsageSeverity(totalsWith({ estimatedCostUsd: 8 }), th), 'warning');
});

test('tokens 와 usd 가 동시에 설정된 경우 둘 중 하나라도 넘으면 승격', () => {
  const th: ClaudeTokenUsageThresholds = { caution: { tokens: 10_000, usd: 5 }, warning: { tokens: 100_000, usd: 20 } };
  // tokens 만 넘김
  assert.equal(resolveUsageSeverity(totalsWith({ inputTokens: 15_000, estimatedCostUsd: 0.1 }), th), 'caution');
  // usd 만 넘김
  assert.equal(resolveUsageSeverity(totalsWith({ inputTokens: 1, estimatedCostUsd: 6 }), th), 'caution');
});

test('parseThresholdInput 은 빈 문자열·음수·비숫자를 모두 미설정으로 처리', () => {
  assert.deepEqual(parseThresholdInput({ tokens: '', usd: '' }), {});
  assert.deepEqual(parseThresholdInput({ tokens: '-5', usd: '0' }), {});
  assert.deepEqual(parseThresholdInput({ tokens: 'abc', usd: 'NaN' }), {});
  assert.deepEqual(parseThresholdInput({ tokens: '  500  ', usd: '1.23' }), { tokens: 500, usd: 1.23 });
});

test('validateThresholds 는 caution ≥ warning 이면 에러 메시지를 돌려준다', () => {
  const bad: ClaudeTokenUsageThresholds = { caution: { tokens: 10_000 }, warning: { tokens: 5_000 } };
  const v = validateThresholds(bad);
  assert.equal(v.ok, false);
  assert.match(v.error ?? '', /주의/);
});

test('validateThresholds 는 축이 서로 다르면 비교하지 않는다(교차 축 허용)', () => {
  const ok: ClaudeTokenUsageThresholds = { caution: { tokens: 100 }, warning: { usd: 10 } };
  assert.equal(validateThresholds(ok).ok, true);
});

test('serialize → deserialize 왕복은 동등', () => {
  const t: ClaudeTokenUsageThresholds = { caution: { tokens: 500, usd: 2 }, warning: { tokens: 5000 } };
  const s = serializeThresholds(t, '2026-04-19T10:00:00.000Z');
  const back = deserializeThresholds(s);
  assert.deepEqual(back, t);
});

test('deserialize — 버전 불일치/손상 JSON/빈 값은 모두 EMPTY_THRESHOLDS', () => {
  assert.deepEqual(deserializeThresholds(null), EMPTY_THRESHOLDS);
  assert.deepEqual(deserializeThresholds(''), EMPTY_THRESHOLDS);
  assert.deepEqual(deserializeThresholds('{"schemaVersion":9}'), EMPTY_THRESHOLDS);
  assert.deepEqual(deserializeThresholds('{not json'), EMPTY_THRESHOLDS);
});

test('deserialize 는 숫자 필드의 음수/비숫자를 필터링한다', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    thresholds: {
      caution: { tokens: -10, usd: 'oops' },
      warning: { tokens: 5000, usd: 20 },
    },
    savedAt: '2026-04-19T10:00:00.000Z',
  });
  const back = deserializeThresholds(raw);
  assert.deepEqual(back.caution, {});
  assert.deepEqual(back.warning, { tokens: 5000, usd: 20 });
});

// ─── 지시 #a0b53ac9 보강 ──────────────────────────────────────────────────────

test('validateThresholds — caution 과 warning 이 동일 값이어도 실패로 분류된다', () => {
  // c.tokens >= w.tokens 계약이므로 동일값도 실패. UI 가 "엄격한 부등호" 를
  // 기대할 경우 이 계약이 깨지면 사용자가 "저장이 왜 안 되나" 혼란을 겪는다.
  const same: ClaudeTokenUsageThresholds = {
    caution: { tokens: 5000 },
    warning: { tokens: 5000 },
  };
  const v = validateThresholds(same);
  assert.equal(v.ok, false, '동일값도 reject');
  assert.match(v.error ?? '', /토큰/);
});

test('parseThresholdInput — tokens 는 정수(Math.floor), usd 는 소수점 유지', () => {
  const out = parseThresholdInput({ tokens: '1234.9', usd: '0.375' });
  assert.equal(out.tokens, 1234, 'tokens 는 Math.floor 로 정수화');
  assert.equal(out.usd, 0.375, 'usd 는 소수점 그대로 보존');
});

test('parseThresholdInput — Infinity/NaN 같은 비정상 실수는 미설정 처리', () => {
  assert.deepEqual(parseThresholdInput({ tokens: 'Infinity', usd: 'NaN' }), {});
  assert.deepEqual(parseThresholdInput({ tokens: '1e309', usd: '-Infinity' }), {},
    '숫자로 파싱되더라도 Number.isFinite 조건을 통과 못하면 미설정');
});
