// Run with: npx tsx --test tests/helpers/claudeMock.regression.test.ts
//
// QA 회귀(지시 #5f4902b0) · 공통 헬퍼 `tests/helpers/claudeMock.ts` 계약 잠금.
//
// 본 헬퍼가 `vi.useFakeTimers` 동등 효과(수동 시계 + fetch 스텁) 를 제공한다는
// 공개 계약을 잠근다. 장래 vitest 도입 시 공개 API 는 유지하고 내부만 교체
// 하도록 시그니처·동작을 고정.
//
//   C1  installFakeTimers · advance(ms) 가 setTimeout/setInterval 을 정확한 순서로 flush
//   C2  installFakeTimers · uninstall 후 전역 타이머가 원복
//   C3  installClaudeFetchMock · 매칭 경로 응답 + calls 누적 + 미매치 404
//   C4  mockSessionStatus 5 시나리오 — status 값·HTTP 코드·category 필드·retry-after

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeTimers,
  installClaudeFetchMock,
  mockSessionStatus,
  advanceUntilIdle,
} from './claudeMock.ts';

// ─── C1 · 타이머 순서 ────────────────────────────────────────────────────

test('C1 · advance 는 due 오름차순으로 타이머를 flush 한다', () => {
  const t = installFakeTimers({ now: 0 });
  try {
    const order: string[] = [];
    setTimeout(() => order.push('A+30s'), 30_000);
    setTimeout(() => order.push('B+10s'), 10_000);
    setInterval(() => order.push(`tick@${t.now()}`), 5_000);

    t.advance(12_000);
    // 5000 tick → 10000 에서 B(due=10000, 삽입 순서 1) → interval(재스케줄 due=10000, 삽입 순서 2).
    // 동일 due 에서는 삽입 순서대로 FIFO 가 유지되어야 한다.
    assert.deepEqual(order, ['tick@5000', 'B+10s', 'tick@10000']);

    t.advance(30_000);
    // 20, 25, 30, 35, 40, (새 tick 은 42 에 예정) — advance target 은 42000
    assert.ok(order.includes('A+30s'));
  } finally { t.uninstall(); }
});

test('C1 · advanceUntilIdle 은 대기 중 타이머를 전부 소진한다', () => {
  const t = installFakeTimers({ now: 0 });
  try {
    setTimeout(() => { /* noop */ }, 1_000);
    setTimeout(() => { /* noop */ }, 10_000);
    setTimeout(() => { /* noop */ }, 60_000);
    // advanceUntilIdle 은 "대기 중 타이머" 기준이므로 인터벌이 없을 때 종료.
    advanceUntilIdle(t, 60_000);
    assert.equal(t.pending(), 0);
  } finally { t.uninstall(); }
});

// ─── C2 · uninstall 원복 ─────────────────────────────────────────────────

test('C2 · uninstall 후 전역 타이머가 원복되어 진짜 setTimeout 이 동작한다', async () => {
  const t = installFakeTimers({ now: 0 });
  const beforeNow = Date.now();
  assert.equal(beforeNow, 0, '가짜 시계 활성 상태에서는 Date.now 가 0');
  t.uninstall();

  const after = await new Promise<number>(res => {
    const start = Date.now();
    setTimeout(() => res(Date.now() - start), 5);
  });
  assert.ok(after >= 0 && after < 1_000, '진짜 setTimeout 으로 5ms 대기가 완료되어야 한다');
});

// ─── C3 · fetch 모의 라우팅 ──────────────────────────────────────────────

test('C3 · installClaudeFetchMock 매칭/미매치 동작과 calls 누적', async () => {
  const { fetcher, calls } = installClaudeFetchMock([
    {
      match: /\/api\/claude\/session-status$/,
      respond: () => mockSessionStatus('active'),
    },
    {
      method: 'POST',
      match: /\/api\/media\/upload$/,
      respond: () => new Response('{"ok":true}', { status: 200 }),
    },
  ]);

  const res1 = await fetcher('/api/claude/session-status');
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.status, 'active');

  const res2 = await fetcher('/api/media/upload', { method: 'POST' });
  assert.equal(res2.status, 200);

  const res3 = await fetcher('/api/unknown');
  assert.equal(res3.status, 404, '미매치 경로는 404 폴백');

  assert.equal(calls.length, 3);
  assert.equal(calls[1].init?.method, 'POST');
});

// ─── C4 · 세션 상태 시나리오 프리셋 ──────────────────────────────────────

test('C4 · mockSessionStatus 는 5 시나리오별 HTTP 코드·필드를 정확히 돌려준다', async () => {
  const active = await mockSessionStatus('active').json();
  assert.equal(active.status, 'active');

  const warning = await mockSessionStatus('warning').json();
  assert.equal(warning.status, 'warning');
  assert.equal(warning.reason, '세션 80% 임계 도달');

  const exhaustedRes = mockSessionStatus('exhausted');
  assert.equal(exhaustedRes.status, 503);
  const exhausted = await exhaustedRes.json();
  assert.equal(exhausted.status, 'exhausted');

  const rateRes = mockSessionStatus('rate-limited');
  assert.equal(rateRes.status, 429);
  assert.equal(rateRes.headers.get('retry-after'), '30');
  const rate = await rateRes.json();
  assert.equal(rate.category, 'rate_limited');

  const reset = await mockSessionStatus('reset').json();
  assert.equal(reset.status, 'reset');
  assert.equal(reset.reason, '세션 창 갱신');
});
