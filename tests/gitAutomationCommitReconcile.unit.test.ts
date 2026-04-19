// Run with: npx tsx --test tests/gitAutomationCommitReconcile.unit.test.ts
//
// 지시 #77704932 — 커밋 실제 성공/실패 재판정
//
// 배경
//   server.ts 의 runStep 은 spawnSync 의 status 만 보고 commit 단계의 ok 를 결정해,
//   pre/post-commit 훅이 비정상 종료한 경우(커밋 객체는 생성되었지만 훅 exit≠0) 에도
//   실패로 보고했다. 결과로 UI 토스트/로그가 "커밋 실패" 를 띄우는 반면 HEAD 는 이미
//   전진해 사용자 관점에서 "실패라는데 커밋은 있다" 는 혼란을 일으켰다.
//
// 계약
//   reconcileCommitOutcome 는 commit 라벨만 다루며, step.ok=true 또는 headBefore/headAfter
//   가 비어 있으면 원본을 그대로 돌려준다. ok=false + 서로 다른 SHA 조합에서만 ok=true 로
//   뒤집고, stderr 에 재판정 근거를, stdout 이 비어 있다면 합성 헤더(`[reconciled <short>]`)
//   를 넣어 parseCommitShaFromStdout 가 계속 SHA 를 회수할 수 있게 한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcileCommitOutcome,
  parseCommitShaFromStdout,
  type GitAutomationStepResult,
} from '../src/utils/gitAutomation.ts';

function commitStep(overrides: Partial<GitAutomationStepResult> = {}): GitAutomationStepResult {
  return {
    label: 'commit',
    ok: false,
    code: 1,
    stderr: 'hook reported non-zero exit',
    stdout: undefined,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 기본 계약 — 다른 라벨·이미 ok·불완전한 HEAD 는 모두 pass-through
// ────────────────────────────────────────────────────────────────────────────

test('A1. commit 라벨이 아니면 step 을 그대로 돌려준다', () => {
  const step: GitAutomationStepResult = { label: 'push', ok: false, code: 1 };
  const out = reconcileCommitOutcome({ step, headBefore: 'a', headAfter: 'b' });
  assert.equal(out, step, '객체 아이덴티티가 유지돼야 한다 — 재판정 대상 외 단계는 건드리지 않음');
});

test('A2. 이미 ok=true 인 commit 은 재판정하지 않는다', () => {
  const step = commitStep({ ok: true, code: 0 });
  const out = reconcileCommitOutcome({
    step,
    headBefore: 'aaaaaaa',
    headAfter: 'bbbbbbb',
  });
  assert.equal(out, step);
});

test('A3. headBefore 또는 headAfter 가 비어 있으면 판정 불가 → 원본 유지', () => {
  const step = commitStep();
  assert.equal(reconcileCommitOutcome({ step, headBefore: '', headAfter: 'b' }), step);
  assert.equal(reconcileCommitOutcome({ step, headBefore: 'a', headAfter: '' }), step);
  assert.equal(reconcileCommitOutcome({ step, headBefore: undefined, headAfter: 'b' }), step);
  assert.equal(reconcileCommitOutcome({ step, headBefore: '   ', headAfter: '   ' }), step);
});

test('A4. HEAD 가 전혀 움직이지 않았다면 실패를 그대로 둔다(실제로 커밋이 없었던 경우)', () => {
  const step = commitStep();
  const out = reconcileCommitOutcome({
    step,
    headBefore: 'abcdef1234',
    headAfter: 'abcdef1234',
  });
  assert.equal(out, step);
  assert.equal(out.ok, false);
});

// ────────────────────────────────────────────────────────────────────────────
// 핵심 — HEAD 가 전진했으면 ok=true 로 뒤집어 UI 혼란을 막는다
// ────────────────────────────────────────────────────────────────────────────

test('B1. ok=false 이지만 HEAD 가 전진했다면 ok=true 로 재판정한다', () => {
  const step = commitStep({ code: 1, stderr: 'husky post-commit failed' });
  const out = reconcileCommitOutcome({
    step,
    headBefore: '0000000000000000000000000000000000000000',
    headAfter:  '1111111111111111111111111111111111111111',
  });
  assert.equal(out.ok, true, 'HEAD 전진은 "커밋 실제로 성공" 의 근거');
  assert.equal(out.code, 1, 'exit 코드 원본은 유지 — 훅 실패 맥락을 잃지 않는다');
});

test('B2. 재판정된 step 의 stderr 는 원본 + 근거를 append 해 관측 가능성을 유지한다', () => {
  const step = commitStep({ code: 2, stderr: 'hook: permission denied' });
  const out = reconcileCommitOutcome({
    step,
    headBefore: '1111111111111111',
    headAfter:  '2222222222222222',
  });
  assert.ok(out.stderr, 'reconcile 후에도 stderr 는 존재해야 한다');
  assert.match(out.stderr!, /hook: permission denied/);
  assert.match(out.stderr!, /reconciled: commit created/);
  assert.match(out.stderr!, /exit=2/, '원래 종료 코드가 근거 노트에 포함');
  assert.match(out.stderr!, /1111111/, 'before SHA 의 앞 7자');
  assert.match(out.stderr!, /2222222/, 'after SHA 의 앞 7자');
});

test('B3. stderr 가 비어 있어도 근거 노트 한 줄을 새로 채운다', () => {
  const step = commitStep({ code: null, stderr: undefined });
  const out = reconcileCommitOutcome({
    step,
    headBefore: 'aaaaaaaa',
    headAfter:  'bbbbbbbb',
  });
  assert.ok(out.stderr && out.stderr.startsWith('reconciled: commit created'));
  assert.match(out.stderr!, /exit=\?/, 'code 가 null 이면 ? 로 표기');
});

test('B4. stdout 이 비어 있으면 parseCommitShaFromStdout 와 호환되는 합성 헤더를 넣는다', () => {
  const step = commitStep({ code: 1, stdout: undefined });
  const out = reconcileCommitOutcome({
    step,
    headBefore: 'aaaaaaabbbb',
    headAfter:  'ccccccc1234',
  });
  assert.ok(out.stdout, '빈 stdout 은 합성본으로 채워야 한다');
  assert.match(out.stdout!, /^\[reconciled [0-9a-f]{7}\]/);
  const sha = parseCommitShaFromStdout(out.stdout);
  assert.equal(sha, 'ccccccc', '합성 헤더에서 동일 파서가 SHA 를 회수 가능');
});

test('B5. git 이 정상 stdout 을 남겼다면 원본을 보존한다(합성본으로 덮지 않음)', () => {
  const originalStdout = '[feature/x abcdef1] chore: auto update';
  const step = commitStep({ code: 1, stdout: originalStdout });
  const out = reconcileCommitOutcome({
    step,
    headBefore: '1111111',
    headAfter:  '2222222',
  });
  assert.equal(out.stdout, originalStdout);
  assert.equal(parseCommitShaFromStdout(out.stdout), 'abcdef1');
});

// ────────────────────────────────────────────────────────────────────────────
// C. 통합 시나리오 — "실패로 보고되던" 실사용 케이스가 이제 성공으로 보고된다
// ────────────────────────────────────────────────────────────────────────────

test('C. pre-commit 훅 exit 1 + 커밋 생성 케이스가 UI 계약상 성공으로 승격된다', () => {
  // runStep 이 쌓아 두던 step — exit 1 이지만 git 은 커밋 객체를 만들었다.
  const step = commitStep({
    code: 1,
    stderr: 'husky - pre-commit hook exited with code 1 (error)\nlint: warnings reported',
    stdout: undefined,
  });
  // spawnSync('git','rev-parse','HEAD') 의 전/후 결과. 개행이 섞여 들어올 수 있음.
  const out = reconcileCommitOutcome({
    step,
    headBefore: 'deadbeefcafebabe0000000000000000\n',
    headAfter:  'feedface12345678abcdef0000000000\n',
  });
  assert.equal(out.ok, true);
  const sha = parseCommitShaFromStdout(out.stdout);
  assert.equal(sha, 'feedfac', 'summarizeRunResult 경로도 SHA 를 회수해 UI 풋노트가 올바른 상태 표시');
  assert.match(out.stderr!, /husky/, '원래 훅 메시지가 살아 있어 사용자가 경고를 확인 가능');
  assert.match(out.stderr!, /reconciled/, '재판정 근거가 동반되어 관측 가능성 유지');
});
