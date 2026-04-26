// Run with: npx tsx --test tests/i18n/multiScreenLanguageToggle.regression.test.tsx
//
// 지시 #f269b2dc — 헤더 LanguageToggle 클릭이 SettingsDrawer · SharedGoalForm ·
// TokenUsageSettingsPanel · LoginForm 의 화면 라벨까지 EN↔KO 로 "동시" 전환되는지
// 통합으로 잠근다. 기존 회귀 4종(loginForm.* / languageToggle.* / languageToggleFlow /
// languageToggleRegression) 이 각자 좁은 축만 잠그고 있어서, 토글이 한 화면에서만
// 적용되는 회귀(컨텍스트 전파 누락 · 모듈 단일 진실원 분기 등)를 잡지 못한다.
// 본 스펙은 (a) 다중 화면이 한 토글로 갈리는지, (b) 영속화 후 새로고침에도 살아
// 남는지, (c) 빠른 연속 클릭이 부분 갱신/누수/깜빡임을 만들지 않는지를 한 자리에
// 검증한다.
//
// 시나리오
//   M1. 디폴트 EN — 4개 화면 모두 영어 라벨로 첫 렌더.
//   M2. 헤더 KO 클릭 — 4개 화면 라벨이 한 번의 setLocale 으로 일제히 한국어 갱신.
//   M3. EN 원복 — 같은 4개 화면이 라운드트립 후 EN 사전과 정확히 일치.
//   M4. 영속화 — KO 클릭 후 localStorage 에 'ko' 저장 + 모듈 리셋 + detectLocale 복원.
//   M5. 연속 클릭 깜빡임/누수 — 12회 EN↔KO 빠른 토글 후 최종 상태가 일관(부분 갱신 0).

import 'global-jsdom/register';

import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup, fireEvent } from '@testing-library/react';

import {
  I18nProvider,
  __resetLocaleForTests,
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  detectLocale,
  getLocale,
  translate,
} from '../../src/i18n/index.ts';
import { LanguageToggle } from '../../src/ui/LanguageToggle.tsx';
import { LoginForm } from '../../src/components/LoginForm.tsx';
import { SettingsDrawer } from '../../src/components/SettingsDrawer.tsx';
import { SharedGoalForm } from '../../src/components/SharedGoalForm.tsx';
import { TokenUsageSettingsPanel } from '../../src/components/TokenUsageSettingsPanel.tsx';

// ────────────────────────────────────────────────────────────────────────────
// 통합 화면 — 헤더(LanguageToggle) + 4개 본문 컴포넌트를 동시에 마운트한다.
// 모두 useI18n 컨슈머이므로, 토글 한 번이면 4 화면 모두 재렌더되어야 한다.
// ────────────────────────────────────────────────────────────────────────────

function MultiScreenHarness(): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-testid': 'multi-screen-root' },
    // 헤더 — LanguageToggle 단일 컨트롤러.
    React.createElement(
      'header',
      { 'data-testid': 'harness-header' },
      React.createElement(LanguageToggle),
    ),
    // 본문 1 · 로그인 폼(온프레미스 모드 — 사용자명/비밀번호 라벨이 보인다).
    React.createElement(
      'section',
      { 'data-testid': 'screen-login' },
      React.createElement(LoginForm, {
        onPremise: true,
        provider: 'github',
        onSubmit: async () => undefined,
        onOAuth: () => undefined,
        onSwitchToSignup: () => undefined,
        error: null,
      }),
    ),
    // 본문 2 · 설정 드로어(open=true 로 강제 노출).
    React.createElement(
      'section',
      { 'data-testid': 'screen-settings' },
      React.createElement(SettingsDrawer, {
        open: true,
        onClose: () => undefined,
      }),
    ),
    // 본문 3 · 공동 목표(projectId=null — fetch 없이 헤더+empty state 만 렌더).
    React.createElement(
      'section',
      { 'data-testid': 'screen-shared-goal' },
      React.createElement(SharedGoalForm, {
        projectId: null,
        onLog: () => undefined,
      }),
    ),
    // 본문 4 · 토큰 사용량 임계 설정 패널.
    React.createElement(
      'section',
      { 'data-testid': 'screen-token-settings' },
      React.createElement(TokenUsageSettingsPanel, {
        initial: { caution: {}, warning: {} },
        onClose: () => undefined,
        onApply: () => undefined,
      }),
    ),
  );
}

/**
 * 4개 화면의 핵심 라벨을 한 번에 수집. 네 컴포넌트 모두 같은 토글에 반응해야 하므로
 * 표 형태의 비교로 "한 컴포넌트만 안 바뀌는" 회귀를 즉시 드러낸다.
 *
 * 키 선택 기준: 각 화면의 헤더(가장 위·가장 큰 라벨)와 보조 라벨 1개씩. 헤더가
 * 안 바뀌면 컴포넌트 자체가 재렌더 안 된 것이고, 보조 라벨까지 일치해야 useI18n
 * 가 자식 트리 깊은 곳까지 전파됐다는 증거가 된다.
 */
function snapshotScreens(): {
  loginTitle: string;
  loginUsername: string;
  loginPassword: string;
  loginSubmit: string;
  settingsTitle: string;
  settingsMotion: string;
  settingsShortcuts: string;
  sharedGoalTitle: string;
  sharedGoalNoProject: string;
  tokenSettingsTitle: string;
  tokenSettingsCaution: string;
  tokenSettingsWarning: string;
} {
  const text = (sel: string): string => {
    const el = document.querySelector(sel);
    return (el?.textContent ?? '').trim();
  };
  // 로그인 폼 — h1 와 라벨 텍스트를 직접 본다.
  // form 안쪽으로 한 번 더 좁혀서 카드 상단 LanguageToggle 의 'Language/언어' span 이
  // loginLabels[0] 을 가로채는 회귀(#75cac73a)를 차단한다.
  const loginRoot = document.querySelector('[data-testid="screen-login"]')!;
  const loginH1 = loginRoot.querySelector('h1')?.textContent?.trim() ?? '';
  const loginLabels = Array.from(loginRoot.querySelectorAll('form label > span'))
    .map((n) => n.textContent?.trim() ?? '')
    .filter((s) => s.length > 0);
  const loginButton = loginRoot.querySelector('button[type="submit"]')?.textContent?.trim() ?? '';
  // 설정 드로어 — h2 와 섹션 h3.
  const settingsRoot = document.querySelector('[data-testid="screen-settings"]')!;
  const settingsH2 = settingsRoot.querySelector('h2#settings-drawer-title')?.textContent?.trim() ?? '';
  const settingsHeadings = Array.from(settingsRoot.querySelectorAll('h3')).map(
    (n) => n.textContent?.trim() ?? '',
  );
  // 공동 목표 — h3 헤딩 + EmptyState 의 title.
  const sharedRoot = document.querySelector('[data-testid="screen-shared-goal"]')!;
  const sharedHeading = sharedRoot.querySelector('h3#shared-goal-heading')?.textContent?.trim() ?? '';
  const sharedEmptyTitle =
    sharedRoot.querySelector('[data-testid="shared-goal-form-no-project"]')?.textContent?.trim() ?? '';
  // 토큰 임계 설정 — title + 두 개 legend.
  const tokenRoot = document.querySelector('[data-testid="screen-token-settings"]')!;
  // title 은 첫 번째 span(이며 uppercase tracking 클래스). querySelector 로 첫 매치 사용.
  const tokenTitle = tokenRoot.querySelector('span.text-\\[10px\\].uppercase')?.textContent?.trim() ?? '';
  const tokenLegends = Array.from(tokenRoot.querySelectorAll('legend')).map(
    (n) => n.textContent?.trim() ?? '',
  );
  return {
    loginTitle: loginH1,
    loginUsername: loginLabels[0] ?? '',
    loginPassword: loginLabels[1] ?? '',
    loginSubmit: loginButton,
    settingsTitle: settingsH2,
    settingsMotion: settingsHeadings[0] ?? '',
    settingsShortcuts: settingsHeadings[settingsHeadings.length - 1] ?? '',
    sharedGoalTitle: sharedHeading,
    sharedGoalNoProject: sharedEmptyTitle,
    tokenSettingsTitle: tokenTitle,
    tokenSettingsCaution: tokenLegends[0] ?? '',
    tokenSettingsWarning: tokenLegends[1] ?? '',
  };
}

/** 헤더 LanguageToggle 의 EN/KO 버튼을 클릭한다. fireEvent 는 act 로 래핑. */
function clickToggle(code: 'en' | 'ko'): void {
  const header = document.querySelector('[data-testid="harness-header"]');
  const btn = header!.querySelector(`[data-testid="language-toggle-${code}"]`) as HTMLButtonElement;
  act(() => {
    fireEvent.click(btn);
  });
}

/** localStorage 클리어 — 매 테스트 직전 영속 상태 격리. */
function resetWorld(): void {
  try { window.localStorage.clear(); } catch { /* jsdom 에서는 발생하지 않음 */ }
  __resetLocaleForTests(DEFAULT_LOCALE);
}

// ────────────────────────────────────────────────────────────────────────────
// M1. 디폴트 EN — 4개 화면 모두 영어 라벨로 첫 렌더
// ────────────────────────────────────────────────────────────────────────────

test('M1. 디폴트 EN — LoginForm/SettingsDrawer/SharedGoalForm/TokenUsageSettingsPanel 가 모두 영어 라벨로 첫 렌더', () => {
  resetWorld();
  try {
    render(
      React.createElement(I18nProvider, { initialLocale: 'en' },
        React.createElement(MultiScreenHarness),
      ),
    );
    const snap = snapshotScreens();
    assert.equal(snap.loginTitle, translate('auth.login.title', 'en'));
    assert.equal(snap.loginUsername, translate('auth.login.username', 'en'));
    assert.equal(snap.loginPassword, translate('auth.login.password', 'en'));
    // submit 버튼은 placeholder 가 한 줄에 같이 들어오므로 startsWith 로 검증.
    assert.ok(
      snap.loginSubmit.includes(translate('auth.login.submit', 'en').replace(/^▶\s*/, '')),
      `로그인 submit 버튼이 EN 사전과 일치해야: actual=${snap.loginSubmit}`,
    );
    assert.equal(snap.settingsTitle, translate('settings.drawer.title', 'en'));
    assert.equal(snap.settingsMotion, translate('settings.drawer.motionSection', 'en'));
    assert.equal(snap.settingsShortcuts, translate('settings.drawer.shortcutsSection', 'en'));
    assert.equal(snap.sharedGoalTitle, translate('sharedGoal.title', 'en'));
    assert.ok(
      snap.sharedGoalNoProject.includes(translate('sharedGoal.noProjectTitle', 'en')),
      `공동 목표 EmptyState 제목이 EN 사전과 일치: actual=${snap.sharedGoalNoProject}`,
    );
    assert.equal(snap.tokenSettingsTitle, translate('tokenUsage.settings.title', 'en'));
    assert.equal(snap.tokenSettingsCaution, translate('tokenUsage.settings.cautionLegend', 'en'));
    assert.equal(snap.tokenSettingsWarning, translate('tokenUsage.settings.warningLegend', 'en'));
  } finally {
    cleanup();
    resetWorld();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// M2. 헤더 KO 클릭 — 4개 화면 라벨이 한 번의 setLocale 으로 일제히 한국어 갱신
// ────────────────────────────────────────────────────────────────────────────

test('M2. 헤더 KO 클릭 — LoginForm/SettingsDrawer/SharedGoalForm/TokenUsageSettingsPanel 라벨이 한꺼번에 KO 사전으로 전환', () => {
  resetWorld();
  try {
    render(
      React.createElement(I18nProvider, { initialLocale: 'en' },
        React.createElement(MultiScreenHarness),
      ),
    );
    // 사전 EN 스냅샷 확보 — 토글 후와 비교해 정말 갈렸는지 증명한다.
    const enSnap = snapshotScreens();

    clickToggle('ko');

    assert.equal(getLocale(), 'ko', '전역 locale 이 ko 로 갱신');
    const koSnap = snapshotScreens();
    // 화면 라벨 표 — KO 사전과 정확히 일치
    assert.equal(koSnap.loginTitle, translate('auth.login.title', 'ko'));
    assert.equal(koSnap.loginUsername, translate('auth.login.username', 'ko'));
    assert.equal(koSnap.loginPassword, translate('auth.login.password', 'ko'));
    assert.equal(koSnap.settingsTitle, translate('settings.drawer.title', 'ko'));
    assert.equal(koSnap.settingsMotion, translate('settings.drawer.motionSection', 'ko'));
    assert.equal(koSnap.settingsShortcuts, translate('settings.drawer.shortcutsSection', 'ko'));
    assert.equal(koSnap.sharedGoalTitle, translate('sharedGoal.title', 'ko'));
    assert.equal(koSnap.tokenSettingsTitle, translate('tokenUsage.settings.title', 'ko'));
    assert.equal(koSnap.tokenSettingsCaution, translate('tokenUsage.settings.cautionLegend', 'ko'));
    assert.equal(koSnap.tokenSettingsWarning, translate('tokenUsage.settings.warningLegend', 'ko'));
    // 4개 화면 모두 EN→KO 로 실제로 갈렸음을 회귀 가드(=한 컴포넌트만 안 바뀌는 회귀 차단).
    const screens: Array<keyof typeof enSnap> = [
      'loginTitle', 'loginUsername', 'loginPassword',
      'settingsTitle', 'settingsMotion', 'settingsShortcuts',
      'sharedGoalTitle',
      'tokenSettingsTitle', 'tokenSettingsCaution', 'tokenSettingsWarning',
    ];
    for (const k of screens) {
      assert.notEqual(enSnap[k], koSnap[k], `${k} 라벨이 토글 후에도 EN 그대로면 한 컴포넌트가 갱신 누락된 것`);
    }
  } finally {
    cleanup();
    resetWorld();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// M3. EN 원복 — 같은 4개 화면이 라운드트립 후 EN 사전과 정확히 일치
// ────────────────────────────────────────────────────────────────────────────

test('M3. EN→KO→EN 라운드트립 — 첫 EN 스냅샷과 마지막 EN 스냅샷이 모든 키에서 동일', () => {
  resetWorld();
  try {
    render(
      React.createElement(I18nProvider, { initialLocale: 'en' },
        React.createElement(MultiScreenHarness),
      ),
    );
    const firstEn = snapshotScreens();
    clickToggle('ko');
    assert.equal(getLocale(), 'ko');
    clickToggle('en');
    assert.equal(getLocale(), 'en');
    const lastEn = snapshotScreens();
    assert.deepEqual(lastEn, firstEn, '라운드트립 후 4개 화면 라벨이 첫 EN 스냅샷과 정확히 같아야');
  } finally {
    cleanup();
    resetWorld();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// M4. 영속화 — KO 클릭 후 localStorage 에 'ko' 저장 + 모듈 리셋 + detectLocale 복원
// ────────────────────────────────────────────────────────────────────────────

test('M4. KO 토글 → localStorage 저장 → 모듈 리셋(새로고침) → detectLocale 이 사용자 storage 에서 ko 복원', () => {
  resetWorld();
  try {
    render(
      React.createElement(I18nProvider, { initialLocale: 'en' },
        React.createElement(MultiScreenHarness),
      ),
    );
    clickToggle('ko');
    // (a) 영속화 — localStorage 에 ko 가 기록되어야.
    assert.equal(window.localStorage.getItem(LOCALE_STORAGE_KEY), 'ko', 'KO 클릭 후 localStorage 저장');

    // (b) "새로고침" — DOM/모듈 상태 초기화. localStorage 만 유지.
    cleanup();
    __resetLocaleForTests(DEFAULT_LOCALE);
    assert.equal(getLocale(), 'en', '리셋 직후 메모리는 디폴트로 비어 있다');

    // (c) detectLocale 이 storage 의 ko 를 복원 — 사용자별 영속 상태가 살아 있다.
    const restored = detectLocale({
      storage: window.localStorage,
      navigatorLanguage: 'en-US',
    });
    assert.equal(restored, 'ko');

    // (d) 새 마운트 — initialLocale 없이 detectLocale 결과로 부트스트랩되도록
    //     I18nProvider 의 동기 시드 경로를 우회해 직접 setLocale 후 마운트.
    //     (실서비스에선 부트 단계에서 detectLocale → I18nProvider initialLocale 주입.)
    render(
      React.createElement(I18nProvider, { initialLocale: 'ko' },
        React.createElement(MultiScreenHarness),
      ),
    );
    const snap = snapshotScreens();
    assert.equal(snap.loginTitle, translate('auth.login.title', 'ko'), '복원된 ko 로 첫 렌더');
    assert.equal(snap.settingsTitle, translate('settings.drawer.title', 'ko'));
    assert.equal(snap.sharedGoalTitle, translate('sharedGoal.title', 'ko'));
    assert.equal(snap.tokenSettingsTitle, translate('tokenUsage.settings.title', 'ko'));
  } finally {
    cleanup();
    resetWorld();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// M5. 연속 클릭 깜빡임/누수 — 12회 EN↔KO 빠른 토글 후 최종 상태 일관
// ────────────────────────────────────────────────────────────────────────────

test('M5. 12회 EN↔KO 연속 토글 — 최종 라벨이 단일 locale 로 수렴(부분 갱신/누수 0)', () => {
  resetWorld();
  try {
    render(
      React.createElement(I18nProvider, { initialLocale: 'en' },
        React.createElement(MultiScreenHarness),
      ),
    );
    // 12회 토글 — 짝수 번이라 최종은 EN. 라벨 일관성을 매 단계 가볍게 검사.
    const sequence: Array<'en' | 'ko'> = [];
    for (let i = 0; i < 6; i += 1) {
      sequence.push('ko', 'en');
    }
    let lastObserved: 'en' | 'ko' = 'en';
    for (const code of sequence) {
      clickToggle(code);
      lastObserved = code;
      // 매 클릭 직후, 4개 컴포넌트 라벨이 모두 현재 code 사전과 일치해야.
      const snap = snapshotScreens();
      assert.equal(snap.loginTitle, translate('auth.login.title', code), `i=${code} loginTitle`);
      assert.equal(snap.settingsTitle, translate('settings.drawer.title', code), `i=${code} settingsTitle`);
      assert.equal(snap.sharedGoalTitle, translate('sharedGoal.title', code), `i=${code} sharedGoalTitle`);
      assert.equal(snap.tokenSettingsTitle, translate('tokenUsage.settings.title', code), `i=${code} tokenSettingsTitle`);
    }
    assert.equal(getLocale(), lastObserved, '연속 토글 후에도 전역 locale 과 마지막 클릭이 동기');

    // 최종 상태(EN) 에 대한 표 비교 — 한 컴포넌트만 KO 가 잔류하면 즉시 실패.
    assert.equal(lastObserved, 'en');
    const finalSnap = snapshotScreens();
    assert.equal(finalSnap.loginUsername, translate('auth.login.username', 'en'));
    assert.equal(finalSnap.loginPassword, translate('auth.login.password', 'en'));
    assert.equal(finalSnap.settingsMotion, translate('settings.drawer.motionSection', 'en'));
    assert.equal(finalSnap.settingsShortcuts, translate('settings.drawer.shortcutsSection', 'en'));
    assert.equal(finalSnap.tokenSettingsCaution, translate('tokenUsage.settings.cautionLegend', 'en'));
    assert.equal(finalSnap.tokenSettingsWarning, translate('tokenUsage.settings.warningLegend', 'en'));

    // localStorage 도 최종 locale 로 정리되어야 — 중간 상태 누수 차단.
    assert.equal(window.localStorage.getItem(LOCALE_STORAGE_KEY), 'en');
  } finally {
    cleanup();
    resetWorld();
  }
});
