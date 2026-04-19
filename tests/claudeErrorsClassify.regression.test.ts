// Run with: npx tsx --test tests/claudeErrorsClassify.regression.test.ts
//
// QA: 지시 #697c4e29 의 (1) 에러 분류기 회귀.
// status / SDK type / Node code / Error name / 메시지 패턴 × 7개 카테고리 매트릭스.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyClaudeError } from '../src/server/claudeErrors.ts';

test('status=429 → rate_limit, retry-after 헤더 초 단위를 ms 로 환산', () => {
  const err = { status: 429, headers: { 'retry-after': '30' }, message: 'Too many requests' };
  const c = classifyClaudeError(err);
  assert.equal(c.category, 'rate_limit');
  assert.equal(c.retryAfterMs, 30_000);
});

test('status=429 — retry-after 가 HTTP-date 이면 현재 시각 대비 ms 환산', () => {
  const futureIso = new Date(Date.now() + 5_000).toUTCString();
  const c = classifyClaudeError({ status: 429, headers: { 'retry-after': futureIso } });
  assert.equal(c.category, 'rate_limit');
  assert.ok((c.retryAfterMs ?? 0) >= 3_000 && (c.retryAfterMs ?? 0) <= 6_000);
});

test('type=rate_limit_error 도 429 동등으로 취급', () => {
  const c = classifyClaudeError({ type: 'rate_limit_error', message: 'quota' });
  assert.equal(c.category, 'rate_limit');
});

test('status=529 / type=overloaded_error → overloaded', () => {
  assert.equal(classifyClaudeError({ status: 529 }).category, 'overloaded');
  assert.equal(classifyClaudeError({ type: 'overloaded_error' }).category, 'overloaded');
});

test('status=401 / 403 → auth', () => {
  assert.equal(classifyClaudeError({ status: 401 }).category, 'auth');
  assert.equal(classifyClaudeError({ status: 403 }).category, 'auth');
});

test('status=400 / type=invalid_request_error → bad_request', () => {
  assert.equal(classifyClaudeError({ status: 400 }).category, 'bad_request');
  assert.equal(classifyClaudeError({ type: 'invalid_request_error' }).category, 'bad_request');
});

test('AbortError / ETIMEDOUT / 408 / "timed out" 메시지 → timeout', () => {
  assert.equal(classifyClaudeError({ name: 'AbortError' }).category, 'timeout');
  assert.equal(classifyClaudeError({ code: 'ETIMEDOUT' }).category, 'timeout');
  assert.equal(classifyClaudeError({ status: 408 }).category, 'timeout');
  assert.equal(classifyClaudeError({ message: 'request timed out' }).category, 'timeout');
});

test('Node network error codes → network', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH']) {
    assert.equal(classifyClaudeError({ code }).category, 'network', `${code} 가 network 로 분류되어야 한다`);
  }
});

test('status=5xx(429/529 제외) → api_error', () => {
  assert.equal(classifyClaudeError({ status: 500 }).category, 'api_error');
  assert.equal(classifyClaudeError({ status: 502 }).category, 'api_error');
  assert.equal(classifyClaudeError({ status: 503 }).category, 'api_error');
});

test('알 수 없는 에러는 api_error 로 폴백', () => {
  assert.equal(classifyClaudeError(new Error('wat')).category, 'api_error');
  assert.equal(classifyClaudeError(null).category, 'api_error');
  assert.equal(classifyClaudeError('nope').category, 'api_error');
});

test('response.status / response.headers 중첩 경로도 읽는다(SDK 스타일)', () => {
  const err = { response: { status: 429, headers: { 'retry-after': '10' } } };
  const c = classifyClaudeError(err);
  assert.equal(c.category, 'rate_limit');
  assert.equal(c.retryAfterMs, 10_000);
});

test('우선순위 — status 값이 우선, 메시지의 timed out 은 status 분류를 뒤집지 않는다', () => {
  // status 500 + "timed out" 메시지는 api_error 가 먼저 결정됨(5xx 분기는 timeout 분기 뒤).
  // 본 프로젝트의 분류기는 timeout 분기가 status=408 만 잡으므로, 500 + "timed out" 은
  // api_error 가 아니라 timeout 이 되어야 한다(메시지 휴리스틱이 fallback 앞).
  // 이 불변을 명문화한다.
  const c = classifyClaudeError({ status: 500, message: 'timed out' });
  assert.equal(c.category, 'timeout', '메시지 timed out 은 5xx 폴백보다 먼저 타임아웃으로 수렴');
});

// ────────────────────────────────────────────────────────────────────────────
// #8888a819 확장 — 구독 세션 폴백(TokenExhausted · SubscriptionExpired) 경계
// ────────────────────────────────────────────────────────────────────────────

import {
  TokenExhaustedError,
  SubscriptionExpiredError,
  retryPolicyFor,
} from '../src/server/claudeErrors.ts';

test('TokenExhaustedError instanceof — message · retryAfterMs 가 그대로 전파되고 재분류되지 않는다', () => {
  const err = new TokenExhaustedError('월 할당량 초과', { retryAfterMs: 30_000 });
  const c = classifyClaudeError(err);
  assert.equal(c.category, 'token_exhausted');
  assert.equal(c.retryAfterMs, 30_000, 'retryAfterMs 전파');
  assert.match(c.message, /월 할당량 초과/);
  assert.equal(c.cause, err, 'cause 는 원본 인스턴스');
});

test('SubscriptionExpiredError instanceof — category 는 subscription_expired 로 직행', () => {
  const err = new SubscriptionExpiredError('구독이 만료되었습니다');
  const c = classifyClaudeError(err);
  assert.equal(c.category, 'subscription_expired');
  assert.equal(c.cause, err);
});

test('status=402 / type=payment_required / type=subscription_expired → subscription_expired (우선 분기)', () => {
  assert.equal(classifyClaudeError({ status: 402 }).category, 'subscription_expired');
  assert.equal(classifyClaudeError({ type: 'payment_required' }).category, 'subscription_expired');
  assert.equal(classifyClaudeError({ type: 'subscription_expired' }).category, 'subscription_expired');
});

test('type=token_exhausted / insufficient_quota / credit_exhausted → token_exhausted', () => {
  for (const type of ['token_exhausted', 'insufficient_quota', 'credit_exhausted']) {
    assert.equal(
      classifyClaudeError({ type }).category,
      'token_exhausted',
      `type=${type}`,
    );
  }
});

test('메시지 휴리스틱 — "subscription expired / payment required / trial has ended" 는 subscription_expired 로 수렴', () => {
  for (const msg of [
    'Your subscription has expired',
    'subscription required',
    'Payment required for this request',
    'Your trial has ended',
    'Plan has expired',
  ]) {
    assert.equal(classifyClaudeError({ message: msg }).category, 'subscription_expired', msg);
  }
});

test('메시지 휴리스틱 — "tokens exhausted / credit depleted / monthly quota exceeded" 는 token_exhausted', () => {
  for (const msg of [
    'Tokens have been exhausted',
    'credits exhausted',
    'usage limit reached',
    'monthly quota exceeded',
    'balance depleted',
    'insufficient credit',
  ]) {
    assert.equal(classifyClaudeError({ message: msg }).category, 'token_exhausted', msg);
  }
});

test('휴리스틱 우선순위 — subscription_expired 가 token_exhausted 보다 먼저 검사된다(혼합 문구 보호)', () => {
  // "subscription tokens exhausted" 같이 두 어휘가 섞여 있어도 사용자 조치가 더 큰
  // subscription_expired 로 먼저 수렴해야 UI 가 잘못된 재충전 안내 대신 재가입을 유도한다.
  // MSG_SUBSCRIPTION_EXPIRED 가 해당 문구를 잡도록 선제적으로 작성되어 있어야 한다.
  const c = classifyClaudeError({
    message: 'Your subscription has expired and tokens have been exhausted',
  });
  assert.equal(c.category, 'subscription_expired');
});

test('retryPolicyFor — token_exhausted · subscription_expired 는 재시도 금지(retriable=false, maxRetries=0)', () => {
  for (const cat of ['token_exhausted', 'subscription_expired'] as const) {
    const p = retryPolicyFor(cat);
    assert.equal(p.retriable, false, `${cat}: retriable false`);
    assert.equal(p.maxRetries, 0, `${cat}: maxRetries 0`);
    assert.equal(p.respectRetryAfter, false);
  }
});

test('헤더 신호 — Web Fetch Headers 인스턴스의 retry-after 가 .get() 경로로 추출된다', () => {
  // Node 의 global Headers 인스턴스를 사용. headers[key] 접근은 지원하지 않고
  // .get('retry-after') 만 동작하므로, 분류기가 .get() 을 시도하는지 회귀.
  const h = new Headers({ 'Retry-After': '5' });
  const c = classifyClaudeError({ status: 429, headers: h });
  assert.equal(c.category, 'rate_limit');
  assert.equal(c.retryAfterMs, 5_000);
});

test('헤더 신호 — 잘못된 get() 구현체는 평문 키 조회로 폴백한다', () => {
  const brokenHeaders = {
    get() {
      throw new Error('broken');
    },
    'retry-after': '12',
  };
  const c = classifyClaudeError({ status: 429, headers: brokenHeaders });
  assert.equal(c.retryAfterMs, 12_000, '평문 폴백으로 12초 환산');
});
