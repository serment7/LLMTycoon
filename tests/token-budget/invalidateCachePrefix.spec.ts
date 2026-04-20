// Run with: npx tsx --test tests/token-budget/invalidateCachePrefix.spec.ts
//
// 지시 #c9c158aa — `invalidateCachePrefix` / `detectCacheInvalidation` /
// `fingerprintCachePrefix` / `describeCacheInvalidation` 의 공개 계약 회귀 잠금.
//
// 축
//   I1. 동일 프리픽스 — 반복 호출에도 decision.invalidated === false · reasons 비어 있음.
//   I2. 시스템 프롬프트 변경 — 'system-prompt-changed' 단독 원인.
//   I3. 에이전트 정의 변경 — 'agent-definition-changed' 단독 원인.
//   I4. 툴 스키마 변경 — 'tools-schema-changed' 단독 원인.
//   I5. 복합 변경 — 두 축 동시 변경 시 reasons 배열이 모두 포함.
//   I6. initial-build — previousFingerprint=null 일 때 reasons=['initial-build'].
//   I7. describeCacheInvalidation — 한글 원인 문자열로 치환.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  invalidateCachePrefix,
  detectCacheInvalidation,
  fingerprintCachePrefix,
  describeCacheInvalidation,
} from '../../src/llm/client.ts';

test('I1. 동일 프리픽스 — 반복 호출에도 무효화 없음', () => {
  const base = {
    systemPrompt: '정적 시스템',
    agentDefinition: '에이전트 목록 A',
    toolsSchema: '{"tools":[{"name":"a"}]}',
    user: 'u',
  };
  const r1 = invalidateCachePrefix({ ...base });
  assert.equal(r1.decision.invalidated, true, '첫 호출은 initial-build');
  assert.deepEqual(r1.decision.reasons, ['initial-build']);

  const r2 = invalidateCachePrefix({ ...base, previousFingerprint: r1.decision.nextFingerprint });
  assert.equal(r2.decision.invalidated, false);
  assert.deepEqual(r2.decision.reasons, []);
  // 핑거프린트는 동일해야 한다 — 동일 입력 → 동일 해시.
  assert.equal(r2.decision.nextFingerprint.prefixKey, r1.decision.nextFingerprint.prefixKey);
});

test('I2. 시스템 프롬프트 변경 — system-prompt-changed 단독 원인', () => {
  const fp = fingerprintCachePrefix({
    systemPrompt: '원본', agentDefinition: 'a', toolsSchema: 't',
  });
  const d = detectCacheInvalidation(fp, {
    systemPrompt: '수정', agentDefinition: 'a', toolsSchema: 't',
  });
  assert.deepEqual(d.reasons, ['system-prompt-changed']);
});

test('I3. 에이전트 정의 변경 — agent-definition-changed 단독 원인', () => {
  const fp = fingerprintCachePrefix({
    systemPrompt: 's', agentDefinition: '기존', toolsSchema: 't',
  });
  const d = detectCacheInvalidation(fp, {
    systemPrompt: 's', agentDefinition: '기존 + Researcher', toolsSchema: 't',
  });
  assert.deepEqual(d.reasons, ['agent-definition-changed']);
});

test('I4. 툴 스키마 변경 — tools-schema-changed 단독 원인', () => {
  const fp = fingerprintCachePrefix({
    systemPrompt: 's', agentDefinition: 'a', toolsSchema: '{"tools":[]}',
  });
  const d = detectCacheInvalidation(fp, {
    systemPrompt: 's', agentDefinition: 'a', toolsSchema: '{"tools":[{"name":"x"}]}',
  });
  assert.deepEqual(d.reasons, ['tools-schema-changed']);
});

test('I5. 복합 변경 — 두 축 동시 변경 시 reasons 에 모두 포함', () => {
  const fp = fingerprintCachePrefix({ systemPrompt: 's', agentDefinition: 'a', toolsSchema: 't' });
  const d = detectCacheInvalidation(fp, {
    systemPrompt: 's',
    agentDefinition: 'a+',
    toolsSchema: 't+',
  });
  assert.ok(d.reasons.includes('agent-definition-changed'));
  assert.ok(d.reasons.includes('tools-schema-changed'));
  assert.equal(d.reasons.includes('system-prompt-changed'), false);
});

test('I6. initial-build — previousFingerprint=null 이면 reasons=[initial-build]', () => {
  const d = detectCacheInvalidation(null, { systemPrompt: 's', agentDefinition: 'a', toolsSchema: 't' });
  assert.deepEqual(d.reasons, ['initial-build']);
  assert.equal(d.invalidated, true);
});

test('I7. describeCacheInvalidation — 한글 원인 문자열로 치환', () => {
  const d1 = detectCacheInvalidation(null, { systemPrompt: '', agentDefinition: '', toolsSchema: '' });
  const msg1 = describeCacheInvalidation(d1);
  assert.match(msg1, /최초 빌드/);

  const fp = fingerprintCachePrefix({ systemPrompt: 's', agentDefinition: 'a', toolsSchema: 't' });
  const d2 = detectCacheInvalidation(fp, { systemPrompt: 's', agentDefinition: 'a+', toolsSchema: 't+' });
  const msg2 = describeCacheInvalidation(d2);
  assert.match(msg2, /에이전트 정의 변경/);
  assert.match(msg2, /툴 스키마 변경/);

  const d3 = detectCacheInvalidation(fp, { systemPrompt: 's', agentDefinition: 'a', toolsSchema: 't' });
  assert.match(describeCacheInvalidation(d3), /유지/);
});

test('I8. invalidateCachePrefix — conversation 과 breakpoints 를 함께 돌려준다', () => {
  const out = invalidateCachePrefix({
    systemPrompt: '시스템',
    agentDefinition: '에이전트',
    toolsSchema: '{"tools":[]}',
    user: '질문',
  });
  assert.ok(out.conversation.system.length >= 1);
  assert.ok(out.breakpoints.includes('system[2]'), '마지막 system 블록에 마커');
});
