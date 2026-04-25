// 지시 #0c066697 — useOverflowMenu 임계값 가드 / 측정 그리디 / 브레이크포인트 회귀.
//
// 테스트 시나리오:
//   1) 모든 항목이 들어가면 overflow=0, 트리거 없음.
//   2) 한 항목이 빠져 트리거가 들어서면 budget 에서 트리거+gap 을 빼고 다시 채운다.
//   3) hideBelowPx 임계가 컨테이너 폭보다 크면 측정 그리디 이전에 강제 더보기로 분류.
//   4) hideBelowPx 미설정 항목은 임계 가드 없이 그리디만 적용.
//   5) resolveBreakpoint — 1280/960/720/0 경계.
//   6) 비어 있는 입력은 EMPTY_STATE.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeOverflowMenu,
  resolveBreakpoint,
  type OverflowMenuItem,
} from '../src/hooks/useOverflowMenu';

const items = (...arr: Array<Partial<OverflowMenuItem> & { id: string; width: number }>): OverflowMenuItem[] =>
  arr.map(a => ({ id: a.id, label: a.label ?? a.id, width: a.width, hideBelowPx: a.hideBelowPx }));

test('1) 모두 수용 — overflow 비고 트리거 미예약', () => {
  const r = computeOverflowMenu({
    containerWidth: 600,
    items: items({ id: 'a', width: 100 }, { id: 'b', width: 100 }),
    overflowTriggerWidth: 40,
    gap: 8,
  });
  assert.deepEqual(r.visibleItems.map(i => i.id), ['a', 'b']);
  assert.equal(r.overflowItems.length, 0);
});

test('2) 한 항목이 빠지면 트리거 폭을 빼고 재채움', () => {
  // 200 폭에 100/100/100 + gap 8 → naive 채움이 a(100) + 8 + b(100) = 208 > 200 으로 b 직전에 컷.
  // 트리거(40) + gap(8) 예약 → budget=152 → a(100) 만 채워지고 b/c 가 더보기로.
  const r = computeOverflowMenu({
    containerWidth: 200,
    items: items({ id: 'a', width: 100 }, { id: 'b', width: 100 }, { id: 'c', width: 100 }),
    overflowTriggerWidth: 40,
    gap: 8,
  });
  assert.deepEqual(r.visibleItems.map(i => i.id), ['a']);
  assert.deepEqual(r.overflowItems.map(i => i.id), ['b', 'c']);
});

test('3) hideBelowPx 임계 — 컨테이너 폭이 임계 미만이면 강제 더보기', () => {
  const r = computeOverflowMenu({
    containerWidth: 500,
    items: items(
      { id: 'token', width: 200 },
      { id: 'lang', width: 120, hideBelowPx: 720 },
    ),
    overflowTriggerWidth: 40,
    gap: 8,
  });
  // token 은 항상 visible, lang 은 임계 가드로 강제 overflow.
  assert.deepEqual(r.visibleItems.map(i => i.id), ['token']);
  assert.deepEqual(r.overflowItems.map(i => i.id), ['lang']);
});

test('4) hideBelowPx 충족 시 측정 그리디만 적용', () => {
  const r = computeOverflowMenu({
    containerWidth: 800,
    items: items(
      { id: 'token', width: 200 },
      { id: 'lang', width: 120, hideBelowPx: 720 },
    ),
    overflowTriggerWidth: 40,
    gap: 8,
  });
  // 800 ≥ 720 → 임계 가드 통과. 200 + 8 + 120 = 328 ≤ 800 → 둘 다 visible.
  assert.deepEqual(r.visibleItems.map(i => i.id), ['token', 'lang']);
  assert.equal(r.overflowItems.length, 0);
});

test('5) resolveBreakpoint — 1280/960/720/0 경계', () => {
  assert.equal(resolveBreakpoint(1400), 1280);
  assert.equal(resolveBreakpoint(1280), 1280);
  assert.equal(resolveBreakpoint(1279), 960);
  assert.equal(resolveBreakpoint(960), 960);
  assert.equal(resolveBreakpoint(959), 720);
  assert.equal(resolveBreakpoint(720), 720);
  assert.equal(resolveBreakpoint(719), 0);
  assert.equal(resolveBreakpoint(0), 0);
  assert.equal(resolveBreakpoint(-10), 0);
  assert.equal(resolveBreakpoint(Number.NaN), 0);
});

test('6) 빈 items 또는 width=0 → 빈 상태', () => {
  const empty = computeOverflowMenu({ containerWidth: 0, items: items({ id: 'a', width: 100 }) });
  assert.equal(empty.visibleItems.length, 0);
  assert.equal(empty.overflowItems.length, 0);
  const noItems = computeOverflowMenu({ containerWidth: 800, items: [] });
  assert.equal(noItems.visibleItems.length, 0);
  assert.equal(noItems.overflowItems.length, 0);
});

test('7) 입력 순서 보존 — visibleItems 와 overflowItems 모두 원본 순서', () => {
  const r = computeOverflowMenu({
    containerWidth: 300,
    items: items(
      { id: 'a', width: 100, hideBelowPx: 0 },
      { id: 'b', width: 100, hideBelowPx: 720 },
      { id: 'c', width: 100, hideBelowPx: 0 },
    ),
    overflowTriggerWidth: 40,
    gap: 8,
  });
  // b 는 hideBelowPx 로 강제 더보기. 측정 그리디는 a(100) + 8 + c(100) = 208 → budget=300-40-8=252 → 둘 다 들어감.
  // overflow 순서는 [측정 컷 → forced]. 본 케이스에선 측정 컷 없음이라 forced(b) 만.
  assert.deepEqual(r.visibleItems.map(i => i.id), ['a', 'c']);
  assert.deepEqual(r.overflowItems.map(i => i.id), ['b']);
});
