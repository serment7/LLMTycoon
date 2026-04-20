// Run with: npx tsx --test tests/tokenUsageUi.unit.test.ts
//
// 지시 #17e58c0f — 토큰 사용량 가시화 UI 의 순수 로직 계약.
//
// 본 스위트는 React 없이 포매터·파생 계산·정규화만 잠근다. 컴포넌트 DOM 회귀는
// 후속 PR 의 jsdom/RTL 스모크에서 다룬다(본 파일은 빠르고 결정론적으로 유지).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSegmentRatios,
  computeUsageRatio,
  formatCompactTokens,
  formatInteger,
  formatPercent,
  normalizeSparkline,
  type TokenUsageSnapshot,
} from '../src/ui/tokenFormatting.ts';

// ─── 포매터 ─────────────────────────────────────────────────────────────────

test('F1. formatInteger — 로캘별 구분자 적용 + 음수/NaN 은 0', () => {
  assert.equal(formatInteger(12345, 'en'), '12,345');
  assert.equal(formatInteger(12345, 'ko'), '12,345');
  assert.equal(formatInteger(-5, 'en'), '0');
  assert.equal(formatInteger(Number.NaN, 'ko'), '0');
});

test('F2. formatCompactTokens — 1000 미만은 정수, 1000 이상은 K/M 축약 + 1 소수', () => {
  assert.equal(formatCompactTokens(942, 'en'), '942');
  assert.equal(formatCompactTokens(1234, 'en'), '1.2K');
  assert.equal(formatCompactTokens(9999, 'en'), '10.0K'.replace('10.0', '10.0') || '10.0K');
  // 9999 → 10.0K(실제로는 반올림으로 10.0K).
  assert.ok(formatCompactTokens(9999, 'en').endsWith('K'));
  assert.equal(formatCompactTokens(12_000, 'en'), '12K');
  assert.equal(formatCompactTokens(3_400_000, 'en'), '3.4M');
  assert.equal(formatCompactTokens(2_000_000_000, 'en'), '2.0B');
});

test('F3. formatCompactTokens — 10 이상은 정수 자리, 10 미만은 소수 1자리', () => {
  assert.equal(formatCompactTokens(9_999, 'en'), '10.0K');
  assert.equal(formatCompactTokens(10_000, 'en'), '10K');
  assert.equal(formatCompactTokens(1_000, 'en'), '1.0K');
});

test('F4. formatPercent — 0~1 범위를 % 포맷, 범위 초과는 클램프', () => {
  assert.equal(formatPercent(0.73, 'en'), '73%');
  assert.equal(formatPercent(1.5, 'en'), '100%');
  assert.equal(formatPercent(-1, 'ko'), '0%');
  assert.equal(formatPercent(Number.NaN, 'en'), '0%');
});

// ─── 파생 계산 ──────────────────────────────────────────────────────────────

test('R1. computeUsageRatio — sessionLimit 없으면 null', () => {
  const snap: TokenUsageSnapshot = { input: 10, output: 20, cacheHit: 5 };
  assert.equal(computeUsageRatio(snap), null);
});

test('R2. computeUsageRatio — input+output 기준이며 1 을 넘지 않는다', () => {
  assert.equal(
    computeUsageRatio({ input: 100, output: 100, cacheHit: 9999, sessionLimit: 400 }),
    0.5,
  );
  assert.equal(
    computeUsageRatio({ input: 500, output: 500, cacheHit: 0, sessionLimit: 400 }),
    1,
  );
});

test('R3. computeSegmentRatios — 합이 0 이면 0/0/0, 아니면 합=1', () => {
  assert.deepEqual(computeSegmentRatios({ input: 0, output: 0, cacheHit: 0 }), {
    input: 0,
    output: 0,
    cacheHit: 0,
  });
  const r = computeSegmentRatios({ input: 2, output: 3, cacheHit: 5 });
  assert.ok(Math.abs(r.input + r.output + r.cacheHit - 1) < 1e-9);
  assert.ok(Math.abs(r.cacheHit - 0.5) < 1e-9);
});

test('R4. computeSegmentRatios — 음수는 0 으로 클램프', () => {
  const r = computeSegmentRatios({ input: -10, output: 5, cacheHit: 5 });
  assert.equal(r.input, 0);
  assert.ok(Math.abs(r.output - 0.5) < 1e-9);
});

// ─── 스파크라인 ─────────────────────────────────────────────────────────────

test('S1. normalizeSparkline — 빈 배열 그대로, 모두 같은 값은 0.5 수평선', () => {
  assert.deepEqual(normalizeSparkline([]), []);
  assert.deepEqual(
    normalizeSparkline([
      { at: 'a', total: 5 },
      { at: 'b', total: 5 },
      { at: 'c', total: 5 },
    ]),
    [0.5, 0.5, 0.5],
  );
});

test('S2. normalizeSparkline — min=0 / max=1 로 정규화', () => {
  const out = normalizeSparkline([
    { at: 'a', total: 10 },
    { at: 'b', total: 20 },
    { at: 'c', total: 30 },
  ]);
  assert.deepEqual(out, [0, 0.5, 1]);
});

test('S3. normalizeSparkline — 음수는 0 으로 클램프', () => {
  const out = normalizeSparkline([
    { at: 'a', total: -5 },
    { at: 'b', total: 10 },
  ]);
  assert.deepEqual(out, [0, 1]);
});
