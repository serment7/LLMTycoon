// Run with: npx tsx --test tests/projects/recommendCountStore.unit.test.ts
//
// 지시 #797538d6 — 추천 인원수 영속 스토어 단위 계약.
//
// 축
//   D. defaults — 처음 호출 시 기본 5, 영속 storage 가 없으면 폴백.
//   C. clamp    — 비정상 입력은 [2, 5] 범위로 강제.
//   P. persist  — set 시 storage 에 String(count) 저장, 읽을 때 동일 값 복원.
//   S. subscribe — 구독자에게 변경 알림, set 후 unsubscribe 시 알림 중지.
//   I. cacheKey — recommendationClient.buildCacheKey 가 count 를 키 프리픽스로 사용.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RECOMMEND_COUNT,
  MAX_RECOMMEND_COUNT,
  MIN_RECOMMEND_COUNT,
  RECOMMEND_COUNT_STORAGE_KEY,
  _resetRecommendCountForTests,
  clampRecommendCount,
  getRecommendCount,
  persistRecommendCount,
  readRecommendCount,
  setRecommendCount,
  subscribeRecommendCount,
  type RecommendCountStorage,
} from '../../src/stores/recommendCountStore.ts';
import {
  buildCacheKey,
  createRecommendationCache,
} from '../../src/project/recommendationClient.ts';
import type { AgentTeamRecommendation } from '../../src/project/recommendAgentTeam.ts';

// ────────────────────────────────────────────────────────────────────────────
// 메모리 storage — globalThis.localStorage 가 노드 환경에서 부재이므로 주입.
// ────────────────────────────────────────────────────────────────────────────

function memStore(initial?: Record<string, string>): RecommendCountStorage & {
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...(initial ?? {}) };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// D. defaults
// ────────────────────────────────────────────────────────────────────────────

test('D1. DEFAULT_RECOMMEND_COUNT 는 5', () => {
  assert.equal(DEFAULT_RECOMMEND_COUNT, 5);
});

test('D2. readRecommendCount — storage 가 비어 있으면 5 반환', () => {
  const store = memStore();
  assert.equal(readRecommendCount(store), 5);
});

test('D3. readRecommendCount — storage 가 null 이면 즉시 기본값', () => {
  assert.equal(readRecommendCount(null), DEFAULT_RECOMMEND_COUNT);
});

test('D4. readRecommendCount — 저장된 정상 값을 클램프해 반환', () => {
  const store = memStore({ [RECOMMEND_COUNT_STORAGE_KEY]: '3' });
  assert.equal(readRecommendCount(store), 3);
});

// ────────────────────────────────────────────────────────────────────────────
// C. clamp
// ────────────────────────────────────────────────────────────────────────────

test('C1. clampRecommendCount — 범위 미만은 MIN(2) 으로 끌어올린다', () => {
  assert.equal(clampRecommendCount(0), MIN_RECOMMEND_COUNT);
  assert.equal(clampRecommendCount(-3), MIN_RECOMMEND_COUNT);
  assert.equal(clampRecommendCount(1), MIN_RECOMMEND_COUNT);
});

test('C2. clampRecommendCount — 범위 초과는 MAX(5) 로 자른다', () => {
  assert.equal(clampRecommendCount(99), MAX_RECOMMEND_COUNT);
  assert.equal(clampRecommendCount(6), MAX_RECOMMEND_COUNT);
});

test('C3. clampRecommendCount — 비숫자 / NaN 은 기본값으로 폴백', () => {
  assert.equal(clampRecommendCount('foo'), DEFAULT_RECOMMEND_COUNT);
  assert.equal(clampRecommendCount(NaN), DEFAULT_RECOMMEND_COUNT);
  assert.equal(clampRecommendCount(undefined), DEFAULT_RECOMMEND_COUNT);
});

test('C4. readRecommendCount — 저장된 비정상 값(15)도 클램프해 반환', () => {
  const store = memStore({ [RECOMMEND_COUNT_STORAGE_KEY]: '15' });
  assert.equal(readRecommendCount(store), MAX_RECOMMEND_COUNT);
});

// ────────────────────────────────────────────────────────────────────────────
// P. persist
// ────────────────────────────────────────────────────────────────────────────

test('P1. persistRecommendCount — 클램프된 값을 문자열로 저장', () => {
  const store = memStore();
  persistRecommendCount(3, store);
  assert.equal(store.data[RECOMMEND_COUNT_STORAGE_KEY], '3');
});

test('P2. persistRecommendCount — 범위 초과는 클램프해 저장', () => {
  const store = memStore();
  persistRecommendCount(42, store);
  assert.equal(store.data[RECOMMEND_COUNT_STORAGE_KEY], String(MAX_RECOMMEND_COUNT));
});

test('P3. round-trip — 저장 후 다시 읽으면 같은 값', () => {
  const store = memStore();
  persistRecommendCount(4, store);
  assert.equal(readRecommendCount(store), 4);
});

// ────────────────────────────────────────────────────────────────────────────
// S. subscribe
// ────────────────────────────────────────────────────────────────────────────

test('S1. subscribeRecommendCount — set 마다 구독자에게 알림', () => {
  // 모듈 상태 초기화 — 이 시점의 storage 값(5) 으로 리셋.
  _resetRecommendCountForTests(memStore());
  let calls = 0;
  const unsub = subscribeRecommendCount(() => {
    calls += 1;
  });
  setRecommendCount(3);
  setRecommendCount(4);
  // 같은 값 재설정은 알림 안 함.
  setRecommendCount(4);
  unsub();
  setRecommendCount(2);
  assert.equal(calls, 2, '서로 다른 값을 set 한 횟수만큼 알림');
  assert.equal(getRecommendCount(), 2);
});

// ────────────────────────────────────────────────────────────────────────────
// I. integration with recommendationClient cache
// ────────────────────────────────────────────────────────────────────────────

test('I1. buildCacheKey — count 가 주어지면 동일 description 도 다른 키를 사용', () => {
  const a = buildCacheKey('동일 설명', 3);
  const b = buildCacheKey('동일 설명', 5);
  assert.notEqual(a, b);
  assert.match(a, /^n=3\|/);
  assert.match(b, /^n=5\|/);
});

test('I2. buildCacheKey — count 미주입 시 description-only 키 보존(후방 호환)', () => {
  const k = buildCacheKey('동일 설명');
  assert.equal(k, '동일 설명');
});

test('I3. createRecommendationCache — (desc,count) 별 슬롯을 분리 저장', () => {
  const cache = createRecommendationCache(8);
  const team3: AgentTeamRecommendation = {
    items: [{ role: 'Leader', name: 'Kai', rationale: '분배' }],
    source: 'claude',
    locale: 'ko',
  };
  const team5: AgentTeamRecommendation = {
    items: [
      { role: 'Leader', name: 'Kai', rationale: '분배' },
      { role: 'Developer', name: 'Dev', rationale: '구현' },
    ],
    source: 'claude',
    locale: 'ko',
  };
  cache.set('결제 모듈 보안', team3, 3);
  cache.set('결제 모듈 보안', team5, 5);
  assert.equal(cache.get('결제 모듈 보안', 3)?.items.length, 1);
  assert.equal(cache.get('결제 모듈 보안', 5)?.items.length, 2);
  assert.equal(cache.get('결제 모듈 보안', 4), undefined, '없는 count 키는 미스');
});
