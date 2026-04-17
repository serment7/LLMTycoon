// Run with: tsx --test src/auth/authRoutes.test.ts
//
// Express 라우터 자체는 http 통합 테스트가 필요하므로 여기서는 다루지 않는다.
// 이 파일은 라우터가 노출하는 순수 헬퍼(쿠키 파서·OAuth state TTL)만 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSidFromCookie,
  issueOAuthState,
  consumeOAuthState,
} from './authRoutes.ts';

test('parseSidFromCookie — returns null for missing header', () => {
  assert.equal(parseSidFromCookie(undefined), null);
  assert.equal(parseSidFromCookie(''), null);
});

test('parseSidFromCookie — extracts the named cookie value', () => {
  assert.equal(
    parseSidFromCookie('foo=1; llm_tycoon_sid=abc.def; bar=2'),
    'abc.def',
  );
});

test('parseSidFromCookie — trims whitespace and ignores unrelated cookies', () => {
  assert.equal(parseSidFromCookie('   llm_tycoon_sid=xyz   '), 'xyz');
  assert.equal(parseSidFromCookie('other=1; another=2'), null);
});

test('parseSidFromCookie — tolerates values containing dots (signed token)', () => {
  const token = 'YWJj.ZGVm.signature';
  assert.equal(parseSidFromCookie(`llm_tycoon_sid=${token}`), token);
});

test('issueOAuthState — returns a unique hex string each time', () => {
  const a = issueOAuthState();
  const b = issueOAuthState();
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.notEqual(a, b);
});

test('consumeOAuthState — accepts an issued state exactly once', () => {
  const s = issueOAuthState();
  assert.equal(consumeOAuthState(s), true);
  assert.equal(consumeOAuthState(s), false);
});

test('consumeOAuthState — rejects unknown state', () => {
  assert.equal(consumeOAuthState('not-a-real-state'), false);
});

test('parseSidFromCookie — skips malformed parts without "="', () => {
  assert.equal(parseSidFromCookie('malformed; llm_tycoon_sid=ok'), 'ok');
});

test('parseSidFromCookie — returns empty string when cookie value is blank', () => {
  assert.equal(parseSidFromCookie('llm_tycoon_sid='), '');
});

test('parseSidFromCookie — picks first match when duplicated', () => {
  assert.equal(
    parseSidFromCookie('llm_tycoon_sid=first; llm_tycoon_sid=second'),
    'first',
  );
});

test('parseSidFromCookie — preserves "=" inside the token value', () => {
  const token = 'base64value==';
  assert.equal(parseSidFromCookie(`llm_tycoon_sid=${token}`), token);
});

test('issueOAuthState — generated states accumulate independently', () => {
  const states = Array.from({ length: 5 }, () => issueOAuthState());
  assert.equal(new Set(states).size, states.length);
  for (const s of states) assert.equal(consumeOAuthState(s), true);
});

test('consumeOAuthState — second consume after success always fails', () => {
  const s = issueOAuthState();
  consumeOAuthState(s);
  assert.equal(consumeOAuthState(s), false);
  assert.equal(consumeOAuthState(s), false);
});
