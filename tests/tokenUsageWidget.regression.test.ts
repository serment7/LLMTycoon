// Run with: npx tsx --test tests/tokenUsageWidget.regression.test.ts
//
// QA: 상단바 Claude 토큰 사용량 위젯 회귀 테스트.
//
// 범위
// ────────────────────────────────────────────────────────────────────────
// 본 파일은 상단바에 도입 예정인 "클로드 토큰 사용량 위젯" 이 (U1) API 호출
// 전/후로 누적값을 올바르게 증가시키는지, (U2) 캐시 히트 이벤트에서
// cache_read_input_tokens 를 일반 input 과 구분해 보여 주는지, (U3) 세션
// 리셋과 페이지 새로고침 사이에서 누적 정책이 일관적인지, (U4) Joker 가
// 넘긴 UI 전수 점검 체크리스트 항목들이 위젯 동작 계약과 충돌하지 않는지를
// 네 축으로 잠근다.
//
// 우선 검토 파일: server.ts — Claude CLI 자식 프로세스의 stream-json `result`
// 이벤트를 받는 유일한 지점이 `src/server/agentWorker.ts::handleMessage` 이고,
// 사용량 집계 REST/소켓 엔드포인트는 앞으로 `server.ts` 에
// `/api/claude-usage` / `/api/claude-usage/reset` / 소켓 `claude-usage:updated`
// 로 추가될 예정이다. 본 테스트는 그 계약을 시뮬레이터로 선제 잠근다.
//
// 배경 — 회귀 방지 목적
// ────────────────────────────────────────────────────────────────────────
// 저장소에는 아직 `input_tokens` / `output_tokens` / `cache_read_input_tokens`
// 키워드가 server.ts / agentWorker.ts 에 없고(검색 기준 0건), `docs/ui-audit-
// 2026-04-19.md` (Joker 의 UI 전수 점검 체크리스트) 도 아직 합류 전이다.
// 본 테스트는 위젯이 실제로 합쳐지기 전에 다음 회귀 카테고리를 선제 차단한다.
//
//   R1. `result` 이벤트의 usage 가 누락돼도 위젯이 스택 트레이스 없이 0 으로 수렴.
//   R2. 캐시 히트가 `input_tokens` 필드로만 보고될 때 캐시 읽기 구분이 사라지는 회귀.
//   R3. 페이지 새로고침 직후 lifetime 누적값이 순간적으로 0 으로 깜빡이는 플리커.
//   R4. 세션 리셋 버튼이 lifetime 까지 같이 지우는 "과잉 리셋" 회귀.
//
// 시뮬레이터 기반 (실제 구현 도입 전)
// ────────────────────────────────────────────────────────────────────────
// `src/server/claudeUsage.ts` (신규 예정) 와 `src/components/TokenUsageWidget.tsx`
// (신규 예정) 가 합류하면 본 시뮬레이터(`accumulate*` / `format*`) 는 해당
// 모듈의 export 함수로 1:1 이식된다.
//
// ┌─ 케이스 지도 ────────────────────────────────────────────────────────────┐
// │ U1  빈 상태 → API 호출 1회 → 위젯의 input/output 값이 정확히 증가          │
// │ U2  캐시 히트 이벤트 → cache_read_input_tokens 가 별도 필드로 구분 표시    │
// │ U3  세션 리셋 / 새로고침 → session 은 0 복귀, lifetime 은 유지             │
// │ U4  Joker UI 전수 점검 체크리스트 항목별 위젯 동작 재현 계약 (10항목)      │
// └──────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 타입 정의 — Claude CLI stream-json `result` 페이로드의 usage 블록을 본뜬다.
// ---------------------------------------------------------------------------

export interface ClaudeUsageEvent {
  // 새로 읽혀 들어간 프롬프트 토큰(캐시 미스 경로).
  input_tokens: number;
  // 응답으로 생성된 출력 토큰.
  output_tokens: number;
  // 캐시 히트로 재사용된 입력 토큰 — 일반 input 과 과금/의미가 다르므로
  // 반드시 별도 필드로 누적해 UI 에 구분 표시한다. 필드 누락 시 0 으로 취급.
  cache_read_input_tokens?: number;
  // 캐시 생성에 쓰인 토큰(프롬프트 캐싱 활성 시). 본 테스트 범위 외지만
  // 누적 함수에서 방어적으로 수용해 합계 일관성을 지킨다.
  cache_creation_input_tokens?: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface UsageSnapshot {
  // 현재 브라우저/서버 세션 진입 이후 누적. "리셋" 버튼이 0 으로 되돌린다.
  session: UsageTotals;
  // 영속 누적(서버 DB 혹은 장기 저장소). 리셋은 lifetime 을 건드리지 않는다.
  lifetime: UsageTotals;
  // 마지막 집계 시각(ISO). UI 툴팁에 "방금" / "N분 전" 으로 표기.
  updatedAt: string;
}

const ZERO_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
};

const EMPTY_SNAPSHOT: UsageSnapshot = {
  session: { ...ZERO_TOTALS },
  lifetime: { ...ZERO_TOTALS },
  updatedAt: '1970-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// 시뮬레이터
// ---------------------------------------------------------------------------

/**
 * Claude CLI `result` 이벤트의 usage 블록을 스냅샷에 누적한다.
 *
 * 불변 계약
 * ─────────────────────────────────────────────────────────────────────────
 *  1) usage 가 undefined/null 이면 스냅샷을 mutate 하지 않는다(예외 금지).
 *  2) 각 필드는 number 이며 음수/NaN 은 0 으로 방어 처리.
 *  3) session 과 lifetime 두 축 모두 동일한 증분으로 증가한다.
 *  4) cache_read_input_tokens 는 input 에 합산하지 않는다 — UI 구분 전제.
 *  5) updatedAt 은 호출자가 전달한 nowIso 로 단조 전진(과거 시각으로 덮어쓰지 않음).
 */
export function accumulateUsage(
  snapshot: UsageSnapshot,
  usage: ClaudeUsageEvent | null | undefined,
  nowIso: string,
): UsageSnapshot {
  if (!usage || typeof usage !== 'object') {
    return snapshot;
  }
  const safe = (n: unknown): number => {
    const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    return v < 0 ? 0 : v;
  };
  const inc: UsageTotals = {
    input: safe(usage.input_tokens),
    output: safe(usage.output_tokens),
    cacheRead: safe(usage.cache_read_input_tokens),
    cacheCreate: safe(usage.cache_creation_input_tokens),
  };
  const nextTime =
    nowIso > snapshot.updatedAt ? nowIso : snapshot.updatedAt;
  return {
    session: addTotals(snapshot.session, inc),
    lifetime: addTotals(snapshot.lifetime, inc),
    updatedAt: nextTime,
  };
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreate: a.cacheCreate + b.cacheCreate,
  };
}

/**
 * 세션 리셋. lifetime 은 그대로, session 만 0 으로 되돌린다.
 */
export function resetSession(
  snapshot: UsageSnapshot,
  nowIso: string,
): UsageSnapshot {
  return {
    session: { ...ZERO_TOTALS },
    lifetime: snapshot.lifetime,
    updatedAt: nowIso > snapshot.updatedAt ? nowIso : snapshot.updatedAt,
  };
}

/**
 * 페이지 새로고침 경로 시뮬레이션. 클라이언트 메모리는 날아가지만, 서버에서
 * lifetime 은 복원되어야 하고 session 은 새 브라우저 세션이므로 0 에서 시작.
 * 현재 하이드레이션 계약: 서버 GET `/api/claude-usage` 가 lifetime 을 응답,
 * session 은 클라이언트가 새로 시작한다.
 */
export function hydrateAfterRefresh(
  serverLifetime: UsageTotals,
  nowIso: string,
): UsageSnapshot {
  return {
    session: { ...ZERO_TOTALS },
    lifetime: { ...serverLifetime },
    updatedAt: nowIso,
  };
}

/**
 * 위젯 표시 문자열 포맷터. 천 단위 구분 + "캐시 N" 배지 문자열 한 줄.
 * 실 구현에서는 JSX 배지로 쪼개지지만, 한국어 레이블·숫자 포맷 계약을
 * 여기서 한 번 잠근다.
 */
export function formatWidgetLabel(totals: UsageTotals): {
  primary: string;
  cacheBadge: string | null;
} {
  const fmt = (n: number) => n.toLocaleString('ko-KR');
  const primary = `입력 ${fmt(totals.input)} · 출력 ${fmt(totals.output)}`;
  const cacheBadge =
    totals.cacheRead > 0 ? `캐시 ${fmt(totals.cacheRead)}` : null;
  return { primary, cacheBadge };
}

// ---------------------------------------------------------------------------
// 공용 픽스처
// ---------------------------------------------------------------------------

const T0 = '2026-04-19T09:00:00.000Z';
const T1 = '2026-04-19T09:05:00.000Z';
const T2 = '2026-04-19T09:10:00.000Z';
const T3 = '2026-04-19T09:15:00.000Z';

const FIRST_CALL: ClaudeUsageEvent = {
  input_tokens: 1200,
  output_tokens: 400,
};

const SECOND_CALL: ClaudeUsageEvent = {
  input_tokens: 300,
  output_tokens: 150,
};

const CACHE_HIT_CALL: ClaudeUsageEvent = {
  input_tokens: 80,
  output_tokens: 60,
  cache_read_input_tokens: 1100,
  cache_creation_input_tokens: 0,
};

// ---------------------------------------------------------------------------
// U1 — 빈 상태 → API 호출 1회 → input/output 이 증가한다.
// ---------------------------------------------------------------------------

test('U1 — 빈 스냅샷에 첫 Claude 호출 usage 를 누적하면 위젯의 입력/출력 값이 정확히 증가한다', () => {
  const before = EMPTY_SNAPSHOT;
  const after = accumulateUsage(before, FIRST_CALL, T1);
  // 누적 전: 0 / 0
  assert.equal(before.session.input, 0);
  assert.equal(before.session.output, 0);
  // 누적 후: input/output 정확히 증가, 캐시 필드는 여전히 0.
  assert.equal(after.session.input, 1200);
  assert.equal(after.session.output, 400);
  assert.equal(after.session.cacheRead, 0);
  assert.equal(after.lifetime.input, 1200, 'lifetime 도 동일 증분');
  assert.equal(after.updatedAt, T1);
});

test('U1 — 연속 호출 시 session/lifetime 모두 동일한 증분으로 누적된다', () => {
  let snap = EMPTY_SNAPSHOT;
  snap = accumulateUsage(snap, FIRST_CALL, T1);
  snap = accumulateUsage(snap, SECOND_CALL, T2);
  assert.equal(snap.session.input, 1200 + 300);
  assert.equal(snap.session.output, 400 + 150);
  assert.equal(snap.lifetime.input, snap.session.input);
  assert.equal(snap.lifetime.output, snap.session.output);
});

test('U1 회귀 — usage 가 undefined/null 로 와도 스냅샷은 이전 값 그대로 유지된다(예외 없음)', () => {
  const base = accumulateUsage(EMPTY_SNAPSHOT, FIRST_CALL, T1);
  const afterNull = accumulateUsage(base, null, T2);
  const afterUndef = accumulateUsage(base, undefined, T2);
  assert.deepEqual(afterNull.session, base.session, 'null 누적은 no-op 이어야 한다');
  assert.deepEqual(afterUndef.session, base.session);
});

test('U1 회귀 — 음수/NaN/문자열 usage 값은 0 으로 방어되어 총합이 감소하지 않는다', () => {
  const badUsage = {
    input_tokens: -50,
    output_tokens: Number.NaN,
    cache_read_input_tokens: 'oops' as unknown as number,
  } as ClaudeUsageEvent;
  const snap = accumulateUsage(EMPTY_SNAPSHOT, badUsage, T1);
  assert.equal(snap.session.input, 0);
  assert.equal(snap.session.output, 0);
  assert.equal(snap.session.cacheRead, 0);
});

test('U1 — formatWidgetLabel 은 천 단위 구분 + 캐시 배지가 0 이면 null 을 낸다', () => {
  const snap = accumulateUsage(EMPTY_SNAPSHOT, FIRST_CALL, T1);
  const { primary, cacheBadge } = formatWidgetLabel(snap.session);
  assert.equal(primary, '입력 1,200 · 출력 400');
  assert.equal(cacheBadge, null, '캐시 히트 없으면 배지 미노출');
});

// ---------------------------------------------------------------------------
// U2 — 캐시 히트 시 cache_read_input_tokens 가 별도 필드로 누적·표시된다.
// ---------------------------------------------------------------------------

test('U2 — 캐시 히트 이벤트는 cache_read_input_tokens 가 별도 축으로 누적되고 input 과 혼합되지 않는다', () => {
  const snap = accumulateUsage(EMPTY_SNAPSHOT, CACHE_HIT_CALL, T1);
  assert.equal(snap.session.input, 80, 'cache_read 가 input 에 합산되면 UI 구분 회귀');
  assert.equal(snap.session.output, 60);
  assert.equal(snap.session.cacheRead, 1100, '캐시 히트는 별도 축으로 누적되어야 한다');
  assert.equal(snap.session.cacheCreate, 0);
});

test('U2 — formatWidgetLabel 이 캐시 히트 시 "캐시 N" 배지를 별도 문자열로 낸다', () => {
  const snap = accumulateUsage(EMPTY_SNAPSHOT, CACHE_HIT_CALL, T1);
  const { primary, cacheBadge } = formatWidgetLabel(snap.session);
  assert.equal(primary, '입력 80 · 출력 60');
  assert.equal(cacheBadge, '캐시 1,100');
});

test('U2 회귀 — 일반 호출 → 캐시 히트 호출 순서로 섞여도 축별 누적이 섞이지 않는다', () => {
  let snap = EMPTY_SNAPSHOT;
  snap = accumulateUsage(snap, FIRST_CALL, T1);       // input 1200 / output 400
  snap = accumulateUsage(snap, CACHE_HIT_CALL, T2);   // +input 80 / +output 60 / +cacheRead 1100
  assert.equal(snap.session.input, 1200 + 80);
  assert.equal(snap.session.output, 400 + 60);
  assert.equal(snap.session.cacheRead, 1100);
});

test('U2 회귀 — cache_read_input_tokens 필드 자체가 누락된 과거 SDK 응답은 0 으로 간주하되 예외는 없다', () => {
  const legacy: ClaudeUsageEvent = { input_tokens: 500, output_tokens: 200 };
  const snap = accumulateUsage(EMPTY_SNAPSHOT, legacy, T1);
  assert.equal(snap.session.cacheRead, 0);
  assert.equal(snap.session.input, 500);
});

// ---------------------------------------------------------------------------
// U3 — 세션 리셋·페이지 새로고침 시 누적값 처리 정책이 일관적이어야 한다.
// ---------------------------------------------------------------------------

test('U3 — 세션 리셋은 session 만 0 으로 되돌리고 lifetime 은 유지한다', () => {
  let snap = EMPTY_SNAPSHOT;
  snap = accumulateUsage(snap, FIRST_CALL, T1);
  snap = accumulateUsage(snap, CACHE_HIT_CALL, T2);
  const beforeLifetime = { ...snap.lifetime };
  const reset = resetSession(snap, T3);
  assert.deepEqual(reset.session, ZERO_TOTALS, 'session 은 0 으로');
  assert.deepEqual(reset.lifetime, beforeLifetime, 'lifetime 은 건드리면 안 된다');
  assert.equal(reset.updatedAt, T3);
});

test('U3 — 페이지 새로고침 경로는 서버 lifetime 복원 + session 0 에서 시작한다', () => {
  const serverLifetime: UsageTotals = {
    input: 5000,
    output: 1200,
    cacheRead: 800,
    cacheCreate: 0,
  };
  const hydrated = hydrateAfterRefresh(serverLifetime, T3);
  assert.deepEqual(hydrated.session, ZERO_TOTALS, '새 브라우저 세션은 0 에서 시작');
  assert.deepEqual(hydrated.lifetime, serverLifetime, '서버 lifetime 이 그대로 복원');
});

test('U3 회귀 — 리셋 직후 새 호출이 들어오면 session 은 그 호출값으로, lifetime 은 이전 + 새 호출 합산이어야 한다', () => {
  let snap = EMPTY_SNAPSHOT;
  snap = accumulateUsage(snap, FIRST_CALL, T1);
  snap = resetSession(snap, T2);
  snap = accumulateUsage(snap, SECOND_CALL, T3);
  assert.equal(snap.session.input, SECOND_CALL.input_tokens);
  assert.equal(snap.lifetime.input, FIRST_CALL.input_tokens + SECOND_CALL.input_tokens);
});

test('U3 회귀 — 새로고침 직후 위젯이 0 으로 순간 깜빡이지 않도록 하이드레이션 경로는 단일 호출로 끝낸다', () => {
  // 계약: hydrateAfterRefresh 의 반환에 이미 lifetime 이 채워져 있어야 한다.
  // 만약 반환 후 별도 fetch 로 lifetime 을 비동기 채우면 그 사이 0 플리커가 난다.
  const hydrated = hydrateAfterRefresh(
    { input: 7, output: 3, cacheRead: 2, cacheCreate: 0 },
    T1,
  );
  assert.ok(hydrated.lifetime.input > 0, '하이드레이션 반환 시점에 lifetime 이 즉시 채워져야 한다');
});

test('U3 회귀 — updatedAt 은 과거 시각으로 덮어쓰이지 않는다(시계 되감김 방어)', () => {
  let snap = EMPTY_SNAPSHOT;
  snap = accumulateUsage(snap, FIRST_CALL, T2);
  const earlier = accumulateUsage(snap, SECOND_CALL, T1); // T1 < T2
  assert.equal(earlier.updatedAt, T2, '이전 시각으로 퇴행하면 안 된다');
});

// ---------------------------------------------------------------------------
// U4 — Joker UI 전수 점검 체크리스트(docs/ui-audit-2026-04-19.md) 기반 재현 케이스.
// 체크리스트 파일이 아직 합류 전이므로 본 테스트는 "합류 시 반드시 맞춰야 하는
// 위젯 동작 계약" 10항목을 선제 잠근다. 항목명은 파일이 합류하면 해당 섹션
// 헤더와 1:1 매핑되어야 한다(문서 §U4-매핑 참조).
// ---------------------------------------------------------------------------

test('U4 — Joker 점검 10항목 · 위젯 동작 재현 계약', () => {
  type AuditRow = {
    id: string;
    label: string;
    verify: (snap: UsageSnapshot) => boolean;
  };
  const rows: AuditRow[] = [
    // (1) 빈 상태에서도 위젯 컨테이너는 렌더되어야 한다(숨김 금지).
    { id: 'J-01', label: '빈 상태 컨테이너 유지',
      verify: (s) => formatWidgetLabel(s.session).primary === '입력 0 · 출력 0' },
    // (2) 캐시 미스 단독일 때는 배지 없음.
    { id: 'J-02', label: '캐시 0 → 배지 null',
      verify: (s) => formatWidgetLabel(s.session).cacheBadge === null },
    // (3) 캐시 히트 1회 후 배지 문자열 포맷 일관.
    { id: 'J-03', label: '캐시 히트 후 "캐시 N" 배지',
      verify: (s) => {
        const withHit = accumulateUsage(s, CACHE_HIT_CALL, T1);
        return formatWidgetLabel(withHit.session).cacheBadge === '캐시 1,100';
      } },
    // (4) 숫자 포맷은 ko-KR 로컬(쉼표 구분자).
    { id: 'J-04', label: 'ko-KR 천 단위 구분',
      verify: (s) => {
        const snap = accumulateUsage(s, { input_tokens: 12345, output_tokens: 0 }, T1);
        return formatWidgetLabel(snap.session).primary.startsWith('입력 12,345');
      } },
    // (5) 세션 리셋 버튼 동작 — lifetime 불변.
    { id: 'J-05', label: '리셋 후 lifetime 불변',
      verify: (s) => {
        const filled = accumulateUsage(s, FIRST_CALL, T1);
        const reset = resetSession(filled, T2);
        return reset.lifetime.input === FIRST_CALL.input_tokens;
      } },
    // (6) 새로고침 경로 — 서버 lifetime 복원.
    { id: 'J-06', label: '새로고침 → lifetime 복원',
      verify: () => {
        const h = hydrateAfterRefresh({ input: 9, output: 4, cacheRead: 2, cacheCreate: 0 }, T1);
        return h.lifetime.input === 9 && h.session.input === 0;
      } },
    // (7) usage 누락 방어.
    { id: 'J-07', label: 'usage 누락 방어',
      verify: (s) => accumulateUsage(s, null, T1) === s },
    // (8) 음수/NaN 방어.
    { id: 'J-08', label: '음수/NaN 방어',
      verify: (s) => {
        const bad = accumulateUsage(s, { input_tokens: -1, output_tokens: NaN }, T1);
        return bad.session.input === 0 && bad.session.output === 0;
      } },
    // (9) updatedAt 단조 전진.
    { id: 'J-09', label: 'updatedAt 단조 전진',
      verify: (s) => {
        const later = accumulateUsage(s, FIRST_CALL, T2);
        const earlier = accumulateUsage(later, SECOND_CALL, T1);
        return earlier.updatedAt === T2;
      } },
    // (10) session/lifetime 두 축 동시 증분.
    { id: 'J-10', label: 'session·lifetime 동시 증분',
      verify: (s) => {
        const next = accumulateUsage(s, FIRST_CALL, T1);
        return next.session.input === next.lifetime.input &&
               next.session.output === next.lifetime.output;
      } },
  ];
  for (const row of rows) {
    assert.ok(row.verify(EMPTY_SNAPSHOT), `${row.id} ${row.label} 검증 실패`);
  }
});

// ---------------------------------------------------------------------------
// 불변 계약 — (usage 종류 × 누적 방식 × 리셋 여부) 진리표로 한 번 더 잠금.
// ---------------------------------------------------------------------------

test('불변 — (usageKind × resetBefore) 4조합 진리표', () => {
  type Row = {
    kind: 'plain' | 'cacheHit';
    resetBefore: boolean;
    expectSessionInput: number;
    expectCacheRead: number;
  };
  const rows: Row[] = [
    { kind: 'plain',    resetBefore: false, expectSessionInput: 1200, expectCacheRead: 0 },
    { kind: 'cacheHit', resetBefore: false, expectSessionInput: 80,   expectCacheRead: 1100 },
    // 리셋 이후 새 호출 1회.
    { kind: 'plain',    resetBefore: true,  expectSessionInput: 1200, expectCacheRead: 0 },
    { kind: 'cacheHit', resetBefore: true,  expectSessionInput: 80,   expectCacheRead: 1100 },
  ];
  for (const row of rows) {
    let snap: UsageSnapshot = {
      session: { input: 9999, output: 9999, cacheRead: 9999, cacheCreate: 0 },
      lifetime: { input: 9999, output: 9999, cacheRead: 9999, cacheCreate: 0 },
      updatedAt: T0,
    };
    if (row.resetBefore) snap = resetSession(snap, T1);
    const evt = row.kind === 'plain' ? FIRST_CALL : CACHE_HIT_CALL;
    snap = accumulateUsage(snap, evt, T2);
    const expectedSession = row.resetBefore ? row.expectSessionInput : 9999 + row.expectSessionInput;
    const expectedCache = row.resetBefore ? row.expectCacheRead : 9999 + row.expectCacheRead;
    assert.equal(snap.session.input, expectedSession,
      `session.input 불일치: ${JSON.stringify(row)}`);
    assert.equal(snap.session.cacheRead, expectedCache,
      `session.cacheRead 불일치: ${JSON.stringify(row)}`);
  }
});
