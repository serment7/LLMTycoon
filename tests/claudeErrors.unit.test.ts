// Run with: npx tsx --test tests/claudeErrors.unit.test.ts
//
// 단위 테스트: src/server/claudeErrors.ts — classifyClaudeError 7종 분기 +
// computeBackoffMs 지수 증가·cap·jitter·retry-after 존중.
// 지시 #b17802a6 — 클로드 SDK 에러 분류기 및 재시도 지수 백오프.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyClaudeError,
  computeBackoffMs,
  retryPolicyFor,
  CLAUDE_ERROR_CATEGORIES,
  TokenExhaustedError,
  SubscriptionExpiredError,
} from '../src/server/claudeErrors.ts';

// ─── classify — 7 카테고리 분기 매트릭스 ────────────────────────────────────

test('classify — HTTP 429 는 rate_limit 으로 수렴, retry-after 초 단위가 ms 로 환산된다', () => {
  const r = classifyClaudeError({ status: 429, response: { status: 429, headers: { 'retry-after': '12' } } });
  assert.equal(r.category, 'rate_limit');
  assert.equal(r.retryAfterMs, 12_000);
});

test('classify — SDK type="rate_limit_error" 도 status 없이 rate_limit 으로 분류', () => {
  const r = classifyClaudeError({ type: 'rate_limit_error', message: 'too fast' });
  assert.equal(r.category, 'rate_limit');
  assert.equal(r.message, 'too fast');
});

test('classify — HTTP 529 / type="overloaded_error" 는 overloaded', () => {
  assert.equal(classifyClaudeError({ status: 529 }).category, 'overloaded');
  assert.equal(classifyClaudeError({ type: 'overloaded_error' }).category, 'overloaded');
});

test('classify — 401/403 은 auth', () => {
  assert.equal(classifyClaudeError({ status: 401 }).category, 'auth');
  assert.equal(classifyClaudeError({ status: 403 }).category, 'auth');
});

test('classify — 400 / type="invalid_request_error" 는 bad_request (재시도 불가)', () => {
  assert.equal(classifyClaudeError({ status: 400 }).category, 'bad_request');
  assert.equal(classifyClaudeError({ type: 'invalid_request_error' }).category, 'bad_request');
  assert.equal(retryPolicyFor('bad_request').retriable, false);
});

test('classify — AbortError · ETIMEDOUT · 408 · timed out 메시지는 timeout', () => {
  assert.equal(classifyClaudeError({ name: 'AbortError' }).category, 'timeout');
  assert.equal(classifyClaudeError({ code: 'ETIMEDOUT' }).category, 'timeout');
  assert.equal(classifyClaudeError({ status: 408 }).category, 'timeout');
  assert.equal(classifyClaudeError({ message: 'request timed out' }).category, 'timeout');
});

test('classify — 네트워크 코드 6종은 network 카테고리', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH']) {
    assert.equal(classifyClaudeError({ code }).category, 'network', `${code} → network`);
  }
});

test('classify — 5xx 는 api_error, 분류 불가도 api_error 로 폴백', () => {
  assert.equal(classifyClaudeError({ status: 500 }).category, 'api_error');
  assert.equal(classifyClaudeError({ status: 503 }).category, 'api_error');
  assert.equal(classifyClaudeError({}).category, 'api_error');
  assert.equal(classifyClaudeError(null).category, 'api_error');
});

test('classify — retry-after 가 HTTP-date 이면 "지금으로부터 남은 ms" 로 환산', () => {
  const future = new Date(Date.now() + 8_500).toUTCString();
  const r = classifyClaudeError({ status: 429, response: { headers: { 'retry-after': future } } });
  assert.equal(r.category, 'rate_limit');
  // 시계 오차를 감안해 5~10초 범위로 체크
  assert.ok(typeof r.retryAfterMs === 'number' && r.retryAfterMs >= 5_000 && r.retryAfterMs <= 10_000,
    `retryAfterMs=${r.retryAfterMs} 는 5~10s 범위여야 한다`);
});

test('classify — retry-after 가 과거 HTTP-date 이면 0ms 로 클램프', () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  const r = classifyClaudeError({ status: 429, response: { headers: { 'retry-after': past } } });
  assert.equal(r.retryAfterMs, 0);
});

test('classify — response.headers 가 Web Fetch Headers 인스턴스여도 retry-after 가 읽힌다', () => {
  // SDK 전환 시 `error.response.headers` 는 `Headers` 인스턴스로 들어온다.
  // bracket 접근이 불가능하므로 `.get()` 기반 조회가 필요.
  const fetchHeaders = new Headers({ 'Retry-After': '7' });
  const r = classifyClaudeError({ status: 429, response: { status: 429, headers: fetchHeaders } });
  assert.equal(r.category, 'rate_limit');
  assert.equal(r.retryAfterMs, 7_000);
});

test('classify — 대문자 헤더 키(Retry-After) 도 평문 객체에서 인식', () => {
  const r = classifyClaudeError({ status: 429, headers: { 'Retry-After': '3' } });
  assert.equal(r.retryAfterMs, 3_000);
});

test('classify — retry-after 값이 배열이면 첫 요소만 사용(Node IncomingHttpHeaders 호환)', () => {
  const r = classifyClaudeError({ status: 429, headers: { 'retry-after': ['5', '99'] } });
  assert.equal(r.retryAfterMs, 5_000);
});

test('classify — 중첩 error.status 가 401 이어도 auth 로 분류', () => {
  // Anthropic SDK 는 `{ error: { type, status } }` 래퍼를 던지기도 한다. 중첩 경로도
  // 최상위/ response 와 동일하게 status 로 승격되어야 auth 정책(재시도 불가) 이 선택된다.
  const r = classifyClaudeError({ error: { status: 401, type: 'authentication_error' } });
  assert.equal(r.category, 'auth');
});

test('classify — 알 수 없는 형태의 headers 객체(.get 없음, key 없음) 는 retry-after 없음으로 폴백', () => {
  const r = classifyClaudeError({ status: 429, headers: { 'x-unrelated': 'noop' } });
  assert.equal(r.category, 'rate_limit');
  assert.equal(r.retryAfterMs, undefined);
});

test('classify — status 402 는 subscription_expired 로 수렴(#cdaaabf3)', () => {
  const r = classifyClaudeError({ status: 402 });
  assert.equal(r.category, 'subscription_expired');
  assert.equal(retryPolicyFor('subscription_expired').retriable, false);
});

test('classify — type="payment_required" / type="subscription_expired" 도 subscription_expired', () => {
  assert.equal(classifyClaudeError({ type: 'payment_required' }).category, 'subscription_expired');
  assert.equal(classifyClaudeError({ type: 'subscription_expired' }).category, 'subscription_expired');
});

test('classify — type="token_exhausted"/"insufficient_quota"/"credit_exhausted" → token_exhausted', () => {
  assert.equal(classifyClaudeError({ type: 'token_exhausted' }).category, 'token_exhausted');
  assert.equal(classifyClaudeError({ type: 'insufficient_quota' }).category, 'token_exhausted');
  assert.equal(classifyClaudeError({ type: 'credit_exhausted' }).category, 'token_exhausted');
  assert.equal(retryPolicyFor('token_exhausted').retriable, false);
});

test('classify — 메시지 "subscription expired" → subscription_expired (rate_limit 보다 먼저)', () => {
  assert.equal(
    classifyClaudeError({ message: 'Your subscription has expired. Please renew.' }).category,
    'subscription_expired',
  );
});

test('classify — 메시지 "tokens exhausted" / "credits exhausted" / "usage limit reached" → token_exhausted', () => {
  assert.equal(classifyClaudeError({ message: 'tokens exhausted for this month' }).category, 'token_exhausted');
  assert.equal(classifyClaudeError({ message: 'credits exhausted' }).category, 'token_exhausted');
  assert.equal(classifyClaudeError({ message: 'usage limit reached' }).category, 'token_exhausted');
});

test('classify — TokenExhaustedError 인스턴스는 category=token_exhausted 로 직접 수렴', () => {
  const err = new TokenExhaustedError('토큰 소진');
  const c = classifyClaudeError(err);
  assert.equal(c.category, 'token_exhausted');
  assert.equal(c.message, '토큰 소진');
});

test('classify — SubscriptionExpiredError 인스턴스는 category=subscription_expired 로 직접 수렴', () => {
  const err = new SubscriptionExpiredError('구독 만료');
  const c = classifyClaudeError(err);
  assert.equal(c.category, 'subscription_expired');
  assert.equal(c.message, '구독 만료');
});

test('CLAUDE_ERROR_CATEGORIES — 9종이 정확히 정의돼 있다(구독 폴백 2종 포함)', () => {
  assert.deepEqual([...CLAUDE_ERROR_CATEGORIES].sort(), [
    'api_error', 'auth', 'bad_request', 'network', 'overloaded', 'rate_limit',
    'subscription_expired', 'timeout', 'token_exhausted',
  ]);
});

// ─── computeBackoffMs — 지수 + cap + jitter + retry-after ────────────────────

test('computeBackoffMs — attempt 가 커질수록 지수적으로 증가(백오프 base*2^(n-1))', () => {
  const policy = { maxRetries: 5, baseMs: 1000, capMs: 60_000, jitterRatio: 0, respectRetryAfter: false, retriable: true };
  assert.equal(computeBackoffMs(1, policy), 1000);
  assert.equal(computeBackoffMs(2, policy), 2000);
  assert.equal(computeBackoffMs(3, policy), 4000);
  assert.equal(computeBackoffMs(4, policy), 8000);
});

test('computeBackoffMs — capMs 를 넘는 백오프는 cap 으로 클램프', () => {
  const policy = { maxRetries: 10, baseMs: 1000, capMs: 5000, jitterRatio: 0, respectRetryAfter: false, retriable: true };
  assert.equal(computeBackoffMs(10, policy), 5000);
  assert.equal(computeBackoffMs(100, policy), 5000);
});

test('computeBackoffMs — jitter 비율만큼 ±변동이 들어가고, 음수로 내려가지 않는다', () => {
  const policy = { maxRetries: 5, baseMs: 1000, capMs: 60_000, jitterRatio: 0.5, respectRetryAfter: false, retriable: true };
  const high = computeBackoffMs(1, policy, undefined, () => 1);  // (1*2-1)=1 → capped*0.5
  const low = computeBackoffMs(1, policy, undefined, () => 0);   // (0*2-1)=-1 → capped*-0.5
  assert.equal(high, Math.floor(1000 + 500));
  assert.equal(low, Math.floor(1000 - 500));
  assert.ok(low >= 0, '음수 금지');
});

test('computeBackoffMs — respectRetryAfter=true 이고 retryAfterMs 있으면 우선(= cap 으로 제한)', () => {
  const policy = { maxRetries: 5, baseMs: 1000, capMs: 10_000, jitterRatio: 0.2, respectRetryAfter: true, retriable: true };
  assert.equal(computeBackoffMs(1, policy, 8_000), 8_000, '서버 지정값 그대로');
  assert.equal(computeBackoffMs(1, policy, 99_999), 10_000, '서버값이 cap 초과면 cap 으로 클램프');
});

test('computeBackoffMs — respectRetryAfter=false 이면 retryAfterMs 는 무시하고 지수 백오프', () => {
  const policy = { maxRetries: 5, baseMs: 500, capMs: 5_000, jitterRatio: 0, respectRetryAfter: false, retriable: true };
  assert.equal(computeBackoffMs(2, policy, 20_000), 1_000,
    'retry-after 무시, 500*2^(2-1)=1000');
});

test('retryPolicyFor — bad_request/auth 는 maxRetries=0 & retriable=false', () => {
  assert.equal(retryPolicyFor('bad_request').retriable, false);
  assert.equal(retryPolicyFor('bad_request').maxRetries, 0);
  assert.equal(retryPolicyFor('auth').retriable, false);
  assert.equal(retryPolicyFor('auth').maxRetries, 0);
});

test('retryPolicyFor — 재시도 가능 5종(rate_limit/overloaded/api_error/timeout/network) 은 양의 maxRetries', () => {
  for (const c of ['rate_limit', 'overloaded', 'api_error', 'timeout', 'network'] as const) {
    const p = retryPolicyFor(c);
    assert.ok(p.retriable, `${c} 는 재시도 가능`);
    assert.ok(p.maxRetries > 0, `${c} 의 maxRetries > 0`);
  }
});
