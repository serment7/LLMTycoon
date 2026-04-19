// Run with: npx tsx --test tests/gitAutomationPanel.regression.test.tsx
//
// QA 회귀(#a6604cb0) — `GitAutomationPanel` 주변의 저장/로드 하이드레이션 레이스 재확인.
//
// 원인 커밋 1587ea9 ("fix: ProjectManagement GitAutomationPanel 저장/로드 하이드레이션
// 레이스 수정") 이 고친 것은 **`ProjectManagement.tsx` 의 래퍼** 쪽이다
// (GitAutomationPanel 자체는 `initial` 을 `useState` 초기값으로만 읽으므로, 서버에서
// 불러오기 전에 마운트되면 사용자가 저장한 값이 기본값으로 "되돌아간 듯" 보인다).
// 본 회귀는 그 4가지 불변식을 재확인하고 + Panel 자체의 `DEFAULT_AUTOMATION`
// 기본값·`validateNewBranchName` 규칙 계약까지 함께 고정한다.
//
// 패널 전체 렌더는 `useReducedMotion`·`useProjectOptions` 등 환경 의존이 많아
// 현 jsdom 하니스(global-jsdom 28)에서 안정적으로 마운트되지 않는다. 본 파일은
// 정적 검증 + 공개 상수/함수 직접 호출로 범위를 한정한다 — 실제 DOM 상호작용
// 회귀는 추후 `sharedGoalFormAccess.e2e.test.tsx` 스타일의 별도 스위트로 확장.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  DEFAULT_AUTOMATION,
  validateNewBranchName,
} from '../src/components/GitAutomationPanel.tsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_MGMT_SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'ProjectManagement.tsx'),
  'utf8',
);

// ────────────────────────────────────────────────────────────────────────────
// 1587ea9 — ProjectManagement 래퍼 4가지 불변식
// ────────────────────────────────────────────────────────────────────────────

test('1587ea9 ① 로딩 박스는 EmptyState(variant="loading") + testId="git-automation-panel-loading" 로 렌더된다', () => {
  assert.match(PROJECT_MGMT_SRC, /testId="git-automation-panel-loading"/);
  assert.match(
    PROJECT_MGMT_SRC,
    /<EmptyState[\s\S]{0,300}variant="loading"[\s\S]{0,400}testId="git-automation-panel-loading"/,
    '로딩 박스가 공용 EmptyState 컴포넌트로 통일되어야 한다',
  );
});

test('1587ea9 ② 로드 완료 판정은 `gitAutomationByProject[selectedProjectId] === undefined` 로 고정', () => {
  assert.match(
    PROJECT_MGMT_SRC,
    /selectedProjectId\s*&&\s*gitAutomationByProject\[selectedProjectId\]\s*===\s*undefined/,
    '이 분기가 사라지면 서버 응답 전에 DEFAULT_AUTOMATION 으로 패널이 마운트돼 회귀 재발 위험',
  );
});

test('1587ea9 ③ 프로젝트 전환 시 GitAutomationPanel 은 Fragment key={selectedProjectId} 로 강제 재마운트', () => {
  assert.match(
    PROJECT_MGMT_SRC,
    /<React\.Fragment\s+key=\{selectedProjectId\s*\|\|\s*'no-project'\}>/,
    'Fragment key 가 사라지면 두 프로젝트 간 전환 시 이전 local state 가 남아 저장값이 오염된다',
  );
});

test('1587ea9 ④ onSave 는 structuredClone 후 localStorage 와 in-memory slot 을 동기 갱신한다', () => {
  assert.match(
    PROJECT_MGMT_SRC,
    /structuredClone\(next\)[\s\S]{0,400}setGitAutomationByProject[\s\S]{0,200}saveGitAutomationSettings\(\s*cloned,\s*selectedProjectId\s*\)/,
    '저장 경로가 참조 격리를 잃으면 패널 내부 mutate 가 부모 state 를 오염시킨다',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// DEFAULT_AUTOMATION — 공개 기본값 계약
// ────────────────────────────────────────────────────────────────────────────

test('DEFAULT_AUTOMATION 기본값은 flow="commit" · enabled=true · branchStrategy="per-session"', () => {
  assert.equal(DEFAULT_AUTOMATION.flow, 'commit', '가장 안전한 commit-only 가 기본');
  assert.equal(DEFAULT_AUTOMATION.enabled, true, '기본 ON (마스터 스위치 꺼짐은 명시적 선택)');
  assert.equal(DEFAULT_AUTOMATION.branchStrategy, 'per-session', '세션당 1 브랜치 기본');
  assert.equal(DEFAULT_AUTOMATION.branchPattern, '{type}/{ticket}-{branch}');
  assert.equal(DEFAULT_AUTOMATION.commitTemplate, '{type}: {branch}');
  assert.equal(DEFAULT_AUTOMATION.prTitleTemplate, '[{ticket}] {type} — {branch}');
  assert.equal(DEFAULT_AUTOMATION.newBranchName, '', 'fixed-branch 외 전략에서는 빈 문자열');
});

// ────────────────────────────────────────────────────────────────────────────
// validateNewBranchName — fixed-branch 입력 규칙
// ────────────────────────────────────────────────────────────────────────────

test('validateNewBranchName — 정상/공백/중복 특수문자/허용 외 문자의 분기', () => {
  assert.deepEqual(validateNewBranchName('feature/auto-dev'), { ok: true });
  assert.equal(validateNewBranchName('').ok, false, '빈 값 거부');
  assert.equal(validateNewBranchName('   ').ok, false, '공백만 거부');
  assert.equal(validateNewBranchName('feature/ auto').ok, false, '중간 공백 거부');
  const dup = validateNewBranchName('feature//auto');
  assert.equal(dup.ok, false, '`//` 중복 슬래시 거부');
  const koreanOnly = validateNewBranchName('기능/자동');
  assert.equal(koreanOnly.ok, false, '한글만의 브랜치명 거부(서버 셸 파서 회귀 방지)');
});

test('validateNewBranchName — 선·후행 `/`, `.`, `-` 는 모두 거부한다', () => {
  for (const bad of ['/feat', 'feat/', '.hidden', 'release.', '-draft', 'feat-']) {
    assert.equal(
      validateNewBranchName(bad).ok,
      false,
      `선·후행 특수문자 거부: ${bad}`,
    );
  }
});
