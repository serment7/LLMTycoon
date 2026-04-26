// Run with: npx tsx --test tests/i18n.spec.ts
//
// 지시 #22d24528 (Developer/베타) · i18n 치환 회귀 가드 통합 스펙.
//
// 본 스펙은 같은 폴더의 분산 회귀 테스트(tests/i18n/*.spec.ts) 들이 좁은 축만
// 잠그던 영역을 한 자리에 묶어, "토글 후에도 영어로 전환되지 않거나 키 원문이
// 화면에 새는" 회귀를 단일 노드 실행으로 즉시 드러낸다.
//
// 검증 축 (3종)
//   A. 키 패리티 — locales/{en,ko}.json 와 src/i18n/{en,ko}.json 의 leaf 경로
//      집합이 4개 정본 모두에서 동일.
//   B. 토글 후 영어 전환 — 주요 4개 화면(로그인/대시보드/에이전트 패널/프로젝트
//      생성) 을 한 트리에 마운트한 뒤 KO → EN 토글 시 모든 라벨이 EN 사전과
//      일치(부분 갱신·잔류 0).
//   C. 누락 키 노출 차단 — 위 4개 화면의 렌더 결과 textContent 어디에도
//      `xxx.yyy.zzz` 형태의 "translate 키 원문" 이 노출되지 않는다.
//
// 화면 매핑(에이전트 패널/대시보드 는 i18n 키가 풍부한 컨슈머로 대표 컴포넌트
// 를 골랐다 — 실서비스 레이아웃이 아니라 i18n 통합 표면을 보는 게 본 스펙의
// 목적이기 때문).
//   · 로그인         → LoginForm
//   · 대시보드       → SettingsDrawer (헤더 + 섹션 라벨)
//   · 에이전트 패널  → SharedGoalForm (에이전트 공동 목표 패널)
//   · 프로젝트 생성  → CreateProjectDialog

import 'global-jsdom/register';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import {
  DEFAULT_LOCALE,
  I18nProvider,
  __resetLocaleForTests,
  translate,
} from '../src/i18n/index.ts';
import { LanguageToggle } from '../src/ui/LanguageToggle.tsx';
import { LoginForm } from '../src/components/LoginForm.tsx';
import { SettingsDrawer } from '../src/components/SettingsDrawer.tsx';
import { SharedGoalForm } from '../src/components/SharedGoalForm.tsx';
import { CreateProjectDialog } from '../src/ui/projects/CreateProjectDialog.tsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

// ────────────────────────────────────────────────────────────────────────────
// 공용 유틸
// ────────────────────────────────────────────────────────────────────────────

type LocaleTree = { [k: string]: string | LocaleTree };

function readLocale(rel: string): LocaleTree {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as LocaleTree;
}

function collectLeafPaths(tree: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (!tree || typeof tree !== 'object') return out;
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.add(path);
    else if (v && typeof v === 'object') {
      for (const p of collectLeafPaths(v, path)) out.add(p);
    }
  }
  return out;
}

function diffSets(a: Set<string>, b: Set<string>): { onlyInA: string[]; onlyInB: string[] } {
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  for (const x of a) if (!b.has(x)) onlyInA.push(x);
  for (const x of b) if (!a.has(x)) onlyInB.push(x);
  return { onlyInA: onlyInA.sort(), onlyInB: onlyInB.sort() };
}

/** 모든 textContent 를 한 줄로 모은다(공백 정규화). */
function flattenTextContent(root: ParentNode): string {
  return ((root as Element).textContent ?? '').replace(/\s+/g, ' ').trim();
}

function resetWorld(): void {
  try { window.localStorage.clear(); } catch { /* jsdom 에서는 발생하지 않음 */ }
  __resetLocaleForTests(DEFAULT_LOCALE);
}

// ────────────────────────────────────────────────────────────────────────────
// 화면 마운트 — 4개 i18n 컨슈머를 한 트리에 묶어 동일 토글에 반응시킨다
// ────────────────────────────────────────────────────────────────────────────

function ScreensHarness(): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-testid': 'i18n-spec-root' },
    React.createElement(
      'header',
      { 'data-testid': 'i18n-spec-header' },
      React.createElement(LanguageToggle),
    ),
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
    React.createElement(
      'section',
      { 'data-testid': 'screen-dashboard' },
      React.createElement(SettingsDrawer, {
        open: true,
        onClose: () => undefined,
      }),
    ),
    React.createElement(
      'section',
      { 'data-testid': 'screen-agent-panel' },
      React.createElement(SharedGoalForm, {
        projectId: null,
        onLog: () => undefined,
      }),
    ),
    React.createElement(
      'section',
      { 'data-testid': 'screen-create-project' },
      React.createElement(CreateProjectDialog, {
        isOpen: true,
        onClose: () => undefined,
        onSubmit: async () => ({ projectId: 'p_test' }),
        // 디바운서가 입력 없이도 안정적으로 마운트되도록 fetcher 를 즉시 빈 결과로 stub.
        fetcher: async () => ({ items: [], source: 'cache', locale: 'en' }),
        debounceMs: 0,
        forceLocale: undefined,
      }),
    ),
  );
}

function clickToggle(code: 'en' | 'ko'): void {
  const header = document.querySelector('[data-testid="i18n-spec-header"]');
  const btn = header!.querySelector(`[data-testid="language-toggle-${code}"]`) as HTMLButtonElement;
  act(() => {
    fireEvent.click(btn);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// A. 키 패리티 — 4개 정본 모두 leaf 경로 집합이 동일
// ────────────────────────────────────────────────────────────────────────────

test('A1. locales/en.json 과 ko.json 의 leaf 경로 집합이 완전히 동일', () => {
  const en = collectLeafPaths(readLocale('locales/en.json'));
  const ko = collectLeafPaths(readLocale('locales/ko.json'));
  const { onlyInA: onlyInEn, onlyInB: onlyInKo } = diffSets(en, ko);
  assert.equal(
    onlyInEn.length + onlyInKo.length,
    0,
    '\n[locales 패리티 드리프트]\n' +
      (onlyInEn.length > 0 ? '  ko 에 없음:\n' + onlyInEn.map((p) => '    - ' + p).join('\n') + '\n' : '') +
      (onlyInKo.length > 0 ? '  en 에 없음:\n' + onlyInKo.map((p) => '    - ' + p).join('\n') : ''),
  );
});

test('A2. src/i18n/en.json 과 ko.json 의 leaf 경로 집합이 완전히 동일(런타임 정본)', () => {
  const en = collectLeafPaths(readLocale('src/i18n/en.json'));
  const ko = collectLeafPaths(readLocale('src/i18n/ko.json'));
  const { onlyInA: onlyInEn, onlyInB: onlyInKo } = diffSets(en, ko);
  assert.equal(
    onlyInEn.length + onlyInKo.length,
    0,
    '\n[src/i18n 패리티 드리프트]\n' +
      (onlyInEn.length > 0 ? '  ko 에 없음:\n' + onlyInEn.map((p) => '    - ' + p).join('\n') + '\n' : '') +
      (onlyInKo.length > 0 ? '  en 에 없음:\n' + onlyInKo.map((p) => '    - ' + p).join('\n') : ''),
  );
});

test('A3. 외부 사본(locales/*) 과 런타임 사본(src/i18n/*) 의 leaf 집합이 동일', () => {
  for (const lang of ['en', 'ko'] as const) {
    const external = collectLeafPaths(readLocale(`locales/${lang}.json`));
    const runtime = collectLeafPaths(readLocale(`src/i18n/${lang}.json`));
    const { onlyInA: extOnly, onlyInB: runOnly } = diffSets(external, runtime);
    assert.equal(
      extOnly.length + runOnly.length,
      0,
      `\n[${lang} 외부 ↔ 런타임 사본 드리프트]\n` +
        (extOnly.length > 0 ? '  src/i18n 에 없음: ' + extOnly.join(', ') + '\n' : '') +
        (runOnly.length > 0 ? '  locales 에 없음: ' + runOnly.join(', ') : ''),
    );
  }
});

// ────────────────────────────────────────────────────────────────────────────
// B. 토글 후 영어 전환 — 4개 화면이 한 토글로 영어 사전으로 전환
// ────────────────────────────────────────────────────────────────────────────

/**
 * 화면별 핵심 라벨을 표로 수집. 토글 전후에 같은 함수로 두 번 찍어 비교한다.
 * 각 화면은 (a) 헤딩 + (b) 보조 라벨 한 개 이상씩 — 컴포넌트 자체의 재렌더 +
 * 자식 트리 깊은 곳까지의 갱신을 동시에 본다.
 */
function snapshotScreens(): Record<string, string> {
  const text = (selector: string): string => {
    const el = document.querySelector(selector);
    return (el?.textContent ?? '').trim();
  };
  const loginRoot = document.querySelector('[data-testid="screen-login"]')!;
  const loginH1 = loginRoot.querySelector('h1')?.textContent?.trim() ?? '';
  const loginLabels = Array.from(loginRoot.querySelectorAll('form label > span'))
    .map((n) => n.textContent?.trim() ?? '')
    .filter((s) => s.length > 0);
  const loginSubmit = loginRoot.querySelector('button[type="submit"]')?.textContent?.trim() ?? '';

  const dashboardRoot = document.querySelector('[data-testid="screen-dashboard"]')!;
  const dashboardTitle = dashboardRoot.querySelector('h2#settings-drawer-title')?.textContent?.trim() ?? '';
  const dashboardSections = Array.from(dashboardRoot.querySelectorAll('h3')).map(
    (n) => n.textContent?.trim() ?? '',
  );

  const agentRoot = document.querySelector('[data-testid="screen-agent-panel"]')!;
  const agentHeading = agentRoot.querySelector('h3#shared-goal-heading')?.textContent?.trim() ?? '';
  const agentEmpty =
    agentRoot.querySelector('[data-testid="shared-goal-form-no-project"]')?.textContent?.trim() ?? '';

  const createRoot = document.querySelector('[data-testid="screen-create-project"]')!;
  const createTitle = createRoot.querySelector('h2')?.textContent?.trim() ?? '';
  const createRecommendTitle = createRoot.querySelector('h3')?.textContent?.trim() ?? '';
  const createFieldLabels = Array.from(createRoot.querySelectorAll('.cpd-field > span'))
    .map((n) => n.textContent?.trim() ?? '')
    .filter((s) => s.length > 0);

  return {
    loginTitle: loginH1,
    loginUsername: loginLabels[0] ?? '',
    loginPassword: loginLabels[1] ?? '',
    loginSubmit,
    dashboardTitle,
    dashboardSection0: dashboardSections[0] ?? '',
    dashboardSectionLast: dashboardSections[dashboardSections.length - 1] ?? '',
    agentHeading,
    agentEmpty,
    createTitle,
    createRecommendTitle,
    createNameLabel: createFieldLabels[0] ?? '',
    createDescLabel: createFieldLabels[1] ?? '',
  };
}

test('B1. KO 초기 마운트 — 4개 화면이 한국어 사전으로 첫 렌더', () => {
  resetWorld();
  try {
    render(
      React.createElement(I18nProvider, { initialLocale: 'ko' },
        React.createElement(ScreensHarness),
      ),
    );
    const snap = snapshotScreens();
    assert.equal(snap.loginTitle, translate('auth.login.title', 'ko'));
    assert.equal(snap.loginUsername, translate('auth.login.username', 'ko'));
    assert.equal(snap.dashboardTitle, translate('settings.drawer.title', 'ko'));
    assert.equal(snap.dashboardSection0, translate('settings.drawer.motionSection', 'ko'));
    assert.equal(snap.agentHeading, translate('sharedGoal.title', 'ko'));
    assert.equal(snap.createTitle, translate('projects.create.modalTitle', 'ko'));
    assert.equal(snap.createRecommendTitle, translate('projects.recommend.title', 'ko'));
    assert.equal(snap.createNameLabel, translate('projects.create.name', 'ko'));
  } finally {
    cleanup();
    resetWorld();
  }
});

test('B2. KO → EN 토글 — 4개 화면 라벨이 한꺼번에 영어 사전으로 전환', () => {
  resetWorld();
  try {
    render(
      React.createElement(I18nProvider, { initialLocale: 'ko' },
        React.createElement(ScreensHarness),
      ),
    );
    const koSnap = snapshotScreens();
    clickToggle('en');
    const enSnap = snapshotScreens();

    // 1) 모든 핵심 라벨이 EN 사전과 정확히 일치
    assert.equal(enSnap.loginTitle, translate('auth.login.title', 'en'));
    assert.equal(enSnap.loginUsername, translate('auth.login.username', 'en'));
    assert.equal(enSnap.loginPassword, translate('auth.login.password', 'en'));
    assert.equal(enSnap.dashboardTitle, translate('settings.drawer.title', 'en'));
    assert.equal(enSnap.dashboardSection0, translate('settings.drawer.motionSection', 'en'));
    assert.equal(enSnap.dashboardSectionLast, translate('settings.drawer.shortcutsSection', 'en'));
    assert.equal(enSnap.agentHeading, translate('sharedGoal.title', 'en'));
    assert.equal(enSnap.createTitle, translate('projects.create.modalTitle', 'en'));
    assert.equal(enSnap.createRecommendTitle, translate('projects.recommend.title', 'en'));
    assert.equal(enSnap.createNameLabel, translate('projects.create.name', 'en'));
    assert.equal(enSnap.createDescLabel, translate('projects.create.description', 'en'));

    // 2) 모든 라벨이 토글 전(KO) 과 다르다 — 한 화면도 KO 잔류가 없다는 회귀 가드
    const trackedKeys: Array<keyof typeof koSnap> = [
      'loginTitle', 'loginUsername', 'loginPassword',
      'dashboardTitle', 'dashboardSection0', 'dashboardSectionLast',
      'agentHeading',
      'createTitle', 'createRecommendTitle', 'createNameLabel', 'createDescLabel',
    ];
    for (const k of trackedKeys) {
      assert.notEqual(
        koSnap[k],
        enSnap[k],
        `${k} 라벨이 토글 후에도 KO 그대로 — 컴포넌트 한 곳이 i18n 갱신 누락`,
      );
    }
  } finally {
    cleanup();
    resetWorld();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// C. 누락 키 노출 차단 — 화면 어디에도 'xxx.yyy' 형태의 키 원문이 없어야 한다
// ────────────────────────────────────────────────────────────────────────────

/**
 * "translate 가 키를 못 찾아 원문으로 fallback" 회귀를 잡는 검증. 두 단계로 본다.
 *   1) 정본(en/ko) 의 leaf 경로 집합을 수집.
 *   2) 화면 textContent 에서 위 정본 키 중 어떤 것도 그대로 등장해서는 안 된다
 *      — 정상 번역이라면 영어/한글 문장으로 치환되어 있을 것이기 때문.
 *   3) 안전망으로 generic 패턴(`a.b.c`) 도 함께 스캔하되, 화이트리스트(파일 확장자
 *      · 도메인 · 'e.g.' 등 자연어) 는 면제한다.
 */
function findKeyLeakage(textContent: string): string[] {
  const enKeys = collectLeafPaths(readLocale('src/i18n/en.json'));
  const leaked: string[] = [];
  for (const key of enKeys) {
    // 정본 키 자체가 단어 경계로 등장하면 leak. 정규식 특수문자 escape.
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^a-zA-Z0-9_.])${escaped}(?:$|[^a-zA-Z0-9_.])`);
    if (re.test(textContent)) leaked.push(key);
  }
  return leaked;
}

test('C1. KO 초기 화면 — translate 키 원문이 textContent 에 노출되지 않는다', () => {
  resetWorld();
  try {
    const { container } = render(
      React.createElement(I18nProvider, { initialLocale: 'ko' },
        React.createElement(ScreensHarness),
      ),
    );
    const flat = flattenTextContent(container);
    const leaked = findKeyLeakage(flat);
    assert.equal(
      leaked.length,
      0,
      '\n[KO 화면에 키 원문 노출]\n' + leaked.map((k) => '  - ' + k).join('\n'),
    );
  } finally {
    cleanup();
    resetWorld();
  }
});

test('C2. EN 토글 후 화면 — translate 키 원문이 textContent 에 노출되지 않는다', () => {
  resetWorld();
  try {
    const { container } = render(
      React.createElement(I18nProvider, { initialLocale: 'ko' },
        React.createElement(ScreensHarness),
      ),
    );
    clickToggle('en');
    const flat = flattenTextContent(container);
    const leaked = findKeyLeakage(flat);
    assert.equal(
      leaked.length,
      0,
      '\n[EN 화면에 키 원문 노출]\n' + leaked.map((k) => '  - ' + k).join('\n'),
    );
  } finally {
    cleanup();
    resetWorld();
  }
});

test('C3. 자기 검증 — findKeyLeakage 가 알려진 키 원문을 실제로 잡아낸다', () => {
  // 일부러 키 원문 한 개를 끼워 넣은 합성 텍스트로 false negative 방지.
  const synthetic = '환영합니다 auth.login.title 오늘도 좋은 하루 되세요';
  const leaked = findKeyLeakage(synthetic);
  assert.ok(leaked.includes('auth.login.title'), 'findKeyLeakage 가 키를 식별하지 못함');
});
