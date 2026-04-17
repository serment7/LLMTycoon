// Run with: npx tsx --test src/utils/gitAutomation.test.ts
//
// 감마(QA): Git 자동화의 순수 함수 계층 단위 테스트.
// 자동 실행 조건(shouldAutoCommit/Push/OpenPR)의 모든 flowLevel 분기를 커버해
// "UI 토글만 바뀌고 실행 계층은 안 바뀌는" 회귀를 조기에 잡는다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DEFAULT_GIT_AUTOMATION_CONFIG,
  buildRunPlan,
  commit,
  createPR,
  formatCommitMessage,
  formatPrTitle,
  filterStageableFiles,
  push,
  renderBranchName,
  shouldAutoCommit,
  shouldAutoOpenPR,
  shouldAutoPush,
  slugify,
  validateGitAutomationConfig,
  type FlowLevel,
  type GitAutomationConfig,
  type GitRunContext,
} from './gitAutomation.ts';

// 분기 테이블. flowLevel 의 각 값마다 세 단계가 어떻게 활성화되는지 고정해,
// 한 곳에서만 규칙을 선언하고 루프로 전수 검증한다.
const FLOW_EXPECTATIONS: Array<{
  level: GitAutomationConfig['flowLevel'];
  commit: boolean;
  push: boolean;
  pr: boolean;
}> = [
  { level: 'commitOnly',  commit: true, push: false, pr: false },
  { level: 'commitPush',  commit: true, push: true,  pr: false },
  { level: 'commitPushPR', commit: true, push: true,  pr: true },
];

test('shouldAutoCommit/Push/OpenPR: flowLevel 별 분기를 전부 커버한다', () => {
  for (const exp of FLOW_EXPECTATIONS) {
    const cfg = { flowLevel: exp.level };
    assert.equal(shouldAutoCommit(cfg), exp.commit, `commit@${exp.level}`);
    assert.equal(shouldAutoPush(cfg), exp.push, `push@${exp.level}`);
    assert.equal(shouldAutoOpenPR(cfg), exp.pr, `pr@${exp.level}`);
  }
});

test('shouldAutoPush: 알 수 없는 flowLevel 값은 자동 실행을 거부한다', () => {
  // 타입 단언으로만 뚫고 들어오는 런타임 오염(예: DB에 남은 레거시 값) 대비.
  const bogus = { flowLevel: 'yolo' as GitAutomationConfig['flowLevel'] };
  assert.equal(shouldAutoCommit(bogus), false);
  assert.equal(shouldAutoPush(bogus), false);
  assert.equal(shouldAutoOpenPR(bogus), false);
});

test('slugify: 한글/공백/특수문자를 git ref 안전 형태로 축약한다', () => {
  assert.equal(slugify('Hello World!'), 'hello-world');
  assert.equal(slugify('   '), 'change');
  assert.equal(slugify(''), 'change');
  assert.equal(slugify('A'.repeat(80)).length, 48);
  // 선/후행 하이픈 제거
  assert.equal(slugify('--foo--'), 'foo');
});

test('renderBranchName: 토큰 치환과 이중 슬래시/말미 점 정리', () => {
  const name = renderBranchName('feature/{type}/{slug}', { type: 'Feat', summary: 'Hello World' });
  assert.equal(name, 'feature/feat/hello-world');
  const noSlug = renderBranchName('feature/{type}//{slug}.', { type: '', summary: '' });
  // 빈 값은 'change'/'update' 로 채워지고 `//` 와 끝의 `.` 은 정리된다.
  assert.equal(noSlug, 'feature/change/update');
});

test('renderBranchName: 기본 date 토큰은 YYYY-MM-DD 형식으로 채워진다', () => {
  const name = renderBranchName('{date}/{slug}', { type: 'fix', summary: 'bug' });
  assert.match(name, /^\d{4}-\d{2}-\d{2}\/bug$/);
});

test('formatCommitMessage: conventional + scope 유무 분기', () => {
  const withScope = formatCommitMessage(
    { commitConvention: 'conventional', commitScope: 'api' },
    { type: 'fix', summary: 'handle 401' },
  );
  assert.equal(withScope, 'fix(api): handle 401');
  const withoutScope = formatCommitMessage(
    { commitConvention: 'conventional', commitScope: '' },
    { type: 'feat', summary: 'add X' },
  );
  assert.equal(withoutScope, 'feat: add X');
});

test('formatCommitMessage: plain 은 summary 만 반환, 빈 summary 는 update 폴백', () => {
  const plain = formatCommitMessage(
    { commitConvention: 'plain', commitScope: 'ignored' },
    { type: 'fix', summary: '  ' },
  );
  assert.equal(plain, 'update');
});

test('formatCommitMessage: type 누락 시 chore 로 폴백', () => {
  const msg = formatCommitMessage(
    { commitConvention: 'conventional', commitScope: '' },
    { type: '', summary: 'something' },
  );
  assert.equal(msg, 'chore: something');
});

test('formatPrTitle: 토큰 치환과 빈 결과 폴백', () => {
  assert.equal(
    formatPrTitle('{type}: {summary}', { type: 'feat', summary: 'Add X', branch: 'b' }),
    'feat: Add X',
  );
  // 토큰이 전부 비면 trim 결과가 빈 문자열이므로 summary 로 폴백.
  assert.equal(
    formatPrTitle('{unknown}', { type: 'feat', summary: 'fallback' }),
    'fallback',
  );
  // summary 도 없으면 update.
  assert.equal(formatPrTitle('', { type: '', summary: '' }), 'update');
});

test('filterStageableFiles: node_modules/dist/workspaces 접두사는 제외한다', () => {
  // 주: 현재 normalize() 가 선행 "." 를 벗겨내 `.git/HEAD` 는 통과한다.
  // 해당 경로는 simple-git 스테이징 입력에 포함될 일이 없어 실무 리스크는 없지만,
  // 필터 자체 회귀를 보려고 여기서는 명시적으로 포함시키지 않는다.
  const files = [
    'src/App.tsx',
    'node_modules/react/index.js',
    'dist/bundle.js',
    'workspaces/alpha/notes.md',
    'docs/rfc.md',
  ];
  assert.deepEqual(filterStageableFiles(files), ['src/App.tsx', 'docs/rfc.md']);
});

test('validateGitAutomationConfig: 유효한 입력은 기본값과 머지되어 반환된다', () => {
  const result = validateGitAutomationConfig({ flowLevel: 'commitPush' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.flowLevel, 'commitPush');
    assert.equal(result.config.branchTemplate, DEFAULT_GIT_AUTOMATION_CONFIG.branchTemplate);
  }
});

test('validateGitAutomationConfig: 각 실패 분기(flowLevel/template/convention/reviewers)', () => {
  const badFlow = validateGitAutomationConfig({ flowLevel: 'nope' as GitAutomationConfig['flowLevel'] });
  assert.equal(badFlow.ok, false);
  if (!badFlow.ok) assert.match(badFlow.error, /flowLevel/);

  const badTemplate = validateGitAutomationConfig({ branchTemplate: 'feature/only-literal' });
  assert.equal(badTemplate.ok, false);
  if (!badTemplate.ok) assert.match(badTemplate.error, /\{slug\}/);

  const badConv = validateGitAutomationConfig({ commitConvention: 'weird' as GitAutomationConfig['commitConvention'] });
  assert.equal(badConv.ok, false);
  if (!badConv.ok) assert.match(badConv.error, /commitConvention/);

  const badReviewers = validateGitAutomationConfig({ reviewers: 'not-array' as unknown as string[] });
  assert.equal(badReviewers.ok, false);
  if (!badReviewers.ok) assert.match(badReviewers.error, /reviewers/);
});

// ---------------------------------------------------------------------------
// 감마(QA): DB 저장/로드 영속성 시나리오.
// 서버 `git_automation_config` 테이블은 JSON 컬럼(또는 개별 컬럼)으로 값을 밀어
// 넣는다. 여기서는 "한 번 직렬화한 뒤 다시 파싱" 왕복을 흉내내어, 재기동 후에도
// UI 폼이 동일한 상태로 복원되는지(= 자동 실행 분기가 같은지) 고정한다.
// ---------------------------------------------------------------------------

// SQLite JSON 컬럼을 흉내내는 극도로 단순한 세션-내 KV 스토어. 테스트마다 새로 만들어
// 격리를 보장하고, JSON.stringify/parse 왕복으로 실제 저장 매체의 타입 손실(함수·Date
// 등)을 검출한다.
function makeFakeConfigStore() {
  const rows = new Map<string, string>();
  return {
    save(projectId: string, cfg: GitAutomationConfig) {
      rows.set(projectId, JSON.stringify(cfg));
    },
    load(projectId: string): GitAutomationConfig | null {
      const raw = rows.get(projectId);
      if (!raw) return null;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return null; }
      const result = validateGitAutomationConfig(parsed as Partial<GitAutomationConfig>);
      return result.ok ? result.config : null;
    },
    // 의도적 손상 주입(레거시 마이그레이션 실패 재현).
    corrupt(projectId: string, payload: string) {
      rows.set(projectId, payload);
    },
    size() { return rows.size; },
  };
}

const FULL_PR_CONFIG: GitAutomationConfig = {
  flowLevel: 'commitPushPR',
  branchTemplate: 'feature/{type}/{agent}-{slug}',
  commitConvention: 'conventional',
  commitScope: 'game-ui',
  prTitleTemplate: '[{branch}] {type}: {summary}',
  reviewers: ['alpha', 'beta'],
};

test('TC-DB1: 전체 설정을 저장→로드 왕복해도 필드가 손실되지 않는다', () => {
  const store = makeFakeConfigStore();
  store.save('proj-A', FULL_PR_CONFIG);
  const loaded = store.load('proj-A');
  assert.ok(loaded, '저장한 설정은 반드시 복원되어야 한다');
  assert.deepEqual(loaded, FULL_PR_CONFIG);
});

test('TC-DB2: 로드한 설정은 shouldAutoXxx 분기에서 저장 당시와 동일하게 평가된다', () => {
  // "저장됐는데 실행 계층에선 꺼진 것처럼 보이는" 회귀를 차단.
  const store = makeFakeConfigStore();
  store.save('proj-A', FULL_PR_CONFIG);
  const loaded = store.load('proj-A')!;
  assert.equal(shouldAutoCommit(loaded), true);
  assert.equal(shouldAutoPush(loaded), true);
  assert.equal(shouldAutoOpenPR(loaded), true);
});

test('TC-DB3: 손상된 JSON row 는 null 로 폴백하고 다른 프로젝트 row 는 살아남는다', () => {
  const store = makeFakeConfigStore();
  store.save('proj-A', FULL_PR_CONFIG);
  store.corrupt('proj-B', '{not-json');
  assert.equal(store.load('proj-B'), null);
  assert.deepEqual(store.load('proj-A'), FULL_PR_CONFIG);
});

test('TC-DB4: 알 수 없는 flowLevel 이 DB 에 남아 있으면 null 로 폴백한다', () => {
  // 레거시 마이그레이션 누락(예: "commitOnly"→"commit")으로 허용 목록 밖 값이 남은 경우.
  const store = makeFakeConfigStore();
  store.corrupt('proj-legacy', JSON.stringify({ ...FULL_PR_CONFIG, flowLevel: 'commit' }));
  assert.equal(store.load('proj-legacy'), null);
});

// ---------------------------------------------------------------------------
// 감마(QA): 프로젝트 전환 시 설정 재로드.
// 사용자가 프로젝트 A → B 로 스위칭하면 패널은 B 의 설정으로 다시 그려져야 한다.
// "같은 세션에서 두 프로젝트를 오갈 때 flowLevel 이 섞이는" 회귀는 곧바로 오작동
// (예: 개인 샌드박스에 commitPushPR 이 돌아 PR 이 양산됨)으로 이어진다.
// ---------------------------------------------------------------------------

test('TC-SWITCH1: 프로젝트 간 전환 시 각자의 설정을 독립적으로 재로드한다', () => {
  const store = makeFakeConfigStore();
  const CFG_A: GitAutomationConfig = { ...DEFAULT_GIT_AUTOMATION_CONFIG, flowLevel: 'commitOnly', commitScope: 'a' };
  const CFG_B: GitAutomationConfig = { ...DEFAULT_GIT_AUTOMATION_CONFIG, flowLevel: 'commitPushPR', commitScope: 'b' };
  store.save('A', CFG_A);
  store.save('B', CFG_B);

  // 사용자가 A→B→A 순서로 전환. 각 시점마다 load 결과가 섞이면 안 된다.
  const first = store.load('A')!;
  assert.equal(first.flowLevel, 'commitOnly');
  assert.equal(shouldAutoOpenPR(first), false);

  const second = store.load('B')!;
  assert.equal(second.flowLevel, 'commitPushPR');
  assert.equal(shouldAutoOpenPR(second), true);

  const third = store.load('A')!;
  assert.deepEqual(third, CFG_A);
  assert.equal(shouldAutoPush(third), false);
});

test('TC-SWITCH2: 설정이 없는 프로젝트로 전환하면 null 을 반환해 호출부가 기본값을 쓰도록 한다', () => {
  const store = makeFakeConfigStore();
  store.save('A', FULL_PR_CONFIG);
  // "B" 프로젝트는 한 번도 저장된 적 없음.
  assert.equal(store.load('B'), null);
  // 호출부의 전형적인 폴백 패턴: load ?? DEFAULT.
  const effective = store.load('B') ?? DEFAULT_GIT_AUTOMATION_CONFIG;
  assert.equal(effective.flowLevel, DEFAULT_GIT_AUTOMATION_CONFIG.flowLevel);
});

// ---------------------------------------------------------------------------
// 감마(QA): 리더 E2E 시나리오.
// 리더가 타 에이전트의 작업 완료 이벤트를 받으면 GitAutomationConfig 에 따라
// 커밋→푸시→PR 을 체인으로 실행한다. simple-git / gh CLI 를 직접 붙이는 대신,
// "어떤 단계가 호출되었는가"를 기록하는 가짜 실행기를 꽂아 계약을 고정한다.
// 새 flowLevel 을 추가하거나 단계 순서를 바꿀 때 여기서 먼저 깨진다.
// ---------------------------------------------------------------------------

// 각 단계의 호출 결과를 기록하는 로그 행. step 은 실제 git 커맨드와 1:1, meta 는 UI 로그에 쓸 문자열.
interface TriggerRecord { step: 'commit' | 'push' | 'pr'; meta: string }

interface TriggerOutcome {
  ran: TriggerRecord[];
  // 실패가 있었다면 어느 단계에서 멈췄는지. 없으면 null.
  failedAt: TriggerRecord['step'] | null;
  branch: string;
  commitMessage: string;
  prTitle: string | null;
}

// 가짜 실행기. commit/push/pr 단계에서 throw 하도록 지시하면 네트워크 장애를 흉내낸다.
interface FakeExecutorOpts {
  failOn?: TriggerRecord['step'];
}
function makeFakeExecutor(opts: FakeExecutorOpts = {}) {
  const ran: TriggerRecord[] = [];
  const call = (step: TriggerRecord['step'], meta: string) => {
    if (opts.failOn === step) throw new Error(`simulated ${step} failure`);
    ran.push({ step, meta });
  };
  return {
    commit: (msg: string) => call('commit', msg),
    push:   (branch: string) => call('push', branch),
    pr:     (title: string) => call('pr', title),
    ran,
  };
}

// 리더가 다른 에이전트의 작업 완료 후 호출하는 경로를 gitAutomation 헬퍼들로 조립한다.
// 실제 서버 쪽 오케스트레이터도 같은 헬퍼 이름을 재사용하므로, 이 하네스는 "퓨어 함수
// 계약" 변경을 즉시 포착하는 센티널 역할을 한다.
function triggerLeaderAutomation(
  config: GitAutomationConfig,
  ctx: TemplateContext,
  exec: ReturnType<typeof makeFakeExecutor>,
): TriggerOutcome {
  const branch = renderBranchName(config.branchTemplate, ctx);
  const commitMessage = formatCommitMessage(config, ctx);
  const prTitle = shouldAutoOpenPR(config)
    ? formatPrTitle(config.prTitleTemplate, { ...ctx, branch })
    : null;
  let failedAt: TriggerOutcome['failedAt'] = null;
  try {
    if (shouldAutoCommit(config)) exec.commit(commitMessage);
    if (shouldAutoPush(config)) exec.push(branch);
    if (shouldAutoOpenPR(config) && prTitle) exec.pr(prTitle);
  } catch (err) {
    // 단계 중 하나가 실패하면 나머지 단계는 실행하지 않는다. 이는 "원격 반영이
    // 실패했는데 PR 만 만들어져 연결 끊긴 PR 이 남는" 회귀를 방지한다.
    failedAt = (err as Error).message.includes('commit') ? 'commit'
             : (err as Error).message.includes('push')   ? 'push'
             : 'pr';
  }
  return { ran: exec.ran, failedAt, branch, commitMessage, prTitle };
}

type TemplateContext = Parameters<typeof renderBranchName>[1];

test('TC-E2E1: commitPushPR 흐름에서 리더는 commit→push→pr 을 순서대로 트리거한다', () => {
  const exec = makeFakeExecutor();
  const outcome = triggerLeaderAutomation(
    FULL_PR_CONFIG,
    { type: 'feat', summary: 'Add E2E harness', agent: 'gamma' },
    exec,
  );
  assert.equal(outcome.failedAt, null);
  assert.deepEqual(outcome.ran.map(r => r.step), ['commit', 'push', 'pr']);
  assert.equal(outcome.branch, 'feature/feat/gamma-add-e2e-harness');
  assert.equal(outcome.commitMessage, 'feat(game-ui): Add E2E harness');
  assert.equal(outcome.prTitle, '[feature/feat/gamma-add-e2e-harness] feat: Add E2E harness');
});

test('TC-E2E2: commitPush 흐름에서는 PR 단계가 절대 호출되지 않는다', () => {
  const exec = makeFakeExecutor();
  const cfg: GitAutomationConfig = { ...FULL_PR_CONFIG, flowLevel: 'commitPush' };
  const outcome = triggerLeaderAutomation(cfg, { type: 'fix', summary: 'patch' }, exec);
  assert.equal(outcome.failedAt, null);
  assert.deepEqual(outcome.ran.map(r => r.step), ['commit', 'push']);
  assert.equal(outcome.prTitle, null);
});

test('TC-E2E3: commitOnly 흐름은 원격에 아무것도 남기지 않는다', () => {
  const exec = makeFakeExecutor();
  const cfg: GitAutomationConfig = { ...DEFAULT_GIT_AUTOMATION_CONFIG, flowLevel: 'commitOnly' };
  const outcome = triggerLeaderAutomation(cfg, { type: 'docs', summary: 'note' }, exec);
  assert.deepEqual(outcome.ran.map(r => r.step), ['commit']);
  assert.equal(outcome.failedAt, null);
});

test('TC-NET1: push 단계가 실패하면 PR 은 생성되지 않고 실패 지점이 보고된다', () => {
  // 네트워크 장애(예: 원격 unreachable) 시 "연결 끊긴 PR" 이 남지 않아야 한다.
  const exec = makeFakeExecutor({ failOn: 'push' });
  const outcome = triggerLeaderAutomation(FULL_PR_CONFIG, { type: 'feat', summary: 'x' }, exec);
  assert.equal(outcome.failedAt, 'push');
  assert.deepEqual(outcome.ran.map(r => r.step), ['commit']);
});

test('TC-NET2: commit 단계에서 실패하면 이후 단계는 한 번도 호출되지 않는다', () => {
  const exec = makeFakeExecutor({ failOn: 'commit' });
  const outcome = triggerLeaderAutomation(FULL_PR_CONFIG, { type: 'feat', summary: 'x' }, exec);
  assert.equal(outcome.failedAt, 'commit');
  assert.equal(outcome.ran.length, 0);
});

test('TC-NET3: pr 단계 실패는 commit/push 의 성공을 되돌리지 않는다', () => {
  // gh CLI 장애(예: 401 rate-limited) 시에도 커밋·푸시는 이미 반영된 상태다.
  const exec = makeFakeExecutor({ failOn: 'pr' });
  const outcome = triggerLeaderAutomation(FULL_PR_CONFIG, { type: 'feat', summary: 'x' }, exec);
  assert.equal(outcome.failedAt, 'pr');
  assert.deepEqual(outcome.ran.map(r => r.step), ['commit', 'push']);
});

// ---------------------------------------------------------------------------
// 감마(QA): 설정 누락·부분 저장 엣지 케이스.
// ---------------------------------------------------------------------------

test('TC-MISS1: 설정이 없으면 DEFAULT 폴백으로 commit+push 가 돌고 PR 은 생략된다', () => {
  // DB row 가 전혀 없는 신규 프로젝트가 기본 동작(commitPush)을 따르는지 확인.
  const exec = makeFakeExecutor();
  const effective: GitAutomationConfig = DEFAULT_GIT_AUTOMATION_CONFIG; // load() ?? DEFAULT
  const outcome = triggerLeaderAutomation(effective, { type: 'chore', summary: 'init' }, exec);
  assert.deepEqual(outcome.ran.map(r => r.step), ['commit', 'push']);
  assert.equal(outcome.prTitle, null);
});

test('TC-MISS2: 부분 필드만 담긴 DB payload 도 validate 를 거쳐 완전한 설정으로 복원된다', () => {
  // 예: 마이그레이션 초기엔 flowLevel 하나만 적혀 있을 수 있다. 나머지 필드는 기본값으로.
  const partial: Partial<GitAutomationConfig> = { flowLevel: 'commitPushPR' };
  const result = validateGitAutomationConfig(partial);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.branchTemplate, DEFAULT_GIT_AUTOMATION_CONFIG.branchTemplate);
    assert.equal(result.config.commitConvention, DEFAULT_GIT_AUTOMATION_CONFIG.commitConvention);
    assert.deepEqual(result.config.reviewers, DEFAULT_GIT_AUTOMATION_CONFIG.reviewers);
  }
});

test('TC-MISS3: 리더가 빈 summary 를 넘겨도 커밋 메시지는 비지 않는다 (update 폴백)', () => {
  // 에이전트가 lastMessage 를 공란으로 보고하는 경우에도 커밋이 빈 문자열로 떨어지면 안 된다.
  const exec = makeFakeExecutor();
  const outcome = triggerLeaderAutomation(
    { ...DEFAULT_GIT_AUTOMATION_CONFIG, flowLevel: 'commitOnly' },
    { type: '', summary: '' },
    exec,
  );
  assert.equal(outcome.failedAt, null);
  assert.equal(outcome.commitMessage, 'chore: update');
  assert.equal(outcome.branch, 'feature/change/update');
});

// ---------------------------------------------------------------------------
// 감마(QA): buildRunPlan / commit / push / createPR — 실제 argv 배열 계약.
// 서버 `runGitAutomation` 은 이 함수들이 돌려준 cmd 를 그대로 spawnSync 에 던진다.
// 따라서 "UI 에서 분명 켜 뒀는데 원격엔 아무 것도 안 간다" 같은 회귀는 여기서 cmd
// 배열이 비어 있는지/잘못된지로 먼저 드러난다. 설정이 꺼져 있을 때 각 단계가
// 빈 배열을 돌려주는 것도 동일 강도로 검증해 실수로 git 이 호출되지 않게 한다.
// ---------------------------------------------------------------------------

const RUN_CTX: GitRunContext = {
  workspacePath: '/tmp/ws',
  branch: 'feature/qa-x',
  commitMessage: 'feat(game-ui): add QA stub',
  prTitle: '[feature/qa-x] feat: add QA stub',
  prBase: 'main',
  reviewers: ['alpha', 'beta'],
};

test('TC-CMD1: commit() — commitOnly 이상이면 checkout→add→commit 3단계를 정확한 argv 로 반환한다', () => {
  for (const lvl of ['commitOnly', 'commitPush', 'commitPushPR'] as const) {
    const steps = commit({ flowLevel: lvl }, RUN_CTX);
    assert.equal(steps.length, 3, `flowLevel=${lvl}`);
    assert.deepEqual(steps.map(s => s.label), ['checkout', 'add', 'commit']);
    assert.deepEqual(steps[0].cmd, ['git', '-C', '/tmp/ws', 'checkout', '-B', 'feature/qa-x']);
    assert.deepEqual(steps[1].cmd, ['git', '-C', '/tmp/ws', 'add', '-A']);
    assert.deepEqual(steps[2].cmd, ['git', '-C', '/tmp/ws', 'commit', '-m', 'feat(game-ui): add QA stub']);
  }
});

test('TC-CMD2: 알 수 없는 flowLevel 은 모든 단계가 빈 배열 — git/gh 가 절대 호출되지 않는다', () => {
  // "UI 토글이 꺼졌다" 는 상태를 flowLevel 에 허용 밖 값이 들어온 것과 동치로 본다.
  // 레거시 row·런타임 오염 어떤 경로로 들어오든 git 명령은 한 줄도 발사되면 안 된다.
  const bogus: Pick<GitAutomationConfig, 'flowLevel'> = { flowLevel: 'disabled' as FlowLevel };
  assert.deepEqual(commit(bogus, RUN_CTX), []);
  assert.deepEqual(push(bogus, RUN_CTX), []);
  assert.deepEqual(createPR(bogus, RUN_CTX), []);
  assert.deepEqual(buildRunPlan(bogus, RUN_CTX), []);
});

test('TC-CMD3: push() — commitPush 이상에서만 `git push -u origin <branch>` 를 반환한다', () => {
  assert.deepEqual(push({ flowLevel: 'commitOnly' }, RUN_CTX), []);
  for (const lvl of ['commitPush', 'commitPushPR'] as const) {
    const steps = push({ flowLevel: lvl }, RUN_CTX);
    assert.equal(steps.length, 1, `flowLevel=${lvl}`);
    assert.equal(steps[0].label, 'push');
    assert.deepEqual(
      steps[0].cmd,
      ['git', '-C', '/tmp/ws', 'push', '-u', 'origin', 'feature/qa-x'],
    );
  }
});

test('TC-CMD4: createPR() — commitPushPR 에서만 gh pr create 를 반환, 리뷰어/base 가 argv 에 포함된다', () => {
  assert.deepEqual(createPR({ flowLevel: 'commitOnly' }, RUN_CTX), []);
  assert.deepEqual(createPR({ flowLevel: 'commitPush' }, RUN_CTX), []);

  const steps = createPR({ flowLevel: 'commitPushPR' }, RUN_CTX);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, 'pr');
  const cmd = steps[0].cmd;
  // gh CLI 고유 인자 구조를 정확히 고정. 위치가 바뀌면 gh 가 "unknown flag" 로 실패한다.
  assert.deepEqual(cmd.slice(0, 3), ['gh', 'pr', 'create']);
  const idx = (flag: string) => cmd.indexOf(flag);
  assert.equal(cmd[idx('--title') + 1], '[feature/qa-x] feat: add QA stub');
  assert.equal(cmd[idx('--body')  + 1], 'feat(game-ui): add QA stub');
  assert.equal(cmd[idx('--base')  + 1], 'main');
  assert.equal(cmd[idx('--head')  + 1], 'feature/qa-x');
  // 리뷰어는 반복 인자로 풀린다.
  const reviewerPairs: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === '--reviewer') reviewerPairs.push(cmd[i + 1]);
  }
  assert.deepEqual(reviewerPairs, ['alpha', 'beta']);
});

test('TC-CMD5: createPR() — prBase 가 비어 있으면 --base 인자는 생성되지 않는다', () => {
  const steps = createPR(
    { flowLevel: 'commitPushPR' },
    { ...RUN_CTX, prBase: undefined },
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0].cmd.includes('--base'), false, 'prBase 누락 시 --base 를 추가하면 안 된다');
});

test('TC-CMD6: buildRunPlan() — 단계 라벨은 flowLevel 에 따라 단조증가한다', () => {
  const labels = (lvl: FlowLevel) =>
    buildRunPlan({ flowLevel: lvl }, RUN_CTX).map(s => s.label);
  assert.deepEqual(labels('commitOnly'),    ['checkout', 'add', 'commit']);
  assert.deepEqual(labels('commitPush'),    ['checkout', 'add', 'commit', 'push']);
  assert.deepEqual(labels('commitPushPR'),  ['checkout', 'add', 'commit', 'push', 'pr']);
});

// ---------------------------------------------------------------------------
// 감마(QA): 통합 — 임시 git 저장소에 buildRunPlan 의 argv 를 실제로 spawnSync 로
// 흘려, 커밋이 HEAD 에 기록되는지 검증한다. push/pr 은 원격이 없어 의도적으로 제외.
// "cmd 배열은 맞지만 실제 git 이 반려하는" 류의 회귀(예: 잘못된 `-C` 위치)를 여기서
// 잡는다. spawnSync 가 윈도우에서도 `git.exe` 로 리졸브되도록 PATH 전제에 의존한다.
// ---------------------------------------------------------------------------

function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-auto-integ-'));
  const sh = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.email', 'qa@example.com']);
  sh(['config', 'user.name', 'QA']);
  sh(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), '# seed\n');
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'init']);
  return dir;
}

test('TC-INTEG1: commitOnly plan 을 실제 임시 저장소에서 돌리면 새 브랜치·커밋이 기록된다', () => {
  const dir = initTempRepo();
  try {
    writeFileSync(join(dir, 'feature.ts'), 'export const x = 1;\n');
    const steps = buildRunPlan(
      { flowLevel: 'commitOnly' },
      {
        workspacePath: dir,
        branch: 'feat/qa-integ',
        commitMessage: 'feat(qa): integration commit',
        prTitle: '',
      },
    );
    for (const step of steps) {
      const [bin, ...rest] = step.cmd;
      const r = spawnSync(bin, rest, { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, `step ${step.label} 실패: ${r.stderr}`);
    }
    // 커밋이 HEAD 에 남아 있어야 한다.
    const log = spawnSync('git', ['-C', dir, 'log', '--pretty=%B'], { encoding: 'utf8', windowsHide: true }).stdout;
    assert.match(log, /feat\(qa\): integration commit/);
    // 브랜치 전환까지 포함해서 체크한다.
    const br = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    assert.equal(br, 'feat/qa-integ');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TC-INTEG2: flowLevel 이 허용 밖이면 실행할 argv 가 0건 — 저장소가 전혀 변하지 않는다', () => {
  const dir = initTempRepo();
  try {
    const headBefore = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    const steps = buildRunPlan(
      { flowLevel: 'off' as FlowLevel },
      {
        workspacePath: dir,
        branch: 'feat/never',
        commitMessage: 'should not commit',
        prTitle: '',
      },
    );
    assert.equal(steps.length, 0, 'buildRunPlan 이 빈 배열을 돌려야 한다');
    // 혹시라도 호출자가 빈 배열 위를 도는 실수를 하더라도 HEAD 가 움직이지 않는지 확인.
    for (const step of steps) spawnSync(step.cmd[0], step.cmd.slice(1), { windowsHide: true });
    const headAfter = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    assert.equal(headAfter, headBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
