// Run with: npx tsx --test spec/git/autoCommit.spec.ts
//
// 지시 #dee6ec06 — 개선된 자동 커밋 메시지 생성 로직 회귀 테스트.
//
// 검증 시나리오
//   (1) 완료된 task 0건 → 'chore: no changes' 폴백
//   (2) 1건 완료 시 단일 라인 요약(본문 없음)
//   (3) 다중 에이전트 완료 시 본문에 에이전트별 항목 누락 없음
//   (4) 변경 파일 목록이 메시지 본문에 정확히 매핑됨

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutoCommitMessage,
  extractCommitMessageMapping,
  type CompletedAgentTask,
} from '../../src/server/autoCommitMessage.ts';

// ────────────────────────────────────────────────────────────────────────────
// (1) 0건 완료 — 폴백 메시지
// ────────────────────────────────────────────────────────────────────────────

test('1. 완료된 task 0건이면 chore: no changes 폴백을 반환한다', () => {
  const result = buildAutoCommitMessage({ tasks: [] });
  assert.equal(result.subject, 'chore: no changes');
  assert.equal(result.body, '');
  assert.equal(result.full, 'chore: no changes');
});

test('1-2. 0건 + fallbackMessage 명시 → 명시 값 우선', () => {
  const result = buildAutoCommitMessage({
    tasks: [],
    fallbackMessage: 'chore: idle convergence — no work to commit',
  });
  assert.equal(result.subject, 'chore: idle convergence — no work to commit');
  assert.equal(result.body, '');
});

test('1-3. 0건 + fallbackMessage 가 빈 문자열이면 기본 폴백으로 회귀', () => {
  const result = buildAutoCommitMessage({ tasks: [], fallbackMessage: '   ' });
  assert.equal(result.subject, 'chore: no changes');
});

// ────────────────────────────────────────────────────────────────────────────
// (2) 1건 완료 — 단일 라인 요약
// ────────────────────────────────────────────────────────────────────────────

test('2. 1건 완료 시 단일 라인 요약이고 body 는 비어 있다', () => {
  const tasks: CompletedAgentTask[] = [
    {
      agent: 'Developer',
      summary: 'test: tokenUsage 회귀 테스트 추가(8건 통과)',
      changedFiles: ['spec/llm/tokenUsage.spec.ts', 'src/llm/promptCache.ts'],
    },
  ];
  const result = buildAutoCommitMessage({ tasks });

  assert.equal(result.body, '', '단일 태스크는 본문이 없다');
  assert.equal(result.subject, result.full, 'full 은 subject 와 동일');
  assert.match(result.subject, /^test: /, 'summary 의 type 접두어를 그대로 보존');
  assert.match(result.subject, /tokenUsage 회귀 테스트 추가/);
  // 단일 라인 — 개행이 없어야 한다.
  assert.equal(result.subject.includes('\n'), false);
});

test('2-2. type 미지정 + 경로가 모두 tests/ 하위면 type 이 test 로 추론된다', () => {
  const tasks: CompletedAgentTask[] = [
    {
      agent: 'QA',
      summary: '회귀 테스트 4건 추가',
      changedFiles: ['tests/foo.spec.ts', 'tests/bar.spec.ts'],
    },
  ];
  const result = buildAutoCommitMessage({ tasks });
  assert.match(result.subject, /^test: 회귀 테스트 4건 추가$/);
});

// ────────────────────────────────────────────────────────────────────────────
// (3) 다중 에이전트 완료 — 본문 항목 누락 금지
// ────────────────────────────────────────────────────────────────────────────

test('3. 다중 에이전트 완료 시 모든 에이전트가 본문에 등장한다', () => {
  const tasks: CompletedAgentTask[] = [
    { agent: 'Kai', summary: 'feat: 리더 디스패치 정리', changedFiles: ['src/server/leaderDispatch.ts'] },
    { agent: 'Developer', summary: 'test: tokenUsage 회귀 추가', changedFiles: ['spec/llm/tokenUsage.spec.ts'] },
    { agent: 'QA', summary: 'docs: QA 체크리스트 갱신', changedFiles: ['docs/qa-checklist.md'] },
  ];
  const result = buildAutoCommitMessage({ tasks });

  assert.equal(result.subject, 'chore: 3 agents completed');
  // 본문에 각 에이전트 이름이 모두 등장
  for (const t of tasks) {
    assert.ok(
      result.body.includes(`- ${t.agent} (`),
      `본문에 에이전트 ${t.agent} 항목이 있어야 한다`,
    );
  }
  // extractCommitMessageMapping 은 입력 순서를 그대로 보존
  const mapping = extractCommitMessageMapping(result.full);
  assert.deepEqual(mapping.agents, ['Kai', 'Developer', 'QA']);
});

test('3-2. 동일 에이전트가 여러 task 를 끝낸 경우에도 항목이 모두 살아남는다', () => {
  const tasks: CompletedAgentTask[] = [
    { agent: 'Developer', summary: 'feat: A', changedFiles: ['src/server/a.ts'] },
    { agent: 'Developer', summary: 'fix: B', changedFiles: ['src/server/b.ts'] },
  ];
  const result = buildAutoCommitMessage({ tasks });

  assert.equal(result.subject, 'chore: 2 agents completed');
  const mapping = extractCommitMessageMapping(result.full);
  assert.equal(mapping.agents.length, 2, '두 항목이 합쳐지지 않고 그대로 살아남아야 한다');
  assert.deepEqual(mapping.agents, ['Developer', 'Developer']);
});

test('3-3. 이름이 비어 있는 에이전트는 unknown 으로 표시된다(누락 금지)', () => {
  const tasks: CompletedAgentTask[] = [
    { agent: '', summary: 'chore: 자동 정리', changedFiles: ['scripts/cleanup.ts'] },
    { agent: 'Kai', summary: 'feat: 리더 검수', changedFiles: ['src/server/leaderDispatch.ts'] },
  ];
  const result = buildAutoCommitMessage({ tasks });
  const mapping = extractCommitMessageMapping(result.full);
  assert.deepEqual(mapping.agents, ['unknown', 'Kai']);
});

// ────────────────────────────────────────────────────────────────────────────
// (4) 변경 파일 목록 매핑
// ────────────────────────────────────────────────────────────────────────────

test('4. 변경 파일 목록이 본문에 빠짐없이 매핑된다', () => {
  const tasks: CompletedAgentTask[] = [
    {
      agent: 'Kai',
      summary: 'feat: 리더 디스패치 정리',
      changedFiles: ['src/server/leaderDispatch.ts', 'src/server/agentWorker.ts'],
    },
    {
      agent: 'Developer',
      summary: 'test: tokenUsage 회귀 추가',
      changedFiles: ['spec/llm/tokenUsage.spec.ts', 'src/llm/promptCache.ts'],
    },
  ];
  const result = buildAutoCommitMessage({ tasks });
  const mapping = extractCommitMessageMapping(result.full);

  const expected = [
    'src/server/leaderDispatch.ts',
    'src/server/agentWorker.ts',
    'spec/llm/tokenUsage.spec.ts',
    'src/llm/promptCache.ts',
  ];
  assert.deepEqual(mapping.files, expected, '변경 파일이 입력 순서대로 모두 본문에 들어가야 한다');

  // 각 파일이 본문에 들여쓴 형식(`  · `) 으로 정확히 한 번씩 등장
  for (const f of expected) {
    const occurrences = result.body.split('\n').filter(line => line === `  · ${f}`).length;
    assert.equal(occurrences, 1, `파일 ${f} 는 본문에 정확히 한 번 등장해야 한다`);
  }
});

test('4-2. Windows 역슬래시 경로도 슬래시 형태로 정규화된다', () => {
  const tasks: CompletedAgentTask[] = [
    {
      agent: 'Developer',
      summary: 'feat: 자동 커밋 빌더',
      changedFiles: ['src\\server\\autoCommitMessage.ts'],
    },
    {
      agent: 'QA',
      summary: 'test: 본문 스냅샷',
      changedFiles: ['spec\\git\\autoCommit.spec.ts'],
    },
  ];
  const result = buildAutoCommitMessage({ tasks });
  assert.match(result.body, /·\s+src\/server\/autoCommitMessage\.ts/);
  assert.match(result.body, /·\s+spec\/git\/autoCommit\.spec\.ts/);
  assert.equal(result.body.includes('\\'), false, '역슬래시는 본문에 남지 않는다');
});

test('4-3. 변경 파일이 0개인 항목은 "(파일 변경 없음)" 으로 명시된다', () => {
  const tasks: CompletedAgentTask[] = [
    { agent: 'Kai', summary: 'chore: 회의록만 정리', changedFiles: [] },
    { agent: 'Developer', summary: 'feat: 자동 커밋 빌더', changedFiles: ['src/server/autoCommitMessage.ts'] },
  ];
  const result = buildAutoCommitMessage({ tasks });
  // type 접두어가 summary 에 있으면 헤더의 (chore) 로 흡수되고 본문 요약에서는 제거된다.
  assert.match(result.body, /- Kai \(chore\): 회의록만 정리\n\s+·\s+\(파일 변경 없음\)/);
  // extractCommitMessageMapping 은 "파일 변경 없음" 라인을 files 에 포함시키지 않는다.
  const mapping = extractCommitMessageMapping(result.full);
  assert.deepEqual(mapping.files, ['src/server/autoCommitMessage.ts']);
});
