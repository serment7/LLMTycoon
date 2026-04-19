// Run with: npx tsx --test tests/claudeErrorsRetryPolicy.regression.test.ts
//
// QA: 지시 #697c4e29 재시도 정책·백오프·withClaudeRetry 오케스트레이터 회귀.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  retryPolicyFor,
  computeBackoffMs,
  withClaudeRetry,
  classifyClaudeError,
} from '../src/server/claudeErrors.ts';

test('재시도 불가 — bad_request / auth 는 retriable=false', () => {
  assert.equal(retryPolicyFor('bad_request').retriable, false);
  assert.equal(retryPolicyFor('auth').retriable, false);
  assert.equal(retryPolicyFor('bad_request').maxRetries, 0);
});

test('retriable 카테고리는 maxRetries >= 2 이며 지수 백오프 base 가 양수', () => {
  for (const cat of ['rate_limit', 'overloaded', 'api_error', 'timeout', 'network'] as const) {
    const p = retryPolicyFor(cat);
    assert.equal(p.retriable, true);
    assert.ok(p.maxRetries >= 2, `${cat} maxRetries >= 2`);
    assert.ok(p.baseMs > 0, `${cat} baseMs > 0`);
    assert.ok(p.capMs > 0, `${cat} capMs > 0`);
  }
});

test('computeBackoffMs — respectRetryAfter=true 이면 retryAfterMs 를 cap 으로 제한해 반환', () => {
  const policy = retryPolicyFor('rate_limit');
  // retryAfter 10s, cap 30s → 10s 그대로
  assert.equal(computeBackoffMs(1, policy, 10_000, () => 0.5), 10_000);
  // retryAfter 60s, cap 30s → 30s 로 잘림
  assert.equal(computeBackoffMs(1, policy, 60_000, () => 0.5), 30_000);
});

test('computeBackoffMs — 지수 백오프 + ±jitterRatio 흔들림', () => {
  const policy = retryPolicyFor('api_error'); // base 1000, cap 15000, jitter 0.25
  // attempt=1, random=0.5(중앙) → jitter=0 → exp 1000
  assert.equal(computeBackoffMs(1, policy, undefined, () => 0.5), 1000);
  // attempt=3 → exp=4000, random=1(최대 +25%) → 5000
  assert.equal(computeBackoffMs(3, policy, undefined, () => 1), 5000);
  // attempt=2 → exp=2000, random=0(최대 -25%) → 1500
  assert.equal(computeBackoffMs(2, policy, undefined, () => 0), 1500);
});

test('computeBackoffMs — exp 가 cap 을 넘으면 cap 으로 제한 후 jitter 적용', () => {
  const policy = retryPolicyFor('timeout'); // base 500, cap 5000, jitter 0.25
  // attempt=10 → 500 * 2^9 = 256000 → cap 5000, jitter=0 → 5000
  assert.equal(computeBackoffMs(10, policy, undefined, () => 0.5), 5000);
});

test('withClaudeRetry — 성공 시 fn 을 한 번만 호출한다', async () => {
  let calls = 0;
  const out = await withClaudeRetry(async () => { calls++; return 'ok'; }, {
    sleep: async () => {}, random: () => 0.5,
  });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('withClaudeRetry — timeout 실패 2회 후 성공(정책 maxRetries=2 안쪽)', async () => {
  let calls = 0;
  const out = await withClaudeRetry(async () => {
    calls++;
    if (calls < 3) throw { name: 'AbortError', message: 'timed out' };
    return 'finally';
  }, { sleep: async () => {}, random: () => 0.5 });
  assert.equal(out, 'finally');
  assert.equal(calls, 3, '최초 1회 + 재시도 2회');
});

test('withClaudeRetry — bad_request 는 재시도 없이 즉시 throw', async () => {
  let calls = 0;
  await assert.rejects(async () => {
    await withClaudeRetry(async () => {
      calls++;
      throw { status: 400, message: 'invalid' };
    }, { sleep: async () => {}, random: () => 0.5 });
  });
  assert.equal(calls, 1, '재시도 없이 1회만 시도되어야 한다');
});

test('withClaudeRetry — onError 콜백이 분류된 카테고리로 호출된다', async () => {
  const observed: string[] = [];
  await assert.rejects(async () => {
    await withClaudeRetry(async () => { throw { status: 401 }; }, {
      sleep: async () => {}, random: () => 0.5,
      onError: c => observed.push(c.category),
    });
  });
  assert.deepEqual(observed, ['auth']);
});

test('withClaudeRetry — maxTotalRetries 로 정책 상한을 낮출 수 있다', async () => {
  let calls = 0;
  await assert.rejects(async () => {
    await withClaudeRetry(async () => {
      calls++;
      throw { status: 500 }; // api_error, maxRetries=3
    }, { sleep: async () => {}, random: () => 0.5, maxTotalRetries: 1 });
  });
  assert.equal(calls, 2, '최초 1회 + maxTotalRetries=1 적용으로 재시도 1회 = 총 2회');
});

test('withClaudeRetry — rate_limit 재시도 시 sleep 인자로 retry-after 반영', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const out = await withClaudeRetry(async () => {
    calls++;
    if (calls === 1) {
      // eslint-disable-next-line no-throw-literal
      throw { status: 429, headers: { 'retry-after': '2' } };
    }
    return 'ok';
  }, {
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
  });
  assert.equal(out, 'ok');
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 2000, '두 번째 시도 전 retry-after 2s 를 정확히 기다렸다');
});

test('분류기 통합 — 재시도 정책과 분류기 매트릭스가 같은 카테고리 집합을 공유', () => {
  for (const cat of ['rate_limit','overloaded','api_error','bad_request','auth','timeout','network'] as const) {
    assert.ok(retryPolicyFor(cat), `정책 누락: ${cat}`);
  }
  // 분류기가 알 수 없는 에러에 대해 정의되지 않은 카테고리를 돌려주지 않는지 확인.
  const c = classifyClaudeError({ status: 418 });
  assert.ok(['rate_limit','overloaded','api_error','bad_request','auth','timeout','network'].includes(c.category));
});
