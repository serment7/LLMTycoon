// Run with: npx tsx --test tests/commitMessageTemplate.regression.test.ts
//
// QA 회귀(#a6604cb0) — 커밋 메시지 템플릿 함수의 한국어 스타일 회귀.
//
// 실제 구현(`src/utils/gitAutomation.ts::formatCommitMessage`) 은 아래 3규칙만 갖는다:
//   · `commitConvention === 'plain'` → `summary.trim()` 그대로 반환(미지정 → 'update').
//   · `conventional` + `commitScope` 없음 → `"{type}: {summary}"`.
//   · `conventional` + `commitScope` 있음 → `"{type}({scope}): {summary}"`.
// 함수 자체는 "변경 파일 수" 를 모른다 — **"변경 파일 수 0건 시 커밋 스킵"** 책임은
// 상위 파이프라인(`gitAutomationPipeline`) 이 진다. 본 테스트는 그 책임 분리가
// 깨지지 않았음을 함께 잠근다.
//
// 최근 커밋 스타일(fdda31b · d0a2e68) 은 "설명(N건 통과)" 형태로, 사용자가 입력한
// `summary` 가 그대로 보존되어야 한다(정규화·트렁케이션 금지). 본 회귀는 그 입력을
// 그대로 넘겼을 때 출력이 `"{type}: {summary}"` 로 동일하게 유지되는지 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCommitMessage,
  formatPrTitle,
} from '../src/utils/gitAutomation.ts';

const PLAIN = { commitConvention: 'plain' as const, commitScope: '' };
const CONV = { commitConvention: 'conventional' as const, commitScope: '' };
const CONV_WITH_SCOPE = { commitConvention: 'conventional' as const, commitScope: 'auto-dev' };

// ────────────────────────────────────────────────────────────────────────────
// 기본 규칙
// ────────────────────────────────────────────────────────────────────────────

test('plain convention — summary 가 그대로 출력된다(trim 적용)', () => {
  assert.equal(
    formatCommitMessage(PLAIN, { type: 'test', summary: '  자동 개발 ON 1차 스켈레톤  ' }),
    '자동 개발 ON 1차 스켈레톤',
  );
});

test('conventional without scope — "type: summary" 형식', () => {
  assert.equal(
    formatCommitMessage(CONV, { type: 'fix', summary: '프로젝트 전환 재마운트' }),
    'fix: 프로젝트 전환 재마운트',
  );
});

test('conventional with scope — "type(scope): summary" 형식', () => {
  assert.equal(
    formatCommitMessage(CONV_WITH_SCOPE, { type: 'feat', summary: '커밋 템플릿 도입' }),
    'feat(auto-dev): 커밋 템플릿 도입',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 폴백 규칙 — "변경 파일 수 0건" 책임은 상위 파이프라인
// ────────────────────────────────────────────────────────────────────────────

test('빈 summary 는 "update" 로 폴백된다(변경 파일 0건 시 상위에서 스킵되어야 함을 암시)', () => {
  assert.equal(formatCommitMessage(CONV, { type: 'chore', summary: '' }), 'chore: update');
  assert.equal(
    formatCommitMessage(PLAIN, { type: 'chore', summary: '   \n\t' }),
    'update',
    'plain 에서도 동일 폴백',
  );
});

test('빈 type 은 "chore" 로 폴백된다(conventional 경로 전용)', () => {
  assert.equal(
    formatCommitMessage(CONV, { type: '', summary: '로그 정리' }),
    'chore: 로그 정리',
  );
});

test('type 은 소문자화된다 — `Feat` 입력도 `feat:` 로 정규화', () => {
  assert.equal(
    formatCommitMessage(CONV, { type: 'Feat', summary: '대소문자 정규화 회귀' }),
    'feat: 대소문자 정규화 회귀',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 최근 커밋 스타일(fdda31b · d0a2e68) 보존
// ────────────────────────────────────────────────────────────────────────────

test('fdda31b 스타일 — "test: 상단바 Claude 토큰 사용량 위젯 회귀 테스트 U1~U4 + …(16건 통과)"', () => {
  const summary =
    '상단바 Claude 토큰 사용량 위젯 회귀 테스트 U1~U4 + 진리표 + QA 준비 문서 추가(16건 통과)';
  assert.equal(
    formatCommitMessage(CONV, { type: 'test', summary }),
    `test: ${summary}`,
    '괄호·물결표·덧셈 기호가 포함된 한국어 요약이 변형 없이 보존되어야 한다',
  );
});

test('d0a2e68 스타일 — "test: 프로젝트 관리 탭 SharedGoalForm 표시 회귀 테스트 P1~P4 추가(15건 통과)"', () => {
  const summary =
    '프로젝트 관리 탭 SharedGoalForm 표시 회귀 테스트 P1~P4 추가(15건 통과)';
  assert.equal(
    formatCommitMessage(CONV, { type: 'test', summary }),
    `test: ${summary}`,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 책임 분리 회귀 — formatCommitMessage 는 "변경 파일 수" 를 계산하지 않는다
// ────────────────────────────────────────────────────────────────────────────

test('formatCommitMessage 는 변경 파일 수·diff 상태를 신경쓰지 않는다(순수 포맷 함수)', () => {
  // 동일 입력이면 몇 번을 호출해도 같은 결과를 돌려주고 외부 상태 의존이 없다.
  const a = formatCommitMessage(CONV, { type: 'feat', summary: '파이프라인 라우팅' });
  const b = formatCommitMessage(CONV, { type: 'feat', summary: '파이프라인 라우팅' });
  assert.equal(a, b, '순수 함수 동등성');
  assert.equal(a, 'feat: 파이프라인 라우팅');
  // "파일 수 0 이면 스킵" 은 gitAutomationPipeline.test.ts 의 scenario-e
  // (empty commit should fail) 가 잠근다 — 본 함수 계약 밖임을 명시적으로 잠금.
});

// ────────────────────────────────────────────────────────────────────────────
// formatPrTitle — 커밋과 별도 템플릿 엔진을 쓰지만 동일 한국어 보존 규약
// ────────────────────────────────────────────────────────────────────────────

test('formatPrTitle — 한국어 summary 와 branch 토큰이 템플릿에 그대로 삽입된다', () => {
  assert.equal(
    formatPrTitle('[{branch}] {type} — {summary}', {
      type: 'fix',
      summary: '하이드레이션 레이스 수정',
      branch: 'fix/auto-dev-race',
    }),
    '[fix/auto-dev-race] fix — 하이드레이션 레이스 수정',
  );
});

test('formatPrTitle — 미제공 토큰은 빈 문자열로 치환되고, 최종 결과가 비면 summary 로 폴백', () => {
  // summary 가 공백만 있고 template 결과가 빈 문자열일 때는 'update' 가 최종 폴백.
  assert.equal(
    formatPrTitle('{branch}', { type: 'chore', summary: '', branch: '' }),
    'update',
  );
});
