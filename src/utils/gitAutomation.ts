import { isExcludedFromGitStaging } from './codeGraphFilter';

// 커밋 → 푸시 → PR 의 어디까지 자동으로 실행할지. UI 토글과 일대일로 매핑된다.
export type FlowLevel = 'commitOnly' | 'commitPush' | 'commitPushPR';

export type CommitConvention = 'conventional' | 'plain';

// SQLite `git_automation_config` 테이블의 1:1 매핑. 서버 쪽 simple-git
// 래퍼와 UI 폼이 공유하므로, 필드 추가 시 양쪽 마이그레이션을 반드시 함께 진행할 것.
export interface GitAutomationConfig {
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
export function shouldAutoCommit(config: Pick<GitAutomationConfig, 'flowLevel'>): boolean {
  return config.flowLevel === 'commitOnly'
      || config.flowLevel === 'commitPush'
      || config.flowLevel === 'commitPushPR';
}

export function shouldAutoPush(config: Pick<GitAutomationConfig, 'flowLevel'>): boolean {
  return config.flowLevel === 'commitPush' || config.flowLevel === 'commitPushPR';
}

export function shouldAutoOpenPR(config: Pick<GitAutomationConfig, 'flowLevel'>): boolean {
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

export function commit(config: Pick<GitAutomationConfig, 'flowLevel'>, ctx: GitRunContext): GitRunStep[] {
  if (!shouldAutoCommit(config)) return [];
  // 변경 사항이 없으면 commit 이 실패하므로 `--allow-empty` 는 일부러 쓰지 않는다.
  // 호출자가 스테이징 후 이 함수를 호출한다는 전제.
  return [
    { label: 'checkout', cmd: ['git', '-C', ctx.workspacePath, 'checkout', '-B', ctx.branch] },
    { label: 'add',      cmd: ['git', '-C', ctx.workspacePath, 'add', '-A'] },
    { label: 'commit',   cmd: ['git', '-C', ctx.workspacePath, 'commit', '-m', ctx.commitMessage] },
  ];
}

export function push(config: Pick<GitAutomationConfig, 'flowLevel'>, ctx: GitRunContext): GitRunStep[] {
  if (!shouldAutoPush(config)) return [];
  return [
    { label: 'push', cmd: ['git', '-C', ctx.workspacePath, 'push', '-u', 'origin', ctx.branch] },
  ];
}

// PR 생성은 git CLI 만으로는 불가능하므로 `gh` CLI 를 전제로 한다.
// 환경에 gh 가 없다면 호출자가 step 배열을 비워 빈 배열로 받게 된다(상위에서 판단).
export function createPR(config: Pick<GitAutomationConfig, 'flowLevel'>, ctx: GitRunContext): GitRunStep[] {
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
export function buildRunPlan(config: Pick<GitAutomationConfig, 'flowLevel'>, ctx: GitRunContext): GitRunStep[] {
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
}

export function startGitAutomationScheduler(opts: GitAutomationSchedulerOptions): () => void {
  let cancelled = false;
  let running = false;
  const timer = setInterval(async () => {
    if (cancelled || running || !opts.isEnabled()) return;
    running = true;
    try { await opts.run(); }
    catch (e) { opts.onError?.(e); }
    finally { running = false; }
  }, opts.intervalMs);

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
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
  return { ok: true, config: merged };
}
