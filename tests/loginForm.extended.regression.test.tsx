// Run with: npx tsx --test tests/loginForm.extended.regression.test.tsx
//
// QA: 지시 #478d99c1 — 기존 `tests/loginForm.regression.test.tsx` 12 축에
// 누락된 **역 불변** 과 **OAuth 분리** 엣지를 추가 잠금.
//   E-02: `error=null` 이면 role="alert" 배너가 DOM 에 부재
//   E-03: `onPremise=false` 일 때 아이디/비밀번호 입력이 렌더되지 않음(OAuth 분리)
//   E-05: provider='gitlab' OAuth 모드에서도 폼 필드 부재(E-03 의 다른 프로바이더 회귀)
//
// 주(註): "submit reject 후 복구" 와 "submit 중 error 주입" 은 `act` + 비동기 경계에서
// 환경 의존도가 커 별도 통합 테스트에서 다룰 계획이다. 본 파일은 DOM 정적 관찰만으로
// 잠글 수 있는 3 축만 포함해 JSDOM 환경에서 안정적으로 돌아가는 데 집중한다.
//
// 기존 파일은 Joker/QA 영역으로 간주해 수정하지 않는다.

import 'global-jsdom/register';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

import { LoginForm, type LoginFormProps } from '../src/components/LoginForm.tsx';

type Overrides = Partial<LoginFormProps>;

function renderLogin(overrides: Overrides = {}) {
  const props: LoginFormProps = {
    onPremise: overrides.onPremise ?? true,
    provider: overrides.provider ?? 'github',
    onSubmit: overrides.onSubmit ?? (async () => {}),
    onOAuth: overrides.onOAuth ?? (() => {}),
    onSwitchToSignup: overrides.onSwitchToSignup ?? (() => {}),
    error: overrides.error ?? null,
  };
  const handle = render(React.createElement(LoginForm, props));
  return { ...handle, props };
}

// ─── E-02 · error null 시 배너 부재 ────────────────────────────────────

test('E-02 — error=null 이면 role="alert" 배너가 DOM 에 부재(역 불변)', () => {
  const { container, unmount } = renderLogin({ error: null });
  const alert = container.querySelector('#login-error');
  assert.equal(alert, null, 'error 가 없으면 배너도 렌더되면 안 된다');
  const anyAlert = container.querySelector('[role="alert"]');
  assert.equal(anyAlert, null, '불필요한 role="alert" 요소가 존재하면 스크린 리더가 빈 알림을 읽는다');
  unmount();
  cleanup();
});

// ─── E-03 · OAuth 모드에서 폼 필드 부재 ────────────────────────────────

test('E-03 — onPremise=false 일 때 username/password 입력이 렌더되지 않는다(OAuth 분리)', () => {
  const { container, unmount } = renderLogin({ onPremise: false, provider: 'github' });
  const usernameInput = container.querySelector('input[autocomplete="username"]');
  const passwordInput = container.querySelector('input[type="password"]');
  assert.equal(usernameInput, null, 'OAuth 전용 모드에서 아이디 입력이 있으면 잘못된 자격증명이 새어나올 수 있다');
  assert.equal(passwordInput, null, 'OAuth 전용 모드에서 비밀번호 입력이 있으면 동상');
  unmount();
  cleanup();
});

// ─── E-05 · gitlab 프로바이더에서도 폼 필드 부재 ───────────────────────

test('E-05 — provider="gitlab" OAuth 모드에서도 폼 필드가 부재(E-03 의 다른 프로바이더 회귀)', () => {
  const { container, unmount } = renderLogin({ onPremise: false, provider: 'gitlab' });
  assert.equal(container.querySelector('input[autocomplete="username"]'), null);
  assert.equal(container.querySelector('input[type="password"]'), null);
  unmount();
  cleanup();
});
