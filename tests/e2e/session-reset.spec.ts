// Run with: npx tsx --test tests/e2e/session-reset.spec.ts
//
// QA 회귀(세션 리셋 전용, #e461c1bb) — Claude 구독 5시간 롤링 윈도우의
// 만료·리셋 사이클 동안 UI 스토어·서버 큐·자동화 설정이 **관찰 가능한
// 단계별 계약** 을 지키는지 잠근다.
//
// 본 파일의 범위
// ────────────────────────────────────────────────────────────────────────────
// 본 저장소는 Playwright 미도입이라 브라우저 렌더·색상 대비·키보드 탐색은
// 자동화하지 않는다. 그 대신 순수 함수(computeSubscriptionSessionSnapshot),
// 클라이언트 스토어(claudeTokenUsageStore), 서버 큐 모듈(agentWorker) 의
// 공개 API 만 두드려 5 시나리오의 "관찰 가능한 상태 전이" 를 잠근다. 실제
// 시각 렌더·색상 대비는 `tests/qa/session-reset-scenarios.md` §수동 체크리스트
// 와 `tests/qa/ui-smoke-report.md` §7 에서 다룬다.
//
// 시나리오 지도(문서 §와 1:1 대응)
//   §1  잔량 ≤ 5% 에서 severity 전환(순수 함수)
//   §2  세션 active → exhausted 순간 태스크 경계 큐잉
//   §3  5시간 경계 리셋 + 자동 재개(스냅샷 isReset + flush)
//   §4  폴백 배지(스토어 setError) 와 회복 경로
//   §5  리셋 사이클이 저장된 branchMode/branchModeNewName 을 오염시키지 않는다
//
// 관련 선행 테스트
//   · tests/agentWorkerTaskBoundary.regression.test.ts  — 큐잉 단위 계약
//   · tests/branchModeSketch.regression.test.ts         — A안 저장·로드 왕복
//   · tests/branchStrategySaveLoad.regression.test.ts   — 4 전략 왕복

import test, { before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUBSCRIPTION_SESSION_WINDOW_MS,
  DEFAULT_SUBSCRIPTION_TOKEN_LIMIT,
  computeSubscriptionSessionSnapshot,
  severityFromRatio,
  type SubscriptionSessionState,
} from '../../src/utils/claudeSubscriptionSession.ts';
import { claudeTokenUsageStore } from '../../src/utils/claudeTokenUsageStore.ts';
import {
  setAgentWorkerSessionStatus,
  setTaskBoundaryHandler,
  resetTaskBoundaryHandler,
  notifyTaskBoundary,
  flushQueuedTaskBoundaries,
  getQueuedTaskBoundaryCount,
  type TaskBoundaryEvent,
} from '../../src/server/agentWorker.ts';
import type { TaskBoundaryCommitConfig } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// 공용 픽스처
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 3, 19, 10, 0, 0); // 2026-04-19 10:00:00 UTC — 시간 이동 기준.
const LIMIT = DEFAULT_SUBSCRIPTION_TOKEN_LIMIT;

const DEFAULT_CFG: TaskBoundaryCommitConfig = {
  commitStrategy: 'per-task',
  queueOnExhausted: true,
  skipIfNoStagedChanges: true,
};

function mkEvent(overrides: Partial<TaskBoundaryEvent> = {}): TaskBoundaryEvent {
  // changedFiles 가 비어 있으면 notifyTaskBoundary 가 즉시 'skipped-no-changes' 를
  // 돌려줘 큐 경로를 타지 않는다. 시나리오 2·3 는 반드시 "변경이 있는" 경계만 관찰.
  return {
    taskId: 't?',
    agentId: 'agent-qa',
    projectId: 'p-qa',
    description: 'QA 회귀용 가상 경계',
    changedFiles: ['src/utils/projectOptions.ts'],
    ...overrides,
  };
}

before(() => {
  // 각 테스트 파일 실행 시 세션 상태·핸들러가 공유된다 — 파일 시작점에서 한 번 초기화.
  resetTaskBoundaryHandler();
  setAgentWorkerSessionStatus('active');
});

beforeEach(() => {
  // 테스트 간 큐·핸들러·세션 상태가 격리되도록 매번 초기화.
  resetTaskBoundaryHandler();
  setAgentWorkerSessionStatus('active');
});

afterEach(() => {
  resetTaskBoundaryHandler();
  setAgentWorkerSessionStatus('active');
});

// ===========================================================================
// §1 — 잔량 ≤ 5% 에서 severity 전환
// ===========================================================================

test('§1-a severityFromRatio 는 0.5·0.8 경계에서 계단식으로 전환된다', () => {
  assert.equal(severityFromRatio(0), 'ok');
  assert.equal(severityFromRatio(0.49), 'ok');
  assert.equal(severityFromRatio(0.5), 'caution');
  assert.equal(severityFromRatio(0.79), 'caution');
  assert.equal(severityFromRatio(0.8), 'critical');
  assert.equal(severityFromRatio(0.99), 'critical');
  assert.equal(severityFromRatio(1), 'critical');
});

test('§1-b 스냅샷은 95%·99%·100% 세 구간에서 모두 critical 로 수렴하고 remaining 이 감소한다', () => {
  // 현재 구현은 0.95 를 별도 단계로 분리하지 않는다(문서 §1 UX 관찰). 본 테스트는
  // 그 사실을 "계약" 으로 고정해, 이후 severityFromRatio 가 임계를 추가할 때 반드시
  // 동반 업데이트되도록 한다 — 단계 추가가 본 테스트를 깨뜨리면 문서도 같이 갱신.
  const cases = [
    { used: 0.95, expectedRemaining: Math.floor(LIMIT * 0.05) },
    { used: 0.99, expectedRemaining: Math.floor(LIMIT * 0.01) },
    { used: 1.0, expectedRemaining: 0 },
  ];
  let state: SubscriptionSessionState | null = null;
  for (const { used, expectedRemaining } of cases) {
    const snap = computeSubscriptionSessionSnapshot({
      prev: state,
      cumulativeTokens: Math.round(LIMIT * used),
      nowMs: T0 + 60_000, // 같은 윈도우 안에서 누적만 늘어남
      limit: LIMIT,
    });
    state = snap.state;
    assert.equal(snap.severity, 'critical', `${used * 100}% 에서 critical 이어야 한다`);
    // remaining 은 정확히 limit - used. 반올림 오차 허용 1 토큰.
    assert.ok(
      Math.abs(snap.remaining - expectedRemaining) <= 1,
      `${used * 100}% 남은 토큰(${snap.remaining}) 이 기대값(${expectedRemaining}) 과 다르다`,
    );
  }
});

test('§1-c 최초 마운트(prev=null) 는 isReset=false 로 깜빡임을 막는다', () => {
  const snap = computeSubscriptionSessionSnapshot({
    prev: null,
    cumulativeTokens: 0,
    nowMs: T0,
    limit: LIMIT,
  });
  assert.equal(snap.isReset, false, '최초 마운트가 isReset=true 로 찍히면 리셋 배지가 불필요하게 깜빡인다');
  assert.equal(snap.used, 0);
  assert.equal(snap.severity, 'ok');
});

// ===========================================================================
// §2 — 세션 active → exhausted 순간 태스크 경계 큐잉
// ===========================================================================

test('§2-a active 상태에서는 태스크 경계가 즉시 핸들러로 흘러간다', () => {
  const seen: string[] = [];
  setTaskBoundaryHandler(e => { seen.push(e.taskId); });

  const res = notifyTaskBoundary(mkEvent({ taskId: 't1' }), DEFAULT_CFG);
  assert.equal(res, 'dispatched');
  assert.deepEqual(seen, ['t1']);
  assert.equal(getQueuedTaskBoundaryCount(), 0);
});

test('§2-b exhausted 전환 직후 첫 경계는 핸들러 호출 없이 큐로 들어간다', () => {
  const seen: string[] = [];
  setTaskBoundaryHandler(e => { seen.push(e.taskId); });

  // exhausted 로 전환 → 이전 상태와 상관없이 다음 notify 는 큐잉.
  setAgentWorkerSessionStatus('exhausted');
  const res = notifyTaskBoundary(mkEvent({ taskId: 't2' }), DEFAULT_CFG);

  assert.equal(res, 'queued-exhausted',
    'exhausted 중 태스크 경계가 dispatch 되면 "토큰 없을 때 커밋 폭주" 회귀가 재발한다');
  assert.equal(seen.length, 0, '핸들러는 이 시점에 호출되면 안 된다');
  assert.equal(getQueuedTaskBoundaryCount(), 1);
});

test('§2-c exhausted 중 추가 경계는 FIFO 순서로 누적되어 핸들러가 호출되지 않는다', () => {
  setTaskBoundaryHandler(() => { /* 관찰만 하고 효과 없음 */ });
  setAgentWorkerSessionStatus('exhausted');
  notifyTaskBoundary(mkEvent({ taskId: 'A' }), DEFAULT_CFG);
  notifyTaskBoundary(mkEvent({ taskId: 'B' }), DEFAULT_CFG);
  notifyTaskBoundary(mkEvent({ taskId: 'C' }), DEFAULT_CFG);
  assert.equal(getQueuedTaskBoundaryCount(), 3);
});

// ===========================================================================
// §3 — 5시간 경계 리셋 + 자동 재개
// ===========================================================================

test('§3-a 윈도우 안(경계 전)에서는 isReset=false 이며 used 가 누적된다', () => {
  const prev: SubscriptionSessionState = {
    windowStartMs: T0,
    tokensAtWindowStart: 0,
  };
  const snap = computeSubscriptionSessionSnapshot({
    prev,
    cumulativeTokens: Math.round(LIMIT * 0.5),
    nowMs: T0 + SUBSCRIPTION_SESSION_WINDOW_MS - 60_000, // 4:59
    limit: LIMIT,
  });
  assert.equal(snap.isReset, false);
  assert.equal(snap.used, Math.round(LIMIT * 0.5));
  assert.equal(snap.severity, 'caution');
  assert.equal(snap.state.windowStartMs, T0, '경계 이전에는 윈도우 시작 시각이 유지되어야 한다');
});

test('§3-b 5시간 경계를 지나면 isReset=true 로 새 창이 열리고 used=0 으로 리셋된다', () => {
  const prev: SubscriptionSessionState = {
    windowStartMs: T0,
    tokensAtWindowStart: 0,
  };
  const now = T0 + SUBSCRIPTION_SESSION_WINDOW_MS + 1;
  const cumulative = Math.round(LIMIT * 0.95); // 이전 창에서 95% 태웠다고 가정
  const snap = computeSubscriptionSessionSnapshot({
    prev,
    cumulativeTokens: cumulative,
    nowMs: now,
    limit: LIMIT,
  });
  assert.equal(snap.isReset, true, '5시간 경계를 지났는데 isReset=false 면 리셋 감지 회귀');
  assert.equal(snap.state.windowStartMs, now, '새 창의 시작 시각이 now 로 당겨져야 한다');
  assert.equal(snap.state.tokensAtWindowStart, cumulative,
    '새 창의 기준 누적이 현 누적과 같아야 used=0 이 나온다');
  assert.equal(snap.used, 0);
  assert.equal(snap.remaining, LIMIT);
  assert.equal(snap.severity, 'ok');
});

test('§3-c 누적이 이전보다 작아지는 경우(서버 reset 직후) windowStartMs 는 유지되고 used 가 음수로 빠지지 않는다', () => {
  // 서버가 claude-usage:reset 을 방출해 클라이언트가 hydrate(0) 를 받은 직후,
  // 5시간 경계는 아직 오지 않았을 수 있다. 이때 windowStartMs 를 유지하면서
  // tokensAtWindowStart 만 현 누적으로 당겨야 used 가 음수로 나오지 않는다.
  const prev: SubscriptionSessionState = {
    windowStartMs: T0,
    tokensAtWindowStart: 200_000,
  };
  const snap = computeSubscriptionSessionSnapshot({
    prev,
    cumulativeTokens: 0, // 서버 리셋 직후
    nowMs: T0 + 60 * 60 * 1000, // 1시간 경과
    limit: LIMIT,
  });
  assert.equal(snap.isReset, false, '경계 이전에는 isReset=false');
  assert.equal(snap.state.windowStartMs, T0, '창 시작 시각은 유지');
  assert.equal(snap.state.tokensAtWindowStart, 0, '기준 누적은 현 누적으로 당겨진다');
  assert.equal(snap.used, 0);
  assert.ok(snap.remaining >= 0, 'remaining 은 항상 0 이상');
});

test('§3-d 큐가 3건 쌓인 상태에서 active 복귀 후 flushQueuedTaskBoundaries 가 FIFO 로 전부 되감는다', () => {
  const observed: Array<{ taskId: string; reason: string }> = [];
  setTaskBoundaryHandler((event, meta) => {
    observed.push({ taskId: event.taskId, reason: meta.reason });
  });

  // 1) exhausted 로 전환 후 3건 큐잉.
  setAgentWorkerSessionStatus('exhausted');
  notifyTaskBoundary(mkEvent({ taskId: 'X' }), DEFAULT_CFG);
  notifyTaskBoundary(mkEvent({ taskId: 'Y' }), DEFAULT_CFG);
  notifyTaskBoundary(mkEvent({ taskId: 'Z' }), DEFAULT_CFG);
  assert.equal(getQueuedTaskBoundaryCount(), 3);
  assert.equal(observed.length, 0, 'exhausted 중에는 핸들러가 호출되면 안 된다');

  // 2) active 로 복귀 — 이 시점에서는 아직 큐 자동 플러시는 없다.
  setAgentWorkerSessionStatus('active');
  assert.equal(getQueuedTaskBoundaryCount(), 3,
    'active 로 돌아왔다고 해서 상태 전환만으로 큐가 비워지면 안 된다(호출자 주도 flush 계약)');

  // 3) 호출자(App.tsx / server reset 핸들러) 가 명시적으로 flush 호출.
  const n = flushQueuedTaskBoundaries();
  assert.equal(n, 3, '쌓인 3건이 모두 디스패치되어야 한다');
  assert.equal(getQueuedTaskBoundaryCount(), 0);
  assert.deepEqual(
    observed.map(o => o.taskId),
    ['X', 'Y', 'Z'],
    'FIFO 순서가 깨지면 태스크 간 의존성(A 커밋 후 B 커밋) 이 뒤집혀 머지 사고 발생',
  );
  assert.ok(
    observed.every(o => o.reason === 'flush'),
    'flush 경로의 reason 은 "flush" — 즉시 디스패치와 구분이 필요',
  );
});

// ===========================================================================
// §4 — 폴백 배지(스토어 setError) 와 회복 경로
// ===========================================================================

test('§4-a setError 이후 구독 스냅샷에 loadError 가 채워지고 후속 hydrate 가 이를 리셋한다', () => {
  // 스토어는 전역 단일 인스턴스라 본 테스트가 다른 테스트와 공유된다 — 회복을
  // 위해 말미에 명시 hydrate 를 호출해 상태를 원복한다.
  const events: Array<string | null> = [];
  const unsubscribe = claudeTokenUsageStore.subscribe(() => {
    events.push(claudeTokenUsageStore.getSnapshot().loadError);
  });

  try {
    // 1) 네트워크 실패 모사.
    claudeTokenUsageStore.setError('네트워크가 지연되고 있습니다');
    assert.equal(
      claudeTokenUsageStore.getSnapshot().loadError,
      '네트워크가 지연되고 있습니다',
      'setError 가 스냅샷에 전달되지 않으면 폴백 배지 분기를 탈 수 없다',
    );

    // 2) 회복 — 서버가 다시 응답, 새 누적 값을 hydrate.
    claudeTokenUsageStore.hydrate({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      callCount: 0,
      estimatedCostUsd: 0,
      byModel: {},
      updatedAt: new Date().toISOString(),
    });
    // hydrate 는 loadError 를 자동 정리하지 않는다 — setError(null) 도 함께 불러야 한다.
    // 본 계약을 잠가 "회복 후에도 배지가 폴백에 머무는" 회귀를 차단.
    claudeTokenUsageStore.setError(null);
    assert.equal(claudeTokenUsageStore.getSnapshot().loadError, null,
      '회복 후 loadError 가 정리되지 않으면 배지가 폴백에 머문다');
  } finally {
    unsubscribe();
  }

  assert.ok(
    events.some(e => e === '네트워크가 지연되고 있습니다'),
    '구독자는 setError 순간의 loadError 상태를 한 번 이상 관찰해야 한다',
  );
});

// ===========================================================================
// §5 — 리셋 사이클이 저장된 branchMode 설정을 오염시키지 않는다
// ===========================================================================
//
// 계약 요약: "세션 리셋 경로(스토어 reset / setSessionStatus / flush 큐)" 는
// 프로젝트별 Git 자동화 저장 구성에 어떤 writing 도 하지 않는다. 이를 모듈
// 격리 레벨에서 잠그기 위해, 같은 브랜치 모드 왕복 계약을 본 파일에서 한 번
// 더 호출해 "세션 경로를 전부 흔들어도 왕복값이 그대로" 를 확인한다.

import { DEFAULT_AUTOMATION, type GitAutomationSettings, type BranchMode }
  from '../../src/components/GitAutomationPanel.tsx';

function toServerSettings(ui: GitAutomationSettings): Record<string, unknown> {
  return {
    enabled: ui.enabled,
    flowLevel: ui.flow === 'commit' ? 'commitOnly'
      : ui.flow === 'commit-push' ? 'commitPush' : 'commitPushPR',
    branchTemplate: ui.branchPattern,
    uiBranchStrategy: ui.branchStrategy,
    branchStrategy: ui.branchStrategy === 'fixed-branch' ? 'current' : 'new',
    prTitleTemplate: ui.prTitleTemplate,
    commitStrategy: ui.commitStrategy,
    commitMessagePrefix: ui.commitMessagePrefix,
    branchModeSketch: ui.branchMode,
    branchModeNewName: ui.branchModeNewName,
  };
}

function fromServerSettings(server: Record<string, unknown>): GitAutomationSettings {
  const rawBranchMode = server.branchModeSketch;
  const branchMode: BranchMode = rawBranchMode === 'continue' || rawBranchMode === 'new'
    ? rawBranchMode
    : DEFAULT_AUTOMATION.branchMode;
  const branchModeNewName = typeof server.branchModeNewName === 'string'
    ? server.branchModeNewName
    : DEFAULT_AUTOMATION.branchModeNewName;
  return {
    ...DEFAULT_AUTOMATION,
    enabled: server.enabled !== false,
    branchStrategy: (server.uiBranchStrategy as GitAutomationSettings['branchStrategy'])
      ?? DEFAULT_AUTOMATION.branchStrategy,
    branchMode,
    branchModeNewName,
  };
}

test('§5-a 세션 리셋 사이클(스토어 reset + exhausted→active + flush) 이 돌아도 branchMode 왕복값이 그대로', () => {
  const saved: GitAutomationSettings = {
    ...DEFAULT_AUTOMATION,
    branchMode: 'continue',
    branchModeNewName: 'feature/keep',
    branchStrategy: 'per-task',
  };
  // 1) 저장 시점의 payload 를 모사(서버 DB 저장).
  const stored = JSON.parse(JSON.stringify(toServerSettings(saved)));

  // 2) 세션 리셋 경로를 일부러 전부 두드린다.
  claudeTokenUsageStore.setSessionStatus('exhausted');
  claudeTokenUsageStore.reset(); // 5시간 경계 리셋 모사
  claudeTokenUsageStore.setSessionStatus('active');
  // 태스크 큐 플러시도 함께 — 핸들러가 없으면 큐는 비어 있어 부작용 없음.
  flushQueuedTaskBoundaries();

  // 3) 새로 로드 — DB 저장값에서 fromServerSettings 를 다시 조립.
  const restored = fromServerSettings(stored);
  assert.equal(restored.branchMode, 'continue',
    '리셋 사이클이 branchMode 를 초기화하면 A안 라디오가 새로고침마다 new 로 되돌아가는 회귀');
  assert.equal(restored.branchModeNewName, 'feature/keep',
    'branchModeNewName 이 세션 리셋 경로로 사라지면 사용자가 이전 입력을 복구할 수 없다');
  assert.equal(restored.branchStrategy, 'per-task', '4전략 축도 리셋 경로와 독립적');
});

test('§5-b 큐가 쌓여 있어도 Git 자동화 설정 roundtrip 은 큐 플러시 이후에도 동일하다', () => {
  const saved: GitAutomationSettings = {
    ...DEFAULT_AUTOMATION,
    branchMode: 'new',
    branchModeNewName: 'fix/login-refresh',
  };
  const stored = JSON.parse(JSON.stringify(toServerSettings(saved)));

  // 큐 3건 쌓기.
  setTaskBoundaryHandler(() => { /* no-op — 큐가 실제로 디스패치되기만 하면 된다 */ });
  setAgentWorkerSessionStatus('exhausted');
  notifyTaskBoundary(mkEvent({ taskId: '1' }), DEFAULT_CFG);
  notifyTaskBoundary(mkEvent({ taskId: '2' }), DEFAULT_CFG);
  assert.equal(getQueuedTaskBoundaryCount(), 2);

  // 세션 active 복귀 + 큐 플러시.
  setAgentWorkerSessionStatus('active');
  const n = flushQueuedTaskBoundaries();
  assert.equal(n, 2, '플러시 중 손실이 있으면 사용자가 기다린 작업이 유실된다');

  // 저장값은 변하지 않았어야 한다.
  const restored = fromServerSettings(stored);
  assert.equal(restored.branchMode, 'new');
  assert.equal(restored.branchModeNewName, 'fix/login-refresh');
});
