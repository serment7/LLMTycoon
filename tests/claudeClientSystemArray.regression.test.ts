// Run with: npx tsx --test tests/claudeClientSystemArray.regression.test.ts
//
// QA: 지시 #00fc6cda 회귀 — `buildCacheableMessages` 가 system 인자로 문자열 단일
// 외에 문자열 배열도 허용하며, 마지막 비어있지 않은 블록에만 ephemeral 캐시 마커가
// 붙는지 확인한다. 기존 단일 문자열 호출(`tests/claudeClientCacheable.regression.test.ts`)
// 계약은 한 줄도 바꾸지 않으며, 본 파일은 확장 분기만 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCacheableMessages } from '../src/server/claudeClient.ts';

test('string[] 입력 — 각 항목이 별도 시스템 블록으로 유지된다', () => {
  const m = buildCacheableMessages(['규칙 A', '역할 B', '체크리스트 C'], '지시');
  assert.equal(m.system.length, 3);
  assert.equal(m.system[0].text, '규칙 A');
  assert.equal(m.system[1].text, '역할 B');
  assert.equal(m.system[2].text, '체크리스트 C');
});

test('string[] 입력 — 마지막 블록에만 cache_control 마커가 붙는다', () => {
  const m = buildCacheableMessages(['규칙 A', '역할 B', '체크리스트 C'], '지시');
  assert.equal(m.system[0].cache_control, undefined);
  assert.equal(m.system[1].cache_control, undefined);
  assert.deepEqual(m.system[2].cache_control, { type: 'ephemeral' });
});

test('string[] 입력 — 빈 항목/공백만 항목은 조용히 건너뛴다', () => {
  const m = buildCacheableMessages(['', '규칙 A', '   ', '역할 B'], '지시');
  assert.equal(m.system.length, 2);
  assert.equal(m.system[0].text, '규칙 A');
  assert.equal(m.system[1].text, '역할 B');
  assert.deepEqual(m.system[1].cache_control, { type: 'ephemeral' });
});

test('string[] + tools — tools 가 마지막 시스템 블록이 되어 마커를 가져간다', () => {
  const m = buildCacheableMessages(['규칙 A', '역할 B'], '지시', '도구 스키마');
  assert.equal(m.system.length, 3);
  assert.equal(m.system[2].text, '도구 스키마');
  assert.deepEqual(m.system[2].cache_control, { type: 'ephemeral' });
  assert.equal(m.system[1].cache_control, undefined);
});

test('string[] 빈 배열 — 시스템 블록이 생성되지 않는다', () => {
  const m = buildCacheableMessages([], '지시');
  assert.equal(m.system.length, 0);
});

test('하위호환 — 단일 string 입력은 기존 동작과 동일', () => {
  const m = buildCacheableMessages('규칙 A', '지시');
  assert.equal(m.system.length, 1);
  assert.equal(m.system[0].text, '규칙 A');
  assert.deepEqual(m.system[0].cache_control, { type: 'ephemeral' });
});

test('user 블록은 배열 입력 여부와 무관하게 휘발성(캐시 마커 없음)', () => {
  const m = buildCacheableMessages(['규칙 A', '역할 B'], '이번 턴 지시');
  assert.equal(m.messages.length, 1);
  assert.equal(m.messages[0].role, 'user');
  assert.equal(m.messages[0].content[0].text, '이번 턴 지시');
  assert.equal(m.messages[0].content[0].cache_control, undefined);
});
