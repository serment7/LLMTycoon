// Run with: npx tsx --test tests/agentWorkerTaskBoundary.regression.test.ts
//
// 회귀 테스트: `src/server/agentWorker.ts` 의 태스크 경계 훅(#f3c0ea52).
// 수동/변경없음/세션소진/정상 4경로와 exhausted → active 복귀 시 FIFO 되감기 를
// 런타임으로 검증한다. QA 의 승격 계약(`taskBoundaryCommit.regression.test.ts`) 이
// 소스 수준 회귀를, 본 파일이 실행 수준 회귀를 담당해 상보적으로 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  notifyTaskBoundary,
  flushQueuedTaskBoundaries,
  getQueuedTaskBoundaryCount,
  setTaskBoundaryHandler,
  resetTaskBoundaryHandler,
  setAgentWorkerSessionStatus,
} from '../src/server/agentWorker.ts';
import { DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG } from '../src/types.ts';

function baseEvent() {
  return {
    taskId: 't1',
    agentId: 'a1',
    projectId: 'p1',
    description: 'test: 신규 회귀 추가',
    changedFiles: ['tests/a.test.ts'],
  };
}

// 각 테스트가 서로 간섭하지 않도록 세션 상태·핸들러를 초기화.
function reset() {
  setAgentWorkerSessionStatus('active');
  resetTaskBoundaryHandler();
}

test("'manual' 전략은 핸들러를 부르지 않고 skipped-manual 을 돌려준다", () => {
  reset();
  let called = 0;
  setTaskBoundaryHandler(() => { called += 1; });
  const result = notifyTaskBoundary(baseEvent(), {
    ...DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG,
    commitStrategy: 'manual',
  });
  assert.equal(result, 'skipped-manual');
  assert.equal(called, 0, 'manual 에서는 핸들러 호출 금지');
});

test('변경 파일이 없으면 skipped-no-changes 를 돌려주고 핸들러를 부르지 않는다', () => {
  reset();
  let called = 0;
  setTaskBoundaryHandler(() => { called += 1; });
  const result = notifyTaskBoundary(
    { ...baseEvent(), changedFiles: [] },
    DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG,
  );
  assert.equal(result, 'skipped-no-changes');
  assert.equal(called, 0);
});

test('정상 경로 — 핸들러가 즉시 호출되고 dispatched 를 돌려준다', () => {
  reset();
  const observed: Array<{ taskId: string; reason: string }> = [];
  setTaskBoundaryHandler((event, meta) => {
    observed.push({ taskId: event.taskId, reason: meta.reason });
  });
  const result = notifyTaskBoundary(baseEvent(), DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG);
  assert.equal(result, 'dispatched');
  assert.deepEqual(observed, [{ taskId: 't1', reason: 'immediate' }]);
});

test('핸들러 미등록이면 no-handler 를 돌려준다', () => {
  reset();
  const result = notifyTaskBoundary(baseEvent(), DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG);
  assert.equal(result, 'no-handler');
});

test('세션 소진 중에는 큐잉만 되고 핸들러는 호출되지 않는다 (§4 폴백 가드)', () => {
  reset();
  let called = 0;
  setTaskBoundaryHandler(() => { called += 1; });
  setAgentWorkerSessionStatus('exhausted');
  const result = notifyTaskBoundary(baseEvent(), DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG);
  assert.equal(result, 'queued-exhausted');
  assert.equal(called, 0, 'exhausted 상태에서는 실제 호출 차단');
  assert.equal(getQueuedTaskBoundaryCount(), 1);
});

test('exhausted → active 복귀 시 flushQueuedTaskBoundaries 가 FIFO 로 되감는다', () => {
  reset();
  const observed: string[] = [];
  setTaskBoundaryHandler((e, meta) => observed.push(`${e.taskId}:${meta.reason}`));
  setAgentWorkerSessionStatus('exhausted');
  notifyTaskBoundary({ ...baseEvent(), taskId: 'A' }, DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG);
  notifyTaskBoundary({ ...baseEvent(), taskId: 'B' }, DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG);
  notifyTaskBoundary({ ...baseEvent(), taskId: 'C' }, DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG);
  assert.equal(getQueuedTaskBoundaryCount(), 3);
  setAgentWorkerSessionStatus('active');
  const n = flushQueuedTaskBoundaries();
  assert.equal(n, 3);
  assert.deepEqual(observed, ['A:flush', 'B:flush', 'C:flush']);
  assert.equal(getQueuedTaskBoundaryCount(), 0);
});

test('exhausted 상태에서 flush 를 호출해도 큐를 비우지 않는다 (세션 복귀 후에만 되감기)', () => {
  reset();
  setTaskBoundaryHandler(() => {});
  setAgentWorkerSessionStatus('exhausted');
  notifyTaskBoundary(baseEvent(), DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG);
  assert.equal(getQueuedTaskBoundaryCount(), 1);
  const n = flushQueuedTaskBoundaries();
  assert.equal(n, 0, 'exhausted 중 flush 는 no-op');
  assert.equal(getQueuedTaskBoundaryCount(), 1, '큐는 보존되어 있어야 한다');
});

test('핸들러 예외는 이후 큐 처리와 다른 이벤트에 전파되지 않는다', () => {
  reset();
  let calls = 0;
  setTaskBoundaryHandler(() => {
    calls += 1;
    throw new Error('boom');
  });
  const result = notifyTaskBoundary(baseEvent(), DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG);
  assert.equal(result, 'dispatched', '예외가 나도 dispatched 로 카운트된다');
  assert.equal(calls, 1);
  // 한 번 더 호출해도 모듈이 망가지지 않는다.
  const again = notifyTaskBoundary(baseEvent(), DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG);
  assert.equal(again, 'dispatched');
});
