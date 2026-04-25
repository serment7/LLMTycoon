// Run with: npx tsx --test tests/git-automation.commit-message.spec.ts
//
// 지시 #98854d74 — 자동 커밋 메시지 가드(buildGuardedAutoCommitMessage) 회귀 잠금.
//
// 검증 계약
//   (1) 완료 태스크 0건 → fallback 'chore: all agents completed' 사용
//   (2) 1건 → 단일 에이전트 요약 형식(본문 비어 있음)
//   (3) 다수 에이전트·다수 파일 → 제목 72자 초과 시 말줄임, 본문 bullet 5건 + …외 N건
//   (4) description 에 줄바꿈/특수문자 → 안전하게 sanitize 되어 한 줄로 합쳐짐
//   (5) 이모지·영어 전용 summary → 이모지 제거 + warnings 에 정책 위반 코드 적재
//
// Thanos·Joker 의 변경 파일 경로를 받으면 곧바로 실행 가능한 fixture 도 함께 둔다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGuardedAutoCommitMessage,
  SUBJECT_MAX_LEN,
  BODY_BULLET_LIMIT,
  DEFAULT_GUARD_FALLBACK,
} from '../src/server/autoCommitMessageGuard.ts';
import {
  extractCommitMessageMapping,
  type CompletedAgentTask,
} from '../src/server/autoCommitMessage.ts';

// ────────────────────────────────────────────────────────────────────────────
// Fixture — Thanos · Joker · Kai 의 표준 태스크 모양. 호출자가 변경 파일 경로만
// 넘기면 곧바로 buildGuardedAutoCommitMessage 입력으로 사용할 수 있다.
// ────────────────────────────────────────────────────────────────────────────
function thanosTask(changedFiles: readonly string[], summary?: string): CompletedAgentTask {
  return {
    agent: 'Thanos',
    summary: summary ?? 'fix: git-automation commit 단계 ident/잠금 가드 강화',
    changedFiles,
  };
}
function jokerTask(changedFiles: readonly string[], summary?: string): CompletedAgentTask {
  return {
    agent: 'Joker',
    summary: summary ?? 'feat: 자동 커밋 메시지 가드 후처리 도입',
    changedFiles,
  };
}
function kaiTask(changedFiles: readonly string[], summary?: string): CompletedAgentTask {
  return {
    agent: 'Kai',
    summary: summary ?? 'chore: 리더 디스패치 정리',
    changedFiles,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// (1) 0건 → 기존 fallback 사용
// ────────────────────────────────────────────────────────────────────────────

test('1. 0건이면 기본 fallback chore: all agents completed 사용', () => {
  const result = buildGuardedAutoCommitMessage({ tasks: [] });
  assert.equal(result.subject, 'chore: all agents completed');
  assert.equal(result.body, '');
  assert.equal(result.full, 'chore: all agents completed');
  assert.equal(result.subject, DEFAULT_GUARD_FALLBACK, '상수와 일치해야 회귀 시 같이 추적 가능');
  assert.equal(result.subjectTruncated, false);
  assert.equal(result.truncatedBullets, 0);
  assert.deepEqual(result.warnings, []);
});

test('1-2. 0건 + fallbackMessage 명시 → 명시 값 우선', () => {
  const result = buildGuardedAutoCommitMessage({
    tasks: [],
    fallbackMessage: 'chore: idle convergence — no work to commit',
  });
  assert.equal(result.subject, 'chore: idle convergence — no work to commit');
});

// ────────────────────────────────────────────────────────────────────────────
// (2) 1건 → 단일 에이전트 요약 형식
// ────────────────────────────────────────────────────────────────────────────

test('2. 1건이면 단일 라인 요약 — body 비어 있고 type 접두어 보존', () => {
  const result = buildGuardedAutoCommitMessage({
    tasks: [thanosTask(['src/server/git/commitStep.ts'])],
  });
  assert.equal(result.body, '', '단일 태스크는 본문이 없다');
  assert.equal(result.subject, result.full);
  assert.match(result.subject, /^fix: /, 'summary 의 type 접두어를 그대로 보존');
  assert.match(result.subject, /git-automation commit/);
  assert.equal(result.subject.includes('\n'), false);
  assert.deepEqual(result.warnings, []);
});

// ────────────────────────────────────────────────────────────────────────────
// (3) 다수 에이전트·다수 파일 → 제목 72자 + bullet 5건 축약
// ────────────────────────────────────────────────────────────────────────────

test('3. 다수 태스크는 제목이 72자 이내로 잘리고 …로 마감', () => {
  // tasks 가 많을수록 subject 는 'chore: N agents completed' 인데, N 이 커도
  // 한 자릿수~두 자릿수라 자연스럽게 72자 이내다. 따라서 제목 truncate 분기는
  // fallback 을 길게 강제해 명시적으로 검증한다.
  const longFallback =
    'chore: ' + '가'.repeat(80) + ' — 매우 긴 폴백';
  const result = buildGuardedAutoCommitMessage({
    tasks: [],
    fallbackMessage: longFallback,
  });
  assert.equal(result.subjectTruncated, true);
  // 코드 포인트 단위로 잘리며, 마지막 글자는 '…' 이어야 한다.
  assert.equal(Array.from(result.subject).length, SUBJECT_MAX_LEN);
  assert.ok(result.subject.endsWith('…'));
});

test('3-2. 본문 bullet 은 태스크당 5건까지만 — 초과는 …외 N건 으로 축약', () => {
  // 한 태스크에 8개 파일을 붙여 5건 + …외 3건 형태가 만들어지는지 확인.
  const eightFiles = Array.from({ length: 8 }, (_, i) => `src/foo/file${i + 1}.ts`);
  const result = buildGuardedAutoCommitMessage({
    tasks: [
      thanosTask(eightFiles),
      jokerTask(['src/server/autoCommitMessageGuard.ts', 'tests/git-automation.commit-message.spec.ts']),
    ],
  });
  // Thanos 항목의 bullet 들이 5개로 잘리고 한 줄짜리 …외 3건 이 따라붙어야 한다.
  const lines = result.body.split('\n');
  // Thanos 항목: '- Thanos (fix): ...' 다음에 5줄 bullet + 1줄 …외 N건
  const thanosHeaderIdx = lines.findIndex(l => l.startsWith('- Thanos'));
  assert.ok(thanosHeaderIdx >= 0);
  const thanosBullets = lines
    .slice(thanosHeaderIdx + 1, thanosHeaderIdx + 1 + BODY_BULLET_LIMIT + 1)
    .filter(l => l.startsWith('  · '));
  assert.equal(thanosBullets.length, BODY_BULLET_LIMIT + 1, '5개 + …외 N건 한 줄');
  assert.match(thanosBullets[BODY_BULLET_LIMIT], /…외 3건/);
  assert.equal(result.truncatedBullets, 3);
  // Joker 항목은 2개 파일이라 축약 없이 그대로.
  const jokerHeaderIdx = lines.findIndex(l => l.startsWith('- Joker'));
  assert.ok(jokerHeaderIdx >= 0);
  // Joker 본문 bullet 두 줄 모두 살아 있는지 — extractCommitMessageMapping 가 동시 검증.
  const mapping = extractCommitMessageMapping(result.full);
  assert.ok(mapping.files.includes('src/server/autoCommitMessageGuard.ts'));
  assert.ok(mapping.files.includes('tests/git-automation.commit-message.spec.ts'));
  // 잘린 파일은 mapping.files 에서도 빠져야 한다(…외 N건 라인은 파일이 아님).
  assert.equal(mapping.files.filter(f => f.startsWith('src/foo/file')).length, BODY_BULLET_LIMIT);
});

// ────────────────────────────────────────────────────────────────────────────
// (4) 줄바꿈/특수문자 sanitize
// ────────────────────────────────────────────────────────────────────────────

test('4. description 에 줄바꿈/탭/제어문자 포함 → 한 줄로 sanitize', () => {
  const dirty = 'fix: 잠금\n해제\t분기 추가  그리고 \r\n 줄바꿈';
  const result = buildGuardedAutoCommitMessage({
    tasks: [thanosTask(['src/server/git/commitStep.ts'], dirty)],
  });
  // 단일 라인 결과여야 하며, 줄바꿈/탭/제어문자가 사라져야 한다.
  assert.equal(result.subject.includes('\n'), false);
  assert.equal(result.subject.includes('\t'), false);
  assert.equal(/[\x00-\x09\x0B-\x1F\x7F]/.test(result.subject), false);
  assert.match(result.subject, /^fix: /);
  // 다중 공백은 단일 공백으로 정규화돼야 한다.
  assert.equal(/\s{2,}/.test(result.subject), false);
  // 정상 분기이므로 warnings 는 비어 있어야 한다(한국어 포함, 이모지 없음).
  assert.deepEqual(result.warnings, []);
});

// ────────────────────────────────────────────────────────────────────────────
// (5) 이모지/영어 강제 규칙 위반 — 이모지 제거 + warnings 적재
// ────────────────────────────────────────────────────────────────────────────

test('5. 이모지 포함 summary → 이모지 제거 + emoji-in-summary 경고', () => {
  const result = buildGuardedAutoCommitMessage({
    tasks: [thanosTask(['src/server/git/commitStep.ts'], 'fix: 🚀 잠금 해제 ✨ 추가')],
  });
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/u.test(result.full), false, '이모지가 메시지에 남으면 안 된다');
  assert.match(result.subject, /^fix: 잠금 해제 추가$/);
  assert.ok(result.warnings.includes('emoji-in-summary:Thanos'));
});

test('5-2. 영어 전용 summary → english-only-summary 경고만 적재(원문은 보존)', () => {
  const englishSummary = 'feat: pure english summary without any hangul characters here';
  const result = buildGuardedAutoCommitMessage({
    tasks: [jokerTask(['src/server/autoCommitMessageGuard.ts'], englishSummary)],
  });
  // 원문은 그대로 살아 있어야 한다(필터링 X — 단지 경고만 띄움).
  assert.match(result.subject, /pure english summary/);
  assert.ok(result.warnings.includes('english-only-summary:Joker'));
});

test('5-3. 한국어가 한 글자라도 섞이면 english-only-summary 경고는 발생하지 않는다', () => {
  const result = buildGuardedAutoCommitMessage({
    tasks: [kaiTask(['src/server/leaderDispatch.ts'], 'feat: dispatch 정리')],
  });
  assert.equal(
    result.warnings.some(w => w.startsWith('english-only-summary:')),
    false,
    '한글 한 글자(정리)만 있어도 영어 전용으로 분류되면 안 된다',
  );
});

test('5-4. 이모지 + 영어 전용 동시 위반 → 두 경고가 모두 적재', () => {
  const result = buildGuardedAutoCommitMessage({
    tasks: [thanosTask(['x.ts'], 'feat: 🚀 english only with emoji')],
  });
  assert.ok(result.warnings.includes('emoji-in-summary:Thanos'));
  assert.ok(result.warnings.includes('english-only-summary:Thanos'));
});
