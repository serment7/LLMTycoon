// Run with: npx tsx --test tests/token-budget/tokenBudgetPipeline.spec.ts
//
// 지시 #9ead51d5 (QA) · 토큰 절약 전략 파이프라인 회귀.
//
// 대상: Thanos 가 구현 중인 src/llm/tokenBudget.ts · src/llm/client.ts 프롬프트
// 캐싱 · src/llm/usageLog.ts. 본 스펙은 세 파일이 채워지기 전 **계약 선(先)고정**
// 을 목적으로 하며, 기존 src/server/claudeClient.ts 의 buildCacheableMessages ·
// extractUsageFromStreamJsonResult 와 src/utils/claudeTokenUsageStore.ts 의 mergeUsage
// 를 실제 프리미티브로 사용한다. 새 모듈이 도착하면 인라인 헬퍼(formatUsageLogLine ·
// parseUsageLogLine · shouldCompact · compactHistory) 를 import 로 교체한다.
//
// 시나리오
//   S1. recordUsage — input/output/cacheRead/cacheCreation 축이 각각 정확히 누적.
//   S2. shouldCompact · compactHistory — 임계 초과 시 true, 오래된 턴만 summary
//        블록으로 치환되고 최신 3턴 + summary 가 보존.
//   S3. SDK 호출 페이로드 — 시스템/에이전트/툴 세 구간이 별도 블록으로 구성되고
//        cache_control 프리픽스가 올바른 위치에 하나 이상 붙는다.
//   S4. 반복 호출 — stream-json result 이벤트를 번갈아 수신하면 cache_read 누적이
//        단조 증가하고 cacheHitRate 가 상승한다(토큰 비용 감소 신호).
//   S5. usageLog JSON lines — formatUsageLogLine 출력이 parseUsageLogLine 왕복 파싱
//        을 통과하고 필수 스키마(ts, model, input, output, cacheRead, cacheCreation)
//        를 모두 포함한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCacheableMessages,
  extractUsageFromStreamJsonResult,
} from '../../src/server/claudeClient.ts';
import {
  EMPTY_TOTALS,
  mergeUsage,
  cacheHitRate,
} from '../../src/utils/claudeTokenUsageStore.ts';
import type {
  ClaudeTokenUsage,
  ClaudeTokenUsageTotals,
} from '../../src/types.ts';

// ────────────────────────────────────────────────────────────────────────────
// 계약 헬퍼 — src/llm/{tokenBudget,usageLog}.ts 가 가져갈 의도
// ────────────────────────────────────────────────────────────────────────────

interface ConversationTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly tokens: number; // 근사 — tiktoken 없이도 작동하도록 문자열 길이 기반 테스트용.
}

interface CompactedHistory {
  readonly summary: string;
  readonly kept: readonly ConversationTurn[];
}

export function shouldCompact(turns: readonly ConversationTurn[], thresholdTokens: number): boolean {
  const total = turns.reduce((acc, t) => acc + t.tokens, 0);
  return total >= thresholdTokens;
}

/**
 * 오래된 턴을 단일 summary 블록으로 치환하고 최신 keepLatest 턴을 유지한다.
 * 핵심 컨텍스트(마지막 user 메시지) 는 반드시 kept 에 포함된다.
 */
export function compactHistory(
  turns: readonly ConversationTurn[],
  keepLatest: number,
): CompactedHistory {
  if (turns.length <= keepLatest) {
    return { summary: '', kept: turns };
  }
  const cutoff = turns.length - keepLatest;
  const older = turns.slice(0, cutoff);
  const kept = turns.slice(cutoff);
  // 요약은 결정론적이어야 회귀가 가능 — 본 테스트에서는 "older 길이 + 토큰 합" 한 줄로 고정.
  const olderTokens = older.reduce((a, t) => a + t.tokens, 0);
  const summary = `이전 ${older.length}턴 요약(${olderTokens}토큰): ${older
    .map((t) => `${t.role}:${t.content.slice(0, 16)}`)
    .join(' | ')}`;
  return { summary, kept };
}

interface UsageLogLine {
  readonly ts: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly callId?: string;
}

export function formatUsageLogLine(usage: ClaudeTokenUsage, callId?: string): string {
  const line: UsageLogLine = {
    ts: usage.at ?? new Date().toISOString(),
    model: usage.model ?? 'unknown',
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheCreation: usage.cache_creation_input_tokens,
    ...(callId ? { callId } : {}),
  };
  return JSON.stringify(line);
}

export function parseUsageLogLine(line: string): UsageLogLine | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj.ts !== 'string' || typeof obj.model !== 'string') return null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const input = num(obj.input);
    const output = num(obj.output);
    const cacheRead = num(obj.cacheRead);
    const cacheCreation = num(obj.cacheCreation);
    if (input === null || output === null || cacheRead === null || cacheCreation === null) return null;
    return {
      ts: obj.ts,
      model: obj.model,
      input,
      output,
      cacheRead,
      cacheCreation,
      ...(typeof obj.callId === 'string' ? { callId: obj.callId } : {}),
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// S1. recordUsage — 축별 정확 누적
// ────────────────────────────────────────────────────────────────────────────

function usage(partial: Partial<ClaudeTokenUsage>): ClaudeTokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model: 'claude-opus-4-7',
    at: '2026-04-21T10:00:00.000Z',
    ...partial,
  };
}

test('S1-1. 4축 각각 단일 호출에서 정확히 누적된다', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  totals = mergeUsage(
    totals,
    usage({ input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 400 }),
  );
  assert.equal(totals.inputTokens, 100);
  assert.equal(totals.outputTokens, 200);
  assert.equal(totals.cacheReadTokens, 300);
  assert.equal(totals.cacheCreationTokens, 400);
  assert.equal(totals.callCount, 1);
});

test('S1-2. 3회 연속 호출 — 축별 합이 정확(교차 오염 없음)', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  totals = mergeUsage(totals, usage({ input_tokens: 10 }));
  totals = mergeUsage(totals, usage({ output_tokens: 20 }));
  totals = mergeUsage(totals, usage({ cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }));
  assert.equal(totals.inputTokens, 10);
  assert.equal(totals.outputTokens, 20);
  assert.equal(totals.cacheReadTokens, 30);
  assert.equal(totals.cacheCreationTokens, 40);
  assert.equal(totals.callCount, 3);
});

test('S1-3. 모델별 브레이크다운 — 같은 모델이 합산되고 다른 모델은 별도 키', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  totals = mergeUsage(totals, usage({ input_tokens: 100, model: 'claude-opus-4-7' }));
  totals = mergeUsage(totals, usage({ input_tokens: 50, model: 'claude-opus-4-7' }));
  totals = mergeUsage(totals, usage({ input_tokens: 30, model: 'claude-sonnet-4-6' }));
  assert.equal(totals.byModel['claude-opus-4-7'].inputTokens, 150);
  assert.equal(totals.byModel['claude-sonnet-4-6'].inputTokens, 30);
  assert.equal(totals.byModel['claude-opus-4-7'].callCount, 2);
});

// ────────────────────────────────────────────────────────────────────────────
// S2. shouldCompact · compactHistory
// ────────────────────────────────────────────────────────────────────────────

function turn(role: 'user' | 'assistant', content: string, tokens: number): ConversationTurn {
  return { role, content, tokens };
}

test('S2-1. shouldCompact — 토큰 총합이 임계치 이상이면 true', () => {
  const turns = [turn('user', 'a', 500), turn('assistant', 'b', 600)];
  assert.equal(shouldCompact(turns, 1000), true);
  assert.equal(shouldCompact(turns, 1500), false);
});

test('S2-2. compactHistory — 최신 keepLatest 턴 유지, 이전은 summary 로 치환', () => {
  const turns = [
    turn('user', 'q1 무엇', 100),
    turn('assistant', 'a1 답변', 100),
    turn('user', 'q2', 100),
    turn('assistant', 'a2', 100),
    turn('user', 'q3 최신 질문', 100),
  ];
  const out = compactHistory(turns, 3);
  assert.equal(out.kept.length, 3);
  assert.equal(out.kept[out.kept.length - 1].content, 'q3 최신 질문', '최신 턴은 무조건 유지');
  assert.ok(out.summary.includes('이전 2턴'));
  assert.ok(out.summary.includes('q1') || out.summary.includes('a1'));
});

test('S2-3. compactHistory — turns.length <= keepLatest 면 summary 비어 있고 전부 유지', () => {
  const turns = [turn('user', 'q1', 10), turn('assistant', 'a1', 10)];
  const out = compactHistory(turns, 3);
  assert.equal(out.summary, '');
  assert.deepEqual(out.kept, turns);
});

test('S2-4. 압축 후에도 핵심 컨텍스트(마지막 user 메시지) 는 반드시 kept 에 포함', () => {
  const turns = Array.from({ length: 10 }, (_, i) =>
    turn(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`, 50),
  );
  const out = compactHistory(turns, 3);
  assert.equal(out.kept.length, 3);
  const last = out.kept[out.kept.length - 1];
  assert.equal(last.content, 'msg-9');
});

// ────────────────────────────────────────────────────────────────────────────
// S3. SDK 페이로드 — 시스템·에이전트·툴 3구간 + cache_control 부착
// ────────────────────────────────────────────────────────────────────────────

test('S3-1. buildCacheableMessages 에 system 3블록(시스템 프롬프트·에이전트 정의·툴 스키마) 을 넘기면 각각 text 블록으로 유지된다', () => {
  const systemPrompt = '당신은 소규모 스튜디오의 편성 담당입니다.';
  const agentDefinition = '[Agents] Leader · Developer · QA · Designer · Researcher';
  const toolsSchema = JSON.stringify({ tools: [{ name: 'hire' }, { name: 'attach' }] });

  const msg = buildCacheableMessages(
    [systemPrompt, agentDefinition],
    '프로젝트 설명: 블로그 CMS',
    toolsSchema,
  );
  // 시스템 2블록 + 툴 1블록 = 3블록.
  assert.equal(msg.system.length, 3);
  assert.equal(msg.system[0].text, systemPrompt);
  assert.equal(msg.system[1].text, agentDefinition);
  assert.equal(msg.system[2].text, toolsSchema);
});

test('S3-2. 마지막 system 블록(툴 스키마) 에 cache_control: ephemeral 이 부착된다', () => {
  const msg = buildCacheableMessages(
    ['시스템', '에이전트'],
    'user',
    '{"tools":[]}',
  );
  const last = msg.system[msg.system.length - 1];
  assert.deepEqual(last.cache_control, { type: 'ephemeral' });
});

test('S3-3. 중간 블록에는 cache_control 이 붙지 않아 단일 프리픽스 캐시 계약이 지켜진다', () => {
  const msg = buildCacheableMessages(
    ['시스템', '에이전트'],
    'user',
    '{"tools":[]}',
  );
  assert.equal(msg.system[0].cache_control, undefined);
  assert.equal(msg.system[1].cache_control, undefined);
});

test('S3-4. user 턴은 휘발성 — cache_control 없음', () => {
  const msg = buildCacheableMessages(['sys'], '질문', '{"tools":[]}');
  assert.equal(msg.messages[0].role, 'user');
  assert.equal(msg.messages[0].content[0].cache_control, undefined);
});

test('S3-5. 빈 시스템 + 툴만 넘겨도 툴 블록에 캐시 마커가 단독으로 붙는다', () => {
  const msg = buildCacheableMessages([], '질문', '{"tools":[]}');
  assert.equal(msg.system.length, 1);
  assert.deepEqual(msg.system[0].cache_control, { type: 'ephemeral' });
});

// ────────────────────────────────────────────────────────────────────────────
// S4. 반복 호출 — cache_read 단조 증가
// ────────────────────────────────────────────────────────────────────────────

function mockStreamJsonResult(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  model = 'claude-opus-4-7',
): unknown {
  return {
    type: 'result',
    model,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
    },
  };
}

test('S4-1. 첫 호출은 cache_creation 비중이 크고, 반복 호출에서 cache_read 가 지배한다', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  const first = extractUsageFromStreamJsonResult(mockStreamJsonResult(800, 400, 0, 4000));
  assert.ok(first);
  totals = mergeUsage(totals, first!);
  for (let i = 0; i < 10; i++) {
    const evt = extractUsageFromStreamJsonResult(mockStreamJsonResult(200, 400, 4000, 0));
    assert.ok(evt);
    totals = mergeUsage(totals, evt!);
  }
  assert.ok(totals.cacheReadTokens >= 40_000, 'cache_read 누적');
  assert.ok(cacheHitRate(totals) >= 0.8, `적중률 0.8 이상 기대, got ${cacheHitRate(totals).toFixed(3)}`);
});

test('S4-2. cache_read 는 호출마다 단조 증가한다', () => {
  let totals: ClaudeTokenUsageTotals = { ...EMPTY_TOTALS, byModel: {}, errors: EMPTY_TOTALS.errors };
  let prev = 0;
  for (let i = 0; i < 5; i++) {
    const evt = extractUsageFromStreamJsonResult(mockStreamJsonResult(100, 200, 3000, 0));
    totals = mergeUsage(totals, evt!);
    assert.ok(totals.cacheReadTokens >= prev);
    prev = totals.cacheReadTokens;
  }
});

test('S4-3. extractUsageFromStreamJsonResult — 네 필드 전부 0 은 null(의미 없는 이벤트)', () => {
  const evt = extractUsageFromStreamJsonResult(mockStreamJsonResult(0, 0, 0, 0));
  assert.equal(evt, null);
});

test('S4-4. extractUsageFromStreamJsonResult — message.usage 경로도 동일하게 처리', () => {
  const msg = {
    type: 'message_start',
    message: { model: 'claude-opus-4-7', usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } },
  };
  const evt = extractUsageFromStreamJsonResult(msg);
  assert.ok(evt);
  assert.equal(evt!.cache_read_input_tokens, 500);
  assert.equal(evt!.model, 'claude-opus-4-7');
});

// ────────────────────────────────────────────────────────────────────────────
// S5. usageLog JSON lines 스키마 · 왕복
// ────────────────────────────────────────────────────────────────────────────

test('S5-1. formatUsageLogLine — 필수 필드 6종 포함', () => {
  const line = formatUsageLogLine(
    usage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }),
  );
  const obj = JSON.parse(line);
  assert.equal(typeof obj.ts, 'string');
  assert.equal(typeof obj.model, 'string');
  assert.equal(obj.input, 1);
  assert.equal(obj.output, 2);
  assert.equal(obj.cacheRead, 3);
  assert.equal(obj.cacheCreation, 4);
});

test('S5-2. 왕복 — format → parse 가 원본과 동일', () => {
  const u = usage({
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
    at: '2026-04-21T12:00:00.000Z', model: 'claude-sonnet-4-6',
  });
  const line = formatUsageLogLine(u, 'call-42');
  const parsed = parseUsageLogLine(line);
  assert.ok(parsed);
  assert.equal(parsed!.ts, u.at);
  assert.equal(parsed!.model, 'claude-sonnet-4-6');
  assert.equal(parsed!.input, 10);
  assert.equal(parsed!.output, 20);
  assert.equal(parsed!.cacheRead, 30);
  assert.equal(parsed!.cacheCreation, 40);
  assert.equal(parsed!.callId, 'call-42');
});

test('S5-3. parseUsageLogLine — 음수/비숫자/결측 필드는 null 로 거절', () => {
  assert.equal(parseUsageLogLine('{"ts":"x","model":"m","input":-1,"output":0,"cacheRead":0,"cacheCreation":0}'), null);
  assert.equal(parseUsageLogLine('{"ts":"x","model":"m","input":"a","output":0,"cacheRead":0,"cacheCreation":0}'), null);
  assert.equal(parseUsageLogLine('{"ts":"x","model":"m","input":1,"output":2,"cacheRead":3}'), null, 'cacheCreation 결측');
  assert.equal(parseUsageLogLine('not-json'), null);
});

test('S5-4. 한 줄당 하나의 JSON — 개행을 포함하지 않는다', () => {
  const line = formatUsageLogLine(usage({ input_tokens: 1, output_tokens: 1 }));
  assert.equal(line.includes('\n'), false);
});

test('S5-5. callId 미지정 시 출력 키에 포함되지 않는다(파서 기대 스키마 최소화)', () => {
  const line = formatUsageLogLine(usage({ input_tokens: 1 }));
  const obj = JSON.parse(line);
  assert.equal(Object.prototype.hasOwnProperty.call(obj, 'callId'), false);
});
