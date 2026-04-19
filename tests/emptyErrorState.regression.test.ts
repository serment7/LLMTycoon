// Run with: npx tsx --test tests/emptyErrorState.regression.test.ts
//
// 회귀 테스트: 공통 EmptyState/ErrorState 컴포넌트가 도입됐고, 인라인으로 흩어져
// 있던 "로딩 중…"/"데이터 없음"/"불러오기 실패" 문구·스타일이 공통 컴포넌트를
// 경유하는지 정적 검증한다. 시각 가이드: docs/ux-cleanup-visual-2026-04-19.md §5.
//
// 잠그는 계약 5가지:
//   1. EmptyState.tsx · ErrorState.tsx 파일 존재 + named export.
//   2. 두 컴포넌트는 모두 src/index.css 의 `--empty-state-*` · `--error-state-*`
//      토큰을 소비한다(하드코딩 색 금지, 토큰 사용 규약).
//   3. SharedGoalForm.tsx 의 로딩/에러/프로젝트-미선택 3 분기가 공통 컴포넌트로
//      치환됐다(인라인 `<div ... role="status"...>공동 목표를 불러오는 중…` 문자열
//      구성은 더 이상 나오지 않는다).
//   4. CollabTimeline.tsx 의 "표시할 협업 항목이 없습니다" 문구가 EmptyState 를
//      통해 렌더된다.
//   5. ProjectManagement.tsx 의 미선택 안내 박스·Git 자동화 로딩 박스가 공통
//      컴포넌트로 치환됐다. 기존 회귀 계약(`project-management-no-project` testId +
//      role/aria 근접 선언) 은 유지.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMPTY_PATH = resolve(__dirname, '..', 'src', 'components', 'EmptyState.tsx');
const ERROR_PATH = resolve(__dirname, '..', 'src', 'components', 'ErrorState.tsx');
const SHARED_GOAL_FORM_PATH = resolve(__dirname, '..', 'src', 'components', 'SharedGoalForm.tsx');
const COLLAB_TIMELINE_PATH = resolve(__dirname, '..', 'src', 'components', 'CollabTimeline.tsx');
const PROJECT_MGMT_PATH = resolve(__dirname, '..', 'src', 'components', 'ProjectManagement.tsx');

test('EmptyState.tsx · ErrorState.tsx 파일이 존재하고 named export 한다', () => {
  assert.ok(existsSync(EMPTY_PATH), 'src/components/EmptyState.tsx 가 존재해야 한다');
  assert.ok(existsSync(ERROR_PATH), 'src/components/ErrorState.tsx 가 존재해야 한다');
  const empty = readFileSync(EMPTY_PATH, 'utf8');
  const err = readFileSync(ERROR_PATH, 'utf8');
  assert.match(empty, /export\s+function\s+EmptyState\b/,
    'named export `EmptyState` 가 선언되어야 한다');
  assert.match(err, /export\s+function\s+ErrorState\b/,
    'named export `ErrorState` 가 선언되어야 한다');
});

test('공통 컴포넌트는 --empty-state-* / --error-state-* 토큰을 소비한다', () => {
  const empty = readFileSync(EMPTY_PATH, 'utf8');
  const err = readFileSync(ERROR_PATH, 'utf8');
  assert.match(empty, /var\(--empty-state-border\)/, 'EmptyState 는 --empty-state-border 를 사용해야 한다');
  assert.match(empty, /var\(--empty-state-title-fg\)/, 'EmptyState 는 --empty-state-title-fg 를 사용해야 한다');
  assert.match(err, /var\(--error-state-strip\)/, 'ErrorState 는 --error-state-strip 을 사용해야 한다');
  assert.match(err, /var\(--error-state-retry-bg\)/, 'ErrorState 는 --error-state-retry-bg 를 사용해야 한다');
});

test('EmptyState loading variant 는 role="status" + aria-live 를 자동 부여한다', () => {
  const empty = readFileSync(EMPTY_PATH, 'utf8');
  assert.match(empty, /role=\{isLoading\s*\?\s*['"]status['"]\s*:/,
    '로딩 분기에서 role="status" 를 부여해야 한다');
  assert.match(empty, /aria-live=\{isLoading\s*\?\s*['"]polite['"]\s*:/,
    '로딩 분기에서 aria-live="polite" 를 부여해야 한다');
});

test('ErrorState 는 role="alert" + aria-live="assertive" 를 부여한다', () => {
  const err = readFileSync(ERROR_PATH, 'utf8');
  assert.match(err, /role="alert"/, 'ErrorState 는 role="alert" 를 부여해야 한다');
  assert.match(err, /aria-live="assertive"/, 'ErrorState 는 aria-live="assertive" 를 부여해야 한다');
});

test('SharedGoalForm.tsx 는 EmptyState/ErrorState 를 import 해 인라인 문구를 치환했다', () => {
  const src = readFileSync(SHARED_GOAL_FORM_PATH, 'utf8');
  assert.match(src, /import\s*\{\s*EmptyState\s*\}\s*from\s*['"]\.\/EmptyState['"]/,
    'SharedGoalForm 은 EmptyState 를 import 해야 한다');
  assert.match(src, /import\s*\{\s*ErrorState\s*\}\s*from\s*['"]\.\/ErrorState['"]/,
    'SharedGoalForm 은 ErrorState 를 import 해야 한다');
  // 기존 인라인 로딩 배너(`공동 목표를 불러오는 중…` 이 `<div ... role="status"` 형태로
  // 있었던 회귀 재발 차단) — 현재는 EmptyState variant="loading" 으로만 존재.
  assert.doesNotMatch(src, /<div[^>]*role="status"[^>]*>\s*공동 목표를 불러오는 중/,
    'SharedGoalForm 의 인라인 로딩 배너는 EmptyState 로 치환되어야 한다');
  assert.match(src, /testId="shared-goal-form-loading"/,
    '기존 testId 계약(shared-goal-form-loading) 은 EmptyState 에도 전달되어야 한다');
  assert.match(src, /testId="shared-goal-form-load-error"/,
    '기존 testId 계약(shared-goal-form-load-error) 은 ErrorState 에도 전달되어야 한다');
  assert.match(src, /testId="shared-goal-form-no-project"/,
    '기존 testId 계약(shared-goal-form-no-project) 은 EmptyState 에도 전달되어야 한다');
});

test('CollabTimeline.tsx 는 빈 상태를 EmptyState 로 렌더한다', () => {
  const src = readFileSync(COLLAB_TIMELINE_PATH, 'utf8');
  assert.match(src, /import\s*\{\s*EmptyState\s*\}\s*from\s*['"]\.\/EmptyState['"]/,
    'CollabTimeline 은 EmptyState 를 import 해야 한다');
  assert.match(src, /<EmptyState[\s\S]{0,400}표시할 협업 항목이 없습니다/,
    '빈 상태 문구는 EmptyState 내부 title/description 로 전달되어야 한다');
  assert.doesNotMatch(src, /<li[^>]*className="px-2 py-3 text-white\/40">표시할 협업 항목이 없습니다/,
    '기존 인라인 <li> 빈 문구는 EmptyState 로 치환되어야 한다');
});

test('ProjectManagement.tsx 는 미선택 박스와 Git 자동화 로딩 박스를 EmptyState 로 치환했다', () => {
  const src = readFileSync(PROJECT_MGMT_PATH, 'utf8');
  assert.match(src, /import\s*\{\s*EmptyState\s*\}\s*from\s*['"]\.\/EmptyState['"]/,
    'ProjectManagement 는 EmptyState 를 import 해야 한다');
  // 기존 회귀 계약(projectManagementNoProjectPlaceholder.regression.test.ts) 과
  // 맞물려 outer wrapper 의 testId·role·aria-live 는 반드시 유지.
  assert.match(src, /data-testid="project-management-no-project"[\s\S]{0,160}role="status"/,
    'outer wrapper 에 data-testid 와 role="status" 가 같이 선언되어야 한다');
  assert.match(src, /testId="git-automation-panel-loading"/,
    'Git 자동화 로딩 박스는 testId="git-automation-panel-loading" 로 EmptyState 에 전달되어야 한다');
  assert.doesNotMatch(src,
    /<div\s+className="p-4 border-2 border-\[var\(--pixel-border\)\] bg-\[#0f3460\] text-\[12px\] text-white\/70"\s*\n\s*data-testid="git-automation-panel-loading"/,
    '기존 인라인 Git 자동화 로딩 <div> 스타일은 EmptyState 로 치환되어야 한다');
});
