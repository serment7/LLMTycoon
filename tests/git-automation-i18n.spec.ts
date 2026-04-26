// 실행: npx tsx --test tests/git-automation-i18n.spec.ts
//
// 지시 #05a74e43 (Developer/베타) · Git 자동화 파이프라인 언어 토글 회귀 가드.
//
// 배경
//   `src/components/GitAutomationFailureNotice.tsx` 가 `gitAutomation.failure.*`
//   네임스페이스 12개 키만 소비한다. 자동화 실패 시 사용자 시선이 가장 먼저 닿는
//   표면이지만, 토글 후에도 라벨이 영어로 갈리지 않거나 한쪽 사전에서 키가
//   누락되는 회귀(빈 stderr fallback 안내가 'gitAutomation.failure.fallbackMessage'
//   원문으로 노출되는 류) 를 막는 단일 진단 스펙은 없었다. 본 스펙은
//   GitAutomationFailureNotice 의 모든 라벨/버튼(닫기) 와 두 추정(stderr 비어 있음
//   안내·spawn 실패 안내) 토스트 라인을 EN↔KO 토글 전·후로 검증한다.
//
// 검증 축
//   G1. EN 토글 — 패널 라벨/버튼/추정 라인 전부 영문 사전(gitAutomation.failure.*)
//        과 정확히 일치.
//   G2. EN→KO 토글 — 같은 패널이 KO 사전으로 즉시 복원, KO 텍스트는 영문과 모두 다름.
//   G3. 키 누락 검출 — `gitAutomation.*` leaf 경로가 src/i18n/{en,ko}.json 과
//        locales/{en,ko}.json 모두에서 동일 집합. 컴포넌트가 참조하는 12개 키 각각이
//        EN/KO 양쪽 사전에 비어 있지 않은 문자열로 존재.

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
  type Locale,
} from '../src/i18n/index.ts';
import { LanguageToggle } from '../src/ui/LanguageToggle.tsx';
import {
  GitAutomationFailureNotice,
  buildFailureLinesForLocale,
} from '../src/components/GitAutomationFailureNotice.tsx';
import type { GitAutomationStepResult } from '../src/utils/gitAutomation.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

// ────────────────────────────────────────────────────────────────────────────
// 공용 유틸 — 사전 leaf 수집, 화면 라인 수집, 월드 리셋
// ────────────────────────────────────────────────────────────────────────────

type LocaleTree = { [k: string]: string | LocaleTree };

function readLocaleJson(rel: string): LocaleTree {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as LocaleTree;
}

function collectLeafPaths(tree: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!tree || typeof tree !== 'object') return out;
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(path, v);
    else if (v && typeof v === 'object') {
      for (const [p, val] of collectLeafPaths(v, path)) out.set(p, val);
    }
  }
  return out;
}

function gitKeysOf(tree: LocaleTree): Set<string> {
  const out = new Set<string>();
  for (const k of collectLeafPaths(tree).keys()) {
    if (k === 'gitAutomation' || k.startsWith('gitAutomation.')) out.add(k);
  }
  return out;
}

function resetWorld(): void {
  try { window.localStorage.clear(); } catch { /* jsdom 에서는 발생하지 않음 */ }
  __resetLocaleForTests(DEFAULT_LOCALE);
}

// ────────────────────────────────────────────────────────────────────────────
// 패널 마운트 — 헤더 LanguageToggle + 실패 알림(spawn 실패 + 빈 stderr 케이스)
//
// 빈 stderr + code===null 조합은 `buildFailureLines` 의 모든 추정 안내 라인
// (noStderr / emptyStderrFallback / spawnFailure) 를 한 번에 생성해 라벨 표면을
// 최대한 넓게 노출한다 — 토글 전후의 변환 누락이 즉시 드러난다.
// ────────────────────────────────────────────────────────────────────────────

const SPAWN_FAILURE_FIXTURE: GitAutomationStepResult = {
  step: 'commit',
  label: 'commit',
  command: ['git', 'commit', '-m', 'auto'],
  cwd: '/tmp/repo',
  durationMs: 0,
  stdout: '',
  stderr: '',
  code: null,
  ok: false,
};

function PanelHarness(): React.ReactElement {
  return React.createElement(
    'div',
    { 'data-testid': 'git-i18n-root' },
    React.createElement(
      'header',
      { 'data-testid': 'git-i18n-header' },
      React.createElement(LanguageToggle),
    ),
    React.createElement(
      'section',
      { 'data-testid': 'git-i18n-panel' },
      React.createElement(GitAutomationFailureNotice, {
        failure: SPAWN_FAILURE_FIXTURE,
        branch: 'feat/auto-commit-i18n',
        onDismiss: () => undefined,
      }),
    ),
  );
}

function clickToggle(code: 'en' | 'ko'): void {
  const header = document.querySelector('[data-testid="git-i18n-header"]');
  const btn = header!.querySelector(`[data-testid="language-toggle-${code}"]`) as HTMLButtonElement;
  act(() => { fireEvent.click(btn); });
}

/** 패널의 모든 가시 라벨/값/버튼을 한 번에 수집. 토글 전후 표 비교에 쓴다. */
interface PanelSnapshot {
  title: string;
  /** label:value 쌍을 'label::value' 한 줄로 평탄화. */
  lines: string[];
  dismissAria: string;
}

function snapshotPanel(): PanelSnapshot {
  const root = document.querySelector('[data-testid="git-i18n-panel"]')!;
  const title = root.querySelector('div.text-\\[10px\\]')?.textContent?.trim() ?? '';
  const items = Array.from(root.querySelectorAll('li'));
  const lines = items.map((li) => {
    const spans = li.querySelectorAll('span');
    const label = spans[0]?.textContent?.replace(/:\s*$/, '').trim() ?? '';
    const value = spans[1]?.textContent?.trim() ?? '';
    return `${label}::${value}`;
  });
  const dismissBtn = root.querySelector('button[aria-label]') as HTMLButtonElement | null;
  const dismissAria = dismissBtn?.getAttribute('aria-label') ?? '';
  return { title, lines, dismissAria };
}

// ────────────────────────────────────────────────────────────────────────────
// G1. EN 토글 — 모든 라벨/버튼/추정 라인이 영문 사전과 일치
// ────────────────────────────────────────────────────────────────────────────

test('G1. EN 토글 상태 — Git 자동화 실패 패널의 라벨/버튼/추정 라인이 모두 영문 사전과 일치', () => {
  resetWorld();
  try {
    render(
      React.createElement(I18nProvider, { initialLocale: 'en' },
        React.createElement(PanelHarness),
      ),
    );
    const snap = snapshotPanel();
    // 헤더 — 'Automation failed'
    assert.equal(snap.title, translate('gitAutomation.failure.title', 'en'));
    // 닫기 버튼 aria-label — 'Dismiss'
    assert.equal(snap.dismissAria, translate('gitAutomation.failure.dismiss', 'en'));
    // buildFailureLinesForLocale 로 같은 입력에 대한 기대 라벨/값 표를 생성하고 라인 비교.
    const expected = buildFailureLinesForLocale(
      { failure: SPAWN_FAILURE_FIXTURE, branch: 'feat/auto-commit-i18n' },
      'en',
    );
    const expectedLines = expected.map((l) => `${l.label}::${l.value}`);
    assert.deepEqual(snap.lines, expectedLines, '렌더된 라인이 EN 빌더 결과와 정확히 일치해야');
    // 핵심 키들이 영문 그대로 나오는지 명시 검증(영문 텍스트 유지 회귀 가드).
    const flat = snap.lines.join(' | ') + ' | ' + snap.title + ' | ' + snap.dismissAria;
    assert.ok(flat.includes(translate('gitAutomation.failure.step', 'en')));
    assert.ok(flat.includes(translate('gitAutomation.failure.exitCode', 'en')));
    assert.ok(flat.includes(translate('gitAutomation.failure.branch', 'en')));
    assert.ok(flat.includes(translate('gitAutomation.failure.stderrLabel', 'en')));
    assert.ok(flat.includes(translate('gitAutomation.failure.noStderr', 'en')));
    assert.ok(flat.includes(translate('gitAutomation.failure.emptyStderrFallback', 'en')));
    assert.ok(flat.includes(translate('gitAutomation.failure.spawnFailure', 'en')));
  } finally {
    cleanup();
    resetWorld();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// G2. EN→KO 토글 — 같은 패널이 한국어 사전으로 즉시 복원
// ────────────────────────────────────────────────────────────────────────────

test('G2. EN→KO 토글 — 같은 실패 패널이 한국어 사전으로 복원되고, EN 텍스트는 단 한 줄도 잔류하지 않는다', () => {
  resetWorld();
  try {
    render(
      React.createElement(I18nProvider, { initialLocale: 'en' },
        React.createElement(PanelHarness),
      ),
    );
    const enSnap = snapshotPanel();
    clickToggle('ko');
    const koSnap = snapshotPanel();

    // 헤더/버튼 KO 사전 일치
    assert.equal(koSnap.title, translate('gitAutomation.failure.title', 'ko'));
    assert.equal(koSnap.dismissAria, translate('gitAutomation.failure.dismiss', 'ko'));

    // 라인 표 — KO 빌더 결과와 정확히 일치(이전 EN 표와 한 줄도 같지 않아야).
    const expectedKo = buildFailureLinesForLocale(
      { failure: SPAWN_FAILURE_FIXTURE, branch: 'feat/auto-commit-i18n' },
      'ko',
    );
    const expectedKoLines = expectedKo.map((l) => `${l.label}::${l.value}`);
    assert.deepEqual(koSnap.lines, expectedKoLines);

    // 라인 단위로 EN 잔류가 없음 — 한 줄이라도 EN 사전 그대로 남아 있으면 회귀.
    for (let i = 0; i < koSnap.lines.length; i += 1) {
      assert.notEqual(
        koSnap.lines[i],
        enSnap.lines[i],
        `라인 ${i} 가 토글 후에도 EN 그대로: ${koSnap.lines[i]}`,
      );
    }
    assert.notEqual(koSnap.title, enSnap.title);
    assert.notEqual(koSnap.dismissAria, enSnap.dismissAria);

    // KO 한 글자 이상이 한글 음절(가~힣) 인지 — 영문 잔존 회귀 차단.
    const HANGUL = /[가-힣]/;
    assert.ok(HANGUL.test(koSnap.title), `KO 헤더에 한글 음절 없음: ${koSnap.title}`);
    assert.ok(HANGUL.test(koSnap.dismissAria), `KO 닫기 라벨에 한글 음절 없음: ${koSnap.dismissAria}`);
  } finally {
    cleanup();
    resetWorld();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// G3. 누락 키 검출 — gitAutomation.* 네임스페이스의 모든 키가 EN/KO 양쪽에 존재
// ────────────────────────────────────────────────────────────────────────────

const SOURCES: Array<{ rel: string; lang: Locale }> = [
  { rel: 'src/i18n/en.json', lang: 'en' },
  { rel: 'src/i18n/ko.json', lang: 'ko' },
  { rel: 'locales/en.json',  lang: 'en' },
  { rel: 'locales/ko.json',  lang: 'ko' },
];

test('G3-1. 각 정본 파일 안에서 EN/KO 좌우 gitAutomation.* leaf 경로가 동일(누락 키 0)', () => {
  // 본 spec 의 범위는 "한 사전 묶음 안에서 ko/en 좌우 패리티". 두 정본 사본 사이의
  // 동기 드리프트(`locales/*` ↔ `src/i18n/*`) 는 `tests/i18n/sourceParity.spec.ts` 가
  // 별도로 책임진다 — 본 spec 까지 그 영역을 잠그면 한 회귀가 두 곳에서 동시에
  // 실패해 진단 신호가 흐려진다.
  const PAIRS: Array<{ label: string; en: string; ko: string }> = [
    { label: 'src/i18n', en: 'src/i18n/en.json', ko: 'src/i18n/ko.json' },
    { label: 'locales',  en: 'locales/en.json',  ko: 'locales/ko.json' },
  ];
  for (const { label, en, ko } of PAIRS) {
    const enKeys = gitKeysOf(readLocaleJson(en));
    const koKeys = gitKeysOf(readLocaleJson(ko));
    const onlyInEn: string[] = [];
    const onlyInKo: string[] = [];
    for (const k of enKeys) if (!koKeys.has(k)) onlyInEn.push(k);
    for (const k of koKeys) if (!enKeys.has(k)) onlyInKo.push(k);
    assert.equal(
      onlyInEn.length + onlyInKo.length,
      0,
      `\n[${label} 사전 EN↔KO gitAutomation 패리티 드리프트]\n` +
        (onlyInEn.length > 0 ? `  ko 에 없음: ` + onlyInEn.join(', ') + '\n' : '') +
        (onlyInKo.length > 0 ? `  en 에 없음: ` + onlyInKo.join(', ') : ''),
    );
    assert.ok(enKeys.size > 0, `${label} 의 gitAutomation 네임스페이스가 비어 있음`);
  }
});

test('G3-2. GitAutomationFailureNotice 가 참조하는 12개 키 각각이 EN/KO 양쪽 사전에 비어 있지 않은 문자열로 존재', () => {
  const REQUIRED_KEYS = [
    'gitAutomation.failure.title',
    'gitAutomation.failure.step',
    'gitAutomation.failure.exitCode',
    'gitAutomation.failure.branch',
    'gitAutomation.failure.stderrLabel',
    'gitAutomation.failure.stdoutLabel',
    'gitAutomation.failure.noStderr',
    'gitAutomation.failure.emptyStderrFallback',
    'gitAutomation.failure.spawnFailure',
    'gitAutomation.failure.dismiss',
    'gitAutomation.failure.fallbackMessage',
  ] as const;
  const missing: string[] = [];
  const empty: string[] = [];
  for (const { rel, lang } of SOURCES) {
    const leaves = collectLeafPaths(readLocaleJson(rel));
    for (const k of REQUIRED_KEYS) {
      const v = leaves.get(k);
      if (typeof v !== 'string') {
        missing.push(`${rel}::${k}`);
      } else if (v.trim().length === 0) {
        empty.push(`${rel}::${k}`);
      } else {
        // 추가로 translate() 도 키 원문이 아닌 실제 번역을 돌려주는지 검증 — 모듈
        // import 경로가 다른 파일을 가리키게 되는 회귀 차단.
        const fromRuntime = translate(k, lang);
        assert.notEqual(fromRuntime, k, `runtime translate(${k}, ${lang}) 가 키 원문을 그대로 반환`);
      }
    }
  }
  assert.equal(
    missing.length + empty.length,
    0,
    '\n[필수 gitAutomation 키 누락/빈 값]\n' +
      (missing.length > 0 ? '  누락:\n' + missing.map((m) => '    - ' + m).join('\n') + '\n' : '') +
      (empty.length > 0 ? '  빈 문자열:\n' + empty.map((m) => '    - ' + m).join('\n') : ''),
  );
});

/**
 * 의도적으로 EN==KO 로 둔 시스템 토큰 화이트리스트.
 *   - 로그 포맷: 자릿수·괄호 위치를 grep 친화적으로 고정해야 함.
 *   - 약어 + URL/식별자 prefix: "PR" 같은 영문 약어 + placeholder 만으로 구성.
 *   - 구분자 suffix: " · {branch}" 같은 구두점 + placeholder.
 * 신규 EN==KO 항목이 늘면 본 화이트리스트를 의식적으로 갱신해야 통과한다 —
 * 즉 "ko 사전에 영문이 그대로 복붙된" 류 회귀는 여전히 빨간 신호로 잡힌다.
 */
const INTENTIONAL_SAME_VALUE_KEYS = new Set<string>([
  'gitAutomation.logs.stepError',
  'gitAutomation.tooltip.prPrefix',
  'gitAutomation.panelLog.branchSuffix',
]);

test('G3-3. EN/KO 양쪽 gitAutomation.* 값이 서로 다른 문자열(번역 누락 차단)', () => {
  // placeholder-only 템플릿(예: "[{label}] exit={code}") 은 텍스트 단어가 없어
  // 한글 번역이 의미 없으므로 대상에서 면제한다 — 자연어 단어가 1자 이상(영문
  // 알파벳 또는 한글 음절) 들어 있는 leaf 만 비교한다. 또한 의도적 동일 항목
  // (INTENTIONAL_SAME_VALUE_KEYS) 도 면제하되, 화이트리스트 등록 자체로 회귀
  // 가시성은 유지된다.
  const HAS_NATURAL_LANGUAGE = /[A-Za-z가-힣]/;
  const en = collectLeafPaths(readLocaleJson('src/i18n/en.json'));
  const ko = collectLeafPaths(readLocaleJson('src/i18n/ko.json'));
  const sameAsEn: string[] = [];
  for (const [k, v] of en) {
    if (!(k === 'gitAutomation' || k.startsWith('gitAutomation.'))) continue;
    if (INTENTIONAL_SAME_VALUE_KEYS.has(k)) continue;
    if (!HAS_NATURAL_LANGUAGE.test(v)) continue;
    if (ko.get(k) === v) sameAsEn.push(`${k} = "${v}"`);
  }
  assert.equal(
    sameAsEn.length,
    0,
    '\n[gitAutomation EN==KO 동일 — 한글 번역 누락]\n' +
      sameAsEn.map((s) => '  - ' + s).join('\n') +
      '\n(의도적 동일이라면 INTENTIONAL_SAME_VALUE_KEYS 에 명시적으로 추가)',
  );
});
