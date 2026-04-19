// Run with: npx tsx --test tests/gitAutomation.unit.test.ts
//
// 지시 #7a3713f3 ① — 커밋 성공 오판정 회귀 잠금.
//
// 배경
//   spawnSync('git commit') 이 pre-commit / post-commit 훅 경고, 사후 스캐너의
//   non-zero 반환 등으로 exit code 0 이 아닌 값을 돌려줘도, 실제로는 git 객체
//   데이터베이스에 커밋이 이미 기록된 경우가 있다. 과거 파이프라인은 step.ok 를
//   spawnSync 의 status === 0 으로만 판정해 "종료 코드 비정상 = 커밋 실패" 로
//   오판정했고, UI 는 실패 토스트를 띄우는 동시에 HEAD 는 이미 전진해 있어 사용자
//   신뢰가 깨졌다.
//
// 수정
//   · src/utils/gitAutomation.ts 에 reconcileCommitOutcome(step, headBefore, headAfter)
//     재판정 헬퍼가 추가되어, HEAD 가 실제로 전진한 경우 step.ok 를 true 로 뒤집고
//     stderr 에 재판정 근거(이전/현재 7자 SHA + 원래 exit 코드)를 append 한다.
//     stdout 이 비어 있던 경우엔 `[reconciled abc1234]` 합성본을 넣어
//     parseCommitShaFromStdout 가 동일 계약으로 SHA 를 회수할 수 있게 한다.
//
// 잠금 축
//   GU1. commit 이 아닌 step 은 재판정 대상이 아님(원본 그대로).
//   GU2. 이미 ok=true 인 commit step 은 변경 없음(불필요한 stderr 오염 방지).
//   GU3. HEAD 가 전진하지 않음(before === after) → 원본 그대로 유지(진짜 실패).
//   GU4. HEAD 전진 + exit 1 → ok=true 로 뒤집고 stderr 에 reconciled 노트 append.
//   GU5. headBefore/headAfter 중 하나라도 누락(undefined/공백) → 보수적으로 원본 유지.
//   GU6. pre-commit 훅 경고(stderr 에 "warning: …") + exit 1 + HEAD 전진 →
//        재판정으로 ok=true, 기존 stderr 는 보존되고 note 가 append 됨.
//   GU7. stdout 이 비어 있던 경우 합성본 `[reconciled abc1234]` 이 삽입되고
//        parseCommitShaFromStdout 가 이 SHA 를 회수.
//   GU8. 통합 — checkout/add/commit(오판정)/push 결과를 재판정 통과시키면
//        summarizeRunResult 가 commitSha 를 채우고 push 도 정상 집계.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcileCommitOutcome,
  parseCommitShaFromStdout,
  summarizeRunResult,
  type GitAutomationStepResult,
  type GitAutomationRunResult,
} from '../src/utils/gitAutomation.ts';

function makeStep(partial: Partial<GitAutomationStepResult> & Pick<GitAutomationStepResult, 'label'>): GitAutomationStepResult {
  return {
    ok: false,
    code: 1,
    stderr: '',
    stdout: '',
    ...partial,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GU1~GU5. 경계 계약
// ────────────────────────────────────────────────────────────────────────────

test('GU1. commit 이 아닌 step 은 재판정 대상이 아님 — 원본 그대로', () => {
  const step = makeStep({ label: 'push', ok: false, code: 128, stderr: 'rejected' });
  const out = reconcileCommitOutcome({ step, headBefore: 'aaaaaaa', headAfter: 'bbbbbbb' });
  assert.strictEqual(out, step, '동일 참조를 반환해 불필요한 객체 할당이 없어야 함');
});

test('GU2. 이미 ok=true 인 commit step 은 변경 없음', () => {
  const step = makeStep({
    label: 'commit', ok: true, code: 0,
    stdout: '[main 1234567] feat: hello',
    stderr: '',
  });
  const out = reconcileCommitOutcome({ step, headBefore: 'aaaaaaa', headAfter: 'bbbbbbb' });
  assert.strictEqual(out, step, 'ok=true 면 재판정 불필요');
  assert.equal(out.stderr, '', 'stderr 에 reconcile 노트가 섞이지 않아야 함');
});

test('GU3. HEAD 가 전진하지 않음(before === after) → 원본 그대로', () => {
  const step = makeStep({
    label: 'commit', ok: false, code: 1,
    stderr: 'nothing to commit, working tree clean',
  });
  const sameSha = 'abc1234def';
  const out = reconcileCommitOutcome({ step, headBefore: sameSha, headAfter: sameSha });
  assert.strictEqual(out, step, 'HEAD 가 안 움직였으면 진짜 실패 — 재판정 금지');
  assert.equal(out.ok, false);
});

test('GU4. HEAD 전진 + exit 1 → ok=true 로 재판정 + stderr 에 reconciled 노트 append', () => {
  const step = makeStep({
    label: 'commit', ok: false, code: 1,
    stderr: 'pre-commit hook failed',
  });
  const out = reconcileCommitOutcome({
    step,
    headBefore: '1111111aaaabbbb',
    headAfter:  '2222222aaaabbbb',
  });
  assert.equal(out.ok, true, '실질 성공으로 뒤집혀야 함');
  assert.equal(out.code, 1, 'code 는 원래 종료 코드 그대로 보존(감사 추적용)');
  assert.match(out.stderr ?? '', /pre-commit hook failed/, '원래 stderr 보존');
  assert.match(out.stderr ?? '', /reconciled: commit created/);
  assert.match(out.stderr ?? '', /1111111 → 2222222/);
  assert.match(out.stderr ?? '', /exit=1/);
});

test('GU5. headBefore / headAfter 중 하나라도 누락이면 보수적으로 원본 유지', () => {
  const step = makeStep({ label: 'commit', ok: false, code: 1 });
  const onlyBefore = reconcileCommitOutcome({ step, headBefore: 'aaaaaaa', headAfter: undefined });
  const onlyAfter  = reconcileCommitOutcome({ step, headBefore: undefined, headAfter: 'bbbbbbb' });
  const bothBlank  = reconcileCommitOutcome({ step, headBefore: '   ',      headAfter: '' });
  assert.strictEqual(onlyBefore, step);
  assert.strictEqual(onlyAfter, step);
  assert.strictEqual(bothBlank, step);
});

// ────────────────────────────────────────────────────────────────────────────
// GU6. pre-commit 훅 경고 실제 케이스 — stderr 누적 보존 + 재판정
// ────────────────────────────────────────────────────────────────────────────

test('GU6. pre-commit 훅 경고 stderr 가 있어도 HEAD 전진이면 재판정 성공', () => {
  const step = makeStep({
    label: 'commit', ok: false, code: 1,
    stderr: 'warning: hook `prettier --check` returned 1\nwarning: staged formatting drift',
    stdout: '',
  });
  const out = reconcileCommitOutcome({
    step,
    headBefore: 'abcdef0111111',
    headAfter:  'abcdef1222222',
  });
  assert.equal(out.ok, true);
  // 원래 경고 stderr 는 그대로, note 는 끝에 append.
  assert.match(out.stderr ?? '', /^warning: hook `prettier --check` returned 1/);
  assert.match(out.stderr ?? '', /staged formatting drift/);
  assert.match(out.stderr ?? '', /\nreconciled: commit created/);
  // stderr 는 총 400자 상한으로 자르는 계약이므로 길이도 확인.
  assert.ok((out.stderr ?? '').length <= 400, 'stderr 상한 보호');
});

// ────────────────────────────────────────────────────────────────────────────
// GU7. stdout 합성 — parseCommitShaFromStdout 이 동일 계약으로 회수
// ────────────────────────────────────────────────────────────────────────────

test('GU7. stdout 이 비어 있으면 `[reconciled abc1234]` 합성, parse 경로가 동일하게 SHA 를 회수', () => {
  const step = makeStep({
    label: 'commit', ok: false, code: 1,
    stderr: 'post-commit hook failed',
    stdout: '',
  });
  const out = reconcileCommitOutcome({
    step,
    headBefore: 'deadbee0000000',
    headAfter:  'cafebab1111111',
  });
  assert.equal(out.ok, true);
  assert.ok(out.stdout && out.stdout.length > 0, '합성 stdout 이 삽입되어야 함');
  assert.match(out.stdout ?? '', /\[reconciled cafebab\]/);
  const parsed = parseCommitShaFromStdout(out.stdout);
  assert.equal(parsed, 'cafebab', 'summarizeRunResult 가 쓰는 기존 파서로 회수 가능');
});

test('GU7b. 이미 git 이 남긴 stdout 이 있으면 합성본이 덮어쓰지 않고 보존', () => {
  const step = makeStep({
    label: 'commit', ok: false, code: 1,
    stdout: '[feature/x 7777777] feat: something\n 3 files changed',
    stderr: 'some warning',
  });
  const out = reconcileCommitOutcome({
    step,
    headBefore: '1111111',
    headAfter:  '7777777',
  });
  assert.equal(out.ok, true);
  assert.match(out.stdout ?? '', /^\[feature\/x 7777777\]/, '기존 stdout 보존');
  assert.equal(parseCommitShaFromStdout(out.stdout), '7777777');
});

// ────────────────────────────────────────────────────────────────────────────
// GU8. 통합 — run.results 재판정 → summarizeRunResult 가 성공으로 집계
// ────────────────────────────────────────────────────────────────────────────

test('GU8. checkout/add/commit(오판정)/push 흐름을 재판정 통과 시 commitSha + pushed 가 올바르게 집계', () => {
  // checkout / add 는 정상, commit 은 exit 1 로 오판정, push 는 그 다음 단계까지
  // 서버가 이어 돌렸다는 가정(재판정 이후 플랜이 계속 진행됨).
  const raw: GitAutomationStepResult[] = [
    { label: 'checkout', ok: true, code: 0 },
    { label: 'add',      ok: true, code: 0 },
    {
      label: 'commit', ok: false, code: 1,
      stderr: 'pre-commit hook returned 1',
      stdout: '',
    },
    {
      label: 'push', ok: true, code: 0,
      stdout: 'Branch pushed',
    },
  ];

  // 재판정: commit step 에 HEAD before/after 를 주입해 reconcile 수행.
  const reconciled = raw.map((s) =>
    s.label === 'commit'
      ? reconcileCommitOutcome({ step: s, headBefore: 'aaaaaaa111', headAfter: 'bbbbbbb222' })
      : s,
  );

  const run: GitAutomationRunResult = {
    ok: true,
    results: reconciled,
    branch: 'feature/test',
  };
  const summary = summarizeRunResult(run);

  assert.equal(summary.commitSha, 'bbbbbbb', '합성 stdout 에서 단축 SHA 회수');
  assert.equal(summary.pushed, true, '재판정 후 push 단계가 정상 집계');
  // 재판정 결과의 commit step 은 ok=true 로 뒤집혔어야 한다.
  const commitStep = reconciled.find((s) => s.label === 'commit');
  assert.equal(commitStep?.ok, true);
});

test('GU8b. 실제 실패(HEAD 전진 없음) 케이스에서는 재판정이 막히고 summarizeRunResult 는 commitSha 가 비어 있음', () => {
  const step = makeStep({
    label: 'commit', ok: false, code: 1,
    stderr: 'nothing to commit, working tree clean',
  });
  const unchanged = reconcileCommitOutcome({
    step,
    headBefore: 'same123',
    headAfter:  'same123',
  });
  const run: GitAutomationRunResult = {
    ok: false,
    results: [unchanged],
  };
  const summary = summarizeRunResult(run);
  assert.equal(summary.commitSha, undefined, 'HEAD 가 안 움직였으므로 SHA 없음');
  assert.equal(summary.pushed, false);
});
