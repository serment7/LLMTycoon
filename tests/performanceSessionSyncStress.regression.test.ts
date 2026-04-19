// Run with: npx tsx --test tests/performanceSessionSyncStress.regression.test.ts
//
// QA 회귀(지시 #07ffd9c4) · 다중 탭 스트레스 — claudeSubscriptionSession 큐·
// envelope 동시 처리 일관성.
//
// 측정 범위
// ─────────────────────────────────────────────────────────────────────────────
//   SS-1  20탭에서 동시에 envelope 방송 → 로컬 탭이 가장 "최근 리셋" 만 반영하고
//         나머지는 dedupe 되어 최종 상태가 단일 결정값으로 수렴.
//   SS-2  중복 id 100건 enqueue → 큐 items.length 는 항상 50 이하(dedupe 동작).
//   SS-3  1 회차에 status=exhausted/active 를 100회 토글해도 flushPendingOnReset
//         은 active 전환 시점에만 released 를 돌려주고, 빈 released 가 반복되지 않음.
//   SS-4  envelope 20건 중 10건은 stale(2분 지연), 10건은 정상 → shouldAcceptSyncEnvelope
//         가 정확히 10건만 true, 나머지 10건은 false 로 분류. 경계 초과 시 누락/오수용 0.
//
// 본 파일은 BroadcastChannel 실체를 쓰지 않고 순수 함수 체인만 돌린다. 실 브라우저
// BroadcastChannel 동작은 tests/sessionSyncMultiTabRefresh.regression.test.ts MT1·MT2
// 와 함께 Playwright 도입 후 재검증 대상이다(수동 체크리스트는 docs 보고서 §6).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_PENDING_QUEUE,
  buildSessionSyncEnvelope,
  enqueuePendingRequest,
  flushPendingOnReset,
  parseSessionSyncEnvelope,
  resolveSessionStateConflict,
  shouldAcceptSyncEnvelope,
  shouldFlushPendingQueue,
  type PendingSessionQueue,
  type SessionSyncEnvelope,
  type SubscriptionSessionState,
} from '../src/utils/claudeSubscriptionSession.ts';

// ─── SS-1 · 20탭 동시 리셋 방송 → 단일 결정값 수렴 ────────────────────────────

test('SS-1 · 20탭이 동시에 리셋을 방송해도 conflict 해결이 가장 최근 창을 단일 결정값으로 수렴시킨다', () => {
  const nowBase = 1_700_000_000_000;
  // 20개 탭이 각각 자기 시계로 +i ms 앞뒤에서 리셋을 방송했다고 가정.
  const envelopes: SessionSyncEnvelope[] = [];
  for (let i = 0; i < 20; i++) {
    envelopes.push(buildSessionSyncEnvelope({
      kind: 'state',
      tabId: `tab-${i}`,
      emittedAtMs: nowBase + i,
      state: {
        windowStartMs: nowBase + (i * 1_000), // 탭 i 번째가 i초 늦게 창을 열었다고 가정
        tokensAtWindowStart: 100 + i * 10,
      },
    }));
  }

  // 로컬 탭은 처음엔 null 상태. 20개 envelope 를 순차 수신하며 resolve 를 누적 적용.
  let merged: SubscriptionSessionState | null = null;
  for (const env of envelopes) {
    const parsed = parseSessionSyncEnvelope(JSON.parse(JSON.stringify(env)));
    if (!parsed || !parsed.state) continue;
    if (!shouldAcceptSyncEnvelope({ envelope: parsed, localTabId: 'local', nowMs: nowBase + 30_000 })) continue;
    merged = resolveSessionStateConflict(merged, parsed.state);
  }

  assert.ok(merged, '20개 envelope 수용 후 merged 는 null 이면 안 된다');
  // 가장 최근 windowStartMs 는 tab-19(nowBase + 19_000). 단일 결정값으로 수렴해야 한다.
  assert.equal(merged!.windowStartMs, nowBase + 19_000,
    '가장 최근 창만 채택되어야 한다 — 그 외 탭들은 conflict 해결에 의해 버려진다');
  // tokensAtWindowStart 도 해당 탭 값(100 + 19*10 = 290) 로 고정.
  assert.equal(merged!.tokensAtWindowStart, 290);
});

// ─── SS-2 · 중복 id 100건 enqueue → dedupe 동작 확인 ──────────────────────────

test('SS-2 · 100회 중복 enqueue 에서도 큐 items.length 는 최초 삽입 고유 id 수 이하로 유지된다', () => {
  let queue: PendingSessionQueue<string> = EMPTY_PENDING_QUEUE as PendingSessionQueue<string>;

  // 10개 고유 id 를 각각 10번씩 (총 100회) 재삽입한다.
  for (let k = 0; k < 10; k++) {
    for (let i = 0; i < 10; i++) {
      queue = enqueuePendingRequest(queue, {
        id: `req-${i}`,
        payload: `페이로드-${i}-회차${k}`,
        queuedAtMs: Date.now() + k * 1_000 + i,
      });
    }
  }

  assert.equal(queue.items.length, 10,
    `중복 id 100회 삽입에서도 큐는 고유 id 수(10) 만큼만 유지되어야 한다. 실제: ${queue.items.length}`);
  // 최초 페이로드가 보존되었는지(= dedupe 가 "첫 삽입 승자" 규칙을 지키는지).
  for (let i = 0; i < 10; i++) {
    const item = queue.items.find(it => it.id === `req-${i}`);
    assert.ok(item);
    assert.match(item!.payload, /회차0$/,
      `id=req-${i} 의 payload 가 첫 삽입 값("회차0") 이어야 한다. 덮어쓰면 "사용자가 2번째로 누른 요청이 승자" 가 되어 큐 계약이 깨진다`);
  }
});

// ─── SS-3 · 100회 상태 토글 중 flushPendingOnReset 호출 일관성 ────────────────

test('SS-3 · status 를 100회 토글해도 flush 는 exhausted→active 순간에만 released 를 돌려준다', () => {
  let queue: PendingSessionQueue<string> = EMPTY_PENDING_QUEUE as PendingSessionQueue<string>;
  // 출발 시 3건 큐잉.
  queue = enqueuePendingRequest(queue, { id: 'a', payload: '1', queuedAtMs: 1 });
  queue = enqueuePendingRequest(queue, { id: 'b', payload: '2', queuedAtMs: 2 });
  queue = enqueuePendingRequest(queue, { id: 'c', payload: '3', queuedAtMs: 3 });

  let prevStatus: 'active' | 'exhausted' | 'warning' = 'active';
  let totalReleased = 0;
  let flushCycles = 0;

  for (let i = 0; i < 100; i++) {
    const nextStatus: 'active' | 'exhausted' = i % 2 === 0 ? 'exhausted' : 'active';
    const should = shouldFlushPendingQueue({
      prevStatus, nextStatus, snapshot: { isReset: false },
    });
    if (should) {
      const { next, released } = flushPendingOnReset(queue, true);
      queue = next;
      totalReleased += released.length;
      flushCycles++;
      // flush 이후엔 다시 큐잉해야 다음 flush 에 release 가 나옴.
      if (i < 50) {
        // 전반 50회: 재큐잉 안 함 → 후반 flush 는 빈 released 만 돌려줘야 한다.
      }
    }
    prevStatus = nextStatus;
  }

  // 첫 번째 exhausted→active 전환(회차 1) 에서만 3건이 release.
  assert.equal(totalReleased, 3,
    `100회 토글 중 release 누적은 최초 1회(3건) 만이어야 한다. 실제: ${totalReleased}. 초과 시 같은 요청이 여러 번 재전송됨`);
  assert.ok(flushCycles >= 1, 'flush 가 최소 한 번은 돌아야 한다');
});

// ─── SS-4 · envelope 20건 중 10건 stale 분류 정확성 ───────────────────────────

test('SS-4 · envelope 20건 혼합(정상 10 / stale 10)에서 shouldAcceptSyncEnvelope 가 정확히 10건만 true', () => {
  const now = 2_000_000_000_000;
  const envelopes: SessionSyncEnvelope[] = [];
  for (let i = 0; i < 10; i++) {
    envelopes.push(buildSessionSyncEnvelope({
      kind: 'status',
      tabId: `fresh-${i}`,
      emittedAtMs: now - 1_000 * (i + 1), // 1~10초 전
      status: { value: 'active' },
    }));
  }
  for (let i = 0; i < 10; i++) {
    envelopes.push(buildSessionSyncEnvelope({
      kind: 'status',
      tabId: `stale-${i}`,
      emittedAtMs: now - 120_000 - 1_000 * i, // 120초+ 지연 (기본 maxAge 60초 초과)
      status: { value: 'exhausted' },
    }));
  }

  let accepted = 0;
  let rejected = 0;
  for (const env of envelopes) {
    const parsed = parseSessionSyncEnvelope(JSON.parse(JSON.stringify(env)))!;
    const ok = shouldAcceptSyncEnvelope({
      envelope: parsed, localTabId: 'local', nowMs: now,
    });
    if (ok) accepted++; else rejected++;
  }

  assert.equal(accepted, 10, `정상 envelope 10건만 수용되어야 한다. 실제: ${accepted}`);
  assert.equal(rejected, 10, `stale envelope 10건만 거절되어야 한다. 실제: ${rejected}`);
});
