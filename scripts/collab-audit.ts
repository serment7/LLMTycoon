#!/usr/bin/env tsx
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * docs/inbox + docs/handoffs 를 파싱해 협업 감사 JSON을 stdout 으로 내보낸다.
 * 근거: docs/reports/2026-04-17-collab-audit.md §5-③.
 *
 *   pnpm/npm run audit:collab        # 모든 인박스 누적 집계
 *   pnpm/npm run audit:collab -- 2026-04-17   # 해당 날짜 창으로 한정
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  computeForbiddenSoloRate,
  parseDirectiveBlocks,
  summarizeDirectiveRouting,
  type DirectiveEntry,
  type MatrixVerdict,
  type SoloHandlingRecord,
} from '../src/utils/workspaceInsights.ts';
import { parseEntry, type LedgerEntry } from '../src/utils/handoffLedger.ts';

const REPO_ROOT = resolve(process.cwd());
const INBOX_DIR = join(REPO_ROOT, 'docs', 'inbox');
const HANDOFF_DIR = join(REPO_ROOT, 'docs', 'handoffs');

const FORBIDDEN_KEYWORDS = [
  '데이터',
  '지표',
  '분석',
  '감사',
  '컴포넌트',
  '서비스',
  '버그',
  'UI',
  '레이아웃',
  '스타일',
];

const ALLOWED_KEYWORDS = ['프로토콜', '차터', '규칙', '인박스', '사용자 응답', 'HANDOFF'];

function listMarkdown(dir: string): string[] {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => join(dir, f));
}

function classifyVerdictByKeyword(digest: string): MatrixVerdict {
  const hay = digest.toLowerCase();
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (hay.includes(kw.toLowerCase())) return 'forbidden';
  }
  for (const kw of ALLOWED_KEYWORDS) {
    if (hay.includes(kw.toLowerCase())) return 'allowed';
  }
  // 매트릭스 미매칭은 보수적으로 forbidden 취급 — 감사 분모 누수 방지.
  return 'forbidden';
}

function resolveVerdict(entry: DirectiveEntry): {
  verdict: MatrixVerdict;
  source: 'matrixBasis' | 'keyword';
} {
  if (entry.verdict) return { verdict: entry.verdict, source: 'matrixBasis' };
  return { verdict: classifyVerdictByKeyword(entry.digest), source: 'keyword' };
}

function toSoloRecord(entry: DirectiveEntry): SoloHandlingRecord {
  return {
    directiveDigest: entry.digest,
    tick: entry.tick,
    verdict: resolveVerdict(entry).verdict,
    delegatedCount: entry.handoffs.length,
    alphaSoloNote: entry.alphaSolo || '없음',
  };
}

function parseInboxFiles(filter?: string): DirectiveEntry[] {
  const files = listMarkdown(INBOX_DIR).filter(
    (p) => !filter || p.includes(filter),
  );
  const out: DirectiveEntry[] = [];
  for (const path of files) {
    const relPath = relative(REPO_ROOT, path).replace(/\\/g, '/');
    const md = readFileSync(path, 'utf8');
    out.push(...parseDirectiveBlocks(md, relPath));
  }
  return out;
}

function parseHandoffFiles(filter?: string): LedgerEntry[] {
  const files = listMarkdown(HANDOFF_DIR).filter(
    (p) => !filter || p.includes(filter),
  );
  return files.map((path) => {
    const relPath = relative(REPO_ROOT, path).replace(/\\/g, '/');
    const content = readFileSync(path, 'utf8');
    return parseEntry({ path: relPath, kind: 'handoff', content });
  });
}

function detectOrphans(
  handoffs: LedgerEntry[],
  entries: DirectiveEntry[],
): LedgerEntry[] {
  const linked = new Set<string>();
  for (const e of entries) {
    for (const h of e.handoffs) linked.add(h);
  }
  return handoffs.filter((h) => !linked.has(h.path));
}

function main() {
  const filter = process.argv[2];
  const entries = parseInboxFiles(filter);
  const handoffs = parseHandoffFiles(filter);
  const records = entries.map(toSoloRecord);

  const routing = summarizeDirectiveRouting(entries);
  const forbiddenSolo = computeForbiddenSoloRate(records);
  const orphans = detectOrphans(handoffs, entries);

  const report = {
    generatedAt: new Date().toISOString(),
    filter: filter ?? null,
    inputs: {
      inboxFiles: listMarkdown(INBOX_DIR)
        .filter((p) => !filter || p.includes(filter))
        .map((p) => relative(REPO_ROOT, p).replace(/\\/g, '/')),
      handoffFiles: handoffs.map((h) => h.path),
    },
    summary: {
      routing,
      forbiddenSolo,
      orphanHandoffCount: orphans.length,
    },
    directives: entries.map((e) => {
      const { verdict, source } = resolveVerdict(e);
      return {
        tick: e.tick,
        digest: e.digest,
        status: e.status,
        handoffs: e.handoffs,
        alphaSolo: e.alphaSolo,
        sourcePath: e.sourcePath,
        matrixBasis: e.matrixBasis ?? null,
        verdict,
        verdictSource: source,
      };
    }),
    orphans: orphans.map((h) => ({
      id: h.id,
      path: h.path,
      status: h.status,
      from: h.from,
      to: h.to,
      slug: h.slug,
    })),
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (forbiddenSolo.thresholdExceeded) {
    process.stderr.write(
      `⚠ ❌ 단독 처리율 임계(20%) 초과: ${(forbiddenSolo.rate * 100).toFixed(1)}%\n`,
    );
    process.exitCode = 2;
  }
}

main();
