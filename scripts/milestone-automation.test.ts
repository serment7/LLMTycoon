// Run with: tsx --test scripts/milestone-automation.test.ts
//
// Unit: covers the pure helpers (validate / parseArgs / formatSummary).
// Integration: drives `handleMilestone` against a throwaway temp git repo in
// dry-run mode so the exact `git checkout|add|commit|push` invocation sequence
// is asserted without touching a real remote or requiring `gh`. The inverse
// — a clean repo emitting *zero* git commands — is asserted too, so a future
// regression where the gate slips won't sneak past.

import test from 'node:test';
import assert from 'node:assert/strict';

import { execSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  formatSummary,
  handleMilestone,
  parseArgs,
  validateBatch,
  validateMilestone,
  type BatchSummary,
  type Milestone,
} from './milestone-automation.ts';

const ok = (over: Partial<Milestone> = {}): Milestone => ({
  id: 'm-1',
  title: 'add login',
  branch: 'feat/login',
  ...over,
});

test('validateMilestone accepts a well-formed milestone', () => {
  assert.doesNotThrow(() => validateMilestone(ok()));
});

test('validateMilestone rejects shell-unsafe branch names', () => {
  for (const branch of ['feat/login;rm', 'feat/$(whoami)', 'feat/`id`', 'feat/login&&ls']) {
    assert.throws(() => validateMilestone(ok({ branch })), /unsafe branch name/);
  }
});

test('validateMilestone rejects malformed branch shapes git would also reject', () => {
  for (const branch of ['feat/../escape', '-feat/login', 'feat/login/']) {
    assert.throws(() => validateMilestone(ok({ branch })), /branch name/);
  }
});

test('validateMilestone rejects oversized titles and branches', () => {
  assert.throws(() => validateMilestone(ok({ title: 'x'.repeat(121) })), /title exceeds/);
  assert.throws(
    () => validateMilestone(ok({ branch: 'a/' + 'b'.repeat(200) })),
    /branch name exceeds/,
  );
});

test('validateMilestone requires id, title, branch', () => {
  assert.throws(() => validateMilestone({ id: '', title: 't', branch: 'b' } as Milestone));
  assert.throws(() => validateMilestone({ id: 'i', title: '', branch: 'b' } as Milestone));
  assert.throws(() => validateMilestone({ id: 'i', title: 't', branch: '' } as Milestone));
});

test('validateBatch surfaces duplicates and invalids together', () => {
  const issues = validateBatch([
    ok({ id: 'a', branch: 'feat/a' }),
    ok({ id: 'a', branch: 'feat/b' }),
    ok({ id: 'b', branch: 'feat/a' }),
    ok({ id: 'c', branch: 'feat/$(bad)' }),
  ]);
  assert.deepEqual(issues.duplicateIds, ['a']);
  assert.deepEqual(issues.duplicateBranches, ['feat/a']);
  assert.equal(issues.invalid.length, 1);
  assert.equal(issues.invalid[0].id, 'c');
});

test('validateBatch is empty for a clean batch', () => {
  const issues = validateBatch([ok({ id: 'a', branch: 'feat/a' }), ok({ id: 'b', branch: 'feat/b' })]);
  assert.deepEqual(issues, { duplicateIds: [], duplicateBranches: [], invalid: [] });
});

test('parseArgs reads positional args and flags in any order', () => {
  const out = parseArgs(['m-1', 'add login', 'feat/login', 'main', '--dry-run', '--json']);
  assert.deepEqual(out.milestone, {
    id: 'm-1',
    title: 'add login',
    branch: 'feat/login',
    baseBranch: 'main',
  });
  assert.equal(out.dryRun, true);
  assert.equal(out.json, true);
});

test('parseArgs rejects unknown flags and missing positionals', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown flag/);
  assert.throws(() => parseArgs(['only-id']), /usage:/);
});

test('parseArgs collects repeated --label and --reviewer, and --draft', () => {
  const out = parseArgs([
    'm-1', 'add login', 'feat/login',
    '--label', 'backend',
    '--label', 'security',
    '--reviewer', 'alice',
    '--reviewer', 'bob',
    '--draft',
  ]);
  assert.deepEqual(out.milestone.labels, ['backend', 'security']);
  assert.deepEqual(out.milestone.reviewers, ['alice', 'bob']);
  assert.equal(out.milestone.draft, true);
});

test('parseArgs errors when a valued flag swallows another flag', () => {
  assert.throws(
    () => parseArgs(['m-1', 't', 'b', '--label', '--draft']),
    /--label requires a value/,
  );
  assert.throws(
    () => parseArgs(['m-1', 't', 'b', '--reviewer']),
    /--reviewer requires a value/,
  );
});

// ---------------------------------------------------------------------------
// 감마(QA): handleMilestone 통합 — 임시 git 저장소 기반.
// 실제 `handleMilestone` 은 `execSync` 로 git 을 돌리며 cwd 는 process.cwd().
// 임시 폴더로 chdir 한 뒤 dry-run 모드에서 호출하면 git 바이너리는 건드리지
// 않고 콘솔 로그로 "어떤 명령이 나갔는지" 만 남는다. 이 두 가지를 고정한다:
//   1) 더티 저장소 + dry-run → checkout/add/commit/push + gh pr create 가 순서대로 호출.
//   2) 클린 저장소 → no-changes 반환, git 변경 계열 로그가 0건.
// "설정 비활성 = 호출 0건" 불변을 전체 플로우 기준으로 잡는 센티널 역할.
// ---------------------------------------------------------------------------

function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ms-integ-'));
  const sh = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'ignore' });
  sh('git init -q -b main');
  sh('git config user.email qa@example.com');
  sh('git config user.name QA');
  sh('git config commit.gpgsign false');
  writeFileSync(join(dir, 'README.md'), '# seed\n');
  sh('git add -A');
  sh('git commit -q -m init');
  return dir;
}

// dry-run 로그를 조용히 가로채 반환한다. 원본 console 메서드는 finally 에서 복원.
function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ value: T; out: string }> {
  const buf: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { buf.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { buf.push(a.map(String).join(' ')); };
  return (async () => {
    try {
      const value = await fn();
      return { value, out: buf.join('\n') };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  })();
}

test('handleMilestone integ: 더티 저장소 dry-run 은 checkout→add→commit→push→gh pr create 를 순서대로 로그한다', async () => {
  const dir = initTempRepo();
  const origCwd = process.cwd();
  try {
    // "이 브랜치에 올릴 변경" 에 해당하는 더티 파일 하나.
    writeFileSync(join(dir, 'feature.ts'), 'export const x = 1;\n');
    process.chdir(dir);

    const { value: result, out } = await captureConsole(() =>
      handleMilestone(
        { id: 'qa-integ', title: 'add qa stub', branch: 'feat/qa-integ' },
        { dryRun: true },
      ),
    );

    // dry-run 은 gh/푸시까지 전부 [dry-run] 로그로만 남기므로 최종 상태는 'opened'(prUrl='').
    assert.equal(result.status, 'opened');

    // 각 명령의 상대적 순서를 고정. 오타/재배열로 깨지면 자동화 흐름이 무너진다.
    const ixCheckout = out.indexOf('[dry-run] git checkout -B feat/qa-integ');
    const ixAdd      = out.indexOf('[dry-run] git add -A');
    const ixCommit   = out.indexOf('[dry-run] git commit -m');
    const ixPush     = out.indexOf('[dry-run] git push -u origin feat/qa-integ');
    const ixPr       = out.indexOf('[dry-run] gh pr create');
    assert.ok(ixCheckout >= 0, `checkout 로그 없음:\n${out}`);
    assert.ok(ixAdd    > ixCheckout, 'add 는 checkout 뒤');
    assert.ok(ixCommit > ixAdd,      'commit 은 add 뒤');
    assert.ok(ixPush   > ixCommit,   'push 는 commit 뒤');
    assert.ok(ixPr     > ixPush,     'gh pr create 는 push 뒤');
    // 커밋 메시지 인자에 id·title 이 반영됐는지 스팟 체크 — shellQuote 구조가 깨지면 실패.
    assert.match(out, /\[dry-run\] git commit -m ".*qa-integ.*add qa stub.*"/);
  } finally {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleMilestone integ: 클린 저장소는 no-changes 를 반환하고 git 변경 명령을 한 줄도 남기지 않는다', async () => {
  const dir = initTempRepo();
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    const { value: result, out } = await captureConsole(() =>
      handleMilestone(
        { id: 'qa-clean', title: 'no op', branch: 'feat/qa-clean' },
        { dryRun: true },
      ),
    );
    assert.equal(result.status, 'no-changes');
    // 변경 계열 명령은 전혀 흘러가면 안 된다. `[dry-run]` 접두 로그가 떨어지지 않는 게 핵심.
    assert.doesNotMatch(out, /\[dry-run\] git (checkout|add|commit|push)/);
    assert.doesNotMatch(out, /\[dry-run\] gh pr create/);
  } finally {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleMilestone integ: dry-run 은 작업 트리(HEAD/브랜치)를 변경하지 않는다', async () => {
  const dir = initTempRepo();
  const origCwd = process.cwd();
  try {
    writeFileSync(join(dir, 'feature.ts'), 'export const x = 1;\n');
    const before = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    const brBefore = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();

    process.chdir(dir);
    await captureConsole(() =>
      handleMilestone(
        { id: 'qa-ro', title: 'readonly', branch: 'feat/qa-ro' },
        { dryRun: true },
      ),
    );
    process.chdir(origCwd);

    const after = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    const brAfter = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    assert.equal(after, before, 'dry-run 은 HEAD 를 옮기면 안 된다');
    assert.equal(brAfter, brBefore, 'dry-run 은 브랜치를 만들면 안 된다');
  } finally {
    if (process.cwd() !== origCwd) process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatSummary renders one line per result with status-specific detail', () => {
  const summary: BatchSummary = {
    total: 3,
    opened: 1,
    existed: 1,
    noChanges: 0,
    skipped: 1,
    results: [
      { status: 'opened', id: 'a', branch: 'feat/a', prUrl: 'https://x/1' },
      { status: 'exists', id: 'b', branch: 'feat/b', prUrl: 'https://x/2' },
      { status: 'skipped', id: 'c', reason: 'gh missing' },
    ],
  };
  const out = formatSummary(summary);
  assert.match(out, /opened=1 existed=1 no-changes=0 skipped=1/);
  assert.match(out, /\[opened\] a \(feat\/a\) https:\/\/x\/1/);
  assert.match(out, /\[exists\] b \(feat\/b\) https:\/\/x\/2/);
  assert.match(out, /\[skipped\] c: gh missing/);
});
