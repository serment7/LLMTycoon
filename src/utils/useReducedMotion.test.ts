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

// ─── (7) 엄격 boolean 비교 계약 ────────────────────────────────────────
//
// 구현은 `mq.matches === true` 로 엄격 비교를 쓴다. 일부 폴리필/래퍼가
// matches 를 truthy 한 non-boolean(문자열·숫자·객체) 으로 돌려주는 경우에도
// 모션을 "켠 상태" 로 보수적으로 해석해야 애니메이션이 사용자 의사와 어긋나지
// 않는다. 이 계약이 느슨해지면(`Boolean(mq.matches)` 로 바뀌면) non-boolean
// truthy 값에서 예상치 못하게 모션이 꺼지므로, 아래 두 테스트로 엄격 비교를
// 고정한다.

test('readReducedMotion: matches 가 truthy 한 문자열이어도 false (엄격 === true 비교)', () => {
  const win: ReducedMotionWindow = {
    matchMedia: () => ({ matches: 'yes' as unknown as boolean }),
  };
  assert.equal(readReducedMotion(win), false);
});

test('readReducedMotion: matches 가 숫자 1 이어도 false (엄격 === true 비교)', () => {
  const win: ReducedMotionWindow = {
    matchMedia: () => ({ matches: 1 as unknown as boolean }),
  };
  assert.equal(readReducedMotion(win), false);
});

// ─── (8) 비표준 matchMedia 반환 객체에서 cleanup 안전성 ─────────────────
//
// matchMedia 는 있지만 반환 객체에 addEventListener / addListener 가 모두
// 없는 비표준·축약 폴리필 환경이 실제로 존재한다. 이 때 구독 함수는 no-op
// cleanup 을 돌려주고, cleanup 호출이 throw 하지 않아야 React useEffect 해제
// 경로가 깨지지 않는다. 현재 구현은 `return () => {}` 로 처리하므로 이 계약을
// 회귀 테스트로 고정한다.

test('subscribeReducedMotion: add(Event)Listener 둘 다 없으면 cleanup 은 no-op 이고 호출이 안전', () => {
  const mq = { matches: false } as unknown as { matches: boolean };
  const win: ReducedMotionWindow = { matchMedia: () => mq };
  const calls: boolean[] = [];
  const off = subscribeReducedMotion(win, v => calls.push(v));
  assert.equal(typeof off, 'function');
  // 호출 자체가 throw 하지 않고, 콜백이 한 번도 불리지 않은 상태여야 한다.
  off();
  assert.deepEqual(calls, []);
});

// ─── (9) API 선택 우선순위 · 쿼리 공유 · cleanup 멱등성 ─────────────────
//
// 최초 도입 이후 QA 라운드 7 (#3381daec) 에서 보강. 이전 케이스는 신·구 API
// 중 "하나씩만" 있는 환경을 검증했지만, 둘 다 있는 환경에서 어느 쪽이 선택되는지
// 는 테스트로 잠기지 않아 리팩터 시 이중 등록(두 경로 모두 add) 위험이 있었다.
// 더불어 React 19 StrictMode 에서 이펙트가 이중 마운트되면 cleanup 이 두 번
// 호출될 수 있으므로, 멱등성도 회귀로 고정한다.

test('subscribeReducedMotion: addEventListener 와 addListener 둘 다 있으면 addEventListener 를 우선 선택', () => {
  const modern = new Set<() => void>();
  const legacy = new Set<() => void>();
  let matches = false;
  const mq = {
    get matches() {
      return matches;
    },
    addEventListener(type: string, cb: () => void) {
      assert.equal(type, 'change');
      modern.add(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      assert.equal(type, 'change');
      modern.delete(cb);
    },
    addListener(cb: () => void) {
      legacy.add(cb);
    },
    removeListener(cb: () => void) {
      legacy.delete(cb);
    },
  };
  const win: ReducedMotionWindow = { matchMedia: () => mq };
  const calls: boolean[] = [];
  const off = subscribeReducedMotion(win, v => calls.push(v));
  // 둘 중 하나에만 등록되어야 중복 이벤트 호출이 발생하지 않는다.
  assert.equal(modern.size, 1, 'addEventListener 경로에 등록되어야 함');
  assert.equal(legacy.size, 0, 'addListener 경로는 사용되지 않아야 함');
  matches = true;
  for (const cb of modern) cb();
  off();
  assert.deepEqual(calls, [true]);
  assert.equal(modern.size, 0, 'cleanup 시 addEventListener 등록이 해제되어야 함');
  assert.equal(legacy.size, 0);
});

test('subscribeReducedMotion: 표준 prefers-reduced-motion 쿼리를 matchMedia 에 전달', () => {
  const queries: string[] = [];
  const win: ReducedMotionWindow = {
    matchMedia: (q: string) => {
      queries.push(q);
      return { matches: false };
    },
  };
  subscribeReducedMotion(win, () => {});
  assert.deepEqual(queries, [REDUCED_MOTION_QUERY]);
});

test('subscribeReducedMotion: cleanup 은 멱등 — 두 번 호출해도 throw 하지 않음 (React StrictMode 대비)', () => {
  const fake = createMatchMedia(false);
  const off = subscribeReducedMotion({ matchMedia: fake.matchMedia }, () => {});
  off();
  // 두 번째 호출도 안전해야 한다. Set.delete 는 존재하지 않는 키에도 안전하므로
  // 현재 구현은 이 계약을 자연히 만족하지만, 구독 구조가 교체되어도 같은 계약을
  // 유지하도록 고정한다.
  off();
  assert.equal(fake.listeners.size, 0);
});
