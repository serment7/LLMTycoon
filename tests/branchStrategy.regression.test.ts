// Run with: npx tsx --test tests/branchStrategy.regression.test.ts
//
// QA: 브랜치 전략(BranchStrategy) 회귀 테스트.
//
// 현재 `src/utils/gitAutomation.ts` 의 `GitAutomationConfig` 에는 `branchTemplate`
// (문자열 템플릿) 만 존재한다. 본 파일은 "브랜치를 언제 새로 만들고 언제 재사용할지"
// 를 결정하는 `BranchStrategy` 가 도입된 후의 계약을 선제적으로 잠그는 회귀 게이트
// 골격이다. 실 구현이 반영되면 본 파일의 로컬 타입 선언과 `resolveBranchForCommit`
// 시뮬레이터를 실 코드 import 로 교체한다(교체 지점은 주석으로 표시).
//
// 브랜치 UI 표시 축(`branch` 필드) 은 src/components/AgentStatusPanel.tsx:1116
// 의 푸터 렌더에서 이미 소비되므로, 본 테스트가 잠그는 "세션 단위 단일 브랜치"
// 계약은 기존 UI 에도 부드럽게 연결된다.
//
// ┌─ 시나리오 지도 ─────────────────────────────────────────────────────────────┐
// │ B1  per-session : 한 세션 다중 커밋에도 브랜치 1개                         │
// │ B2  per-task    : 동일 taskId 면 같은 브랜치 재사용                        │
// │ B3  fixed-branch: 원격에 이미 있는 브랜치도 충돌 없이 체크아웃            │
// │ B4  per-commit  : 매 커밋마다 신규 브랜치 생성                             │
// │ B5  autoMergeToMain=true : 세션 종료 시 main 으로 병합·푸시               │
// └─────────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// 로컬 타입 선언 — 실 구현이 도입되면 `../src/utils/gitAutomation.ts` 에서 import.
// ---------------------------------------------------------------------------

type BranchStrategy =
  | { kind: 'per-session' }
  | { kind: 'per-task' }
  | { kind: 'per-commit' }
  | { kind: 'fixed-branch'; fixedBranchName: string };

interface BranchDecisionInput {
  strategy: BranchStrategy;
  sessionId: string;
  taskId?: string;
  // 세션 시작을 0 으로 삼는 커밋 순번. per-commit 전략에서 브랜치 이름을 유일화하는
  // 축으로 사용된다.
  commitIndex: number;
  // per-commit 전략 또는 per-session 기본 이름 생성에 사용하는 템플릿.
  // `{session}`, `{task}`, `{index}` 토큰을 치환한다.
  template: string;
}

/**
 * 전략별 "이번 커밋이 사용할 브랜치 이름" 을 결정한다. 실제 git 명령은 부르지 않고
 * 문자열만 돌려준다. 실 구현은 `src/utils/gitAutomation.ts` 에 도입 예정.
 */
function resolveBranchForCommit(input: BranchDecisionInput): string {
  const { strategy, sessionId, taskId, commitIndex, template } = input;
  const render = (tpl: string, ctx: { session: string; task: string; index: string }): string =>
    tpl
      .replaceAll('{session}', ctx.session)
      .replaceAll('{task}', ctx.task)
      .replaceAll('{index}', ctx.index);
  switch (strategy.kind) {
    case 'per-session':
      // 세션 내내 동일한 브랜치. commitIndex 를 이름에 반영하지 않는다.
      return render(template, { session: sessionId, task: '', index: '0' });
    case 'per-task':
      // taskId 없이 호출되면 계약 위반. 세션 루프에서는 항상 taskId 를 주입해야 한다.
      if (!taskId) throw new Error('per-task 전략은 taskId 를 요구한다');
      return render(template, { session: sessionId, task: taskId, index: '0' });
    case 'per-commit':
      return render(template, { session: sessionId, task: taskId ?? '', index: String(commitIndex) });
    case 'fixed-branch':
      // 사용자가 UI 에서 명시한 브랜치 이름. 템플릿·세션·태스크는 무시한다.
      return strategy.fixedBranchName;
  }
}

// ---------------------------------------------------------------------------
// Git 저장소 fixture — src/utils/gitAutomationPipeline.test.ts:67 의
// `setupWorkAndRemote` 패턴을 그대로 차용. 로컬 bare 저장소를 원격 대역으로 쓰고,
// 워크트리 한 벌을 만들어 초기 커밋을 main 에 올린다.
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  work: string;
  remote: string;
  cleanup: () => void;
}

function sh(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function shOrThrow(cwd: string, args: string[]): string {
  const r = sh(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function setupFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'branch-strategy-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  mkdirSync(work);
  mkdirSync(remote);
  shOrThrow(remote, ['init', '--bare', '-q', '-b', 'main']);
  shOrThrow(work, ['init', '-q', '-b', 'main']);
  shOrThrow(work, ['config', 'user.email', 'qa@example.com']);
  shOrThrow(work, ['config', 'user.name', 'QA']);
  shOrThrow(work, ['config', 'commit.gpgsign', 'false']);
  shOrThrow(work, ['remote', 'add', 'origin', remote]);
  writeFileSync(join(work, 'README.md'), '# seed\n');
  shOrThrow(work, ['add', '-A']);
  shOrThrow(work, ['commit', '-q', '-m', 'init']);
  shOrThrow(work, ['push', '-u', 'origin', 'main']);
  return {
    root, work, remote,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 원격 bare 저장소의 브랜치 목록. main 을 포함한 전체. */
function remoteBranches(remote: string): string[] {
  const out = shOrThrow(remote, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  return out.split(/\r?\n/).filter(Boolean).sort();
}

function currentBranch(work: string): string {
  return shOrThrow(work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

function commitOnResolvedBranch(
  fixture: Fixture,
  branch: string,
  filePath: string,
  contents: string,
  commitMessage: string,
): void {
  // `git checkout -B <branch>` 는 이미 있는 로컬 브랜치는 그대로 붙고, 없으면 만든다.
  // 원격에만 있는 브랜치로 이동하려면 먼저 fetch 후 tracking 브랜치를 만들어야 하므로,
  // "원격에 있는지" 먼저 검사해 분기한다.
  const remoteHas = sh(fixture.work, ['ls-remote', '--exit-code', '--heads', 'origin', branch]).status === 0;
  const localHas = sh(fixture.work, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
  if (remoteHas && !localHas) {
    shOrThrow(fixture.work, ['fetch', 'origin', `${branch}:${branch}`]);
    shOrThrow(fixture.work, ['checkout', branch]);
  } else {
    shOrThrow(fixture.work, ['checkout', '-B', branch]);
  }
  writeFileSync(join(fixture.work, filePath), contents);
  shOrThrow(fixture.work, ['add', '-A']);
  shOrThrow(fixture.work, ['commit', '-q', '-m', commitMessage]);
  shOrThrow(fixture.work, ['push', '-u', 'origin', branch]);
}

// ---------------------------------------------------------------------------
// 공용 픽스처 값.
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-20260418-a';
const PER_SESSION_TEMPLATE = 'auto/{session}';
const PER_TASK_TEMPLATE = 'auto/{session}/task-{task}';
const PER_COMMIT_TEMPLATE = 'auto/{session}/c-{index}';

// ---------------------------------------------------------------------------
// 시나리오 B1 — per-session 전략: 여러 커밋이 발생해도 브랜치 1개만 유지.
// ---------------------------------------------------------------------------

test('B1 — Given per-session 전략 When 세션 내 3회 커밋 Then 원격 브랜치는 main 외 1개만 추가된다', { timeout: 30_000 }, () => {
  // Given: 깨끗한 원격 + 워크트리. per-session 전략.
  const fx = setupFixture();
  try {
    const strategy: BranchStrategy = { kind: 'per-session' };
    const decided = new Set<string>();

    // When: 세 번 연속 커밋. resolveBranchForCommit 이 돌려준 브랜치에 쓰기.
    for (let i = 0; i < 3; i++) {
      const branch = resolveBranchForCommit({
        strategy, sessionId: SESSION_ID, commitIndex: i, template: PER_SESSION_TEMPLATE,
      });
      decided.add(branch);
      commitOnResolvedBranch(fx, branch, `f${i}.txt`, `v${i}`, `feat: commit ${i}`);
    }

    // Then 1: 전략 결정 결과 자체가 유일해야 한다.
    assert.equal(decided.size, 1, 'per-session 은 세션 내내 같은 브랜치를 돌려줘야 한다');

    // Then 2: 원격 브랜치는 main + 자동 브랜치 = 2개.
    const branches = remoteBranches(fx.remote);
    assert.deepEqual(branches, ['auto/session-20260418-a', 'main']);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 시나리오 B2 — per-task 전략: 동일 taskId 이면 같은 브랜치 재사용.
// ---------------------------------------------------------------------------

test('B2 — Given per-task 전략 When 같은 taskId 로 2회 커밋 Then 같은 브랜치에 2 커밋 누적, 다른 taskId 는 별개 브랜치', { timeout: 30_000 }, () => {
  const fx = setupFixture();
  try {
    const strategy: BranchStrategy = { kind: 'per-task' };

    const b1a = resolveBranchForCommit({ strategy, sessionId: SESSION_ID, taskId: 'T-1', commitIndex: 0, template: PER_TASK_TEMPLATE });
    const b1b = resolveBranchForCommit({ strategy, sessionId: SESSION_ID, taskId: 'T-1', commitIndex: 1, template: PER_TASK_TEMPLATE });
    const b2  = resolveBranchForCommit({ strategy, sessionId: SESSION_ID, taskId: 'T-2', commitIndex: 0, template: PER_TASK_TEMPLATE });

    assert.equal(b1a, b1b, '같은 taskId 는 같은 브랜치여야 한다');
    assert.notEqual(b1a, b2, '다른 taskId 는 다른 브랜치여야 한다');

    // 실제 fixture 에서 두 커밋이 같은 브랜치에 쌓이고 push 됨을 확인.
    commitOnResolvedBranch(fx, b1a, 'T1a.txt', 'a', 'feat: T-1 step 1');
    commitOnResolvedBranch(fx, b1b, 'T1b.txt', 'b', 'feat: T-1 step 2');
    commitOnResolvedBranch(fx, b2,  'T2.txt',  'c', 'feat: T-2 step 1');

    const branches = remoteBranches(fx.remote);
    // main + T-1 브랜치 + T-2 브랜치 = 3.
    assert.equal(branches.length, 3);
    assert.ok(branches.includes(b1a), 'T-1 브랜치가 원격에 있어야 한다');
    assert.ok(branches.includes(b2),  'T-2 브랜치가 원격에 있어야 한다');

    // T-1 브랜치의 커밋 수는 초기 main 1건 + 두 번의 feat = 3건.
    const log = shOrThrow(fx.work, ['log', '--oneline', b1a]).trim().split(/\r?\n/);
    assert.equal(log.length, 3, `T-1 브랜치 커밋 수 예상=3, 실제=${log.length}`);
  } finally {
    fx.cleanup();
  }
});

test('B2 회귀 — per-task 에서 taskId 를 누락하면 결정 함수가 계약 위반으로 throw 한다', () => {
  const strategy: BranchStrategy = { kind: 'per-task' };
  assert.throws(
    () => resolveBranchForCommit({ strategy, sessionId: SESSION_ID, commitIndex: 0, template: PER_TASK_TEMPLATE }),
    /taskId/,
  );
});

// ---------------------------------------------------------------------------
// 시나리오 B3 — fixed-branch 전략: 이미 원격에 존재하는 브랜치도 충돌 없이 체크아웃.
// ---------------------------------------------------------------------------

test('B3 — Given 원격에 이미 존재하는 fixedBranchName When 세션 시작 Then 충돌 없이 체크아웃 · 후속 커밋이 해당 브랜치에 누적', { timeout: 30_000 }, () => {
  const fx = setupFixture();
  try {
    // Given: 다른 워크트리(또는 이전 세션)에서 이미 원격에 `dev` 브랜치를 생성·푸시.
    shOrThrow(fx.work, ['checkout', '-B', 'dev']);
    writeFileSync(join(fx.work, 'pre.txt'), 'pre-existing');
    shOrThrow(fx.work, ['add', '-A']);
    shOrThrow(fx.work, ['commit', '-q', '-m', 'pre-existing commit on dev']);
    shOrThrow(fx.work, ['push', '-u', 'origin', 'dev']);

    // 로컬 브랜치를 일부러 제거해 "원격에만 있는 상태" 를 재현 — fixed-branch 전략이
    // 새 세션에서 이 브랜치로 매끄럽게 복귀해야 한다는 계약을 실제로 통과시키기 위함.
    shOrThrow(fx.work, ['checkout', 'main']);
    shOrThrow(fx.work, ['branch', '-D', 'dev']);

    // When: 세션 시작 — fixed-branch 전략으로 `dev` 를 잡는다.
    const strategy: BranchStrategy = { kind: 'fixed-branch', fixedBranchName: 'dev' };
    const decided = resolveBranchForCommit({
      strategy, sessionId: SESSION_ID, commitIndex: 0, template: 'ignored/{session}',
    });
    assert.equal(decided, 'dev');

    // Then 1: checkout 이 실패 없이 붙어야 하고 후속 커밋이 dev 에 쌓여야 한다.
    commitOnResolvedBranch(fx, decided, 'new.txt', 'v2', 'feat: new change on dev');
    assert.equal(currentBranch(fx.work), 'dev');

    // Then 2: dev 브랜치에는 초기 main 1건 + 기존 pre commit 1건 + 새 커밋 1건 = 3건.
    const log = shOrThrow(fx.work, ['log', '--oneline', 'dev']).trim().split(/\r?\n/);
    assert.equal(log.length, 3, `dev 브랜치 커밋 수 예상=3, 실제=${log.length}`);

    // Then 3: 원격에도 main + dev 만 존재 — 잘못된 파생 브랜치가 생기지 않는다.
    assert.deepEqual(remoteBranches(fx.remote), ['dev', 'main']);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 시나리오 B4 — per-commit 전략: 매 커밋마다 신규 브랜치 생성.
// ---------------------------------------------------------------------------

test('B4 — Given per-commit 전략 When 세션 내 3회 커밋 Then 원격에는 매 커밋마다 별개 브랜치 3개 추가', { timeout: 30_000 }, () => {
  const fx = setupFixture();
  try {
    const strategy: BranchStrategy = { kind: 'per-commit' };
    const decided: string[] = [];

    for (let i = 0; i < 3; i++) {
      const branch = resolveBranchForCommit({
        strategy, sessionId: SESSION_ID, taskId: 'T-x', commitIndex: i, template: PER_COMMIT_TEMPLATE,
      });
      decided.push(branch);
      // 각 브랜치는 main 에서 파생되어야 의미가 있다 — 이전 브랜치에 쌓이면 시나리오 위반.
      shOrThrow(fx.work, ['checkout', 'main']);
      commitOnResolvedBranch(fx, branch, `c${i}.txt`, `v${i}`, `feat: commit ${i}`);
    }

    // Then 1: 결정된 이름들이 모두 서로 달라야 한다.
    const uniq = new Set(decided);
    assert.equal(uniq.size, 3);

    // Then 2: 원격 브랜치 = main + 3 = 4.
    const branches = remoteBranches(fx.remote);
    assert.equal(branches.length, 4, `원격 브랜치 예상=4, 실제=${branches.join(',')}`);
    for (const b of decided) {
      assert.ok(branches.includes(b), `${b} 가 원격에 존재해야 한다`);
    }
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 시나리오 B5 — autoMergeToMain=true: 세션 종료 시 main 으로 병합·푸시.
// ---------------------------------------------------------------------------

/**
 * 세션 종료 훅 시뮬레이터. 실 구현이 도입되면 `src/utils/gitAutomation.ts` 에
 * `finalizeSession({ strategy, autoMergeToMain, sessionBranch })` 로 등장할 예정.
 */
function finalizeSession(
  fixture: Fixture,
  opts: { sessionBranch: string; autoMergeToMain: boolean; baseBranch?: string },
): void {
  if (!opts.autoMergeToMain) return;
  const base = opts.baseBranch ?? 'main';
  // 세션 브랜치의 최신을 미리 원격에 반영했다고 가정 (commitOnResolvedBranch 가 push 까지 함).
  shOrThrow(fixture.work, ['checkout', base]);
  shOrThrow(fixture.work, ['pull', '--ff-only', 'origin', base]);
  // --no-ff 로 병합해 "세션 단위 머지 커밋" 이 그래프에 남도록 고정.
  shOrThrow(fixture.work, ['merge', '--no-ff', '-m', `chore: merge session ${opts.sessionBranch} to ${base}`, opts.sessionBranch]);
  shOrThrow(fixture.work, ['push', 'origin', base]);
}

test('B5 — Given autoMergeToMain=true · per-session 전략 When 2회 커밋 후 세션 종료 Then main 으로 병합되어 원격 main HEAD 가 갱신된다', { timeout: 30_000 }, () => {
  const fx = setupFixture();
  try {
    const strategy: BranchStrategy = { kind: 'per-session' };
    const sessionBranch = resolveBranchForCommit({
      strategy, sessionId: SESSION_ID, commitIndex: 0, template: PER_SESSION_TEMPLATE,
    });

    // 세션 내 2 커밋.
    commitOnResolvedBranch(fx, sessionBranch, 'a.txt', 'A', 'feat: a');
    commitOnResolvedBranch(fx, sessionBranch, 'b.txt', 'B', 'feat: b');

    const mainBeforeMerge = shOrThrow(fx.remote, ['rev-parse', 'refs/heads/main']).trim();

    // When: 세션 종료 훅 발사.
    finalizeSession(fx, { sessionBranch, autoMergeToMain: true });

    // Then 1: 원격 main 의 HEAD 가 병합으로 이동.
    const mainAfterMerge = shOrThrow(fx.remote, ['rev-parse', 'refs/heads/main']).trim();
    assert.notEqual(mainBeforeMerge, mainAfterMerge, 'main 이 병합 전후로 달라져야 한다');

    // Then 2: 원격 main 의 트리에 세션 브랜치 커밋의 파일들이 모두 포함된다.
    const mainTree = shOrThrow(fx.work, ['ls-tree', '-r', '--name-only', 'origin/main']).trim().split(/\r?\n/);
    assert.ok(mainTree.includes('a.txt'), 'a.txt 가 병합된 main 트리에 있어야 한다');
    assert.ok(mainTree.includes('b.txt'), 'b.txt 가 병합된 main 트리에 있어야 한다');

    // Then 3: 세션 브랜치는 여전히 원격에 남아 이력 추적이 가능하다(후속 강제 삭제는
    // 별도 정책).
    assert.ok(remoteBranches(fx.remote).includes(sessionBranch));

    // Then 4: main 에 찍힌 머지 커밋 메시지에 세션 식별 접두어가 포함된다.
    const mainLog = shOrThrow(fx.work, ['log', '--oneline', '-n', '1', 'origin/main']).trim();
    assert.match(mainLog, /merge session/);
  } finally {
    fx.cleanup();
  }
});

test('B5 회귀 — autoMergeToMain=false 이면 세션 종료 후에도 원격 main HEAD 가 변하지 않는다', { timeout: 30_000 }, () => {
  // 마스터 스위치가 꺼져 있으면 finalizeSession 이 no-op 이어야 한다는 계약.
  const fx = setupFixture();
  try {
    const strategy: BranchStrategy = { kind: 'per-session' };
    const sessionBranch = resolveBranchForCommit({
      strategy, sessionId: SESSION_ID, commitIndex: 0, template: PER_SESSION_TEMPLATE,
    });
    commitOnResolvedBranch(fx, sessionBranch, 'x.txt', 'X', 'feat: x');
    const before = shOrThrow(fx.remote, ['rev-parse', 'refs/heads/main']).trim();

    finalizeSession(fx, { sessionBranch, autoMergeToMain: false });

    const after = shOrThrow(fx.remote, ['rev-parse', 'refs/heads/main']).trim();
    assert.equal(before, after, 'autoMergeToMain=false 에서는 main 이 그대로여야 한다');
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 결정 함수 단독 계약 — git 없이도 확정할 수 있는 순수 함수 회귀.
// ---------------------------------------------------------------------------

test('결정 함수 — per-commit 은 commitIndex 값이 브랜치 이름에 반영된다', () => {
  const strategy: BranchStrategy = { kind: 'per-commit' };
  const a = resolveBranchForCommit({ strategy, sessionId: 's', commitIndex: 0, template: 'b/{session}/c-{index}' });
  const b = resolveBranchForCommit({ strategy, sessionId: 's', commitIndex: 1, template: 'b/{session}/c-{index}' });
  assert.equal(a, 'b/s/c-0');
  assert.equal(b, 'b/s/c-1');
  assert.notEqual(a, b);
});

test('결정 함수 — fixed-branch 는 템플릿·세션·태스크·인덱스를 모두 무시하고 fixedBranchName 을 그대로 돌려준다', () => {
  const strategy: BranchStrategy = { kind: 'fixed-branch', fixedBranchName: 'release/next' };
  const out = resolveBranchForCommit({
    strategy, sessionId: 'ignored', taskId: 'ignored', commitIndex: 99, template: 'also/ignored',
  });
  assert.equal(out, 'release/next');
});
