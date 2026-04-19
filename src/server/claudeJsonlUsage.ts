// Claude Code 가 로컬에 쌓는 세션 로그(*.jsonl)에서 usage 를 합산해 서버 집계에
// 반영한다. IDE 의 `/usage` 슬래시 명령은 headless 에서 막히는 경우가 많아,
// 동일 머신의 `~/.config/claude/projects` · `~/.claude/projects` 등을 읽는 우회 경로다.
//
// 증분만 더하기 위해 직전 스캔 합계를 baseline 파일에 저장한다. 로그 로테이션으로
// 합계가 줄어들면 baseline 을 현재값으로 맞추고 음수 델타는 기록하지 않는다.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

import type { ClaudeTokenUsage } from '../types';

export interface JsonlAggregateTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** 스캔한 .jsonl 파일 수 */
  readonly fileCount: number;
  /** 파싱해 usage 로 인정한 줄 수 */
  readonly usageLineCount: number;
}

export interface JsonlBaseline {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly savedAt: string;
}

export interface JsonlSyncResult {
  readonly ok: boolean;
  readonly roots: readonly string[];
  readonly aggregate: JsonlAggregateTotals;
  readonly deltaRecorded: boolean;
  readonly delta: JsonlAggregateTotals | null;
  readonly baselineUpdated: boolean;
  readonly error?: string;
}

function safeInt(n: unknown): number {
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.floor(n);
  if (typeof n === 'string') {
    const p = parseInt(n, 10);
    return Number.isFinite(p) && p >= 0 ? p : 0;
  }
  return 0;
}

/** 한 객체에서 Anthropic usage 형태를 한 번만 추출 (깊은 탐색, 깊이 제한). */
function extractUsageShape(o: unknown, depth = 0): Pick<
  ClaudeTokenUsage,
  'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
> | null {
  if (depth > 10 || !o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const hasTokenShape =
    'input_tokens' in r || 'output_tokens' in r
    || 'cache_read_input_tokens' in r || 'cache_creation_input_tokens' in r;
  if (hasTokenShape) {
    const input_tokens = safeInt(r.input_tokens);
    const output_tokens = safeInt(r.output_tokens);
    const cache_read_input_tokens = safeInt(r.cache_read_input_tokens);
    const cache_creation_input_tokens = safeInt(r.cache_creation_input_tokens);
    if (input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens === 0) {
      return null;
    }
    return { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens };
  }
  if (r.usage && typeof r.usage === 'object') {
    const u = extractUsageShape(r.usage, depth + 1);
    if (u) return u;
  }
  if (r.message && typeof r.message === 'object') {
    const u = extractUsageShape(r.message, depth + 1);
    if (u) return u;
  }
  if (r.delta && typeof r.delta === 'object') {
    const u = extractUsageShape(r.delta, depth + 1);
    if (u) return u;
  }
  for (const v of Object.values(r)) {
    if (v && typeof v === 'object') {
      const u = extractUsageShape(v, depth + 1);
      if (u) return u;
    }
  }
  return null;
}

function* walkJsonlFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkJsonlFiles(p);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      yield p;
    }
  }
}

const MAX_FILE_BYTES = 80 * 1024 * 1024;

/**
 * Claude Code 기본 프로젝트 로그 루트(신규/구 경로) + CLAUDE_CONFIG_DIR·추가 ENV.
 */
export function resolveClaudeCodeJsonlRoots(extraFromEnv?: string | null): string[] {
  const roots = new Set<string>();
  const home = homedir();
  roots.add(path.join(home, '.config', 'claude', 'projects'));
  roots.add(path.join(home, '.claude', 'projects'));

  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (cfg) {
    roots.add(path.join(cfg, 'projects'));
    if (cfg.toLowerCase().endsWith('projects')) roots.add(cfg);
  }

  const extra = (extraFromEnv ?? process.env.CLAUDE_JSONL_EXTRA_ROOTS ?? '').trim();
  if (extra) {
    for (const part of extra.split(/[;,]/)) {
      const t = part.trim();
      if (t) roots.add(path.resolve(t));
    }
  }

  return [...roots];
}

export function aggregateUsageFromJsonlRoots(roots: readonly string[]): JsonlAggregateTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let fileCount = 0;
  let usageLineCount = 0;

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of walkJsonlFiles(root)) {
      let st: { size: number };
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      fileCount += 1;
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(t);
        } catch {
          continue;
        }
        const u = extractUsageShape(obj);
        if (!u) continue;
        usageLineCount += 1;
        inputTokens += u.input_tokens;
        outputTokens += u.output_tokens;
        cacheReadTokens += u.cache_read_input_tokens;
        cacheCreationTokens += u.cache_creation_input_tokens;
      }
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    fileCount,
    usageLineCount,
  };
}

function loadBaseline(baselinePath: string): JsonlBaseline | null {
  if (!existsSync(baselinePath)) return null;
  try {
    const raw = readFileSync(baselinePath, 'utf8');
    const j = JSON.parse(raw) as Partial<JsonlBaseline>;
    if (typeof j.inputTokens !== 'number' || typeof j.outputTokens !== 'number') return null;
    return {
      inputTokens: Math.max(0, Math.floor(j.inputTokens)),
      outputTokens: Math.max(0, Math.floor(j.outputTokens)),
      cacheReadTokens: Math.max(0, Math.floor(j.cacheReadTokens ?? 0)),
      cacheCreationTokens: Math.max(0, Math.floor(j.cacheCreationTokens ?? 0)),
      savedAt: typeof j.savedAt === 'string' ? j.savedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function saveBaseline(baselinePath: string, agg: JsonlAggregateTotals): void {
  const dir = path.dirname(baselinePath);
  mkdirSync(dir, { recursive: true });
  const payload: JsonlBaseline = {
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheCreationTokens: agg.cacheCreationTokens,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(baselinePath, JSON.stringify(payload, null, 2), 'utf8');
}

function subPos(a: JsonlAggregateTotals, b: JsonlBaseline): JsonlAggregateTotals {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens),
    cacheCreationTokens: Math.max(0, a.cacheCreationTokens - b.cacheCreationTokens),
    fileCount: a.fileCount,
    usageLineCount: a.usageLineCount,
  };
}

/**
 * 로컬 JSONL 합계를 스캔하고, 직전 baseline 대비 증분만 `record` 로 한 건 반영한다.
 * 최초 실행은 `CLAUDE_JSONL_SEED!==0` 이면 전체 합을 한 번 시드한 뒤 baseline 을 저장한다.
 */
export function syncJsonlUsageDeltas(options: {
  baselinePath: string;
  roots?: readonly string[];
  record: (usage: ClaudeTokenUsage) => void;
}): JsonlSyncResult {
  const roots = options.roots ?? resolveClaudeCodeJsonlRoots();
  try {
    const aggregate = aggregateUsageFromJsonlRoots(roots);
    const prev = loadBaseline(options.baselinePath);

    const hasAgg = (a: JsonlAggregateTotals) =>
      a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheCreationTokens > 0;

    if (!prev) {
      const seedFirst = process.env.CLAUDE_JSONL_SEED !== '0';
      let seeded = false;
      if (seedFirst && hasAgg(aggregate)) {
        options.record({
          input_tokens: aggregate.inputTokens,
          output_tokens: aggregate.outputTokens,
          cache_read_input_tokens: aggregate.cacheReadTokens,
          cache_creation_input_tokens: aggregate.cacheCreationTokens,
          model: 'local-claude-jsonl-seed',
          at: new Date().toISOString(),
        });
        seeded = true;
      }
      saveBaseline(options.baselinePath, aggregate);
      return {
        ok: true,
        roots,
        aggregate,
        deltaRecorded: seeded,
        delta: seeded ? aggregate : null,
        baselineUpdated: true,
      };
    }

    const delta = subPos(aggregate, prev);
    const hasDelta =
      delta.inputTokens > 0
      || delta.outputTokens > 0
      || delta.cacheReadTokens > 0
      || delta.cacheCreationTokens > 0;

    if (hasDelta) {
      options.record({
        input_tokens: delta.inputTokens,
        output_tokens: delta.outputTokens,
        cache_read_input_tokens: delta.cacheReadTokens,
        cache_creation_input_tokens: delta.cacheCreationTokens,
        model: 'local-claude-jsonl',
        at: new Date().toISOString(),
      });
    }

    saveBaseline(options.baselinePath, aggregate);

    return {
      ok: true,
      roots,
      aggregate,
      deltaRecorded: hasDelta,
      delta: hasDelta ? delta : null,
      baselineUpdated: true,
    };
  } catch (e) {
    return {
      ok: false,
      roots,
      aggregate: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        fileCount: 0,
        usageLineCount: 0,
      },
      deltaRecorded: false,
      delta: null,
      baselineUpdated: false,
      error: (e as Error).message,
    };
  }
}

export const DEFAULT_JSONL_BASELINE_PATH = path.join(process.cwd(), 'data', 'claude-jsonl-usage-baseline.json');
