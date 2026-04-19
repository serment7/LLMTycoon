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
  computeSubscriptionSessionSnapshot,
  dequeuePendingRequest,
  enqueuePendingRequest,
  flushPendingOnReset,
  formatResetClock,
  formatTimeUntilReset,
  severityFromRatio,
  shouldFlushPendingQueue,
  type PendingSessionQueue,
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
