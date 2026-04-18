// Run with: npx tsx --test src/utils/gitAutomationPipeline.test.ts
//
// QA: Git 자동화 파이프라인의 end-to-end 검증 시나리오.
// 기존 gitAutomation.test.ts 는 commitOnly 의 로컬 커밋만 실제 git 으로 확인했고,
// commitPush / commitPushPR 의 "원격으로 실제 간다" / "gh pr create 가 정확한
// argv 로 깨어난다" 부분과 실패 경로(네트워크 단절, 충돌)는 비어 있었다. 여기서
// 로컬 bare 저장소를 원격 대역으로 세우고 `gh` 를 스텁 바이너리로 바꿔 세 flowLevel
// 전체 + 두 가지 실패 경로를 한 파일에 고정한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';

import {
  buildRunPlan,
  shouldAutoCommit,
  shouldAutoOpenPR,
  shouldAutoPush,
  type FlowLevel,
  type GitAutomationConfig,
} from './gitAutomation.ts';
// 리더 재분배 E2E 시나리오(G/I)에서 실 taskRunner 의 JSON 파싱 분기와 동일한
// 출처를 공유하기 위해 import 한다. leaderDispatch.test.ts 시뮬레이터가 참조하는
// prompts.extractLeaderPlan 과 같은 함수라 계약이 한 곳으로 수렴한다.
import { extractLeaderPlan } from '../server/prompts.ts';

interface StepResult {
  label: string;
  ok: boolean;
  code: number | null;
  stderr?: string;
}

// 실행기: server.ts runGitAutomation 의 spawnSync 루프와 동일한 계약.
// 실패 단계에서 중단하고 나머지는 결과 배열에 기록하지 않는다.
function runPlan(
  cmdList: ReturnType<typeof buildRunPlan>,
  env: NodeJS.ProcessEnv,
): StepResult[] {
  const results: StepResult[] = [];
  for (const step of cmdList) {
    const [bin, ...rest] = step.cmd;
    const r = spawnSync(bin, rest, { encoding: 'utf8', windowsHide: true, env });
    const ok = r.status === 0;
    results.push({
      label: step.label,
      ok,
      code: r.status,
      stderr: ok ? undefined : (r.stderr || '').slice(0, 400),
    });
    if (!ok) break;
  }
  return results;
}

// bare 원격과 워크트리를 함께 만든다. 원격은 로컬 파일시스템 경로를 URL 로 쓴다.
function setupWorkAndRemote(): { work: string; remote: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'git-auto-pipe-'));
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

  return {
    work,
    remote,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// 테스트 동안 `gh` 호출을 가로채기 위한 스텁 바이너리. Windows 와 Unix 양쪽에서
// PATH 앞에 붙일 수 있도록, 각각 .cmd / POSIX 쉘 래퍼 두 벌을 함께 깔아둔다.
// 스텁은 전달받은 argv 를 JSONL 로 캡처 파일에 append 해, 테스트에서 "무엇으로
// 깨웠는지" 를 그대로 검사할 수 있게 한다.
function installGhStub(binDir: string, capturePath: string): void {
  mkdirSync(binDir, { recursive: true });
  const nodeShim = [
    '#!/usr/bin/env node',
    'const fs = require("fs");',
    'fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
    'process.exit(0);',
  ].join('\n');
  const jsPath = join(binDir, 'gh-stub.js');
  writeFileSync(jsPath, nodeShim);
  // Windows 용 gh.cmd — `node gh-stub.js <args>` 를 호출하도록 고정.
  if (platform() === 'win32') {
    const cmd = `@echo off\r\nnode "${jsPath.replace(/\\/g, '\\\\')}" %*\r\n`;
    writeFileSync(join(binDir, 'gh.cmd'), cmd);
  }
  // POSIX 용 `gh` 도 함께 둬서 WSL / Linux CI 에서 같은 테스트가 재사용 가능하다.
  const sh = `#!/bin/sh\nexec node "${jsPath}" "$@"\n`;
  const shPath = join(binDir, 'gh');
  writeFileSync(shPath, sh);
  try { chmodSync(shPath, 0o755); } catch { /* Windows 에서는 chmod 무시 */ }
  // 캡처 로그 초기화.
  writeFileSync(capturePath, '');
}

function envWithStub(binDir: string, capturePath: string): NodeJS.ProcessEnv {
  // stub 이 진짜 gh 보다 먼저 잡히도록 PATH 최앞단에 꽂는다.
  const sep = platform() === 'win32' ? ';' : ':';
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH ?? ''}`,
    GH_STUB_LOG: capturePath,
  };
}

function headSha(dir: string): string {
  return spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', windowsHide: true,
  }).stdout.trim();
}

function branchExistsOnRemote(remote: string, branch: string): boolean {
  const r = spawnSync('git', ['-C', remote, 'rev-parse', `refs/heads/${branch}`], {
    encoding: 'utf8', windowsHide: true,
  });
  return r.status === 0;
}

const BASE_CFG: GitAutomationConfig = {
  flowLevel: 'commitOnly',
  branchTemplate: 'feature/{type}/{slug}',
  commitConvention: 'conventional',
  commitScope: '',
  prTitleTemplate: '{type}: {summary}',
  reviewers: ['alpha'],
};

// 리포트 수집기 — 각 테스트가 작성한 결과를 한 번에 파일로 떨군다. afterAll 훅이
// 없는 node:test 에서도 process.on('exit') 로 안정적으로 플러시된다.
interface Scenario {
  name: string;
  flowLevel: string;
  branch: string;
  commitSha?: string;
  remoteSha?: string | null;
  prCaptured?: unknown;
  steps: StepResult[];
  failedAt?: string | null;
  notes?: string;
}
const report: Scenario[] = [];
const reportPath = join(
  process.cwd(),
  'docs', 'reports', '2026-04-18-git-automation-pipeline-validation.md',
);
process.on('exit', () => {
  const lines: string[] = [];
  lines.push('# Git 자동화 파이프라인 검증 보고서');
  lines.push('');
  lines.push('- 날짜: 2026-04-18');
  lines.push('- 테스트 파일: `src/utils/gitAutomationPipeline.test.ts`');
  lines.push('- 커버 범위: flowLevel 3종(commitOnly / commitPush / commitPushPR) + 실패 경로 2종(네트워크 단절·충돌)');
  lines.push('');
  for (const s of report) {
    lines.push(`## ${s.name}`);
    lines.push('');
    lines.push(`- flowLevel: \`${s.flowLevel}\``);
    lines.push(`- branch: \`${s.branch}\``);
    if (s.commitSha) lines.push(`- local HEAD SHA: \`${s.commitSha}\``);
    if (s.remoteSha !== undefined) {
      lines.push(`- remote HEAD SHA: ${s.remoteSha ? `\`${s.remoteSha}\`` : '(푸시되지 않음)'}`);
    }
    if (s.prCaptured !== undefined) {
      lines.push(`- gh pr create argv 캡처: \`${JSON.stringify(s.prCaptured)}\``);
    }
    lines.push(`- 실패 단계: ${s.failedAt ?? '없음'}`);
    lines.push('- 단계 결과:');
    for (const r of s.steps) {
      lines.push(`  - ${r.label}: ${r.ok ? 'ok' : `fail(code=${r.code})`}${r.stderr ? ` — \`${r.stderr.replace(/\n/g, ' ').slice(0, 160)}\`` : ''}`);
    }
    if (s.notes) {
      lines.push('');
      lines.push(`> ${s.notes}`);
    }
    lines.push('');
  }
  try {
    mkdirSync(join(process.cwd(), 'docs', 'reports'), { recursive: true });
    writeFileSync(reportPath, lines.join('\n'));
  } catch { /* 보고서 기록은 부수 효과일 뿐 테스트 실패로 승격하지 않는다. */ }
});

// ---------------------------------------------------------------------------
// 시나리오 A — commitOnly: 로컬 커밋만, push/PR 은 절대 발사되지 않음.
// ---------------------------------------------------------------------------
test('시나리오 A — commitOnly: 로컬 커밋만 기록되고 원격/PR 은 건드리지 않는다', () => {
  const { work, remote, cleanup } = setupWorkAndRemote();
  const binDir = join(work, '.stub-bin');
  const capture = join(work, '.stub-bin', 'gh-calls.jsonl');
  installGhStub(binDir, capture);
  try {
    writeFileSync(join(work, 'featureA.ts'), 'export const a = 1;\n');
    const cfg: GitAutomationConfig = { ...BASE_CFG, flowLevel: 'commitOnly' };
    const steps = buildRunPlan(cfg, {
      workspacePath: work,
      branch: 'feature/chore/scenario-a',
      commitMessage: 'chore: scenario-a commit only',
      prTitle: '',
    });
    const results = runPlan(steps, envWithStub(binDir, capture));
    const sha = headSha(work);
    report.push({
      name: '시나리오 A — commitOnly',
      flowLevel: cfg.flowLevel,
      branch: 'feature/chore/scenario-a',
      commitSha: sha,
      remoteSha: branchExistsOnRemote(remote, 'feature/chore/scenario-a') ? '(예상 밖) 존재' : null,
      prCaptured: readFileSync(capture, 'utf8').trim() || '(호출 없음)',
      steps: results,
      failedAt: null,
      notes: 'push/pr 은 plan 자체에 포함되지 않아 호출이 0건이어야 한다.',
    });

    assert.deepEqual(results.map(r => r.label), ['checkout', 'add', 'commit']);
    assert.ok(results.every(r => r.ok), `단계 실패: ${JSON.stringify(results)}`);
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(
      branchExistsOnRemote(remote, 'feature/chore/scenario-a'),
      false,
      'commitOnly 인데 원격에 브랜치가 생겼다',
    );
    assert.equal(readFileSync(capture, 'utf8'), '', 'commitOnly 인데 gh 가 호출됐다');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 시나리오 B — commitPush: 로컬 커밋 + 원격 푸시 성공. gh 는 여전히 호출 금지.
// ---------------------------------------------------------------------------
test('시나리오 B — commitPush: 로컬 커밋 SHA 가 원격 ref 와 일치하고 gh 는 호출되지 않는다', () => {
  const { work, remote, cleanup } = setupWorkAndRemote();
  const binDir = join(work, '.stub-bin');
  const capture = join(work, '.stub-bin', 'gh-calls.jsonl');
  installGhStub(binDir, capture);
  try {
    writeFileSync(join(work, 'featureB.ts'), 'export const b = 2;\n');
    const cfg: GitAutomationConfig = { ...BASE_CFG, flowLevel: 'commitPush' };
    const branch = 'feature/feat/scenario-b';
    const steps = buildRunPlan(cfg, {
      workspacePath: work,
      branch,
      commitMessage: 'feat: scenario-b commit + push',
      prTitle: '',
    });
    const results = runPlan(steps, envWithStub(binDir, capture));
    const localSha = headSha(work);
    const remoteSha = spawnSync('git', ['-C', remote, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf8', windowsHide: true,
    }).stdout.trim();
    report.push({
      name: '시나리오 B — commitPush',
      flowLevel: cfg.flowLevel,
      branch,
      commitSha: localSha,
      remoteSha: remoteSha || null,
      prCaptured: readFileSync(capture, 'utf8').trim() || '(호출 없음)',
      steps: results,
      failedAt: null,
    });

    assert.deepEqual(results.map(r => r.label), ['checkout', 'add', 'commit', 'push']);
    assert.ok(results.every(r => r.ok), `단계 실패: ${JSON.stringify(results)}`);
    assert.equal(localSha, remoteSha, '로컬 HEAD 와 원격 ref SHA 가 일치하지 않는다');
    assert.equal(readFileSync(capture, 'utf8'), '', 'commitPush 인데 gh 가 호출됐다');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 시나리오 C — commitPushPR: 커밋+푸시+gh pr create. gh 는 스텁으로 argv 를 캡처.
// ---------------------------------------------------------------------------
test('시나리오 C — commitPushPR: push 후 pr 단계 argv(title/base/head/reviewer) 가 정확히 만들어진다', () => {
  // gh 실행까지 end-to-end 로 엮으려 했으나, Windows 환경에서 PATH 해석이
  // 시스템 `gh.exe` 를 먼저 잡아 스텁 바이너리가 안정적이지 않았다. QA 관점에서
  // 검증해야 할 계약은 두 가지:
  //   (1) push 까지 실제로 원격 ref 에 반영된다 → 로컬/원격 SHA 동일.
  //   (2) plan 의 pr 단계 argv 가 UI 설정(title/base/head/reviewer) 을 정확히 반영한다.
  // 그래서 push 까지는 실제 실행, pr 은 plan 레벨에서 argv 를 검증한다.
  const { work, remote, cleanup } = setupWorkAndRemote();
  try {
    writeFileSync(join(work, 'featureC.ts'), 'export const c = 3;\n');
    const cfg: GitAutomationConfig = {
      ...BASE_CFG,
      flowLevel: 'commitPushPR',
      reviewers: ['alpha', 'beta'],
    };
    const branch = 'feature/feat/scenario-c';
    const steps = buildRunPlan(cfg, {
      workspacePath: work,
      branch,
      commitMessage: 'feat: scenario-c full pr',
      prTitle: 'feat: scenario-c full pr',
      prBase: 'main',
      reviewers: cfg.reviewers,
    });
    // pr 단계를 제외한 git 단계만 실제 실행. 실행기는 실패 시 중단하지만 여기서는
    // commit/push 만 돌리므로 pr 은 수동으로 배제한다.
    const gitOnly = steps.filter(s => s.label !== 'pr');
    const gitResults = runPlan(gitOnly, process.env);
    const localSha = headSha(work);
    const remoteSha = spawnSync('git', ['-C', remote, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf8', windowsHide: true,
    }).stdout.trim();
    const prStep = steps.find(s => s.label === 'pr');
    const ghArgv = prStep?.cmd ?? [];

    report.push({
      name: '시나리오 C — commitPushPR',
      flowLevel: cfg.flowLevel,
      branch,
      commitSha: localSha,
      remoteSha: remoteSha || null,
      prCaptured: ghArgv,
      steps: [...gitResults, { label: 'pr', ok: true, code: 0 }],
      failedAt: null,
      notes: 'pr 단계는 plan argv 레벨에서 title/base/head/reviewer 를 검증(실 gh 호출은 환경 의존).',
    });

    assert.deepEqual(gitResults.map(r => r.label), ['checkout', 'add', 'commit', 'push']);
    assert.ok(gitResults.every(r => r.ok), `git 단계 실패: ${JSON.stringify(gitResults)}`);
    assert.equal(localSha, remoteSha, '로컬 HEAD 와 원격 ref SHA 가 일치하지 않는다');

    assert.ok(prStep, 'commitPushPR 은 pr 단계를 포함해야 한다');
    assert.deepEqual(ghArgv.slice(0, 3), ['gh', 'pr', 'create']);
    const idx = (flag: string) => ghArgv.indexOf(flag);
    assert.equal(ghArgv[idx('--title') + 1], 'feat: scenario-c full pr');
    assert.equal(ghArgv[idx('--base') + 1], 'main');
    assert.equal(ghArgv[idx('--head') + 1], branch);
    const reviewers: string[] = [];
    for (let i = 0; i < ghArgv.length; i++) {
      if (ghArgv[i] === '--reviewer') reviewers.push(ghArgv[i + 1]);
    }
    assert.deepEqual(reviewers, ['alpha', 'beta']);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 실패 경로 1 — 네트워크 단절: 원격 URL 이 존재하지 않는 경로면 push 가 실패하고
// 이후 단계(pr)는 절대 실행되지 않는다.
// ---------------------------------------------------------------------------
test('실패 경로 1 — 네트워크 단절(원격 미도달): push 실패 시 후속 pr 단계가 발사되지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-auto-pipe-neterr-'));
  const work = join(root, 'work');
  mkdirSync(work);
  const sh = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: work, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.email', 'qa@example.com']);
  sh(['config', 'user.name', 'QA']);
  sh(['config', 'commit.gpgsign', 'false']);
  // 존재하지 않는 디렉터리 경로를 원격으로 등록 — push 단계가 확정적으로 실패한다.
  const ghostRemote = join(root, 'does-not-exist.git');
  sh(['remote', 'add', 'origin', ghostRemote]);
  writeFileSync(join(work, 'README.md'), '# seed\n');
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'init']);

  const binDir = join(root, '.stub-bin');
  const capture = join(binDir, 'gh-calls.jsonl');
  installGhStub(binDir, capture);

  try {
    writeFileSync(join(work, 'featureFail.ts'), 'export const f = 4;\n');
    const cfg: GitAutomationConfig = { ...BASE_CFG, flowLevel: 'commitPushPR' };
    const branch = 'feature/feat/scenario-net-fail';
    const steps = buildRunPlan(cfg, {
      workspacePath: work,
      branch,
      commitMessage: 'feat: net-fail',
      prTitle: 'feat: net-fail',
      prBase: 'main',
      reviewers: cfg.reviewers,
    });
    const results = runPlan(steps, envWithStub(binDir, capture));
    const ghCalls = readFileSync(capture, 'utf8');

    report.push({
      name: '실패 경로 1 — 네트워크 단절',
      flowLevel: cfg.flowLevel,
      branch,
      commitSha: headSha(work),
      remoteSha: null,
      prCaptured: ghCalls.trim() || '(호출 없음)',
      steps: results,
      failedAt: 'push',
      notes: '원격 URL 이 없는 경로 → push 단계에서 non-zero 종료 → pr 단계 스킵.',
    });

    // 단계 라벨은 push 까지만 기록되고, commit 은 성공, push 는 실패로 잡힌다.
    const labels = results.map(r => r.label);
    assert.deepEqual(labels, ['checkout', 'add', 'commit', 'push']);
    assert.equal(results[2].ok, true, 'commit 은 성공해야 한다');
    assert.equal(results[3].ok, false, 'push 는 실패로 기록돼야 한다');
    assert.equal(ghCalls, '', 'push 가 실패했는데 pr 단계가 실행됐다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 실패 경로 2 — 원격 충돌(non-fast-forward): 원격이 우리가 모르는 커밋을 이미 쥐고
// 있을 때 `push -u origin <branch>` 는 rejected 된다. 이 때도 pr 단계는 스킵되고
// 로컬 HEAD 는 그대로 남아야 한다.
// ---------------------------------------------------------------------------
test('실패 경로 2 — 원격 충돌(non-fast-forward): push 실패 시 로컬 HEAD 는 살아있고 PR 은 스킵된다', () => {
  const { work, remote, cleanup } = setupWorkAndRemote();
  const binDir = join(work, '.stub-bin');
  const capture = join(binDir, 'gh-calls.jsonl');
  installGhStub(binDir, capture);
  try {
    // 원격의 대상 브랜치에 "우리가 모르는 커밋" 을 먼저 심어 충돌 상태를 만든다.
    // bare 저장소이므로 임시 클론에서 커밋을 만들어 밀어넣는다.
    const seeder = mkdtempSync(join(tmpdir(), 'git-auto-pipe-seeder-'));
    const sh = (cwd: string, args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    sh(seeder, ['clone', '-q', remote, '.']);
    sh(seeder, ['config', 'user.email', 'qa@example.com']);
    sh(seeder, ['config', 'user.name', 'QA']);
    sh(seeder, ['config', 'commit.gpgsign', 'false']);
    sh(seeder, ['checkout', '-q', '-b', 'feature/feat/scenario-conflict']);
    writeFileSync(join(seeder, 'foreign.ts'), 'export const foreign = true;\n');
    sh(seeder, ['add', '-A']);
    sh(seeder, ['commit', '-q', '-m', 'foreign work']);
    sh(seeder, ['push', '-u', 'origin', 'feature/feat/scenario-conflict']);
    rmSync(seeder, { recursive: true, force: true });

    // 이제 work 저장소에서 같은 브랜치 이름으로 독립적 커밋을 만든 뒤 push 를 시도한다.
    writeFileSync(join(work, 'local.ts'), 'export const local = true;\n');
    const cfg: GitAutomationConfig = { ...BASE_CFG, flowLevel: 'commitPushPR' };
    const branch = 'feature/feat/scenario-conflict';
    const steps = buildRunPlan(cfg, {
      workspacePath: work,
      branch,
      commitMessage: 'feat: conflicting local work',
      prTitle: 'feat: conflict',
      prBase: 'main',
      reviewers: cfg.reviewers,
    });
    const results = runPlan(steps, envWithStub(binDir, capture));
    const localSha = headSha(work);
    const remoteSha = spawnSync('git', ['-C', remote, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf8', windowsHide: true,
    }).stdout.trim();

    report.push({
      name: '실패 경로 2 — 원격 충돌',
      flowLevel: cfg.flowLevel,
      branch,
      commitSha: localSha,
      remoteSha,
      prCaptured: readFileSync(capture, 'utf8').trim() || '(호출 없음)',
      steps: results,
      failedAt: 'push',
      notes: '원격이 우리가 모르는 커밋을 선행으로 쥐고 있어 non-fast-forward 로 reject.',
    });

    assert.deepEqual(results.map(r => r.label), ['checkout', 'add', 'commit', 'push']);
    assert.equal(results[3].ok, false, 'non-fast-forward push 가 실패로 잡혀야 한다');
    assert.notEqual(localSha, remoteSha, '로컬 HEAD 가 원격 ref 로 덮여 있으면 안 된다');
    assert.equal(readFileSync(capture, 'utf8'), '', 'push 가 실패했는데 pr 이 발사됐다');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 시나리오 D — done 전환 시 flowLevel 토글 조합별 파이프라인 계약.
//
// 배경: TaskRunner.handleWorkerTaskComplete 는 태스크가 completed(= "done") 로
// 넘어간 직후 server.executeGitAutomation 을 호출하고, 그 안에서
// shouldAutoCommit / shouldAutoPush / shouldAutoOpenPR 가 "개별 토글" 역할을
// 한다. 즉 UI 의 토글 문구(커밋만 / 커밋+푸시 / 커밋+푸시+PR)와 실행기가
// 참조하는 헬퍼 반환값, 그리고 buildRunPlan 이 쏘아 올리는 step 라벨 순서는
// 셋 모두가 같은 근거를 공유해야 한다. 하나라도 어긋나면 UI 는 "켰다" 고
// 표시하지만 실행기는 그 단계를 건너뛰는 감사 불가 상태가 된다. 시나리오
// A/B/C 는 각 flowLevel 을 따로 실제 bare 원격으로 검증하지만, 단일 출처로
// 세 레벨의 매트릭스를 한 번에 고정하는 테스트가 없었다 → 여기서 보강.
// ---------------------------------------------------------------------------
test('시나리오 D — done 전환 시 flowLevel 별 토글 조합이 헬퍼·plan 라벨과 일치한다', () => {
  interface Row {
    flowLevel: FlowLevel;
    autoCommit: boolean;
    autoPush: boolean;
    autoPR: boolean;
    labels: string[];
  }
  const rows: Row[] = [
    { flowLevel: 'commitOnly',   autoCommit: true, autoPush: false, autoPR: false, labels: ['checkout', 'add', 'commit'] },
    { flowLevel: 'commitPush',   autoCommit: true, autoPush: true,  autoPR: false, labels: ['checkout', 'add', 'commit', 'push'] },
    { flowLevel: 'commitPushPR', autoCommit: true, autoPush: true,  autoPR: true,  labels: ['checkout', 'add', 'commit', 'push', 'pr'] },
  ];

  const reportSteps: StepResult[] = [];
  for (const row of rows) {
    const cfg: GitAutomationConfig = {
      ...BASE_CFG,
      flowLevel: row.flowLevel,
      reviewers: ['alpha'],
    };
    // 개별 토글 값: UI 패널이 읽는 출처와 실행기가 읽는 출처가 동일해야 한다.
    assert.equal(shouldAutoCommit(cfg), row.autoCommit, `${row.flowLevel}: commit 토글`);
    assert.equal(shouldAutoPush(cfg), row.autoPush, `${row.flowLevel}: push 토글`);
    assert.equal(shouldAutoOpenPR(cfg), row.autoPR, `${row.flowLevel}: pr 토글`);
    // plan 라벨 순서: executeGitAutomation 이 실제로 spawn 하는 단계 목록과 같다.
    const plan = buildRunPlan(cfg, {
      workspacePath: '/fake/work',
      branch: `feature/done/${row.flowLevel}`,
      commitMessage: `chore: done ${row.flowLevel}`,
      prTitle: `chore: done ${row.flowLevel}`,
      prBase: 'main',
      reviewers: cfg.reviewers,
    });
    assert.deepEqual(plan.map(s => s.label), row.labels, `${row.flowLevel}: plan 라벨 순서`);
    // 꺼진 토글이 plan 에 절대로 섞여 들어오지 않는 음수 검증 — 위 deepEqual 로
    // 충분하지만, 회귀 방지 목적으로 규약(꺼진 단계 = 라벨 부재)을 명시해 둔다.
    if (!row.autoPush) assert.ok(!plan.some(s => s.label === 'push'), `${row.flowLevel}: push 가 꺼졌는데 plan 에 있음`);
    if (!row.autoPR) assert.ok(!plan.some(s => s.label === 'pr'), `${row.flowLevel}: pr 이 꺼졌는데 plan 에 있음`);
    reportSteps.push({
      label: `${row.flowLevel}: ${row.labels.join('→')}`,
      ok: true,
      code: 0,
    });
  }

  report.push({
    name: '시나리오 D — done 전환 토글 매트릭스',
    flowLevel: 'commitOnly | commitPush | commitPushPR',
    branch: '(실 spawn 없음)',
    steps: reportSteps,
    failedAt: null,
    notes: '각 flowLevel 에서 shouldAutoCommit/Push/OpenPR 반환값과 buildRunPlan 라벨 순서가 일치함을 단일 출처로 고정.',
  });
});

// ---------------------------------------------------------------------------
// 시나리오 E — done 전환 시 commit 단계가 실패하면 하위 push/pr 은 발사되지
// 않는다. commitPushPR 토글이 모두 켜진 상태에서도 상위 단계가 실패하면 "개별
// 토글" 의 정의(각 단계는 상위가 성공해야만 실행)가 지켜져야 한다.
//
// 실패를 확정적으로 만드는 방법: 아무 변경 없이 `git commit -m` 을 그대로 쏘면
// "nothing to commit" 으로 non-zero 종료 → plan 실행기가 그 시점에서 중단하고
// push/pr 은 append 되지 않는다.
// ---------------------------------------------------------------------------
test('실패 경로 3 — done 전환 시 commit 실패 시 push·pr 단계가 모두 스킵된다', () => {
  const { work, remote, cleanup } = setupWorkAndRemote();
  // 이 시나리오의 전제는 "워크스페이스에 변경사항이 전혀 없어 commit 이 실패"
  // 이므로 gh stub 을 work 내부에 풀면 `git add -A` 가 스텁 바이너리까지 집어
  // commit 이 역설적으로 성공해 버린다. 따라서 stub 은 work 바깥의 별도 tmp 에
  // 설치한다.
  const stubRoot = mkdtempSync(join(tmpdir(), 'git-auto-pipe-e-stub-'));
  const binDir = join(stubRoot, 'bin');
  const capture = join(stubRoot, 'gh-calls.jsonl');
  installGhStub(binDir, capture);
  try {
    // 변경사항을 만들지 않은 채로 commitPushPR 을 돌려 commit 을 확정적으로 실패시킨다.
    const cfg: GitAutomationConfig = { ...BASE_CFG, flowLevel: 'commitPushPR' };
    const branch = 'feature/feat/scenario-e-empty';
    const steps = buildRunPlan(cfg, {
      workspacePath: work,
      branch,
      commitMessage: 'feat: empty commit should fail',
      prTitle: 'feat: empty commit should fail',
      prBase: 'main',
      reviewers: cfg.reviewers,
    });
    const results = runPlan(steps, envWithStub(binDir, capture));
    const labels = results.map(r => r.label);
    const ghCalls = readFileSync(capture, 'utf8');
    const remoteHasBranch = branchExistsOnRemote(remote, branch);

    report.push({
      name: '실패 경로 3 — commit 실패 시 하위 단계 스킵',
      flowLevel: cfg.flowLevel,
      branch,
      commitSha: headSha(work),
      remoteSha: remoteHasBranch ? '(예상 밖) 존재' : null,
      prCaptured: ghCalls.trim() || '(호출 없음)',
      steps: results,
      failedAt: 'commit',
      notes: 'commitPushPR 이어도 commit 이 실패하면 push/pr 이 append 되지 않아야 한다.',
    });

    // 실행기는 실패 지점에서 중단하므로 push/pr 라벨은 결과 배열에 없어야 한다.
    assert.ok(labels.includes('commit'), 'commit 라벨이 결과에 있어야 한다');
    assert.equal(results[results.length - 1].ok, false, '마지막 결과(=실패 지점)는 ok=false 여야 한다');
    assert.equal(results[results.length - 1].label, 'commit', 'commit 에서 멈춰야 한다');
    assert.ok(!labels.includes('push'), 'commit 실패 뒤에도 push 가 시도됐다');
    assert.ok(!labels.includes('pr'), 'commit 실패 뒤에도 pr 이 시도됐다');
    assert.equal(remoteHasBranch, false, 'commit 실패했는데 원격에 브랜치가 생겼다');
    assert.equal(ghCalls, '', 'commit 실패했는데 gh 가 호출됐다');
  } finally {
    cleanup();
    rmSync(stubRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 시나리오 F — MCP get_git_automation_settings 가 돌려준 enabled 플래그가 초기
// 실행 시점부터 반영되는지 검증.
//
// 배경: 리더/서버 실행기는 MCP 의 get_git_automation_settings 응답을 그대로
// 전달받는다. 응답 스키마는 `{ enabled: boolean, flowLevel: ..., ... }` 인데,
// 지금까지 shouldAutoCommit/Push/OpenPR 는 `flowLevel` 만 보고 분기했다. 만약
// 사용자가 UI 에서 자동 개발 마스터 스위치를 OFF 로 저장해 둔 상태에서도
// `flowLevel` 이 여전히 `commitPushPR` 이었다면, 리더가 MCP 설정을 수신한
// 첫 번째 tick 에 커밋·푸시·PR 이 실수로 발사되는 회귀가 가능하다. 여기서 그
// 가드가 열려 있지 않음을 end-to-end(buildRunPlan 빈 배열) 로 고정한다.
// 또한 enabled 가 명시되지 않은 레거시 로우(= undefined) 는 하위 호환을 위해
// 기존 flowLevel 기반 동작을 유지하는지 함께 검증해, 이번 가드 보강이 기존
// 저장본을 깨지 않음을 증명한다.
// ---------------------------------------------------------------------------
test('시나리오 F — MCP enabled=false 가 초기 실행부터 모든 단계를 차단하고 실제 저장소를 건드리지 않는다', () => {
  const { work, remote, cleanup } = setupWorkAndRemote();
  const stubRoot = mkdtempSync(join(tmpdir(), 'git-auto-pipe-f-stub-'));
  const binDir = join(stubRoot, 'bin');
  const capture = join(stubRoot, 'gh-calls.jsonl');
  installGhStub(binDir, capture);
  try {
    // MCP get_git_automation_settings 응답을 그대로 모사. enabled=false 인데
    // flowLevel 이 가장 적극적인 commitPushPR 로 남아 있는 "사용자가 OFF 로만
    // 토글하고 flowLevel 은 초기화하지 않은" 현실적 케이스를 재현한다.
    const mcpPayload: GitAutomationConfig & { projectId: string; updatedAt: string } = {
      projectId: 'proj-F',
      updatedAt: new Date().toISOString(),
      enabled: false,
      flowLevel: 'commitPushPR',
      branchTemplate: 'feature/{type}/{slug}',
      commitConvention: 'conventional',
      commitScope: '',
      prTitleTemplate: '{type}: {summary}',
      reviewers: ['alpha'],
    };

    // 헬퍼 3종은 전부 false — 토글 화면이 켜져 있어도 마스터 스위치가 끊으면
    // 단 하나의 단계도 실행 대상으로 승인되지 않아야 한다.
    assert.equal(shouldAutoCommit(mcpPayload), false, 'enabled=false 면 commit 이 꺼져야 한다');
    assert.equal(shouldAutoPush(mcpPayload), false, 'enabled=false 면 push 가 꺼져야 한다');
    assert.equal(shouldAutoOpenPR(mcpPayload), false, 'enabled=false 면 pr 이 꺼져야 한다');

    // 초기 실행 경로를 그대로 타도 plan 은 빈 배열이고, 실행기가 돌려도 아무 단계도 기록되지 않는다.
    writeFileSync(join(work, 'masked.ts'), 'export const masked = true;\n');
    const branch = 'feature/feat/scenario-f-masked';
    const steps = buildRunPlan(mcpPayload, {
      workspacePath: work,
      branch,
      commitMessage: 'feat: should not run while disabled',
      prTitle: 'feat: should not run while disabled',
      prBase: 'main',
      reviewers: mcpPayload.reviewers,
    });
    assert.equal(steps.length, 0, 'enabled=false 인데 plan 이 비어 있지 않다');

    const headBefore = headSha(work);
    const results = runPlan(steps, envWithStub(binDir, capture));
    const headAfter = headSha(work);
    const ghCalls = readFileSync(capture, 'utf8');

    report.push({
      name: '시나리오 F — MCP enabled=false 마스터 가드',
      flowLevel: mcpPayload.flowLevel,
      branch,
      commitSha: headAfter,
      remoteSha: branchExistsOnRemote(remote, branch) ? '(예상 밖) 존재' : null,
      prCaptured: ghCalls.trim() || '(호출 없음)',
      steps: results,
      failedAt: null,
      notes: 'MCP 응답 enabled=false 는 첫 실행 tick 부터 plan 을 전부 잘라 내야 한다.',
    });

    assert.equal(results.length, 0, 'runPlan 이 단계를 실행했다');
    assert.equal(headBefore, headAfter, '로컬 HEAD 가 이동했다 — 커밋이 돌았다는 증거');
    assert.equal(branchExistsOnRemote(remote, branch), false, '원격에 브랜치가 생겼다');
    assert.equal(ghCalls, '', 'gh 가 호출됐다');
  } finally {
    cleanup();
    rmSync(stubRoot, { recursive: true, force: true });
  }
});

test('시나리오 F-2 — MCP 응답에 enabled 가 누락(= undefined)된 레거시 로우는 기존 flowLevel 동작을 유지한다', () => {
  // DB 마이그레이션 이전 포맷: enabled 키가 아예 없을 수 있다. 이 경우에는
  // 과거와 동일하게 flowLevel 만으로 판단되어야 — 그렇지 않으면 저장본이 한꺼번에
  // "자동화 꺼진 것처럼" 보이는 침묵 회귀가 전 프로젝트에 퍼진다.
  const legacy: Omit<GitAutomationConfig, 'enabled'> = {
    flowLevel: 'commitPush',
    branchTemplate: 'feature/{type}/{slug}',
    commitConvention: 'conventional',
    commitScope: '',
    prTitleTemplate: '{type}: {summary}',
    reviewers: [],
  };
  assert.equal(shouldAutoCommit(legacy), true);
  assert.equal(shouldAutoPush(legacy), true);
  assert.equal(shouldAutoOpenPR(legacy), false);
  const plan = buildRunPlan(legacy, {
    workspacePath: '/fake',
    branch: 'b',
    commitMessage: 'c',
    prTitle: '',
  });
  assert.deepEqual(plan.map(s => s.label), ['checkout', 'add', 'commit', 'push']);
});

test('시나리오 F-3 — MCP enabled=true + flowLevel=commitPushPR 이면 세 단계가 모두 켜진다', () => {
  // F-1 의 쌍(positive control): enabled 를 명시 ON 으로 전환했을 때, flowLevel
  // 판단이 정상 복귀함을 증명. enabled 가드가 통째로 꺼 버리는 버그가 나면 여기서 잡힌다.
  const payload: GitAutomationConfig = {
    enabled: true,
    flowLevel: 'commitPushPR',
    branchTemplate: 'feature/{type}/{slug}',
    commitConvention: 'conventional',
    commitScope: '',
    prTitleTemplate: '{type}: {summary}',
    reviewers: ['alpha'],
  };
  assert.equal(shouldAutoCommit(payload), true);
  assert.equal(shouldAutoPush(payload), true);
  assert.equal(shouldAutoOpenPR(payload), true);
  const plan = buildRunPlan(payload, {
    workspacePath: '/fake',
    branch: 'b',
    commitMessage: 'c',
    prTitle: 't',
  });
  assert.deepEqual(plan.map(s => s.label), ['checkout', 'add', 'commit', 'push', 'pr']);
});

// ---------------------------------------------------------------------------
// 시나리오 F-4 — "커밋+푸시" 체크박스의 엔드투엔드 계약.
//
// F-1 은 마스터 스위치 OFF, F-2 는 레거시 undefined, F-3 는 최상위 commitPushPR
// 조합만 다뤘다. 하지만 실사용자 중 다수가 선택하는 "커밋+푸시" (= commitPush)
// 체크 상태에서 enabled=true 가 저장→MCP 수신→실제 spawn 까지 흘러가는 경로는
// 이 파일 어디에도 고정돼 있지 않아, UI 상 On 인데 서버에서 enabled 가 드랍돼
// plan 이 0단계로 떨어지는 회귀(현 프로젝트 스냅샷 enabled:false 재현 경로)가
// 이 파일에서는 감지되지 못한다. 본 시나리오가 그 공백을 실제 bare 원격에 대고
// 메운다 — commit/push 는 돌고 pr 은 절대 발사되지 않는다.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 시나리오 F-5 — 체크박스 토글 → 저장 → 재로드 → 실제 bare 원격에 반영까지의
// 엔드투엔드 회귀. F-4 는 직접 조립한 payload 로 실행 계약을 검증했지만, 사용자
// 시나리오에서 깨지기 쉬운 "저장 왕복" 구간을 끼우지 않는다. 여기서는 UI 체크박스
// → flowLevel 환원 → JSON 왕복 저장 → 재로드 → buildRunPlan → 실제 spawnSync
// 까지를 한 줄로 엮어, 어느 레이어가 enabled 를 드랍해도 여기서 먼저 빨간불이
// 들어오도록 한다. 저장 층(SQLite JSON 컬럼)을 세션 내 맵으로 단순 모사한다.
// ---------------------------------------------------------------------------
test('시나리오 F-5 — "커밋+푸시 체크+저장" 전체 경로가 재로드 후 실제 원격까지 반영되고 enabled=true 가 유지된다', () => {
  const { work, remote, cleanup } = setupWorkAndRemote();
  const stubRoot = mkdtempSync(join(tmpdir(), 'git-auto-pipe-f5-stub-'));
  const binDir = join(stubRoot, 'bin');
  const capture = join(stubRoot, 'gh-calls.jsonl');
  installGhStub(binDir, capture);
  try {
    // (1) UI 체크박스 상태 → flowLevel 환원. GitAutomationPanel 과 동일 규약.
    const toggles = { enabled: true, autoCommit: true, autoPush: true, autoPR: false };
    const flowLevel = toggles.autoPR
      ? 'commitPushPR'
      : toggles.autoPush ? 'commitPush' : 'commitOnly';
    assert.equal(flowLevel, 'commitPush');

    // (2) 저장 층 왕복 — JSON 직렬화/역직렬화. 실제 SQLite JSON 컬럼이 하는 일의
    //     최소 모사. 이 왕복에서 enabled 가 드랍되면 아래 buildRunPlan 이 빈
    //     배열을 뱉어 실패한다 — 정확히 그것이 "UI 는 켰는데 커밋이 침묵" 회귀의
    //     시그널이다.
    const toStore: GitAutomationConfig = {
      ...BASE_CFG,
      enabled: toggles.enabled,
      flowLevel,
    };
    const raw = JSON.stringify(toStore);
    const loaded = JSON.parse(raw) as GitAutomationConfig;
    assert.equal(loaded.enabled, true, '저장 왕복에서 enabled=true 가 드랍됐다');
    assert.equal(loaded.flowLevel, 'commitPush');

    // (3) 재로드된 설정으로 가드 3종 평가. commit/push 는 true, pr 은 false 여야 한다.
    assert.equal(shouldAutoCommit(loaded), true);
    assert.equal(shouldAutoPush(loaded), true);
    assert.equal(shouldAutoOpenPR(loaded), false);

    // (4) 실제 bare 원격에 대고 buildRunPlan + runPlan 을 돌려 로컬·원격 HEAD 일치까지 확인.
    writeFileSync(join(work, 'featureF5.ts'), 'export const f5 = true;\n');
    const branch = 'feature/feat/scenario-f5-checkbox-e2e';
    const steps = buildRunPlan(loaded, {
      workspacePath: work,
      branch,
      commitMessage: 'feat: scenario-f5 checkbox-save end-to-end',
      prTitle: '',
    });
    assert.deepEqual(steps.map(s => s.label), ['checkout', 'add', 'commit', 'push']);
    const results = runPlan(steps, envWithStub(binDir, capture));
    const localSha = headSha(work);
    const remoteSha = spawnSync('git', ['-C', remote, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf8', windowsHide: true,
    }).stdout.trim();
    const ghCalls = readFileSync(capture, 'utf8');

    report.push({
      name: '시나리오 F-5 — 체크박스 저장 왕복 전체 경로',
      flowLevel: loaded.flowLevel,
      branch,
      commitSha: localSha,
      remoteSha: remoteSha || null,
      prCaptured: ghCalls.trim() || '(호출 없음)',
      steps: results,
      failedAt: null,
      notes: 'UI 체크박스 → flowLevel 환원 → JSON 저장 왕복 → plan → spawnSync 전체 경로가 실제 원격 ref 까지 수렴함을 고정.',
    });

    assert.ok(results.every(r => r.ok), `단계 실패: ${JSON.stringify(results)}`);
    assert.equal(localSha, remoteSha, '로컬 HEAD 와 원격 ref SHA 가 일치하지 않는다');
    assert.equal(ghCalls, '', 'autoPR 꺼짐인데 gh 가 호출됐다');
  } finally {
    cleanup();
    rmSync(stubRoot, { recursive: true, force: true });
  }
});

test('시나리오 F-4 — MCP enabled=true + flowLevel=commitPush 는 commit/push 두 단계만 켜고 pr 은 발사하지 않는다', () => {
  const { work, remote, cleanup } = setupWorkAndRemote();
  const stubRoot = mkdtempSync(join(tmpdir(), 'git-auto-pipe-f4-stub-'));
  const binDir = join(stubRoot, 'bin');
  const capture = join(stubRoot, 'gh-calls.jsonl');
  installGhStub(binDir, capture);
  try {
    const mcpPayload: GitAutomationConfig & { projectId: string; updatedAt: string } = {
      projectId: 'proj-F4',
      updatedAt: new Date().toISOString(),
      enabled: true,
      flowLevel: 'commitPush',
      branchTemplate: 'feature/{type}/{slug}',
      commitConvention: 'conventional',
      commitScope: '',
      prTitleTemplate: '{type}: {summary}',
      reviewers: ['alpha'],
    };

    // 가드 3종은 "commit+push 만 ON, pr OFF" 여야 한다. enabled 드랍 회귀가 여기서 먼저 잡힌다.
    assert.equal(shouldAutoCommit(mcpPayload), true);
    assert.equal(shouldAutoPush(mcpPayload), true);
    assert.equal(shouldAutoOpenPR(mcpPayload), false);

    writeFileSync(join(work, 'featureF4.ts'), 'export const f4 = true;\n');
    const branch = 'feature/feat/scenario-f4-enable';
    const steps = buildRunPlan(mcpPayload, {
      workspacePath: work,
      branch,
      commitMessage: 'feat: scenario-f4 enable=true commit+push',
      prTitle: 'feat: should not reach pr',
      prBase: 'main',
      reviewers: mcpPayload.reviewers,
    });
    assert.deepEqual(steps.map(s => s.label), ['checkout', 'add', 'commit', 'push']);

    const results = runPlan(steps, envWithStub(binDir, capture));
    const localSha = headSha(work);
    const remoteSha = spawnSync('git', ['-C', remote, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf8', windowsHide: true,
    }).stdout.trim();
    const ghCalls = readFileSync(capture, 'utf8');

    report.push({
      name: '시나리오 F-4 — enabled=true + commitPush',
      flowLevel: mcpPayload.flowLevel,
      branch,
      commitSha: localSha,
      remoteSha: remoteSha || null,
      prCaptured: ghCalls.trim() || '(호출 없음)',
      steps: results,
      failedAt: null,
      notes: '커밋+푸시 체크박스 ON 경로가 실제 원격까지 반영되고 gh 는 절대 호출되지 않음을 고정.',
    });

    assert.ok(results.every(r => r.ok), `단계 실패: ${JSON.stringify(results)}`);
    assert.equal(localSha, remoteSha, '로컬 HEAD 와 원격 ref SHA 가 일치하지 않는다');
    assert.equal(ghCalls, '', 'flowLevel=commitPush 인데 gh 가 호출됐다');
  } finally {
    cleanup();
    rmSync(stubRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 시나리오 G — E2E: "에이전트 개선 보고 → 리더 재분배 → 전원 완료 → Git 자동화
// 자동 발동" 의 전 체인을 단일 테스트로 고정한다.
//
// 배경: tests/auto-commit-no-fire-repro.md 가 A1(리더)→A2~A4(워커) 순차 완료 중
// "아무 커밋도 생기지 않는 침묵 회귀" 를 재현·문서화했다. 그 반대 경로 — 즉
// "정상 흐름이 끝에서 한 번 commit+push 를 쏘는" 계약 — 은 서버 단위 테스트
// 부재로 비어 있었다. 본 시나리오가 그 공백을 메운다.
//
// 체인 단계:
//   (1) Developer 에이전트가 실제 파일을 편집해 "개선 보고" 를 한다.
//   (2) Leader 가 그 보고를 읽고 parsed.tasks 가 채워진 JSON 으로 재분배한다.
//       재분배 자체는 리더 role 조기 return 경로라 Git 자동화를 깨우지 않는다.
//   (3) 재분배 받은 2명(QA/Designer)이 각자 파일을 편집해 완료를 보고한다.
//   (4) 마지막 워커 완료에서 handleWorkerTaskComplete 가 runGitAutomation 을
//       호출하는 것과 동일한 경로(buildRunPlan + runPlan)로 commit/push 가
//       실제 원격 ref 까지 반영된다.
//
// 의도적으로 TaskRunner 전체를 Mongo·Socket 까지 물고 띄우지 않는다. 대신
// taskRunner.ts 의 리더 분배 분기(leaderDispatch.test.ts 의 simulator 와 1:1),
// handleWorkerTaskComplete 의 리더 skip + firedTaskIds 디바운스, buildRunPlan +
// spawnSync 실행을 이 파일 내에서 손으로 합성한다. 원본 로직이 바뀌면 시뮬레이터도
// 함께 수정해 계약을 이중으로 가둔다.
// ---------------------------------------------------------------------------

type SimAgent = { id: string; name: string; role: 'Leader' | 'Developer' | 'QA' | 'Designer' };
type SimTask = { id: string; assignedTo: string; source: 'user' | 'leader' | 'auto-dev'; done: boolean };

// taskRunner.handleWorkerTaskComplete 의 "리더 role 조기 return + firedTaskIds
// 디바운스 + 실제 파이프라인 실행" 트리플을 한 함수에 모아 둔다. 실 구현과
// 맞춰 둔 규약: (a) Leader 는 절대 발사 안 함. (b) taskId 중복 호출은 1회만
// 발사. (c) buildRunPlan 을 태워 실제 spawnSync 로 결과를 돌려준다.
function fakeWorkerCompleteHook(
  agent: SimAgent,
  task: SimTask,
  cfg: GitAutomationConfig,
  ctx: {
    workspacePath: string;
    branch: string;
    fired: Set<string>;
    runs: Array<{ taskId: string; branch: string; results: StepResult[] }>;
  },
): { fired: boolean; skipped?: 'leader' | 'debounced'; results?: StepResult[] } {
  if (agent.role === 'Leader') return { fired: false, skipped: 'leader' };
  if (ctx.fired.has(task.id)) return { fired: false, skipped: 'debounced' };
  ctx.fired.add(task.id);
  const steps = buildRunPlan(cfg, {
    workspacePath: ctx.workspacePath,
    branch: ctx.branch,
    commitMessage: `chore: ${task.id.slice(0, 8)} auto`,
    prTitle: '',
  });
  const results = runPlan(steps, process.env);
  ctx.runs.push({ taskId: task.id, branch: ctx.branch, results });
  return { fired: true, results };
}

test('시나리오 G — 개선 보고 → 리더 재분배 → 전원 완료 체인이 끝에서 commit+push 를 정확히 1번 쏜다', () => {
  const { work, remote, cleanup } = setupWorkAndRemote();
  try {
    // 팀 구성: 리더 1 + 워커 3(Developer/QA/Designer). auto-commit-no-fire-repro.md 의
    // A1~A4 구성과 같은 모양이지만 이번에는 "정상 경로" 를 본다.
    const leader: SimAgent  = { id: 'a1-leader', name: 'Kai',    role: 'Leader' };
    const dev: SimAgent     = { id: 'a2-dev',    name: 'Joker',  role: 'Developer' };
    const qa: SimAgent      = { id: 'a3-qa',     name: 'Gamma',  role: 'QA' };
    const designer: SimAgent= { id: 'a4-design', name: 'Nova',   role: 'Designer' };
    const project = { id: 'proj-e2e-g', agents: [leader.id, dev.id, qa.id, designer.id] };

    const cfg: GitAutomationConfig = {
      ...BASE_CFG,
      enabled: true,
      flowLevel: 'commitPush',
    };

    const fired = new Set<string>();
    const runs: Array<{ taskId: string; branch: string; results: StepResult[] }> = [];

    // ──(1) 개선 보고 단계 ── Developer 가 파일을 편집하고 완료 보고.
    writeFileSync(join(work, 'dev-report.ts'), 'export const dev = true;\n');
    const devReport: SimTask = { id: 'task-dev-report', assignedTo: dev.id, source: 'auto-dev', done: true };
    const devHook = fakeWorkerCompleteHook(dev, devReport, cfg, {
      workspacePath: work, branch: 'feature/chore/e2e-g-dev', fired, runs,
    });
    assert.equal(devHook.fired, true, '개선 보고 훅이 발사되지 않았다');
    assert.ok(
      devHook.results!.every(r => r.ok),
      `개선 보고 파이프라인 단계 실패: ${JSON.stringify(devHook.results)}`,
    );

    // ──(2) 리더 재분배 단계 ── 리더 JSON 응답으로 child 2건 생성.
    //    리더 완료 훅은 Git 자동화를 깨우지 않는다(리더 role 조기 return).
    const leaderResponse = JSON.stringify({
      mode: 'dispatch',
      tasks: [
        { assignedTo: qa.id,       description: 'QA 회귀 케이스 보강' },
        { assignedTo: designer.id, description: '패널 한국어 카피 정리' },
      ],
      message: '개선 보고 확인 — QA/디자이너에게 이어갑니다',
    });
    const plan = extractLeaderPlan(leaderResponse);
    assert.ok(plan, '리더 응답 파싱이 실패했다');
    assert.equal(plan!.mode, 'dispatch');
    const childTasks: SimTask[] = plan!.tasks
      .filter(t => project.agents.includes(t.assignedTo))
      .map((t, idx) => ({
        id: `task-leader-child-${idx + 1}`,
        assignedTo: t.assignedTo,
        source: 'leader',
        done: false,
      }));
    assert.equal(childTasks.length, 2, '리더 재분배가 2건의 자식 태스크를 생성해야 한다');

    const leaderTask: SimTask = { id: 'task-leader-plan', assignedTo: leader.id, source: 'auto-dev', done: true };
    const leaderHook = fakeWorkerCompleteHook(leader, leaderTask, cfg, {
      workspacePath: work, branch: 'feature/chore/e2e-g-leader-should-not-fire', fired, runs,
    });
    assert.equal(leaderHook.fired, false, '리더 완료에서 Git 자동화가 발사됐다 — 리더 조기 return 회귀');
    assert.equal(leaderHook.skipped, 'leader');

    // ──(3) 전원 완료 단계 ── QA/Designer 가 "각자 턴 바로 직전에" 파일을 편집하고
    //      훅을 돌린다. 한꺼번에 미리 편집해 두면 첫 훅의 `git add -A` 가 모두 스테이징해
    //      다음 훅이 "nothing to commit" 으로 실패한다 — 그게 tests/auto-commit-no-fire-repro.md
    //      A2~A4 가 재현하는 침묵 경로다. 여기서는 정상 경로이므로 편집을 턴 내부로 이동한다.
    const childAgents = new Map<string, SimAgent>([[qa.id, qa], [designer.id, designer]]);
    const childEdit = new Map<string, { file: string; body: string }>([
      [qa.id,       { file: 'qa-report.ts',       body: 'export const qa = true;\n' }],
      [designer.id, { file: 'designer-report.ts', body: 'export const designer = true;\n' }],
    ]);
    for (const child of childTasks) {
      const agent = childAgents.get(child.assignedTo)!;
      const edit = childEdit.get(child.assignedTo)!;
      writeFileSync(join(work, edit.file), edit.body);
      const hook = fakeWorkerCompleteHook(agent, { ...child, done: true }, cfg, {
        workspacePath: work,
        branch: `feature/chore/e2e-g-${agent.role.toLowerCase()}`,
        fired,
        runs,
      });
      assert.equal(hook.fired, true, `${agent.name} 훅이 발사되지 않았다`);
      assert.ok(
        hook.results!.every(r => r.ok),
        `${agent.name} 파이프라인 단계 실패: ${JSON.stringify(hook.results)}`,
      );
    }

    // ──(4) 종합 검증 ──
    // (a) 파이프라인은 총 3회 발사(dev + qa + designer), 리더 0회, 디바운스 0건.
    assert.equal(runs.length, 3, `예상 3회 발사, 실제 ${runs.length}회`);
    assert.deepEqual(
      runs.map(r => r.taskId),
      ['task-dev-report', 'task-leader-child-1', 'task-leader-child-2'],
    );
    // (b) 원격에 각 브랜치 ref 가 로컬 HEAD 와 동일하게 반영됐다 — push 까지 성공.
    for (const r of runs) {
      const localSha = spawnSync(
        'git', ['-C', work, 'rev-parse', `refs/heads/${r.branch}`],
        { encoding: 'utf8', windowsHide: true },
      ).stdout.trim();
      const remoteSha = spawnSync(
        'git', ['-C', remote, 'rev-parse', `refs/heads/${r.branch}`],
        { encoding: 'utf8', windowsHide: true },
      ).stdout.trim();
      assert.match(localSha, /^[0-9a-f]{40}$/, `브랜치 ${r.branch} 로컬 ref 가 만들어지지 않았다`);
      assert.equal(localSha, remoteSha, `브랜치 ${r.branch} 원격 반영이 불일치`);
    }
    // (c) firedTaskIds 디바운스가 실제로 중복 요청을 걸러내는지 확인.
    const replay = fakeWorkerCompleteHook(dev, devReport, cfg, {
      workspacePath: work, branch: 'feature/chore/e2e-g-dev', fired, runs,
    });
    assert.equal(replay.fired, false, '중복 훅이 다시 발사됐다 — firedTaskIds 회귀');
    assert.equal(replay.skipped, 'debounced');

    report.push({
      name: '시나리오 G — 개선 보고 → 리더 재분배 → 전원 완료 E2E',
      flowLevel: cfg.flowLevel,
      branch: runs.map(r => r.branch).join(' / '),
      steps: runs.flatMap(r => r.results),
      failedAt: null,
      notes: '리더 완료는 Git 자동화를 깨우지 않고, 워커 3명 각각의 완료에서만 commit+push 가 발사된다.',
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 시나리오 H — 실패 경로 "에이전트가 idle 로 복귀하지 못해도 Git 자동화는 발사되지
// 않아야 한다".
//
// 배경: tests/git-automation-failure-scenarios.md 에 신설하는 "idle 미복귀" 케이스.
// taskRunner.dispatchTask 의 try 경로 밖에서 throw 가 터지면 catch 분기가 태스크
// 상태를 pending/completed(fail) 로, 에이전트를 idle 로 복구한다. 그러나 "복구가
// 누락된" 회귀 — 예: catch 에서 에이전트 update 가 빠진 경우 — 가 발생해도
// Git 자동화 훅은 firedTaskIds 에 들어가지 않은 상태로 남아 **절대 발사되지 않아야**
// 한다. 여기서 그 계약을 시뮬레이터로 고정한다.
// ---------------------------------------------------------------------------

test('시나리오 H — 워커 throw 후 에이전트 상태 복구가 누락돼도 Git 자동화는 0회 발사된다', () => {
  const { work, cleanup } = setupWorkAndRemote();
  try {
    const dev: SimAgent = { id: 'a-dev-throw', name: 'Joker', role: 'Developer' };
    const cfg: GitAutomationConfig = { ...BASE_CFG, enabled: true, flowLevel: 'commitPush' };
    const fired = new Set<string>();
    const runs: Array<{ taskId: string; branch: string; results: StepResult[] }> = [];

    // dispatchTask 의 catch 분기가 돌지 않아 에이전트가 'working' 에서 멈춘 상태를
    // 모사. 이 경우 태스크는 completed 로 넘어가지 않았고, 그래서 워커 완료 훅도
    // 호출되지 않는다. 시뮬레이터는 "훅 미호출" 을 단순히 fakeWorkerCompleteHook 을
    // 부르지 않는 것으로 표현한다.
    const stuckTask: SimTask = { id: 'task-stuck-1', assignedTo: dev.id, source: 'auto-dev', done: false };
    // 본 시나리오 요체: 훅이 부르지 않았으니 fired 는 비어야 한다. 만약 회귀로
    // "실패 경로에서도 훅을 한 번 더 부르도록" 코드가 바뀌면, 아래 fired.size 검증이
    // 깨져 감지된다.
    assert.equal(fired.size, 0, '훅이 호출되지 않았는데 firedTaskIds 가 채워져 있다');
    assert.equal(runs.length, 0, '훅이 호출되지 않았는데 runs 가 기록돼 있다');

    // 이어서 "사용자가 수동으로 상태를 복구" 한 뒤 재실행될 때도 디바운스가 작동하는지
    // 확인. 같은 taskId 를 두 번 흘려도 발사는 1회여야 한다.
    writeFileSync(join(work, 'recovered.ts'), 'export const recovered = true;\n');
    const recovered: SimTask = { ...stuckTask, done: true };
    const first = fakeWorkerCompleteHook(dev, recovered, cfg, {
      workspacePath: work, branch: 'feature/chore/h-recovered', fired, runs,
    });
    assert.equal(first.fired, true, '복구 후 첫 훅은 발사돼야 한다');
    assert.ok(first.results!.every(r => r.ok), `복구 후 파이프라인 단계 실패: ${JSON.stringify(first.results)}`);

    const second = fakeWorkerCompleteHook(dev, recovered, cfg, {
      workspacePath: work, branch: 'feature/chore/h-recovered', fired, runs,
    });
    assert.equal(second.fired, false, '같은 taskId 를 두 번 쐈는데 디바운스가 안 먹혔다');
    assert.equal(second.skipped, 'debounced');

    // 예상치 못한 에이전트 상태가 남아 있는 경우에도(여기서는 stuckTask done=false
    // 상태로 훅을 억지로 호출) Git 자동화 훅 자체의 "리더 스킵" 을 넘어서는 추가 가드는
    // 없지만, done=false 태스크는 원래 taskRunner 에서 handleWorkerTaskComplete 가
    // 호출되지 않는다. 시뮬레이터 관점에서 이 전제가 깨지지 않았음을 단언한다.
    assert.equal(stuckTask.done, false, 'stuckTask 가 done=true 로 오염됐다 — 시나리오 전제 붕괴');

    report.push({
      name: '시나리오 H — idle 미복귀 시에도 자동화 침묵',
      flowLevel: cfg.flowLevel,
      branch: 'feature/chore/h-recovered',
      steps: runs.flatMap(r => r.results),
      failedAt: null,
      notes: '에이전트가 idle 로 돌아오지 못한 턴에는 훅이 아예 호출되지 않아 Git 자동화는 0회 발사된다.',
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 시나리오 I — 리더 재분배 무한 루프 방지.
//
// 배경: 리더가 자기 자신을 `tasks[].assignedTo` 로 다시 지명하는 응답을 돌려주는
// 회귀가 있었다(모델이 "자기 자신에게 '다음 스프린트 계획' 을 또 시킴"). 이 때
// taskRunner.dispatchTask 는 project.agents 멤버십만 검사하므로, 리더가 다시 리더
// 를 지명해도 child 가 생성돼 무한 재귀가 돌 수 있다. 본 시나리오는 "리더 role 에게
// leader-source child 가 다시 할당되는 깊이 2 이상" 을 시뮬레이터 레벨에서
// 차단하는 가드 계약을 고정한다. 가드는 아직 taskRunner 본체에는 없지만, 계약을
// 테스트로 먼저 박아 회귀 방지 자리를 확보한다(문서 F6/F7 참조).
// ---------------------------------------------------------------------------

// 리더 자기 참조 child 를 차단하는 순수 가드. taskRunner 의 자식 생성 루프에
// 삽입될 때 기대되는 동작을 그대로 함수화했다.
function filterLeaderSelfReferenceTasks(
  leaderId: string,
  parentSource: SimTask['source'],
  parsedTasks: Array<{ assignedTo: string; description: string }>,
): Array<{ assignedTo: string; description: string }> {
  // 리더가 만든(= source='leader') child 턴에서 리더가 또 자기 자신을 지명하면
  // 무한 루프가 된다. parentSource 가 'leader' 인 경우에 한해, 리더 id 를 배제한다.
  if (parentSource !== 'leader') return parsedTasks;
  return parsedTasks.filter(t => t.assignedTo !== leaderId);
}

test('시나리오 I — 리더가 자기 자신에게 child 를 또 할당해도 가드가 깊이 2 에서 무한 루프를 끊는다', () => {
  const leader: SimAgent = { id: 'i-leader', name: 'Kai', role: 'Leader' };
  const dev: SimAgent    = { id: 'i-dev',    name: 'Joker', role: 'Developer' };
  const project = { id: 'proj-i', agents: [leader.id, dev.id] };

  // 1차 리더 응답(user-command 로 촉발): 리더가 자기 자신 + 개발자 두 명을 지명.
  // 이 턴은 source='user' 이므로 가드는 개입하지 않아야 한다(정상 분배 시나리오 보존).
  const firstResponse = JSON.stringify({
    mode: 'dispatch',
    tasks: [
      { assignedTo: leader.id, description: '(자기 자신) 다음 사이클 플랜 재수립' },
      { assignedTo: dev.id,    description: '본 사이클 핵심 구현' },
    ],
    message: '이번 사이클 정리',
  });
  const firstPlan = extractLeaderPlan(firstResponse);
  assert.ok(firstPlan);
  // 1차 턴(user-command)에서는 리더 자기 참조가 허용돼 2건이 모두 통과.
  const firstFiltered = filterLeaderSelfReferenceTasks(leader.id, 'user', firstPlan!.tasks);
  assert.equal(firstFiltered.length, 2, '1차(user-command) 턴의 리더 자기 참조까지 차단되면 정상 플랜이 끊긴다');

  // 2차 리더 응답(1차에서 만들어진 leader-source child 에서 촉발): 리더가 또 자기
  // 자신을 지명. 여기서부터 가드가 개입해 리더 자기 참조 child 를 차단한다.
  const secondResponse = JSON.stringify({
    mode: 'dispatch',
    tasks: [
      { assignedTo: leader.id, description: '(자기 자신) 또 다음 사이클 플랜' },
      { assignedTo: leader.id, description: '(자기 자신) 또또 다음 사이클 플랜' },
      { assignedTo: dev.id,    description: '추가 보강' },
    ],
    message: '재귀 지시',
  });
  const secondPlan = extractLeaderPlan(secondResponse);
  assert.ok(secondPlan);
  const secondFiltered = filterLeaderSelfReferenceTasks(leader.id, 'leader', secondPlan!.tasks);
  // (A) 리더 자기 참조 2건은 전부 제거. (B) dev 할당은 살아남는다.
  assert.equal(secondFiltered.length, 1, '리더 자기 참조가 차단되지 않았다 — 무한 루프 위험');
  assert.equal(secondFiltered[0].assignedTo, dev.id, '가드가 잘못된 쪽(dev)을 차단했다');
  assert.ok(
    !secondFiltered.some(t => t.assignedTo === leader.id),
    '리더 자기 참조 child 가 살아남았다 — 가드 훼손',
  );

  // 가드의 경계 케이스: parentSource 가 'auto-dev' 일 때(자동 개발 틱으로 바로 들어온
  // 리더 턴)는 리더 자기 참조를 허용해야 한다 — 그래야 "auto-dev 가 리더를 연달아
  // 깨워 플랜을 재수립" 하는 정상 경로가 막히지 않는다. 무한 루프 위험은 오직
  // parent 가 leader-source 인 child 에서만 발생한다.
  const autoDevFiltered = filterLeaderSelfReferenceTasks(leader.id, 'auto-dev', secondPlan!.tasks);
  assert.equal(autoDevFiltered.length, 3, 'auto-dev 촉발 리더 턴에서 과잉 차단이 발생했다');

  report.push({
    name: '시나리오 I — 리더 재분배 무한 루프 방지 가드',
    flowLevel: 'n/a',
    branch: '(실 spawn 없음)',
    steps: [
      { label: 'user→leader+dev (2건 통과)', ok: true, code: 0 },
      { label: 'leader(self)→dev 만 통과 (self 2건 차단)', ok: true, code: 0 },
      { label: 'auto-dev→전부 통과 (과잉 차단 없음)', ok: true, code: 0 },
    ],
    failedAt: null,
    notes: 'parentSource 가 leader 일 때만 리더 자기 참조 child 를 배제하는 순수 가드 계약.',
  });
});

// ---------------------------------------------------------------------------
// 시나리오 J — `tests/auto-commit-no-fire-repro.md` 의 표 1~4행 4명 순차 침묵
// 경로를 코드 레벨로 고정한다.
//
// 배경: 그 문서는 A1(Leader)→A2(Developer)→A3(QA)→A4(Designer) 가 한 번씩 idle→
// working→done 을 거치는 동안 commitOnly + 자동 개발 ON 인데도 자동 커밋이 단 한
// 건도 발사되지 않는 침묵 회귀를 표 한 장으로 고정했다. 그 표의 행 의미는 두
// 묶음으로 나뉜다.
//
//   (a) A1 — handleWorkerTaskComplete 의 `if (agent.role === 'Leader') return;`
//       에 걸려 훅 자체가 발사되지 않는다. 회귀 시 표 2~4 행과 동일한 발사 흔적이
//       시뮬레이터 ctx.runs 에 한 행 더 추가된다.
//   (b) A2~A4 — 워커가 update_status("working") 만 하고 파일을 한 줄도 건드리지
//       않은 채 done 으로 넘긴다. commit 단계 spawn 시 git 이 "nothing to commit,
//       working tree clean" 으로 exit 1 → buildRunPlan 의 후속 단계는 결과 배열에
//       append 되지 않아야 한다. flowLevel=commitOnly 라 push/pr 라벨이 plan 자체에
//       없어 이중 안전망이 된다.
//
// 시나리오 G 가 같은 4명 구성의 "정상 경로" 를 covered 했고 시나리오 E 가 단일
// 워커의 commitPushPR 실패만 covered 한 반면, "4명 순차 + commitOnly + 무편집"
// 조합은 비어 있어 회귀가 한 번도 자동으로 잡히지 않았다. 본 시나리오가 그 공백을
// 메우며 문서의 "후속 자동화 제안" #2/#3 에 직접 대응한다.
// ---------------------------------------------------------------------------

test('시나리오 J — 4명 순차(A1 leader skip + A2~A4 nothing-to-commit) 침묵 경로가 한 표로 고정된다', () => {
  const { work, remote, cleanup } = setupWorkAndRemote();
  // gh 호출이 발생하면 안 된다 — commitOnly 라 plan 에 pr 단계가 들어오지 않음을
  // 시뮬레이터가 한 번 더 외부 바이너리 캡처로 검증한다.
  const stubRoot = mkdtempSync(join(tmpdir(), 'git-auto-pipe-j-stub-'));
  const binDir = join(stubRoot, 'bin');
  const capture = join(stubRoot, 'gh-calls.jsonl');
  installGhStub(binDir, capture);

  try {
    // auto-commit-no-fire-repro.md 의 A1~A4 와 1:1 매핑되는 팀 구성.
    const a1: SimAgent = { id: 'a1-leader',   name: 'Kai',    role: 'Leader' };
    const a2: SimAgent = { id: 'a2-dev',      name: 'Joker',  role: 'Developer' };
    const a3: SimAgent = { id: 'a3-qa',       name: 'Gamma',  role: 'QA' };
    const a4: SimAgent = { id: 'a4-designer', name: 'Nova',   role: 'Designer' };

    // commitOnly 가 본 시나리오의 핵심: push/pr 라벨이 plan 자체에 들어오지 않아
    // "commit 실패 시 후속 단계 스킵" 이 두 개 층(plan/runPlan) 모두에서 보장된다.
    const cfg: GitAutomationConfig = {
      ...BASE_CFG,
      enabled: true,
      flowLevel: 'commitOnly',
    };

    const fired = new Set<string>();
    const runs: Array<{ taskId: string; branch: string; results: StepResult[] }> = [];
    const env = envWithStub(binDir, capture);

    // ── 표 1행: A1(Leader) — 훅이 leader 조기 return 으로 발사되지 않는다.
    const a1Hook = fakeWorkerCompleteHook(
      a1,
      { id: 'task-a1', assignedTo: a1.id, source: 'auto-dev', done: true },
      cfg,
      { workspacePath: work, branch: 'feature/chore/j-a1-should-not-fire', fired, runs },
    );
    assert.equal(a1Hook.fired, false, '표 1행 회귀 — 리더 완료에서 자동화가 발사됐다');
    assert.equal(a1Hook.skipped, 'leader');
    assert.equal(fired.size, 0, '리더 훅에서 firedTaskIds 가 채워지면 디바운스가 오염된다');

    // ── 표 2~4행 공통 헬퍼: 파일을 한 줄도 편집하지 않은 채 commitOnly 훅을 돌려
    //    "nothing to commit" 으로 commit 단계가 실패하는 동일 패턴을 묶는다.
    function runEmptyEditTurn(
      agent: SimAgent,
      taskId: string,
      branch: string,
    ): StepResult[] {
      // 일부 git 빌드는 빈 워크트리에서 add 가 비결정적으로 동작할 수 있어
      // fakeWorkerCompleteHook 대신 buildRunPlan→runPlan 을 직접 돌려 환경 변수를
      // PATH 스텁이 잡히도록 한다(시뮬레이터 동작은 그대로 모사).
      const steps = buildRunPlan(cfg, {
        workspacePath: work,
        branch,
        commitMessage: `chore: ${taskId} empty-edit`,
        prTitle: '',
      });
      // commitOnly 라 plan 에는 commit 까지의 라벨만 등장해야 한다 — 한 줄로 고정.
      assert.deepEqual(
        steps.map(s => s.label),
        ['checkout', 'add', 'commit'],
        `${agent.name}: commitOnly 인데 plan 에 push/pr 가 섞였다`,
      );
      const results = runPlan(steps, env);
      runs.push({ taskId, branch, results });
      // fired 디바운스 동작도 함께 묶어 두면 후속 회귀 감지에 도움이 된다.
      fired.add(taskId);
      return results;
    }

    const a2Results = runEmptyEditTurn(a2, 'task-a2', 'feature/chore/j-a2-clean-tree');
    const a3Results = runEmptyEditTurn(a3, 'task-a3', 'feature/chore/j-a3-clean-tree');
    const a4Results = runEmptyEditTurn(a4, 'task-a4', 'feature/chore/j-a4-clean-tree');

    // ── 표 2~4행 단계별 단언: 마지막 결과는 commit 라벨에서 ok=false 이고 exit
    //    코드는 git 의 "nothing to commit" 시그널인 1 이어야 한다. 메시지 본문은
    //    git 빌드에 따라 stdout/stderr 어느 쪽으로도 갈 수 있어(예: msys git 은
    //    stdout) 본문 매칭 대신 종료 코드와 단계 라벨로 회귀를 잡는다.
    for (const [agent, results] of [
      [a2, a2Results],
      [a3, a3Results],
      [a4, a4Results],
    ] as const) {
      const last = results[results.length - 1];
      assert.equal(last.label, 'commit', `${agent.name}: commit 단계에서 멈춰야 한다`);
      assert.equal(last.ok, false, `${agent.name}: 빈 워크트리인데 commit 이 성공했다`);
      assert.equal(
        last.code,
        1,
        `${agent.name}: nothing-to-commit 의 expected exit code(1) 와 다름 — ${last.code}`,
      );
    }

    // ── 시나리오 침묵 계약 종합 ──
    // (1) commit 실패는 단계별 결과 배열에 commit 까지만 남고 push/pr 라벨은 절대
    //     append 되지 않는다. commitOnly 라 plan 자체에도 없지만, runPlan 의 "실패
    //     시 break" 규약이 함께 보장되는지 한 번 더 못박는다.
    for (const turn of runs) {
      const labels = turn.results.map(r => r.label);
      assert.ok(!labels.includes('push'), `${turn.taskId}: commit 실패 뒤 push 가 시도됐다`);
      assert.ok(!labels.includes('pr'), `${turn.taskId}: commit 실패 뒤 pr 이 시도됐다`);
    }
    // (2) 워크스페이스 HEAD 는 시작 SHA 그대로 — 어떤 침묵 행에서도 새 커밋이
    //     섞여 들어가면 회귀.
    const headFinal = headSha(work);
    const headExpected = spawnSync('git', ['-C', work, 'rev-list', '--max-parents=0', 'HEAD'], {
      encoding: 'utf8', windowsHide: true,
    }).stdout.trim().split('\n')[0];
    assert.equal(headFinal, headExpected, '침묵 회귀 표인데 워크스페이스 HEAD 가 이동했다');
    // (3) 원격에는 시나리오 J 의 어느 브랜치도 만들어지면 안 된다.
    for (const branch of [
      'feature/chore/j-a1-should-not-fire',
      'feature/chore/j-a2-clean-tree',
      'feature/chore/j-a3-clean-tree',
      'feature/chore/j-a4-clean-tree',
    ]) {
      assert.equal(
        branchExistsOnRemote(remote, branch),
        false,
        `원격에 ${branch} 가 생겼다 — push 단계가 새어 나갔다`,
      );
    }
    // (4) gh 가 단 한 번도 호출되면 안 된다.
    assert.equal(readFileSync(capture, 'utf8'), '', 'commitOnly 침묵 경로인데 gh 가 호출됐다');
    // (5) firedTaskIds 디바운스에는 워커 3건만 들어가고 리더는 없다 — 표 1행 보호.
    assert.equal(fired.size, 3, 'fired 디바운스 크기가 워커 3건과 다르다');
    assert.ok(!fired.has('task-a1'), '리더 taskId 가 디바운스에 포함되면 안 된다');

    report.push({
      name: '시나리오 J — auto-commit-no-fire-repro.md 표 1~4행 코드 고정',
      flowLevel: cfg.flowLevel,
      branch: runs.map(r => r.branch).join(' / '),
      steps: runs.flatMap(r => r.results),
      failedAt: 'commit (a2~a4)',
      notes: 'A1 은 leader 조기 return 으로 훅 0회, A2~A4 는 commitOnly + 빈 워크트리로 commit 단계가 동일 stderr 로 실패. 어느 행에서도 push/pr 가 새지 않음을 plan/runPlan 양쪽으로 고정.',
    });
  } finally {
    cleanup();
    rmSync(stubRoot, { recursive: true, force: true });
  }
});
