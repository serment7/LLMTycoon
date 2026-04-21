// Run with: npx tsx --test tests/server/llm/messagesWithCache.spec.ts
//
// 지시 #c89384cd — 에이전트 공용 호출 헬퍼 회귀. 본 스펙은 문서
// docs/token-budget-strategy.md §1 의 블록 배치 규칙과 1:1 로 대응한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { messagesWithCache } from '../../../src/server/llm/messagesWithCache.ts';

test('system 단일 문자열 — 마지막 시스템 블록에만 ephemeral 마커', () => {
  const { messages, cacheMarkedBlocks } = messagesWithCache({
    system: '정책',
    user: '이번 턴 지시',
  });
  assert.equal(messages.system.length, 1);
  assert.deepEqual(messages.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(messages.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(cacheMarkedBlocks, ['system[0]']);
});

test('system 배열 — 마지막 항목에만 마커, 앞 항목은 평문', () => {
  const { messages, cacheMarkedBlocks } = messagesWithCache({
    system: ['정책', '예시'],
    user: '지시',
  });
  assert.equal(messages.system.length, 2);
  assert.equal(messages.system[0].cache_control, undefined);
  assert.deepEqual(messages.system[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(cacheMarkedBlocks, ['system[1]']);
});

test('tools 가 있으면 tools 블록으로 마커가 이동한다', () => {
  const { messages, cacheMarkedBlocks } = messagesWithCache({
    system: ['정책', '예시'],
    user: '지시',
    tools: '{"tools":[]}',
  });
  assert.equal(messages.system.length, 3);
  assert.equal(messages.system[2].text, '{"tools":[]}');
  assert.deepEqual(messages.system[2].cache_control, { type: 'ephemeral' });
  assert.equal(messages.system[1].cache_control, undefined);
  assert.deepEqual(cacheMarkedBlocks, ['system[2]']);
});

test('빈/공백 system 항목은 조용히 제거된다', () => {
  const { messages } = messagesWithCache({
    system: ['', '   ', '정책'],
    user: '지시',
  });
  assert.equal(messages.system.length, 1);
  assert.equal(messages.system[0].text, '정책');
});

test('system 이 완전히 비어 있으면 마커도 없다(cacheMarkedBlocks 빈 배열)', () => {
  const { messages, cacheMarkedBlocks } = messagesWithCache({
    system: '',
    user: '지시',
  });
  assert.equal(messages.system.length, 0);
  assert.deepEqual(cacheMarkedBlocks, []);
});

test('user 블록은 언제나 휘발성 — cache_control 없음', () => {
  const { messages } = messagesWithCache({
    system: ['정책'],
    user: '이번 턴 지시',
    tools: '{"tools":[]}',
  });
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0].role, 'user');
  assert.equal(messages.messages[0].content[0].text, '이번 턴 지시');
  assert.equal(messages.messages[0].content[0].cache_control, undefined);
});
