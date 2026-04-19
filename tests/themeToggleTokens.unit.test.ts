// Run with: npx tsx --test tests/themeToggleTokens.unit.test.ts
//
// 통합 디자인 토큰·테마 전환 단위 테스트(#e7ba6da5).
//   1) parseThemePreference/resolveAppliedTheme — 저장값 해석 + 시스템 선호 결합 계약.
//   2) deriveThemeAttribute + applyThemeToDocument — DOM 속성 세팅/해제 시나리오.
//   3) tokens.css — 라이트/다크 페어와 prefers-reduced-motion 블록이 실제 파일에 있는지
//      소스 레벨 정규식 계약으로 회귀 잠금.
//
// React DOM 렌더 없이 순수 함수 + 파일 문자열 감사로 계약을 굳힌다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  deriveThemeAttribute,
  parseThemePreference,
  resolveAppliedTheme,
  type ThemePreference,
} from '../src/components/ThemeToggle.tsx';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1) 해석 — 저장값 + 시스템 선호 결합
// ---------------------------------------------------------------------------

test('parseThemePreference + resolveAppliedTheme — 저장값/시스템 결합 계약', () => {
  // 저장값 해석: 유효한 3값만 통과, 그 외는 'system'.
  assert.equal(parseThemePreference('light'), 'light');
  assert.equal(parseThemePreference('dark'), 'dark');
  assert.equal(parseThemePreference('system'), 'system');
  assert.equal(parseThemePreference(null), 'system');
  assert.equal(parseThemePreference(undefined), 'system');
  assert.equal(parseThemePreference('auto'), 'system', '미지 값은 system 으로 수렴');
  assert.equal(parseThemePreference(123), 'system', '비문자도 system 으로 폴백');

  // 결합: system 선호가 dark 라도 사용자가 light 를 고르면 light.
  assert.equal(resolveAppliedTheme({ preference: 'light', systemPrefersDark: true }), 'light');
  assert.equal(resolveAppliedTheme({ preference: 'dark', systemPrefersDark: false }), 'dark');
  // system → 시스템 선호를 따른다.
  assert.equal(resolveAppliedTheme({ preference: 'system', systemPrefersDark: true }), 'dark');
  assert.equal(resolveAppliedTheme({ preference: 'system', systemPrefersDark: false }), 'light');

  // 저장 키 상수가 요구 사양(llmtycoon.theme) 과 일치.
  assert.equal(THEME_STORAGE_KEY, 'llmtycoon.theme');
});

// ---------------------------------------------------------------------------
// 2) DOM 속성 파생 — system 은 removeAttribute, 그 외는 setAttribute
// ---------------------------------------------------------------------------

test('deriveThemeAttribute + applyThemeToDocument — system 은 remove, 나머지는 set', () => {
  const system = deriveThemeAttribute('system');
  assert.deepEqual(system, { action: 'remove' },
    'system 은 data-theme 속성을 제거해 CSS prefers-color-scheme 이 자연 반영되게 한다');

  assert.deepEqual(deriveThemeAttribute('light'), { action: 'set', value: 'light' });
  assert.deepEqual(deriveThemeAttribute('dark'), { action: 'set', value: 'dark' });

  // DOM 이 없는 Node 환경에서 side-effect 래퍼는 no-op — 예외를 던지지 말 것.
  assert.doesNotThrow(() => applyThemeToDocument('light'));
  assert.doesNotThrow(() => applyThemeToDocument('dark'));
  assert.doesNotThrow(() => applyThemeToDocument('system'));

  // 잘못된 preference 값도 함수가 안전하게 처리(타입으로 잡지만 런타임 방어 확인).
  assert.doesNotThrow(() => applyThemeToDocument('???' as unknown as ThemePreference));
});

// ---------------------------------------------------------------------------
// 3) tokens.css 회귀 — 라이트·다크 페어 + reduced-motion 블록 존재 여부
// ---------------------------------------------------------------------------

test('tokens.css · 라이트/다크 페어와 prefers-reduced-motion 블록이 정의되어 있다', () => {
  const css = readFileSync(resolve(__dirname, '..', 'src/styles/tokens.css'), 'utf8');

  // 공통 여백·모션 토큰.
  assert.match(css, /--space-md:\s*12px/, '여백 토큰이 빠지면 레이아웃이 해진다');
  assert.match(css, /--motion-ease-out:\s*cubic-bezier/, 'easing 토큰은 모션 감소 대응의 기준점');

  // 다크 기본 + 라이트 override 블록.
  assert.match(css, /:root\s*\{[\s\S]*--color-bg:/, '기본 다크 팔레트가 :root 에 정의되어야 한다');
  assert.match(css, /\[data-theme='light'\]\s*\{[\s\S]*--color-bg:/,
    '명시적 라이트 선택은 system 쿼리와 독립으로 덮어써야 한다');
  assert.match(css, /@media \(prefers-color-scheme:\s*light\)/,
    '시스템 선호 감지 쿼리가 없으면 system 모드가 동작하지 않는다');

  // 모션 감소 블록 — 사용자 선호를 존중.
  assert.match(
    css,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*--motion-duration-md:\s*0ms/,
    'reduced-motion 블록이 없으면 motion 선호를 따르지 못한다',
  );

  // 포커스 링 토큰 — WCAG 2.4.7.
  assert.match(css, /--color-focus-ring:/);
  assert.match(css, /--focus-ring-width:/);
});
