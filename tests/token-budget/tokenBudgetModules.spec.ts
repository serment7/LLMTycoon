// Run with: npx tsx --test tests/token-budget/tokenBudgetModules.spec.ts
//
// 지시 #a0fe127e — 신규 `src/llm/tokenBudget.ts` · `src/llm/usageLog.ts` ·
// `src/llm/client.ts` 의 공개 계약 회귀 잠금. QA 의 `tokenBudgetPipeline.spec.ts` 가
// 잡아 둔 인라인 헬퍼 대신 이제 실제 모듈의 export 를 직접 import 해 "빌트인"
// 경로로 돌아가는지 확인한다.
//
// 축
//   B1. tokenBudget — shouldCompact / compactHistory 정확성(경계 · summary 포맷).
//   B2. tokenBudget — 세션 상태 기계: recordUsage·appendTurn·maybeCompact 불변 업데이트.
//   B3. usageLog — formatUsageLogLine · parseUsageLogLine 왕복 + 음수 클램프.
//   B4. usageLog — in-memory sink 가 라인을 그대로 보관 / 파일 sink 가 주입된 appendFile 을 호출.
//   B5. client — 4구간(sys/agent/tools + history) 에서 마지막 시스템 블록과
//        "마지막 사용자 메시지 직전 assistant 블록" 에 ephemeral 마커가 붙는다.
//   B6. client — 반복 호출 시나리오: history 가 커져도 캐시 마커 위치가 여전히
//        "마지막 user 직전" 에만 있어 브레이크포인트 수가 정적 프리픽스 1 + 히스토리 1 = 2 로 유지.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldCompact,
  compactHistory,
  createBudgetSession,
  recordUsage,
  appendTurn,
  maybeCompact,
  DEFAULT_BUDGET_POLICY,
  type ConversationTurn,
} from '../../src/llm/tokenBudget.ts';
import {
  formatUsageLogLine,
  parseUsageLogLine,
  createInMemoryUsageLog,
  createFileUsageLog,
} from '../../src/llm/usageLog.ts';
import {
  buildCacheableConversation,
  collectCacheBreakpoints,
} from '../../src/llm/client.ts';
import type { ClaudeTokenUsage } from '../../src/types.ts';

function turn(role: 'user' | 'assistant', content: string, tokens: number): ConversationTurn {
  return { role, content, tokens };
}

// ────────────────────────────────────────────────────────────────────────────
// B1. shouldCompact / compactHistory 경계 · 포맷
// ────────────────────────────────────────────────────────────────────────────

test('B1-1. shouldCompact — 경계(>=)', () => {
  const turns = [turn('user', 'a', 500), turn('assistant', 'b', 500)];
  assert.equal(shouldCompact(turns, 1_000), true);
  assert.equal(shouldCompact(turns, 1_001), false);
  assert.equal(shouldCompact([], 1_000), false);
});

test('B1-2. compactHistory — 결정론 요약 포맷과 keepLatest 보정', () => {
  const turns = [
    turn('user', 'q1-내용이 긴 질문이어야 한다', 100),
    turn('assistant', 'a1-응답', 100),
    turn('user', 'q2', 100),
    turn('assistant', 'a2', 100),
    turn('user', 'q3 최신', 100),
  ];
  const out = compactHistory(turns, 3);
  assert.equal(out.kept.length, 3);
  assert.equal(out.kept[out.kept.length - 1].content, 'q3 최신');
  assert.ok(out.summary.startsWith('이전 2턴 요약(200토큰):'));
  assert.ok(out.summary.includes('user:q1-내용이 긴 질문이어야 '));  // slice(0, 16)
});

test('B1-3. compactHistory — keepLatest<=0 이면 1 로 보정', () => {
  const turns = [turn('user', 'a', 10), turn('assistant', 'b', 10)];
  const out = compactHistory(turns, 0);
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].content, 'b');
});

// ────────────────────────────────────────────────────────────────────────────
// B2. 세션 상태 기계 — recordUsage · appendTurn · maybeCompact 불변성
// ────────────────────────────────────────────────────────────────────────────

test('B2-1. recordUsage — mergeUsage 와 동일한 총계로 수렴하고 원본 세션은 불변', () => {
  const s0 = createBudgetSession('S1');
  const u: ClaudeTokenUsage = {
    input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 400,
    model: 'claude-opus-4-7', at: '2026-04-21T10:00:00.000Z',
  };
  const s1 = recordUsage(s0, u);
  assert.equal(s0.totals.callCount, 0, '원본 불변');
  assert.equal(s1.totals.callCount, 1);
  assert.equal(s1.totals.inputTokens, 100);
  assert.equal(s1.totals.outputTokens, 200);
  assert.equal(s1.totals.cacheReadTokens, 300);
  assert.equal(s1.totals.cacheCreationTokens, 400);
  assert.equal(s1.lastUsageAt, '2026-04-21T10:00:00.000Z');
});

test('B2-2. appendTurn + maybeCompact — 임계치 도달 전에는 히스토리 유지, 도달 시 요약 생성', () => {
  let s = createBudgetSession('S2');
  for (let i = 0; i < 5; i++) {
    s = appendTurn(s, turn(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`, 1_000));
  }
  const before = maybeCompact(s, { compactThresholdTokens: 10_000, keepLatestTurns: 3 });
  assert.equal(before.history.length, 5, '임계 미만이면 그대로');
  assert.equal(before.compactedSummary, '');

  const after = maybeCompact(s, { compactThresholdTokens: 4_500, keepLatestTurns: 3 });
  assert.equal(after.history.length, 3, '임계 초과 시 최신 3턴만 유지');
  assert.ok(after.compactedSummary.startsWith('이전 2턴 요약'));
});

test('B2-3. maybeCompact 누적 — 두 번 호출되면 요약이 이어 붙는다', () => {
  let s = createBudgetSession('S3');
  for (let i = 0; i < 8; i++) {
    s = appendTurn(s, turn(i % 2 === 0 ? 'user' : 'assistant', `t-${i}`, 1_000));
  }
  s = maybeCompact(s, { compactThresholdTokens: 5_000, keepLatestTurns: 3 });
  const firstSummary = s.compactedSummary;
  for (let i = 0; i < 8; i++) {
    s = appendTurn(s, turn(i % 2 === 0 ? 'user' : 'assistant', `x-${i}`, 1_000));
  }
  s = maybeCompact(s, { compactThresholdTokens: 5_000, keepLatestTurns: 3 });
  assert.ok(s.compactedSummary.length > firstSummary.length, '두 번째 압축이 요약을 확장');
  assert.ok(s.compactedSummary.includes(firstSummary), '이전 요약 보존');
});

// ────────────────────────────────────────────────────────────────────────────
// B3. usageLog — 왕복 · 음수 클램프
// ────────────────────────────────────────────────────────────────────────────

test('B3-1. formatUsageLogLine · parseUsageLogLine 왕복', () => {
  const u: ClaudeTokenUsage = {
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
    model: 'claude-sonnet-4-6', at: '2026-04-21T09:00:00.000Z',
  };
  const line = formatUsageLogLine(u, 'call-99');
  const parsed = parseUsageLogLine(line);
  assert.ok(parsed);
  assert.equal(parsed!.model, 'claude-sonnet-4-6');
  assert.equal(parsed!.callId, 'call-99');
  assert.equal(parsed!.input, 10);
});

test('B3-2. format — 음수 input 은 0 으로 클램프, callId 미지정 시 키 생략', () => {
  const line = formatUsageLogLine({
    input_tokens: -5, output_tokens: 2,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    model: 'm',
  });
  const parsed = parseUsageLogLine(line);
  assert.ok(parsed);
  assert.equal(parsed!.input, 0);
  assert.equal('callId' in parsed!, false);
});

test('B3-3. parse — 음수 cacheRead / 결측 필드는 null', () => {
  assert.equal(parseUsageLogLine('{"ts":"x","model":"m","input":0,"output":0,"cacheRead":-1,"cacheCreation":0}'), null);
  assert.equal(parseUsageLogLine('{"ts":"x","model":"m","input":1}'), null);
});

// ────────────────────────────────────────────────────────────────────────────
// B4. sink — in-memory · file(주입 appendFile 확인)
// ────────────────────────────────────────────────────────────────────────────

test('B4-1. in-memory sink 는 append 한 라인을 보관하고 snapshot 에서 반환', async () => {
  const sink = createInMemoryUsageLog();
  await sink.append({
    input_tokens: 1, output_tokens: 2,
    cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
    model: 'm', at: '2026-04-21T10:00:00.000Z',
  }, 'c1');
  const snap = sink.snapshot();
  assert.equal(snap.length, 1);
  const parsed = parseUsageLogLine(snap[0]);
  assert.equal(parsed?.callId, 'c1');
});

test('B4-2. file sink — 주입된 appendFile 이 "path" 와 "line\\n" 을 받는다', async () => {
  const calls: Array<{ path: string; data: string }> = [];
  const sink = createFileUsageLog('/tmp/usage.jsonl', {
    appendFile: async (path, data) => { calls.push({ path, data }); },
  });
  await sink.append({
    input_tokens: 1, output_tokens: 1,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    model: 'm',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/tmp/usage.jsonl');
  assert.ok(calls[0].data.endsWith('\n'), '끝에 개행 추가');
  assert.equal(sink.size(), 1);
  assert.deepEqual(sink.snapshot(), [], '파일 싱크는 snapshot 을 보관하지 않음');
});

test('B4-3. file sink — enabled=false 면 appendFile 을 호출하지 않는다', async () => {
  let hit = false;
  const sink = createFileUsageLog('/tmp/x.jsonl', {
    enabled: false,
    appendFile: async () => { hit = true; },
  });
  await sink.append({
    input_tokens: 1, output_tokens: 1,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    model: 'm',
  });
  assert.equal(hit, false);
  assert.equal(sink.size(), 0);
});

// ────────────────────────────────────────────────────────────────────────────
// B5. client — 4구간 + 캐시 브레이크포인트
// ────────────────────────────────────────────────────────────────────────────

test('B5-1. 4구간 모두 채워지면 system=3블록, 마지막에만 cache_control', () => {
  const conv = buildCacheableConversation({
    systemPrompt: '시스템 프롬프트',
    agentDefinition: '에이전트 정의',
    toolsSchema: '{"tools":[]}',
    user: '질문',
  });
  assert.equal(conv.system.length, 3);
  assert.equal(conv.system[0].cache_control, undefined);
  assert.equal(conv.system[1].cache_control, undefined);
  assert.deepEqual(conv.system[2].cache_control, { type: 'ephemeral' });
});

test('B5-2. 히스토리가 있을 때 — "마지막 user 직전 assistant 블록" 에 브레이크포인트가 박힌다', () => {
  const history: ConversationTurn[] = [
    turn('user', 'q1', 10),
    turn('assistant', 'a1', 10),
    turn('user', 'q2', 10),
    turn('assistant', 'a2', 10),
    turn('user', 'q3', 10),
  ];
  const conv = buildCacheableConversation({
    systemPrompt: 'sys',
    toolsSchema: '{"tools":[]}',
    history,
    user: '새 질문',
  });
  const marks = collectCacheBreakpoints(conv);
  // system 의 마지막 블록 + 히스토리 내부의 assistant a2(인덱스 3) 가 마커 보유.
  assert.ok(marks.includes('system[1]'));
  assert.ok(marks.some((m) => m.startsWith('messages[3].content')), '마지막 user 직전 assistant 에 마커');
  assert.equal(marks.length, 2, '정적 프리픽스 1 + 히스토리 1 = 2');
});

test('B5-3. 히스토리 마지막이 user 가 아니면 히스토리 내부에는 마커가 없고 정적 프리픽스만 1개', () => {
  const history: ConversationTurn[] = [
    turn('user', 'q1', 10),
    turn('assistant', 'a1', 10),
  ];
  const conv = buildCacheableConversation({
    systemPrompt: 'sys',
    history,
    user: 'follow-up',
  });
  const marks = collectCacheBreakpoints(conv);
  assert.equal(marks.length, 1);
  assert.equal(marks[0], 'system[0]');
});

test('B5-4. 압축된 요약이 있으면 systemPrompt 바로 뒤에 "[과거 대화 요약]" 블록으로 삽입된다', () => {
  const conv = buildCacheableConversation({
    systemPrompt: 'sys',
    compactedSummary: '이전 5턴 요약(...)',
    toolsSchema: '{"tools":[]}',
    user: '다음 질문',
  });
  assert.equal(conv.system.length, 3);
  assert.ok(conv.system[1].text.startsWith('[과거 대화 요약]'));
});

// ────────────────────────────────────────────────────────────────────────────
// B6. 반복 호출 — 히스토리가 커져도 브레이크포인트 수는 유지
// ────────────────────────────────────────────────────────────────────────────

test('B6-1. 30턴 + 마지막 user 까지 — 캐시 마커는 여전히 정확히 2 개', () => {
  const history: ConversationTurn[] = [];
  for (let i = 0; i < 30; i++) {
    history.push(turn(i % 2 === 0 ? 'user' : 'assistant', `t-${i}`, 10));
  }
  // 마지막이 'assistant' 이므로, 추가로 user 하나 더.
  history.push(turn('user', 'final-user', 10));
  const conv = buildCacheableConversation({
    systemPrompt: 'sys',
    agentDefinition: 'agents',
    toolsSchema: 'tools',
    history,
    user: '새 user',
  });
  const marks = collectCacheBreakpoints(conv);
  assert.equal(marks.length, 2);
  assert.ok(marks.includes('system[2]'));
});
