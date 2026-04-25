// 지시 #f907fb65 — buildAgentsCompletedCommitMessage 회귀 시나리오.
//
// 시나리오 매핑:
//   1. 0건 입력 → fallback 만, 제목 ≤ 72자.
//   2. 1건 입력 → 제목에 에이전트와 요약 포함, 본문은 변경 파일만.
//   3. 다건 입력 → 제목에 대표 에이전트 + N명, 본문에 항목 N + 변경 파일 섹션.
//   4. 변경 파일 6건 이상 → 상위 5개 + `...외 N건` 축약 라인.
//   5. 길이 상한 — 제목 72자 / 본문 라인 100자 강제, `…` 마감.
//   6. 이모지 입력 제거.
//   7. type 접두어 dominantType 다수결.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BODY_LINE_MAX_LEN,
  SUBJECT_MAX_LEN,
  buildAgentsCompletedCommitMessage,
  dominantType,
} from '../src/server/git/commitMessageBuilder';

test('1) 빈 tasks → fallback 제목만 사용, 본문 비어 있음', () => {
  const m = buildAgentsCompletedCommitMessage({ tasks: [], changedFiles: [] });
  assert.equal(m.subject, 'chore: 변경 없음');
  assert.equal(m.body, '');
  assert.equal(m.full, m.subject);
  assert.ok(m.subject.length <= SUBJECT_MAX_LEN);
});

test('2) 단일 태스크 → 제목에 에이전트·요약, 본문은 변경 파일만', () => {
  const m = buildAgentsCompletedCommitMessage({
    tasks: [{ agent: 'Thanos', description: 'autoCommit 빌더 도입' }],
    changedFiles: ['src/server/git/commitMessageBuilder.ts'],
  });
  assert.match(m.subject, /^chore\(agents\): Thanos /);
  assert.match(m.subject, /빌더/);
  // 단일 태스크는 항목 줄을 본문에 중복하지 않는다.
  assert.doesNotMatch(m.body, /^- Thanos:/m);
  assert.match(m.body, /변경 파일/);
  assert.match(m.body, /commitMessageBuilder\.ts/);
});

test('3) 다건 입력 → 대표 에이전트 + N명, 본문에 항목 N개 + 변경 파일 섹션', () => {
  const m = buildAgentsCompletedCommitMessage({
    tasks: [
      { agent: 'Kai', description: 'leadership: 머지 정책 정리' },
      { agent: 'Thanos', description: 'feat: 빌더 추가' },
      { agent: 'Developer', description: 'fix: 진단 로그 보강' },
    ],
    changedFiles: ['server.ts', 'src/server/git/commitMessageBuilder.ts'],
  });
  assert.match(m.subject, /^chore\(agents\): /);
  // 대표 에이전트 둘이 노출되고 나머지 1명은 "외 1명" 으로 축약.
  assert.match(m.subject, /Kai/);
  assert.match(m.subject, /Thanos/);
  assert.match(m.subject, /외 1명/);
  // 본문에 세 항목 모두 등장.
  assert.match(m.body, /- Kai: /);
  assert.match(m.body, /- Thanos: /);
  assert.match(m.body, /- Developer: /);
  // type 접두어 제거 후 본문만 노출.
  assert.doesNotMatch(m.body, /leadership:/);
  assert.doesNotMatch(m.body, /^- Thanos: feat:/m);
});

test('4) 변경 파일 6건 이상 → 상위 5개 + `...외 N건`', () => {
  const files = Array.from({ length: 9 }, (_, i) => `src/file${i + 1}.ts`);
  const m = buildAgentsCompletedCommitMessage({
    tasks: [{ agent: 'A', description: 'feat: bulk' }],
    changedFiles: files,
  });
  // 상위 5개만 라인으로 등장.
  for (let i = 1; i <= 5; i += 1) assert.match(m.body, new RegExp(`- src/file${i}\\.ts`));
  for (let i = 6; i <= 9; i += 1) {
    assert.doesNotMatch(m.body, new RegExp(`- src/file${i}\\.ts$`, 'm'));
  }
  assert.match(m.body, /\.\.\.외 4건/);
  assert.match(m.body, /총 9건, 상위 5/);
});

test('5) 길이 상한 — 제목 72자, 본문 라인 100자 강제', () => {
  const longDesc = 'feat: ' + 'a'.repeat(200);
  const longAgents = Array.from({ length: 4 }, (_, i) => ({
    agent: `Agent_${i}_${'b'.repeat(30)}`,
    description: longDesc,
  }));
  const m = buildAgentsCompletedCommitMessage({
    tasks: longAgents,
    changedFiles: [`src/${'c'.repeat(150)}.ts`],
  });
  assert.ok(m.subject.length <= SUBJECT_MAX_LEN, `subject(${m.subject.length}) 72자 초과`);
  for (const line of m.body.split('\n')) {
    assert.ok(line.length <= BODY_LINE_MAX_LEN, `라인(${line.length})이 100자 초과: ${line}`);
  }
});

test('6) 이모지 제거 — 입력에 섞여도 결과 메시지에서 사라진다', () => {
  const m = buildAgentsCompletedCommitMessage({
    tasks: [{ agent: 'Kai 🚀', description: 'feat: 🎉 새 기능 추가 ✨' }],
    changedFiles: ['src/file.ts 📝'],
  });
  assert.doesNotMatch(m.full, /[\u{1F300}-\u{1FAFF}]/u);
  assert.doesNotMatch(m.full, /[\u{2600}-\u{27BF}]/u);
  assert.match(m.subject, /Kai/);
});

test('7) dominantType — 다수 type 이 최빈값으로 선택된다', () => {
  const t = dominantType([
    { agent: 'a', description: 'feat: x' },
    { agent: 'b', description: 'fix: y' },
    { agent: 'c', description: 'feat: z' },
  ]);
  assert.equal(t, 'feat');
  // type 미지정 + 접두어 없음 → chore 폴백.
  assert.equal(dominantType([{ agent: 'a', description: '아무 설명' }]), 'chore');
});

test('8) 동일 파일 중복 입력 → 본문에서는 한 번만 노출', () => {
  const m = buildAgentsCompletedCommitMessage({
    tasks: [{ agent: 'a', description: 'feat: x' }],
    changedFiles: ['src/a.ts', 'src/a.ts', 'src\\a.ts'],
  });
  const occurrences = (m.body.match(/- src\/a\.ts/g) || []).length;
  assert.equal(occurrences, 1);
  assert.match(m.body, /총 1건/);
});

test('9) 빈 description tasks 는 무시된다 — fallback 으로 폴백', () => {
  const m = buildAgentsCompletedCommitMessage({
    tasks: [
      { agent: 'a', description: '' },
      { agent: 'b', description: '   ' },
    ],
    changedFiles: ['src/a.ts'],
  });
  assert.equal(m.subject, 'chore: 변경 없음');
  assert.equal(m.body, '');
});
