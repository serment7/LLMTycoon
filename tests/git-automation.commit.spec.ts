// Run with: npx tsx --test tests/git-automation.commit.spec.ts
//
// 지시 #e56407b0 — Thanos 가 수정할 git-automation commit 단계 회귀 잠금.
//
// 배경
//   server.ts:1905-1932 의 runStep 헬퍼는 spawnSync('git', ['commit', ...]) 의
//   결과를 GitAutomationStepResult 로 정형화한 뒤 UI(Toast / AgentStatusPanel)·
//   구조화 로그(buildGitAutomationLogEntries)·요약 헬퍼(summarizeRunResult)
//   세 곳에서 동일하게 소비된다. Thanos 의 리팩터링이 이 commit 분기의 관측
//   가능성(ok / code / stderr / stdout) 또는 사용자 가시 메시지를 회귀시키지
//   않도록, 4가지 분기를 실제 임시 git 저장소에 대해 잠가 둔다.
//
// 검증 계약
//   (1) 변경 사항 없음    → ok=false, code !== 0, "nothing to commit" 시그널 + 친화 메시지
//   (2) ident 미설정       → ok=false, stderr 에 user.email/name 결핍 신호
//   (3) .git/index.lock    → ok=false, stderr 에 index.lock + 친화 메시지
//   (4) 정상 staged 변경   → ok=true,  code === 0, parseCommitShaFromStdout 로 SHA 회수

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseCommitShaFromStdout,
  type GitAutomationStepResult,
} from '../src/utils/gitAutomation.ts';

// ────────────────────────────────────────────────────────────────────────────
// 인라인 실행 헬퍼 — server.ts:1905-1932 의 runStep('commit', …) 계약을 그대로
// 따른다. Thanos 가 commit 단계를 별도 모듈로 분리할 때 본문을 import 한 헬퍼로
// 교체하면 테스트는 그대로 통과해야 한다.
// ────────────────────────────────────────────────────────────────────────────
function runCommitStep(
  workspacePath: string,
  commitMessage: string,
  envOverride?: NodeJS.ProcessEnv,
): GitAutomationStepResult {
  const r = spawnSync('git', ['-C', workspacePath, 'commit', '-m', commitMessage], {
    encoding: 'utf8',
    windowsHide: true,
    env: envOverride ?? process.env,
  });
  const ok = r.status === 0 && !r.error;
  const stderrRaw = (r.stderr || '') + (r.error ? `\nspawn error: ${r.error.message}` : '');
  return {
    label: 'commit',
    ok,
    code: r.status,
    stderr: ok ? undefined : stderrRaw.slice(0, 400),
    stdout: ((r.stdout || '').slice(0, 400)) || undefined,
  };
}

// 실패 분기를 사용자 친화 한국어 한 줄로 정형화한다. UI 토스트가 stderr 원문을
// 그대로 노출해 사용자가 다음 행동을 모르게 되는 회귀(#e56407b0)를 잠근다.
function summarizeCommitFailure(step: GitAutomationStepResult): string {
  const blob = `${step.stdout || ''}\n${step.stderr || ''}`;
  if (/nothing to commit/i.test(blob)) {
    return '커밋할 변경 사항이 없습니다. 작업 트리가 깨끗합니다.';
  }
  if (
    /Please tell me who you are/i.test(blob)
    || /empty ident name/i.test(blob)
    || /no email was given/i.test(blob)
    || /auto[- ]detection is disabled/i.test(blob)
  ) {
    return 'git user.email/user.name 이 설정되지 않았습니다. config 를 먼저 지정하세요.';
  }
  if (/index\.lock/i.test(blob)) {
    return 'index.lock 파일이 남아 있어 커밋할 수 없습니다. 다른 git 프로세스를 종료한 뒤 재시도하세요.';
  }
  return `커밋 실패 (exit=${step.code ?? '?'})`;
}

// ────────────────────────────────────────────────────────────────────────────
// 임시 저장소 헬퍼
// ────────────────────────────────────────────────────────────────────────────
interface TempRepo {
  cwd: string;
  // GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM 가 가리킬 빈 파일 — 외부 글로벌 설정 누수 차단.
  emptyConfigPath: string;
  cleanup(): void;
}

function makeTempRepo(opts?: { configureUser?: boolean }): TempRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tycoon-commit-spec-'));
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd);
  const emptyConfigPath = path.join(root, 'empty.gitconfig');
  fs.writeFileSync(emptyConfigPath, '');
  const init = spawnSync('git', ['-C', cwd, 'init', '-q', '-b', 'main'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (init.status !== 0) {
    throw new Error(`git init failed: ${init.stderr || init.error?.message || 'unknown'}`);
  }
  if (opts?.configureUser) {
    spawnSync('git', ['-C', cwd, 'config', 'user.email', 'spec@llm-tycoon.test'], {
      encoding: 'utf8', windowsHide: true,
    });
    spawnSync('git', ['-C', cwd, 'config', 'user.name', 'Spec Bot'], {
      encoding: 'utf8', windowsHide: true,
    });
  }
  return {
    cwd,
    emptyConfigPath,
    cleanup() {
      try { fs.rmSync(root, { recursive: true, force: true }); }
      catch { /* 잔존 핸들이 있어도 다음 mkdtemp 가 새 디렉터리를 사용하므로 무시 */ }
    },
  };
}

// 외부 git 설정·환경 ident 누수를 차단해 ident 미설정 시나리오가 호스트 환경에
// 의존하지 않도록 한다. user.useConfigOnly 와 함께 사용해 결정성을 보장한다.
function isolatedEnv(repo: TempRepo): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...process.env };
  delete cleaned.GIT_AUTHOR_NAME;
  delete cleaned.GIT_AUTHOR_EMAIL;
  delete cleaned.GIT_COMMITTER_NAME;
  delete cleaned.GIT_COMMITTER_EMAIL;
  delete cleaned.EMAIL;
  cleaned.GIT_CONFIG_GLOBAL = repo.emptyConfigPath;
  cleaned.GIT_CONFIG_SYSTEM = repo.emptyConfigPath;
  cleaned.GIT_CONFIG_NOSYSTEM = '1';
  cleaned.HOME = path.dirname(repo.emptyConfigPath);
  cleaned.USERPROFILE = path.dirname(repo.emptyConfigPath);
  return cleaned;
}

function stage(repo: TempRepo, name: string, body: string): void {
  fs.writeFileSync(path.join(repo.cwd, name), body);
  const r = spawnSync('git', ['-C', repo.cwd, 'add', name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git add 실패: ${r.stderr || r.error?.message || 'unknown'}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 시나리오
// ────────────────────────────────────────────────────────────────────────────

// (1) 변경 사항 없는 상태에서 commit 호출 → code !== 0, 친화 메시지 노출
test('1. 변경 없음 — code 비정상 + nothing-to-commit 사용자 친화 메시지', (t) => {
  const repo = makeTempRepo({ configureUser: true });
  t.after(() => repo.cleanup());

  const step = runCommitStep(repo.cwd, 'chore: empty commit attempt');

  assert.equal(step.ok, false, '변경이 없으면 ok=false 여야 한다');
  assert.notStrictEqual(step.code, 0, 'exit code 가 0 이 아니어야 한다');
  assert.equal(step.code, 1, 'git 은 변경 없음 시 1 로 종료한다');
  // git 은 "nothing to commit" 을 stdout 으로 흘리는 버전이 많다 — runStep 이
  // commit 라벨에서 stdout 도 캡처해야 친화 메시지 추출이 가능함을 잠근다.
  const blob = `${step.stdout || ''}\n${step.stderr || ''}`;
  assert.match(blob, /nothing to commit/i, 'stdout/stderr 어딘가에 nothing-to-commit 시그널');
  assert.match(summarizeCommitFailure(step), /변경 사항이 없습니다/);
});

// (2) user.email/user.name 미설정 → 실패 메시지 캡처
test('2. ident 미설정 — Please tell me who you are / empty ident / no email 캡처', (t) => {
  const repo = makeTempRepo({ configureUser: false });
  t.after(() => repo.cleanup());
  // ident 검사까지 도달하려면 staged 변경이 필요하다.
  stage(repo, 'a.txt', 'hello\n');
  // 환경/호스트 ident 폴백을 끊어 결정적인 실패를 만든다. 외부 글로벌 config
  // 가 user.email 을 가지고 있을 수 있으므로 isolatedEnv 와 함께 사용한다.
  spawnSync('git', ['-C', repo.cwd, 'config', '--local', 'user.useConfigOnly', 'true'], {
    encoding: 'utf8', windowsHide: true,
  });

  const step = runCommitStep(repo.cwd, 'feat: a', isolatedEnv(repo));

  assert.equal(step.ok, false);
  assert.notStrictEqual(step.code, 0);
  assert.ok(step.stderr, 'stderr 가 비어 있으면 안 된다');
  assert.match(
    step.stderr || '',
    /(Please tell me who you are|empty ident name|no email was given|auto[- ]detection is disabled|user\.email)/i,
    `ident 결핍 시그널이 stderr 에 있어야 함 — got: ${step.stderr}`,
  );
  assert.match(summarizeCommitFailure(step), /user\.email\/user\.name/);
});

// (3) .git/index.lock 잔존 → 실패 분기
test('3. .git/index.lock 잔존 — File exists 분기 + 친화 메시지', (t) => {
  const repo = makeTempRepo({ configureUser: true });
  t.after(() => repo.cleanup());
  stage(repo, 'a.txt', 'hello\n');
  const lockPath = path.join(repo.cwd, '.git', 'index.lock');
  fs.writeFileSync(lockPath, '');

  const step = runCommitStep(repo.cwd, 'feat: locked');
  // cleanup 이 rmSync 로 .git 트리를 지울 때 lock 잔여로 EBUSY 가 나는 환경이
  // 있으니 즉시 풀어 둔다.
  try { fs.rmSync(lockPath, { force: true }); } catch { /* noop */ }

  assert.equal(step.ok, false);
  assert.notStrictEqual(step.code, 0);
  assert.match(step.stderr || '', /index\.lock/i, 'stderr 에 index.lock 시그널');
  assert.match(summarizeCommitFailure(step), /index\.lock/);
});

// (4) 정상 commit 성공 경로 — stdout 머리글의 SHA 가 회수돼야 한다
test('4. 정상 staged 변경 — ok=true, parseCommitShaFromStdout 로 SHA 회수', (t) => {
  const repo = makeTempRepo({ configureUser: true });
  t.after(() => repo.cleanup());
  stage(repo, 'a.txt', 'hello\n');

  const step = runCommitStep(repo.cwd, 'feat: hello');

  assert.equal(step.ok, true, `commit 이 성공해야 한다 — stderr=${step.stderr}`);
  assert.equal(step.code, 0);
  assert.equal(step.stderr, undefined, '성공 시 stderr 는 비워 둔다(runStep 계약)');
  assert.ok(step.stdout, 'commit 라벨은 stdout 을 캡처해 SHA 회수가 가능해야 한다');
  // server.ts 의 stdout 슬라이스(400자) 정책과 동일하게 `[branch sha] …` 헤더가 보존돼야 한다.
  const sha = parseCommitShaFromStdout(step.stdout);
  assert.ok(
    sha && /^[0-9a-f]{7,40}$/i.test(sha),
    `parseCommitShaFromStdout 가 7자 이상 단축 SHA 를 회수해야 한다 — got=${sha}`,
  );
});
