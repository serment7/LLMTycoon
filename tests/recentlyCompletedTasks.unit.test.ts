// Run with: npx tsx --test tests/recentlyCompletedTasks.unit.test.ts
//
// 지시 #06aa5c30 — 자동 커밋 시점 commitMessageBuilder 가 동기적으로 끌어다 쓸
// "최근 완료 태스크 버퍼" 단위 테스트. 검증 포인트
//   1. record → get: push 한 항목이 같은 projectId 의 미소비 조회로 그대로 나온다.
//   2. 격리: 다른 projectId 는 서로의 버퍼를 보지 못한다.
//   3. sinceTs: 워터마크 이전 항목은 응답에서 제외된다.
//   4. consume: 호출 후 동일 selector 는 빈 배열, includeConsumed=true 만 항목 노출.
//   5. consume(beforeTs): 워터마크 이후 항목은 살아남는다.
//   6. 중복 record(동일 taskId·미소비) 는 덮어쓰기로 본문 중복을 막는다.
//   7. clear: 프로젝트별/전체 정리.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordCompletedTask,
  getRecentlyCompletedTasks,
  consumeRecentlyCompletedTasks,
  clearRecentlyCompletedTasks,
  __resetRecentlyCompletedTasksForTests,
} from '../src/server/recentlyCompletedTasks';

test.beforeEach(() => {
  __resetRecentlyCompletedTasksForTests();
});

test('record → get: 같은 프로젝트의 미소비 항목이 그대로 조회된다', () => {
  recordCompletedTask({
    projectId: 'p1',
    taskId: 't1',
    agent: 'Developer',
    summary: 'feat: add foo',
    changedFiles: ['src/a.ts', 'src/b.ts'],
    completedAt: 1_000,
  });
  const out = getRecentlyCompletedTasks('p1');
  assert.equal(out.length, 1);
  assert.equal(out[0].taskId, 't1');
  assert.equal(out[0].agent, 'Developer');
  assert.deepEqual([...out[0].changedFiles], ['src/a.ts', 'src/b.ts']);
  assert.equal(out[0].consumed, false);
});

test('다른 projectId 끼리는 격리되어 서로의 항목을 보지 못한다', () => {
  recordCompletedTask({ projectId: 'p1', agent: 'A', summary: 'x', completedAt: 1 });
  recordCompletedTask({ projectId: 'p2', agent: 'B', summary: 'y', completedAt: 1 });
  assert.equal(getRecentlyCompletedTasks('p1').length, 1);
  assert.equal(getRecentlyCompletedTasks('p2').length, 1);
  assert.equal(getRecentlyCompletedTasks('p3').length, 0);
});

test('sinceTs 이상 항목만 응답한다', () => {
  recordCompletedTask({ projectId: 'p', agent: 'A', summary: 'old', completedAt: 100 });
  recordCompletedTask({ projectId: 'p', agent: 'B', summary: 'new', completedAt: 500 });
  const result = getRecentlyCompletedTasks('p', { sinceTs: 200 });
  assert.equal(result.length, 1);
  assert.equal(result[0].summary, 'new');
});

test('consume 후 기본 selector 는 빈 배열, includeConsumed=true 면 항목이 보인다', () => {
  recordCompletedTask({ projectId: 'p', agent: 'A', summary: 's1', completedAt: 1 });
  recordCompletedTask({ projectId: 'p', agent: 'B', summary: 's2', completedAt: 2 });
  const consumed = consumeRecentlyCompletedTasks('p');
  assert.equal(consumed.length, 2);
  assert.ok(consumed.every(t => t.consumed === true));
  assert.equal(getRecentlyCompletedTasks('p').length, 0);
  assert.equal(
    getRecentlyCompletedTasks('p', { includeConsumed: true }).length,
    2,
  );
});

test('consume(beforeTs) 는 워터마크 이전 항목만 소비, 이후 항목은 살아남는다', () => {
  recordCompletedTask({ projectId: 'p', agent: 'A', summary: 's1', completedAt: 100 });
  recordCompletedTask({ projectId: 'p', agent: 'B', summary: 's2', completedAt: 200 });
  recordCompletedTask({ projectId: 'p', agent: 'C', summary: 's3', completedAt: 300 });
  const consumed = consumeRecentlyCompletedTasks('p', { beforeTs: 200 });
  // beforeTs=200 이하인 100·200 만 소비, 300 은 그대로 미소비.
  assert.equal(consumed.length, 2);
  const remaining = getRecentlyCompletedTasks('p');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].summary, 's3');
});

test('동일 taskId·미소비 재기록은 덮어쓰기 — 본문 중복을 막는다', () => {
  recordCompletedTask({
    projectId: 'p',
    taskId: 't',
    agent: 'A',
    summary: 'old',
    changedFiles: ['a.ts'],
    completedAt: 1,
  });
  recordCompletedTask({
    projectId: 'p',
    taskId: 't',
    agent: 'A',
    summary: 'new',
    changedFiles: ['a.ts', 'b.ts'],
    completedAt: 2,
  });
  const all = getRecentlyCompletedTasks('p');
  assert.equal(all.length, 1);
  assert.equal(all[0].summary, 'new');
  assert.deepEqual([...all[0].changedFiles], ['a.ts', 'b.ts']);
});

test('소비된 taskId 는 같은 id 로 다시 record 시 새 사이클 항목으로 누적된다', () => {
  recordCompletedTask({ projectId: 'p', taskId: 't', agent: 'A', summary: 'a', completedAt: 1 });
  consumeRecentlyCompletedTasks('p');
  recordCompletedTask({ projectId: 'p', taskId: 't', agent: 'A', summary: 'b', completedAt: 2 });
  // 새 항목은 미소비, 이전 사이클 항목은 includeConsumed 로만 보인다.
  const fresh = getRecentlyCompletedTasks('p');
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].summary, 'b');
  const all = getRecentlyCompletedTasks('p', { includeConsumed: true });
  assert.equal(all.length, 2);
});

test('clearRecentlyCompletedTasks: 단일 프로젝트 / 전역 클리어', () => {
  recordCompletedTask({ projectId: 'p1', agent: 'A', summary: 's', completedAt: 1 });
  recordCompletedTask({ projectId: 'p2', agent: 'B', summary: 's', completedAt: 1 });
  clearRecentlyCompletedTasks('p1');
  assert.equal(getRecentlyCompletedTasks('p1').length, 0);
  assert.equal(getRecentlyCompletedTasks('p2').length, 1);
  clearRecentlyCompletedTasks();
  assert.equal(getRecentlyCompletedTasks('p2').length, 0);
});

test('changedFiles: 역슬래시 정규화 + 중복 제거 + 비어 있는 항목 무시', () => {
  recordCompletedTask({
    projectId: 'p',
    agent: 'A',
    summary: 's',
    changedFiles: ['src\\a.ts', 'src/a.ts', '   ', 'src/b.ts'],
    completedAt: 1,
  });
  const [entry] = getRecentlyCompletedTasks('p');
  assert.deepEqual([...entry.changedFiles], ['src/a.ts', 'src/b.ts']);
});

test('agent 빈 문자열은 unknown 으로 정규화된다', () => {
  recordCompletedTask({ projectId: 'p', agent: '   ', summary: 's', completedAt: 1 });
  const [entry] = getRecentlyCompletedTasks('p');
  assert.equal(entry.agent, 'unknown');
});

test('projectId 누락은 즉시 throw 한다(잘못된 호출 차단)', () => {
  assert.throws(
    () => recordCompletedTask({ projectId: '', agent: 'A', summary: 's' }),
    /projectId 가 필요합니다/,
  );
});
