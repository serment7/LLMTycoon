// tokenLimits.ts 단위 테스트.
// 모델 매칭/안전 한도/이어쓰기 메시지 형태/워치독 한도를 검증한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelLimits,
  safeMaxOutputTokens,
  watchdogCeiling,
  remainingBudget,
  estimateTokens,
  continueGeneration,
  continueRounds,
  WATCHDOG_RATIO,
} from './tokenLimits';

test('modelLimits: 등록된 모델은 정확히 매칭', () => {
  assert.equal(modelLimits('qwen3.5:9b').contextWindow, 32_768);
  assert.equal(modelLimits('llama3.1:8b').contextWindow, 128_000);
});

test('modelLimits: 베이스명만 같아도 매칭', () => {
  // qwen3.5:latest → qwen3.5:9b 와 같은 한도 적용
  assert.equal(modelLimits('qwen3.5:latest').contextWindow, 32_768);
});

test('modelLimits: 알 수 없는 모델은 보수적 fallback', () => {
  const lim = modelLimits('unknown-model:13b');
  assert.equal(lim.contextWindow, 8_192);
  assert.equal(lim.defaultMaxOutput, 1_024);
});

test('safeMaxOutputTokens: env 가 모델 기본값을 덮어쓴다', () => {
  const orig = process.env.LLM_MAX_OUTPUT_TOKENS;
  try {
    process.env.LLM_MAX_OUTPUT_TOKENS = '512';
    assert.equal(safeMaxOutputTokens('qwen3.5:9b'), 512);
  } finally {
    if (orig === undefined) delete process.env.LLM_MAX_OUTPUT_TOKENS;
    else process.env.LLM_MAX_OUTPUT_TOKENS = orig;
  }
});

test('safeMaxOutputTokens: env 미설정 시 모델 기본값', () => {
  const orig = process.env.LLM_MAX_OUTPUT_TOKENS;
  delete process.env.LLM_MAX_OUTPUT_TOKENS;
  try {
    assert.equal(safeMaxOutputTokens('qwen3.5:9b'), 4_096);
  } finally {
    if (orig !== undefined) process.env.LLM_MAX_OUTPUT_TOKENS = orig;
  }
});

test('watchdogCeiling: 컨텍스트 창의 90%', () => {
  assert.equal(watchdogCeiling('qwen3.5:9b'), Math.floor(32_768 * WATCHDOG_RATIO));
});

test('remainingBudget: 누적이 한계를 넘으면 0 으로 클램프', () => {
  const ceiling = watchdogCeiling('qwen3.5:9b');
  assert.equal(remainingBudget('qwen3.5:9b', ceiling + 100), 0);
  assert.equal(remainingBudget('qwen3.5:9b', 0), ceiling);
});

test('estimateTokens: 빈 문자열은 0', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens: 4 글자/토큰 룰', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2); // ceil(5/4)
});

test('continueGeneration: 원본 배열을 변형하지 않고 assistant+user 두 개를 추가', () => {
  const msgs = [{ role: 'user' as const, content: '안녕' }];
  const next = continueGeneration(msgs, '잘린 응답');
  assert.equal(msgs.length, 1, '원본 길이는 유지되어야 한다');
  assert.equal(next.length, 3);
  assert.equal(next[1].role, 'assistant');
  assert.equal(next[1].content, '잘린 응답');
  assert.equal(next[2].role, 'user');
  assert.match(next[2].content, /이어/);
});

test('continueRounds: env 미설정 시 3', () => {
  const orig = process.env.LLM_CONTINUE_ROUNDS;
  delete process.env.LLM_CONTINUE_ROUNDS;
  try {
    assert.equal(continueRounds(), 3);
  } finally {
    if (orig !== undefined) process.env.LLM_CONTINUE_ROUNDS = orig;
  }
});

test('continueRounds: env 가 음수가 아닌 숫자면 그 값을 사용', () => {
  const orig = process.env.LLM_CONTINUE_ROUNDS;
  try {
    process.env.LLM_CONTINUE_ROUNDS = '0';
    assert.equal(continueRounds(), 0);
    process.env.LLM_CONTINUE_ROUNDS = '7';
    assert.equal(continueRounds(), 7);
  } finally {
    if (orig === undefined) delete process.env.LLM_CONTINUE_ROUNDS;
    else process.env.LLM_CONTINUE_ROUNDS = orig;
  }
});
