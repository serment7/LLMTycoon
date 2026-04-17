// Run with: tsx --test src/utils/zoomMath.test.ts
//
// 감마(QA) 줌 기능 테스트 케이스. 5개 시나리오:
//   (1) 캔버스 좌상단/중앙/우하단에서 휠 줌 시 마우스 포인터 아래 요소가 고정
//   (2) 연속 줌 인/아웃 후 원위치 복귀 정확도
//   (3) 최소/최대 줌 경계값 동작
//   (4) 터치패드 핀치 줌 호환성
//   (5) 팬 이동 후 줌 동작 정상 여부
//
// 추가로 App.tsx 의 휠 핸들러가 동일 상수(WHEEL_ZOOM_STEP/MIN_ZOOM/MAX_ZOOM)를
// 사용하는지 소스 수준에서 고정해, 헬퍼와 실제 핸들러가 따로 표류하지 않도록 한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MIN_ZOOM,
  MAX_ZOOM,
  WHEEL_ZOOM_STEP,
  clampZoom,
  applyWheelZoom,
  applyPinchZoom,
  computeCursorAnchoredPan,
  computeCursorAnchoredPanTopLeft,
  clientToCanvas,
  screenToWorld,
  Point,
} from './zoomMath.ts';

const APP_SRC = readFileSync(
  fileURLToPath(new URL('../App.tsx', import.meta.url)),
  'utf8',
);

// 부동소수 누적 오차 허용치. 줌 한 단계 0.1 이 IEEE-754 로 정확히 표현되지 않으므로
// 라운드트립 누적은 1e-9 수준의 잡음을 허용한다.
const EPS = 1e-9;

function approx(actual: number, expected: number, eps = EPS): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ≈ ${expected}, got ${actual} (Δ=${Math.abs(actual - expected)})`,
  );
}

function approxPoint(actual: Point, expected: Point, eps = 1e-6): void {
  approx(actual.x, expected.x, eps);
  approx(actual.y, expected.y, eps);
}

// ─── 사전 점검: App.tsx 와 헬퍼 상수가 일치 ─────────────────────────────

test('App.tsx handleWheel 이 헬퍼와 동일한 클램프 [0.5, 3] 을 사용', () => {
  // 두 곳의 상수가 어긋나면 휠 핸들러 거동과 헬퍼 기반 QA 가 따로 논다.
  // prev/prevZoom 같은 지역 변수명 변경을 허용하되 경계 상수 0.5/3 은 고정.
  assert.match(APP_SRC, /Math\.max\(0\.5,\s*Math\.min\(3,\s*\w+\s*\+\s*delta\)\)/);
  assert.equal(MIN_ZOOM, 0.5);
  assert.equal(MAX_ZOOM, 3);
});

test('App.tsx handleWheel 의 휠 한 노치 변화량이 헬퍼 WHEEL_ZOOM_STEP 과 일치', () => {
  assert.match(APP_SRC, /e\.deltaY\s*>\s*0\s*\?\s*-0\.1\s*:\s*0\.1/);
  assert.equal(WHEEL_ZOOM_STEP, 0.1);
});

test('App.tsx handleWheel: 커서 위치 기반 팬 보정이 들어 있다(케이스 1 가드)', () => {
  // getBoundingClientRect 로 마우스 좌표를 잡고 worldX/worldY 를 계산해
  // newPan = mouse - world * newZoom 형태로 보정해야 "포인터 아래 요소 고정"
  // 계약이 성립한다. 이 블록이 사라지면 줌이 단순 스케일로 회귀하면서
  // 코너 줌 시 콘텐츠가 미끄러지는 증상이 재발한다.
  assert.match(APP_SRC, /getBoundingClientRect/);
  assert.match(APP_SRC, /const\s+worldX\s*=\s*\(mouseX\s*-\s*pan\.x\)\s*\/\s*prevZoom/);
  assert.match(APP_SRC, /const\s+worldY\s*=\s*\(mouseY\s*-\s*pan\.y\)\s*\/\s*prevZoom/);
  assert.match(APP_SRC, /x:\s*mouseX\s*-\s*worldX\s*\*\s*newZoom/);
  assert.match(APP_SRC, /y:\s*mouseY\s*-\s*worldY\s*\*\s*newZoom/);
});

test('App.tsx handleWheel: 클램프 결과가 변하지 않으면 setPan 도 호출하지 않음', () => {
  // 경계(0.5/3)에서 추가 휠을 굴려도 newZoom === prevZoom 이면 pan 갱신을
  // 막아야 "줌 안 되는데 화면이 흘러내리는" 회귀를 방지한다.
  assert.match(APP_SRC, /if\s*\(\s*newZoom\s*===\s*prevZoom\s*\)\s*return;/);
});

test('회귀: handleWheel 의 좌표 원점과 transform 의 transformOrigin 이 일치', () => {
  // handleWheel 은 mouseX = clientX - rect.left, worldX = (mouseX - pan.x)/zoom 으로
  // 좌표를 풀므로 "transform 의 원점이 컨테이너 좌상단(0,0)" 이라는 가정을 깔고 있다.
  // CSS transformOrigin 이 'center center' 면 시각적 줌 중심과 수식 상의 원점이
  // 어긋나, 코너로 갈수록 포인터 아래 요소가 점점 미끄러지는 회귀가 발생한다.
  // 두 좌표계가 같다는 사실을 명시 고정해 한쪽만 변경되는 사고를 막는다.
  const transformOriginMatch = APP_SRC.match(/transformOrigin:\s*'([^']+)'/);
  assert.ok(transformOriginMatch, 'transformOrigin 선언을 찾지 못함');
  assert.equal(
    transformOriginMatch[1],
    '0 0',
    `handleWheel 의 좌상단 기준 좌표계와 일치하려면 transformOrigin 이 '0 0' 이어야 한다 (현재: '${transformOriginMatch[1]}')`,
  );
});

// ─── (3) 최소/최대 줌 경계값 ────────────────────────────────────────────

test('clampZoom: [MIN_ZOOM, MAX_ZOOM] 범위 밖 입력은 경계로 끌어온다', () => {
  assert.equal(clampZoom(0), MIN_ZOOM);
  assert.equal(clampZoom(-100), MIN_ZOOM);
  assert.equal(clampZoom(MAX_ZOOM + 5), MAX_ZOOM);
  assert.equal(clampZoom(NaN), MIN_ZOOM);
  // 경계 자체는 그대로 통과해야 "정확히 0.5/3 에서 멈춤" 보장이 성립한다.
  assert.equal(clampZoom(MIN_ZOOM), MIN_ZOOM);
  assert.equal(clampZoom(MAX_ZOOM), MAX_ZOOM);
});

test('applyWheelZoom: 최소 경계에서 추가 축소 호출 시 더 내려가지 않음', () => {
  let z = MIN_ZOOM;
  for (let i = 0; i < 20; i++) z = applyWheelZoom(z, +100);
  assert.equal(z, MIN_ZOOM);
});

test('applyWheelZoom: 최대 경계에서 추가 확대 호출 시 더 올라가지 않음', () => {
  let z = MAX_ZOOM;
  for (let i = 0; i < 20; i++) z = applyWheelZoom(z, -100);
  assert.equal(z, MAX_ZOOM);
});

// ─── (2) 연속 줌 인/아웃 라운드트립 정확도 ─────────────────────────────

test('applyWheelZoom: N번 인 → N번 아웃 시 원래 줌으로 복귀(부동소수 허용)', () => {
  // 1.0 에서 +5 노치 후 -5 노치. 0.1 의 누적 오차가 가시화되지 않는지 확인.
  let z = 1;
  for (let i = 0; i < 5; i++) z = applyWheelZoom(z, -1); // 확대
  for (let i = 0; i < 5; i++) z = applyWheelZoom(z, +1); // 축소
  approx(z, 1);
});

test('applyWheelZoom: 경계를 한번 찍고 돌아온 라운드트립도 깨끗히 복귀', () => {
  // 최대까지 올렸다가 다시 내리기. 클램프에 막혀서 잃은 노치 수만큼만 빼야 한다.
  let z = 1;
  // 1 → 3 까지 올리려면 20노치, 여유분 5노치 더 시도해도 3에 머물러야 한다.
  for (let i = 0; i < 25; i++) z = applyWheelZoom(z, -1);
  approx(z, MAX_ZOOM);
  // 3 → 1 로 내려오려면 20노치 필요.
  for (let i = 0; i < 20; i++) z = applyWheelZoom(z, +1);
  approx(z, 1);
});

// ─── (1) 커서 고정 줌: 좌상단/중앙/우하단 ─────────────────────────────

test('computeCursorAnchoredPan: 커서가 origin 과 일치해도 world 고정 계약은 유지', () => {
  // transformOrigin 이 스크린 상에서 고정이라는 모델에서, cursor==origin 일 때
  // 화면 origin 점에 찍힌 "월드 좌표"는 pan/zoom 에 따라 달라지므로
  // 단순히 팬이 보존될 필요는 없다. 본질 계약(월드 고정)만 검증한다.
  const origin = { x: 100, y: 100 };
  const prevPan = { x: 50, y: -30 };
  const prevZoom = 1;
  const nextZoom = 2;
  const nextPan = computeCursorAnchoredPan(prevZoom, nextZoom, prevPan, origin, origin);
  const wPrev = screenToWorld(origin, prevPan, prevZoom, origin);
  const wNext = screenToWorld(origin, nextPan, nextZoom, origin);
  approxPoint(wNext, wPrev);
});

test('컨테이너 중앙(=origin)에서 휠 줌해도 포인터 아래 월드 좌표가 그대로', () => {
  // 1000x600 캔버스. transformOrigin: center center → origin = (500, 300).
  const origin = { x: 500, y: 300 };
  const cursor = { x: 500, y: 300 };
  const prevPan = { x: 0, y: 0 };
  const prevZoom = 1;
  const nextZoom = applyWheelZoom(prevZoom, -1); // 1 → 1.1
  const nextPan = computeCursorAnchoredPan(prevZoom, nextZoom, prevPan, cursor, origin);
  const wPrev = screenToWorld(cursor, prevPan, prevZoom, origin);
  const wNext = screenToWorld(cursor, nextPan, nextZoom, origin);
  approxPoint(wNext, wPrev);
});

test('좌상단 코너에서 휠 줌 시 포인터 아래 월드 좌표가 고정된다', () => {
  // 캔버스 좌상단 (0, 0). origin 은 중앙. 코너에서 줌 인할 때
  // 포인터 아래 요소가 고정되려면 팬이 음의 방향으로 이동해야 한다.
  const origin = { x: 500, y: 300 };
  const cursor = { x: 0, y: 0 };
  const prevPan = { x: 0, y: 0 };
  const prevZoom = 1;
  const nextZoom = 1.5; // 직접 큰 폭으로 갱신 — 가시 효과 큼
  const nextPan = computeCursorAnchoredPan(prevZoom, nextZoom, prevPan, cursor, origin);
  const wPrev = screenToWorld(cursor, prevPan, prevZoom, origin);
  const wNext = screenToWorld(cursor, nextPan, nextZoom, origin);
  approxPoint(wNext, wPrev);
  // 좌상단에서 확대 시 팬은 양의 방향(콘텐츠를 우하단으로 밀어 좌상단 점이
  // 화면에 그대로 남게)이어야 한다. 부호 회귀 가드.
  assert.ok(nextPan.x > 0, `좌상단 확대 시 panX > 0 이어야 함 (got ${nextPan.x})`);
  assert.ok(nextPan.y > 0, `좌상단 확대 시 panY > 0 이어야 함 (got ${nextPan.y})`);
});

test('우하단 코너에서 휠 줌 시 포인터 아래 월드 좌표가 고정된다', () => {
  const origin = { x: 500, y: 300 };
  const cursor = { x: 1000, y: 600 };
  const prevPan = { x: 0, y: 0 };
  const prevZoom = 1;
  const nextZoom = 1.5;
  const nextPan = computeCursorAnchoredPan(prevZoom, nextZoom, prevPan, cursor, origin);
  const wPrev = screenToWorld(cursor, prevPan, prevZoom, origin);
  const wNext = screenToWorld(cursor, nextPan, nextZoom, origin);
  approxPoint(wNext, wPrev);
  // 우하단 확대는 콘텐츠를 좌상단 방향으로 끌어와야 한다.
  assert.ok(nextPan.x < 0, `우하단 확대 시 panX < 0 이어야 함 (got ${nextPan.x})`);
  assert.ok(nextPan.y < 0, `우하단 확대 시 panY < 0 이어야 함 (got ${nextPan.y})`);
});

test('축소(줌 아웃) 시에도 포인터 아래 월드 좌표가 고정된다', () => {
  // 인 방향뿐 아니라 아웃 방향에서도 동일 계약이 성립해야 한다.
  const origin = { x: 500, y: 300 };
  const cursor = { x: 200, y: 100 };
  const prevPan = { x: 30, y: -10 };
  const prevZoom = 2;
  const nextZoom = applyWheelZoom(prevZoom, +1); // 2 → 1.9
  const nextPan = computeCursorAnchoredPan(prevZoom, nextZoom, prevPan, cursor, origin);
  const wPrev = screenToWorld(cursor, prevPan, prevZoom, origin);
  const wNext = screenToWorld(cursor, nextPan, nextZoom, origin);
  approxPoint(wNext, wPrev);
});

// ─── (4) 터치패드 핀치 줌 호환성 ───────────────────────────────────────

test('applyPinchZoom: scaleFactor 1 은 항등(현재 줌 보존)', () => {
  assert.equal(applyPinchZoom(1.7, 1), 1.7);
  assert.equal(applyPinchZoom(MIN_ZOOM, 1), MIN_ZOOM);
});

test('applyPinchZoom: 양수 배율은 그대로 곱하고 클램프 적용', () => {
  approx(applyPinchZoom(1, 1.5), 1.5);
  // 0.5 * 0.5 = 0.25 < MIN_ZOOM → 0.5 로 클램프.
  approx(applyPinchZoom(0.5, 0.5), MIN_ZOOM);
  // 2 * 2 = 4 > MAX_ZOOM → 3 으로 클램프.
  approx(applyPinchZoom(2, 2), MAX_ZOOM);
});

test('applyPinchZoom: 비정상 입력(0/음수/NaN)은 현재 줌 유지', () => {
  // 핀치 이벤트가 누락되거나 0이 들어와도 화면이 사라지지 않아야 한다.
  assert.equal(applyPinchZoom(1.5, 0), 1.5);
  assert.equal(applyPinchZoom(1.5, -1), 1.5);
  assert.equal(applyPinchZoom(1.5, NaN), 1.5);
});

test('핀치와 휠은 같은 [MIN_ZOOM, MAX_ZOOM] 범위로 수렴', () => {
  // 두 입력 경로가 다른 한계를 갖는다면 사용자가 입력 방식을 바꿀 때마다
  // 갑자기 줌이 튀는 사고가 난다. 두 경로가 공통 클램프를 거치는지 확인.
  let z = 1;
  for (let i = 0; i < 50; i++) z = applyPinchZoom(z, 2);
  assert.equal(z, MAX_ZOOM);
  for (let i = 0; i < 50; i++) z = applyWheelZoom(z, -1);
  assert.equal(z, MAX_ZOOM);
});

// ─── (5) 팬 이동 후 줌 동작 ─────────────────────────────────────────────

test('비제로 팬 상태에서도 커서 고정 줌 계약이 성립', () => {
  // 사용자가 캔버스를 끌어 옮긴(prevPan ≠ 0) 뒤 휠을 굴려도
  // 포인터 아래 월드 좌표는 여전히 고정되어야 한다.
  const origin = { x: 500, y: 300 };
  const cursor = { x: 720, y: 410 };
  const prevPan = { x: -180, y: 95 };
  const prevZoom = 1.4;
  const nextZoom = applyWheelZoom(prevZoom, -1);
  const nextPan = computeCursorAnchoredPan(prevZoom, nextZoom, prevPan, cursor, origin);
  const wPrev = screenToWorld(cursor, prevPan, prevZoom, origin);
  const wNext = screenToWorld(cursor, nextPan, nextZoom, origin);
  approxPoint(wNext, wPrev);
});

test('팬 → 줌 → 팬 → 줌 시퀀스에서 누적 오차가 픽셀 미만으로 유지', () => {
  // 실사용 시나리오: 사용자가 끌고-줌-끌고-줌을 번갈아 한다.
  // 매 줌 단계에서 커서 아래 월드 좌표가 유지되는지 단계별로 확인.
  const origin = { x: 500, y: 300 };
  let pan = { x: 0, y: 0 };
  let zoom = 1;
  const events: Array<{ cursor: Point; deltaY: number; panAfter: Point }> = [
    { cursor: { x: 100, y: 80 }, deltaY: -1, panAfter: { x: -40, y: 25 } },
    { cursor: { x: 800, y: 500 }, deltaY: -1, panAfter: { x: 30, y: -15 } },
    { cursor: { x: 450, y: 290 }, deltaY: +1, panAfter: { x: 0, y: 0 } },
  ];
  for (const ev of events) {
    const wBefore = screenToWorld(ev.cursor, pan, zoom, origin);
    const nextZoom = applyWheelZoom(zoom, ev.deltaY);
    const nextPan = computeCursorAnchoredPan(zoom, nextZoom, pan, ev.cursor, origin);
    const wAfter = screenToWorld(ev.cursor, nextPan, nextZoom, origin);
    approxPoint(wAfter, wBefore);
    // 사용자가 추가로 캔버스를 끌어 옮기는 단계.
    zoom = nextZoom;
    pan = ev.panAfter;
  }
});

test('회귀: prevZoom == nextZoom 인 noop 호출은 팬을 건드리지 않음', () => {
  // 클램프에 막혀 줌이 변하지 않은 경우(예: MAX_ZOOM 에서 추가 확대 호출),
  // 팬까지 흔들면 사용자가 "줌 안되는데 화면이 흘러내리는" 증상을 겪는다.
  const origin = { x: 500, y: 300 };
  const pan = { x: 12, y: -34 };
  const next = computeCursorAnchoredPan(MAX_ZOOM, MAX_ZOOM, pan, { x: 700, y: 200 }, origin);
  approxPoint(next, pan);
});

// ─── 감마 할당 업무: 줌-아웃 전용 경계 회귀 ─────────────────────────────
//
// 배경: 기존 케이스는 "좌상단/우하단에서 확대 시 고정" 에 초점을 맞춘다.
// 실제 사용자 민원은 주로 "휠을 아래로 굴려 축소할 때" 발생한다
// (deltaY>0, nextZoom < prevZoom). 축소 방향은 팬 공식의 부호가 반대로
// 뒤집히므로 확대 케이스만으로는 방어가 불완전하다. 아래 묶음은
// "줌-아웃 × 경계(모서리, 스크롤된 페이지, 리사이즈)" 의 교차 축을
// 명시적으로 모두 찔러 회귀를 고정한다.

// 줌-아웃 + 임의 커서 조합에서 screenToWorld 불변식을 측정하는 헬퍼.
// 실패 시 Δ 벡터를 메시지에 포함해 어느 축이 드리프트했는지 바로 보이게 한다.
function assertZoomOutPointerInvariant(
  prevZoom: number,
  nextZoom: number,
  prevPan: Point,
  cursor: Point,
  origin: Point,
  label: string,
): void {
  assert.ok(nextZoom < prevZoom, `${label}: 이 헬퍼는 줌-아웃(next<prev) 전용`);
  const wPrev = screenToWorld(cursor, prevPan, prevZoom, origin);
  const nextPan = computeCursorAnchoredPan(prevZoom, nextZoom, prevPan, cursor, origin);
  const wNext = screenToWorld(cursor, nextPan, nextZoom, origin);
  const dx = wNext.x - wPrev.x;
  const dy = wNext.y - wPrev.y;
  assert.ok(
    Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6,
    `${label}: 포인터 아래 world drift Δ=(${dx}, ${dy})`,
  );
}

test('줌-아웃 회귀: 캔버스 네 모서리 모두에서 포인터 아래 월드 좌표 불변', () => {
  // 1000×600 컨테이너, transformOrigin=center center.
  const origin = { x: 500, y: 300 };
  const corners: Array<[string, Point]> = [
    ['top-left', { x: 0, y: 0 }],
    ['top-right', { x: 1000, y: 0 }],
    ['bottom-left', { x: 0, y: 600 }],
    ['bottom-right', { x: 1000, y: 600 }],
  ];
  for (const [label, cursor] of corners) {
    assertZoomOutPointerInvariant(
      2,
      applyWheelZoom(2, +120), // 2 → 1.9 (축소)
      { x: 0, y: 0 },
      cursor,
      origin,
      `corner ${label}`,
    );
  }
});

test('줌-아웃 회귀: 모서리에서 축소 시 팬 부호는 확대와 반대', () => {
  // 확대 케이스의 좌상단은 panX>0/panY>0 (기존 테스트). 축소에서는 콘텐츠가
  // "멀어지며" 좌상단 월드 점이 origin 쪽으로 당겨지므로 팬 부호가 뒤집혀야
  // 한다. 부호가 잘못 고정되면 화면이 모서리를 중심으로 "반대 방향으로
  // 튀는" 사고가 난다 — 이 회귀를 명시 가드.
  const origin = { x: 500, y: 300 };
  const prevZoom = 2;
  const nextZoom = 1.5; // 명시적 축소
  const topLeft = computeCursorAnchoredPan(
    prevZoom,
    nextZoom,
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    origin,
  );
  assert.ok(topLeft.x < 0, `좌상단 축소 시 panX < 0 이어야 함 (got ${topLeft.x})`);
  assert.ok(topLeft.y < 0, `좌상단 축소 시 panY < 0 이어야 함 (got ${topLeft.y})`);

  const bottomRight = computeCursorAnchoredPan(
    prevZoom,
    nextZoom,
    { x: 0, y: 0 },
    { x: 1000, y: 600 },
    origin,
  );
  assert.ok(bottomRight.x > 0, `우하단 축소 시 panX > 0 이어야 함 (got ${bottomRight.x})`);
  assert.ok(bottomRight.y > 0, `우하단 축소 시 panY > 0 이어야 함 (got ${bottomRight.y})`);
});

test('줌-아웃 회귀: 캔버스 바깥 커서(드래그 오버슛)에서도 불변', () => {
  // 사용자가 캔버스 밖으로 드래그한 상태에서 휠을 돌리는 경우.
  // cursor-origin 벡터의 크기가 컨테이너 크기를 넘어서는 극단값에서
  // 팬 공식이 깨지지 않는지 확인.
  const origin = { x: 500, y: 300 };
  const offscreenCursors: Point[] = [
    { x: -300, y: -200 },
    { x: 1500, y: 900 },
    { x: -100, y: 700 },
  ];
  for (const cursor of offscreenCursors) {
    assertZoomOutPointerInvariant(
      1.7,
      applyWheelZoom(1.7, +120),
      { x: 40, y: -20 },
      cursor,
      origin,
      `offscreen cursor ${cursor.x},${cursor.y}`,
    );
  }
});

test('줌-아웃 회귀: 이미 스크롤/팬된 페이지에서 축소해도 포인터 불변', () => {
  // 기존 "비제로 팬 상태" 케이스는 단일 팬 값만 확인한다. 스크롤 방향이
  // 4사분면 모두에 걸친 경우를 한꺼번에 앵커로 박아, 부호 대칭성이 무너지는
  // 회귀(한쪽 사분면만 드리프트) 를 차단.
  const origin = { x: 500, y: 300 };
  const pans: Point[] = [
    { x: 200, y: 150 }, // +,+
    { x: -200, y: 150 }, // -,+
    { x: 200, y: -150 }, // +,-
    { x: -200, y: -150 }, // -,-
    { x: 800, y: 800 }, // 컨테이너보다 큰 팬
  ];
  for (const pan of pans) {
    assertZoomOutPointerInvariant(
      2.4,
      applyWheelZoom(2.4, +120),
      pan,
      { x: 620, y: 280 },
      origin,
      `pre-panned ${pan.x},${pan.y}`,
    );
  }
});

test('줌-아웃 회귀: 같은 커서에서 축소 휠을 연속 굴려도 월드 좌표 드리프트 없음', () => {
  // 사용자는 보통 휠을 여러 번 굴린다. 매 스텝 pan 을 갱신해 체인을 만들어도
  // "초기 커서 아래 월드 좌표" 가 계속 유지되는지 확인. 누적 부동소수
  // 오차도 동시에 상한 체크.
  const origin = { x: 500, y: 300 };
  const cursor: Point = { x: 555, y: 410 };
  let zoom = 2.8;
  let pan: Point = { x: 75, y: -30 };
  const initialWorld = screenToWorld(cursor, pan, zoom, origin);

  for (let i = 0; i < 15; i += 1) {
    const next = applyWheelZoom(zoom, +120); // 축소
    pan = computeCursorAnchoredPan(zoom, next, pan, cursor, origin);
    zoom = next;
    const w = screenToWorld(cursor, pan, zoom, origin);
    approx(w.x, initialWorld.x);
    approx(w.y, initialWorld.y);
  }
  // 체인 끝에서는 MIN_ZOOM 포화. 여기서 추가 축소가 호출되어도 팬이 튀지
  // 않는 것도 위의 noop 가드와 결합해 같이 방어된다.
  assert.ok(zoom >= MIN_ZOOM - EPS, `final zoom below MIN_ZOOM: ${zoom}`);
});

test('줌-아웃 회귀: 리사이즈로 origin 이 바뀐 직후에도 포인터 불변', () => {
  // App 이 컨테이너 리사이즈에 반응해 origin 만 새 중심으로 바꿨고, 팬은
  // 기존 값을 그대로 들고 있는 전이 상태를 모사. 이때 첫 휠 축소에서
  // 포인터 아래가 고정되지 않으면 사용자가 "리사이즈하면 화면이 점프"
  // 를 체감한다.
  const postResizeOrigins: Point[] = [
    { x: 600, y: 400 }, // 컨테이너 확장
    { x: 250, y: 200 }, // 축소
    { x: 400, y: 450 }, // 세로만
    { x: 700, y: 300 }, // 가로만
  ];
  for (const origin of postResizeOrigins) {
    assertZoomOutPointerInvariant(
      2,
      applyWheelZoom(2, +120),
      { x: 60, y: -20 }, // 리사이즈 이전부터 누적된 팬
      { x: 720, y: 510 },
      origin,
      `post-resize origin ${origin.x},${origin.y}`,
    );
  }
});

test('줌-아웃 회귀: 리사이즈 직후 커서가 새 모서리에 걸쳐도 포인터 불변', () => {
  // "리사이즈 + 모서리" 의 교차 경계. 두 회귀 축이 겹치는 지점이라
  // 단일 축 테스트로는 놓치기 쉽다 — 별도 앵커로 박는다.
  const newOrigin: Point = { x: 500, y: 360 };
  const newCorners: Point[] = [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 0, y: 720 },
    { x: 1000, y: 720 },
  ];
  for (const cursor of newCorners) {
    assertZoomOutPointerInvariant(
      2.4,
      1.3,
      { x: -80, y: 40 },
      cursor,
      newOrigin,
      `resize + corner ${cursor.x},${cursor.y}`,
    );
  }
});

test('줌-아웃 회귀: 핀치 축소(ctrlKey 휠) 경로도 동일 계약 유지', () => {
  // App.tsx 는 ctrlKey+휠을 applyPinchZoom 경로로 분기한다. 휠 축소와
  // 핀치 축소 두 경로가 같은 포인터-불변 계약을 공유하는지 확인.
  const origin: Point = { x: 500, y: 300 };
  const prev = 2;
  const next = applyPinchZoom(prev, 0.7); // 축소
  assert.ok(next < prev, 'pinch 0.7 은 축소여야 함');
  assertZoomOutPointerInvariant(
    prev,
    next,
    { x: 100, y: -50 },
    { x: 50, y: 550 }, // 좌하단 근처 — 경계 성격도 동시에 찌른다
    origin,
    'pinch zoom-out near bottom-left',
  );
});

// ─── 미커버 export: computeCursorAnchoredPanTopLeft / clientToCanvas ─────
//
// 배경: 두 함수는 공개 API 로 노출되어 있으나 기존 스위트는 손대지 않았다.
// 좌상단 원점 공식이 일반 공식의 특수 경우라는 "동등성 계약" 과,
// DOMRect 기반 좌표 환산의 기본 산수가 각각 별도 회귀로 박혀 있어야
// 누군가 한 쪽만 수정했을 때 표류가 즉시 드러난다.

test('computeCursorAnchoredPanTopLeft: origin={0,0} 인 일반 공식과 수치적으로 동일', () => {
  // transformOrigin='0 0' 으로 렌더하는 App.tsx 경로와 QA 일반 경로가 같은
  // 수식을 공유하는지 확인. 한쪽이 어긋나면 실제 핸들러 결과와 테스트가
  // 서로 다른 현실을 보게 된다.
  const cases: Array<{ prev: number; next: number; pan: Point; cursor: Point }> = [
    { prev: 1, next: 1.5, pan: { x: 0, y: 0 }, cursor: { x: 200, y: 120 } },
    { prev: 2, next: 1, pan: { x: -40, y: 60 }, cursor: { x: 700, y: 410 } },
    { prev: 1.7, next: 0.8, pan: { x: 90, y: -30 }, cursor: { x: 0, y: 0 } },
    { prev: 0.5, next: 3, pan: { x: 12, y: -34 }, cursor: { x: 999, y: 1 } },
  ];
  for (const c of cases) {
    const general = computeCursorAnchoredPan(c.prev, c.next, c.pan, c.cursor, { x: 0, y: 0 });
    const topLeft = computeCursorAnchoredPanTopLeft(c.prev, c.next, c.pan, c.cursor);
    approxPoint(topLeft, general, 1e-12);
  }
});

test('computeCursorAnchoredPanTopLeft: 포인터 아래 월드 좌표 불변(좌상단 원점)', () => {
  // 좌상단 원점에서의 screenToWorld 는 origin={0,0} 일 때의 일반형과 같으므로
  // 해당 월드 고정 계약을 바로 확인할 수 있다. 좌상단 원점 전용 공식이
  // 실제로 "포인터 아래 고정" 을 만족하는지 세 표본으로 가드.
  const samples: Array<{ prev: number; next: number; pan: Point; cursor: Point }> = [
    { prev: 1, next: 1.5, pan: { x: 40, y: -20 }, cursor: { x: 220, y: 310 } },
    { prev: 2.2, next: 1.4, pan: { x: -110, y: 80 }, cursor: { x: 600, y: 90 } },
    { prev: 0.9, next: 2.4, pan: { x: 0, y: 0 }, cursor: { x: 15, y: 480 } },
  ];
  for (const s of samples) {
    const wPrev = screenToWorld(s.cursor, s.pan, s.prev, { x: 0, y: 0 });
    const nextPan = computeCursorAnchoredPanTopLeft(s.prev, s.next, s.pan, s.cursor);
    const wNext = screenToWorld(s.cursor, nextPan, s.next, { x: 0, y: 0 });
    approxPoint(wNext, wPrev);
  }
});

test('computeCursorAnchoredPan: prevZoom === 0 방어(NaN 팬 방지)', () => {
  // 초기화 버그나 외부 주입으로 prevZoom 이 0 에 닿으면 1 - next/0 이
  // 무한대가 되면서 팬 전체가 NaN 으로 오염된다. 가드가 팬을 그대로
  // 돌려주는지 확인 — 화면이 사라지는 회귀보다 "한 프레임 정지" 쪽이 낫다.
  const pan = { x: 123, y: -45 };
  const out = computeCursorAnchoredPan(0, 1, pan, { x: 200, y: 200 }, { x: 500, y: 300 });
  assert.equal(out.x, pan.x);
  assert.equal(out.y, pan.y);
  const outTL = computeCursorAnchoredPanTopLeft(0, 1, pan, { x: 200, y: 200 });
  assert.equal(outTL.x, pan.x);
  assert.equal(outTL.y, pan.y);
});

test('clientToCanvas: DOMRect 좌상단 기준으로 뷰포트 좌표를 오프셋 변환', () => {
  // 사이드바·스크롤로 캔버스가 뷰포트 좌상단에 있지 않아도 (clientX,clientY)
  // 에서 rect.left/top 을 빼면 캔버스 내부 좌표가 나와야 한다. 부호와 원점
  // 기준이 뒤집히면 휠 핸들러의 world 계산이 통째로 틀어진다.
  const rect = { left: 120, top: 60 };
  approxPoint(clientToCanvas(rect, 120, 60), { x: 0, y: 0 });
  approxPoint(clientToCanvas(rect, 300, 260), { x: 180, y: 200 });
  // 커서가 캔버스 바깥으로 넘어가면 음수 좌표가 나오는 것도 계약이다 —
  // 드래그 오버슛 상황에서 핸들러가 이 음수 좌표를 그대로 소화해야 한다.
  approxPoint(clientToCanvas(rect, 20, 10), { x: -100, y: -50 });
});

test('clientToCanvas: 실수 좌표(고해상도 디스플레이 서브픽셀)를 손실 없이 반영', () => {
  // DPI 환경에서 getBoundingClientRect 은 소수 좌표를 반환한다. 정수 반올림이
  // 들어가면 서브픽셀 단위로 커서 고정이 드리프트한다.
  const rect = { left: 100.25, top: 50.75 };
  approxPoint(clientToCanvas(rect, 200.5, 150.125), { x: 100.25, y: 99.375 }, 1e-12);
});
