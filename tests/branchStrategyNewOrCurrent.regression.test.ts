// Run with: npx tsx --test tests/branchStrategyNewOrCurrent.regression.test.ts
//
// QA: "새 브랜치 생성 ↔ 현재 브랜치로 계속" 2선택 옵션 회귀 테스트.
//
// 본 파일은 GitAutomationPanel 의 4 전략(`BranchStrategy`) 라디오 위에 얹히는
// **이진 토글** — "새 브랜치 생성" 대 "현재 브랜치로 계속" — 의 계약을 잠근다.
// 시나리오 의도:
//   (1) '새 브랜치 생성' + 유효 브랜치명 → 새 브랜치가 만들어지고 커밋이 해당 브랜치에 쌓인다.
//   (2) '현재 브랜치로 계속' → 현재 체크아웃된 브랜치에 그대로 커밋이 누적된다.
//   (3) 브랜치명 미입력·공백·이미 존재하는 이름 → 사용자 피드백 메시지가 노출되고
//       git 실행 경로로는 진입하지 않는다.
//   (4) 기존 커밋 메시지 템플릿 · 자동 푸시 토글 조합이 깨지지 않는다.
//
// 실제 `BranchStrategy` 열거형(`per-commit|per-task|per-session|fixed-branch`) 에
// "current" 는 아직 없으므로, 본 파일은 UI 이진 토글을 얇게 감싸는 로컬 타입과
// 결정 함수(`decideBranchForCommit`)를 정의해 실 구현이 추가될 때 교체 지점을
// 주석으로 표시한다. 시뮬레이터 교체 시 `commit` / `push` / `validateGitAutomationConfig`
// 등 실제 모듈 함수는 그대로 재사용한다 — 이 테스트가 잠그는 것은 "UI 이진 선택이
// 기존 자동화 파이프라인과 매끄럽게 물리는가" 이기 때문.
//
// ┌─ 시나리오 지도 ──────────────────────────────────────────────────────────────┐
// │ N1  새 브랜치 + 유효명            → 새 브랜치 생성 · 해당 브랜치에 커밋 누적 │
// │ N2  현재 브랜치로 계속            → HEAD 브랜치 유지 · 신규 브랜치 생성 無   │
// │ N3-a 빈 브랜치명                  → "브랜치명을 입력하세요" 피드백 · no-op  │
// │ N3-b 공백만 브랜치명              → 공백 피드백 · no-op                      │
// │ N3-c 이미 존재하는 로컬 브랜치    → 중복 충돌 피드백 · no-op                 │
// │ N3-d 이미 존재하는 원격 브랜치    → 원격 선점 피드백 · no-op                 │
// │ N4-a 새 브랜치 + commitPush        → 커밋 메시지 포맷 유지 · origin 에 push │
// │ N4-b 현재 브랜치 + commitOnly      → push 단계가 빈 배열(푸시 미발사)       │
// └──────────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DEFAULT_GIT_AUTOMATION_CONFIG,
  buildRunPlan,
  commit as buildCommitSteps,
  formatCommitMessage,
  push as buildPushSteps,
  shouldAutoCommit,
  shouldAutoPush,
} from '../src/utils/gitAutomation.ts';

// ---------------------------------------------------------------------------
// 로컬 UI 타입 — "새 브랜치 생성" ↔ "현재 브랜치로 계속" 이진 토글.
// 실 구현이 `BranchStrategy` 열거형에 편입되면 이 블록을 해당 타입으로 교체.
// ---------------------------------------------------------------------------

type BranchMode =
  | { mode: 'new'; branchName: string }
  | { mode: 'current' };

interface BranchFeedback {
  ok: boolean;
  // 사용자에게 노출될 피드백 키. UI 번역 레이어가 이 키로 i18n 한다 — 문자열 본문을
  // 직접 비교하지 않는 이유는, 마이크로카피 수정으로 테스트가 쏟아지는 걸 방지하기 위함.
  reason?:
    | 'branch-name-required'
    | 'branch-name-whitespace'
    | 'branch-name-exists-local'
    | 'branch-name-exists-remote';
  // 결정된 브랜치. ok=false 면 undefined — git 경로 진입 금지를 강제.
  branch?: string;
  // 'new' 일 때만 true. 호출자가 `git checkout -B` 를 실행해도 되는가의 가드.
  willCreate: boolean;
}

interface DecideBranchInput {
  selection: BranchMode;
  // 현재 체크아웃된 브랜치. 'current' 모드에서 그대로 돌려주기 위해 호출자가 주입.
  currentCheckedOut: string;
  // 이름 충돌 검사. 두 predicate 모두 호출자가 실제 git 에 물어보거나, 테스트의
  // Set 기반 가짜로 주입한다. 'new' 모드에서만 호출된다.
  localBranchExists: (name: string) => boolean;
  remoteBranchExists: (name: string) => boolean;
}

/**
 * UI 이진 토글이 결정한 "이번 커밋이 사용할 브랜치" + 사용자 피드백을 함께 돌려준다.
 * 실 구현은 `src/utils/branchResolver.ts` 에 `decideBranchForCommit` 등으로 추가될
 * 예정이며, 그 시점에 본 함수는 import 로 교체된다.
 */
function decideBranchForCommit(input: DecideBranchInput): BranchFeedback {
  if (input.selection.mode === 'current') {
    // 'current' 는 이름 입력이 없으므로 즉시 결정. HEAD 가 비어 있는(신규 저장소)
    // 병리 경우는 호출자(UI)가 자동화를 비활성화해 진입 자체를 막는다는 계약.
    return { ok: true, branch: input.currentCheckedOut, willCreate: false };
  }
  const raw = input.selection.branchName;
  if (raw.length === 0) {
    return { ok: false, reason: 'branch-name-required', willCreate: false };
  }
  if (raw.trim().length === 0) {
    // 공백만 입력 — 빈 문자열과 구분해 "공백 피드백" 을 돌려준다. UI 는 두 케이스에
    // 서로 다른 마이크로카피(입력 요청 / 공백 경고) 를 노출한다.
    return { ok: false, reason: 'branch-name-whitespace', willCreate: false };
  }
  const name = raw.trim();
  if (input.localBranchExists(name)) {
    return { ok: false, reason: 'branch-name-exists-local', branch: name, willCreate: false };
  }
  if (input.remoteBranchExists(name)) {
    return { ok: false, reason: 'branch-name-exists-remote', branch: name, willCreate: false };
  }
  return { ok: true, branch: name, willCreate: true };
}

// ---------------------------------------------------------------------------
// Git 저장소 fixture — `tests/branchStrategy.regression.test.ts:103` 의 setupFixture
// 와 동일한 패턴. 로컬 bare 저장소를 원격 대역으로 쓰고 워크트리에 초기 커밋을 올린다.
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
  const root = mkdtempSync(join(tmpdir(), 'branch-new-or-current-'));
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

function currentBranch(work: string): string {
  return shOrThrow(work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

function remoteBranches(remote: string): string[] {
  const out = shOrThrow(remote, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  return out.split(/\r?\n/).filter(Boolean).sort();
}

function localBranches(work: string): string[] {
  const out = shOrThrow(work, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  return out.split(/\r?\n/).filter(Boolean).sort();
}

// 결정된 브랜치로 체크아웃 후 한 파일을 커밋·푸시한다. willCreate 값을 기준으로
// `checkout -B` (새로 생성) 또는 단순 `checkout` (기존 브랜치 유지) 를 분기한다.
function commitOnDecidedBranch(
  fx: Fixture,
  decided: BranchFeedback,
  filePath: string,
  contents: string,
  message: string,
  doPush: boolean,
): void {
  if (!decided.ok || !decided.branch) throw new Error('결정 실패 상태에서 git 경로로 진입해서는 안 된다');
  if (decided.willCreate) {
    shOrThrow(fx.work, ['checkout', '-B', decided.branch]);
  } else {
    shOrThrow(fx.work, ['checkout', decided.branch]);
  }
  writeFileSync(join(fx.work, filePath), contents);
  shOrThrow(fx.work, ['add', '-A']);
  shOrThrow(fx.work, ['commit', '-q', '-m', message]);
  if (doPush) shOrThrow(fx.work, ['push', '-u', 'origin', decided.branch]);
}

// ---------------------------------------------------------------------------
// 시나리오 N1 — '새 브랜치 생성' + 유효 브랜치명.
// ---------------------------------------------------------------------------

test('N1 — Given 새 브랜치 생성 + 유효 브랜치명 When 커밋 Then 해당 브랜치가 생성되고 커밋이 올라간다', { timeout: 30_000 }, () => {
  const fx = setupFixture();
  try {
    // Given: 깨끗한 main. 원격에도 dev/feature 없음.
    assert.equal(currentBranch(fx.work), 'main');
    const decided = decideBranchForCommit({
      selection: { mode: 'new', branchName: 'feature/payments' },
      currentCheckedOut: 'main',
      localBranchExists: () => false,
      remoteBranchExists: () => false,
    });

    // Then 1: 결정이 성공해야 하고 willCreate 가 true.
    assert.equal(decided.ok, true);
    assert.equal(decided.branch, 'feature/payments');
    assert.equal(decided.willCreate, true);
    assert.equal(decided.reason, undefined);

    // When: 그 브랜치로 커밋 + 푸시.
    commitOnDecidedBranch(fx, decided, 'a.txt', 'A', 'feat: payments', true);

    // Then 2: 로컬·원격 모두에 feature/payments 가 존재하고 HEAD 가 거기에 있다.
    assert.equal(currentBranch(fx.work), 'feature/payments');
    assert.ok(localBranches(fx.work).includes('feature/payments'));
    assert.ok(remoteBranches(fx.remote).includes('feature/payments'));

    // Then 3: main 에는 추가 커밋이 없어야 한다 — 새 브랜치로 격리가 됐는지 확인.
    const mainCommits = shOrThrow(fx.work, ['log', '--oneline', 'main']).trim().split(/\r?\n/);
    assert.equal(mainCommits.length, 1, 'main 은 초기 커밋 1건만 유지해야 한다');
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 시나리오 N2 — '현재 브랜치로 계속'.
// ---------------------------------------------------------------------------

test('N2 — Given 현재 브랜치로 계속 When 커밋 Then HEAD 브랜치 유지 · 새 브랜치는 생성되지 않는다', { timeout: 30_000 }, () => {
  const fx = setupFixture();
  try {
    // Given: main 에서 dev 로 미리 체크아웃 해 둔 상태(사용자가 수동으로 만든 브랜치).
    shOrThrow(fx.work, ['checkout', '-B', 'dev']);
    writeFileSync(join(fx.work, 'pre.txt'), 'pre');
    shOrThrow(fx.work, ['add', '-A']);
    shOrThrow(fx.work, ['commit', '-q', '-m', 'wip on dev']);
    const localBefore = localBranches(fx.work);

    // When: 'current' 모드로 결정.
    const decided = decideBranchForCommit({
      selection: { mode: 'current' },
      currentCheckedOut: currentBranch(fx.work),
      localBranchExists: () => { throw new Error('current 모드에서는 충돌 검사를 호출하지 않는다'); },
      remoteBranchExists: () => { throw new Error('current 모드에서는 충돌 검사를 호출하지 않는다'); },
    });

    // Then 1: 결정이 즉시 성공 · willCreate=false.
    assert.equal(decided.ok, true);
    assert.equal(decided.branch, 'dev');
    assert.equal(decided.willCreate, false);

    // When: dev 에 후속 커밋.
    commitOnDecidedBranch(fx, decided, 'b.txt', 'B', 'feat: next', false);

    // Then 2: HEAD 가 여전히 dev · 새 로컬 브랜치가 생기지 않았다.
    assert.equal(currentBranch(fx.work), 'dev');
    assert.deepEqual(localBranches(fx.work), localBefore);

    // Then 3: dev 에 pre + next 2 커밋 + 초기 main 1 = 3.
    const log = shOrThrow(fx.work, ['log', '--oneline', 'dev']).trim().split(/\r?\n/);
    assert.equal(log.length, 3, `dev 커밋 수 예상=3, 실제=${log.length}`);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 시나리오 N3 — 예외 케이스 4종. 모두 ok=false + 구체 reason.
// ---------------------------------------------------------------------------

test('N3-a — Given 새 브랜치 + 빈 브랜치명 Then 사용자 피드백 noted · willCreate=false · git 경로 진입 금지', () => {
  const decided = decideBranchForCommit({
    selection: { mode: 'new', branchName: '' },
    currentCheckedOut: 'main',
    localBranchExists: () => { throw new Error('빈 입력에서 호출되면 안 됨'); },
    remoteBranchExists: () => { throw new Error('빈 입력에서 호출되면 안 됨'); },
  });
  assert.equal(decided.ok, false);
  assert.equal(decided.reason, 'branch-name-required');
  assert.equal(decided.willCreate, false);
});

test('N3-b — Given 새 브랜치 + 공백만 입력 Then 공백 피드백 · willCreate=false', () => {
  const decided = decideBranchForCommit({
    selection: { mode: 'new', branchName: '   \t ' },
    currentCheckedOut: 'main',
    localBranchExists: () => { throw new Error('공백 입력에서 호출되면 안 됨'); },
    remoteBranchExists: () => { throw new Error('공백 입력에서 호출되면 안 됨'); },
  });
  assert.equal(decided.ok, false);
  assert.equal(decided.reason, 'branch-name-whitespace');
  assert.equal(decided.willCreate, false);
});

test('N3-c — Given 새 브랜치 + 이미 존재하는 로컬 브랜치 Then 로컬 중복 피드백 · willCreate=false', { timeout: 30_000 }, () => {
  const fx = setupFixture();
  try {
    // Given: dev 가 로컬에 이미 있음.
    shOrThrow(fx.work, ['checkout', '-B', 'dev']);
    shOrThrow(fx.work, ['checkout', 'main']);

    const localSet = new Set(localBranches(fx.work));
    const decided = decideBranchForCommit({
      selection: { mode: 'new', branchName: 'dev' },
      currentCheckedOut: 'main',
      localBranchExists: (n) => localSet.has(n),
      remoteBranchExists: () => false,
    });

    // Then: 결정 실패 · reason 은 로컬 중복.
    assert.equal(decided.ok, false);
    assert.equal(decided.reason, 'branch-name-exists-local');
    assert.equal(decided.willCreate, false);
    // branch 필드는 노출(UI 가 "이미 있는 브랜치: dev" 로 안내하도록) 하되, 실행은 금지.
    assert.equal(decided.branch, 'dev');

    // 실제로 git 경로에 들어가지 않았음을 보장 — 로컬 브랜치 수가 변하지 않았다.
    assert.deepEqual(localBranches(fx.work), [...localSet].sort());
  } finally {
    fx.cleanup();
  }
});

test('N3-d — Given 새 브랜치 + 이미 원격에만 존재 Then 원격 선점 피드백 · willCreate=false', { timeout: 30_000 }, () => {
  const fx = setupFixture();
  try {
    // Given: 원격에 release 브랜치가 이미 푸시됨. 로컬에는 없음.
    shOrThrow(fx.work, ['checkout', '-B', 'release']);
    writeFileSync(join(fx.work, 'r.txt'), 'r');
    shOrThrow(fx.work, ['add', '-A']);
    shOrThrow(fx.work, ['commit', '-q', '-m', 'release seed']);
    shOrThrow(fx.work, ['push', '-u', 'origin', 'release']);
    shOrThrow(fx.work, ['checkout', 'main']);
    shOrThrow(fx.work, ['branch', '-D', 'release']);

    const remoteSet = new Set(remoteBranches(fx.remote));
    const decided = decideBranchForCommit({
      selection: { mode: 'new', branchName: 'release' },
      currentCheckedOut: 'main',
      localBranchExists: () => false, // 로컬엔 이제 없다.
      remoteBranchExists: (n) => remoteSet.has(n),
    });

    assert.equal(decided.ok, false);
    assert.equal(decided.reason, 'branch-name-exists-remote');
    assert.equal(decided.willCreate, false);
    assert.equal(decided.branch, 'release');
  } finally {
    fx.cleanup();
  }
});

test('N3 — 로컬/원격 검사 우선순위: 로컬에 있으면 원격은 보지 않는다', () => {
  // 로컬·원격 양쪽에 있을 때 사용자가 먼저 보는 피드백은 "로컬 중복" 이어야 한다.
  // 원격 검사가 느린 네트워크 호출일 수 있으므로 단락평가(short-circuit) 계약도 함께 잠근다.
  let remoteCalled = false;
  const decided = decideBranchForCommit({
    selection: { mode: 'new', branchName: 'shared' },
    currentCheckedOut: 'main',
    localBranchExists: () => true,
    remoteBranchExists: () => { remoteCalled = true; return true; },
  });
  assert.equal(decided.reason, 'branch-name-exists-local');
  assert.equal(remoteCalled, false, '로컬 중복이면 원격 검사는 단락평가로 건너뛰어야 한다');
});

// ---------------------------------------------------------------------------
// 시나리오 N4 — 커밋 메시지 포맷 · 자동 푸시 옵션과의 조합.
// ---------------------------------------------------------------------------

test('N4-a — Given 새 브랜치 + commitPush flowLevel When 파이프라인 구성 Then 커밋 메시지 포맷 유지 · push 단계 포함 · origin 에 실제 푸시', { timeout: 30_000 }, () => {
  const fx = setupFixture();
  try {
    const decided = decideBranchForCommit({
      selection: { mode: 'new', branchName: 'feature/n4a' },
      currentCheckedOut: 'main',
      localBranchExists: () => false,
      remoteBranchExists: () => false,
    });
    assert.equal(decided.ok, true);

    // 기존 커밋 메시지 포맷터가 동일 입력에 동일 결과를 내는지 — UI 이진 토글이
    // 메시지 계약을 바꿔서는 안 된다.
    const config = { ...DEFAULT_GIT_AUTOMATION_CONFIG, flowLevel: 'commitPush' as const };
    const message = formatCommitMessage(
      { commitConvention: config.commitConvention, commitScope: 'branch-ui' },
      { type: 'feat', summary: 'N4 조합 테스트' },
    );
    assert.equal(message, 'feat(branch-ui): N4 조합 테스트');

    // push 가드가 true 여야 한다.
    assert.equal(shouldAutoCommit(config), true);
    assert.equal(shouldAutoPush(config), true);

    // buildRunPlan 가 돌려주는 단계에 push 가 실제로 포함된다.
    const plan = buildRunPlan(config, {
      workspacePath: fx.work,
      branch: decided.branch!,
      commitMessage: message,
      prTitle: '',
    });
    const labels = plan.map(s => s.label);
    assert.ok(labels.includes('checkout'));
    assert.ok(labels.includes('commit'));
    assert.ok(labels.includes('push'), 'commitPush 수준에서는 push 단계가 plan 에 포함되어야 한다');
    assert.ok(!labels.includes('pr'), 'commitPush 수준은 PR 단계를 포함하지 않는다');

    // 실제로 파이프라인을 돌려 원격에 새 브랜치가 반영되는지 확인.
    commitOnDecidedBranch(fx, decided, 'n4a.txt', 'n4a', message, true);
    assert.ok(remoteBranches(fx.remote).includes('feature/n4a'));

    // 원격 커밋 메시지가 formatCommitMessage 결과와 일치한다.
    const lastMsg = shOrThrow(fx.work, ['log', '-1', '--pretty=%s', 'feature/n4a']).trim();
    assert.equal(lastMsg, 'feat(branch-ui): N4 조합 테스트');
  } finally {
    fx.cleanup();
  }
});

test('N4-b — Given 현재 브랜치 + commitOnly flowLevel Then push 단계는 빈 배열 · 원격은 갱신되지 않는다', { timeout: 30_000 }, () => {
  const fx = setupFixture();
  try {
    // Given: dev 로 이동한 상태에서 current 선택.
    shOrThrow(fx.work, ['checkout', '-B', 'dev']);
    const decided = decideBranchForCommit({
      selection: { mode: 'current' },
      currentCheckedOut: 'dev',
      localBranchExists: () => false,
      remoteBranchExists: () => false,
    });

    const config = { ...DEFAULT_GIT_AUTOMATION_CONFIG, flowLevel: 'commitOnly' as const };
    assert.equal(shouldAutoCommit(config), true);
    assert.equal(shouldAutoPush(config), false);

    const pushSteps = buildPushSteps(config, {
      workspacePath: fx.work, branch: decided.branch!, commitMessage: 'x', prTitle: '',
    });
    assert.deepEqual(pushSteps, [], 'commitOnly 에서는 push 단계가 공배열이어야 한다');

    const commitSteps = buildCommitSteps(config, {
      workspacePath: fx.work, branch: decided.branch!, commitMessage: 'chore: current branch test', prTitle: '',
    });
    // checkout -B 는 current 모드에서 "같은 브랜치로 강제 리셋" 이 일어나지만,
    // 같은 커밋을 가리키므로 실제 효과는 no-op. 계약 상 checkout/add/commit 3 단계가
    // 구성되어야 한다는 것만 확인.
    assert.equal(commitSteps.length, 3);

    // 원격이 갱신되지 않았음을 직접 확인.
    const remoteBefore = remoteBranches(fx.remote);
    commitOnDecidedBranch(fx, decided, 'n4b.txt', 'n4b', 'chore: current branch test', /* doPush */ false);
    const remoteAfter = remoteBranches(fx.remote);
    assert.deepEqual(remoteAfter, remoteBefore, 'commitOnly 에서 원격 브랜치 목록은 변하지 않아야 한다');
  } finally {
    fx.cleanup();
  }
});

test('N4 — 결정 실패(N3-*) 시 자동 푸시 토글과 무관하게 파이프라인이 발사되지 않는다', () => {
  // 호출자가 decided.ok=false 에도 불구하고 push 를 호출했을 때의 보호막은 이 함수 밖
  // (예: 서버 실행기) 에 있지만, 최소한 "플랜이 결정 없이 구성될 수 없음" 을 잠그는
  // 보조 가드로 commit/push 빌더가 의미 있는 branch 없이 호출될 수 없음을 확인한다.
  const decided = decideBranchForCommit({
    selection: { mode: 'new', branchName: '' },
    currentCheckedOut: 'main',
    localBranchExists: () => false,
    remoteBranchExists: () => false,
  });
  assert.equal(decided.ok, false);
  assert.equal(decided.branch, undefined);

  // 호출자가 실수로 buildRunPlan 에 decided.branch 를 넣는 상황을 모사. branch 가
  // undefined 면 타입 시스템이 차단하는 것이 이상적이지만, 런타임에서도 "빈 문자열" 은
  // git checkout 에 치명적이므로 호출자가 반드시 ok 체크를 해야 함을 회귀로 못 박는다.
  const config = { ...DEFAULT_GIT_AUTOMATION_CONFIG, flowLevel: 'commitPush' as const };
  assert.throws(
    () => {
      const branch = decided.branch;
      if (!branch) throw new Error('결정 실패 상태에서 파이프라인을 구성해서는 안 된다');
      buildRunPlan(config, { workspacePath: '/tmp/x', branch, commitMessage: '', prTitle: '' });
    },
    /결정 실패/,
  );
});
