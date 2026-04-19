// Run with: npx tsx --test tests/claudeTokenUsageParse.regression.test.ts
//
// QA: Claude CLI stdout → usage 파싱 best-effort 계약 회귀 테스트.
// callClaude (server.ts) 가 plain text / JSON / stream-json 어떤 출력 형식을 돌려주든
// 파서가 과감히 null 을 돌려주거나 정상 usage 를 돌려줘야 한다. 예외로 호출 흐름을
// 막으면 에이전트 응답 자체가 실패하므로 절대 throw 하지 않는 것이 핵심 계약이다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseClaudeUsageFromStdout } from '../src/utils/claudeTokenUsageParse.ts';

test('plain text stdout → null (파서는 조용히 실패)', () => {
  const out = '안녕하세요. 질문에 답변드립니다.';
  assert.equal(parseClaudeUsageFromStdout(out), null);
});

test('빈 stdout / 비문자열 → null', () => {
  assert.equal(parseClaudeUsageFromStdout(''), null);
  // 방어 동작 검증: 타입 시스템 상으로는 string 이어야 하지만 런타임에 null/undefined
  // 가 들어와도 throw 하지 않고 null 을 돌려줘야 한다.
  assert.equal(parseClaudeUsageFromStdout(null as unknown as string), null);
  assert.equal(parseClaudeUsageFromStdout(undefined as unknown as string), null);
});

test('전체 JSON 형식(--output-format json) → usage 필드 추출', () => {
  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    role: 'assistant',
    content: [{ type: 'text', text: '답변' }],
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    },
  });
  const u = parseClaudeUsageFromStdout(payload);
  assert.ok(u);
  assert.equal(u!.input_tokens, 120);
  assert.equal(u!.output_tokens, 45);
  assert.equal(u!.cache_read_input_tokens, 30);
  assert.equal(u!.cache_creation_input_tokens, 10);
  assert.equal(u!.model, 'claude-sonnet-4-6');
});

test('stream-json 다중 줄 중 result 이벤트에서 usage 채택', () => {
  const lines = [
    JSON.stringify({ type: 'message_start', message: { id: 'm1' } }),
    JSON.stringify({ type: 'content_block_delta', delta: { text: '답변' } }),
    JSON.stringify({
      type: 'message_delta',
      usage: { input_tokens: 55, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
  ].join('\n');
  const u = parseClaudeUsageFromStdout(lines);
  assert.ok(u);
  assert.equal(u!.input_tokens, 55);
  assert.equal(u!.output_tokens, 12);
});

test('마지막 줄이 usage 를 가진 경우 마지막 줄 채택(가장 최신 메트릭)', () => {
  const lines = [
    JSON.stringify({ type: 'start' }),
    JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    JSON.stringify({ usage: { input_tokens: 30, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
  ].join('\n');
  const u = parseClaudeUsageFromStdout(lines);
  assert.ok(u);
  assert.equal(u!.input_tokens, 30, '마지막 줄의 usage 가 최종 누적을 대표한다');
  assert.equal(u!.output_tokens, 8);
});

test('네 필드 모두 0 인 usage 는 "의미 없는 호출" 로 null 반환', () => {
  const payload = JSON.stringify({
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  assert.equal(parseClaudeUsageFromStdout(payload), null);
});

test('깨진 JSON 은 throw 하지 않고 null 반환', () => {
  assert.equal(parseClaudeUsageFromStdout('{"usage":{bad json'), null);
});

test('usage 키가 중첩된 message 안에 있는 경우도 잡는다', () => {
  const payload = JSON.stringify({
    message: {
      model: 'claude-opus-4-7',
      usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  const u = parseClaudeUsageFromStdout(payload);
  assert.ok(u);
  assert.equal(u!.input_tokens, 500);
  assert.equal(u!.output_tokens, 200);
});
