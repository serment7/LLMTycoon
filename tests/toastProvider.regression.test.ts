// Run with: npx tsx --test tests/toastProvider.regression.test.ts
//
// 회귀 테스트: 공통 토스트/알림 컴포넌트 도입 (지시 #e4007b78, 2026-04-19).
// 시각 가이드: docs/toast-notification-visual-2026-04-19.md.
//
// 잠그는 계약 7가지:
//   1. src/components/ToastProvider.tsx 파일 존재 + named export (ToastProvider · useToast · 타입).
//   2. --toast-* 토큰을 토스트 구현부가 소비한다.
//   3. useToast 는 Provider 없이 호출돼도 no-op 을 돌려준다(점진적 도입 안전성).
//   4. push 는 중복 병합(같은 id)을 처리하는 분기를 갖는다 (T-09).
//   5. 동시 표시 최대 3개(MAX_VISIBLE) 로 큐잉한다 (T-08).
//   6. aria-live 가 variant 에 따라 polite/assertive 분기 (T-10).
//   7. SharedGoalModal 이 useToast 를 import 하고 성공/실패 경로에 토스트 트리거를 둔다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = resolve(__dirname, '..', 'src', 'components', 'ToastProvider.tsx');
const MODAL_PATH = resolve(__dirname, '..', 'src', 'components', 'SharedGoalModal.tsx');

test('ToastProvider.tsx 파일이 존재하고 필수 심볼을 named export 한다', () => {
  assert.ok(existsSync(PROVIDER_PATH), 'src/components/ToastProvider.tsx 가 존재해야 한다');
  const src = readFileSync(PROVIDER_PATH, 'utf8');
  assert.match(src, /export\s+function\s+ToastProvider\b/, 'named export `ToastProvider` 가 필요하다');
  assert.match(src, /export\s+function\s+useToast\b/, 'named export `useToast` 훅이 필요하다');
  assert.match(src, /export\s+type\s+ToastVariant\b/, '타입 `ToastVariant` 가 export 되어야 한다');
  assert.match(src, /export\s+interface\s+ToastInput\b/, '인터페이스 `ToastInput` 이 export 되어야 한다');
});

test('ToastProvider 는 --toast-* 토큰을 실제로 소비한다', () => {
  const src = readFileSync(PROVIDER_PATH, 'utf8');
  for (const tok of [
    '--toast-safe-top',
    '--toast-safe-right',
    '--toast-z-index',
    '--toast-radius',
    '--toast-padding',
    '--toast-width-max',
    '--toast-success-bg',
    '--toast-info-bg',
    '--toast-warning-bg',
    '--toast-error-bg',
    '--toast-shadow',
  ]) {
    assert.ok(src.includes(tok), `ToastProvider 가 토큰 ${tok} 을 사용해야 한다`);
  }
});

test('useToast 는 Provider 없을 때 no-op 을 돌려준다 (점진적 도입 안전망)', () => {
  const src = readFileSync(PROVIDER_PATH, 'utf8');
  assert.match(src, /NO_OP_TOAST/, 'no-op fallback 상수가 선언되어야 한다');
  assert.match(src, /useContext\(ToastContext\)\s*\?\?\s*NO_OP_TOAST/,
    'useToast 는 Context 가 없을 때 NO_OP_TOAST 를 반환해야 한다');
});

test('push 는 같은 id 에 대해 DOM 추가 없이 병합한다 (T-09)', () => {
  const src = readFileSync(PROVIDER_PATH, 'utf8');
  assert.match(src, /findIndex\(t\s*=>\s*t\.id\s*===\s*id\)/,
    '중복 id 검사 분기가 필요하다');
  assert.match(src, /next\[idx\]\s*=\s*item/,
    '같은 인덱스를 새 item 으로 교체해야 수명만 리셋되고 DOM 에 추가되지 않는다');
});

test('동시 표시는 MAX_VISIBLE 로 큐잉된다 (T-08)', () => {
  const src = readFileSync(PROVIDER_PATH, 'utf8');
  assert.match(src, /const\s+MAX_VISIBLE\s*=\s*3/, 'MAX_VISIBLE 상수는 3이어야 한다');
  assert.match(src, /queue\.slice\(0,\s*MAX_VISIBLE\)/, '큐에서 최대 MAX_VISIBLE 만 slice 해야 한다');
});

test('aria-live 는 variant 에 따라 polite/assertive 로 분기된다 (T-10)', () => {
  const src = readFileSync(PROVIDER_PATH, 'utf8');
  assert.match(src, /variant\s*===\s*['"]warning['"]\s*\|\|\s*variant\s*===\s*['"]error['"]/,
    '경고/에러 판정 분기(isAssertive)가 존재해야 한다');
  assert.match(src, /aria-live=\{isAssertive\s*\?\s*['"]assertive['"]\s*:\s*['"]polite['"]\}/,
    'aria-live 속성이 분기에 따라 설정되어야 한다');
  assert.match(src, /role=\{isAssertive\s*\?\s*['"]alert['"]\s*:\s*['"]status['"]\}/,
    'role 속성도 variant 분기를 따라야 한다');
});

test('SharedGoalModal 은 useToast 를 import 해 성공·실패 경로에 토스트를 띄운다', () => {
  const src = readFileSync(MODAL_PATH, 'utf8');
  assert.match(src, /import\s*\{\s*useToast\s*\}\s*from\s*['"]\.\/ToastProvider['"]/,
    'useToast 를 ToastProvider 에서 import 해야 한다');
  assert.match(src, /const\s+toast\s*=\s*useToast\(\)/,
    '컴포넌트 본문에서 const toast = useToast() 로 훅을 호출해야 한다');
  assert.match(src, /toast\.push\(\s*\{[\s\S]{0,300}variant:\s*['"]success['"][\s\S]{0,300}\}/,
    '저장 성공 경로에 success 토스트 push 가 존재해야 한다');
  assert.match(src, /toast\.push\(\s*\{[\s\S]{0,300}variant:\s*['"]error['"][\s\S]{0,300}\}/,
    '저장 실패 경로에 error 토스트 push 가 존재해야 한다');
});
