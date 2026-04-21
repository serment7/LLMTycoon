// Run with: npx tsx --test tests/i18n/languageToggle.visibility.spec.tsx
//
// 지시 #b9552a14 — 헤더 언어 토글 가시성 보강 회귀.
//
// 축
//   V1. LanguageToggle — EN/KO 세그먼트 버튼이 실제로 DOM 에 렌더되고 aria-pressed 로
//        현재 locale 을 표시한다.
//   V2. 버튼 클릭 — setLocale + onPersist 훅이 호출되고 aria-pressed 가 즉시 전환된다.
//   V3. AppShell 헤더 — 세그먼트 버튼이 헤더 우측에 그대로 노출된다(숨김 X).
//   V4. 숨김 select 는 DOM 에 남아 있어 기존 자동화 경로(select.value) 가 살아 있다.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup, fireEvent } from '@testing-library/react';

import {
  I18nProvider,
  __resetLocaleForTests,
  DEFAULT_LOCALE,
  type Locale,
} from '../../src/i18n/index.ts';
import { LanguageToggle } from '../../src/ui/LanguageToggle.tsx';
import { AppShell } from '../../src/ui/AppShell.tsx';

function onboardedStorage() {
  return {
    getItem: () => '1',
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

test('V1. 세그먼트 버튼 — EN/KO 두 버튼이 헤더 토글에 모두 렌더된다', () => {
  __resetLocaleForTests('en');
  try {
    render(
      React.createElement(I18nProvider, null,
        React.createElement(LanguageToggle, null),
      ),
    );
    const en = document.querySelector('[data-testid="language-toggle-en"]') as HTMLButtonElement;
    const ko = document.querySelector('[data-testid="language-toggle-ko"]') as HTMLButtonElement;
    assert.ok(en, 'EN 버튼이 렌더');
    assert.ok(ko, 'KO 버튼이 렌더');
    assert.equal(en.getAttribute('aria-pressed'), 'true', '현재 locale(en) 버튼은 pressed');
    assert.equal(ko.getAttribute('aria-pressed'), 'false');
    assert.equal(en.textContent, 'EN');
    assert.equal(ko.textContent, 'KO');
  } finally {
    cleanup();
    __resetLocaleForTests(DEFAULT_LOCALE);
  }
});

test('V2. 버튼 클릭 — setLocale 이 발사되고 aria-pressed 가 즉시 전환된다', () => {
  __resetLocaleForTests('en');
  try {
    let persisted: Locale | null = null;
    render(
      React.createElement(I18nProvider, null,
        React.createElement(LanguageToggle, { onPersist: (l: Locale) => { persisted = l; } }),
      ),
    );
    const ko = document.querySelector('[data-testid="language-toggle-ko"]') as HTMLButtonElement;
    act(() => { fireEvent.click(ko); });
    assert.equal(persisted, 'ko', 'onPersist 는 선택된 locale 을 받는다');
    const enAfter = document.querySelector('[data-testid="language-toggle-en"]') as HTMLButtonElement;
    const koAfter = document.querySelector('[data-testid="language-toggle-ko"]') as HTMLButtonElement;
    assert.equal(enAfter.getAttribute('aria-pressed'), 'false');
    assert.equal(koAfter.getAttribute('aria-pressed'), 'true');
  } finally {
    cleanup();
    __resetLocaleForTests(DEFAULT_LOCALE);
  }
});

test('V3. AppShell 헤더 — 세그먼트 버튼이 헤더에 노출되고 initialLocale 을 반영한다', () => {
  __resetLocaleForTests('en');
  try {
    render(
      React.createElement(AppShell, {
        initialLocale: 'ko',
        storage: onboardedStorage(),
      }),
    );
    const header = document.querySelector('.app-shell-header');
    assert.ok(header, '헤더가 렌더');
    const buttons = header!.querySelectorAll('[data-testid^="language-toggle-"]');
    assert.equal(buttons.length, 2, '헤더에 EN/KO 두 버튼이 있다');
    const ko = header!.querySelector('[data-testid="language-toggle-ko"]') as HTMLButtonElement;
    assert.equal(ko.getAttribute('aria-pressed'), 'true', '복원된 ko 가 pressed');
  } finally {
    cleanup();
    __resetLocaleForTests(DEFAULT_LOCALE);
  }
});

test('V4. 숨김 select — DOM 에 남아 있어 value/onChange 로도 조작 가능', () => {
  __resetLocaleForTests('en');
  try {
    let persisted: Locale | null = null;
    render(
      React.createElement(I18nProvider, null,
        React.createElement(LanguageToggle, { onPersist: (l: Locale) => { persisted = l; } }),
      ),
    );
    const select = document.querySelector('select.language-toggle-select') as HTMLSelectElement;
    assert.ok(select, '숨김 select 는 여전히 DOM 에 있다');
    assert.equal(select.value, 'en');
    act(() => { fireEvent.change(select, { target: { value: 'ko' } }); });
    assert.equal(persisted, 'ko');
    assert.equal(select.value, 'ko');
  } finally {
    cleanup();
    __resetLocaleForTests(DEFAULT_LOCALE);
  }
});
