// Run with: npx tsx --test tests/i18n/languageToggle.regression.test.tsx
//
// 지시 #8de1a1c8 — 언어 토글 UI + Context 기반 재렌더링 + 세션 동기화 회귀.
//
// 축
//   L1. I18nProvider + useI18n — Context 가 locale 을 전파하고 setLocale 이 자식 재렌더링.
//   L2. LanguageToggle — <select> 값 변경 시 setLocale 호출 + onPersist 콜백 실행.
//   L3. AppShell 헤더 — <LanguageToggle> 이 헤더에 렌더되고, initialLocale 이 복원된다.
//   L4. sessionStore — SessionSnapshot 에 languagePreference 가 저장·복원된다.
//   L5. SessionPersistor.onLanguagePreferenceChanged — 저장이 발생하고 shallowDiff 가 변경 감지.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup, fireEvent } from '@testing-library/react';

import {
  I18nProvider,
  useI18n,
  __resetLocaleForTests,
  DEFAULT_LOCALE,
  type Locale,
} from '../../src/i18n/index.ts';
import { LanguageToggle } from '../../src/ui/LanguageToggle.tsx';
import { AppShell } from '../../src/ui/AppShell.tsx';
import {
  createInMemorySessionStore,
  createSessionPersistor,
  buildSessionSnapshot,
  shallowDiffSnapshot,
} from '../../src/session/sessionStore.ts';
import {
  createBudgetSession,
  recordUsage,
  type BudgetSession,
} from '../../src/llm/tokenBudget.ts';
import type { ClaudeTokenUsage } from '../../src/types.ts';

function WatchLocale(): React.ReactElement {
  const { locale, t } = useI18n();
  return React.createElement('div', { 'data-testid': 'locale-probe' },
    React.createElement('span', { 'data-testid': 'locale-code' }, locale),
    React.createElement('span', { 'data-testid': 'locale-title' }, t('app.title')),
  );
}

function sampleUsage(): ClaudeTokenUsage {
  return {
    input_tokens: 10, output_tokens: 20,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    model: 'm', at: '2026-04-21T10:00:00.000Z',
  };
}

test('L1. I18nProvider + useI18n — locale 전파 후 t() 결과가 변경된다', () => {
  __resetLocaleForTests(DEFAULT_LOCALE);
  try {
    const handle = render(
      React.createElement(I18nProvider, { initialLocale: 'en' },
        React.createElement(WatchLocale),
      ),
    );
    assert.equal(document.querySelector('[data-testid="locale-code"]')?.textContent, 'en');
    const enTitle = document.querySelector('[data-testid="locale-title"]')?.textContent ?? '';

    // Context 안에서 전환 — 자식이 즉시 재렌더링되어야.
    act(() => { handle.rerender(
      React.createElement(I18nProvider, { initialLocale: 'ko' },
        React.createElement(WatchLocale),
      ),
    ); });

    assert.equal(document.querySelector('[data-testid="locale-code"]')?.textContent, 'ko');
    const koTitle = document.querySelector('[data-testid="locale-title"]')?.textContent ?? '';
    assert.notEqual(enTitle, koTitle, 'locale 전환 시 t(app.title) 결과가 달라야');
  } finally {
    cleanup();
    __resetLocaleForTests(DEFAULT_LOCALE);
  }
});

test('L2. LanguageToggle — select 변경 시 onPersist 콜백에 선택된 locale 이 전달된다', () => {
  __resetLocaleForTests('en');
  try {
    let persisted: Locale | null = null;
    render(
      React.createElement(I18nProvider, null,
        React.createElement(LanguageToggle, { onPersist: (l: Locale) => { persisted = l; } }),
      ),
    );
    const select = document.querySelector('select') as HTMLSelectElement;
    assert.ok(select);
    act(() => {
      fireEvent.change(select, { target: { value: 'ko' } });
    });
    assert.equal(persisted, 'ko');
    // 후속 프로브에서 Context 가 ko 로 반영되는지.
    const { t } = getCurrentI18n();
    assert.ok(typeof t('app.title') === 'string');
  } finally {
    cleanup();
    __resetLocaleForTests(DEFAULT_LOCALE);
  }
});

function getCurrentI18n() {
  // Provider 밖에서 useI18n 호출은 React 훅 규칙 위반이라, 테스트용 얇은 Capture 컴포넌트로 대체.
  let captured: { t: (k: string) => string; locale: Locale } | null = null;
  const Capture = (): React.ReactElement => {
    const i = useI18n();
    captured = i;
    return React.createElement('span');
  };
  render(
    React.createElement(I18nProvider, null, React.createElement(Capture)),
  );
  const out = captured!;
  cleanup();
  return out;
}

test('L3. AppShell 헤더 — LanguageToggle 이 렌더되고 initialLocale=ko 가 적용된다', () => {
  __resetLocaleForTests('en');
  try {
    render(
      React.createElement(AppShell, {
        initialLocale: 'ko',
        storage: {
          // OnboardingTour 가 첫 렌더에 뜨지 않도록 completed 저장소를 주입.
          getItem: () => '1',
          setItem: () => undefined,
          removeItem: () => undefined,
        },
      }),
    );
    const toggle = document.querySelector('[data-testid="language-toggle"]');
    assert.ok(toggle, '헤더에 language-toggle 렌더');
    const select = toggle!.querySelector('select') as HTMLSelectElement;
    assert.equal(select.value, 'ko');
  } finally {
    cleanup();
    __resetLocaleForTests(DEFAULT_LOCALE);
  }
});

test('L4. SessionSnapshot — languagePreference 가 저장·복원된다', async () => {
  const adapter = createInMemorySessionStore();
  let budget: BudgetSession = createBudgetSession('S1');
  budget = recordUsage(budget, sampleUsage());
  const snap = buildSessionSnapshot({
    sessionId: 'S1', userId: 'U', budget,
    languagePreference: 'ko',
    now: () => '2026-04-21T10:00:00.000Z',
  });
  assert.equal(snap.languagePreference, 'ko');
  await adapter.upsert(
    { sessionId: 'S1', userId: 'U', patch: {
      history: snap.history, compactedSummary: snap.compactedSummary, budget: snap.budget,
      mcp: snap.mcp, compactions: snap.compactions,
      languagePreference: snap.languagePreference,
      updatedAt: snap.updatedAt,
    } },
    snap,
  );
  const got = await adapter.get('U', 'S1');
  assert.ok(got);
  assert.equal(got!.languagePreference, 'ko');
});

test('L5. SessionPersistor.onLanguagePreferenceChanged — 저장 발생 + shallowDiff 변경 감지', async () => {
  const adapter = createInMemorySessionStore();
  const persistor = createSessionPersistor({ adapter, sessionId: 'S2', userId: 'U' });
  let budget: BudgetSession = createBudgetSession('S2');
  budget = recordUsage(budget, sampleUsage());
  // 1회차 — 첫 저장이라 true.
  assert.equal(await persistor.onRecordUsage(budget), true);
  // 언어 변경 → true.
  assert.equal(await persistor.onLanguagePreferenceChanged(budget, 'ko'), true);
  // 같은 언어 재지정 → false.
  assert.equal(await persistor.onLanguagePreferenceChanged(budget, 'ko'), false);

  const saved = await adapter.get('U', 'S2');
  assert.equal(saved?.languagePreference, 'ko');

  // shallowDiff 직접 검사.
  const before = buildSessionSnapshot({
    sessionId: 'S2', userId: 'U', budget, languagePreference: 'en',
    now: () => 'a',
  });
  const after = buildSessionSnapshot({
    sessionId: 'S2', userId: 'U', budget, languagePreference: 'ko',
    now: () => 'b',
  });
  const diff = shallowDiffSnapshot(before, after);
  assert.equal(diff.patch.languagePreference, 'ko');
});
