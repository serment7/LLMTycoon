// Run with: npx tsx --test tests/unit/pendingRequestQueue.spec.ts
//
// 지시 #3f1b7597 §1·§4 — 실패 요청 영속 재시도 큐의 순수 계약.
// 실제 IDB 는 브라우저 전역이라 Node 환경에서는 `createMemoryPendingRequestStorage`
// 를 주입해 동일 계약을 잠근다. 브라우저 어댑터는 IDB 미존재 시 자동으로 메모리로
// 폴백하도록 설계됐다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPendingRequestQueue,
  createMemoryPendingRequestStorage,
  createIndexedDbPendingRequestStorage,
  computeNextAttemptDelayMs,
  type PendingRequestQueue,
  type PendingRequest,
} from '../../src/utils/pendingRequestQueue.ts';

function newQueue(overrides: {
  now?: () => number;
  jitter?: () => number;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
} = {}): PendingRequestQueue {
  return createPendingRequestQueue({
    adapter: createMemoryPendingRequestStorage(),
    now: overrides.now ?? (() => 1_000_000),
    jitter: overrides.jitter ?? (() => 1),
    maxAttempts: overrides.maxAttempts ?? 3,
    initialBackoffMs: overrides.initialBackoffMs ?? 1000,
    maxBackoffMs: overrides.maxBackoffMs ?? 60_000,
  });
}

// ─── 저장·복구·목록 ──────────────────────────────────────────────────────────

test('enqueue → list 는 같은 항목을 돌려준다', async () => {
  const q = newQueue();
  await q.enqueue({
    id: 'task-A',
    payload: { endpoint: '/api/tasks', body: { hello: 'world' }, conversationId: 'conv-1' },
  });
  const all = await q.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'task-A');
  assert.equal(all[0].payload.conversationId, 'conv-1');
  assert.equal(all[0].attempts, 0);
  assert.equal(all[0].schemaVersion, 1);
});

test('중복 방지 — 같은 id 는 한 항목만 유지하고 attempts·오류만 갱신', async () => {
  const q = newQueue();
  await q.enqueue({ id: 'task-A', payload: { endpoint: '/api/tasks', body: { v: 1 } } });
  const updated = await q.enqueue({
    id: 'task-A',
    payload: { endpoint: '/api/tasks', body: { v: 999 } },
    errorCode: 'UPLOAD_FAILED',
    errorMessage: '두 번째 실패',
  });
  const all = await q.list();
  assert.equal(all.length, 1);
  assert.equal(updated.attempts, 1);
  assert.equal(updated.lastErrorCode, 'UPLOAD_FAILED');
  // 페이로드는 기존을 유지해 "처음 의도한 요청" 이 보존된다.
  assert.deepEqual((all[0].payload.body as { v: number }).v, 1);
});

// ─── 지수 백오프 ─────────────────────────────────────────────────────────────

test('computeNextAttemptDelayMs — attempts 가 증가할수록 지연이 커지고, maxBackoff 에서 수렴', () => {
  const base = { initialBackoffMs: 1000, maxBackoffMs: 8000, jitter: () => 1 };
  const d0 = computeNextAttemptDelayMs(0, base);
  const d1 = computeNextAttemptDelayMs(1, base);
  const d2 = computeNextAttemptDelayMs(2, base);
  const d10 = computeNextAttemptDelayMs(10, base);
  assert.ok(d1 > d0, '1회차 지연 > 0회차');
  assert.ok(d2 > d1, '2회차 지연 > 1회차');
  assert.ok(d10 <= base.maxBackoffMs, 'maxBackoff 를 초과하지 않는다');
  const jitterLow = computeNextAttemptDelayMs(0, { ...base, jitter: () => 0 });
  assert.ok(jitterLow < d0, 'jitter 값이 낮으면 같은 attempts 에도 지연이 짧다');
});

// ─── runRetryPass — 성공·실패·영구 드롭·보류 ─────────────────────────────────

test('runRetryPass — 성공 항목은 제거되고 onRecovered 가 호출된다', async () => {
  // nextAttemptAtMs 를 앞서 지난 시각에 넣어 즉시 재시도 가능하게 한다.
  const adapter = createMemoryPendingRequestStorage();
  await adapter.put({
    schemaVersion: 1, id: 'task-A',
    payload: { endpoint: '/api/tasks', body: 'a' },
    attempts: 0, enqueuedAtMs: 0, nextAttemptAtMs: 0,
  });
  const q = createPendingRequestQueue({
    adapter,
    now: () => 1_000_000,
    jitter: () => 1,
    maxAttempts: 3,
  });
  const recovered: string[] = [];
  const report = await q.runRetryPass({
    execute: async () => ({ ok: true }),
    onRecovered: (req) => recovered.push(req.id),
  });
  assert.equal(report.succeeded.length, 1);
  assert.equal(recovered[0], 'task-A');
  assert.equal((await q.list()).length, 0);
});

test('runRetryPass — 실패는 attempts 증가 + 다음 시각이 미래로 이동(보류)', async () => {
  let t = 1000;
  const adapter = createMemoryPendingRequestStorage();
  await adapter.put({
    schemaVersion: 1, id: 'task-B',
    payload: { endpoint: '/api/tasks', body: 'b' },
    attempts: 0, enqueuedAtMs: 0, nextAttemptAtMs: 0,
  });
  const q = createPendingRequestQueue({
    adapter, now: () => t, jitter: () => 1,
    initialBackoffMs: 1000, maxBackoffMs: 8000, maxAttempts: 3,
  });
  const rep = await q.runRetryPass({
    execute: async () => ({ ok: false, errorCode: 'UPLOAD_FAILED', errorMessage: '일시 오류' }),
  });
  assert.equal(rep.failed.length, 1);
  assert.equal(rep.succeeded.length, 0);
  const all = await q.list();
  assert.equal(all[0].attempts, 1);
  assert.equal(all[0].lastErrorCode, 'UPLOAD_FAILED');
  assert.ok(all[0].nextAttemptAtMs > t, '다음 시각은 현재 시각보다 미래여야 한다');
});

test('runRetryPass — maxAttempts 초과는 영구 드롭(droppedPermanent)', async () => {
  const adapter = createMemoryPendingRequestStorage();
  await adapter.put({
    schemaVersion: 1, id: 'task-C',
    payload: { endpoint: '/api/tasks', body: 'c' },
    attempts: 2, enqueuedAtMs: 0, nextAttemptAtMs: 0,
  });
  const q = createPendingRequestQueue({
    adapter, now: () => 1000, jitter: () => 1,
    maxAttempts: 3,
  });
  const rep = await q.runRetryPass({ execute: async () => ({ ok: false }) });
  assert.equal(rep.droppedPermanent.length, 1);
  assert.equal((await q.list()).length, 0);
});

test('runRetryPass — 대기중 항목(nextAttemptAtMs > now) 은 deferred 로 남는다', async () => {
  const adapter = createMemoryPendingRequestStorage();
  await adapter.put({
    schemaVersion: 1, id: 'task-D',
    payload: { endpoint: '/api/tasks', body: 'd' },
    attempts: 0, enqueuedAtMs: 0, nextAttemptAtMs: 10_000_000,
  });
  const q = createPendingRequestQueue({
    adapter, now: () => 1_000_000, jitter: () => 1,
  });
  let executed = 0;
  const rep = await q.runRetryPass({ execute: async () => { executed += 1; return { ok: true }; } });
  assert.equal(rep.deferred.length, 1);
  assert.equal(executed, 0, 'deferred 는 execute 를 호출하지 않는다');
  assert.equal((await q.list()).length, 1);
});

test('createIndexedDbPendingRequestStorage — IDB 미존재 환경에서도 계약 유지(메모리 폴백)', async () => {
  const q = createPendingRequestQueue({
    adapter: createIndexedDbPendingRequestStorage(),
    now: () => 123,
    jitter: () => 1,
  });
  await q.enqueue({ id: 'task-E', payload: { endpoint: '/api/tasks', body: 'e' } });
  const all = await q.list();
  assert.equal(all[0].id, 'task-E');
});

test('runRetryPass — giveUp 은 attempts 와 무관하게 즉시 영구 드롭', async () => {
  const adapter = createMemoryPendingRequestStorage();
  await adapter.put({
    schemaVersion: 1, id: 'task-F',
    payload: { endpoint: '/api/tasks', body: 'f' },
    attempts: 0, enqueuedAtMs: 0, nextAttemptAtMs: 0,
  });
  const q = createPendingRequestQueue({ adapter, now: () => 1000, jitter: () => 1, maxAttempts: 5 });
  const rep = await q.runRetryPass({ execute: async () => ({ ok: false, giveUp: true, errorCode: 'BAD_REQUEST' }) });
  assert.equal(rep.droppedPermanent.length, 1);
  assert.equal(rep.failed.length, 0);
});

// ─── dequeue · clear · 자동 id · 예외·중단 ────────────────────────────────────

test('dequeue — 지정 id 만 제거하고 나머지는 유지', async () => {
  const q = newQueue();
  await q.enqueue({ id: 'task-X', payload: { endpoint: '/api/tasks', body: 'x' } });
  await q.enqueue({ id: 'task-Y', payload: { endpoint: '/api/tasks', body: 'y' } });
  await q.dequeue('task-X');
  const all = await q.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'task-Y');
});

test('clear — 모든 항목을 일괄 제거', async () => {
  const q = newQueue();
  await q.enqueue({ id: 'task-X', payload: { endpoint: '/api/tasks', body: 'x' } });
  await q.enqueue({ id: 'task-Y', payload: { endpoint: '/api/tasks', body: 'y' } });
  await q.clear();
  assert.equal((await q.list()).length, 0);
});

test('enqueue — id 를 생략하면 주입된 generateId 로 새 항목이 생성된다', async () => {
  let counter = 0;
  const q = createPendingRequestQueue({
    adapter: createMemoryPendingRequestStorage(),
    now: () => 1000,
    jitter: () => 1,
    generateId: () => `auto-${++counter}`,
  });
  const first = await q.enqueue({ payload: { endpoint: '/api/tasks', body: 1 } });
  const second = await q.enqueue({ payload: { endpoint: '/api/tasks', body: 2 } });
  assert.equal(first.id, 'auto-1');
  assert.equal(second.id, 'auto-2');
  assert.equal((await q.list()).length, 2);
});

test('runRetryPass — execute 가 예외를 던져도 실패로 취급되고 attempts 가 증가한다', async () => {
  const adapter = createMemoryPendingRequestStorage();
  await adapter.put({
    schemaVersion: 1, id: 'task-Throw',
    payload: { endpoint: '/api/tasks', body: 't' },
    attempts: 0, enqueuedAtMs: 0, nextAttemptAtMs: 0,
  });
  const q = createPendingRequestQueue({ adapter, now: () => 1000, jitter: () => 1, maxAttempts: 3 });
  const rep = await q.runRetryPass({
    execute: async () => { throw Object.assign(new Error('네트워크 끊김'), { code: 'NET_ERR' }); },
  });
  assert.equal(rep.failed.length, 1);
  assert.equal(rep.succeeded.length, 0);
  const all = await q.list();
  assert.equal(all[0].attempts, 1);
  assert.equal(all[0].lastErrorCode, 'NET_ERR');
  assert.equal(all[0].lastErrorMessage, '네트워크 끊김');
});

test('runRetryPass — AbortSignal 이 이미 중단된 상태면 execute 를 호출하지 않는다', async () => {
  const adapter = createMemoryPendingRequestStorage();
  await adapter.put({
    schemaVersion: 1, id: 'task-Abort',
    payload: { endpoint: '/api/tasks', body: 'a' },
    attempts: 0, enqueuedAtMs: 0, nextAttemptAtMs: 0,
  });
  const q = createPendingRequestQueue({ adapter, now: () => 1000, jitter: () => 1 });
  const controller = new AbortController();
  controller.abort();
  let executed = 0;
  const rep = await q.runRetryPass({
    execute: async () => { executed += 1; return { ok: true }; },
    signal: controller.signal,
  });
  assert.equal(executed, 0, '중단 신호는 execute 호출을 건너뛰어야 한다');
  assert.equal(rep.succeeded.length, 0);
  assert.equal((await q.list()).length, 1, '중단된 재시도 패스는 항목을 그대로 보존한다');
});

test('runRetryPass — 한 번의 패스에서 성공·실패·영구드롭·보류가 뒤섞여도 각각 올바르게 분류', async () => {
  const adapter = createMemoryPendingRequestStorage();
  await adapter.put({
    schemaVersion: 1, id: 'ok', payload: { endpoint: '/api/tasks', body: 1 },
    attempts: 0, enqueuedAtMs: 0, nextAttemptAtMs: 0,
  });
  await adapter.put({
    schemaVersion: 1, id: 'fail', payload: { endpoint: '/api/tasks', body: 2 },
    attempts: 0, enqueuedAtMs: 0, nextAttemptAtMs: 0,
  });
  await adapter.put({
    schemaVersion: 1, id: 'dropped', payload: { endpoint: '/api/tasks', body: 3 },
    attempts: 2, enqueuedAtMs: 0, nextAttemptAtMs: 0,
  });
  await adapter.put({
    schemaVersion: 1, id: 'deferred', payload: { endpoint: '/api/tasks', body: 4 },
    attempts: 0, enqueuedAtMs: 0, nextAttemptAtMs: 10_000_000,
  });
  const q = createPendingRequestQueue({
    adapter, now: () => 1000, jitter: () => 1, maxAttempts: 3,
  });
  const rep = await q.runRetryPass({
    execute: async (req) => {
      if (req.id === 'ok') return { ok: true };
      return { ok: false, errorCode: 'RETRY' };
    },
  });
  assert.deepEqual(rep.succeeded.map(r => r.id), ['ok']);
  assert.deepEqual(rep.failed.map(r => r.id), ['fail']);
  assert.deepEqual(rep.droppedPermanent.map(r => r.id), ['dropped']);
  assert.deepEqual(rep.deferred.map(r => r.id), ['deferred']);
  const remaining = (await q.list()).map(r => r.id).sort();
  assert.deepEqual(remaining, ['deferred', 'fail']);
});

test('runRetryPass — onRecovered 가 예외를 던져도 큐 상태는 정상 처리', async () => {
  const adapter = createMemoryPendingRequestStorage();
  await adapter.put({
    schemaVersion: 1, id: 'task-NotifyBoom',
    payload: { endpoint: '/api/tasks', body: 'n' },
    attempts: 0, enqueuedAtMs: 0, nextAttemptAtMs: 0,
  });
  const q = createPendingRequestQueue({ adapter, now: () => 1000, jitter: () => 1 });
  const rep = await q.runRetryPass({
    execute: async () => ({ ok: true }),
    onRecovered: () => { throw new Error('토스트 표시 실패'); },
  });
  assert.equal(rep.succeeded.length, 1);
  assert.equal((await q.list()).length, 0, '콜백 예외는 큐에서의 항목 제거를 되돌리지 않는다');
});

// `PendingRequest` 타입은 위 runRetryPass 테스트 내 execute 콜백 매개변수 추론에
// 쓰이고 있어 별도 참조는 필요하지 않다. 명시적으로 사용해 import 의도를 잠근다.
const _typeProbe: PendingRequest | null = null;
void _typeProbe;
