// Run with: npx tsx --test tests/sessionSyncMultiTabRefresh.regression.test.ts
//
// QA 회귀(지시 #add33552) — Joker 의 다중 탭·새로고침·네트워크 회복 세션
// 동기화(`src/utils/claudeSubscriptionSession.ts`) 에 대한 **통합 시나리오 잠금**.
//
// 기존 `tests/claudeSubscriptionSession.regression.test.ts` 가 순수 함수 단위
// 계약(W/S/F/T/Q/B/R) 을 개별로 잠갔다면, 본 파일은 그 함수들을 **실제 UI 경로와
// 동일한 순서로 엮어** QA 가 수동으로 재현해야 했던 3가지 UX 시나리오를
// 결정론적으로 자동화한다.
//
// ┌─ 시나리오 지도 ───────────────────────────────────────────────────────────────┐
// │ MT1  탭A 리셋 → 탭B 수렴: envelope 경유 conflict 해결 + compute 스냅샷까지  │
// │ MT2  탭A status 만료 방송 → 탭B 큐잉 → 복귀 envelope 수신 시 flush 1회      │
// │ RH1  새로고침: restored 먼저 렌더, 서버 active 응답 도착 시 배지 즉시 복귀  │
// │ RH2  새로고침: cumulative 이중 카운트 없음(used 는 tokensAtWindowStart 기준)  │
// │ NR1  네트워크 단절 중 enqueue → 복구 시 flush 정확히 1회, 중복 재시도 없음    │
// │ NR2  오프라인 재생 공격(지연된 storage 이벤트) → 세션 역행 전환 차단         │
// └──────────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_PENDING_QUEUE,
  SUBSCRIPTION_SESSION_WINDOW_MS,
  buildSessionSyncEnvelope,
  computeSubscriptionSessionSnapshot,
  deserializePersistedSession,
  enqueuePendingRequest,
  flushPendingOnReset,
  parseSessionSyncEnvelope,
  reconcileRestoredWithServer,
  resolveSessionStateConflict,
  serializePersistedSession,
  shouldAcceptSyncEnvelope,
  shouldFlushPendingQueue,
  type PendingSessionQueue,
  type SubscriptionSessionState,
} from '../src/utils/claudeSubscriptionSession.ts';

const WINDOW = SUBSCRIPTION_SESSION_WINDOW_MS;

// ────────────────────────────────────────────────────────────────────────────
// MT — 다중 탭 동기화(탭A 이벤트 → envelope 경유 → 탭B 상태)
// ────────────────────────────────────────────────────────────────────────────

test('MT1 — 탭A 에서 5시간 리셋이 일어나면 탭B 는 envelope 만 받아도 새 창으로 수렴한다', () => {
  // 두 탭은 처음 같은 상태(tokensAtWindowStart=100)에서 출발한다.
  const t0 = 2_000_000_000_000;
  const shared: SubscriptionSessionState = { windowStartMs: t0, tokensAtWindowStart: 100 };

  // 5시간 경과 후 탭A 가 compute → isReset=true 로 새 윈도우 진입.
  const tAfter = t0 + WINDOW + 30_000; // 5시간 30초
  const tabAsnap = computeSubscriptionSessionSnapshot({
    prev: shared,
    cumulativeTokens: 90_000,
    nowMs: tAfter,
  });
  assert.equal(tabAsnap.isReset, true, '전제 — 탭A 가 먼저 경계를 넘어야 실제 브로드캐스트가 발생한다');
  assert.equal(tabAsnap.state.windowStartMs, tAfter);

  // 탭A 는 그 사실을 envelope 로 방송한다.
  const envelope = buildSessionSyncEnvelope({
    kind: 'state',
    tabId: 'tab-A',
    emittedAtMs: tAfter,
    state: tabAsnap.state,
  });
  const wire = JSON.stringify(envelope);

  // 탭B 는 아직 compute 를 돌리지 않은 상태로(=과거 창 상태) 존재한다.
  const tabBprev = shared;
  const parsed = parseSessionSyncEnvelope(JSON.parse(wire));
  assert.ok(parsed);
  assert.equal(
    shouldAcceptSyncEnvelope({ envelope: parsed!, localTabId: 'tab-B', nowMs: tAfter + 10 }),
    true,
    '정상 envelope 가 수락되지 않으면 "탭 간 수렴" 자체가 실패한다',
  );
  // 탭B 는 conflict 해결을 통해 탭A 의 새 창을 채택한다.
  const mergedState = resolveSessionStateConflict(tabBprev, parsed!.state ?? null);
  assert.equal(mergedState?.windowStartMs, tAfter,
    '더 최근 windowStartMs 를 선호하지 않으면 탭B 가 구 창에 머물러 "잔량이 탭마다 다르게 보이는" UX 회귀');

  // 이제 탭B 가 compute 를 돌리면 isReset 은 이미 탭A 가 처리했으니 false 지만
  // 새 창 시작점(탭A 와 동일)에서 used 가 산출되어야 한다.
  const tabBsnap = computeSubscriptionSessionSnapshot({
    prev: mergedState,
    cumulativeTokens: 90_500, // 탭A 기준 새 창에서 500 더 사용
    nowMs: tAfter + 10_000,
  });
  assert.equal(tabBsnap.used, 500, '탭A 의 새 창 시작점을 채택했다면 used 는 delta(500) 와 같아야 한다');
  assert.equal(tabBsnap.isReset, false, '탭B 는 envelope 로 이미 리셋을 수용했으니 본인 compute 에서 깜빡이면 안 된다');
});

test('MT2 — 탭A 만료 방송 후 탭B 가 요청을 큐잉, 복귀 방송 수신 시 FIFO 로 정확히 1회 flush', () => {
  // 탭B 의 로컬 큐: 사용자가 만료 직전 보낸 3건이 대기 중.
  let queue: PendingSessionQueue<string> = EMPTY_PENDING_QUEUE as PendingSessionQueue<string>;
  queue = enqueuePendingRequest(queue, { id: 'q1', payload: '첫 지시', queuedAtMs: 100 });
  queue = enqueuePendingRequest(queue, { id: 'q2', payload: '둘째 지시', queuedAtMs: 200 });
  queue = enqueuePendingRequest(queue, { id: 'q3', payload: '셋째 지시', queuedAtMs: 150 });

  // 탭A 에서 "exhausted" 방송 도착. 탭B 는 받아들이지만 flush 금지(활성 복귀 아님).
  const exhaustedEnv = buildSessionSyncEnvelope({
    kind: 'status',
    tabId: 'tab-A',
    emittedAtMs: 1_000,
    status: { value: 'exhausted', reason: '한도 초과' },
  });
  const parsedExhausted = parseSessionSyncEnvelope(JSON.parse(JSON.stringify(exhaustedEnv)))!;
  assert.equal(parsedExhausted.status?.value, 'exhausted');
  const dontFlushYet = shouldFlushPendingQueue({
    prevStatus: 'active', nextStatus: 'exhausted', snapshot: { isReset: false },
  });
  assert.equal(dontFlushYet, false, '만료 진입 시점에 flush 하면 사용자가 눌러둔 요청이 서버에서 즉시 거절된다');

  // 탭A 에서 활성 복귀 방송 도착. 탭B 는 flush 1회.
  const activeEnv = buildSessionSyncEnvelope({
    kind: 'status',
    tabId: 'tab-A',
    emittedAtMs: 2_000,
    status: { value: 'active', reason: '복귀' },
  });
  const parsedActive = parseSessionSyncEnvelope(JSON.parse(JSON.stringify(activeEnv)))!;
  assert.equal(parsedActive.status?.value, 'active');
  const flushNow = shouldFlushPendingQueue({
    prevStatus: 'exhausted', nextStatus: 'active', snapshot: { isReset: false },
  });
  assert.equal(flushNow, true);

  const { next: afterFlush, released } = flushPendingOnReset(queue, flushNow);
  assert.deepEqual(released.map(r => r.id), ['q1', 'q3', 'q2'],
    'queuedAtMs 오름차순으로 FIFO — 탭 간 동기화 후에도 사용자가 누른 순서가 보존되어야 한다');
  assert.equal(afterFlush.items.length, 0);

  // 두 번째 flush 시도(잇따라 들어온 중복 active 방송) 는 released 를 또 내지 않는다.
  const { released: released2 } = flushPendingOnReset(afterFlush, true);
  assert.equal(released2.length, 0, '빈 큐에 flush 를 또 돌려도 중복 재시도가 일어나서는 안 된다');
});

// ────────────────────────────────────────────────────────────────────────────
// RH — 새로고침 직후 복원·서버 치환 경로
// ────────────────────────────────────────────────────────────────────────────

test('RH1 — 새로고침: restored 가 exhausted 여도 서버 active 응답이 오면 깜빡임 없이 active 로 치환', () => {
  const now = 2_000_000_200_000;
  const persisted = serializePersistedSession({
    state: { windowStartMs: now - 2 * 60_000, tokensAtWindowStart: 300 },
    status: 'exhausted',
    statusReason: '새로고침 직전에 한도 도달',
    savedAtMs: now - 60_000,
  });

  // 1차 렌더: localStorage 복원 + 서버 응답 없음 → exhausted 유지(네트워크 지연 체감 대비).
  const firstPaint = reconcileRestoredWithServer({
    restored: deserializePersistedSession(JSON.stringify(persisted), now),
    serverStatus: null,
    nowMs: now,
  });
  assert.equal(firstPaint.status, 'exhausted', '네트워크가 느려도 이전 화면은 보존 — "빈 상단바" 깜빡임 차단');
  assert.ok(firstPaint.state, '상태 스냅은 복원되어야 한다');

  // 2차 렌더: 서버가 active 응답 → 즉시 권위값 치환. state 는 유지돼 잔량 표시에 이어쓴다.
  const afterServer = reconcileRestoredWithServer({
    restored: deserializePersistedSession(JSON.stringify(persisted), now),
    serverStatus: 'active',
    nowMs: now,
  });
  assert.equal(afterServer.status, 'active', '서버 권위값이 도착하면 exhausted 배지가 즉시 내려가야 한다');
  assert.equal(afterServer.state?.windowStartMs, firstPaint.state?.windowStartMs,
    '두 렌더 사이 state 참조가 바뀌면 compute 가 "최초 마운트" 로 오인해 used 가 0 으로 점프한다');
  assert.equal(afterServer.statusReason, undefined,
    '서버가 reason 을 주지 않으면 복원된 사유를 끌고 가지 않는다 — 오래된 만료 문구 잔존 방지');
});

test('RH2 — 새로고침 직후 compute 는 이중 카운트 없이 단조 증가한다(restored tokensAtWindowStart 를 그대로 기준점으로)', () => {
  const now = 2_000_000_300_000;
  // 새로고침 이전 탭은 500 토큰을 쓴 상태로 저장됐다.
  const persisted = serializePersistedSession({
    state: { windowStartMs: now - 3 * 60_000, tokensAtWindowStart: 1_000 },
    status: 'active',
    savedAtMs: now - 30_000,
  });
  const restored = deserializePersistedSession(JSON.stringify(persisted), now);
  assert.ok(restored);

  // 1차 렌더: 서버가 돌려준 cumulativeTokens=1_500(=500 사용).
  const firstSnap = computeSubscriptionSessionSnapshot({
    prev: restored!.state,
    cumulativeTokens: 1_500,
    nowMs: now,
  });
  assert.equal(firstSnap.used, 500, '복원된 기준점에서 delta 만 잡아야 새로고침 직전 사용량이 정확히 이어진다');

  // 2차 렌더: 소켓으로 cumulativeTokens=1_700 도착.
  const secondSnap = computeSubscriptionSessionSnapshot({
    prev: firstSnap.state,
    cumulativeTokens: 1_700,
    nowMs: now + 5_000,
  });
  assert.equal(secondSnap.used, 700, 'used 는 단조 증가해야 한다 — 새로고침이 카운터를 0 으로 되돌리면 안 된다');

  // 만약 서버 권위값이 "새로운 구독 세션(windowStartMs 가 더 최근)" 이라고 주장하면,
  // conflict 해결이 더 최근 창을 택해 used 가 delta 기준으로 재시작해야 한다.
  const serverAuthority: SubscriptionSessionState = {
    windowStartMs: now + 1_000, // 서버는 더 늦게 새 창을 열었다고 주장
    tokensAtWindowStart: 1_700,
  };
  const merged = resolveSessionStateConflict(secondSnap.state, serverAuthority);
  const postMerge = computeSubscriptionSessionSnapshot({
    prev: merged,
    cumulativeTokens: 1_750,
    nowMs: now + 6_000,
  });
  assert.equal(postMerge.used, 50, '서버 권위값 반영 후 delta 가 50 이어야 한다 — 이중 카운트되면 used=750 으로 튄다');
});

// ────────────────────────────────────────────────────────────────────────────
// NR — 네트워크 단절·복구 경쟁
// ────────────────────────────────────────────────────────────────────────────

test('NR1 — 네트워크 단절 중 누적 요청 → 복구 시 flush 정확히 1회, 누락·중복 없음', () => {
  // 단절 중 사용자가 3번 눌렀다. 동일 id 로 "재시도 누름" 이 섞여도 중복 큐잉 금지.
  let queue: PendingSessionQueue<{ payload: string }> = EMPTY_PENDING_QUEUE as PendingSessionQueue<{ payload: string }>;
  queue = enqueuePendingRequest(queue, { id: 'net-1', payload: { payload: '첫' }, queuedAtMs: 10 });
  queue = enqueuePendingRequest(queue, { id: 'net-2', payload: { payload: '둘' }, queuedAtMs: 20 });
  queue = enqueuePendingRequest(queue, { id: 'net-3', payload: { payload: '셋' }, queuedAtMs: 30 });
  queue = enqueuePendingRequest(queue, { id: 'net-1', payload: { payload: '재시도' }, queuedAtMs: 40 });
  assert.equal(queue.items.length, 3, '동일 id 재큐잉은 무시 — 네트워크 단절 중 사용자 더블 클릭이 서버 복구 직후 중복 호출을 일으키면 안 된다');

  // 복구 시점: 소켓이 status:active 를 되돌려 주면 flush.
  const shouldFlush = shouldFlushPendingQueue({
    prevStatus: 'exhausted', nextStatus: 'active', snapshot: { isReset: false },
  });
  const { next, released } = flushPendingOnReset(queue, shouldFlush);
  assert.equal(released.length, 3);
  assert.deepEqual(released.map(r => r.id), ['net-1', 'net-2', 'net-3']);
  assert.equal(next.items.length, 0);

  // 경쟁 상황: flush 직후 같은 틱에 isReset=true 스냅샷이 또 들어옴(소켓 재접속 간섭).
  // 두 번째 flush 가 released 를 또 내면 서버가 중복 요청을 받는다.
  const { released: raceReleased } = flushPendingOnReset(next, true);
  assert.equal(raceReleased.length, 0, '경쟁 상황에서 두 번째 flush 가 중복 release 를 만들면 서버에 같은 작업이 두 번 꽂힌다');

  // 실패한 네트워크 호출을 호출자가 다시 enqueue → 다음 사이클에 다시 flush 되어야 한다.
  let retryQueue = next;
  retryQueue = enqueuePendingRequest(retryQueue, { id: 'net-2', payload: { payload: '재시도' }, queuedAtMs: 50 });
  const retry = flushPendingOnReset(retryQueue, true);
  assert.equal(retry.released.length, 1);
  assert.equal(retry.released[0].id, 'net-2', '실패한 id 만 재투입되면 다음 flush 에서 정확히 한 번만 내려와야 한다');
});

test('NR2 — 재생 공격(지연된 storage 이벤트) 은 세션을 역행 전환시키지 못한다', () => {
  // 현재 탭은 이미 active 로 복귀한 상태. 방금 복귀했으니 now = 300_000ms.
  const now = 300_000;

  // 뒤늦게 도착한 과거 envelope: 2분 전 emittedAtMs, status=exhausted.
  // 이 패킷이 그대로 적용되면 "방금 복귀한 배지가 다시 만료로 뒤집히는" UX 회귀가 발생한다.
  const staleEnv = buildSessionSyncEnvelope({
    kind: 'status',
    tabId: 'tab-attacker',
    emittedAtMs: now - 120_000, // 2분 지연
    status: { value: 'exhausted' },
  });
  const parsed = parseSessionSyncEnvelope(JSON.parse(JSON.stringify(staleEnv)))!;
  assert.equal(
    shouldAcceptSyncEnvelope({ envelope: parsed, localTabId: 'tab-me', nowMs: now }),
    false,
    '기본 maxAge=60s 를 넘는 지연 메시지가 수용되면 만료 잔상이 잔뜩 생긴다',
  );

  // 미래 타임스탬프(탭 시계 앞섬) 도 같은 이유로 차단.
  const futureEnv = buildSessionSyncEnvelope({
    kind: 'status',
    tabId: 'tab-skewed',
    emittedAtMs: now + 120_000,
    status: { value: 'exhausted' },
  });
  const parsedFuture = parseSessionSyncEnvelope(JSON.parse(JSON.stringify(futureEnv)))!;
  assert.equal(
    shouldAcceptSyncEnvelope({ envelope: parsedFuture, localTabId: 'tab-me', nowMs: now }),
    false,
    '미래 타임스탬프 envelope 가 통과하면 탭 간 시계 편차가 세션 상태를 비결정적으로 뒤집는다',
  );
});
