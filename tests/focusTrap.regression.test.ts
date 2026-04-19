// Run with: npx tsx --test tests/focusTrap.regression.test.ts
//
// QA: 지시 #3e91c3da — 공용 포커스 트랩 유틸 회귀.
// SharedGoalModal 의 내부 구현은 본 유틸로 옮기지 않고 후속 모달들이 참조할 공용
// 순수 함수 계약만 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TABBABLE_SELECTORS,
  computeNextFocusIndex,
  toQuerySelector,
} from '../src/utils/focusTrap.ts';

test('TABBABLE_SELECTORS — W3C 기본 집합을 포함한다', () => {
  for (const s of [
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ]) {
    assert.ok(TABBABLE_SELECTORS.includes(s), `${s} 선택기가 포함되어야 한다`);
  }
});

test('TABBABLE_SELECTORS — tabindex="-1" 는 루트 선택기로 허용되지 않는다', () => {
  // `:not(...)` 내부에 `tabindex="-1"` 가 들어가는 것은 정상 패턴(해당 선택기 제외 용).
  // 본 검증은 `:not(...)` 블록을 제거한 뒤 루트 선택기에 `[tabindex="-1"]` 가 독립으로
  // 남아 있지 않은지만 확인한다.
  for (const s of TABBABLE_SELECTORS) {
    const withoutNot = s.replace(/:not\([^)]*\)/g, '');
    assert.ok(!/\[tabindex="?-1"?\]/.test(withoutNot),
      `루트 선택기에 [tabindex="-1"] 가 남아 있으면 프로그램적 포커스 전용 요소까지 포커스된다: ${s}`);
  }
});

test('computeNextFocusIndex — forward 순환(마지막→0)', () => {
  assert.equal(computeNextFocusIndex(0, 3, 'forward'), 1);
  assert.equal(computeNextFocusIndex(1, 3, 'forward'), 2);
  assert.equal(computeNextFocusIndex(2, 3, 'forward'), 0);
});

test('computeNextFocusIndex — backward 순환(0→마지막)', () => {
  assert.equal(computeNextFocusIndex(2, 3, 'backward'), 1);
  assert.equal(computeNextFocusIndex(1, 3, 'backward'), 0);
  assert.equal(computeNextFocusIndex(0, 3, 'backward'), 2);
});

test('computeNextFocusIndex — total=0 이면 -1 반환', () => {
  assert.equal(computeNextFocusIndex(0, 0, 'forward'), -1);
  assert.equal(computeNextFocusIndex(-1, 0, 'backward'), -1);
});

test('computeNextFocusIndex — currentIndex=-1(초기) 은 진입점 선택', () => {
  assert.equal(computeNextFocusIndex(-1, 4, 'forward'), 0, 'forward 초기 진입은 0');
  assert.equal(computeNextFocusIndex(-1, 4, 'backward'), 3, 'backward 초기 진입은 total-1');
});

test('computeNextFocusIndex — NaN/비유한 currentIndex 도 초기 진입으로 처리', () => {
  assert.equal(computeNextFocusIndex(Number.NaN, 5, 'forward'), 0);
  assert.equal(computeNextFocusIndex(Number.POSITIVE_INFINITY, 5, 'backward'), 4);
});

test('computeNextFocusIndex — total 이 소수면 내림으로 정규화', () => {
  assert.equal(computeNextFocusIndex(2, 3.9, 'forward'), 0, 'total=3 으로 내림 후 순환');
});

test('computeNextFocusIndex — currentIndex 가 범위를 벗어나면 진입점으로 복귀', () => {
  assert.equal(computeNextFocusIndex(-5, 3, 'forward'), 0);
  assert.equal(computeNextFocusIndex(-5, 3, 'backward'), 2);
});

test('toQuerySelector — 공백·빈 항목을 걸러내고 쉼표로 결합', () => {
  assert.equal(toQuerySelector(['button', '', '  ', 'input']), 'button, input');
});

test('toQuerySelector — TABBABLE_SELECTORS 를 그대로 넘겨 유효한 CSS 셀렉터 문자열을 만든다', () => {
  const out = toQuerySelector(TABBABLE_SELECTORS);
  assert.match(out, /button:not\(\[disabled\]\)/);
  assert.match(out, /\[tabindex\]:not\(\[tabindex="-1"\]\)/);
  assert.ok(out.split(',').length >= 8, '선택기가 쉼표로 다수 결합되어야 한다');
});
