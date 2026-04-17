// Run with: tsx --test src/utils/useReducedMotion.test.ts
//
// 디자이너→베타 HANDOFF(2026-04-18) 기대 산출물: matchMedia mock 회귀 테스트.
// React 훅 자체는 렌더 환경(JSDOM 미설치)에서 직접 호출하지 못하므로,
// 훅이 의존하는 순수 헬퍼(`readReducedMotion` / `subscribeReducedMotion`)와
// 소스 수준 계약(`useReducedMotion` 이 두 헬퍼를 사용)을 함께 고정한다.
//
// 검증 축:
//   (1) SSR/미지원 환경: window 부재 또는 matchMedia 미지원 시 false 로 수렴
//   (2) matches=true 인 환경: true 반환
//   (3) 변경 이벤트 구독: addEventListener 경로로 콜백이 갱신값을 받는다
//   (4) 레거시 사파리 폴백: addListener / removeListener 경로도 동작
//   (5) 구독 해제: cleanup 호출 후 mq 콜백이 더 이상 트리거되지 않는다
//   (6) 소스 계약: useReducedMotion 본체가 헬퍼를 호출 — 두 호출부가 표류하지 않게 고정

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  REDUCED_MOTION_QUERY,
  readReducedMotion,
  subscribeReducedMotion,
  type ReducedMotionWindow,
} from './useReducedMotion.ts';

const HOOK_SRC = readFileSync(
  fileURLToPath(new URL('./useReducedMotion.ts', import.meta.url)),
  'utf8',
);

// 단순한 matchMedia 가짜. 변경을 시뮬레이션할 수 있도록 mq 인스턴스를 노출한다.
function createMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    matches: initial,
    addEventListener(type: string, cb: () => void) {
      assert.equal(type, 'change');
      listeners.add(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      assert.equal(type, 'change');
      listeners.delete(cb);
    },
  };
  let queries: string[] = [];
  function matchMedia(query: string) {
    queries.push(query);
    return mq;
  }
  function set(value: boolean) {
    mq.matches = value;
    for (const cb of listeners) cb();
  }
  return { matchMedia, set, listeners, queries: () => queries };
}

// ─── (1) SSR / 미지원 환경 ─────────────────────────────────────────────

test('readReducedMotion: window 가 undefined 면 false', () => {
  assert.equal(readReducedMotion(undefined), false);
});

test('readReducedMotion: matchMedia 미지원 시 false', () => {
  assert.equal(readReducedMotion({} as ReducedMotionWindow), false);
});

test('readReducedMotion: matchMedia 가 throw 해도 false 로 흡수', () => {
  const win: ReducedMotionWindow = {
    matchMedia: () => {
      throw new Error('boom');
    },
  };
  assert.equal(readReducedMotion(win), false);
});

// ─── (2) matches=true 인 환경 ──────────────────────────────────────────

test('readReducedMotion: matchMedia.matches=true 면 true', () => {
  const { matchMedia } = createMatchMedia(true);
  const win: ReducedMotionWindow = { matchMedia };
  assert.equal(readReducedMotion(win), true);
});

test('readReducedMotion: matchMedia.matches=false 면 false', () => {
  const { matchMedia } = createMatchMedia(false);
  const win: ReducedMotionWindow = { matchMedia };
  assert.equal(readReducedMotion(win), false);
});

test('readReducedMotion: 표준 prefers-reduced-motion 쿼리를 사용', () => {
  const { matchMedia, queries } = createMatchMedia(false);
  readReducedMotion({ matchMedia });
  assert.deepEqual(queries(), [REDUCED_MOTION_QUERY]);
  assert.equal(REDUCED_MOTION_QUERY, '(prefers-reduced-motion: reduce)');
});

// ─── (3) 변경 이벤트 구독 ──────────────────────────────────────────────

test('subscribeReducedMotion: addEventListener 경로로 변경값을 콜백에 전달', () => {
  const fake = createMatchMedia(false);
  const win: ReducedMotionWindow = { matchMedia: fake.matchMedia };
  const calls: boolean[] = [];
  const off = subscribeReducedMotion(win, v => calls.push(v));
  fake.set(true);
  fake.set(false);
  fake.set(true);
  off();
  assert.deepEqual(calls, [true, false, true]);
});

// ─── (4) 레거시 사파리 폴백 ────────────────────────────────────────────

test('subscribeReducedMotion: addEventListener 미지원 시 addListener 폴백', () => {
  const listeners = new Set<() => void>();
  let matches = false;
  const mq = {
    get matches() {
      return matches;
    },
    addListener(cb: () => void) {
      listeners.add(cb);
    },
    removeListener(cb: () => void) {
      listeners.delete(cb);
    },
  };
  const win: ReducedMotionWindow = { matchMedia: () => mq };
  const calls: boolean[] = [];
  const off = subscribeReducedMotion(win, v => calls.push(v));
  matches = true;
  for (const cb of listeners) cb();
  matches = false;
  for (const cb of listeners) cb();
  off();
  assert.deepEqual(calls, [true, false]);
  assert.equal(listeners.size, 0, '레거시 폴백도 cleanup 시 listener 를 제거해야 함');
});

// ─── (5) 구독 해제 ──────────────────────────────────────────────────────

test('subscribeReducedMotion: cleanup 호출 후 콜백이 더 이상 호출되지 않음', () => {
  const fake = createMatchMedia(false);
  const calls: boolean[] = [];
  const off = subscribeReducedMotion({ matchMedia: fake.matchMedia }, v => calls.push(v));
  fake.set(true);
  off();
  fake.set(false);
  fake.set(true);
  assert.deepEqual(calls, [true]);
  assert.equal(fake.listeners.size, 0);
});

test('subscribeReducedMotion: matchMedia 미지원 시 cleanup 도 no-op (throw 금지)', () => {
  const off = subscribeReducedMotion({}, () => {});
  off(); // 호출만으로 throw 하지 않는지 확인
});

test('subscribeReducedMotion: window=undefined 시에도 안전 no-op', () => {
  const off = subscribeReducedMotion(undefined, () => {});
  off();
});

// ─── (6) 소스 계약: 훅이 헬퍼를 호출 ───────────────────────────────────

test('useReducedMotion 본체가 readReducedMotion / subscribeReducedMotion 을 사용', () => {
  // 두 호출이 함께 사라지면 훅이 헬퍼와 다른 경로로 표류한 것이므로
  // 테스트 보장이 의미를 잃는다. 둘이 같은 소스 안에 묶여 있는 것을 고정.
  assert.match(HOOK_SRC, /readReducedMotion\(/);
  assert.match(HOOK_SRC, /subscribeReducedMotion\(/);
});

test('useReducedMotion: useEffect 본문이 매 마운트마다 현재값을 다시 읽는다', () => {
  // 마운트와 첫 paint 사이에 미디어 상태가 바뀌었을 수 있으므로
  // useEffect 진입 시 한 번 더 setReduced(read…) 를 호출해 동기화를 맞춰야 한다.
  // 이 호출이 사라지면 SSR → 클라이언트 hydration 에서 한 틱 동안 잘못된 값이 깜빡인다.
  assert.match(HOOK_SRC, /useEffect\([^)]*\(\)\s*=>\s*\{[\s\S]*?setReduced\(readReducedMotion\(window\)\)/);
});
