// Run with: npx tsx --test tests/authGateAccessibility.regression.test.ts
//
// QA 회귀 · AuthGate 접근성·예외 방어 (지시 #18a3047f).
//
// AuthGate 는 앱 진입점의 최상위 가드이므로 DOM 렌더 통합 테스트 대신 정적 검증으로
// 세 가지 계약을 잠근다:
//   1. 로딩 영역이 `role="status"` + `aria-live="polite"` 로 스크린리더에 1회 낭독된다.
//   2. bootError 복구 버튼이 한국어 aria-label 을 갖는다("인증 서버 연결 다시 시도").
//   3. handleLogin/handleSignup 이 try/catch 블록으로 감싸져 네트워크 예외를
//      LoginForm 의 role="alert" 배너 경로로 돌려 주도록 되어 있다(포착되지 않은
//      Promise rejection 방어).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'AuthGate.tsx'),
  'utf8',
);

test('로딩 컨테이너는 role="status" + aria-live="polite" 를 가진다', () => {
  // 첫 렌더 경로의 "로딩 중…" 문구가 스크린리더에 전달되지 않으면 시각 장애 사용자는
  // 앱이 "정지" 된 것으로 오해한다.
  const loadingIdx = SRC.indexOf('data-testid="auth-loading"');
  assert.ok(loadingIdx > -1, 'auth-loading 컨테이너 식별자가 필요하다');
  // 해당 식별자 주변 400자 창 안에 role="status" · aria-live="polite" 가 함께 등장
  const windowStart = Math.max(0, loadingIdx - 400);
  const windowEnd = Math.min(SRC.length, loadingIdx + 400);
  const snippet = SRC.slice(windowStart, windowEnd);
  assert.match(snippet, /role="status"/, '로딩 컨테이너 근처에 role="status" 가 필요하다');
  assert.match(snippet, /aria-live="polite"/, '로딩 컨테이너 근처에 aria-live="polite" 가 필요하다');
});

test('bootError 재시도 버튼은 한국어 aria-label 을 갖는다', () => {
  assert.match(
    SRC,
    /aria-label="인증 서버 연결 다시 시도"/,
    '재시도 버튼은 스크린리더에 "무엇을 다시 시도" 인지 한국어로 전달되어야 한다',
  );
});

test('handleLogin/handleSignup 은 try/catch 로 네트워크 예외를 포착해 setError 로 흘린다', () => {
  // 과거에는 fetch 자체 TypeError(네트워크 끊김·DNS 실패) 가 포착되지 않아
  // LoginForm 배너에 아무 메시지도 뜨지 않고 버튼만 먹통처럼 보였다.
  const loginBlock = SRC.match(/const handleLogin = async[\s\S]*?\n  \};/);
  assert.ok(loginBlock, 'handleLogin 블록을 찾지 못했다');
  assert.match(loginBlock![0], /try\s*\{[\s\S]*catch\s*\(/, 'handleLogin 에 try/catch 필요');
  assert.match(loginBlock![0], /로그인 실패/, 'catch 블록이 한국어 에러 메시지를 세팅해야 한다');

  const signupBlock = SRC.match(/const handleSignup = async[\s\S]*?\n  \};/);
  assert.ok(signupBlock, 'handleSignup 블록을 찾지 못했다');
  assert.match(signupBlock![0], /try\s*\{[\s\S]*catch\s*\(/, 'handleSignup 에 try/catch 필요');
  assert.match(signupBlock![0], /회원가입 실패/, 'catch 블록이 한국어 에러 메시지를 세팅해야 한다');
});
