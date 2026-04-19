// Run with: npx tsx --test tests/commitMessageTemplateTaskBoundary.regression.test.ts
//
// 회귀 테스트: `src/server/commitMessageTemplate.ts` 의 태스크 경계 전용 한국어
// 제목 생성기(#f3c0ea52). 기존 `gitAutomation::formatCommitMessage` 는 설정 기반
// 템플릿이고, 본 생성기는 "태스크 description + 변경 파일" 을 받아 한 줄 제목을
// 조립한다. 최근 커밋(4aed31a · fdda31b · d0a2e68) 의 한국어 스타일을 보존하는지
// 확인한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTaskBoundaryCommitMessage,
  inferCommitTypeFromPaths,
  normalizeSummary,
} from '../src/server/commitMessageTemplate.ts';

// ────────────────────────────────────────────────────────────────────────────
// type 추론 — 경로 패턴 기반
// ────────────────────────────────────────────────────────────────────────────

test('inferCommitTypeFromPaths — 모두 tests/ 하위면 test', () => {
  assert.equal(inferCommitTypeFromPaths(['tests/foo.test.ts', 'tests/bar.test.ts']), 'test');
});

test('inferCommitTypeFromPaths — 모두 docs/ 하위면 docs', () => {
  assert.equal(inferCommitTypeFromPaths(['docs/readme.md', 'docs/arch.md']), 'docs');
});

test('inferCommitTypeFromPaths — src/server 또는 src/components 가 섞이면 feat', () => {
  assert.equal(inferCommitTypeFromPaths(['src/server/mediaGenerator.ts', 'tests/x.test.ts']), 'feat');
  assert.equal(inferCommitTypeFromPaths(['src/components/DirectivePrompt.tsx']), 'feat');
});

test('inferCommitTypeFromPaths — 설정성 파일만이면 chore', () => {
  assert.equal(inferCommitTypeFromPaths(['package.json', 'tsconfig.json']), 'chore');
});

test('inferCommitTypeFromPaths — 빈 배열이면 chore 폴백', () => {
  assert.equal(inferCommitTypeFromPaths([]), 'chore');
});

test('inferCommitTypeFromPaths — Windows 구분자(\\)도 정규화해 동일 판정', () => {
  assert.equal(inferCommitTypeFromPaths(['tests\\foo.ts', 'tests\\bar.ts']), 'test');
});

// ────────────────────────────────────────────────────────────────────────────
// normalizeSummary — 공백/개행 정규화
// ────────────────────────────────────────────────────────────────────────────

test('normalizeSummary — 개행을 공백으로, 연속 공백을 하나로 압축', () => {
  assert.equal(normalizeSummary('첫 줄\n  둘째 줄\r\n세 번째'), '첫 줄 둘째 줄 세 번째');
});

test('normalizeSummary — 양끝 공백 제거(trim)', () => {
  assert.equal(normalizeSummary('   요약   '), '요약');
});

test('normalizeSummary — 한국어 80자+괄호도 자르지 않고 보존', () => {
  // 최근 커밋의 `(16건 통과)` 말미처럼 80자를 초과해도 그대로 두어야 한다.
  const raw = '상단바 Claude 토큰 사용량 위젯 회귀 테스트 U1~U4 + 진리표 + QA 준비 문서 추가(16건 통과)';
  assert.equal(normalizeSummary(raw), raw);
});

// ────────────────────────────────────────────────────────────────────────────
// buildTaskBoundaryCommitMessage — 조합
// ────────────────────────────────────────────────────────────────────────────

test('description 에 `type:` 접두가 있으면 그 type 을 존중한다', () => {
  const out = buildTaskBoundaryCommitMessage({
    description: 'test: 공동 목표 모달 시안 문서 추가',
    changedFiles: ['src/server/foo.ts'], // 파일로는 feat 가 추론되어야 하지만 명시 type 이 우선
  });
  assert.equal(out, 'test: 공동 목표 모달 시안 문서 추가');
});

test('description 에 type 이 없으면 파일 경로로 추론한다', () => {
  const out = buildTaskBoundaryCommitMessage({
    description: '커밋 템플릿 도입',
    changedFiles: ['src/server/commitMessageTemplate.ts'],
  });
  assert.equal(out, 'feat: 커밋 템플릿 도입');
});

test('fdda31b 스타일 — 사용자 요약 + 검증 결과 괄호 병기', () => {
  const out = buildTaskBoundaryCommitMessage({
    description: 'test: 상단바 Claude 토큰 사용량 위젯 회귀 테스트 U1~U4 + 진리표 + QA 준비 문서 추가',
    changedFiles: ['tests/tokenUsageWidget.regression.test.ts'],
    verified: '16건 통과',
  });
  assert.equal(
    out,
    'test: 상단바 Claude 토큰 사용량 위젯 회귀 테스트 U1~U4 + 진리표 + QA 준비 문서 추가(16건 통과)',
  );
});

test('d0a2e68 스타일 — "test: 요약(N건 통과)"', () => {
  const out = buildTaskBoundaryCommitMessage({
    description: '프로젝트 관리 탭 SharedGoalForm 표시 회귀 테스트 P1~P4 추가',
    changedFiles: ['tests/sharedGoalFormDisplay.regression.test.ts'],
    verified: '15건 통과',
  });
  assert.equal(out, 'test: 프로젝트 관리 탭 SharedGoalForm 표시 회귀 테스트 P1~P4 추가(15건 통과)');
});

test('4aed31a 스타일 — "chore: 시안 문서 + 토큰 선도입" (검증 결과 생략)', () => {
  const out = buildTaskBoundaryCommitMessage({
    description: 'chore: SharedGoalModal 자동 개발 ON 트리거 UX 시안 문서 + --shared-goal-modal-* 토큰 선도입',
    changedFiles: ['tests/shared-goal-modal-mockup.md', 'src/index.css'],
  });
  assert.equal(
    out,
    'chore: SharedGoalModal 자동 개발 ON 트리거 UX 시안 문서 + --shared-goal-modal-* 토큰 선도입',
  );
});

test('prefix 옵션 — commitMessagePrefix 가 있으면 제목 앞에 붙는다', () => {
  const out = buildTaskBoundaryCommitMessage({
    description: '설정 기본값 조정',
    changedFiles: ['package.json'],
    prefix: 'auto: ',
  });
  assert.equal(out, 'auto: chore: 설정 기본값 조정');
});

test('빈 description 은 update 로 폴백된다', () => {
  const out = buildTaskBoundaryCommitMessage({
    description: '   ',
    changedFiles: ['package.json'],
  });
  assert.equal(out, 'chore: update');
});

test('알려지지 않은 영문 접두어(`updt:`) 는 type 으로 승격하지 않는다 — 본문의 일부로 취급', () => {
  const out = buildTaskBoundaryCommitMessage({
    description: 'updt: 사소한 수정',
    changedFiles: ['src/server/foo.ts'],
  });
  assert.equal(out, 'feat: updt: 사소한 수정');
});
