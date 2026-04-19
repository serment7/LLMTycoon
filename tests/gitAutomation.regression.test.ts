// Run with: npx tsx --test tests/gitAutomation.regression.test.ts
//
// QA: Git 자동화 커밋 플로우 × 재시도/하이드레이션 회귀 테스트.
//
// 본 파일은 자동 개발 루프가 돌 때 Git 커밋 파이프라인이 네 가지 지점에서
// 어떻게 동작해야 하는지를 Given/When/Then 으로 잠근다. sharedGoal.regression.test.ts
// 가 자동 개발 진입 가드(공동 목표)를 잠그는 것과 대칭으로, 여기서는 "커밋이 실제
// 발사된 이후" 의 계약을 잠근다.
//
// 우선 검토 파일:
//   · src/utils/gitAutomation.ts — buildRunPlan / summarizeRunResult /
//     buildGitAutomationLogEntries / startGitAutomationScheduler. GA1·GA3 의 단일 출처.
//   · src/server/commitMessageTemplate.ts — buildTaskBoundaryCommitMessage.
//     커밋 메시지 폴백(GA2) 의 단일 출처.
//   · src/components/ProjectManagement.tsx — loadUserPreferences /
//     saveUserPreferences. 하이드레이션 왕복(GA4) 의 단일 출처.
//
// ┌─ 시나리오 지도 ─────────────────────────────────────────────────────────┐
// │ GA1  정상 변경 → buildRunPlan 이 [checkout,add,commit,push] 를 쌓고    │
// │      모든 단계가 ok 인 결과를 summarize/로그빌더가 그대로 보존한다.    │
// │ GA2  description·changedFiles 가 비어/공백만 → 기본 템플릿 `chore:     │
// │      update` 로 폴백. formatCommitMessage 도 요약 공백 시 'update'.    │
// │ GA3  토큰 만료/네트워크 오류로 run 이 throw → 스케줄러가 재시도 한도   │
// │      도달 시 onLog 에 "재시도 한도(…)" 를 남기고 onError 를 호출한다.  │
// │ GA4  loadUserPreferences → 저장 → 재로드 왕복에서 gitAutomation 설정   │
// │      전 필드가 1:1 로 보존된다(프로젝트 스코프 키 사용 시에도).        │
// └─────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunPlan,
  summarizeRunResult,
  buildGitAutomationLogEntries,
  formatCommitMessage,
  startGitAutomationScheduler,
  type GitAutomationRunResult,
  type GitAutomationStepResult,
  type GitRunContext,
} from '../src/utils/gitAutomation.ts';
import { buildTaskBoundaryCommitMessage } from '../src/server/commitMessageTemplate.ts';
import {
  loadUserPreferences,
  saveUserPreferences,
  PROJECT_SETTINGS_KEY_PREFIX,
} from '../src/components/ProjectManagement.tsx';
import type { GitAutomationPreference, UserPreferences } from '../src/types.ts';

// ---------------------------------------------------------------------------
// 공용 픽스처
// ---------------------------------------------------------------------------

const RUN_CTX: GitRunContext = {
  workspacePath: '/tmp/ws',
  branch: 'feature/test/goal-v1',
  commitMessage: 'test: 공동 목표 가드 테스트 추가(12건 통과)',
  prTitle: 'test: 공동 목표 가드 테스트',
  prBase: 'main',
  reviewers: ['reviewer-a'],
};

const OK_STEP = (label: string, stdout?: string): GitAutomationStepResult => ({
  label, ok: true, code: 0, stdout,
  startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_500,
});

const FAIL_STEP = (label: string, stderr: string, code = 1): GitAutomationStepResult => ({
  label, ok: false, code, stderr,
  startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_750,
});

// ---------------------------------------------------------------------------
// 시나리오 GA1 — 정상 변경 → 자동 커밋 성공
// ---------------------------------------------------------------------------

test('GA1 — Given 자동화 ON·flowLevel=commitPush When buildRunPlan Then checkout·add·commit·push 4단계가 순서대로 쌓인다', () => {
  const plan = buildRunPlan(
    { enabled: true, flowLevel: 'commitPush' },
    RUN_CTX,
  );
  const labels = plan.map(s => s.label);
  assert.deepEqual(labels, ['checkout', 'add', 'commit', 'push']);
  // commit 단계에 준비된 `-m` 인자에 commitMessage 가 그대로 실려야 한다.
  const commitStep = plan.find(s => s.label === 'commit');
  assert.ok(commitStep, 'commit 단계가 쌓여야 한다');
  assert.ok(
    commitStep!.cmd.includes(RUN_CTX.commitMessage),
    'commit -m 의 뒤 인자에 RUN_CTX.commitMessage 가 그대로 들어가야 한다',
  );
  // push 는 origin + -u + branch 를 명시해야 upstream 추적이 한 번에 설정된다.
  const pushStep = plan.find(s => s.label === 'push');
  assert.ok(pushStep, 'push 단계가 쌓여야 한다');
  assert.deepEqual(
    pushStep!.cmd,
    ['git', '-C', RUN_CTX.workspacePath, 'push', '-u', 'origin', RUN_CTX.branch],
  );
});

test('GA1 — Given 전 단계 성공 결과 When summarizeRunResult·buildGitAutomationLogEntries Then commitSha 추출·pushed=true·로그 엔트리가 started/succeeded 한 쌍씩', () => {
  const commitStdout = '[feature/test/goal-v1 a1b2c3d] test: 공동 목표 가드 테스트 추가';
  const run: GitAutomationRunResult = {
    ok: true,
    results: [
      OK_STEP('checkout'),
      OK_STEP('add'),
      OK_STEP('commit', commitStdout),
      OK_STEP('push'),
    ],
    branch: RUN_CTX.branch,
    commitMessage: RUN_CTX.commitMessage,
  };

  const summary = summarizeRunResult(run);
  // commitSha 는 stdout 헤더 `[branch shortsha]` 에서 그대로 파싱된다.
  assert.equal(summary.commitSha, 'a1b2c3d');
  assert.equal(summary.pushed, true);
  assert.equal(summary.prUrl, undefined, 'PR 단계가 없었으므로 prUrl 은 undefined');

  const entries = buildGitAutomationLogEntries(run, { taskId: 't-1', agent: 'Juno' });
  const stages = entries.map(e => `${e.stage}:${e.outcome}`);
  // 준비 단계(checkout/add) 는 "성공 시에는" 로그 엔트리를 남기지 않는다는 계약.
  assert.deepEqual(stages, [
    'commit:started', 'commit:succeeded',
    'push:started',   'push:succeeded',
  ]);
  const commitSucceeded = entries.find(e => e.stage === 'commit' && e.outcome === 'succeeded');
  assert.equal(commitSucceeded?.commitSha, 'a1b2c3d', '성공 엔트리에 커밋 SHA 가 병기되어야 한다');
  assert.equal(commitSucceeded?.taskId, 't-1');
  assert.equal(commitSucceeded?.agent, 'Juno');
  assert.equal(commitSucceeded?.branch, RUN_CTX.branch);
});

// ---------------------------------------------------------------------------
// 시나리오 GA2 — 커밋 메시지 생성 실패 시 기본 템플릿 폴백
// ---------------------------------------------------------------------------

test('GA2 — Given description·changedFiles 가 빈 문자열 When buildTaskBoundaryCommitMessage Then `chore: update` 기본 템플릿으로 폴백한다', () => {
  const msg = buildTaskBoundaryCommitMessage({ description: '', changedFiles: [] });
  assert.equal(msg, 'chore: update', '빈 입력은 반드시 chore: update 로 폴백');
});

test('GA2 — Given description 이 공백·탭·개행만 When buildTaskBoundaryCommitMessage Then 동일하게 chore: update 로 폴백한다', () => {
  const msg = buildTaskBoundaryCommitMessage({
    description: '   \n\t  ',
    changedFiles: ['   ', '\n'],
  });
  assert.equal(msg, 'chore: update');
});

test('GA2 — Given prefix 가 지정되면 When buildTaskBoundaryCommitMessage Then 폴백 메시지 앞에 접두어가 공백 보정되어 붙는다', () => {
  const msg = buildTaskBoundaryCommitMessage({
    description: '',
    changedFiles: [],
    prefix: 'auto:',
  });
  // prefix 가 공백으로 끝나지 않으면 공백 한 칸을 보정해 조립한다.
  assert.equal(msg, 'auto: chore: update');
});

test('GA2 — formatCommitMessage 도 summary 가 공백이면 "update" 로 폴백한다', () => {
  // 서버 `executeGitAutomation` 이 ctxHint.summary 를 잃은 경우에도 빈 커밋 메시지가
  // 실수로 git 으로 흘러 들어가 `nothing to commit` 과 구분되지 않는 실패가 나는
  // 회귀를 막는다. 폴백 값은 "update" 단일.
  const msg = formatCommitMessage(
    { commitConvention: 'conventional', commitScope: '' },
    { type: 'chore', summary: '   ' },
  );
  assert.equal(msg, 'chore: update');
});

// ---------------------------------------------------------------------------
// 시나리오 GA3 — 토큰 만료/네트워크 오류 시 재시도 및 사용자 알림
// ---------------------------------------------------------------------------

test('GA3 — Given run 이 매번 네트워크 오류를 throw When 스케줄러가 maxRetries=2 가드로 돈다 Then onError 2회 + onLog 에 재시도 한도 도달 메시지가 남는다', async () => {
  // setInterval 을 직접 훅으로 가로채 async 콜백을 호출한다. 실 타이머에 의존하면
  // 2 ms 간격 × 2 회 시도 테스트가 CI 에서 flaky 해진다. node:test MockTimers 대신
  // 전역 스텁 방식을 쓰는 이유: scheduler 내부 `running` 가드와 async await 경계가
  // MockTimers 의 `tick` 과 상호작용할 때 microtask 드레인 순서가 보장되지 않아서.
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const capturedCbs: Array<() => unknown> = [];
  (global as unknown as { setInterval: typeof setInterval }).setInterval = ((cb: () => unknown) => {
    capturedCbs.push(cb);
    // setInterval 의 반환값은 Node 의 Timeout 객체이지만, 여기서는 clearInterval 스텁이
    // 아무 것도 하지 않으므로 값 자체는 검사하지 않는다. scheduler 는 반환값을 로컬
    // 변수로만 잡고 stop() 에서 clearInterval 에 넘긴다.
    return { __captured: true } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  (global as unknown as { clearInterval: typeof clearInterval }).clearInterval = (() => {}) as typeof clearInterval;

  try {
    const logs: string[] = [];
    const errors: unknown[] = [];
    let runCalls = 0;
    const stop = startGitAutomationScheduler({
      intervalMs: 1,
      isEnabled: () => true,
      isAgentDone: () => true,
      maxRetries: 2,
      run: async () => {
        runCalls += 1;
        // 토큰 만료 + 네트워크 오류 두 부류를 번갈아 던져, 서로 다른 실패 타입이
        // 같은 onError 경로를 탈 수 있는지(throw 의 종류를 구분하지 않는지)도 함께 잠근다.
        if (runCalls === 1) throw new Error('토큰 만료 (401 Unauthorized)');
        throw new Error('네트워크 오류 (ECONNRESET)');
      },
      onError: (e) => { errors.push(e); },
      onLog: (line) => { logs.push(line); },
    });

    // 첫 틱: idle → attempting 전이, 첫 시도 실패.
    assert.equal(capturedCbs.length, 1, 'setInterval 콜백은 한 번만 등록된다');
    await capturedCbs[0]();
    // 두 번째 틱: 두 번째 시도 실패 → attempts === maxRetries 이므로 exhausted 전이.
    await capturedCbs[0]();

    stop();

    assert.equal(runCalls, 2, 'maxRetries=2 이므로 run 은 정확히 2회 호출되어야 한다');
    assert.equal(errors.length, 2, '두 번 모두 onError 로 사용자 알림 경로가 호출되어야 한다');
    // 전이·시도·한도 도달이 한국어 로그로 사용자에게 드러나야 한다.
    assert.ok(
      logs.some(l => l.includes('done 전이 감지')),
      'rising-edge 전이가 감지됐다는 로그가 있어야 한다',
    );
    assert.ok(
      logs.some(l => l.includes('토큰 만료')),
      '첫 실패의 에러 메시지가 로그에 노출되어야 한다(사용자 알림)',
    );
    assert.ok(
      logs.some(l => /재시도 한도\(2\) 도달/.test(l)),
      '한도 도달 로그는 "재시도 한도(2) 도달" 형식으로 정확히 남아야 한다',
    );

    // 추가 틱을 흘려도(같은 done 구간) 더 이상 run 이 발사되지 않아야 한다 — exhausted.
    await capturedCbs[0]();
    assert.equal(runCalls, 2, 'exhausted 단계에서 같은 done 구간은 더 이상 재시도하지 않는다');
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

// ---------------------------------------------------------------------------
// 시나리오 GA4 — ProjectManagement 하이드레이션 직후 자동화 설정이 유지된다
// ---------------------------------------------------------------------------

// Node 환경에 window.localStorage 미니 shim. 브라우저가 없는 상황에서
// ProjectManagement 의 load/save 경로를 그대로 드라이브하기 위한 최소 구현.
function installLocalStorageShim(): () => void {
  const store = new Map<string, string>();
  const shim = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  const g = globalThis as { window?: { localStorage?: unknown } };
  const hadWindow = 'window' in g;
  const prev = hadWindow ? g.window : undefined;
  g.window = { ...(prev ?? {}), localStorage: shim } as typeof g.window;
  return () => {
    if (hadWindow) g.window = prev;
    else delete g.window;
  };
}

const FULL_AUTOMATION: GitAutomationPreference = {
  flowLevel: 'commitPushPR',
  branchTemplate: 'feature/{type}/{slug}',
  commitConvention: 'conventional',
  commitScope: 'git-auto',
  prTitleTemplate: '{type}: {summary}',
  reviewers: ['serment7', 'reviewer-b'],
};

test('GA4 — Given 프로젝트 스코프 선호값 저장 When 같은 프로젝트로 loadUserPreferences 재호출 Then gitAutomation 전 필드가 1:1 로 복원된다', () => {
  const restore = installLocalStorageShim();
  try {
    const projectId = 'proj-hydrate-1';
    const before: UserPreferences = { gitAutomation: FULL_AUTOMATION };
    saveUserPreferences(before, projectId);

    const after = loadUserPreferences(projectId);

    assert.deepEqual(after.gitAutomation, FULL_AUTOMATION,
      '하이드레이션 직후 gitAutomation 전 필드가 1:1 로 복원되어야 한다');
  } finally {
    restore();
  }
});

test('GA4 — Given A·B 두 프로젝트에 서로 다른 선호값 저장 When 각 프로젝트로 재로드 Then 서로 섞이지 않는다(프로젝트 스코프 격리)', () => {
  const restore = installLocalStorageShim();
  try {
    const prefA: UserPreferences = { gitAutomation: FULL_AUTOMATION };
    const prefB: UserPreferences = {
      gitAutomation: { ...FULL_AUTOMATION, flowLevel: 'commitOnly', reviewers: [] },
    };
    saveUserPreferences(prefA, 'proj-A');
    saveUserPreferences(prefB, 'proj-B');

    const loadedA = loadUserPreferences('proj-A');
    const loadedB = loadUserPreferences('proj-B');

    assert.equal(loadedA.gitAutomation?.flowLevel, 'commitPushPR');
    assert.deepEqual(loadedA.gitAutomation?.reviewers, ['serment7', 'reviewer-b']);
    assert.equal(loadedB.gitAutomation?.flowLevel, 'commitOnly');
    assert.deepEqual(loadedB.gitAutomation?.reviewers, []);
    // 서로 다른 프로젝트는 서로 다른 localStorage 키를 써야 한다.
    const g = globalThis as { window?: { localStorage?: { key(i: number): string | null; length: number } } };
    const ls = g.window!.localStorage!;
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (k) keys.push(k);
    }
    assert.ok(keys.includes(`${PROJECT_SETTINGS_KEY_PREFIX}:proj-A`));
    assert.ok(keys.includes(`${PROJECT_SETTINGS_KEY_PREFIX}:proj-B`));
  } finally {
    restore();
  }
});

test('GA4 — Given localStorage 에 손상된 JSON When loadUserPreferences Then 빈 객체로 안전 폴백하고 예외를 던지지 않는다', () => {
  const restore = installLocalStorageShim();
  try {
    const g = globalThis as { window?: { localStorage?: { setItem(k: string, v: string): void } } };
    const ls = g.window!.localStorage!;
    ls.setItem(`${PROJECT_SETTINGS_KEY_PREFIX}:proj-corrupt`, '{ this is : not json ]');

    const loaded = loadUserPreferences('proj-corrupt');
    assert.deepEqual(loaded, {}, '깨진 JSON 은 조용히 빈 객체로 폴백해야 한다');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 불변 계약 — 시나리오 간 상호작용: 재시도 로직이 하이드레이션·폴백 경로에
// 부작용을 남기지 않는다.
// ---------------------------------------------------------------------------

test('불변 — buildTaskBoundaryCommitMessage 는 입력을 mutate 하지 않는다(폴백·명시 경로 모두)', () => {
  const files = ['tests/a.ts', 'tests/b.ts'];
  const snapshot = files.slice();
  buildTaskBoundaryCommitMessage({ description: '', changedFiles: files });
  buildTaskBoundaryCommitMessage({ description: 'feat: x', changedFiles: files });
  assert.deepEqual(files, snapshot, 'changedFiles 배열이 mutate 되면 호출자가 공유한 리스트가 깨진다');
});
