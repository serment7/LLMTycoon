// Run with: npx tsx --test tests/claudeErrorsMessageHeuristic.regression.test.ts
//
// QA: 지시 #864a097a — `classifyClaudeError` 의 CLI stderr 메시지 힌트 휴리스틱 회귀.
//
// 배경
//  `server.ts::callClaude` 의 exit≠0 경로는 status/type/code 가 전부 없고 메시지
//  문자열만 있는 상태로 `classifyClaudeError` 를 호출한다. 메시지에 "rate limit"
//  같은 의미 있는 단어가 섞이면 5xx 폴백 전에 카테고리를 승격시켜 적절한
//  재시도 정책(retry-after 존중·더 긴 백오프·재시도 불가) 이 선택되어야 한다.
//
// 본 테스트는 기존 분류 매트릭스(`tests/claudeErrorsClassify.regression.test.ts`) 의
// 우선순위 계약을 **깨지 않으면서** 신규 휴리스틱이 기대대로 동작하는지 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyClaudeError, retryPolicyFor } from '../src/server/claudeErrors.ts';

// ---------------------------------------------------------------------------
// 신규 휴리스틱 — 각 카테고리
// ---------------------------------------------------------------------------

test('메시지 "Rate limit exceeded" → rate_limit 으로 승격', () => {
  const c = classifyClaudeError({ message: 'Rate limit exceeded for organization' });
  assert.equal(c.category, 'rate_limit');
  assert.equal(retryPolicyFor(c.category).respectRetryAfter, true, 'rate_limit 은 retry-after 정책을 사용');
});

test('메시지 "quota exhausted" → rate_limit', () => {
  assert.equal(classifyClaudeError({ message: 'quota exhausted for this key' }).category, 'rate_limit');
});

test('메시지 "Too Many Requests" → rate_limit', () => {
  assert.equal(classifyClaudeError({ message: 'Too Many Requests' }).category, 'rate_limit');
});

test('메시지 "service unavailable" → overloaded', () => {
  assert.equal(classifyClaudeError({ message: 'service unavailable — please retry' }).category, 'overloaded');
});

test('메시지 "server busy" → overloaded', () => {
  assert.equal(classifyClaudeError({ message: 'upstream server busy' }).category, 'overloaded');
});

test('메시지 "Invalid API key" → auth', () => {
  const c = classifyClaudeError({ message: 'Invalid API key provided' });
  assert.equal(c.category, 'auth');
  assert.equal(retryPolicyFor(c.category).retriable, false, 'auth 는 재시도 불가');
});

test('메시지 "unauthorized" → auth', () => {
  assert.equal(classifyClaudeError({ message: 'unauthorized access' }).category, 'auth');
});

test('메시지 "authentication failed" → auth', () => {
  assert.equal(classifyClaudeError({ message: 'authentication failed for key' }).category, 'auth');
});

test('메시지 "malformed request" → bad_request', () => {
  const c = classifyClaudeError({ message: 'malformed request payload' });
  assert.equal(c.category, 'bad_request');
  assert.equal(retryPolicyFor(c.category).retriable, false, 'bad_request 는 재시도 불가');
});

test('메시지 "Invalid parameter" → bad_request', () => {
  assert.equal(classifyClaudeError({ message: 'Invalid parameter: model' }).category, 'bad_request');
});

// ---------------------------------------------------------------------------
// 기존 우선순위 계약 — 신규 휴리스틱이 깨지 않는지 검증
// ---------------------------------------------------------------------------

test('우선순위 — status 429 + "invalid key" 메시지는 여전히 rate_limit (status 가 우선)', () => {
  // 기존 classify 계약상 status 값이 가장 먼저 판정된다. 메시지에 auth 힌트가 있어도
  // status=429 가 이긴다.
  const c = classifyClaudeError({ status: 429, message: 'invalid api key' });
  assert.equal(c.category, 'rate_limit');
});

test('우선순위 — timed out 메시지는 여전히 timeout 우선 (휴리스틱보다 먼저 체크)', () => {
  // 기존 claudeErrorsClassify.regression.test.ts 의 "status=500 + timed out → timeout" 계약 유지.
  const c = classifyClaudeError({ status: 500, message: 'timed out waiting for response' });
  assert.equal(c.category, 'timeout');
});

test('우선순위 — network code(ECONNRESET) 가 메시지 힌트보다 우선', () => {
  // "network error, rate limit close" 처럼 섞여 와도 Node 코드가 있으면 network.
  const c = classifyClaudeError({ code: 'ECONNRESET', message: 'network error — rate limit may be near' });
  assert.equal(c.category, 'network');
});

test('휴리스틱 미적용 — 단순 "wat" 메시지는 여전히 api_error 폴백', () => {
  assert.equal(classifyClaudeError(new Error('wat')).category, 'api_error');
});

test('휴리스틱 미적용 — 빈 메시지 + status 500 은 api_error 유지', () => {
  assert.equal(classifyClaudeError({ status: 500 }).category, 'api_error');
});

// ---------------------------------------------------------------------------
// 휴리스틱 자체 우선순위 — rate_limit > overloaded > auth > bad_request
// ---------------------------------------------------------------------------

test('휴리스틱 우선순위 — "rate limit" + "invalid" 메시지는 rate_limit 이 앞선다', () => {
  const c = classifyClaudeError({ message: 'invalid input — rate limit exceeded' });
  assert.equal(c.category, 'rate_limit');
});

test('휴리스틱 우선순위 — "overloaded" + "unauthorized" 메시지는 overloaded 가 앞선다', () => {
  const c = classifyClaudeError({ message: 'server overloaded, unauthorized fallback' });
  assert.equal(c.category, 'overloaded');
});

test('휴리스틱 우선순위 — "unauthorized" + "invalid parameter" 메시지는 auth 가 앞선다', () => {
  const c = classifyClaudeError({ message: 'unauthorized: invalid parameter' });
  assert.equal(c.category, 'auth');
});

// ---------------------------------------------------------------------------
// 휴리스틱이 분류기의 반환 shape 를 망가뜨리지 않는지
// ---------------------------------------------------------------------------

test('반환 shape — category · message · cause 는 모두 채워진다', () => {
  const err = { message: 'Rate limit exceeded' };
  const c = classifyClaudeError(err);
  assert.equal(c.category, 'rate_limit');
  assert.equal(c.message, 'Rate limit exceeded');
  assert.equal(c.cause, err);
});
