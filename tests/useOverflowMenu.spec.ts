// Run with: npx tsx --test tests/useOverflowMenu.spec.ts
//
// 지시 #50e356dd — 상단 툴바 반응형(useOverflowMenu) 회귀 잠금.
//
// 검증 계약
//   (1) 컨테이너 폭 1400/1100/800/600px 에서 노출/오버플로우 분기가 가이드대로
//       유지된다(180px·gap=8px·trigger=80px 표준 항목).
//   (2) 항목 추가/제거 시 같은 컨테이너 폭에서도 분기가 즉시 재계산된다.
//   추가 경계: 빈 목록, 0px 컨테이너, 1개 항목, 모두 들어가는 경우.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeOverflowMenu,
  resolveBreakpoint,
  type OverflowMenuItem,
} from '../src/hooks/useOverflowMenu.ts';

// ────────────────────────────────────────────────────────────────────────────
// 표준 fixture — 상단 툴바의 6개 액션을 모사한다.
//   · 폭 180px / 항목 사이 gap 8px / "더보기" 트리거 80px
//   · 6개 합계 1120px(180*6 + 8*5) — 1400px 안에는 들어가지만 1100px 부터 압박.
// ────────────────────────────────────────────────────────────────────────────
const ITEM_WIDTH = 180;
const GAP = 8;
const TRIGGER_WIDTH = 80;

const SIX_ITEMS: readonly OverflowMenuItem[] = [
  { id: 'project',  label: '프로젝트',     width: ITEM_WIDTH },
  { id: 'token',    label: '토큰 사용량',   width: ITEM_WIDTH },
  { id: 'agents',   label: '에이전트',      width: ITEM_WIDTH },
  { id: 'media',    label: '미디어',         width: ITEM_WIDTH },
  { id: 'git',      label: '깃 자동화',     width: ITEM_WIDTH },
  { id: 'settings', label: '설정',           width: ITEM_WIDTH },
];

function run(containerWidth: number, items: readonly OverflowMenuItem[] = SIX_ITEMS) {
  return computeOverflowMenu({
    containerWidth,
    items,
    overflowTriggerWidth: TRIGGER_WIDTH,
    gap: GAP,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// (1) 1400/1100/800/600px 분기
// ────────────────────────────────────────────────────────────────────────────

test('1. 1400px — 6개 항목 모두 노출, 오버플로우 없음', () => {
  const r = run(1400);
  assert.equal(r.visibleItems.length, 6);
  assert.equal(r.overflowItems.length, 0);
  // 트리거를 예약하지 않은 1단계 분기 — consumed 는 1120(=180*6+8*5).
  assert.equal(r.consumedWidth, 1120);
});

test('1-2. 1100px — 5개 노출 + 1개 오버플로우', () => {
  const r = run(1100);
  assert.equal(r.visibleItems.length, 5);
  assert.equal(r.overflowItems.length, 1);
  assert.deepEqual(
    r.visibleItems.map(i => i.id),
    ['project', 'token', 'agents', 'media', 'git'],
  );
  assert.equal(r.overflowItems[0].id, 'settings', '마지막 항목이 더보기로 밀려야 한다');
});

test('1-3. 800px — 3개 노출 + 3개 오버플로우', () => {
  const r = run(800);
  assert.equal(r.visibleItems.length, 3);
  assert.equal(r.overflowItems.length, 3);
  assert.deepEqual(
    r.overflowItems.map(i => i.id),
    ['media', 'git', 'settings'],
    '뒤쪽 3개가 더보기로 밀린다 — 입력 순서 보존',
  );
});

test('1-4. 600px — 2개 노출 + 4개 오버플로우', () => {
  const r = run(600);
  assert.equal(r.visibleItems.length, 2);
  assert.equal(r.overflowItems.length, 4);
});

// 분기 경계가 1400→1100→800→600 순으로 단조 감소하는지 잠근다 — 누군가 알고리즘을
// 바꾸어 중간 폭에서 visible 이 늘어나는 회귀를 막는다.
test('1-5. 폭이 줄어들수록 visible 항목 수는 단조 감소한다', () => {
  const widths = [1400, 1100, 800, 600];
  const visibleCounts = widths.map(w => run(w).visibleItems.length);
  for (let i = 1; i < visibleCounts.length; i++) {
    assert.ok(
      visibleCounts[i] <= visibleCounts[i - 1],
      `width ${widths[i]} 의 visible(${visibleCounts[i]}) 이 이전(${visibleCounts[i - 1]})보다 크면 안 된다`,
    );
  }
});

// ────────────────────────────────────────────────────────────────────────────
// (2) 항목 추가/제거 시 즉시 재계산
// ────────────────────────────────────────────────────────────────────────────

test('2. 같은 800px 에서 항목 4→6 으로 늘리면 visible/overflow 가 재계산된다', () => {
  const four = SIX_ITEMS.slice(0, 4);
  const before = run(800, four);
  // 4개 합계 744 ≤ 800 → 모두 들어간다.
  assert.equal(before.visibleItems.length, 4);
  assert.equal(before.overflowItems.length, 0);

  const after = run(800, SIX_ITEMS);
  // 6개로 늘면 트리거 예약(720 budget) 으로 3개만 살아남는다.
  assert.equal(after.visibleItems.length, 3);
  assert.equal(after.overflowItems.length, 3);
});

test('2-2. 같은 800px 에서 항목 6→2 로 줄이면 오버플로우가 사라진다', () => {
  const before = run(800, SIX_ITEMS);
  assert.ok(before.overflowItems.length > 0);

  const after = run(800, SIX_ITEMS.slice(0, 2));
  // 2개 합계 368 ≤ 800 → 트리거 없이 모두 들어가야 한다.
  assert.equal(after.visibleItems.length, 2);
  assert.equal(after.overflowItems.length, 0);
});

test('2-3. 가운데 항목을 제거해도 입력 순서가 보존된 채 재계산된다', () => {
  const without3rd = SIX_ITEMS.filter(i => i.id !== 'agents');
  const r = run(1100, without3rd);
  // 5개 합계 932 ≤ 1100 → 트리거 없이 모두 들어가야 한다.
  assert.equal(r.visibleItems.length, 5);
  assert.equal(r.overflowItems.length, 0);
  assert.deepEqual(
    r.visibleItems.map(i => i.id),
    ['project', 'token', 'media', 'git', 'settings'],
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 경계 — 빈 목록, 0px, 1개 항목
// ────────────────────────────────────────────────────────────────────────────

test('E1. 항목 0개 — visible/overflow 모두 빈 배열', () => {
  const r = run(1200, []);
  assert.deepEqual(r.visibleItems, []);
  assert.deepEqual(r.overflowItems, []);
  assert.equal(r.consumedWidth, 0);
});

test('E2. 컨테이너 폭 0 — 항목이 있어도 visible 은 비고 모두 overflow 처리되지 않는다', () => {
  const r = run(0);
  // 0px 환경(SSR 첫 렌더 등)은 측정 전이므로, 안전하게 빈 결과를 돌려주는 계약.
  assert.deepEqual(r.visibleItems, []);
  assert.deepEqual(r.overflowItems, []);
});

test('E3. 1개 항목이 컨테이너에 들어가면 트리거 예약 없이 그대로 노출', () => {
  const single: OverflowMenuItem[] = [{ id: 'only', label: '단일', width: 180 }];
  const r = run(300, single);
  assert.equal(r.visibleItems.length, 1);
  assert.equal(r.overflowItems.length, 0);
  assert.equal(r.consumedWidth, 180);
});

test('E4. 1개 항목이 컨테이너보다 크면 — visible 은 비고 그 항목이 overflow 로', () => {
  const single: OverflowMenuItem[] = [{ id: 'huge', label: '큰 항목', width: 500 }];
  const r = run(300, single);
  assert.equal(r.visibleItems.length, 0);
  assert.equal(r.overflowItems.length, 1);
});

// ────────────────────────────────────────────────────────────────────────────
// 임계값 기반 강제 분기(hideBelowPx) — Thanos 의 후속 추가(#0c066697)
// ────────────────────────────────────────────────────────────────────────────

test('T1. hideBelowPx 가 지정된 항목은 폭 미만이면 측정값과 무관하게 overflow', () => {
  const items: OverflowMenuItem[] = [
    { id: 'project',  label: '프로젝트', width: 180 },
    { id: 'token',    label: '토큰',     width: 180, hideBelowPx: 1280 },
    { id: 'settings', label: '설정',     width: 180 },
  ];
  // 1100px 컨테이너 — 합계 540 + gap 16 = 556 으로 모두 들어가지만, hideBelowPx
  // 1280 임계가 token 을 강제로 overflow 로 보낸다. 입력 순서는 보존돼야 한다.
  const r = computeOverflowMenu({
    containerWidth: 1100,
    items,
    overflowTriggerWidth: TRIGGER_WIDTH,
    gap: GAP,
  });
  assert.deepEqual(r.visibleItems.map(i => i.id), ['project', 'settings']);
  assert.deepEqual(r.overflowItems.map(i => i.id), ['token']);
});

test('T2. hideBelowPx 임계 이상이면 일반 그리디만 동작 — 강제 overflow 없음', () => {
  const items: OverflowMenuItem[] = [
    { id: 'a', label: 'A', width: 180, hideBelowPx: 720 },
    { id: 'b', label: 'B', width: 180 },
  ];
  const r = computeOverflowMenu({ containerWidth: 1100, items, gap: GAP });
  assert.equal(r.visibleItems.length, 2);
  assert.equal(r.overflowItems.length, 0);
});

test('T3. resolveBreakpoint — 1280/960/720/0 임계와 정렬', () => {
  assert.equal(resolveBreakpoint(1600), 1280);
  assert.equal(resolveBreakpoint(1280), 1280);
  assert.equal(resolveBreakpoint(1279), 960);
  assert.equal(resolveBreakpoint(960), 960);
  assert.equal(resolveBreakpoint(959), 720);
  assert.equal(resolveBreakpoint(720), 720);
  assert.equal(resolveBreakpoint(719), 0);
  assert.equal(resolveBreakpoint(0), 0);
  assert.equal(resolveBreakpoint(-100), 0);
  assert.equal(resolveBreakpoint(Number.NaN), 0);
});
