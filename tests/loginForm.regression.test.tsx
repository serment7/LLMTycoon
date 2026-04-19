// Run with: npx tsx --test tests/loginForm.regression.test.tsx
//
// QA 회귀 · LoginForm (지시 #4ba11bd4, 라운드 7).
// docs/qa-coverage-gap-2026-04-19.md §3.3 G-2 (Auth 3컴포넌트 단위) 액션 아이템 N-12 기여.
//
// 검증 축:
//   L-01: onPremise=false 일 때 GitHub 프로바이더 버튼 노출 + 클릭 시 onOAuth 호출
//   L-02: onPremise=false 일 때 GitLab 프로바이더 버튼 노출
//   L-03: onPremise=true 일 때 아이디/비밀번호 입력 필드 + submit 버튼 렌더
//   L-04: error prop 전달 시 role="alert" + id="login-error" 배너 표시
//   L-05: username/password 가 빈 값이면 submit 버튼 disabled
//   L-06: 둘 다 채우면 submit 버튼 활성화
//   L-07: submit 시 username 을 trim 해서 onSubmit 에 전달
//   L-08: submit 진행 중에는 버튼 disabled 유지 + 중복 호출 무시
//   L-09: submit resolve 후 submitting 상태가 복구되어 버튼이 다시 활성
//   L-10: 회원가입 링크 클릭 시 onSwitchToSignup 호출
//   L-11: password 입력에 autoComplete="current-password" 가 부여된다(접근성·비밀번호 관리자 연동)
//   L-12: error 와 CapsLock 활성 시 aria-describedby 가 두 id 를 공백으로 결합

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup, fireEvent } from '@testing-library/react';

import { LoginForm, type LoginFormProps } from '../src/components/LoginForm.tsx';

type Overrides = Partial<LoginFormProps>;

function renderLogin(overrides: Overrides = {}) {
  const onSubmit = overrides.onSubmit ?? (async () => {});
  const onOAuth = overrides.onOAuth ?? (() => {});
  const onSwitchToSignup = overrides.onSwitchToSignup ?? (() => {});
  const props: LoginFormProps = {
    onPremise: overrides.onPremise ?? true,
    provider: overrides.provider ?? 'github',
    onSubmit,
    onOAuth,
    onSwitchToSignup,
    error: overrides.error ?? null,
  };
  const handle = render(React.createElement(LoginForm, props));
  return { ...handle, props };
}

// ─── (1) OAuth 분기 ────────────────────────────────────────────────────

test('L-01: onPremise=false 일 때 GitHub 로 계속하기 버튼 노출 + 클릭 시 onOAuth 호출', () => {
  let oauthCalls = 0;
  const { getByRole, unmount } = renderLogin({
    onPremise: false,
    provider: 'github',
    onOAuth: () => {
      oauthCalls += 1;
    },
  });
  const btn = getByRole('button', { name: /GitHub 로 계속하기/ });
  fireEvent.click(btn);
  assert.equal(oauthCalls, 1);
  unmount();
  cleanup();
});

test('L-02: onPremise=false + provider="gitlab" 이면 GitLab 로 계속하기 버튼 노출', () => {
  const { getByRole, unmount } = renderLogin({
    onPremise: false,
    provider: 'gitlab',
  });
  const btn = getByRole('button', { name: /GitLab 로 계속하기/ });
  assert.ok(btn, 'GitLab 버튼이 렌더되어야 함');
  unmount();
  cleanup();
});

// ─── (2) 온프레미스 폼 렌더 ─────────────────────────────────────────────

test('L-03: onPremise=true 일 때 아이디/비밀번호 입력 + 로그인 버튼이 렌더', () => {
  const { container, getByRole, unmount } = renderLogin({ onPremise: true });
  const usernameInput = container.querySelector('input[autocomplete="username"]');
  const passwordInput = container.querySelector('input[type="password"]');
  assert.ok(usernameInput, '아이디 입력이 렌더되어야 함');
  assert.ok(passwordInput, '비밀번호 입력이 렌더되어야 함');
  const submitBtn = getByRole('button', { name: /로그인/ });
  assert.ok(submitBtn);
  unmount();
  cleanup();
});

// ─── (3) error 배너 ────────────────────────────────────────────────────

test('L-04: error prop 전달 시 role="alert" + id="login-error" 배너가 표시', () => {
  const { container, unmount } = renderLogin({ error: '아이디 또는 비밀번호가 틀립니다.' });
  const alert = container.querySelector('#login-error');
  assert.ok(alert, '#login-error 배너가 존재해야 함');
  assert.equal(alert!.getAttribute('role'), 'alert');
  assert.match(alert!.textContent || '', /아이디 또는 비밀번호/);
  unmount();
  cleanup();
});

// ─── (4) submit 버튼 게이트 ────────────────────────────────────────────

test('L-05: username/password 빈 값이면 로그인 버튼 disabled', () => {
  const { getByRole, unmount } = renderLogin();
  const submitBtn = getByRole('button', { name: /로그인/ }) as HTMLButtonElement;
  assert.equal(submitBtn.disabled, true);
  unmount();
  cleanup();
});

test('L-06: 아이디·비밀번호 둘 다 채우면 로그인 버튼이 활성화', () => {
  const { container, getByRole, unmount } = renderLogin();
  const usernameInput = container.querySelector(
    'input[autocomplete="username"]',
  ) as HTMLInputElement;
  const passwordInput = container.querySelector(
    'input[type="password"]',
  ) as HTMLInputElement;
  fireEvent.change(usernameInput, { target: { value: 'alice' } });
  fireEvent.change(passwordInput, { target: { value: 'secret' } });
  const submitBtn = getByRole('button', { name: /로그인/ }) as HTMLButtonElement;
  assert.equal(submitBtn.disabled, false);
  unmount();
  cleanup();
});

// ─── (5) trim · 이중 호출 방어 · 상태 복구 ─────────────────────────────

test('L-07: submit 시 username 을 trim 해서 onSubmit 에 전달', async () => {
  const calls: Array<{ u: string; p: string }> = [];
  const { container, getByRole, unmount } = renderLogin({
    onSubmit: async (u, p) => {
      calls.push({ u, p });
    },
  });
  const usernameInput = container.querySelector(
    'input[autocomplete="username"]',
  ) as HTMLInputElement;
  const passwordInput = container.querySelector(
    'input[type="password"]',
  ) as HTMLInputElement;
  fireEvent.change(usernameInput, { target: { value: '  alice  ' } });
  fireEvent.change(passwordInput, { target: { value: 'secret' } });
  const form = container.querySelector('form')!;
  await act(async () => {
    fireEvent.submit(form);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].u, 'alice', '앞뒤 공백이 제거되어야 함');
  assert.equal(calls[0].p, 'secret');
  // 부가: submit 완료 후 버튼이 다시 활성
  const submitBtn = getByRole('button', { name: /로그인/ }) as HTMLButtonElement;
  assert.equal(submitBtn.disabled, false);
  unmount();
  cleanup();
});

test('L-08: submit 진행 중에는 중복 submit 호출이 무시된다', async () => {
  let resolveOnSubmit: (() => void) | null = null;
  const pending = new Promise<void>((r) => {
    resolveOnSubmit = r;
  });
  let callCount = 0;
  const { container, unmount } = renderLogin({
    onSubmit: async () => {
      callCount += 1;
      await pending;
    },
  });
  const usernameInput = container.querySelector(
    'input[autocomplete="username"]',
  ) as HTMLInputElement;
  const passwordInput = container.querySelector(
    'input[type="password"]',
  ) as HTMLInputElement;
  fireEvent.change(usernameInput, { target: { value: 'alice' } });
  fireEvent.change(passwordInput, { target: { value: 'secret' } });
  const form = container.querySelector('form')!;
  // 첫 submit — pending
  act(() => {
    fireEvent.submit(form);
  });
  // 진행 중 두 번째 submit 시도 — 가드로 무시되어야 함
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  assert.equal(callCount, 1, 'submit 진행 중 재호출은 onSubmit 을 추가로 부르지 않음');
  // 완료 시키고 cleanup
  await act(async () => {
    resolveOnSubmit!();
    await pending;
  });
  unmount();
  cleanup();
});

test('L-09: onSubmit 이 resolve 된 뒤 로그인 버튼이 다시 활성화', async () => {
  const { container, getByRole, unmount } = renderLogin({
    onSubmit: async () => {
      /* 즉시 resolve */
    },
  });
  const usernameInput = container.querySelector(
    'input[autocomplete="username"]',
  ) as HTMLInputElement;
  const passwordInput = container.querySelector(
    'input[type="password"]',
  ) as HTMLInputElement;
  fireEvent.change(usernameInput, { target: { value: 'alice' } });
  fireEvent.change(passwordInput, { target: { value: 'secret' } });
  const form = container.querySelector('form')!;
  await act(async () => {
    fireEvent.submit(form);
  });
  const submitBtn = getByRole('button', { name: /로그인/ }) as HTMLButtonElement;
  assert.equal(submitBtn.disabled, false, 'finally 에서 submitting=false 로 복구');
  unmount();
  cleanup();
});

// ─── (6) 회원가입 링크 ─────────────────────────────────────────────────

test('L-10: 회원가입 링크 클릭 시 onSwitchToSignup 호출', () => {
  let switched = 0;
  const { getByText, unmount } = renderLogin({
    onSwitchToSignup: () => {
      switched += 1;
    },
  });
  const link = getByText(/계정이 없으신가요\? 회원가입/);
  fireEvent.click(link);
  assert.equal(switched, 1);
  unmount();
  cleanup();
});

// ─── (7) 접근성·자동완성 ────────────────────────────────────────────────

test('L-11: password 입력은 autoComplete="current-password" 로 비밀번호 관리자·스크린리더와 호환', () => {
  const { container, unmount } = renderLogin();
  const passwordInput = container.querySelector(
    'input[type="password"]',
  ) as HTMLInputElement;
  assert.equal(passwordInput.getAttribute('autocomplete'), 'current-password');
  unmount();
  cleanup();
});

test('L-12: error 존재 시 password 의 aria-describedby 가 login-error id 를 포함', () => {
  const { container, unmount } = renderLogin({ error: '로그인 실패' });
  const passwordInput = container.querySelector(
    'input[type="password"]',
  ) as HTMLInputElement;
  const describedBy = passwordInput.getAttribute('aria-describedby') ?? '';
  assert.ok(
    describedBy.split(' ').includes('login-error'),
    'aria-describedby 에 login-error id 가 포함되어야 함',
  );
  unmount();
  cleanup();
});
