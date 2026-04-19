// Run with: npx tsx --test tests/bugBashDarkModeBinding.regression.test.ts
//
// QA 회귀(지시 #66a923a5) · 9회차 버그 배시 — BUG-BASH-1 다크 모드 CSS 바인딩.
//
// 배경: ThemeToggle 은 사용자가 "다크" 를 고르면 `<html data-theme="dark">` 를 찍는다.
// 그러나 본 시점에 `src/index.css` 에 `[data-theme="dark"]` 선택자가 **0건**,
// `@media (prefers-color-scheme: dark)` 도 **0건** — 라이트 전용
// `prefers-color-scheme: light` 블록 1건만 존재. 사용자 입장에서는 "다크 모드 버튼을
// 눌러도 UI 가 안 바뀐다" 는 회귀로 관찰된다.
//
// 본 파일은 현재 결함을 **test.skip 된 "수정 후" 계약** 으로 선 등록해 두어, 디자이너
// 토큰 바인딩 + Joker CSS 배선 수정 PR 에서 skip → test 로 전환하면 곧바로 잠금이
// 발효되도록 한다. 동시에 ThemeToggle 이 DOM 에 data-theme 을 찍는 공개 계약은
// 통과 테스트로 유지해 회귀 방지.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_CSS = readFileSync(resolve(__dirname, '..', 'src', 'index.css'), 'utf8');
const THEME_TOGGLE = readFileSync(resolve(__dirname, '..', 'src', 'components', 'ThemeToggle.tsx'), 'utf8');

// ─── 현재 사실 ─────────────────────────────────────────────────────────────

test('BUG-BASH-1 · ThemeToggle 이 DOM 에 data-theme 속성을 찍는다(수정과 무관 · 상시 유지)', () => {
  assert.match(THEME_TOGGLE, /data-theme/);
  assert.match(THEME_TOGGLE, /setAttribute\(\s*['"]data-theme['"]\s*,\s*decision\.value\)/);
  assert.match(THEME_TOGGLE, /removeAttribute\(\s*['"]data-theme['"]\s*\)/);
});

test('BUG-BASH-1 · 현재는 `[data-theme="dark"]` CSS 선택자가 index.css 에 존재하지 않음을 기록한다', () => {
  // 본 상태를 명시적으로 잠가 두면, 수정 PR 에서 이 테스트가 자동으로 깨져
  // 리뷰어에게 "다크 바인딩 추가" 사실을 신호한다.
  const hasDarkSelector = /\[data-theme="dark"\]/.test(INDEX_CSS);
  const hasDarkMedia = /@media \(prefers-color-scheme:\s*dark\)/.test(INDEX_CSS);
  assert.equal(
    hasDarkSelector || hasDarkMedia,
    false,
    `현재 시점 기록: 다크 CSS 바인딩이 추가되면 본 테스트가 실패해 리뷰를 강제한다(수정 시 테스트 자체를 삭제 또는 아래 pass 버전으로 교체).`,
  );
});

// ─── 수정 후 계약(skip) ──────────────────────────────────────────────────────

test.skip('BUG-BASH-1 · 수정 후: `[data-theme="dark"]` 블록이 주요 팔레트 토큰을 오버라이드한다', () => {
  // 기대 최소 구조:
  //   [data-theme="dark"] {
  //     --pixel-bg: …;
  //     --pixel-card: …;
  //     --pixel-border: …;
  //     --shared-goal-modal-header-fg: …;
  //     --toast-*-bg: …;
  //   }
  assert.match(INDEX_CSS, /\[data-theme="dark"\]\s*\{[\s\S]{0,600}--pixel-bg\s*:/,
    '다크 배경 토큰 바인딩 누락 — 배경색이 라이트 그대로 남는다');
  assert.match(INDEX_CSS, /\[data-theme="dark"\][\s\S]{0,600}--pixel-card\s*:/,
    '다크 카드 배경 누락 — 사이드바·패널 대비 깨짐');
  assert.match(INDEX_CSS, /\[data-theme="dark"\][\s\S]{0,1200}--toast-(info|warning|error|success)-bg/,
    '다크 모드에서 토스트 팔레트 오버라이드가 없으면 AA 대비 달성 불가');
});

test.skip('BUG-BASH-1 · 수정 후: @media (prefers-color-scheme: dark) 폴백이 system 선택 시에도 적용된다', () => {
  assert.match(INDEX_CSS, /@media \(prefers-color-scheme:\s*dark\)\s*\{[\s\S]{0,400}:root\s*\{/,
    "'system' 모드 사용자가 OS 다크를 쓰는 경우에도 팔레트가 자동 반영되어야 한다");
});

// ─── FOUC 방지 계약(skip · 후속 권고) ───────────────────────────────────────

test.skip('BUG-BASH-1 · 수정 후: index.html 또는 SSR 훅에서 data-theme 을 1프레임 전 선주입해 FOUC 제거', () => {
  // `src/main.tsx` 또는 `index.html` 에 아래와 같은 블로킹 스크립트가 있어야
  // 초기 페인트에서 라이트 → 다크 깜빡임이 사라진다.
  //
  //   <script>(function(){ var p = localStorage.getItem('llmtycoon.theme');
  //     if (p === 'dark') document.documentElement.dataset.theme = 'dark';
  //     else if (p === 'light') document.documentElement.dataset.theme = 'light';
  //   })();</script>
  //
  // 본 테스트는 index.html 에 해당 스니펫이 들어왔을 때만 통과한다.
  const indexHtml = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
  assert.match(indexHtml, /llmtycoon\.theme[\s\S]{0,200}data-theme/,
    'FOUC 방지 스니펫이 index.html 에 없으면 첫 프레임 라이트 → 다크 깜빡임이 남는다');
});
