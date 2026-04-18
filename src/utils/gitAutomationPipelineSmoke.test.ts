// Run with: npx tsx --test src/utils/gitAutomationPipelineSmoke.test.ts
//
// QA: Git 자동화 파이프라인이 "끝까지" 실행됐는지, 그리고 그 결과가 호출자 쪽에서
// 커밋 해시와 푸시 성공 여부로 즉시 회수 가능한지를 한 테스트로 고정하는 스모크.
//
// 기존 gitAutomationPipeline.test.ts 는 flowLevel/실패 경로 매트릭스를 길게 돌리지만,
// 정작 "파이프라인이 리턴한 값에서 커밋 SHA 와 푸시 결과가 꺼내지는가" 를 단일 출처로
// 고정하지 않아 summarizeRunResult 같은 요약 헬퍼를 끼워 넣을 때 회귀 감지가 어려웠다.
// 본 스모크는 다음 3가지를 한 번에 못 박는다:
//   1) commit 단계 stdout 이 파이프라인 결과에 담긴다(서버 spawnSync 계약과 동일).
//   2) parseCommitShaFromStdout 가 그 stdout 에서 단축 SHA 를 꺼내고, 같은 SHA 가
//      실제 `git rev-parse HEAD` 와 일치한다(로컬 커밋 성립 확인).
//   3) push 단계는 ok=true 로 종료되고, summarizeRunResult(run) 가 { commitSha, pushed:true }
//      를 돌려준다 — 호출자가 단일 요약만 보고도 "끝까지 갔는지" 판정 가능.
//
// 네트워크에 의존하지 않도록 로컬 bare 저장소를 원격 대역으로 세운다. gitAutomationPipeline.test.ts
// 의 setupWorkAndRemote 와 동일 패턴이지만, 이 파일은 단 하나의 "happy-path" 경로만 본다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  buildRunPlan,
  parseCommitShaFromStdout,
  summarizeRunResult,
  type GitAutomationConfig,
  type GitAutomationRunResult,
  type GitAutomationStepResult,
} from './gitAutomation.ts';

function setupWorkAndRemote(): { work: string; remote: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'git-auto-smoke-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  mkdirSync(work);
  mkdirSync(remote);
  const sh = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  sh(remote, ['init', '--bare', '-q', '-b', 'main']);
  sh(work, ['init', '-q', '-b', 'main']);
  sh(work, ['config', 'user.email', 'qa@example.com']);
  sh(work, ['config', 'user.name', 'QA']);
  sh(work, ['config', 'commit.gpgsign', 'false']);
  sh(work, ['remote', 'add', 'origin', remote]);
  writeFileSync(join(work, 'README.md'), '# seed\n');
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-q', '-m', 'init']);
  sh(work, ['push', '-u', 'origin', 'main']);
  return { work, remote, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// server.ts executeGitAutomation 의 runStep 과 동일한 계약:
//   - 성공/실패를 r.status 로 판정
//   - commit/pr 단계에 한해 stdout 을 400자 상한으로 캡처
//   - 실패 시 stderr 를 400자 상한으로 보관하고 즉시 중단
// 이 스모크의 목적은 "실 서버와 동일 규약으로 결과를 만들었을 때 요약이 성립하는가"
// 이므로, 서버 구현을 그대로 옮겨와 한 곳에서 계약을 고정한다.
function runPlanLikeServer(
  steps: ReturnType<typeof buildRunPlan>,
  cwd: string,
): GitAutomationRunResult {
  const results: GitAutomationStepResult[] = [];
  let ok = true;
  for (const step of steps) {
    const [bin, ...rest] = step.cmd;
    const r = spawnSync(bin, rest, { cwd, encoding: 'utf8', windowsHide: true });
    const stepOk = r.status === 0 && !r.error;
    const captured = step.label === 'commit' || step.label === 'pr'
      ? (r.stdout || '').slice(0, 400)
      : undefined;
    results.push({
      label: step.label,
      ok: stepOk,
      code: r.status,
      stdout: captured || undefined,
      stderr: stepOk ? undefined : ((r.stderr || '') + (r.error ? `\nspawn error: ${r.error.message}` : '')).slice(0, 400),
    });
    if (!stepOk) { ok = false; break; }
  }
  return { ok, results };
}

test('스모크 — commitPush 파이프라인이 끝까지 실행되고 커밋 해시·푸시 결과가 요약으로 회수된다', () => {
  const { work, remote, cleanup } = setupWorkAndRemote();
  try {
    writeFileSync(join(work, 'smoke.ts'), 'export const smoke = true;\n');
    const cfg: GitAutomationConfig = {
      enabled: true,
      flowLevel: 'commitPush',
      branchTemplate: 'feature/{type}/{slug}',
      commitConvention: 'conventional',
      commitScope: '',
      prTitleTemplate: '{type}: {summary}',
      reviewers: [],
    };
    const branch = 'feature/feat/smoke-return-contract';
    const steps = buildRunPlan(cfg, {
      workspacePath: work,
      branch,
      commitMessage: 'feat: smoke-return-contract',
      prTitle: '',
    });
    // plan 자체가 checkout→add→commit→push 라벨 순서를 그대로 쏘는지부터 확인 —
    // 라벨 자체가 어긋나면 아래의 stdout/parse 계약 전체가 같이 꺼진다.
    assert.deepEqual(steps.map(s => s.label), ['checkout', 'add', 'commit', 'push']);

    const run = runPlanLikeServer(steps, work);
    assert.equal(run.ok, true, `파이프라인이 끝까지 성공해야 한다: ${JSON.stringify(run.results)}`);
    // 모든 단계가 ok=true 로 기록됐는지 단일 줄로 고정. 한 단계라도 실패하면 이후
    // 단계는 append 되지 않으므로 길이 4 + every ok 로 end-to-end 를 못 박는다.
    assert.equal(run.results.length, 4);
    assert.ok(run.results.every(r => r.ok), `실패 단계 존재: ${JSON.stringify(run.results)}`);

    // 1) commit 단계에 stdout 이 캡처돼야 한다. 서버는 commit/pr 두 단계에 한해
    //    stdout 을 보관하므로, 여기서 stdout === undefined 면 서버 계약이 깨진 것.
    const commit = run.results.find(r => r.label === 'commit');
    assert.ok(commit, 'commit 단계가 결과에 없다');
    assert.ok(commit!.stdout && commit!.stdout.length > 0, 'commit stdout 이 캡처되지 않았다');

    // 2) 파서가 SHA 를 꺼내 실제 git HEAD 와 일치해야 한다. parseCommitShaFromStdout 은
    //    7~40자 16진만 허용하므로 prefix 일치로 비교한다.
    const parsedShort = parseCommitShaFromStdout(commit!.stdout);
    assert.ok(parsedShort && /^[0-9a-f]{7,40}$/.test(parsedShort), `커밋 SHA 파싱 실패: ${commit!.stdout}`);
    const realFull = spawnSync('git', ['-C', work, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', windowsHide: true,
    }).stdout.trim();
    assert.ok(realFull.startsWith(parsedShort!), `파싱된 SHA(${parsedShort}) 가 실제 HEAD(${realFull}) 와 다르다`);

    // 3) push 단계 성공 여부는 ok/code 로만 판정. git push 는 stdout 이 비어 있는
    //    게 정상이므로 stdout 을 기대하면 안 된다.
    const push = run.results.find(r => r.label === 'push');
    assert.ok(push && push.ok && push.code === 0, `push 실패: ${JSON.stringify(push)}`);

    // 4) 원격 ref 도 로컬 HEAD 와 동일하게 이동 — "push 결과" 의 물리적 증거.
    const remoteSha = spawnSync('git', ['-C', remote, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf8', windowsHide: true,
    }).stdout.trim();
    assert.equal(realFull, remoteSha, '원격 ref 가 로컬 HEAD 와 일치하지 않는다 — push 결과 누락');

    // 5) summarizeRunResult 는 commitSha(파싱된 단축), pushed=true, prUrl=undefined
    //    를 한 번에 돌려줘야 한다. 호출자가 요약만 보고도 "커밋 해시와 푸시 결과"
    //    두 가지 리턴을 수신 가능해야 한다는 계약.
    const summary = summarizeRunResult(run);
    assert.equal(summary.commitSha, parsedShort, 'summarizeRunResult.commitSha 가 파서 출력과 불일치');
    assert.equal(summary.pushed, true, 'summarizeRunResult.pushed 가 true 가 아니다 — 푸시 결과 드랍');
    assert.equal(summary.prUrl, undefined, 'commitPush 인데 요약에 prUrl 이 채워졌다');
  } finally {
    cleanup();
  }
});

test('스모크 — commitOnly 는 commitSha 는 돌려주지만 pushed=false 로 원격 미반영을 그대로 보고한다', () => {
  // commitPush 의 음수 대조군. autoPush 가 꺼진 구성에서는 pushed=false 로 요약이
  // 나와야 하고(자동 push 를 한 적 없으므로), commitSha 는 여전히 회수 가능해야 한다.
  // 호출자가 "pushed=false 인 이유" 를 run.skipped 나 run.results 에서 별도로
  // 읽지 않아도 요약만으로 원격 미반영을 구분할 수 있음을 고정한다.
  const { work, remote, cleanup } = setupWorkAndRemote();
  try {
    writeFileSync(join(work, 'smoke-local.ts'), 'export const local = true;\n');
    const cfg: GitAutomationConfig = {
      enabled: true,
      flowLevel: 'commitOnly',
      branchTemplate: 'feature/{type}/{slug}',
      commitConvention: 'conventional',
      commitScope: '',
      prTitleTemplate: '{type}: {summary}',
      reviewers: [],
    };
    const branch = 'feature/chore/smoke-commit-only';
    const steps = buildRunPlan(cfg, {
      workspacePath: work,
      branch,
      commitMessage: 'chore: smoke-commit-only',
      prTitle: '',
    });
    assert.deepEqual(steps.map(s => s.label), ['checkout', 'add', 'commit']);

    const run = runPlanLikeServer(steps, work);
    assert.equal(run.ok, true);
    const summary = summarizeRunResult(run);
    assert.ok(summary.commitSha && /^[0-9a-f]{7,40}$/.test(summary.commitSha), '요약에 commitSha 가 없다');
    assert.equal(summary.pushed, false, 'commitOnly 인데 pushed=true 로 올라갔다');
    // 원격 ref 도 없어야 한다 — push 가 한 번도 발사되지 않았음을 물리 수준에서 확인.
    const remoteHas = spawnSync('git', ['-C', remote, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf8', windowsHide: true,
    }).status === 0;
    assert.equal(remoteHas, false, 'commitOnly 인데 원격 ref 가 생겼다');
  } finally {
    cleanup();
  }
});
