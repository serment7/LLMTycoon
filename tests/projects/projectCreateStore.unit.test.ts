// Run with: npx tsx --test tests/projects/projectCreateStore.unit.test.ts
//
// 지시 #462fa5ec — 프로젝트 생성 폼 영속 스토어 + 잠긴 역할 머지 + reason 필드 단위 계약.
//
// 축
//   D. defaults — 첫 호출 시 잠금/스냅샷 모두 비어 있고 minLength/디바운스 상수가 노출.
//   L. locked   — 잠금 토글, 중복 차단, 정규화(허용 역할만), persist round-trip.
//   S. snapshot — lastRecommendation 저장/복원, 깨진 페이로드 폴백.
//   M. merge    — mergeLockedRoles 가 잠긴 역할은 우선 보존하고, 응답에 같은 역할이
//                있으면 응답값으로 갱신, 없으면 직전 값 유지.
//   G. guard    — isDescriptionLongEnough 가 minLength 임계값에 정확히 맞춤.
//   R. reason   — validateRecommendations 가 reason 필드를 보존(공백·비문자열은 무시).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAST_RECOMMENDATION_STORAGE_KEY,
  LOCKED_ROLES_STORAGE_KEY,
  MIN_DESCRIPTION_LENGTH,
  RECOMMENDATION_DEBOUNCE_MS,
  _resetProjectCreateForTests,
  clearLockedRoles,
  getLastRecommendation,
  getLockedRoles,
  isDescriptionLongEnough,
  mergeLockedRoles,
  persistLastRecommendation,
  persistLockedRoles,
  readLastRecommendation,
  readLockedRoles,
  setLastRecommendation,
  toggleLockedRole,
  type ProjectCreateStorage,
} from '../../src/stores/projectCreateStore.ts';
import {
  validateRecommendations,
  type AgentRecommendation,
} from '../../src/project/recommendAgentTeam.ts';

// ────────────────────────────────────────────────────────────────────────────
// 메모리 storage — globalThis.localStorage 가 노드 환경에서 부재이므로 주입.
// ────────────────────────────────────────────────────────────────────────────

function memStore(initial?: Record<string, string>): ProjectCreateStorage & {
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

test('D1. MIN_DESCRIPTION_LENGTH=20, RECOMMENDATION_DEBOUNCE_MS=600', () => {
  assert.equal(MIN_DESCRIPTION_LENGTH, 20);
  assert.equal(RECOMMENDATION_DEBOUNCE_MS, 600);
});

test('D2. readLockedRoles — 빈 storage 면 빈 배열', () => {
  assert.deepEqual(readLockedRoles(memStore()), []);
});

test('D3. readLastRecommendation — 빈 storage 면 null', () => {
  assert.equal(readLastRecommendation(memStore()), null);
});

// ────────────────────────────────────────────────────────────────────────────
// L. locked roles
// ────────────────────────────────────────────────────────────────────────────

test('L1. persist + read round-trip — 정상 역할만 보존', () => {
  const store = memStore();
  persistLockedRoles(['Designer', 'QA'], store);
  assert.deepEqual(readLockedRoles(store), ['Designer', 'QA']);
});

test('L2. read — 깨진 JSON / 비배열은 빈 배열로 폴백', () => {
  const store = memStore({ [LOCKED_ROLES_STORAGE_KEY]: '{not-an-array}' });
  assert.deepEqual(readLockedRoles(store), []);
});

test('L3. read — 알 수 없는 role 은 무시하고 중복도 제거', () => {
  const store = memStore({
    [LOCKED_ROLES_STORAGE_KEY]: JSON.stringify(['Designer', 'Designer', 'foo', 'QA']),
  });
  assert.deepEqual(readLockedRoles(store), ['Designer', 'QA']);
});

test('L4. toggleLockedRole — 같은 역할 두 번 토글 시 원상 복귀', () => {
  _resetProjectCreateForTests(memStore());
  toggleLockedRole('Designer');
  assert.deepEqual(getLockedRoles(), ['Designer']);
  toggleLockedRole('Designer');
  assert.deepEqual(getLockedRoles(), []);
});

test('L5. clearLockedRoles — 모든 잠금 해제', () => {
  _resetProjectCreateForTests(memStore());
  toggleLockedRole('Designer');
  toggleLockedRole('QA');
  clearLockedRoles();
  assert.deepEqual(getLockedRoles(), []);
});

// ────────────────────────────────────────────────────────────────────────────
// S. lastRecommendation snapshot
// ────────────────────────────────────────────────────────────────────────────

test('S1. setLastRecommendation — 모듈 상태 + storage 양쪽 갱신', () => {
  const store = memStore();
  _resetProjectCreateForTests(store);
  // setLastRecommendation 은 모듈 기본 storage(=globalThis.localStorage 또는 null) 에 저장하므로
  // 본 단위 테스트는 persist 헬퍼만 따로 검증한다.
  persistLastRecommendation(
    {
      description: '결제 모듈 보안 강화 — PCI 감사 + 토큰 암호화 작업',
      count: 3,
      locale: 'ko',
      source: 'claude',
      items: [{ role: 'Leader', name: 'Kai', rationale: '분배', reason: '범위 분해' }],
      storedAt: '2026-04-26T00:00:00.000Z',
    },
    store,
  );
  const restored = readLastRecommendation(store);
  assert.ok(restored);
  assert.equal(restored.count, 3);
  assert.equal(restored.locale, 'ko');
  assert.equal(restored.items[0].reason, '범위 분해');
});

test('S2. read — 깨진 페이로드(JSON 가능하지만 schema 어긋남) 는 null', () => {
  const store = memStore({
    [LAST_RECOMMENDATION_STORAGE_KEY]: JSON.stringify({ description: 1, count: 'x', items: 'no' }),
  });
  assert.equal(readLastRecommendation(store), null);
});

test('S3. round-trip — set null 로 storage 항목 제거', () => {
  const store = memStore({
    [LAST_RECOMMENDATION_STORAGE_KEY]: JSON.stringify({
      description: 'desc-1234567890abcd-aaa',
      count: 5,
      locale: 'en',
      source: 'cache',
      items: [{ role: 'Leader', name: 'Kai', rationale: 'Distributes' }],
      storedAt: '2026-04-26T00:00:00.000Z',
    }),
  });
  assert.ok(readLastRecommendation(store));
  persistLastRecommendation(null, store);
  assert.equal(LAST_RECOMMENDATION_STORAGE_KEY in store.data, false);
  assert.equal(readLastRecommendation(store), null);
});

test('S4. setLastRecommendation 모듈 API — getLastRecommendation 즉시 반영', () => {
  _resetProjectCreateForTests(memStore());
  const snap = {
    description: '회원·결제·푸시 통합 — 한 번에 검토 필요',
    count: 4,
    locale: 'ko' as const,
    source: 'claude' as const,
    items: [{ role: 'Leader' as const, name: 'Kai', rationale: '분배' }],
    storedAt: '2026-04-26T00:00:00.000Z',
  };
  setLastRecommendation(snap);
  const got = getLastRecommendation();
  assert.ok(got);
  assert.equal(got.description, snap.description);
  setLastRecommendation(null);
  assert.equal(getLastRecommendation(), null);
});

// ────────────────────────────────────────────────────────────────────────────
// M. mergeLockedRoles
// ────────────────────────────────────────────────────────────────────────────

const FRESH: readonly AgentRecommendation[] = [
  { role: 'Leader', name: 'Kai', rationale: 'fresh-lead' },
  { role: 'Developer', name: 'Dev', rationale: 'fresh-dev' },
  { role: 'Designer', name: 'Dex', rationale: 'fresh-design' },
];

const PREV: readonly AgentRecommendation[] = [
  { role: 'Leader', name: 'Kai', rationale: 'prev-lead' },
  { role: 'QA', name: 'QA-Pin', rationale: 'prev-qa' },
];

test('M1. lockedRoles 가 비어 있으면 fresh 그대로(슬라이스만)', () => {
  const out = mergeLockedRoles(FRESH, { lockedRoles: [], previous: PREV, count: 2 });
  assert.deepEqual(out.map((it) => it.role), ['Leader', 'Developer']);
});

test('M2. 잠긴 역할이 fresh 에 있으면 fresh 값(새 카피) 채택', () => {
  const out = mergeLockedRoles(FRESH, {
    lockedRoles: ['Leader'],
    previous: PREV,
    count: 3,
  });
  // Leader 는 fresh 의 'fresh-lead' 채택, 나머지는 fresh 순서로 채워짐.
  assert.equal(out[0].rationale, 'fresh-lead');
  assert.deepEqual(out.slice(0, 3).map((it) => it.role), ['Leader', 'Developer', 'Designer']);
});

test('M3. 잠긴 역할이 fresh 에 없고 previous 에만 있으면 previous 카드 보존', () => {
  const freshNoQA = FRESH.filter((it) => it.role !== 'QA');
  const out = mergeLockedRoles(freshNoQA, {
    lockedRoles: ['QA'],
    previous: PREV,
    count: 3,
  });
  // QA 는 PREV 에서 가져옴, 그 뒤에 fresh 순서.
  assert.equal(out[0].role, 'QA');
  assert.equal(out[0].name, 'QA-Pin');
  assert.equal(out[0].rationale, 'prev-qa');
});

test('M4. 잠긴 역할이 양쪽 모두에 없으면 결과에 등장하지 않는다', () => {
  const out = mergeLockedRoles(FRESH, {
    lockedRoles: ['Researcher'],
    previous: PREV,
    count: 3,
  });
  assert.equal(out.find((it) => it.role === 'Researcher'), undefined);
});

test('M5. count 만큼 슬라이스되 잠긴 역할은 보존(잠긴 수가 더 많으면 그쪽 우선)', () => {
  const out = mergeLockedRoles(FRESH, {
    lockedRoles: ['Designer'],
    previous: PREV,
    count: 1,
  });
  // count=1 이지만 잠긴 역할 1개라 Designer 만 살아남는다.
  assert.deepEqual(out.map((it) => it.role), ['Designer']);
});

// ────────────────────────────────────────────────────────────────────────────
// G. guard
// ────────────────────────────────────────────────────────────────────────────

test('G1. isDescriptionLongEnough — trim 후 정확히 임계값에서 true', () => {
  const just = 'a'.repeat(MIN_DESCRIPTION_LENGTH);
  assert.equal(isDescriptionLongEnough(just), true);
  assert.equal(isDescriptionLongEnough(`  ${just}  `), true);
});

test('G2. isDescriptionLongEnough — 1자 부족이면 false', () => {
  const tooShort = 'a'.repeat(MIN_DESCRIPTION_LENGTH - 1);
  assert.equal(isDescriptionLongEnough(tooShort), false);
});

test('G3. isDescriptionLongEnough — 공백만은 false', () => {
  assert.equal(isDescriptionLongEnough('   '), false);
  assert.equal(isDescriptionLongEnough(''), false);
});

// ────────────────────────────────────────────────────────────────────────────
// R. reason 필드 보존
// ────────────────────────────────────────────────────────────────────────────

test('R1. validateRecommendations — reason 문자열은 trim 후 보존', () => {
  const out = validateRecommendations({
    items: [
      { role: 'Leader', name: 'Kai', rationale: '분배', reason: '  결제 도메인 우선 분해  ' },
    ],
  });
  assert.equal(out[0].reason, '결제 도메인 우선 분해');
});

test('R2. validateRecommendations — 비문자열·빈 문자열 reason 은 무시(필드 부재)', () => {
  const out = validateRecommendations({
    items: [
      { role: 'Leader', name: 'Kai', rationale: '분배', reason: '' },
      { role: 'Developer', name: 'Dev', rationale: '구현', reason: 42 },
    ],
  });
  assert.equal(out[0].reason, undefined);
  assert.equal(out[1].reason, undefined);
});

test('R3. validateRecommendations — reason 240자 초과는 잘려 보존', () => {
  const long = 'r'.repeat(500);
  const out = validateRecommendations({
    items: [{ role: 'Leader', name: 'Kai', rationale: '분배', reason: long }],
  });
  assert.equal(out[0].reason?.length, 240);
});
