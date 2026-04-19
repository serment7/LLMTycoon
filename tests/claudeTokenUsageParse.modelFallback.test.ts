// Run with: npx tsx --test tests/claudeTokenUsageParse.modelFallback.test.ts
//
// 단위 회귀(지시 #2bc86dfa) · parseClaudeUsageFromStdout 의 model 추출 강화.
//
// 기존 tests/claudeTokenUsageParse.regression.test.ts 는 model 이 최상위 객체의
// `model` 필드에 있을 때만 검증했다. 실제 Anthropic 응답은 최상위 `model` 이
// 비어 있고 `message.model` 에만 있는 경우도 자주 나오며, 공백만으로 구성된
// model 이 byModel 키로 흘러가는 회귀 가능성이 있어 아래 세 계약을 추가로 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseClaudeUsageFromStdout } from '../src/utils/claudeTokenUsageParse.ts';

test('M1 · 전체 JSON 에서 최상위 model 이 없으면 message.model 로 폴백', () => {
  const payload = JSON.stringify({
    message: {
      model: 'claude-opus-4-7',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  const u = parseClaudeUsageFromStdout(payload);
  assert.ok(u);
  assert.equal(u!.model, 'claude-opus-4-7', 'message.model 이 normalized.model 에 실려야 한다');
});

test('M2 · stream-json 에서도 message.model 폴백이 동작', () => {
  const lines = [
    JSON.stringify({ type: 'message_start', message: { id: 'm1', model: 'claude-sonnet-4-6' } }),
    JSON.stringify({
      type: 'message_delta',
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 77, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
  ].join('\n');
  const u = parseClaudeUsageFromStdout(lines);
  assert.ok(u);
  assert.equal(u!.model, 'claude-sonnet-4-6');
  assert.equal(u!.input_tokens, 77);
});

test('M3 · 공백만 채운 model("   ") 은 undefined 로 정규화된다', () => {
  const payload = JSON.stringify({
    model: '   ',
    usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  const u = parseClaudeUsageFromStdout(payload);
  assert.ok(u);
  assert.equal(u!.model, undefined, '공백 model 은 저장되지 않아야 한다');
  // 기본 호출 정상성은 유지(핵심 수치는 그대로 집계).
  assert.equal(u!.input_tokens, 5);
  assert.equal(u!.output_tokens, 3);
});

test('M4 · model 이 최상위/메시지 양쪽에 비어 있으면 undefined', () => {
  const payload = JSON.stringify({
    message: { /* model 없음 */
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  const u = parseClaudeUsageFromStdout(payload);
  assert.ok(u);
  assert.equal(u!.model, undefined);
});

// ─── 전략 3 정규식 중첩 허용 (지시 #a7c1affe) ─────────────────────────────────

test('M5 · 전략 3 · usage 내부에 1단계 중첩 객체(by_tool 등) 가 있어도 추출된다', () => {
  // 전체 JSON 이 아닌 stdout 에 "usage":{...{...}...} 가 섞여 있는 최악의 경우에도
  // 과거 정규식(`[^{}]*`) 은 중첩 첫 글자에서 끊겼다. 보강된 패턴은 1단계 중첩까지
  // 허용한다.
  const stdout = '앞에 서술 {이 잘못된 브레이스 "usage": {"input_tokens": 50, "output_tokens": 20, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "by_tool": {"Read": 10, "Write": 5}} 뒤에 서술';
  const u = parseClaudeUsageFromStdout(stdout);
  assert.ok(u, '중첩된 usage 블록이어도 추출 성공');
  assert.equal(u!.input_tokens, 50);
  assert.equal(u!.output_tokens, 20);
});
