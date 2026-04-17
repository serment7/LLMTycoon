import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

export type Milestone = {
  id: string;
  title: string;
  branch: string;
  baseBranch?: string;
  body?: string;
  labels?: string[];
  reviewers?: string[];
  draft?: boolean;
};

export type MilestoneResult =
  | { status: 'no-changes'; id: string }
  | { status: 'opened'; id: string; branch: string; prUrl: string }
  | { status: 'exists'; id: string; branch: string; prUrl: string }
  | { status: 'skipped'; id: string; reason: string };

export type BatchSummary = {
  total: number;
  opened: number;
  existed: number;
  noChanges: number;
  skipped: number;
  results: MilestoneResult[];
};

type RunOptions = { allowFailure?: boolean; dryRun?: boolean };

function run(cmd: string, opts: RunOptions = {}): string {
  if (opts.dryRun) {
    console.log(`[dry-run] ${cmd}`);
    return '';
  }
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (opts.allowFailure) return '';
    throw err;
  }
}

function hasUncommittedChanges(): boolean {
  return run('git status --porcelain').length > 0;
}

function ghAvailable(): boolean {
  return run('gh --version', { allowFailure: true }).length > 0;
}

function currentBranch(): string {
  return run('git rev-parse --abbrev-ref HEAD', { allowFailure: true });
}

function hasStagedChanges(): boolean {
  // `git status --porcelain` reports untracked too; after `git add -A` we want
  // to confirm the index actually differs from HEAD before spending a commit.
  return run('git diff --cached --name-only', { allowFailure: true }).length > 0;
}

function existingPrUrl(head: string): string {
  // Returns the URL of an open PR for this head branch, or '' if none.
  const out = run(
    `gh pr list --head ${head} --state open --json url --jq ".[0].url"`,
    { allowFailure: true },
  );
  return out;
}

// Conservative branch-name sanitizer: git allows a broad set, but for automation
// we restrict to a safe subset so the name can be interpolated into shell args.
const BRANCH_RE = /^[A-Za-z0-9._\-\/]+$/;
const ID_RE = /^[A-Za-z0-9._\-]+$/;
const MAX_TITLE_LEN = 120;
const MAX_BRANCH_LEN = 200;

export function validateMilestone(m: Milestone): void {
  if (!m.id || !m.title || !m.branch) {
    throw new Error('milestone requires id, title, branch');
  }
  if (!ID_RE.test(m.id)) {
    throw new Error(`unsafe milestone id: ${m.id}`);
  }
  if (m.title.length > MAX_TITLE_LEN) {
    throw new Error(`title exceeds ${MAX_TITLE_LEN} chars: ${m.id}`);
  }
  if (m.branch.length > MAX_BRANCH_LEN) {
    throw new Error(`branch name exceeds ${MAX_BRANCH_LEN} chars: ${m.branch}`);
  }
  if (!BRANCH_RE.test(m.branch)) {
    throw new Error(`unsafe branch name: ${m.branch}`);
  }
  // Reject git-reserved tokens that could confuse downstream commands.
  if (m.branch.includes('..') || m.branch.startsWith('-') || m.branch.endsWith('/')) {
    throw new Error(`malformed branch name: ${m.branch}`);
  }
  if (m.baseBranch && !BRANCH_RE.test(m.baseBranch)) {
    throw new Error(`unsafe base branch name: ${m.baseBranch}`);
  }
}

// QA pre-flight: surface conflicts before any git mutation occurs.
// Returns the offending entries so the caller can decide how to react.
export function validateBatch(milestones: Milestone[]): {
  duplicateIds: string[];
  duplicateBranches: string[];
  invalid: Array<{ id: string; reason: string }>;
} {
  const idCount = new Map<string, number>();
  const branchCount = new Map<string, number>();
  const invalid: Array<{ id: string; reason: string }> = [];
  for (const m of milestones) {
    try {
      validateMilestone(m);
    } catch (err) {
      invalid.push({ id: m.id ?? '<missing>', reason: (err as Error).message });
      continue;
    }
    idCount.set(m.id, (idCount.get(m.id) ?? 0) + 1);
    branchCount.set(m.branch, (branchCount.get(m.branch) ?? 0) + 1);
  }
  return {
    duplicateIds: [...idCount.entries()].filter(([, n]) => n > 1).map(([k]) => k),
    duplicateBranches: [...branchCount.entries()].filter(([, n]) => n > 1).map(([k]) => k),
    invalid,
  };
}

// Escape a string for safe inclusion inside a double-quoted shell argument.
// NUL bytes and raw newlines are rejected outright — both have surprised us in
// past automation runs (truncation and accidental multi-command execution).
function shellQuote(s: string): string {
  if (s.includes('\u0000') || /\r|\n/.test(s)) {
    throw new Error('shellQuote rejects NUL and newline characters');
  }
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

export async function handleMilestone(
  m: Milestone,
  opts: { dryRun?: boolean } = {},
): Promise<MilestoneResult> {
  validateMilestone(m);
  const base = m.baseBranch ?? 'main';

  if (!opts.dryRun && !ghAvailable()) {
    return { status: 'skipped', id: m.id, reason: 'gh CLI not installed' };
  }

  if (!hasUncommittedChanges()) {
    console.log(`[milestone:${m.id}] no changes to commit`);
    return { status: 'no-changes', id: m.id };
  }

  const runOpts: RunOptions = { dryRun: opts.dryRun };
  run(`git checkout -B ${m.branch}`, runOpts);
  run('git add -A', runOpts);

  // Staging can become empty if a .gitignore rule swallowed every dirty path.
  // Skip the commit/push/PR dance entirely in that case — it's effectively a
  // no-op and a failed `git commit` would leave us on the new branch.
  if (!opts.dryRun && !hasStagedChanges()) {
    console.log(`[milestone:${m.id}] nothing staged after add; treating as no-changes`);
    return { status: 'no-changes', id: m.id };
  }

  run(`git commit -m ${shellQuote(`feat(${m.id}): ${m.title}`)}`, runOpts);
  run(`git push -u origin ${m.branch}`, runOpts);

  // If a PR already exists for this head branch, reuse it instead of letting
  // `gh pr create` fail with a non-obvious error. Idempotency matters when
  // this script runs from a scheduler that retries on transient failures.
  if (!opts.dryRun) {
    const existing = existingPrUrl(m.branch);
    if (existing) {
      console.log(`[milestone:${m.id}] PR already exists: ${existing}`);
      return { status: 'exists', id: m.id, branch: m.branch, prUrl: existing };
    }
  }

  // Pass the PR body via a temp file so multi-line bodies and special
  // characters survive intact regardless of shell quoting rules.
  const body = m.body ?? renderPrBodyTemplate(m);
  const tmp = mkdtempSync(join(tmpdir(), 'milestone-'));
  const bodyPath = join(tmp, 'body.md');
  if (!opts.dryRun) writeFileSync(bodyPath, body, 'utf8');

  const flags = [
    `--base ${base}`,
    `--head ${m.branch}`,
    `--title ${shellQuote(m.title)}`,
    `--body-file ${shellQuote(bodyPath)}`,
  ];
  if (m.draft) flags.push('--draft');
  if (m.labels?.length) flags.push(`--label ${shellQuote(m.labels.join(','))}`);
  if (m.reviewers?.length) flags.push(`--reviewer ${shellQuote(m.reviewers.join(','))}`);

  let prUrl = '';
  try {
    prUrl = run(`gh pr create ${flags.join(' ')}`, runOpts);
  } finally {
    if (!opts.dryRun) rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`[milestone:${m.id}] PR opened: ${prUrl}`);
  return { status: 'opened', id: m.id, branch: m.branch, prUrl };
}

export function formatSummary(summary: BatchSummary): string {
  const header =
    `milestones total=${summary.total} ` +
    `opened=${summary.opened} existed=${summary.existed} ` +
    `no-changes=${summary.noChanges} skipped=${summary.skipped}`;
  const lines: string[] = [header];
  for (const r of summary.results) {
    if (r.status === 'opened' || r.status === 'exists') {
      lines.push(`[${r.status}] ${r.id} (${r.branch}) ${r.prUrl}`);
    } else if (r.status === 'skipped') {
      lines.push(`[skipped] ${r.id}: ${r.reason}`);
    } else {
      lines.push(`[no-changes] ${r.id}`);
    }
  }
  return lines.join('\n');
}

// Default PR body, used when the milestone author didn't supply one.
// Kept minimal and predictable so reviewers always know where to look:
// Summary up top, Scope as a checklist (since labels/reviewers are known
// at call time), and a Verification hint pointing at the branch.
export function renderPrBodyTemplate(m: Milestone): string {
  const labels = m.labels?.length ? m.labels.map((l) => `\`${l}\``).join(', ') : '_none_';
  const reviewers = m.reviewers?.length
    ? m.reviewers.map((r) => `@${r.replace(/^@/, '')}`).join(', ')
    : '_none_';
  return [
    `## Summary`,
    ``,
    `Automated PR for milestone **${m.id}** — ${m.title}`,
    ``,
    `## Scope`,
    ``,
    `- Branch: \`${m.branch}\``,
    `- Labels: ${labels}`,
    `- Reviewers: ${reviewers}`,
    ``,
    `## Verification`,
    ``,
    `- [ ] CI is green on \`${m.branch}\``,
    `- [ ] Summary above still matches the final diff`,
    ``,
    `_Generated by milestone-automation._`,
  ].join('\n');
}

export async function handleMilestones(
  milestones: Milestone[],
  opts: { dryRun?: boolean; stopOnError?: boolean } = {},
): Promise<BatchSummary> {
  // Fail fast on duplicate ids/branches — running the loop would otherwise
  // happily push twice to the same branch and the second PR open would error
  // mid-batch with state already mutated on disk.
  const issues = validateBatch(milestones);
  if (issues.duplicateIds.length || issues.duplicateBranches.length) {
    throw new Error(
      `batch has duplicates — ids: [${issues.duplicateIds.join(', ')}], ` +
        `branches: [${issues.duplicateBranches.join(', ')}]`,
    );
  }
  const startBranch = currentBranch();
  const results: MilestoneResult[] = [];
  for (const m of milestones) {
    try {
      results.push(await handleMilestone(m, { dryRun: opts.dryRun }));
    } catch (err) {
      console.error(`[milestone:${m.id}] failed:`, (err as Error).message);
      results.push({ status: 'skipped', id: m.id, reason: (err as Error).message });
      if (opts.stopOnError) break;
    }
  }
  if (startBranch && startBranch !== 'HEAD' && !opts.dryRun) {
    run(`git checkout ${startBranch}`, { allowFailure: true });
  }
  return {
    total: milestones.length,
    opened: results.filter((r) => r.status === 'opened').length,
    existed: results.filter((r) => r.status === 'exists').length,
    noChanges: results.filter((r) => r.status === 'no-changes').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  };
}

const USAGE =
  'usage: tsx scripts/milestone-automation.ts <id> <title> <branch> [base]\n' +
  '       [--dry-run] [--json] [--draft] [--label L]... [--reviewer R]... [--body-file PATH]';

// Flags that consume the following argv token as their value. Centralised so
// parseArgs can detect "--label --draft" and complain instead of silently
// swallowing --draft as the label value.
const VALUED_FLAGS = new Set(['--label', '--reviewer', '--body-file']);

export function parseArgs(argv: string[]): {
  milestone: Milestone;
  dryRun: boolean;
  json: boolean;
} {
  const positional: string[] = [];
  let dryRun = false;
  let json = false;
  let draft = false;
  const labels: string[] = [];
  const reviewers: string[] = [];
  let bodyFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--json') json = true;
    else if (a === '--draft') draft = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (VALUED_FLAGS.has(a)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${a} requires a value\n${USAGE}`);
      }
      if (a === '--label') labels.push(next);
      else if (a === '--reviewer') reviewers.push(next);
      else if (a === '--body-file') bodyFile = next;
      i++;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}\n${USAGE}`);
    } else positional.push(a);
  }
  const [id, title, branch, baseBranch] = positional;
  if (!id || !title || !branch) {
    throw new Error(USAGE);
  }
  const milestone: Milestone = { id, title, branch, baseBranch };
  if (draft) milestone.draft = true;
  if (labels.length) milestone.labels = labels;
  if (reviewers.length) milestone.reviewers = reviewers;
  if (bodyFile) milestone.body = readFileSync(bodyFile, 'utf8');
  return { milestone, dryRun, json };
}

// Detect CLI invocation by script basename so the check survives compilation to
// .js, path-separator differences on Windows, and being launched via tsx/node.
function isCliEntry(entry: string | undefined): boolean {
  if (!entry) return false;
  const name = basename(entry);
  return name === 'milestone-automation.ts' || name === 'milestone-automation.js';
}

if (isCliEntry(process.argv[1])) {
  try {
    const { milestone, dryRun, json } = parseArgs(process.argv.slice(2));
    handleMilestone(milestone, { dryRun })
      .then((result) => {
        if (json) console.log(JSON.stringify(result));
        if (result.status === 'skipped') process.exit(2);
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
