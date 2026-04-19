// Run with: npx tsx --test tests/claudeClientCacheable.regression.test.ts
//
// QA: 지시 #176df2b8 클로드 래퍼 캐싱·usage 허브 회귀.
//  (1) buildCacheableMessages — 마지막 시스템 블록에만 cache_control 마커가 붙고,
//      system/tools 가 비어 있으면 마커도 없어야 한다.
//  (2) flattenMessagesForCli — system/user 가 분리돼 반환돼야 CLI --append-system-prompt
//      인자에 그대로 꽂을 수 있다.
//  (3) extractUsageFromStreamJsonResult — CLI result 이벤트의 usage 네 필드를 정규화.
//  (4) onClaudeUsage / emitUsageFromStreamJson — 구독 → 발사 경로가 실제로 배선되는가.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCacheableMessages,
  flattenMessagesForCli,
  extractUsageFromStreamJsonResult,
  onClaudeUsage,
  emitUsageFromStreamJson,
  resetClaudeUsageListeners,
} from '../src/server/claudeClient.ts';
import type { ClaudeTokenUsage } from '../src/types.ts';

// ---------------------------------------------------------------------------
// 캐싱 마크업
// ---------------------------------------------------------------------------

test('buildCacheableMessages — 마지막 시스템 블록에만 ephemeral 마커가 붙는다', () => {
  const m = buildCacheableMessages('시스템 규칙', '이번 턴 지시', '도구 스키마');
  assert.equal(m.system.length, 2);
  assert.equal(m.system[0].cache_control, undefined, '앞 블록은 마커 없음');
  assert.deepEqual(m.system[1].cache_control, { type: 'ephemeral' }, '마지막 블록에만 마커');
  assert.equal(m.messages.length, 1);
  assert.equal(m.messages[0].role, 'user');
  assert.equal(m.messages[0].content[0].cache_control, undefined, '유저 턴은 휘발성 — 마커 없음');
});

test('buildCacheableMessages — tools 미지정 시 system 블록은 한 개만 생긴다', () => {
  const m = buildCacheableMessages('시스템 규칙', '지시');
  assert.equal(m.system.length, 1);
  assert.deepEqual(m.system[0].cache_control, { type: 'ephemeral' });
});

test('buildCacheableMessages — 시스템이 비어 있으면 시스템 블록도 마커도 없다', () => {
  const m = buildCacheableMessages('', '지시');
  assert.equal(m.system.length, 0);
});

test('flattenMessagesForCli — system/user 를 CLI 인자/stdin 분리용으로 돌려준다', () => {
  const m = buildCacheableMessages('시스템 규칙', '지시', '도구 스키마');
  const flat = flattenMessagesForCli(m);
  assert.ok(flat.systemPrompt.includes('시스템 규칙'));
  assert.ok(flat.systemPrompt.includes('도구 스키마'));
  assert.equal(flat.userPrompt, '지시');
});

// ---------------------------------------------------------------------------
// usage 추출
// ---------------------------------------------------------------------------

test('extractUsageFromStreamJsonResult — 정상 result 이벤트의 네 필드를 돌려준다', () => {
  const msg = {
    type: 'result',
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    },
  };
  const u = extractUsageFromStreamJsonResult(msg);
  assert.ok(u);
  assert.equal(u!.input_tokens, 120);
  assert.equal(u!.cache_read_input_tokens, 30);
  assert.equal(u!.cache_creation_input_tokens, 10);
  assert.equal(u!.model, 'claude-sonnet-4-6');
});

test('extractUsageFromStreamJsonResult — message.usage 중첩 경로도 지원', () => {
  const msg = {
    type: 'result',
    message: {
      model: 'claude-opus-4-7',
      usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
  const u = extractUsageFromStreamJsonResult(msg);
  assert.ok(u);
  assert.equal(u!.input_tokens, 1000);
  assert.equal(u!.model, 'claude-opus-4-7');
});

test('extractUsageFromStreamJsonResult — usage 누락/네 필드 전부 0/비객체는 null', () => {
  assert.equal(extractUsageFromStreamJsonResult({ type: 'result' }), null);
  assert.equal(extractUsageFromStreamJsonResult(null), null);
  assert.equal(extractUsageFromStreamJsonResult('not an object'), null);
  assert.equal(extractUsageFromStreamJsonResult({
    type: 'result', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), null);
});

test('extractUsageFromStreamJsonResult — 음수·NaN·비숫자를 0 으로 클램프한다', () => {
  const msg = {
    type: 'result',
    usage: { input_tokens: -5, output_tokens: Number.NaN, cache_read_input_tokens: 'oops', cache_creation_input_tokens: 12 },
  };
  const u = extractUsageFromStreamJsonResult(msg);
  assert.ok(u);
  assert.equal(u!.input_tokens, 0);
  assert.equal(u!.output_tokens, 0);
  assert.equal(u!.cache_read_input_tokens, 0);
  assert.equal(u!.cache_creation_input_tokens, 12);
});

// ---------------------------------------------------------------------------
// 전역 옵저버
// ---------------------------------------------------------------------------

test('onClaudeUsage → emitUsageFromStreamJson — 구독자가 usage 를 실시간으로 받는다', () => {
  resetClaudeUsageListeners();
  const received: ClaudeTokenUsage[] = [];
  const unsubscribe = onClaudeUsage(u => received.push(u));
  emitUsageFromStreamJson({
    type: 'result',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  emitUsageFromStreamJson({ type: 'result', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  unsubscribe();
  emitUsageFromStreamJson({
    type: 'result',
    usage: { input_tokens: 999, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  assert.equal(received.length, 1, '0/0/0/0 은 건너뛰고 해제 이후의 이벤트는 전달되지 않아야 한다');
  assert.equal(received[0].input_tokens, 10);
});

test('onClaudeUsage — 한 구독자 실패가 다른 구독자를 막지 않는다(격리)', () => {
  resetClaudeUsageListeners();
  const received: number[] = [];
  onClaudeUsage(() => { throw new Error('broken'); });
  onClaudeUsage(u => received.push(u.input_tokens));
  emitUsageFromStreamJson({
    type: 'result',
    usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  assert.deepEqual(received, [7]);
  resetClaudeUsageListeners();
});
