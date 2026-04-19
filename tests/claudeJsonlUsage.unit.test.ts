// Run with: npx tsx --test tests/claudeJsonlUsage.unit.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  aggregateUsageFromJsonlRoots,
  syncJsonlUsageDeltas,
} from '../src/server/claudeJsonlUsage.ts';
import type { ClaudeTokenUsage } from '../src/types.ts';

test('aggregateUsageFromJsonlRoots — usage 가 있는 줄만 합산한다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-jsonl-'));
  try {
    const log = path.join(dir, 's.jsonl');
    writeFileSync(
      log,
      [
        JSON.stringify({ type: 'meta', foo: 1 }),
        JSON.stringify({
          type: 'result',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 0,
          },
        }),
        JSON.stringify({
          usage: {
            input_tokens: 3,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }),
        '',
      ].join('\n'),
      'utf8',
    );
    const agg = aggregateUsageFromJsonlRoots([dir]);
    assert.equal(agg.fileCount, 1);
    assert.equal(agg.usageLineCount, 2);
    assert.equal(agg.inputTokens, 13);
    assert.equal(agg.outputTokens, 7);
    assert.equal(agg.cacheReadTokens, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncJsonlUsageDeltas — 증분만 record 된다 (시드 끔)', () => {
  const prevSeed = process.env.CLAUDE_JSONL_SEED;
  process.env.CLAUDE_JSONL_SEED = '0';
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-jsonl-'));
  const baseline = path.join(dir, 'baseline.json');
  const logDir = path.join(dir, 'proj');
  mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, 'a.jsonl');
  writeFileSync(
    log,
    JSON.stringify({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }) + '\n',
    'utf8',
  );

  const recorded: ClaudeTokenUsage[] = [];
  const r1 = syncJsonlUsageDeltas({
    baselinePath: baseline,
    roots: [logDir],
    record: (u) => recorded.push(u),
  });
  assert.equal(r1.deltaRecorded, false, '시드 없이 baseline 만');
  assert.equal(recorded.length, 0);

  writeFileSync(
    log,
    [
      JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
      JSON.stringify({
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  const r2 = syncJsonlUsageDeltas({
    baselinePath: baseline,
    roots: [logDir],
    record: (u) => recorded.push(u),
  });
  assert.equal(r2.deltaRecorded, true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].input_tokens, 20);
  assert.equal(recorded[0].output_tokens, 10);

  process.env.CLAUDE_JSONL_SEED = prevSeed;
  rmSync(dir, { recursive: true, force: true });
});
