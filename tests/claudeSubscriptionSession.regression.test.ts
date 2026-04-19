// Run with: npx tsx --test tests/claudeSubscriptionSession.regression.test.ts
//
// QA 회귀 — Claude 구독 세션(5시간 주기) 롤링 윈도우 계산 순수 함수 계약.
//
// 본 파일은 TokenUsageIndicator 가 소비하는 `computeSubscriptionSessionSnapshot`
// 의 리셋 감지·남은량 산출·severity 경계 규칙을 잠근다. UI 경합/타이머 없이
// 순수 입력(prev, cumulative, now) → 출력(snapshot) 만 검증하므로 CI 에서 빠르게
// 돌고, 미래에 5시간 → 다른 창 길이로 바뀌거나 색상 임계값이 이동할 때 한 곳
// 에서 즉시 잡힌다.
//
// ┌─ 시나리오 지도 ──────────────────────────────────────────────────────────────┐
// │ W1  prev=null 최초 마운트 → 새 윈도우 시작, used=0, isReset=false            │
// │ W2  같은 창 내 누적 증가 → used = cumulative - tokensAtWindowStart           │
// │ W3  5시간 경계 넘김 → 새 윈도우(리셋), isReset=true, used=0                  │
// │ W4  서버 reset 으로 cumulative 가 작아짐 → 윈도우 유지·시작점 당김·used=0    │
// │ S1  severity: 49% 이하 ok, 50~79% caution, 80% 이상 critical                │
// │ F1  폴백: cumulative 음수/NaN, limit 0/음수, windowMs 0 → 기본값 폴백         │
// │ T1  formatResetClock/formatTimeUntilReset 은 비정상 입력에 폴백 문자열         │
// └──────────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SUBSCRIPTION_TOKEN_LIMIT,
  SUBSCRIPTION_SESSION_WINDOW_MS,
  EMPTY_PENDING_QUEUE,
  buildSessionSyncEnvelope,
  computeSubscriptionSessionSnapshot,
  dequeuePendingRequest,
  deserializePersistedSession,
  enqueuePendingRequest,
  flushPendingOnReset,
  formatResetClock,
  formatTimeUntilReset,
  parseSessionSyncEnvelope,
  reconcileRestoredWithServer,
  resolveSessionStateConflict,
  serializePersistedSession,
  severityFromRatio,
  shouldAcceptSyncEnvelope,
  shouldFlushPendingQueue,
  type PendingSessionQueue,
  type PersistedSubscriptionSession,
  type SessionSyncEnvelope,
  type SubscriptionSessionState,
} from '../src/utils/claudeSubscriptionSession.ts';

const WINDOW = SUBSCRIPTION_SESSION_WINDOW_MS;

// ---------------------------------------------------------------------------
// W1 — 최초 마운트: prev=null 이면 "지금을 시작으로" 새 창을 열고 used=0.
// ---------------------------------------------------------------------------

test('W1 — Given prev=null When compute Then 새 창 시작·used=0·isReset=false', () => {
  const now = Date.UTC(2026, 3, 19, 10, 0, 0);
  const snap = computeSubscriptionSessionSnapshot({
    prev: null,
    cumulativeTokens: 12345,
    nowMs: now,
  });
  assert.equal(snap.state.windowStartMs, now);
  assert.equal(snap.state.tokensAtWindowStart, 12345, '시작점 누적은 지금 값을 그대로 스냅');
  assert.equal(snap.used, 0, '새 창은 used=0 으로 시작');
  assert.equal(snap.isReset, false, '최초 마운트를 "리셋" 으로 표시하면 배지 테두리가 매 새로고침마다 깜빡인다');
  assert.equal(snap.resetAtMs, now + WINDOW);
  assert.equal(snap.limit, DEFAULT_SUBSCRIPTION_TOKEN_LIMIT);
  assert.equal(snap.severity, 'ok');
});

// ---------------------------------------------------------------------------
// W2 — 같은 창 내 누적 증가: used 는 뺄셈, 상태는 그대로.
// ---------------------------------------------------------------------------

test('W2 — Given 기존 창 When cumulative 증가 Then used 증가·창 유지', () => {
  const windowStart = Date.UTC(2026, 3, 19, 10, 0, 0);
  const prev: SubscriptionSessionState = { windowStartMs: windowStart, tokensAtWindowStart: 1000 };
  const snap = computeSubscriptionSessionSnapshot({
    prev,
    cumulativeTokens: 1500,
    nowMs: windowStart + 30 * 60 * 1000, // 30분 경과
    limit: 2000,
  });
  assert.equal(snap.state, prev, '동일 창 유지 시 상태 객체 참조도 동일해야 한다(불필요 재렌더 회피)');
  assert.equal(snap.used, 500, 'used = cumulative(1500) - windowStart(1000)');
  assert.equal(snap.remaining, 1500);
  assert.equal(snap.ratioUsed, 0.25);
  assert.equal(snap.severity, 'ok');
  assert.equal(snap.isReset, false);
});

// ---------------------------------------------------------------------------
// W3 — 5시간 경계를 넘으면 새 창 리셋. isReset=true, used=0.
// ---------------------------------------------------------------------------

test('W3 — Given 5시간 경과 When compute Then 새 창·used=0·isReset=true', () => {
  const windowStart = Date.UTC(2026, 3, 19, 10, 0, 0);
  const prev: SubscriptionSessionState = { windowStartMs: windowStart, tokensAtWindowStart: 100 };
  const now = windowStart + WINDOW + 60_000; // 5시간 1분
  const snap = computeSubscriptionSessionSnapshot({
    prev,
    cumulativeTokens: 99_000,
    nowMs: now,
  });
  assert.equal(snap.state.windowStartMs, now, '새 창은 지금을 시작점으로');
  assert.equal(snap.state.tokensAtWindowStart, 99_000, '시작점 누적도 지금 값으로 갱신');
  assert.equal(snap.used, 0, '리셋 직후 used=0 이 아니면 카운터가 이월돼 사용자 체감이 깨진다');
  assert.equal(snap.isReset, true, '리셋 감지는 UI 쪽 애니메이션/토스트 트리거에 쓰인다');
  assert.equal(snap.severity, 'ok');
});

test('W3 — 경계 "정확히 5시간" 도 리셋으로 판정한다 (부등호 경계)', () => {
  // >= windowMs 이므로 정확한 5시간 경계에서도 리셋. "5:00:00 정확히 찍혀야 리셋" 이
  // UX 설계 의도(소숫점 반올림으로 놓치지 않도록 경계 포함).
  const windowStart = 0;
  const prev: SubscriptionSessionState = { windowStartMs: windowStart, tokensAtWindowStart: 0 };
  const snap = computeSubscriptionSessionSnapshot({
    prev,
    cumulativeTokens: 10,
    nowMs: windowStart + WINDOW,
  });
  assert.equal(snap.isReset, true);
  assert.equal(snap.state.windowStartMs, windowStart + WINDOW);
});

// ---------------------------------------------------------------------------
// W4 — 서버 reset 이벤트(모든 totals 0 으로 초기화) 직후: cumulative 가 이전
// windowStart 스냅보다 작다. 이때는 창 자체는 그대로 유지하되 시작점만
// 현재 값(보통 0) 으로 당겨와 used 가 음수로 떨어지지 않게 해야 한다.
// ---------------------------------------------------------------------------

test('W4 — Given 서버 reset 으로 cumulative 가 이전 스냅보다 작음 When compute Then 창 유지·시작점 당김·used=0', () => {
  const windowStart = 1_000_000;
  const prev: SubscriptionSessionState = { windowStartMs: windowStart, tokensAtWindowStart: 5000 };
  const snap = computeSubscriptionSessionSnapshot({
    prev,
    cumulativeTokens: 0, // 서버가 totals 를 0 으로 밀어냄
    nowMs: windowStart + 60_000,
  });
  assert.equal(snap.state.windowStartMs, windowStart, '5시간 경계 전이면 창을 유지해야 한다');
  assert.equal(snap.state.tokensAtWindowStart, 0, '시작점은 현재 값(0)으로 당겨져 음수 used 방지');
  assert.equal(snap.used, 0);
  assert.equal(snap.isReset, false, '서버 reset 은 "창 리셋" 이 아니라 "누적 재시작" 이므로 isReset 이 켜지지 않아야 한다');
});

// ---------------------------------------------------------------------------
// S1 — severity 경계: <50% ok, 50~79% caution, ≥80% critical.
// ---------------------------------------------------------------------------

test('S1 — severityFromRatio 경계값(0, 0.49, 0.50, 0.79, 0.80, 1.5) 이 3단계로 수렴', () => {
  assert.equal(severityFromRatio(0),    'ok');
  assert.equal(severityFromRatio(0.49), 'ok');
  assert.equal(severityFromRatio(0.50), 'caution', '50% 는 caution 으로 승격(엄밀 경계)');
  assert.equal(severityFromRatio(0.79), 'caution');
  assert.equal(severityFromRatio(0.80), 'critical', '80% 는 critical 로 승격');
  assert.equal(severityFromRatio(1.5),  'critical', '한도를 넘어도 critical 유지');
});

test('S1 — 비정상 비율(NaN/음수) 은 ok 로 안전 폴백', () => {
  assert.equal(severityFromRatio(Number.NaN), 'ok');
  assert.equal(severityFromRatio(-0.1), 'ok');
  assert.equal(severityFromRatio(Number.POSITIVE_INFINITY), 'critical', '+∞ 는 critical 로 수렴');
});

test('S1 — 스냅샷 severity 는 ratioUsed 와 일치한다(한 줄 contract)', () => {
  const prev: SubscriptionSessionState = { windowStartMs: 0, tokensAtWindowStart: 0 };
  const cases: Array<[number, 'ok' | 'caution' | 'critical']> = [
    [100_000, 'ok'],
    [500_000, 'caution'],
    [800_000, 'critical'],
    [1_500_000, 'critical'],
  ];
  for (const [cumulative, expected] of cases) {
    const snap = computeSubscriptionSessionSnapshot({
      prev, cumulativeTokens: cumulative, nowMs: 60_000, limit: 1_000_000,
    });
    assert.equal(snap.severity, expected, `cumulative=${cumulative} 에서 ${expected} 가 나와야 한다`);
  }
});

// ---------------------------------------------------------------------------
// F1 — 비정상 입력 폴백: 누적 음수/NaN, limit 0/음수, windowMs 0.
// UI 가 절대 깨지지 않도록 모든 분기에서 정상 숫자를 돌려준다.
// ---------------------------------------------------------------------------

test('F1 — cumulativeTokens 가 음수/NaN 이면 0 으로 치환해 계산', () => {
  const snap = computeSubscriptionSessionSnapshot({
    prev: null,
    cumulativeTokens: Number.NaN,
    nowMs: 1000,
  });
  assert.equal(snap.used, 0);
  assert.equal(snap.state.tokensAtWindowStart, 0);

  const negSnap = computeSubscriptionSessionSnapshot({
    prev: null,
    cumulativeTokens: -500,
    nowMs: 1000,
  });
  assert.equal(negSnap.used, 0);
  assert.equal(negSnap.state.tokensAtWindowStart, 0);
});

test('F1 — limit 이 0/음수/NaN/undefined 이면 DEFAULT_SUBSCRIPTION_TOKEN_LIMIT 으로 폴백', () => {
  for (const bad of [0, -10, Number.NaN, undefined]) {
    const snap = computeSubscriptionSessionSnapshot({
      prev: null, cumulativeTokens: 0, nowMs: 0, limit: bad as number | undefined,
    });
    assert.equal(snap.limit, DEFAULT_SUBSCRIPTION_TOKEN_LIMIT,
      `limit=${String(bad)} 가 기본값으로 폴백되지 않으면 인디케이터가 분모 0 으로 NaN% 를 그린다`);
  }
});

test('F1 — windowMs 가 0/음수이면 기본 5시간으로 폴백해 resetAt 이 유효값', () => {
  const prev: SubscriptionSessionState = { windowStartMs: 0, tokensAtWindowStart: 0 };
  const snap = computeSubscriptionSessionSnapshot({
    prev, cumulativeTokens: 0, nowMs: 1000, windowMs: 0,
  });
  assert.equal(snap.resetAtMs, 0 + WINDOW,
    'windowMs=0 이면 리셋이 매 틱마다 일어나 인디케이터가 깜빡인다 — 기본값 폴백 필요');
});

// ---------------------------------------------------------------------------
// T1 — 포매터 폴백: 비정상 입력에서도 UI 표시 문자열을 돌려줘 React 렌더가 깨지지 않는다.
// ---------------------------------------------------------------------------

test('T1 — formatResetClock: 정상값은 HH:MM, 비정상은 "--:--" 폴백', () => {
  // 로컬 타임존 의존성을 피하기 위해 "HH:MM" 형태 자체만 검증(분 두 자리 여부).
  const s = formatResetClock(Date.now());
  assert.match(s, /^\d{2}:\d{2}$/);
  assert.equal(formatResetClock(Number.NaN), '--:--');
  assert.equal(formatResetClock(Number.POSITIVE_INFINITY), '--:--');
});

test('T1 — formatTimeUntilReset: 0 이하/비정상은 "<1분"/"--" 폴백', () => {
  const now = 1_000_000;
  assert.equal(formatTimeUntilReset(now, now), '<1분', '0 이하 남은 시간은 "<1분" 으로 수렴');
  assert.equal(formatTimeUntilReset(now - 1, now), '<1분', '음수 남음도 <1분 으로');
  assert.equal(formatTimeUntilReset(now + 30 * 60_000, now), '30분');
  assert.equal(formatTimeUntilReset(now + 3 * 60 * 60_000 + 15 * 60_000, now), '3시간 15분');
  assert.equal(formatTimeUntilReset(Number.NaN, now), '--');
});

// ---------------------------------------------------------------------------
// Q — 만료→재리셋 복구 큐: "세션 소진 중 쌓인 요청" 을 유실 없이 FIFO 로 되돌려준다.
// 배경: DirectivePrompt/SharedGoalForm 이 `sessionStatus==='exhausted'` 로 읽기 전용이
// 된 직후 눌린 enter 나 소켓 지연으로 뒤늦게 도착한 요청은 그대로 버려지면 "요청이 증발"
// 하는 UX 회귀가 발생한다. 본 섹션은 큐 → flush 트리거 → 순서 보존 계약을 잠근다.
// ---------------------------------------------------------------------------

test('Q1 — enqueuePendingRequest/flushPendingOnReset: 리셋 트리거 시 FIFO 로 released', () => {
  // 세 요청이 시간 차로 쌓이고, 5시간 경계 리셋 스냅이 오면 하나도 버려지지 않은 채
  // queuedAtMs 오름차순으로 호출자에게 풀려야 한다.
  let q: PendingSessionQueue<string> = EMPTY_PENDING_QUEUE as PendingSessionQueue<string>;
  q = enqueuePendingRequest(q, { id: 'a', payload: '첫 요청', queuedAtMs: 100 });
  q = enqueuePendingRequest(q, { id: 'b', payload: '둘째 요청', queuedAtMs: 200 });
  q = enqueuePendingRequest(q, { id: 'c', payload: '셋째 요청', queuedAtMs: 150 });
  // 동일 id 재삽입은 무시(중복 enter 방지).
  q = enqueuePendingRequest(q, { id: 'a', payload: '재삽입 무시', queuedAtMs: 999 });
  assert.equal(q.items.length, 3, '동일 id 는 덮어쓰지 않아야 사용자 중복 enter 가 중복 재시도로 이어지지 않는다');

  const { next, released } = flushPendingOnReset(q, /*shouldFlush=*/ true);
  assert.equal(released.length, 3);
  assert.deepEqual(
    released.map(r => r.id),
    ['a', 'c', 'b'],
    'queuedAtMs 오름차순 — a(100) → c(150) → b(200)',
  );
  assert.equal(next.items.length, 0, 'flush 후 큐는 비어 있어야 한다');

  // 플러시 안 됨 케이스: 상태가 그대로 유지되어 재렌더를 유발하지 않는다.
  const held = flushPendingOnReset(q, /*shouldFlush=*/ false);
  assert.equal(held.next, q, 'shouldFlush=false 면 참조 동일성 유지');
  assert.equal(held.released.length, 0);
});

test('Q2 — shouldFlushPendingQueue: 만료→활성 전환 또는 5시간 경계 리셋 시에만 true', () => {
  const snap = (isReset: boolean) => ({ isReset });
  // 핵심 계약 1: exhausted → active 전환은 flush.
  assert.equal(
    shouldFlushPendingQueue({ prevStatus: 'exhausted', nextStatus: 'active', snapshot: snap(false) }),
    true,
    '만료 해제 순간 큐를 비워 실제 재시도를 수행해야 한다',
  );
  // 핵심 계약 2: warning → active 도 flush(소진 직전 큐잉된 것들 해방).
  assert.equal(
    shouldFlushPendingQueue({ prevStatus: 'warning', nextStatus: 'active', snapshot: snap(false) }),
    true,
  );
  // 핵심 계약 3: isReset=true 이면 상태 변화 여부 상관없이 flush.
  assert.equal(
    shouldFlushPendingQueue({ prevStatus: 'active', nextStatus: 'active', snapshot: snap(true) }),
    true,
    '5시간 경계 리셋이 단독으로도 flush 를 유도해야 한다',
  );
  // 역방향/동일 상태는 flush 하지 않아야 — 평상 운용에서 큐가 무단 비워지면 안 된다.
  assert.equal(
    shouldFlushPendingQueue({ prevStatus: 'active', nextStatus: 'exhausted', snapshot: snap(false) }),
    false,
  );
  assert.equal(
    shouldFlushPendingQueue({ prevStatus: 'active', nextStatus: 'active', snapshot: snap(false) }),
    false,
  );
  // 초기 마운트(prev=null) 는 flush 하지 않는다.
  assert.equal(
    shouldFlushPendingQueue({ prevStatus: null, nextStatus: 'active', snapshot: snap(false) }),
    false,
    'prev=null 은 초기 마운트이므로 빈 큐에서도 괜한 flush 를 유도하지 않는다',
  );
});

test('Q3 — dequeuePendingRequest: 중간 취소 시 해당 id 만 제거하고 나머지 순서·참조를 보존', () => {
  let q: PendingSessionQueue<number> = EMPTY_PENDING_QUEUE as PendingSessionQueue<number>;
  q = enqueuePendingRequest(q, { id: 'x', payload: 1, queuedAtMs: 10 });
  q = enqueuePendingRequest(q, { id: 'y', payload: 2, queuedAtMs: 20 });
  q = enqueuePendingRequest(q, { id: 'z', payload: 3, queuedAtMs: 30 });

  const removed = dequeuePendingRequest(q, 'y');
  assert.deepEqual(removed.items.map(r => r.id), ['x', 'z']);

  // 존재하지 않는 id 는 참조 동일성을 유지 — React state 에 그대로 넣어도 리렌더가 튀지 않는다.
  const noop = dequeuePendingRequest(removed, 'missing');
  assert.equal(noop, removed);
});

// ---------------------------------------------------------------------------
// B — 다중 탭 브로드캐스트: 한 탭의 리셋/만료가 다른 탭으로 즉시 수렴한다.
// 배경: BroadcastChannel 또는 storage 이벤트로 전달되는 envelope 가 자기 자신의
// 에코·시계 틀어진 메시지·손상된 페이로드를 어떻게 처리하는지 계약을 고정한다.
// ---------------------------------------------------------------------------

test('B1 — buildSessionSyncEnvelope → JSON roundtrip → parseSessionSyncEnvelope 동일값 복원', () => {
  const state: SubscriptionSessionState = { windowStartMs: 1_700_000_000_000, tokensAtWindowStart: 123_456 };
  const env = buildSessionSyncEnvelope({
    kind: 'state',
    tabId: 'tab-A',
    emittedAtMs: 1_700_000_100_000,
    state,
  });
  const round = parseSessionSyncEnvelope(JSON.parse(JSON.stringify(env)));
  assert.ok(round, '정상 JSON 라운드트립 후 null 이 나오면 직렬화 계약이 깨진다');
  assert.equal(round!.kind, 'state');
  assert.equal(round!.tabId, 'tab-A');
  assert.deepEqual(round!.state, state);

  // 손상된 입력은 null — UI 가 깨지지 않도록 조용히 무시되어야 한다.
  assert.equal(parseSessionSyncEnvelope(null), null);
  assert.equal(parseSessionSyncEnvelope({ schemaVersion: 2, kind: 'state', tabId: 't', emittedAtMs: 0 }), null,
    '스키마 버전 불일치는 null — v1/v2 혼합 배포 중 구 탭이 신 탭 envelope 를 오해석하면 안 된다');
  assert.equal(parseSessionSyncEnvelope({ schemaVersion: 1, kind: 'status', tabId: '', emittedAtMs: 0 }), null,
    '빈 tabId 는 거부 — 자기 에코 방지가 불가능해진다');
  assert.equal(parseSessionSyncEnvelope({ schemaVersion: 1, kind: 'status', tabId: 'x', emittedAtMs: 0 }), null,
    'status envelope 에 status 페이로드가 없으면 거부');

  // status 페이로드 유효성.
  const statusEnv = buildSessionSyncEnvelope({
    kind: 'status',
    tabId: 'tab-B',
    emittedAtMs: 1,
    status: { value: 'exhausted', reason: '한도 도달' },
  });
  const statusRound = parseSessionSyncEnvelope(JSON.parse(JSON.stringify(statusEnv)));
  assert.equal(statusRound!.status?.value, 'exhausted');
  assert.equal(statusRound!.status?.reason, '한도 도달');
});

test('B2 — shouldAcceptSyncEnvelope: 자기 에코/오래된/미래 메시지 차단, 정상만 통과', () => {
  const now = 1_700_000_300_000;
  const base = (overrides: Partial<SessionSyncEnvelope> = {}): SessionSyncEnvelope => ({
    schemaVersion: 1,
    kind: 'state',
    tabId: 'remote',
    emittedAtMs: now - 5_000,
    state: { windowStartMs: 1, tokensAtWindowStart: 0 },
    ...overrides,
  });

  // 정상: 5초 전 메시지 → accept.
  assert.equal(shouldAcceptSyncEnvelope({ envelope: base(), localTabId: 'local', nowMs: now }), true);

  // 자기 에코: 자기 탭 id 는 거절. BroadcastChannel 은 자기 자신한테도 쏘므로 이 가드가 필수.
  assert.equal(
    shouldAcceptSyncEnvelope({ envelope: base({ tabId: 'local' }), localTabId: 'local', nowMs: now }),
    false,
    '자기 탭 envelope 를 받아들이면 send → 수신 → re-send 의 피드백 루프가 생긴다',
  );

  // 오래됨: 2분 전 메시지는 거절(기본 maxAge 60초).
  assert.equal(
    shouldAcceptSyncEnvelope({ envelope: base({ emittedAtMs: now - 120_000 }), localTabId: 'local', nowMs: now }),
    false,
    '재생 공격/지연된 storage 이벤트가 세션을 역행 전환시키면 안 된다',
  );

  // 미래 타임스탬프: 다른 탭 시계가 10분 앞서도 거절.
  assert.equal(
    shouldAcceptSyncEnvelope({ envelope: base({ emittedAtMs: now + 600_000 }), localTabId: 'local', nowMs: now }),
    false,
  );

  // 커스텀 maxAgeMs: 30초로 줄이면 45초 전 메시지가 거절된다.
  assert.equal(
    shouldAcceptSyncEnvelope({ envelope: base({ emittedAtMs: now - 45_000 }), localTabId: 'local', nowMs: now, maxAgeMs: 30_000 }),
    false,
  );
});

test('B3 — resolveSessionStateConflict: 더 최근 windowStartMs 를 선호, 동률이면 tokensAtWindowStart 작은 쪽', () => {
  const oldWin: SubscriptionSessionState = { windowStartMs: 100, tokensAtWindowStart: 500 };
  const newWin: SubscriptionSessionState = { windowStartMs: 200, tokensAtWindowStart: 0 };

  // 한 쪽이 null → non-null 사용.
  assert.equal(resolveSessionStateConflict(null, oldWin), oldWin);
  assert.equal(resolveSessionStateConflict(newWin, null), newWin);

  // windowStartMs 가 더 큰 쪽(=리셋이 더 최근) 을 사용.
  assert.equal(resolveSessionStateConflict(oldWin, newWin), newWin,
    '리셋 사실이 유실되면 탭 간 "한쪽만 새 창, 한쪽은 옛 창" 상태가 무한히 엇갈린다');
  assert.equal(resolveSessionStateConflict(newWin, oldWin), newWin);

  // 동률 windowStartMs → 더 작은 tokensAtWindowStart 선호.
  const sameWinLow: SubscriptionSessionState = { windowStartMs: 100, tokensAtWindowStart: 200 };
  const sameWinHigh: SubscriptionSessionState = { windowStartMs: 100, tokensAtWindowStart: 800 };
  assert.equal(resolveSessionStateConflict(sameWinHigh, sameWinLow), sameWinLow,
    'tokensAtWindowStart 가 작은 쪽을 쓰지 않으면 cumulative 가 내려간 직후 used 가 음수로 튄다');
});

// ---------------------------------------------------------------------------
// R — 새로고침 복원: localStorage 스냅샷과 서버 응답의 순서 방어.
// 배경: 네트워크가 느려도 이전 화면을 재현해야 하고, 서버 응답이 도착하면 그 즉시
// 권위값으로 치환해야 한다. 특히 "로컬=exhausted, 서버=active" 레이스는 배지가
// 새로고침 뒤에도 잘못 남아 있는 UX 회귀를 만드는 대표 경로다.
// ---------------------------------------------------------------------------

test('R1 — serialize → deserialize 라운드트립: 유효 스냅샷은 복원되고 오래되거나 손상된 값은 null', () => {
  const now = 2_000_000_000_000;
  const payload = serializePersistedSession({
    state: { windowStartMs: now - 10 * 60_000, tokensAtWindowStart: 777 },
    status: 'warning',
    statusReason: '80% 임계',
    savedAtMs: now - 60_000,
  });
  const raw = JSON.stringify(payload);

  // 정상 복원.
  const restored = deserializePersistedSession(raw, now);
  assert.ok(restored);
  assert.equal(restored!.status, 'warning');
  assert.equal(restored!.statusReason, '80% 임계');
  assert.equal(restored!.state.tokensAtWindowStart, 777);

  // 창이 이미 지난 경우: 5시간 + 1분 지나면 null 반환.
  const tooOldState = serializePersistedSession({
    state: { windowStartMs: now - SUBSCRIPTION_SESSION_WINDOW_MS - 60_000, tokensAtWindowStart: 0 },
    status: 'active',
    savedAtMs: now - 60_000,
  });
  assert.equal(deserializePersistedSession(JSON.stringify(tooOldState), now), null,
    '이미 창이 지난 스냅샷을 복원하면 카운터가 이월돼 used 가 터진다');

  // 저장 시각이 너무 오래됨(기본 maxAge=WINDOW) → null.
  assert.equal(
    deserializePersistedSession(
      JSON.stringify({ ...payload, savedAtMs: now - SUBSCRIPTION_SESSION_WINDOW_MS - 10_000 }),
      now,
    ),
    null,
  );

  // 손상된 입력/스키마 불일치.
  assert.equal(deserializePersistedSession('{"not":"json-session"}', now), null);
  assert.equal(deserializePersistedSession('not-json', now), null);
  assert.equal(deserializePersistedSession(null, now), null);
  assert.equal(
    deserializePersistedSession(JSON.stringify({ ...payload, schemaVersion: 99 }), now),
    null,
    '다음 버전 스키마는 읽지 않는다 — 구버전 탭이 신버전 페이로드를 오해석하면 안 된다',
  );
});

test('R2 — reconcileRestoredWithServer: 서버 응답이 오면 권위값 치환, 없으면 복원값 유지', () => {
  const now = 2_000_000_100_000;
  const restored: PersistedSubscriptionSession = {
    schemaVersion: 1,
    state: { windowStartMs: now - 60_000, tokensAtWindowStart: 100 },
    status: 'exhausted',
    statusReason: '구 배지',
    savedAtMs: now - 30_000,
  };

  // 서버가 active 로 응답 → 즉시 active 복귀. 이 경로를 잠그지 않으면 새로고침
  // 이후 서버는 이미 리셋됐는데 UI 만 exhausted 로 남는 회귀가 재발한다.
  const activeOverride = reconcileRestoredWithServer({
    restored, serverStatus: 'active', nowMs: now,
  });
  assert.equal(activeOverride.status, 'active');
  assert.equal(activeOverride.state, restored.state, '상태는 치환됐지만 state 스냅은 유지 — 잔량 표시에 이어쓴다');
  assert.equal(activeOverride.statusReason, undefined,
    '서버가 reason 을 주지 않으면 과거 사유를 남겨 두지 않는다');

  // 서버 응답이 아직 없음(네트워크 차단/404) → 복원값 유지.
  const held = reconcileRestoredWithServer({ restored, serverStatus: null, nowMs: now });
  assert.equal(held.status, 'exhausted');
  assert.equal(held.statusReason, '구 배지');

  // 복원도 없고 서버도 없음 → 안전 폴백(active + state=null).
  const fallback = reconcileRestoredWithServer({ restored: null, serverStatus: null, nowMs: now });
  assert.equal(fallback.status, 'active');
  assert.equal(fallback.state, null);

  // 서버 응답은 있으나 복원 없음 → 서버 값만 사용, state 는 null(컴포넌트가 prev=null 로 시작).
  const serverOnly = reconcileRestoredWithServer({
    restored: null, serverStatus: 'warning', serverStatusReason: '경계', nowMs: now,
  });
  assert.equal(serverOnly.status, 'warning');
  assert.equal(serverOnly.statusReason, '경계');
  assert.equal(serverOnly.state, null);
});
