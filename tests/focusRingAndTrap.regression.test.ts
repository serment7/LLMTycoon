// Run with: npx tsx --test tests/focusRingAndTrap.regression.test.ts
//
// 회귀 테스트: 키보드 접근성·포커스 관리 정비.
// 시각 가이드: docs/focus-ring-visual-2026-04-19.md §2~§3.
//
// 잠그는 계약 6가지:
//   1. src/index.css 에 --focus-ring-* 토큰이 선도입되어 있다(기본/on-light/danger/
//      success/caution 5종 색 + offset/width/radius/halo/transition).
//   2. index.css 글로벌 :focus-visible 규칙이 존재해 button·input·textarea·select·
//      [role="button"|"tab"|"radio"|"checkbox"|"switch"]·[tabindex] 를 포괄한다.
//   3. data-focus-tone="danger|success|caution" variant 선택자가 정의돼 있다.
//   4. prefers-reduced-motion:reduce 미디어 쿼리에서 focus-visible transition 이 제거된다.
//   5. SharedGoalModal.tsx 가 dialogRef + handleDialogKeyDown (Tab 순환) + lastFocusRef
//      복원 3요소를 갖는다(시안 §4.1 포커스 트랩 규약).
//   6. SharedGoalModal primary 확정 버튼에 data-focus-tone="success" 가 부여돼 있다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_CSS_PATH = resolve(__dirname, '..', 'src', 'index.css');
const MODAL_PATH = resolve(__dirname, '..', 'src', 'components', 'SharedGoalModal.tsx');

test('--focus-ring-* 토큰이 선도입되어 있다 (색 5종 + 규격 4종)', () => {
  const src = readFileSync(INDEX_CSS_PATH, 'utf8');
  for (const tok of [
    '--focus-ring-color:',
    '--focus-ring-color-on-light:',
    '--focus-ring-color-danger:',
    '--focus-ring-color-success:',
    '--focus-ring-color-caution:',
    '--focus-ring-offset:',
    '--focus-ring-offset-color:',
    '--focus-ring-width:',
    '--focus-ring-width-thick:',
    '--focus-ring-halo-danger:',
    '--focus-ring-transition:',
  ]) {
    assert.match(src, new RegExp(tok.replace(/[-:]/g, (m) => ({ '-': '\\-', ':': ':' }[m]!))),
      `index.css 에 ${tok} 토큰이 필요하다`);
  }
});

test('글로벌 :focus-visible 규칙이 주요 인터랙티브 셀렉터를 포괄한다', () => {
  const src = readFileSync(INDEX_CSS_PATH, 'utf8');
  // 단일 규칙 블록 안에 button/input/textarea/select/[role="button"|"tab"|"radio"]/[tabindex]
  // 셀렉터가 함께 나오는지 확인한다(컴포넌트별 :focus-visible 은 위 셀렉터 공통 집합에
  // 속하지 않으므로 같은 블록 안에 모두 나와야 "글로벌 안전망" 이다).
  const blockMatch = src.match(/button:focus-visible[\s\S]{0,900}?\}/);
  assert.ok(blockMatch, '글로벌 :focus-visible 규칙 블록을 찾을 수 없다');
  const block = blockMatch[0];
  for (const sel of [
    'button:focus-visible',
    'input:focus-visible',
    'textarea:focus-visible',
    'select:focus-visible',
    '[role="button"]:focus-visible',
    '[role="tab"]:focus-visible',
    '[role="radio"]:focus-visible',
    '[tabindex]:not([tabindex="-1"]):focus-visible',
  ]) {
    assert.ok(block.includes(sel), `글로벌 블록에 ${sel} 셀렉터가 포함되어야 한다`);
  }
  assert.match(block, /var\(--focus-ring-color\)/, '토큰 --focus-ring-color 를 사용해야 한다');
  assert.match(block, /var\(--focus-ring-offset\)/, '토큰 --focus-ring-offset 을 사용해야 한다');
  assert.match(block, /var\(--focus-ring-transition\)/, '토큰 --focus-ring-transition 을 사용해야 한다');
});

test('data-focus-tone variant 선택자가 선언돼 있다 (danger/success/caution)', () => {
  const src = readFileSync(INDEX_CSS_PATH, 'utf8');
  assert.match(src, /\[data-focus-tone="danger"\]:focus-visible\s*\{/,
    'danger variant 규칙이 필요하다');
  assert.match(src, /\[data-focus-tone="success"\]:focus-visible\s*\{/,
    'success variant 규칙이 필요하다');
  assert.match(src, /\[data-focus-tone="caution"\]:focus-visible\s*\{/,
    'caution variant 규칙이 필요하다');
  assert.match(src, /var\(--focus-ring-color-danger\)/, 'danger variant 는 해당 색 토큰을 사용해야 한다');
  assert.match(src, /var\(--focus-ring-halo-danger\)/, 'danger variant 는 halo 를 추가로 표현해야 한다');
});

test('prefers-reduced-motion:reduce 에서 focus-visible transition 이 제거된다', () => {
  const src = readFileSync(INDEX_CSS_PATH, 'utf8');
  assert.match(src, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?:focus-visible[\s\S]*?transition:\s*none/,
    'prefers-reduced-motion:reduce 미디어 쿼리에서 focus-visible transition: none 이 적용되어야 한다');
});

test('SharedGoalModal 은 dialogRef + handleDialogKeyDown + lastFocusRef 3요소를 갖는다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(src, /const\s+dialogRef\s*=\s*useRef<HTMLDivElement>/,
    'dialogRef 가 선언되어야 한다(포커스 트랩 DOM 경계)');
  assert.match(src, /const\s+lastFocusRef\s*=\s*useRef<HTMLElement\s*\|\s*null>/,
    'lastFocusRef 가 선언되어야 한다(이전 포커스 복원)');
  assert.match(src, /const\s+handleDialogKeyDown\s*=/,
    'handleDialogKeyDown 핸들러가 선언되어야 한다');
  assert.match(src, /onKeyDown=\{handleDialogKeyDown\}/,
    'dialog 요소에 handleDialogKeyDown 이 연결되어야 한다');
  assert.match(src, /lastFocusRef\.current\?\.focus\(\)|lastFocusRef\.current\.focus\(\)/,
    '닫힘 시 lastFocusRef.current.focus() 로 이전 포커스를 복원해야 한다');
});

test('SharedGoalModal primary 확정 버튼은 data-focus-tone="success" 를 갖는다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  // 확정 버튼 근처 창에 두 속성이 같이 있어야 한다.
  const idx = src.indexOf('data-testid="shared-goal-modal-confirm"');
  assert.ok(idx > -1, '확정 버튼이 존재해야 한다');
  const snippet = src.slice(Math.max(0, idx - 60), Math.min(src.length, idx + 200));
  assert.match(snippet, /data-focus-tone="success"/,
    '확정 버튼에 data-focus-tone="success" 가 부여되어야 한다(시안 §3.2 success 변이)');
});
