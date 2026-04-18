import { isExcludedFromGitStaging } from './codeGraphFilter';
import type {
  GitAutomationLogEntry,
  GitAutomationLogStage,
  BranchStrategy,
} from '../types';

// 커밋 → 푸시 → PR 의 어디까지 자동으로 실행할지. UI 토글과 일대일로 매핑된다.
export type FlowLevel = 'commitOnly' | 'commitPush' | 'commitPushPR';

export type CommitConvention = 'conventional' | 'plain';

// SQLite `git_automation_config` 테이블의 1:1 매핑. 서버 쪽 simple-git
// 래퍼와 UI 폼이 공유하므로, 필드 추가 시 양쪽 마이그레이션을 반드시 함께 진행할 것.
export interface GitAutomationConfig {
  // 자동 개발 모드 ON/OFF 마스터 스위치. MCP get_git_automation_settings 응답의
  // 최상단 키와 같은 이름을 쓰며, 값이 명시적으로 false 면 commit/push/PR 가드가
  // 전부 false 를 돌려준다. undefined(옵셔널) 로 두면 "flowLevel 만으로 판단" 하는
  // 레거시 동작을 유지해, enabled 를 모르는 호출부(기존 DB 로우·테스트 픽스처)가
  // 회귀 없이 같은 계약으로 돌게 한다.
  enabled?: boolean;
  flowLevel: FlowLevel;
  // 브랜치 이름 템플릿. `{type}`, `{slug}`, `{agent}`, `{date}` 토큰을 치환한다.
  branchTemplate: string;
  commitConvention: CommitConvention;
  // Conventional Commits 의 scope. 빈 문자열이면 생략.
  commitScope: string;
  // PR 제목 템플릿. `{type}`, `{summary}`, `{branch}` 토큰을 치환한다.
  prTitleTemplate: string;
  // 리뷰어 자동 지정에 쓰이는 GitHub/GitLab 핸들 목록. 현재는 UI 기록용.
  reviewers: string[];
}

export const DEFAULT_GIT_AUTOMATION_CONFIG: GitAutomationConfig = {
  flowLevel: 'commitPush',
  branchTemplate: 'feature/{type}/{slug}',
  commitConvention: 'conventional',
  commitScope: '',
  prTitleTemplate: '{type}: {summary}',
  reviewers: [],
};

export interface TemplateContext {
  type: string;
  summary: string;
  agent?: string;
  date?: string;
  branch?: string;
}

// 템플릿 토큰을 채우기 전에 파일·브랜치명으로 안전한 형태로 깎는다.
// 한글/공백/특수문자를 그대로 두면 git ref 규칙(RFC 3986 부분집합)에 걸린다.
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'change';
}

function replaceTokens(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = ctx[key];
    return v === undefined ? '' : v;
  });
}

export function renderBranchName(template: string, ctx: TemplateContext): string {
  const tokens: Record<string, string> = {
    type: slugify(ctx.type || 'change'),
    slug: slugify(ctx.summary || 'update'),
    agent: slugify(ctx.agent || ''),
    date: ctx.date || new Date().toISOString().slice(0, 10),
  };
  const rendered = replaceTokens(template, tokens);
  // git은 `//`, 끝의 `.`, 공백을 허용하지 않는다. 템플릿 오타로 생기는 사고를
  // 여기서 한 번 더 정리한다.
  return rendered.replace(/\/{2,}/g, '/').replace(/\.+$/, '').replace(/\s+/g, '-');
}

// branchNamePattern 전용 렌더러. renderBranchName 의 슬러그 토큰을 그대로
// 지원하면서 `{shortId}` 토큰을 추가로 치환한다 — per-task 전략은 taskId,
// per-session 전략은 sessionId 의 앞 8자를 넘긴다.
export function renderBranchPattern(
  pattern: string,
  ctx: TemplateContext & { shortId?: string },
): string {
  const tokens: Record<string, string> = {
    type: slugify(ctx.type || 'change'),
    slug: slugify(ctx.summary || 'update'),
    agent: slugify(ctx.agent || ''),
    date: ctx.date || new Date().toISOString().slice(0, 10),
    shortId: (ctx.shortId || '').trim() || 'anon',
  };
  const rendered = replaceTokens(pattern, tokens);
  return rendered.replace(/\/{2,}/g, '/').replace(/\.+$/, '').replace(/\s+/g, '-');
}

// ensureBranch 컨텍스트. 런타임 의존성(실제 git 명령)을 가두기 위해 존재 여부
// 확인은 호출자가 전달하는 predicate 로 추상화한다. 서버 실행기는 spawnSync
// 기반 `git rev-parse --verify` 로 구현하고, 테스트는 Map 기반 가짜 predicate 를
// 주입한다.
export interface EnsureBranchInput {
  strategy: BranchStrategy;
  // 기존 설정과의 호환을 위해 per-commit 에서 계속 사용되는 레거시 템플릿.
  branchTemplate: string;
  // per-task / per-session 전략이 사용하는 패턴. `{shortId}` 토큰을 지원한다.
  branchNamePattern: string;
  // fixed-branch 전략이 그대로 사용하는 이름.
  fixedBranchName: string;
  templateCtx: TemplateContext;
  // 전략별 shortId 후보. 우선순위: per-task → taskId, per-session → sessionId.
  taskId?: string;
  sessionId?: string;
  branchExists(name: string): boolean;
}

export interface EnsuredBranch {
  branch: string;
  // true 면 기존 브랜치가 있어 checkout 만 수행(재사용), false 면 `checkout -B` 로
  // 생성한다. 호출자는 이 플래그로 "같은 세션 안에서 중복 생성되지 않는지" 검증.
  existed: boolean;
  strategy: BranchStrategy;
}

function shortIdFor(input: EnsureBranchInput): string {
  if (input.strategy === 'per-task') return (input.taskId || '').slice(0, 8);
  if (input.strategy === 'per-session') return (input.sessionId || '').slice(0, 8);
  return '';
}

// 브랜치 전략에 따라 실제로 사용할 브랜치 이름을 계산하고, 이미 존재하는지
// 검사한 결과를 함께 돌려준다. "매 커밋마다 새 브랜치" 회귀는 strategy 가
// per-session/per-task/fixed-branch 일 때 branchExists 경로를 타며 재사용된다.
export function ensureBranch(input: EnsureBranchInput): EnsuredBranch {
  let branch: string;
  switch (input.strategy) {
    case 'fixed-branch':
      branch = input.fixedBranchName.trim() || 'auto/dev';
      break;
    case 'per-task':
    case 'per-session': {
      const shortId = shortIdFor(input);
      branch = renderBranchPattern(input.branchNamePattern, { ...input.templateCtx, shortId });
      break;
    }
    case 'per-commit':
    default:
      branch = renderBranchName(input.branchTemplate, input.templateCtx);
      break;
  }
  const existed = !!branch && input.branchExists(branch);
  return { branch, existed, strategy: input.strategy };
}

export function formatCommitMessage(
  config: Pick<GitAutomationConfig, 'commitConvention' | 'commitScope'>,
  ctx: TemplateContext,
): string {
  const summary = ctx.summary.trim() || 'update';
  if (config.commitConvention === 'plain') return summary;
  const type = (ctx.type || 'chore').toLowerCase();
  const scope = config.commitScope.trim();
  return scope ? `${type}(${scope}): ${summary}` : `${type}: ${summary}`;
}

export function formatPrTitle(template: string, ctx: TemplateContext): string {
  const tokens: Record<string, string> = {
    type: ctx.type || 'chore',
    summary: ctx.summary || 'update',
    branch: ctx.branch || '',
  };
  return replaceTokens(template, tokens).trim() || ctx.summary || 'update';
}

// simple-git 실행 직전에 스테이징 후보를 정리한다. node_modules 등이
// 실수로 들어오면 커밋 한 번에 수십 MB가 새어 나간다.
export function filterStageableFiles(files: readonly string[]): string[] {
  return files.filter((f) => !isExcludedFromGitStaging(f));
}

// 자동 실행 조건 분기. UI 토글(FlowLevel)을 런타임 동작(커밋/푸시/PR)과 분리해,
// 서버 쪽 실행기와 단위 테스트가 같은 조건을 공유한다. 각 단계는 상위를 포함한다.
// enabled 는 MCP get_git_automation_settings 응답의 마스터 스위치. `false` 로 명시된
// 경우에만 가드를 끊어 커밋이 한 줄도 발사되지 않게 한다. `undefined` 는 "호출부가
// enabled 를 모르는 레거시 경로" 로 간주해 기존 flowLevel 기반 판단을 그대로 유지 —
// 덕분에 기존 테스트 픽스처와 직접 `{ flowLevel: ... }` 만 넘기는 코드가 회귀 없이
// 같은 결과를 돌려받는다.
export type AutoFlowGuardInput = Pick<GitAutomationConfig, 'flowLevel' | 'enabled'>;

function isMasterSwitchOff(config: AutoFlowGuardInput): boolean {
  return config.enabled === false;
}

export function shouldAutoCommit(config: AutoFlowGuardInput): boolean {
  if (isMasterSwitchOff(config)) return false;
  return config.flowLevel === 'commitOnly'
      || config.flowLevel === 'commitPush'
      || config.flowLevel === 'commitPushPR';
}

export function shouldAutoPush(config: AutoFlowGuardInput): boolean {
  if (isMasterSwitchOff(config)) return false;
  return config.flowLevel === 'commitPush' || config.flowLevel === 'commitPushPR';
}

export function shouldAutoOpenPR(config: AutoFlowGuardInput): boolean {
  if (isMasterSwitchOff(config)) return false;
  return config.flowLevel === 'commitPushPR';
}

// 리더가 호출하는 실행 어댑터. 실제 git 명령은 서버 쪽에서 child_process 로 돌려
// 브라우저 번들이 node API 를 끌어오지 않도록, 여기서는 "어떤 명령을 어떤 cwd 에
// 쏠지"만 계산한다. commit/push/createPR 은 단계별로 다음 단계로 넘어가는 gate 를
// 포함해, 실수로 설정 밖의 단계가 뛰지 않도록 한다.
export interface GitRunContext {
  workspacePath: string;
  branch: string;
  commitMessage: string;
  prTitle: string;
  prBase?: string;
  reviewers?: string[];
}

export interface GitRunStep {
  label: string;
  cmd: string[];
}

// 서버 실행기가 단계별로 쌓는 결과. label 은 checkout/add/commit/push/pr 중 하나.
// ok=false 인 첫 단계에서 실행이 중단되므로, 이 배열 길이로 "어디까지 성공했는지"
// 를 그대로 판단할 수 있다. stderr 는 디스크 공간을 먹지 않도록 400자로 자른다.
export interface GitAutomationStepResult {
  label: string;
  ok: boolean;
  code: number | null;
  stderr?: string;
  // commit/pr 단계의 stdout 을 UI 에서 파싱(커밋 SHA, PR URL)하기 위해 보존한다.
  // 400자 상한은 stderr 와 동일 — 직렬화 비용과 소켓 페이로드 크기를 함께 제한한다.
  stdout?: string;
  // 서버 실행기가 단계 spawn 직전에 채워 넣는 시작 시각(epoch ms). 구조화 로그
  // 빌더가 없는 경우에도 폴백할 수 있도록 옵셔널로 둔다 — 현재 server.ts 는 아직
  // 채우지 않지만, 타입 계약을 미리 고정해 이후 계측 주입이 비파괴적으로 이뤄진다.
  startedAt?: number;
  // 단계 종료 시각(성공·실패 모두). started 와 함께 AgentStatusPanel 타임라인에서
  // 소요 시간을 계산할 수 있게 한다.
  finishedAt?: number;
}

export interface GitAutomationRunResult {
  ok: boolean;
  // 설정이 비활성(enabled=false)이거나 프로젝트를 찾지 못한 경우 짧게 조기 종료.
  skipped?: 'disabled' | 'no-project';
  error?: string;
  results: GitAutomationStepResult[];
  branch?: string;
  commitMessage?: string;
  prTitle?: string;
}

export function commit(config: AutoFlowGuardInput, ctx: GitRunContext): GitRunStep[] {
  if (!shouldAutoCommit(config)) return [];
  // 변경 사항이 없으면 commit 이 실패하므로 `--allow-empty` 는 일부러 쓰지 않는다.
  // 호출자가 스테이징 후 이 함수를 호출한다는 전제.
  return [
    { label: 'checkout', cmd: ['git', '-C', ctx.workspacePath, 'checkout', '-B', ctx.branch] },
    { label: 'add',      cmd: ['git', '-C', ctx.workspacePath, 'add', '-A'] },
    { label: 'commit',   cmd: ['git', '-C', ctx.workspacePath, 'commit', '-m', ctx.commitMessage] },
  ];
}

export function push(config: AutoFlowGuardInput, ctx: GitRunContext): GitRunStep[] {
  if (!shouldAutoPush(config)) return [];
  return [
    { label: 'push', cmd: ['git', '-C', ctx.workspacePath, 'push', '-u', 'origin', ctx.branch] },
  ];
}

// PR 생성은 git CLI 만으로는 불가능하므로 `gh` CLI 를 전제로 한다.
// 환경에 gh 가 없다면 호출자가 step 배열을 비워 빈 배열로 받게 된다(상위에서 판단).
export function createPR(config: AutoFlowGuardInput, ctx: GitRunContext): GitRunStep[] {
  if (!shouldAutoOpenPR(config)) return [];
  const reviewerArgs: string[] = [];
  for (const r of ctx.reviewers ?? []) {
    if (r && typeof r === 'string') reviewerArgs.push('--reviewer', r);
  }
  const base = ctx.prBase?.trim();
  return [
    {
      label: 'pr',
      cmd: [
        'gh', 'pr', 'create',
        '--title', ctx.prTitle,
        '--body', ctx.commitMessage,
        ...(base ? ['--base', base] : []),
        '--head', ctx.branch,
        ...reviewerArgs,
      ],
    },
  ];
}

// 한 번에 전체 단계를 쌓아 반환해, 실행기가 순차적으로 돌리게 한다.
export function buildRunPlan(config: AutoFlowGuardInput, ctx: GitRunContext): GitRunStep[] {
  return [...commit(config, ctx), ...push(config, ctx), ...createPR(config, ctx)];
}

// 주기 실행 스케줄러. 이 파일은 지금까지 순수 함수(설정/계획)만 제공했고, UI 토글이
// 켜져 있어도 실제로 러너를 깨우는 경로가 없어 "설정은 남지만 실행은 멈춘" 상태가
// 생길 수 있었다. 최소 단위 스케줄러로 enabled 를 매 tick 재평가하고, 느린 러너가
// 겹쳐 쌓이지 않도록 동시 실행을 스스로 억제한다. stop() 은 언마운트 정리에서
// 반드시 호출할 것.
export interface GitAutomationSchedulerOptions {
  intervalMs: number;
  isEnabled: () => boolean;
  run: () => void | Promise<void>;
  onError?: (err: unknown) => void;
  // 자동 개발 모드에서 commit/push/PR 파이프라인이 "에이전트가 done 을 보고한
  // 순간에만" 발사되도록 하는 rising-edge 가드. 지정하지 않으면 매 tick 레벨 기반으로
  // 실행하는 기존 동작(ProjectManagement 의 주기 폴링)을 그대로 유지한다.
  // 지정하면 done=false → true 로 바뀐 첫 tick 에 한 번만 run 을 발사하고, 이어지는
  // 동일 done 구간에서는 재발사를 차단한다. done 이 다시 false 로 떨어지면 idle
  // 상태로 되돌아가 다음 전이를 대기한다.
  isAgentDone?: () => boolean;
  // 연속 실패 상한. 초과하면 done 이 false 로 떨어졌다가 다시 true 로 재전이할
  // 때까지 run 을 중단한다. isAgentDone 가드가 있을 때만 의미가 있다(가드가
  // 없으면 "레벨 기반 영원히 반복" 이라 상한 자체가 정의되지 않는다).
  // 기본값 Infinity → 기존 동작과 동일한 무제한 재시도.
  maxRetries?: number;
  // 가드 전이/성공/실패/재시도 한도 도달을 사람이 읽을 한 줄 로그로 흘린다.
  // UI 로그 패널이 자동화 건너뜀 이유를 사용자에게 표시할 수 있도록 한다.
  onLog?: (line: string) => void;
}

export function startGitAutomationScheduler(opts: GitAutomationSchedulerOptions): () => void {
  let cancelled = false;
  let running = false;
  const gated = !!opts.isAgentDone;
  const maxRetries = opts.maxRetries ?? Infinity;
  // 가드 상태기. idle → attempting → (satisfied | exhausted) 로 전이하며,
  // done 이 false 로 떨어지는 순간 idle 로 복귀한다. satisfied/exhausted 구간에서는
  // run 이 다시 발사되지 않아, 같은 "done 구간" 이 지속돼도 커밋이 반복 쌓이지 않는다.
  type Phase = 'idle' | 'attempting' | 'satisfied' | 'exhausted';
  let phase: Phase = 'idle';
  let attempts = 0;
  const limitLabel = () => (maxRetries === Infinity ? '∞' : String(maxRetries));

  const timer = setInterval(async () => {
    if (cancelled || running) return;
    if (!opts.isEnabled()) {
      // UI 토글이 꺼지면 가드 상태기도 초기화한다. 재활성화 시 그 시점의 done 이 새
      // 사이클의 rising-edge 로 인식되도록 해, "토글을 껐다 켰는데 커밋이 안 도는"
      // 회귀를 막는다.
      if (gated && phase !== 'idle') { phase = 'idle'; attempts = 0; }
      return;
    }

    if (!gated) {
      // 레거시 경로 — ProjectManagement 의 주기 폴링이 매 tick 서버로 티크를 보내는
      // 기존 동작. isAgentDone 를 지정하지 않은 호출부는 이 분기로 들어와 동일 행동.
      running = true;
      try { await opts.run(); }
      catch (e) { opts.onError?.(e); }
      finally { running = false; }
      return;
    }

    const done = opts.isAgentDone!();
    if (!done) {
      if (phase !== 'idle') {
        phase = 'idle';
        attempts = 0;
      }
      return;
    }

    if (phase === 'satisfied' || phase === 'exhausted') return;
    if (phase === 'idle') {
      phase = 'attempting';
      attempts = 0;
      opts.onLog?.(`[git-auto] done 전이 감지 — 자동 커밋/푸시 파이프라인 개시`);
    }
    if (attempts >= maxRetries) {
      phase = 'exhausted';
      opts.onLog?.(`[git-auto] 재시도 한도(${limitLabel()}) 도달 — done 재전이까지 대기`);
      return;
    }

    running = true;
    attempts += 1;
    try {
      await opts.run();
      phase = 'satisfied';
      opts.onLog?.(`[git-auto] done 트리거 성공 (${attempts}회 시도)`);
    } catch (e) {
      opts.onLog?.(`[git-auto] done 트리거 실패 ${attempts}/${limitLabel()}: ${(e as Error).message}`);
      opts.onError?.(e);
      if (attempts >= maxRetries) {
        phase = 'exhausted';
        opts.onLog?.(`[git-auto] 재시도 한도(${limitLabel()}) 도달 — done 재전이까지 대기`);
      }
    }
    finally { running = false; }
  }, opts.intervalMs);

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}

// `git commit` stdout 의 머리글 `[branch abc1234] ...` 에서 단축 SHA 만 떼어낸다.
// 매치 실패 시 undefined — 사용자에게 "없으면 없는 대로" 보이게 하고 강제 throw 하지
// 않는다. 7자 이상의 16진 문자만 허용해, 메시지 본문에서 우연히 비슷한 토큰이
// 잡히는 오탐을 막는다. AgentStatusPanel 풋노트와 구조화 로그 양쪽이 같은 파서를
// 쓰도록 export 한다.
export function parseCommitShaFromStdout(stdout: string | undefined): string | undefined {
  if (!stdout) return undefined;
  const m = stdout.match(/\[[^\]]+\s([0-9a-f]{7,40})\]/i);
  return m ? m[1] : undefined;
}

// `gh pr create` stdout 은 마지막 줄에 PR URL 만 찍힌다. 여러 줄이 섞여 오는
// 경우에도 github.com(또는 gitlab.com)의 /pull|/merge_requests 경로만 허용해
// 오탐을 막는다. 반환은 공백이 정리된 첫 URL 한 개.
export function parsePrUrlFromStdout(stdout: string | undefined): string | undefined {
  if (!stdout) return undefined;
  const m = stdout.match(/https?:\/\/[^\s]+\/(?:pull|merge_requests)\/\d+[^\s]*/i);
  return m ? m[0].trim() : undefined;
}

// 파이프라인 실행 결과를 "호출자가 가장 자주 필요로 하는 3가지" 로 요약한다.
// 지금까지는 커밋 SHA / 푸시 성공 여부 / PR URL 이 각각 다른 경로(로그 엔트리 빌더,
// AgentStatusPanel 풋노트, server.ts 응답 해석)로 재파싱돼, 어느 한 곳에서 파서가
// 흔들리면 나머지 소비자가 조용히 어긋났다. 이 요약은 단일 출처가 되어 "서버에서
// 커밋 해시와 푸시 결과가 실제로 회수 가능한가" 를 한 함수로 계약화한다.
export interface GitAutomationRunSummary {
  // commit 단계가 성공했고 stdout 헤더에서 7자 이상 단축 SHA 를 파싱할 수 있었을 때만
  // 채워진다. commit 이 실패했거나 stdout 이 캡처되지 않았으면 undefined — 호출자는
  // 이 값의 유무로 "실제로 로컬 커밋이 성립했는가" 를 한 번에 판단할 수 있다.
  commitSha?: string;
  // push 단계가 ok=true 로 종료됐는가. push 가 플랜에 없었던(commitOnly) 경우도
  // false — "원격까지 갔는가" 만 본다. 호출자가 "autoPush 가 꺼져 false 인 건지
  // 실행이 실패해 false 인 건지" 를 구분하려면 run.results / run.skipped 를 함께 읽으면 된다.
  pushed: boolean;
  // pr 단계가 ok=true 로 종료됐고 stdout 에서 PR URL 을 파싱할 수 있었을 때만 채워진다.
  prUrl?: string;
}

export function summarizeRunResult(run: GitAutomationRunResult): GitAutomationRunSummary {
  const summary: GitAutomationRunSummary = { pushed: false };
  for (const step of run.results) {
    if (!step.ok) continue;
    if (step.label === 'commit') summary.commitSha = parseCommitShaFromStdout(step.stdout);
    else if (step.label === 'push') summary.pushed = true;
    else if (step.label === 'pr') summary.prUrl = parsePrUrlFromStdout(step.stdout);
  }
  return summary;
}

// GitAutomationRunResult 의 단계 결과 배열을 AgentStatusPanel 이 바로 소비 가능한
// 구조화 로그 엔트리로 펼친다. 계약:
//   1) 각 단계(commit/push/pr) 마다 started 엔트리 1건을 먼저 쌓고, 이어서 성공
//      → succeeded, 실패 → failed 엔트리를 1건 추가한다. 실패 이후 단계는
//      엔트리를 남기지 않아 "어디서 멈췄는가" 가 배열 길이로 그대로 드러난다.
//   2) checkout/add 처럼 UI 가 구분하지 않는 준비 단계는 로그 스테이지에서 제외한다
//      — 실패했다면 가장 가까운 다음 사용자 가시 단계(commit)에 failed 로 귀속해,
//      사용자가 "언제 무엇이 안 됐는가" 를 일관되게 읽을 수 있다.
//   3) skipped 경로(설정 비활성 등)는 commit 스테이지에 skipped 엔트리 1건으로
//      단일화한다. outcome==='skipped' 만 보면 전체 파이프라인이 시작조차 안 했음을
//      알 수 있다.
//   4) 타임스탬프는 step.startedAt / finishedAt 우선, 없으면 opts.now() 로 폴백.
//      구조화 계측이 아직 주입되지 않은 서버 버전에서도 순서 보존 + 동일 시각으로
//      안전한 결과를 돌려준다.
export interface BuildLogEntriesOptions {
  taskId?: string;
  agent?: string;
  now?: () => number;
}

const LOG_STAGE_BY_LABEL: Record<string, GitAutomationLogStage | undefined> = {
  commit: 'commit',
  push: 'push',
  pr: 'pr',
  // checkout/add 는 실패 시 아래 로직에서 가장 가까운 commit 단계에 귀속된다.
};

export function buildGitAutomationLogEntries(
  run: GitAutomationRunResult,
  opts: BuildLogEntriesOptions = {},
): GitAutomationLogEntry[] {
  const now = opts.now ?? Date.now;
  const base = { taskId: opts.taskId, agent: opts.agent, branch: run.branch };

  // 설정 비활성·프로젝트 누락: 단일 skipped 엔트리로 요약해 UI 가 "자동화가 돌지 않음"
  // 을 한눈에 구분할 수 있게 한다.
  if (run.skipped) {
    return [{
      ...base,
      stage: 'commit',
      outcome: 'skipped',
      at: now(),
      errorMessage: run.skipped === 'disabled'
        ? 'Git 자동화가 비활성 상태입니다'
        : `파이프라인이 스킵되었습니다 (${run.skipped})`,
    }];
  }

  const entries: GitAutomationLogEntry[] = [];
  // checkout/add 가 실패하면 그 실패를 "commit 단계의 failed" 로 귀속시키기 위해,
  // 첫 commit 진입 전까지 임시로 쌓아 두는 started/preparation 큐.
  let preparationFailure: GitAutomationStepResult | undefined;
  let pendingStage: GitAutomationLogStage | null = null;

  for (const step of run.results) {
    const mapped = LOG_STAGE_BY_LABEL[step.label];
    if (!mapped) {
      // 준비 단계: 실패만 기억해 두고, 다음 사용자 가시 단계에 귀속시켜 뱉는다.
      if (!step.ok) {
        preparationFailure = step;
        // 준비 단계 실패 = 커밋 단계 개시 실패로 간주.
        const failAt = step.finishedAt ?? now();
        const startAt = step.startedAt ?? failAt;
        entries.push({ ...base, stage: 'commit', outcome: 'started', at: startAt });
        entries.push({
          ...base,
          stage: 'commit',
          outcome: 'failed',
          at: failAt,
          exitCode: step.code,
          errorMessage: formatStepError(step),
        });
        break;
      }
      continue;
    }
    if (preparationFailure) break; // 이미 실패로 마감된 경우 이후 단계 무시.
    pendingStage = mapped;
    const startAt = step.startedAt ?? now();
    const endAt = step.finishedAt ?? startAt;
    entries.push({ ...base, stage: mapped, outcome: 'started', at: startAt });
    if (step.ok) {
      entries.push({
        ...base,
        stage: mapped,
        outcome: 'succeeded',
        at: endAt,
        exitCode: step.code,
        commitSha: mapped === 'commit' ? parseCommitShaFromStdout(step.stdout) : undefined,
        prUrl: mapped === 'pr' ? parsePrUrlFromStdout(step.stdout) : undefined,
      });
    } else {
      entries.push({
        ...base,
        stage: mapped,
        outcome: 'failed',
        at: endAt,
        exitCode: step.code,
        errorMessage: formatStepError(step),
      });
      break;
    }
  }

  // run 이 전반적으로 실패했는데 results 가 비어 있는 방어 경로(예: executeGitAutomation
  // 자체가 try/catch 로 error 만 채움). 최소한의 failed 엔트리를 한 건 남겨 UI 침묵을 막는다.
  if (!run.ok && !run.skipped && entries.length === 0) {
    entries.push({
      ...base,
      stage: 'commit',
      outcome: 'failed',
      at: now(),
      errorMessage: run.error || '자동화 실행 중 알 수 없는 오류가 발생했습니다',
    });
  }
  // pendingStage 는 디버그용으로 남겨도 되지만, 외부 소비자에게 노출할 필요는 없다.
  void pendingStage;
  return entries;
}

function formatStepError(step: GitAutomationStepResult): string {
  const code = step.code === null || step.code === undefined ? '?' : String(step.code);
  const stderr = step.stderr?.trim();
  const body = stderr ? ` — ${stderr}` : '';
  return `[${step.label}] exit=${code}${body}`.slice(0, 400);
}

// 설정값을 저장하기 전 최소한의 정합성을 검증한다. 빈 템플릿/잘못된 flowLevel
// 같은 UI 입력 실수는 여기서 거른다.
export function validateGitAutomationConfig(
  raw: Partial<GitAutomationConfig>,
): { ok: true; config: GitAutomationConfig } | { ok: false; error: string } {
  const merged = { ...DEFAULT_GIT_AUTOMATION_CONFIG, ...raw };
  if (!['commitOnly', 'commitPush', 'commitPushPR'].includes(merged.flowLevel)) {
    return { ok: false, error: `invalid flowLevel: ${merged.flowLevel}` };
  }
  if (!merged.branchTemplate.includes('{slug}')) {
    return { ok: false, error: 'branchTemplate must include {slug} token' };
  }
  if (!['conventional', 'plain'].includes(merged.commitConvention)) {
    return { ok: false, error: `invalid commitConvention: ${merged.commitConvention}` };
  }
  if (!Array.isArray(merged.reviewers)) {
    return { ok: false, error: 'reviewers must be an array' };
  }
  // enabled 는 옵셔널이지만, 들어오면 반드시 boolean — 문자열 'false' 같은 값이
  // DB/MCP 응답 누수로 섞여 들어오면 가드 체크가 항상 false 가 아니라 truthy 로
  // 풀려 실제로 자동화가 도는 사고가 난다. 타입 가드를 여기서 단일 출처로 강제한다.
  if (merged.enabled !== undefined && typeof merged.enabled !== 'boolean') {
    return { ok: false, error: `invalid enabled: ${String(merged.enabled)}` };
  }
  return { ok: true, config: merged };
}
