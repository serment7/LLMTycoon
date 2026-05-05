// Run with: npx tsx --test tests/agentNameDedup.unit.test.ts
//
// 사용자 보고 — "프로젝트 추천 팀에 동일 이름 에이전트가 섞여서 합류". 본 스위트는
// 1) 추천 배치 내 dedup 헬퍼와 2) 기동 마이그레이션 플래너가 이름 충돌을 어떻게
// 해소하는지 잠근다. Mongo 의존은 어댑터 단으로 격리되어 본 단위 테스트에는 들어오지
// 않는다(어댑터는 server.ts 통합 경로에서 검증).
//
// 축
//   U1. uniqueAgentName — 기본 충돌 회피 + 접미사 누진.
//   U2. dedupeRecommendationNames — 배치 내 충돌 + 외부 점유 이름과의 충돌 모두 회피.
//   U3. dedupeRecommendationNames — 충돌 없는 입력은 동일 참조를 그대로 통과(불필요한 객체 사본 회피).
//   M1. planAgentNameDedup — 중복 없는 입력은 빈 plan + scanned 만 채움.
//   M2. planAgentNameDedup — 같은 이름 셋이 셋이면 첫은 보존, 둘은 -2 / -3 접미사.
//   M3. planAgentNameDedup — 신규 접미사가 기존 다른 이름과 충돌하면 다음 숫자로 점프.
//   M4. planAgentNameDedup — 멱등 — plan 의 renames 를 적용한 결과를 다시 plan 해도 빈 결과.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  uniqueAgentName,
  dedupeRecommendationNames,
} from '../src/utils/agentNameDedup.ts';
import {
  planAgentNameDedup,
  type AgentDocLike,
} from '../src/server/migrations/dedupeAgentNames.ts';

// ─── U: 추천 배치 / 헬퍼 ─────────────────────────────────────────────────────

test('U1. uniqueAgentName — 미점유 이름은 그대로, 점유면 2/3/... 누진', () => {
  assert.equal(uniqueAgentName([], 'Dev'), 'Dev');
  assert.equal(uniqueAgentName(['Dev'], 'Dev'), 'Dev2');
  assert.equal(uniqueAgentName(['Dev', 'Dev2'], 'Dev'), 'Dev3');
  assert.equal(uniqueAgentName(['Dev', 'Dev2', 'Dev4'], 'Dev'), 'Dev3');
});

test('U2. dedupeRecommendationNames — 배치 내·외부 점유 이름 모두 회피', () => {
  const items = [
    { role: 'Leader', name: 'Kai' },
    { role: 'Developer', name: 'Dev' },
    { role: 'Researcher', name: 'Dev' }, // 배치 내 중복
    { role: 'QA', name: 'QA' },
  ];
  const out = dedupeRecommendationNames(items, ['Kai']); // 외부 'Kai' 점유
  assert.deepEqual(out.map(i => i.name), ['Kai2', 'Dev', 'Dev2', 'QA']);
  // 다른 필드는 보존
  assert.equal(out[0].role, 'Leader');
  assert.equal(out[3].role, 'QA');
});

test('U3. dedupeRecommendationNames — 충돌 없는 입력은 같은 참조를 통과', () => {
  const a = { role: 'Leader', name: 'Kai' };
  const b = { role: 'Developer', name: 'Dev' };
  const out = dedupeRecommendationNames([a, b]);
  // 충돌이 없으면 새 객체를 만들지 않는다(불필요한 사본 회피).
  assert.strictEqual(out[0], a);
  assert.strictEqual(out[1], b);
});

// ─── M: 마이그레이션 플래너 ─────────────────────────────────────────────────

test('M1. planAgentNameDedup — 중복 0건 plan 은 빈 renames', () => {
  const all: AgentDocLike[] = [
    { id: 'a1', name: 'Kai' },
    { id: 'a2', name: 'Dev' },
  ];
  const plan = planAgentNameDedup(all);
  assert.equal(plan.scanned, 2);
  assert.equal(plan.duplicateGroups, 0);
  assert.deepEqual(plan.renames, []);
});

test('M2. planAgentNameDedup — 동명 3인이면 첫은 보존, 둘은 2/3 부여', () => {
  const all: AgentDocLike[] = [
    { id: 'a1', name: 'Dev' },
    { id: 'a2', name: 'Dev' },
    { id: 'a3', name: 'Dev' },
    { id: 'a4', name: 'QA' },
  ];
  const plan = planAgentNameDedup(all);
  assert.equal(plan.scanned, 4);
  assert.equal(plan.duplicateGroups, 1);
  assert.deepEqual(plan.renames, [
    { id: 'a2', from: 'Dev', to: 'Dev2' },
    { id: 'a3', from: 'Dev', to: 'Dev3' },
  ]);
});

test('M3. planAgentNameDedup — 새 접미사가 기존 다른 이름과 충돌하면 다음 숫자로', () => {
  const all: AgentDocLike[] = [
    { id: 'a1', name: 'Dev' },
    { id: 'a2', name: 'Dev' },
    { id: 'a3', name: 'Dev2' }, // 이미 Dev2 가 다른 에이전트로 존재
  ];
  const plan = planAgentNameDedup(all);
  assert.deepEqual(plan.renames, [
    // 두 번째 'Dev' 는 'Dev2' 가 점유돼 'Dev3' 로
    { id: 'a2', from: 'Dev', to: 'Dev3' },
  ]);
});

test('M4. planAgentNameDedup — 멱등 (plan 적용 후 재실행은 빈 결과)', () => {
  const initial: AgentDocLike[] = [
    { id: 'a1', name: 'Dev' },
    { id: 'a2', name: 'Dev' },
    { id: 'a3', name: 'Dev' },
  ];
  const plan1 = planAgentNameDedup(initial);
  // plan1 을 적용한 가상 상태를 만든다 — id 는 그대로, name 만 교체.
  const renameById = new Map(plan1.renames.map(r => [r.id, r.to]));
  const after: AgentDocLike[] = initial.map(a => ({
    id: a.id,
    name: renameById.get(a.id) ?? a.name,
  }));
  const plan2 = planAgentNameDedup(after);
  assert.equal(plan2.duplicateGroups, 0);
  assert.deepEqual(plan2.renames, []);
});
