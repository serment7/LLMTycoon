// Run with: npx tsx --test tests/git-automation.spec.ts
//
// 지시 #2dcad0b8 — Thanos 의 "커밋 메시지 동적 생성" 통합 회귀 잠금.
//
// 배경
//   server.ts:2256-2299 의 allAgentsCompletedWatcher 는 60분 이내 완료된 에이전트
//   태스크 N건 + 통합 변경 파일 목록을 모아 buildAgentsCompletedCommitMessage 로
//   다중 라인 메시지를 만든 뒤, runStep('commit', commitMessageOverride=full) 으로
//   `git commit -m` 한 번에 흘린다(#f907fb65). 빌더가 throw 하는 분기에서는 try/catch
//   가 기존 폴백 'chore: all agents completed' 로 폴백한다.
//
//   기존 commitMessageBuilder.unit.test.ts 가 빌더 단위 행동을 9가지 케이스로 잠그고
//   있고, git-automation.commit-message.spec.ts 가 가드(autoCommitMessageGuard) 를
//   잠그고 있다. 본 spec 은 그 사이의 "통합 시나리오" — 즉 server.ts 가 실제로 빌더에
//   넘기는 입력 형태로 (1) 단일/(2) 다중/(3) 빈/실패 폴백 세 분기를 잠가, Thanos 의
//   리팩터링이 watcher 진입점 계약을 회귀시키지 않도록 한다.
//
// 검증 계약
//   (1) 단일 에이전트 완료     → subject 에 에이전트 + description 본문 키워드 포함,
//                                 body 에 변경 파일 경로가 누락 없이 등장
//   (2) 다중 에이전트 완료     → 모든 에이전트 항목과 모든 변경 파일이 본문에 반영
//                                 (5건 이내) / 5건 초과 시 ...외 N건 으로 누적 표기
//   (3) 빈 변경/실패 폴백      → tasks=[] 또는 description 공백 → 'chore: 변경 없음',
//                                 명시 fallback 우선, 빌더는 절대 throw 하지 않음

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentsCompletedCommitMessage,
  SUBJECT_MAX_LEN,
  BODY_LINE_MAX_LEN,
  type CompletedAgentTask,
} from '../src/server/git/commitMessageBuilder';

// ────────────────────────────────────────────────────────────────────────────
// Fixture — server.ts 가 watcher 에서 만들어 넘기는 모양 그대로의 태스크.
// description 만 사용하고 응답 본문은 받지 않는 계약(#f907fb65) 을 반영한다.
// ────────────────────────────────────────────────────────────────────────────
function task(agent: string, description: string): CompletedAgentTask {
  return { agent, description };
}

// ────────────────────────────────────────────────────────────────────────────
// (1) 단일 에이전트 완료 — subject 에 작업 요약, body 에 변경 파일 누락 없이
// ────────────────────────────────────────────────────────────────────────────

test('1. 단일 에이전트 — subject 에 에이전트·요약 포함, body 에 변경 파일 모두 노출', () => {
  const m = buildAgentsCompletedCommitMessage({
    tasks: [task('Thanos', 'fix: git-automation commit 단계 ident/잠금 가드 강화')],
    changedFiles: ['src/server/git/commitStep.ts', 'tests/git-automation.commit.spec.ts'],
  });

  // 제목 — chore(agents) scope + 에이전트 + 요약 본문 키워드.
  assert.match(m.subject, /^chore\(agents\): Thanos /, 'subject 는 chore(agents): Thanos … 형태');
  assert.match(m.subject, /git-automation/, 'description 본문 키워드가 subject 에 포함');
  assert.ok(m.subject.length <= SUBJECT_MAX_LEN, `subject(${m.subject.length}) 는 ${SUBJECT_MAX_LEN}자 이내`);
  // type 접두어(fix:) 는 subject 에서 제거돼야 한다 — chore(agents) scope 가 강제되므로.
  assert.doesNotMatch(m.subject, /fix:/);

  // 본문 — 단일 태스크는 항목 줄 중복 없이 변경 파일 섹션만.
  assert.doesNotMatch(m.body, /^- Thanos:/m, '단일 태스크는 본문에 항목 줄을 중복하지 않는다');
  assert.match(m.body, /변경 파일 \(총 2건\)/, '변경 파일 섹션이 총 건수와 함께 등장');
  assert.match(m.body, /- src\/server\/git\/commitStep\.ts/, '첫 변경 파일 누락 없이 본문 등장');
  assert.match(m.body, /- tests\/git-automation\.commit\.spec\.ts/, '두 번째 변경 파일도 누락 없이 등장');

  // full = subject + 빈 줄 + body.
  assert.equal(m.full, `${m.subject}\n\n${m.body}`, 'full 은 subject + 공백 줄 + body 결합');
});

test('1-2. 단일 에이전트 + 변경 파일 0건 — body 비어 있고 subject 만 노출', () => {
  // 문서 전용 태스크 등 changedFiles 가 비어 있는 분기. body 는 비어야 하고 full=subject.
  const m = buildAgentsCompletedCommitMessage({
    tasks: [task('Thanos', 'docs: commit 단계 회귀 시나리오 정리')],
    changedFiles: [],
  });
  assert.match(m.subject, /^chore\(agents\): Thanos /);
  assert.equal(m.body, '', '변경 파일이 없으면 본문은 비어 있다');
  assert.equal(m.full, m.subject);
});

// ────────────────────────────────────────────────────────────────────────────
// (2) 다중 에이전트 완료 — 모든 항목/모든 변경 파일이 본문에 반영
// ────────────────────────────────────────────────────────────────────────────

test('2. 다중 에이전트 — 모든 에이전트 항목과 모든 변경 파일이 본문에 반영(≤5건)', () => {
  const tasks = [
    task('Kai', 'leadership: 머지 정책 정리'),
    task('Thanos', 'feat: commit 단계 모듈화'),
    task('Developer', 'test: git-automation 회귀 spec 추가'),
  ];
  const changedFiles = [
    'server.ts',
    'src/server/git/commitMessageBuilder.ts',
    'tests/git-automation.spec.ts',
  ];

  const m = buildAgentsCompletedCommitMessage({ tasks, changedFiles });

  // 제목 — 대표 에이전트 두 명 + "외 1명" + 첫 태스크 요약.
  assert.match(m.subject, /^chore\(agents\): /);
  assert.match(m.subject, /Kai/);
  assert.match(m.subject, /Thanos/);
  assert.match(m.subject, /외 1명/);
  assert.ok(m.subject.length <= SUBJECT_MAX_LEN, `subject(${m.subject.length}) ≤ ${SUBJECT_MAX_LEN}자`);

  // 본문 — 모든 에이전트 항목이 누락 없이 노출.
  assert.match(m.body, /- Kai: /m);
  assert.match(m.body, /- Thanos: /m);
  assert.match(m.body, /- Developer: /m);
  // type 접두어(leadership:/feat:/test:) 는 본문 항목에서 제거.
  assert.doesNotMatch(m.body, /- Kai: leadership:/m);
  assert.doesNotMatch(m.body, /- Thanos: feat:/m);
  assert.doesNotMatch(m.body, /- Developer: test:/m);

  // 모든 변경 파일이 5건 이내라 ...외 N건 축약 없이 그대로 등장.
  assert.match(m.body, /변경 파일 \(총 3건\):/);
  for (const f of changedFiles) {
    assert.match(m.body, new RegExp(`- ${f.replace(/\./g, '\\.')}`), `변경 파일 ${f} 누락 없이 본문 등장`);
  }
  assert.doesNotMatch(m.body, /\.\.\.외 /, '5건 이내는 축약 라인이 붙지 않는다');

  // 본문 라인 길이 상한 강제.
  for (const line of m.body.split('\n')) {
    assert.ok(line.length <= BODY_LINE_MAX_LEN, `본문 라인(${line.length})이 ${BODY_LINE_MAX_LEN}자 초과: ${line}`);
  }
});

test('2-2. 다중 에이전트 + 변경 파일 6건 이상 — 상위 5개 + ...외 N건 으로 모두 카운트', () => {
  // 변경이 모두 본문에 "반영" 된다는 계약은 누적 카운트(총 N건) + 상위 5개 + 잔여 N건
  // 표기로 만족한다 — 한 건도 무성격으로 사라지지 않아야 회귀 잠금이 가치 있다.
  const files = Array.from({ length: 7 }, (_, i) => `src/file${i + 1}.ts`);
  const m = buildAgentsCompletedCommitMessage({
    tasks: [task('Thanos', 'feat: 대량 커밋'), task('Joker', 'fix: 후속 패치')],
    changedFiles: files,
  });

  // 총 7건 표기 + 상위 5 표시 + ...외 2건.
  assert.match(m.body, /변경 파일 \(총 7건, 상위 5\):/);
  for (let i = 1; i <= 5; i += 1) {
    assert.match(m.body, new RegExp(`- src/file${i}\\.ts`), `상위 ${i}번째 파일 노출`);
  }
  for (let i = 6; i <= 7; i += 1) {
    assert.doesNotMatch(m.body, new RegExp(`- src/file${i}\\.ts$`, 'm'), `${i}번째 파일은 축약 영역으로`);
  }
  assert.match(m.body, /\.\.\.외 2건/, '잔여 2건이 ...외 N건 으로 누적');

  // 두 에이전트 항목 모두 본문에 등장.
  assert.match(m.body, /- Thanos: /m);
  assert.match(m.body, /- Joker: /m);
});

test('2-3. 동일 파일이 staged·unstaged 양쪽에서 들어와도 본문은 1회만 — 누락 없이 dedupe', () => {
  // server.ts 의 watcher 가 staged/unstaged 두 소스에서 합쳐 넘기는 분기에서, 같은 파일이
  // 두 번 등장해도 사용자에게는 1줄만 보여야 한다(builder 의 dedupe 책임).
  const m = buildAgentsCompletedCommitMessage({
    tasks: [task('Thanos', 'feat: 동일 경로'), task('Joker', 'fix: 동일 경로')],
    changedFiles: ['src/dup.ts', 'src/dup.ts', 'src\\dup.ts'],
  });
  const occurrences = (m.body.match(/- src\/dup\.ts/g) || []).length;
  assert.equal(occurrences, 1, '동일 파일은 본문에 한 번만 노출');
  assert.match(m.body, /총 1건/, '카운트도 dedupe 후 1건');
  // 두 에이전트 항목은 그대로 살아 있어야 한다(dedupe 가 항목 수에는 영향 없음).
  assert.match(m.body, /- Thanos: /m);
  assert.match(m.body, /- Joker: /m);
});

// ────────────────────────────────────────────────────────────────────────────
// (3) 빈 변경 또는 실패 케이스 — fallback 메시지가 적절한지
// ────────────────────────────────────────────────────────────────────────────

test('3. 빈 변경 — tasks=[]·changedFiles=[] → 기본 fallback "chore: 변경 없음"', () => {
  const m = buildAgentsCompletedCommitMessage({ tasks: [], changedFiles: [] });
  assert.equal(m.subject, 'chore: 변경 없음');
  assert.equal(m.body, '');
  assert.equal(m.full, m.subject);
  assert.ok(m.subject.length <= SUBJECT_MAX_LEN);
});

test('3-2. description 이 공백/빈 문자열뿐 → 모두 무시 후 fallback 으로 폴백', () => {
  // server.ts 가 description 을 미리 trim 하지 못한 분기에서, 빌더가 빈 태스크를
  // 자동 필터링해 fallback 으로 폴백한다는 안전 그물(#f907fb65) 잠금.
  const m = buildAgentsCompletedCommitMessage({
    tasks: [task('Thanos', ''), task('Joker', '   ')],
    changedFiles: ['src/a.ts'],
  });
  assert.equal(m.subject, 'chore: 변경 없음');
  assert.equal(m.body, '', '유효 태스크가 없으면 변경 파일 섹션도 노출하지 않는다');
});

test('3-3. 명시 fallback 우선 — server.ts 가 강제하는 폴백 문구를 빌더가 그대로 사용', () => {
  // server.ts 의 watcher 가 (예: 빌더 진입 전) 이미 합의된 폴백 문구를 강제할 때.
  const m = buildAgentsCompletedCommitMessage({
    tasks: [],
    changedFiles: [],
    fallback: 'chore: all agents completed',
  });
  assert.equal(m.subject, 'chore: all agents completed', '명시 fallback 이 기본 fallback 보다 우선');
});

test('3-4. 비정상 입력에도 절대 throw 하지 않는다 — server.ts try/catch 폴백 보호 계약', () => {
  // 빌더가 throw 하면 server.ts:2295-2299 의 try/catch 가 'chore: all agents completed'
  // 로 폴백하지만, 그 폴백은 회귀 신호를 잃어버리는 마지막 수단이다. 빌더 자체는 어떤
  // 비정상 입력에서도 throw 하지 않아야 watcher 가 항상 동적 메시지를 만들 수 있다.
  const cases: Array<{ name: string; input: Parameters<typeof buildAgentsCompletedCommitMessage>[0] }> = [
    { name: 'tasks 미지정', input: { tasks: undefined as unknown as readonly CompletedAgentTask[], changedFiles: [] } },
    { name: 'changedFiles 미지정', input: { tasks: [task('Kai', 'feat: x')], changedFiles: undefined as unknown as readonly string[] } },
    { name: 'agent 빈 문자열', input: { tasks: [task('', 'feat: anonymous')], changedFiles: ['src/a.ts'] } },
    { name: 'fallback 빈 문자열', input: { tasks: [], changedFiles: [], fallback: '' } },
  ];
  for (const c of cases) {
    let result;
    assert.doesNotThrow(() => { result = buildAgentsCompletedCommitMessage(c.input); }, `[${c.name}] 빌더는 throw 금지`);
    // 폴백 분기로 가더라도 항상 비어 있지 않은 subject 를 돌려준다 — git commit -m 의
    // 빈 메시지 분기를 막는 마지막 가드.
    assert.ok(result, `[${c.name}] 결과 객체가 반환됨`);
    assert.ok(result!.subject.length > 0, `[${c.name}] subject 는 비어 있지 않다`);
    assert.ok(result!.subject.length <= SUBJECT_MAX_LEN, `[${c.name}] subject ≤ ${SUBJECT_MAX_LEN}자`);
  }
});

test('3-5. agent 가 빈 문자열인 단일 태스크 → unknown 으로 정규화돼 subject 보존', () => {
  // server.ts 가 익명 에이전트(예: 시스템 트리거) 의 태스크를 넘긴 경우에도 fallback
  // 으로 떨어지지 않고, 'unknown' 라벨로 정상 메시지를 만든다.
  const m = buildAgentsCompletedCommitMessage({
    tasks: [task('   ', 'feat: 익명 트리거')],
    changedFiles: ['src/a.ts'],
  });
  assert.match(m.subject, /^chore\(agents\): unknown /);
  assert.match(m.body, /변경 파일/);
});
