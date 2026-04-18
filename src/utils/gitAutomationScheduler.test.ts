// Run with: npx tsx --test src/utils/gitAutomationScheduler.test.ts
//
// QA: startGitAutomationScheduler 는 gitAutomation.ts 의 유일한 "주기 실행"
// 진입점인데도 지금까지 단위 테스트가 전혀 없었다. ProjectManagement 패널이
// 마운트되는 순간 이 스케줄러가 깨어나 git 자동화를 돌리므로, isEnabled/stop/
// 동시 실행 가드 중 하나라도 깨지면 (1) UI 가 꺼져 있어도 자동 커밋이 돌거나
// (2) 느린 러너가 겹쳐 쌓여 리소스가 터지는 회귀가 즉시 발생한다.
//
// 타이머는 node:test 의 mock.timers 로 결정적으로 끌고 간다. 실시간 setInterval
// 에 기대면 CI 환경에서 "가끔 실패" 하는 플래키 테스트가 되므로, 분 단위 실 시간을
// 안 쓰고 tick 만 앞으로 밀어 같은 상태 전이를 재현한다.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { startGitAutomationScheduler } from './gitAutomation.ts';

// mock.timers 를 setInterval 에만 켰다 끈다. 각 테스트가 자기 타이머만 관리하도록
// 개별 test 안에서 enable/reset 을 호출한다.
function withMockedInterval(fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

// startGitAutomationScheduler 의 콜백은 async 라 `await opts.run()` 이후의
// `running=false` 복귀가 microtask 큐에 얹힌다. mock.timers.tick() 은 타이머만
// 즉시 실행할 뿐 microtask 를 돌리지 않으므로, 다음 tick 으로 넘어가기 전에
// 여러 번 await 해서 큐를 비워야 동시 실행 가드가 풀린다. 넉넉히 여러 회 돈다.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('isEnabled=true 면 intervalMs 마다 run 이 호출된다', withMockedInterval(async () => {
  let runCount = 0;
  const stop = startGitAutomationScheduler({
    intervalMs: 100,
    isEnabled: () => true,
    run: () => { runCount += 1; },
  });
  try {
    // 각 tick 사이에 microtask 를 비워 running=false 복귀를 확정.
    mock.timers.tick(100); await flushMicrotasks();
    mock.timers.tick(100); await flushMicrotasks();
    mock.timers.tick(100); await flushMicrotasks();
    assert.equal(runCount, 3);
  } finally {
    stop();
  }
}));

test('isEnabled=false 면 run 은 단 한 번도 호출되지 않는다', withMockedInterval(async () => {
  let runCount = 0;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => false,
    run: () => { runCount += 1; },
  });
  try {
    for (let i = 0; i < 10; i++) {
      mock.timers.tick(50);
      await flushMicrotasks();
    }
    assert.equal(runCount, 0);
  } finally {
    stop();
  }
}));

test('isEnabled 이 동적으로 바뀌면 그 시점 이후 tick 만 run 을 실행한다', withMockedInterval(async () => {
  let runCount = 0;
  let enabled = false;
  const stop = startGitAutomationScheduler({
    intervalMs: 100,
    isEnabled: () => enabled,
    run: () => { runCount += 1; },
  });
  try {
    mock.timers.tick(100); await flushMicrotasks(); // disabled
    mock.timers.tick(100); await flushMicrotasks(); // disabled
    enabled = true;
    mock.timers.tick(100); await flushMicrotasks(); // +1
    mock.timers.tick(100); await flushMicrotasks(); // +1
    assert.equal(runCount, 2);
  } finally {
    stop();
  }
}));

test('stop() 이후에는 run 이 호출되지 않는다', withMockedInterval(async () => {
  let runCount = 0;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    run: () => { runCount += 1; },
  });
  mock.timers.tick(50); await flushMicrotasks();
  stop();
  mock.timers.tick(50); await flushMicrotasks();
  mock.timers.tick(50); await flushMicrotasks();
  mock.timers.tick(50); await flushMicrotasks();
  // stop 이후 tick 은 모두 무시돼야 한다.
  assert.equal(runCount, 1);
}));

test('동시 실행 가드 — 직전 run 이 아직 진행 중이면 다음 tick 은 건너뛴다', withMockedInterval(async () => {
  // 첫 tick 에서 async run 을 오래 걸리게 하고, 그 사이 또 다른 tick 을 쏘아
  // 두 번째 호출이 "running=true 가드" 에 의해 스킵되는지 확인한다.
  let startCount = 0;
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    run: async () => {
      startCount += 1;
      // 첫 호출은 외부 신호(releaseFirst)까지 대기, 두 번째는 즉시 반환.
      if (startCount === 1) await firstDone;
    },
  });
  try {
    mock.timers.tick(50); // 1차 호출 시작, running=true 로 잠김
    await Promise.resolve();
    mock.timers.tick(50); // 2차 tick — 가드에 막혀 run 미호출
    mock.timers.tick(50); // 3차 tick — 역시 스킵
    await Promise.resolve();
    assert.equal(startCount, 1, '동시 실행 중에는 추가 run 이 발사되면 안 된다');

    // 1차 호출을 해제 → running=false 복귀 → 다음 tick 부터 다시 돈다.
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(50); // 4차 tick — 이제 재진입 가능
    await Promise.resolve();
    assert.equal(startCount, 2);
  } finally {
    stop();
  }
}));

test('run 에서 throw 가 나도 interval 은 살아 있고 onError 에 원본 에러가 전달된다', withMockedInterval(async () => {
  const errors: unknown[] = [];
  let runCount = 0;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    run: async () => {
      runCount += 1;
      if (runCount === 1) throw new Error('boom');
    },
    onError: (e) => { errors.push(e); },
  });
  try {
    mock.timers.tick(50); // 1회: throw
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(50); // 2회: 정상
    await Promise.resolve();
    assert.equal(runCount, 2, '첫 tick 의 throw 가 interval 을 죽여선 안 된다');
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'boom');
  } finally {
    stop();
  }
}));

test('onError 가 없어도 run 의 throw 는 프로세스를 죽이지 않고 다음 tick 이 돈다', withMockedInterval(async () => {
  let runCount = 0;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    run: async () => {
      runCount += 1;
      if (runCount === 1) throw new Error('silent');
    },
    // onError 의도적으로 누락 — 옵셔널이므로 호출부가 생략할 수 있다.
  });
  try {
    mock.timers.tick(50);
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(50);
    await Promise.resolve();
    assert.equal(runCount, 2);
  } finally {
    stop();
  }
}));

// ---------------------------------------------------------------------------
// 자동 개발 모드 가드 — done rising-edge 트리거, 재시도 한도, 로깅.
//
// 과거 스케줄러는 isEnabled 만 보고 매 tick 파이프라인을 돌렸다. 그 결과 에이전트가
// 아직 working/thinking 인데 토글이 켜져 있다는 이유로 commit/push/PR 이 떨어지는
// 회귀가 잠재했다. isAgentDone 옵션은 "리더가 동료의 done 을 수신한 순간" 을
// rising-edge 로만 잡아 파이프라인을 한 번 발사하도록 제한하고, 실패 시 maxRetries
// 까지만 재시도한 뒤 done 이 재전이될 때까지 조용히 대기한다. 아래 테스트는 그
// 계약을 한 파일에서 전수 고정해, 옵션을 지정하지 않은 레거시 호출부(ProjectManagement)
// 의 기존 행동이 깨지지 않는지까지 함께 확인한다.
// ---------------------------------------------------------------------------

test('guard: isAgentDone=false 면 done 전이가 없을 때까지 run 은 절대 호출되지 않는다', withMockedInterval(async () => {
  let runCount = 0;
  const logs: string[] = [];
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    isAgentDone: () => false,
    run: () => { runCount += 1; },
    onLog: (line) => { logs.push(line); },
  });
  try {
    for (let i = 0; i < 5; i++) {
      mock.timers.tick(50);
      await flushMicrotasks();
    }
    assert.equal(runCount, 0, 'done=false 인데 run 이 발사됐다');
    assert.equal(logs.length, 0, 'done 전이 전이라 onLog 도 조용해야 한다');
  } finally {
    stop();
  }
}));

test('guard: done 이 false→true 로 전이한 첫 tick 에 한 번만 run 이 발사되고 이후 구간은 스킵한다', withMockedInterval(async () => {
  let runCount = 0;
  let done = false;
  const logs: string[] = [];
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    isAgentDone: () => done,
    run: () => { runCount += 1; },
    onLog: (line) => { logs.push(line); },
  });
  try {
    mock.timers.tick(50); await flushMicrotasks(); // done=false → no run
    mock.timers.tick(50); await flushMicrotasks(); // done=false → no run
    assert.equal(runCount, 0);

    done = true;
    mock.timers.tick(50); await flushMicrotasks(); // rising edge → run 1회
    mock.timers.tick(50); await flushMicrotasks(); // satisfied → 스킵
    mock.timers.tick(50); await flushMicrotasks(); // satisfied → 스킵
    assert.equal(runCount, 1, 'done 이 유지되는 동안 run 이 재발사됐다');
    // 로그에는 "개시" + "성공" 두 줄이 있어야 한다(정확 문구는 구현 상수와 결합되므로 substring 매치).
    assert.ok(logs.some(l => l.includes('done 전이 감지')), '개시 로그가 누락');
    assert.ok(logs.some(l => l.includes('트리거 성공')), '성공 로그가 누락');
  } finally {
    stop();
  }
}));

test('guard: done 이 true→false→true 로 다시 전이하면 run 이 재발사된다', withMockedInterval(async () => {
  let runCount = 0;
  let done = true;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    isAgentDone: () => done,
    run: () => { runCount += 1; },
  });
  try {
    mock.timers.tick(50); await flushMicrotasks(); // idle→attempting: run 1회
    assert.equal(runCount, 1);

    done = false;
    mock.timers.tick(50); await flushMicrotasks(); // satisfied→idle (재전이 대기)
    done = true;
    mock.timers.tick(50); await flushMicrotasks(); // 새 사이클: run 1회
    assert.equal(runCount, 2, 'done 재전이 후 새 사이클이 발사되지 않았다');
  } finally {
    stop();
  }
}));

test('retry: run 이 실패하면 maxRetries 까지 같은 done 구간에서 재시도하고 상한 초과 시 중단한다', withMockedInterval(async () => {
  const logs: string[] = [];
  let attempt = 0;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    isAgentDone: () => true,
    maxRetries: 3,
    run: async () => {
      attempt += 1;
      throw new Error(`try-${attempt}`);
    },
    onLog: (line) => { logs.push(line); },
    // onError 는 의도적으로 생략 — 옵션 누락이어도 maxRetries 경로가 살아있어야 한다.
  });
  try {
    // attempts=1 (실패), 2 (실패), 3 (실패) → exhausted. 이후 tick 은 전부 스킵.
    for (let i = 0; i < 8; i++) {
      mock.timers.tick(50);
      await flushMicrotasks();
    }
    assert.equal(attempt, 3, 'maxRetries=3 인데 시도 횟수가 초과/미달');
    // 실패 로그는 3/3 까지 정확히 찍혀야 하고, 한도 도달 로그도 1회 존재.
    const failureLogs = logs.filter(l => l.includes('트리거 실패'));
    assert.equal(failureLogs.length, 3, '실패 로그가 시도 횟수와 일치하지 않음');
    assert.ok(failureLogs[0].includes('1/3'), '첫 실패 로그에 시도/한도 표기 누락');
    assert.ok(failureLogs[2].includes('3/3'), '마지막 실패 로그에 한도 표기 누락');
    const exhaustionLogs = logs.filter(l => l.includes('재시도 한도(3) 도달'));
    assert.equal(exhaustionLogs.length, 1, '재시도 한도 도달 로그는 정확히 1회만');
  } finally {
    stop();
  }
}));

test('retry: 실패하다가 성공하면 그 시점에 satisfied 로 고정되고 이후 tick 은 추가 발사되지 않는다', withMockedInterval(async () => {
  const logs: string[] = [];
  let attempt = 0;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    isAgentDone: () => true,
    maxRetries: 5,
    run: async () => {
      attempt += 1;
      if (attempt < 2) throw new Error('flaky');
    },
    onLog: (line) => { logs.push(line); },
  });
  try {
    mock.timers.tick(50); await flushMicrotasks(); // attempt 1: 실패
    mock.timers.tick(50); await flushMicrotasks(); // attempt 2: 성공 → satisfied
    mock.timers.tick(50); await flushMicrotasks(); // satisfied: 스킵
    mock.timers.tick(50); await flushMicrotasks(); // satisfied: 스킵
    assert.equal(attempt, 2, '성공 이후에도 run 이 추가 발사됐다');
    const successLogs = logs.filter(l => l.includes('트리거 성공'));
    assert.equal(successLogs.length, 1);
    assert.ok(successLogs[0].includes('2회 시도'), '성공 로그에 누적 시도 횟수가 빠졌다');
  } finally {
    stop();
  }
}));

test('retry: 한도 초과 후에도 done 이 false→true 로 재전이하면 시도 카운터가 리셋된다', withMockedInterval(async () => {
  let attempt = 0;
  let done = true;
  let shouldFail = true;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    isAgentDone: () => done,
    maxRetries: 2,
    run: async () => {
      attempt += 1;
      if (shouldFail) throw new Error('boom');
    },
  });
  try {
    mock.timers.tick(50); await flushMicrotasks(); // 1 실패
    mock.timers.tick(50); await flushMicrotasks(); // 2 실패 → exhausted
    mock.timers.tick(50); await flushMicrotasks(); // 스킵
    assert.equal(attempt, 2);

    // 사용자가 수정 후 에이전트가 working 으로 돌아갔다가 다시 done 을 보고.
    done = false;
    mock.timers.tick(50); await flushMicrotasks(); // idle 복귀
    done = true;
    shouldFail = false;
    mock.timers.tick(50); await flushMicrotasks(); // 새 사이클 — 성공
    assert.equal(attempt, 3, '재전이 후 새 사이클이 시작되지 않았다');
  } finally {
    stop();
  }
}));

test('guard: isEnabled 가 false 로 떨어지면 가드 상태기가 idle 로 리셋되어 재활성화 시 다음 done 을 새 사이클로 잡는다', withMockedInterval(async () => {
  let runCount = 0;
  let enabled = true;
  let done = true;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => enabled,
    isAgentDone: () => done,
    run: () => { runCount += 1; },
  });
  try {
    mock.timers.tick(50); await flushMicrotasks(); // satisfied
    assert.equal(runCount, 1);

    // 토글 off → 상태기가 idle 로 리셋돼야 한다.
    enabled = false;
    mock.timers.tick(50); await flushMicrotasks();
    mock.timers.tick(50); await flushMicrotasks();

    // 토글 on — done 은 그대로 true 였더라도 상태기가 idle 로 돌아왔으므로 새 사이클.
    enabled = true;
    mock.timers.tick(50); await flushMicrotasks();
    assert.equal(runCount, 2, '토글 재활성화 후 새 사이클이 발사되지 않았다');
  } finally {
    stop();
  }
}));

test('backcompat: isAgentDone 를 지정하지 않으면 레거시 경로(레벨 기반 매 tick 실행)가 그대로 유지된다', withMockedInterval(async () => {
  // ProjectManagement 의 기존 호출부가 가드 옵션을 주지 않은 채로 계속 돌 수 있도록,
  // isAgentDone 누락 시 새 상태기 로직은 완전히 우회돼야 한다. maxRetries 도 무시된다.
  let runCount = 0;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => true,
    maxRetries: 1, // 레거시 경로에서는 무시된다.
    run: () => { runCount += 1; },
  });
  try {
    for (let i = 0; i < 4; i++) {
      mock.timers.tick(50);
      await flushMicrotasks();
    }
    assert.equal(runCount, 4, '레거시 호출부에서 매 tick 실행이 깨졌다');
  } finally {
    stop();
  }
}));

// ---------------------------------------------------------------------------
// MCP 초기 설정 반영 — 리더가 get_git_automation_settings 를 비동기로 받아오는 동안
// 스케줄러는 이미 tick 을 시작한 상태일 수 있다. 설정이 비어 있던 초반 tick 은
// 반드시 건너뛰고, 응답이 들어온 순간 그 값에 맞춰 첫 실행/차단이 이뤄져야 한다.
// ---------------------------------------------------------------------------

// MCP 응답을 비동기로 수신하는 상황을 흉내내는 경량 스토어. fetch 전에는 null,
// fetch 후에는 서버 응답을 그대로 쥐고 있다. 실제 리더/ProjectManagement 의
// 동작과 같은 "null → 값" 전이를 단일 변수로 단순화해, 스케줄러 관점의 계약만
// 남긴다.
interface McpFakeSettings {
  enabled: boolean;
  flowLevel: 'commitOnly' | 'commitPush' | 'commitPushPR';
}
function makeMcpFetch(initial: McpFakeSettings | null) {
  let current = initial;
  return {
    get: () => current,
    resolve: (next: McpFakeSettings) => { current = next; },
  };
}

test('MCP 수신 직후: enabled=false 로 늦게 들어온 응답은 첫 tick 부터 run 을 즉시 차단한다', withMockedInterval(async () => {
  // 초기엔 설정이 아직 도착하지 않아 null. 스케줄러는 isEnabled=false 로 간주해
  // 침묵해야 한다. 이후 MCP 응답이 enabled=false 로 도착하면, 이후에도 run 은
  // 단 한 번도 호출되지 않아야 한다 — "로드 성공했다" 는 타임라인 이벤트만으로
  // 커밋이 실수로 나가는 회귀를 막는다.
  let runCount = 0;
  const store = makeMcpFetch(null);
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    // 프로덕션 호출부가 실제로 하는 파생식: 설정이 로드됐고 enabled=true 일 때만 실행.
    isEnabled: () => !!store.get() && store.get()!.enabled,
    run: () => { runCount += 1; },
  });
  try {
    mock.timers.tick(50); await flushMicrotasks(); // 설정 아직 null — 스킵
    mock.timers.tick(50); await flushMicrotasks(); // 스킵
    assert.equal(runCount, 0);

    store.resolve({ enabled: false, flowLevel: 'commitPushPR' });
    for (let i = 0; i < 5; i++) {
      mock.timers.tick(50);
      await flushMicrotasks();
    }
    assert.equal(runCount, 0, 'enabled=false 응답 수신 후에도 run 이 호출되면 안 된다');
  } finally {
    stop();
  }
}));

test('MCP 수신 직후: enabled=true 로 들어온 응답은 해당 tick 부터 즉시 run 을 발사한다', withMockedInterval(async () => {
  // 초기 null → enabled=true 로 채워지는 정방향 케이스. 응답이 들어온 직후 첫
  // tick 에 바로 run 이 호출되어야 한다. "뒤늦게 도착한 설정이 다음 tick 에 아예
  // 반영되지 않는" 종류의 캐시 버그를 여기서 잡는다.
  let runCount = 0;
  const store = makeMcpFetch(null);
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => !!store.get() && store.get()!.enabled,
    run: () => { runCount += 1; },
  });
  try {
    mock.timers.tick(50); await flushMicrotasks(); // null — 스킵
    assert.equal(runCount, 0);

    store.resolve({ enabled: true, flowLevel: 'commitPush' });
    mock.timers.tick(50); await flushMicrotasks(); // 여기서 첫 발사
    assert.equal(runCount, 1, 'MCP 응답 직후 첫 tick 에 발사되지 않았다');
    mock.timers.tick(50); await flushMicrotasks();
    assert.equal(runCount, 2, '이후 tick 도 계속 발사되어야 한다');
  } finally {
    stop();
  }
}));

test('MCP 수신 직후: enabled=true 로 시작해 false 로 재수신되면 이후 tick 부터 run 이 멈춘다', withMockedInterval(async () => {
  // 사용자가 UI 에서 OFF 로 바꾸면 서버가 git-automation:updated 로 재송신한다.
  // 스케줄러는 그 시점부터 즉시 멈춰야 하며, 이미 러닝 중이지 않은 한 진행 중이던
  // 주기 호출이 "한 번 더" 새어 나가면 안 된다.
  let runCount = 0;
  const store = makeMcpFetch({ enabled: true, flowLevel: 'commitPush' });
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => !!store.get() && store.get()!.enabled,
    run: () => { runCount += 1; },
  });
  try {
    mock.timers.tick(50); await flushMicrotasks();
    mock.timers.tick(50); await flushMicrotasks();
    assert.equal(runCount, 2);

    store.resolve({ enabled: false, flowLevel: 'commitPush' });
    for (let i = 0; i < 4; i++) {
      mock.timers.tick(50);
      await flushMicrotasks();
    }
    assert.equal(runCount, 2, 'enabled 가 false 로 뒤집힌 뒤에도 run 이 추가 발사됐다');
  } finally {
    stop();
  }
}));

test('MCP 초기 수신 + done 가드 조합: settings 가 채워지고 done 이 true 가 되는 첫 tick 에 한 번만 발사', withMockedInterval(async () => {
  // 현실적인 조합: enabled 가 null → true 로 전이하고 거의 동시에 done 가드도
  // false → true 로 전이. 이 두 조건이 같은 tick 에 동시에 만족됐을 때 run 이
  // 정확히 한 번만 발사돼야 한다. isEnabled 와 isAgentDone 가 독립적으로 판정될
  // 때 "둘 중 한 쪽이 늦게 반영돼 첫 발사를 놓치는" 회귀를 차단한다.
  let runCount = 0;
  const store = makeMcpFetch(null);
  let done = false;
  const stop = startGitAutomationScheduler({
    intervalMs: 50,
    isEnabled: () => !!store.get() && store.get()!.enabled,
    isAgentDone: () => done,
    run: () => { runCount += 1; },
  });
  try {
    mock.timers.tick(50); await flushMicrotasks(); // 전부 false — 스킵
    store.resolve({ enabled: true, flowLevel: 'commitPush' });
    done = true;
    mock.timers.tick(50); await flushMicrotasks(); // 양쪽 조건 만족 — 1회 발사
    mock.timers.tick(50); await flushMicrotasks(); // done 지속 — satisfied, 재발사 없음
    assert.equal(runCount, 1, '초기 수신 tick 에 정확히 한 번만 발사되어야 한다');
  } finally {
    stop();
  }
}));
