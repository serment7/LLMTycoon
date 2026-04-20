// Run with: npx tsx --test tests/llm/requestQueue.spec.ts
//
// 지시 #4cc1a134 — `src/llm/requestQueue.ts` 요청 회복층 엔진 계약 잠금.
//
// 축
//   Q1. 429 한 번 발생 → 1회 재시도 후 성공, 대기 시간은 baseDelayMs.
//   Q2. 529 연속 3회 → 4회차 성공, 누적 대기 시간 = base·(1+2+4).
//   Q3. 네트워크 오류 연속 6회 → maxRetries=5 초과로 실패(RequestQueueError.reason='network').
//   Q4. TimeoutError 도 재시도 대상(reason='timeout').
//   Q5. 4xx(400) 은 재시도 없이 즉시 실패.
//   Q6. AbortSignal — 대기 중 취소 → 'aborted' 이벤트 emit · Promise reject · execute 미호출.
//   Q7. 동일 callId 중복 enqueue → 같은 Promise 반환 · execute 한 번만 호출.
//   Q8. 취소 시 refundedUsage 가 onRefund · usageLog.appendLine 으로 전달된다.
//   Q9. 우선순위 — 작은 priority 가 먼저 실행된다.
//   Q10. 이벤트 — requesting(retry) · rate-limited · 재시도 attempt 번호 순서대로 emit.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRequestQueue,
  createRequestQueueBus,
  RequestQueueError,
  type RequestQueueEvent,
} from '../../src/llm/requestQueue.ts';
import { createInMemoryUsageLog } from '../../src/llm/usageLog.ts';

interface TestError extends Error { status?: number; code?: string }
function mkHttpError(status: number): TestError {
  const e = new Error(`http-${status}`) as TestError;
  e.status = status;
  return e;
}
function mkTypeError(): TestError {
  const e = new Error('network') as TestError;
  e.name = 'TypeError';
  return e;
}
function mkTimeoutError(): TestError {
  const e = new Error('request timed out') as TestError;
  e.name = 'TimeoutError';
  return e;
}

function collectBus() {
  const bus = createRequestQueueBus();
  const events: RequestQueueEvent[] = [];
  bus.subscribe((e) => { events.push(e); });
  return { bus, events };
}

function makeFakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => { delays.push(ms); },
  };
}

test('Q1. 429 한 번 발생 → 1회 재시도 후 성공, 대기 시간은 baseDelayMs', async () => {
  const { bus, events } = collectBus();
  const { sleep, delays } = makeFakeSleep();
  const q = createRequestQueue({ bus, sleep, jitter: false, baseDelayMs: 300, random: () => 0.5 });

  let attempts = 0;
  const result = await q.enqueue({
    callId: 'c1',
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw mkHttpError(429);
      return { result: 'ok' };
    },
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [300], 'baseDelayMs 1회 대기');
  // 이벤트: retry(attempt=1) · rate-limited · retry(attempt=2).
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('rate-limited'));
});

test('Q2. 529 연속 3회 → 4회차 성공, 누적 대기 = base·(1+2+4)', async () => {
  const { bus } = collectBus();
  const { sleep, delays } = makeFakeSleep();
  const q = createRequestQueue({ bus, sleep, jitter: false, baseDelayMs: 100 });
  let attempts = 0;
  const result = await q.enqueue({
    callId: 'c2',
    execute: async () => {
      attempts += 1;
      if (attempts <= 3) throw mkHttpError(529);
      return { result: 42 };
    },
  });
  assert.equal(result, 42);
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [100, 200, 400]);
});

test('Q3. 네트워크 오류 6회 연속 → maxRetries=5 초과로 실패', async () => {
  const { bus } = collectBus();
  const { sleep } = makeFakeSleep();
  const q = createRequestQueue({ bus, sleep, jitter: false, baseDelayMs: 10, maxRetries: 5 });
  let attempts = 0;
  await assert.rejects(
    () => q.enqueue({
      callId: 'c3',
      execute: async () => {
        attempts += 1;
        throw mkTypeError();
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof RequestQueueError);
      assert.equal((err as RequestQueueError).reason, 'network');
      assert.equal((err as RequestQueueError).attempts, 6);
      return true;
    },
  );
  assert.equal(attempts, 6, '초기 1 + 재시도 5 = 6회 실행');
});

test('Q4. TimeoutError 는 재시도 대상(reason=timeout)', async () => {
  const { bus } = collectBus();
  const { sleep, delays } = makeFakeSleep();
  const q = createRequestQueue({ bus, sleep, jitter: false, baseDelayMs: 20 });
  let attempts = 0;
  const result = await q.enqueue({
    callId: 'c4',
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw mkTimeoutError();
      return { result: 'ok' };
    },
  });
  assert.equal(result, 'ok');
  assert.equal(delays.length, 1);
});

test('Q5. 4xx(400) 은 재시도 없이 즉시 실패', async () => {
  const { bus } = collectBus();
  const { sleep, delays } = makeFakeSleep();
  const q = createRequestQueue({ bus, sleep, jitter: false });
  let attempts = 0;
  await assert.rejects(
    () => q.enqueue({
      callId: 'c5',
      execute: async () => {
        attempts += 1;
        throw mkHttpError(400);
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof RequestQueueError);
      assert.equal((err as RequestQueueError).reason, 'other');
      return true;
    },
  );
  assert.equal(attempts, 1);
  assert.equal(delays.length, 0, '재시도 없음 → 대기 없음');
});

test('Q6. AbortSignal — 대기 중 취소 → execute 미호출, reject', async () => {
  const { bus } = collectBus();
  const { sleep } = makeFakeSleep();
  const q = createRequestQueue({ bus, sleep, jitter: false });

  // 먼저 느린 작업을 큐에 올려 앞자리를 채운다.
  let slowAttempts = 0;
  const slowPromise = q.enqueue({
    callId: 'slow',
    execute: async () => {
      slowAttempts += 1;
      // 미세한 대기 — 두 번째 enqueue 가 wait 큐에 들어갈 시간을 만든다.
      await new Promise((r) => setTimeout(r, 5));
      return { result: 'slow-done' };
    },
  });

  const ac = new AbortController();
  let secondAttempts = 0;
  const pending = q.enqueue({
    callId: 'second',
    signal: ac.signal,
    execute: async () => {
      secondAttempts += 1;
      return { result: 'never' };
    },
  });

  ac.abort();

  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof RequestQueueError);
    assert.equal((err as RequestQueueError).reason, 'aborted');
    return true;
  });
  assert.equal(secondAttempts, 0, 'execute 는 호출되지 않아야');

  // 느린 작업은 정상 완료.
  const r = await slowPromise;
  assert.equal(r, 'slow-done');
  assert.equal(slowAttempts, 1);
});

test('Q7. 중복 callId dedup — execute 는 한 번만 호출되고 같은 Promise 반환', async () => {
  const { bus } = collectBus();
  const { sleep } = makeFakeSleep();
  const q = createRequestQueue({ bus, sleep, jitter: false });
  let calls = 0;
  const p1 = q.enqueue({
    callId: 'dup',
    execute: async () => { calls += 1; return { result: 'r' }; },
  });
  const p2 = q.enqueue({
    callId: 'dup',
    execute: async () => { calls += 1; return { result: 'r2' }; },
  });
  assert.strictEqual(p1, p2, '같은 Promise 참조가 반환되어야');
  const r = await p1;
  assert.equal(r, 'r');
  assert.equal(calls, 1);
});

test('Q8. 취소 시 refundedUsage → onRefund + usageLog.appendLine("refund":true)', async () => {
  const { bus } = collectBus();
  const { sleep } = makeFakeSleep();
  const log = createInMemoryUsageLog();
  const refunds: Array<{ callId: string; input: number }> = [];
  const q = createRequestQueue({
    bus, sleep, jitter: false,
    usageLog: log,
    onRefund: (callId, u) => { refunds.push({ callId, input: u.input_tokens }); },
  });

  // 앞자리 느린 작업으로 두 번째가 대기 큐에 머무르게 한다.
  const slowP = q.enqueue({
    callId: 'slow2',
    execute: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { result: 'done' };
    },
  });

  const ac = new AbortController();
  const pending = q.enqueue({
    callId: 'will-cancel',
    signal: ac.signal,
    refundedUsage: {
      input_tokens: 111, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      model: 'claude-opus-4-7', at: '2026-04-21T12:00:00.000Z',
    },
    execute: async () => ({ result: 'x' }),
  });
  ac.abort();
  await assert.rejects(pending);

  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].callId, 'will-cancel');
  assert.equal(refunds[0].input, 111);

  // 드레인 시 appendLine 이 fire-and-forget 이므로 미세 대기 후 스냅샷 조회.
  await new Promise((r) => setTimeout(r, 0));
  const snap = log.snapshot();
  assert.equal(snap.length, 1);
  const parsed = JSON.parse(snap[0]) as { refund?: boolean; callId?: string; input?: number };
  assert.equal(parsed.refund, true);
  assert.equal(parsed.callId, 'will-cancel');
  assert.equal(parsed.input, 111);
  await slowP;
});

test('Q9. 우선순위 — 작은 priority 가 먼저 실행된다', async () => {
  const { bus } = collectBus();
  const { sleep } = makeFakeSleep();
  const q = createRequestQueue({ bus, sleep, jitter: false });
  const order: string[] = [];
  // 먼저 도착하지만 priority 높은(=후순위) 작업.
  const pA = q.enqueue({
    callId: 'A', priority: 10,
    execute: async () => {
      order.push('A');
      return { result: 'A' };
    },
  });
  const pB = q.enqueue({
    callId: 'B', priority: 1,
    execute: async () => {
      order.push('B');
      return { result: 'B' };
    },
  });
  const pC = q.enqueue({
    callId: 'C', priority: 5,
    execute: async () => {
      order.push('C');
      return { result: 'C' };
    },
  });
  await Promise.all([pA, pB, pC]);
  assert.deepEqual(order, ['B', 'C', 'A']);
});

test('Q10. 이벤트 — retry attempt 1..N + rate-limited 발화 순서', async () => {
  const { bus, events } = collectBus();
  const { sleep } = makeFakeSleep();
  const q = createRequestQueue({ bus, sleep, jitter: false, baseDelayMs: 10 });
  let attempts = 0;
  await q.enqueue({
    callId: 'events',
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw mkHttpError(429);
      return { result: 'ok' };
    },
  });
  const retries = events.filter((e) => e.kind === 'retry');
  const rateLimited = events.filter((e) => e.kind === 'rate-limited');
  assert.ok(retries.length >= 2, 'initial + retry 최소 2회');
  assert.equal(rateLimited.length, 1);
  assert.equal((retries[0] as { attempt: number }).attempt, 1);
  assert.equal((retries[retries.length - 1] as { attempt: number }).attempt, 2);
});
