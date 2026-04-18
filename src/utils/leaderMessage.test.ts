// Run with: npx tsx --test src/utils/leaderMessage.test.ts
//
// QA: leaderMessage.ts 의 순수 헬퍼 계약을 한 파일로 고정한다.
// 기존 src/server/leaderDispatch.test.ts 는 taskRunner 의 리더 분기 전체를
// 시뮬레이션하는 "통합" 회귀이고, 이 파일은 렌더 헬퍼 4종(parse/summarize/
// classify/isAnswerOnly) + 배지 라벨 상수의 단위 계약을 직접 노출해
// UI(App.tsx·AgentContextBubble·AgentStatusPanel·AgentStatusSnapshot)가
// 기대하는 입출력을 독립적으로 보호한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLeaderPlanMessage,
  summarizeLeaderMessage,
  classifyLeaderMessage,
  isLeaderAnswerOnly,
  LEADER_ANSWER_ONLY_LABEL,
  LEADER_ANSWER_ONLY_TOOLTIP,
  LEADER_MESSAGE_KIND_LABEL,
  LEADER_MESSAGE_KIND_TOOLTIP,
  createImprovementReport,
  serializeImprovementReport,
  parseImprovementReport,
  formatImprovementReportForLeader,
  buildLeaderGitAutomationContext,
  type ImprovementReport,
} from './leaderMessage.ts';

// ---------------------------------------------------------------------------
// parseLeaderPlanMessage — 방어 경로 & 모드 추정.
// ---------------------------------------------------------------------------

test('parseLeaderPlanMessage: null/undefined/빈 문자열은 null 을 돌려준다', () => {
  assert.equal(parseLeaderPlanMessage(null), null);
  assert.equal(parseLeaderPlanMessage(undefined), null);
  assert.equal(parseLeaderPlanMessage(''), null);
});

test('parseLeaderPlanMessage: "{" 가 없는 자연어는 fast-cutoff 로 null', () => {
  // 말풍선 폴백 경로에서 원문을 그대로 내보내기 위한 계약 —
  // 일반 문장을 JSON.parse 시도에 흘리지 않는다.
  assert.equal(parseLeaderPlanMessage('오늘은 분배할 작업이 없습니다.'), null);
});

test('parseLeaderPlanMessage: "{" 는 있지만 유효 JSON 이 아니면 null', () => {
  assert.equal(parseLeaderPlanMessage('{ this is : not json }'), null);
});

test('parseLeaderPlanMessage: tasks 도 message 도 없는 유효 JSON 은 null', () => {
  // 빈 객체는 "의미 있는 plan" 이 아니므로 호출부가 원문 폴백을 쓰도록
  // null 을 반환해야 한다. 이 계약이 깨지면 말풍선에 빈 배지가 뜬다.
  assert.equal(parseLeaderPlanMessage('{}'), null);
  assert.equal(parseLeaderPlanMessage('{"unrelated":"value"}'), null);
});

test('parseLeaderPlanMessage: mode 누락 시 tasks 길이로 dispatch/reply 추정', () => {
  const dispatched = parseLeaderPlanMessage(
    JSON.stringify({ tasks: [{ assignedTo: 'dev-1', description: 'X' }] }),
  );
  assert.ok(dispatched);
  assert.equal(dispatched!.mode, 'dispatch');

  const replied = parseLeaderPlanMessage(
    JSON.stringify({ tasks: [], message: '답변입니다' }),
  );
  assert.ok(replied);
  assert.equal(replied!.mode, 'reply');
});

test('parseLeaderPlanMessage: mode 필드가 명시되면 tasks 길이보다 우선한다', () => {
  // "tasks 는 채워져 있지만 모델이 reply 로 선언" 한 경우 모델 의도를 존중한다.
  // reply 선언 시에도 원문 tasks 는 파싱 결과에 그대로 담겨 UI 가 참조할 수 있어야 한다.
  const reply = parseLeaderPlanMessage(
    JSON.stringify({
      mode: 'reply',
      message: '실행은 하지 않고 상황만 공유',
      tasks: [{ assignedTo: 'dev-1', description: '무시될 것' }],
    }),
  );
  assert.ok(reply);
  assert.equal(reply!.mode, 'reply');
  assert.equal(reply!.tasks.length, 1);

  const dispatch = parseLeaderPlanMessage(
    JSON.stringify({ mode: 'dispatch', tasks: [], message: '빈 분배' }),
  );
  assert.ok(dispatch);
  assert.equal(dispatch!.mode, 'dispatch');
});

test('parseLeaderPlanMessage: 알 수 없는 mode 값은 폴백 추정으로 돌아간다', () => {
  const plan = parseLeaderPlanMessage(
    JSON.stringify({
      mode: 'ANNOUNCE',
      tasks: [{ assignedTo: 'dev-1', description: 'x' }],
      message: 'm',
    }),
  );
  assert.ok(plan);
  // 모르는 모드는 무시하고 tasks 길이로 dispatch 추정.
  assert.equal(plan!.mode, 'dispatch');
});

test('parseLeaderPlanMessage: tasks 원소는 assignedTo/description 둘 다 문자열인 항목만 통과한다', () => {
  const plan = parseLeaderPlanMessage(
    JSON.stringify({
      tasks: [
        { assignedTo: 'dev-1', description: 'ok' },
        { assignedTo: 'dev-2' },                    // description 누락
        { description: '누구에게?' },               // assignedTo 누락
        { assignedTo: 7, description: 'number 할당' }, // 타입 불일치
        null,                                       // 비객체
      ],
    }),
  );
  assert.ok(plan);
  assert.equal(plan!.tasks.length, 1);
  assert.deepEqual(plan!.tasks[0], { assignedTo: 'dev-1', description: 'ok' });
});

test('parseLeaderPlanMessage: tasks 가 배열이 아니면 빈 배열로 정규화된다', () => {
  // 모델이 {"tasks":"none"} 같은 이상한 값을 줄 때도 UI 가 터지지 않게 하는 가드.
  const plan = parseLeaderPlanMessage(
    JSON.stringify({ tasks: 'none', message: '메시지만' }),
  );
  assert.ok(plan);
  assert.equal(plan!.tasks.length, 0);
  assert.equal(plan!.message, '메시지만');
});

test('parseLeaderPlanMessage: tasks 가 null 이면 빈 배열로 정규화되고, message 없으면 null 반환', () => {
  // 모델이 {"tasks": null} 을 돌려주는 실측 회귀. Array.isArray 가드로
  // 빈 배열 취급된 뒤, message 도 없으므로 의미 없는 plan → null.
  assert.equal(parseLeaderPlanMessage('{"tasks": null}'), null);
});

test('parseLeaderPlanMessage: 중괄호가 열린 채 잘린 응답은 null', () => {
  // 토큰 제한·네트워크 중단으로 JSON 이 끊기면 JSON.parse 가 throw → null 로 폴백.
  // 깨진 조각을 UI 에 흘려 보내면 말풍선에 반쪽 JSON 이 노출되는 사고를 막는다.
  assert.equal(parseLeaderPlanMessage('{"tasks":[{"assignedTo":"dev-1", '), null);
});

test('parseLeaderPlanMessage: 모든 task 엔트리가 타입 검증에서 탈락하고 message 도 없으면 null', () => {
  // 개별 필터는 assignedTo/description 타입을 요구한다(96행 테스트). 이 조합에
  // message 마저 없으면 tasks=[] + message 없음 → 의미 없는 plan 으로 null.
  assert.equal(
    parseLeaderPlanMessage('{"tasks":[{"assignedTo":7},{"description":9}]}'),
    null,
  );
});

test('parseLeaderPlanMessage: 원문에 JSON 이 어디에 박혀도 {…} 매칭으로 복원', () => {
  // 서버 taskRunner 가 원문 전체(앞뒤 자연어 포함)를 그대로 emit 할 때도
  // UI 가 JSON 부분만 뽑아 구조화할 수 있어야 한다.
  const mixed =
    '리더 계획입니다.\n' +
    JSON.stringify({ tasks: [], message: '상태 보고' }) +
    '\n---끝---';
  const plan = parseLeaderPlanMessage(mixed);
  assert.ok(plan);
  assert.equal(plan!.message, '상태 보고');
});

// ---------------------------------------------------------------------------
// summarizeLeaderMessage — 말풍선 한 줄 요약.
// ---------------------------------------------------------------------------

test('summarizeLeaderMessage: 빈 입력은 빈 문자열', () => {
  assert.equal(summarizeLeaderMessage(null), '');
  assert.equal(summarizeLeaderMessage(undefined), '');
  assert.equal(summarizeLeaderMessage(''), '');
});

test('summarizeLeaderMessage: 파싱 실패 시 원문 그대로', () => {
  // 말풍선은 빈 값보다 원문을 우선 노출해 "리더가 뭔가 말은 했다" 는
  // 신호를 잃지 않는다.
  assert.equal(summarizeLeaderMessage('그냥 자연어'), '그냥 자연어');
});

test('summarizeLeaderMessage: message 가 있으면 message 를 우선 노출', () => {
  const raw = JSON.stringify({
    tasks: [{ assignedTo: 'dev-1', description: '디테일 설명' }],
    message: '짧은 헤드라인',
  });
  assert.equal(summarizeLeaderMessage(raw), '짧은 헤드라인');
});

test('summarizeLeaderMessage: message 가 없으면 첫 task 의 description 으로 폴백', () => {
  const raw = JSON.stringify({
    tasks: [
      { assignedTo: 'dev-1', description: '첫 번째 업무' },
      { assignedTo: 'qa-1', description: '두 번째 업무' },
    ],
  });
  assert.equal(summarizeLeaderMessage(raw), '첫 번째 업무');
});

// ---------------------------------------------------------------------------
// classifyLeaderMessage — 배지/아이콘 분기.
// ---------------------------------------------------------------------------

test("classifyLeaderMessage: null/undefined/빈 문자열은 'plain'", () => {
  assert.equal(classifyLeaderMessage(null), 'plain');
  assert.equal(classifyLeaderMessage(undefined), 'plain');
  assert.equal(classifyLeaderMessage(''), 'plain');
});

test("classifyLeaderMessage: 리더 JSON 이 아닌 자유 텍스트는 'plain'", () => {
  assert.equal(classifyLeaderMessage('일반 채팅 문장'), 'plain');
  assert.equal(classifyLeaderMessage('{}'), 'plain'); // parse 가 null → plain
});

test("classifyLeaderMessage: mode='dispatch' 또는 tasks 가 있으면 'delegate'", () => {
  const withTasks = JSON.stringify({
    tasks: [{ assignedTo: 'dev-1', description: 'X' }],
  });
  assert.equal(classifyLeaderMessage(withTasks), 'delegate');

  const dispatchMode = JSON.stringify({
    mode: 'dispatch',
    tasks: [],
    message: '빈 분배 선언',
  });
  assert.equal(classifyLeaderMessage(dispatchMode), 'delegate');
});

test("classifyLeaderMessage: mode='reply' 또는 message 만 있으면 'reply'", () => {
  const replyMode = JSON.stringify({
    mode: 'reply',
    tasks: [],
    message: '답만 합니다',
  });
  assert.equal(classifyLeaderMessage(replyMode), 'reply');

  const messageOnly = JSON.stringify({ tasks: [], message: '상황 공유' });
  assert.equal(classifyLeaderMessage(messageOnly), 'reply');
});

// ---------------------------------------------------------------------------
// isLeaderAnswerOnly — taskRunner 의 'agent:messaged' 플래그 계산에 쓰는 래퍼.
// ---------------------------------------------------------------------------

test('isLeaderAnswerOnly: reply 계열만 true, 나머지는 false', () => {
  assert.equal(
    isLeaderAnswerOnly(JSON.stringify({ tasks: [], message: '답만' })),
    true,
  );
  assert.equal(
    isLeaderAnswerOnly(
      JSON.stringify({ mode: 'reply', tasks: [], message: '답만' }),
    ),
    true,
  );
  assert.equal(
    isLeaderAnswerOnly(
      JSON.stringify({
        tasks: [{ assignedTo: 'dev-1', description: 'x' }],
      }),
    ),
    false,
  );
  assert.equal(isLeaderAnswerOnly('자연어'), false);
  assert.equal(isLeaderAnswerOnly(null), false);
});

// ---------------------------------------------------------------------------
// LEADER_ANSWER_ONLY_LABEL — 세 군데 UI 가 공유하는 단일 라벨.
// ---------------------------------------------------------------------------

test('LEADER_ANSWER_ONLY_LABEL: 한국어 "답변 전용" 상수 고정', () => {
  // App.tsx / AgentContextBubble / AgentStatusPanel 이 모두 이 상수를 읽는다.
  // 라벨이 영어화되거나 빈 문자열이 되면 세 군데의 배지 라벨이 동시에 사라진다.
  assert.equal(LEADER_ANSWER_ONLY_LABEL, '답변 전용');
  assert.ok(LEADER_ANSWER_ONLY_LABEL.length > 0);
});

test('LEADER_ANSWER_ONLY_TOOLTIP: "답변 전용" 배지 3곳이 공유하는 호버 문구', () => {
  // App.tsx 로그 패널 / AgentContextBubble 헤더 / AgentStatusPanel 에이전트 행의
  // 세 배지가 같은 호버 문구를 써 어휘 드리프트를 차단한다. 빈 문자열이 되면
  // 세 곳의 툴팁이 동시에 사라지고, 반대로 "답변"·"분배" 키워드가 모두 빠지면
  // 사용자가 배지의 의미를 유추할 수 없게 되므로 두 키워드 포함을 고정한다.
  assert.ok(typeof LEADER_ANSWER_ONLY_TOOLTIP === 'string');
  assert.ok(LEADER_ANSWER_ONLY_TOOLTIP.length >= 12, '툴팁이 너무 짧다');
  assert.match(LEADER_ANSWER_ONLY_TOOLTIP, /답/);
  assert.match(LEADER_ANSWER_ONLY_TOOLTIP, /분배/);
});

// ---------------------------------------------------------------------------
// LEADER_MESSAGE_KIND_LABEL / TOOLTIP — mix-chip 표기 단일 출처 (디자이너 합의).
// 여러 패널(AgentStatusSnapshot, 로그 패널 배지 등) 에서 같은 kind 를 서로 다른
// 문구로 표기하면 같은 개념을 중복 학습하게 되므로, 라벨/툴팁을 이 두 상수로
// 수렴시킨다. 테스트는 "세 kind 에 대해 비어 있지 않은 문구가 존재" 와
// "분배·답변·일반 의미가 뒤섞이지 않음(label 중복 금지)" 을 고정한다.
// ---------------------------------------------------------------------------

test('LEADER_MESSAGE_KIND_LABEL: 세 kind 모두 비어 있지 않은 한국어 라벨을 가진다', () => {
  assert.ok(LEADER_MESSAGE_KIND_LABEL.delegate && LEADER_MESSAGE_KIND_LABEL.delegate.length > 0);
  assert.ok(LEADER_MESSAGE_KIND_LABEL.reply && LEADER_MESSAGE_KIND_LABEL.reply.length > 0);
  assert.ok(LEADER_MESSAGE_KIND_LABEL.plain && LEADER_MESSAGE_KIND_LABEL.plain.length > 0);
});

test('LEADER_MESSAGE_KIND_LABEL: 각 라벨은 서로 달라 UI 에서 구분 가능해야 한다', () => {
  const labels = [
    LEADER_MESSAGE_KIND_LABEL.delegate,
    LEADER_MESSAGE_KIND_LABEL.reply,
    LEADER_MESSAGE_KIND_LABEL.plain,
  ];
  const unique = new Set(labels);
  assert.equal(unique.size, labels.length, '세 kind 라벨이 서로 달라야 한다');
});

test('LEADER_MESSAGE_KIND_TOOLTIP: 세 kind 모두 1문장 이상 길이의 설명을 가진다', () => {
  for (const kind of ['delegate', 'reply', 'plain'] as const) {
    const tooltip = LEADER_MESSAGE_KIND_TOOLTIP[kind];
    assert.ok(typeof tooltip === 'string' && tooltip.length >= 8, `${kind} tooltip 이 너무 짧다: ${tooltip}`);
  }
});

test('LEADER_MESSAGE_KIND_TOOLTIP: delegate/reply 툴팁은 서로 의미가 겹치지 않는다', () => {
  // delegate 는 "분배", reply 는 "분배 없이" 같은 반대 개념을 담아야 한다.
  // 같은 문구를 복붙하면 UI 에서 구분 의미가 사라지므로 이 회귀를 고정.
  assert.notEqual(
    LEADER_MESSAGE_KIND_TOOLTIP.delegate,
    LEADER_MESSAGE_KIND_TOOLTIP.reply,
  );
  assert.match(LEADER_MESSAGE_KIND_TOOLTIP.delegate, /분배/);
  assert.match(LEADER_MESSAGE_KIND_TOOLTIP.reply, /답/);
});

// ---------------------------------------------------------------------------
// ImprovementReport — agentWorker → taskRunner → leaderDispatch 파이프라인의
// 직렬화 계약. 리포트가 왕복 통과할 때 필수 필드가 손실되면 리더가 출처를 잃고
// 임의 태스크가 생성되므로 schema/summary/agentId/projectId 는 반드시 유지.
// ---------------------------------------------------------------------------

test('createImprovementReport: summary 가 비거나 agentId/projectId 누락이면 null', () => {
  assert.equal(
    createImprovementReport({ agentId: 'a', projectId: 'p', summary: '' }),
    null,
  );
  assert.equal(
    createImprovementReport({ agentId: 'a', projectId: 'p', summary: '   ' }),
    null,
  );
  assert.equal(
    createImprovementReport({ agentId: '', projectId: 'p', summary: '개선점' }),
    null,
  );
  assert.equal(
    createImprovementReport({ agentId: 'a', projectId: '', summary: '개선점' }),
    null,
  );
});

test('createImprovementReport: 기본값(schema/category/at/focusFiles) 을 채운다', () => {
  const report = createImprovementReport({
    agentId: 'dev-1',
    projectId: 'proj-1',
    summary: '로그인 폼 ARIA 레이블 보강',
  });
  assert.ok(report);
  assert.equal(report!.schema, 'improvement-report/1');
  assert.equal(report!.category, 'other');
  assert.deepEqual(report!.focusFiles, []);
  assert.ok(typeof report!.at === 'number' && report!.at > 0);
});

test('createImprovementReport: focusFiles 는 중복 제거 후 상한(8) 으로 잘린다', () => {
  const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
  const dup = [...files, 'src/f0.ts', '  src/f1.ts  ', ''];
  const report = createImprovementReport({
    agentId: 'a',
    projectId: 'p',
    summary: 'x',
    focusFiles: dup,
  });
  assert.ok(report);
  assert.equal(report!.focusFiles.length, 8);
  // 중복/빈 문자열이 제거되고 trim 된 경로가 살아남는다.
  assert.ok(report!.focusFiles.includes('src/f0.ts'));
  assert.ok(report!.focusFiles.includes('src/f1.ts'));
});

test('createImprovementReport: 알 수 없는 category 는 "other" 로 폴백', () => {
  const report = createImprovementReport({
    agentId: 'a',
    projectId: 'p',
    summary: 'x',
    // @ts-expect-error - 허용되지 않는 값 계약 확인
    category: 'unknown',
  });
  assert.ok(report);
  assert.equal(report!.category, 'other');
});

test('serialize → parse 왕복: 모든 필수 필드가 보존된다', () => {
  const src = createImprovementReport({
    agentId: 'dev-1',
    projectId: 'proj-1',
    agentName: 'Joker',
    role: 'Developer',
    summary: 'LoginForm 에 빈 이메일 가드 추가',
    detail: '제출 핸들러에서 trim 후 길이 체크',
    category: 'bug',
    focusFiles: ['src/components/LoginForm.tsx'],
    taskId: 't-1',
    at: 1700000000000,
  });
  assert.ok(src);
  const json = serializeImprovementReport(src!);
  const back = parseImprovementReport(json);
  assert.ok(back);
  assert.deepEqual(back, src);
});

test('parseImprovementReport: null/빈 문자열/schema 마커 없는 텍스트는 null', () => {
  assert.equal(parseImprovementReport(null), null);
  assert.equal(parseImprovementReport(undefined), null);
  assert.equal(parseImprovementReport(''), null);
  assert.equal(parseImprovementReport('일반 자연어 문장입니다.'), null);
  // improvement-report 마커가 없으면 fast-cutoff.
  assert.equal(
    parseImprovementReport('{"schema":"other","summary":"x"}'),
    null,
  );
});

test('parseImprovementReport: schema 불일치 / 필수 필드 누락은 null', () => {
  assert.equal(
    parseImprovementReport('{"schema":"improvement-report/1"}'),
    null,
  );
  assert.equal(
    parseImprovementReport(
      '{"schema":"improvement-report/1","agentId":"a","projectId":"p"}',
    ),
    null,
    'summary 누락 → null',
  );
  assert.equal(
    parseImprovementReport(
      '{"schema":"improvement-report/1","summary":"x","projectId":"p"}',
    ),
    null,
    'agentId 누락 → null',
  );
});

test('parseImprovementReport: 깨진 JSON 꼬리는 null 로 폴백 (throw 금지)', () => {
  const broken =
    '{"schema":"improvement-report/1","agentId":"a","projectId":"p","summary":"x"';
  assert.equal(parseImprovementReport(broken), null);
});

test('parseImprovementReport: 잡음 섞인 로그에서도 첫 JSON 블록만 복원한다', () => {
  const noisy =
    '[worker] 턴 종료\n' +
    '{"schema":"improvement-report/1","agentId":"a","projectId":"p","summary":"간결화","focusFiles":[],"category":"refactor","at":1}\n' +
    '--- end ---';
  const report = parseImprovementReport(noisy);
  assert.ok(report);
  assert.equal(report!.summary, '간결화');
  assert.equal(report!.category, 'refactor');
});

test('formatImprovementReportForLeader: 보고자/요약/관련 파일이 한국어 본문에 포함된다', () => {
  const report: ImprovementReport = {
    schema: 'improvement-report/1',
    agentId: 'dev-1',
    agentName: 'Joker',
    role: 'Developer',
    projectId: 'p',
    taskId: 't-1',
    focusFiles: ['src/components/LoginForm.tsx'],
    category: 'refactor',
    summary: '제출 핸들러 분리',
    detail: '커스텀 훅으로 추출',
    at: 1,
  };
  const body = formatImprovementReportForLeader(report);
  assert.match(body, /\[개선 보고\]/);
  assert.match(body, /Joker\(Developer\)/);
  assert.match(body, /제출 핸들러 분리/);
  assert.match(body, /리팩터링/);
  assert.match(body, /src\/components\/LoginForm\.tsx/);
  assert.match(body, /mode="reply"/);
});

test('formatImprovementReportForLeader: 보고자 이름이 없으면 agentId 로 폴백', () => {
  const report: ImprovementReport = {
    schema: 'improvement-report/1',
    agentId: 'dev-999',
    projectId: 'p',
    focusFiles: [],
    category: 'other',
    summary: 'x',
    at: 1,
  };
  const body = formatImprovementReportForLeader(report);
  assert.match(body, /dev-999/);
});

// ---------------------------------------------------------------------------
// buildLeaderGitAutomationContext — 팀원 완료 이벤트를 수신한 리더가 runGitAutomation
// (MCP trigger_git_automation 동일 경로) 에 넘길 context 를 구성하는 순수 함수.
// category → conventional commit type 매핑과 summary 절단·보고자 폴백 규칙을 고정한다.
// 이 계약이 무너지면 리더가 커밋을 보내도 브랜치·메시지·작성자 정보가 일관되지 않게
// 기록되어, tests/auto-commit-no-fire-repro.md 의 침묵 회귀 조사가 어려워진다.
// ---------------------------------------------------------------------------

function reportOf(partial: Partial<ImprovementReport>): ImprovementReport {
  return {
    schema: 'improvement-report/1',
    agentId: 'dev-1',
    projectId: 'p',
    focusFiles: [],
    category: 'other',
    summary: 'x',
    at: 1,
    ...partial,
  };
}

test('buildLeaderGitAutomationContext: category → conventional commit type 매핑', () => {
  // 6개 카테고리 전부 고정. 새 카테고리가 생기면 이 테이블이 먼저 터지도록 의도.
  const cases: Array<[ImprovementReport['category'], string]> = [
    ['bug', 'fix'],
    ['refactor', 'refactor'],
    ['doc', 'docs'],
    ['test', 'test'],
    ['followup', 'chore'],
    ['other', 'chore'],
  ];
  for (const [category, expectedType] of cases) {
    const ctx = buildLeaderGitAutomationContext(
      reportOf({ category, summary: '요약' }),
      'Joker',
    );
    assert.equal(ctx.type, expectedType, `category=${category} 에서 type 매핑이 ${expectedType} 이어야 한다`);
  }
});

test('buildLeaderGitAutomationContext: summary 는 64자 상한, 공백만 있으면 "auto update" 폴백', () => {
  const long = '가'.repeat(120);
  const ctxLong = buildLeaderGitAutomationContext(reportOf({ summary: long }), 'A');
  assert.equal(ctxLong.summary.length, 64, 'summary 는 64자로 잘려야 브랜치/커밋 메시지가 안전하다');

  const ctxBlank = buildLeaderGitAutomationContext(reportOf({ summary: '   ' } as any), 'A');
  assert.equal(ctxBlank.summary, 'auto update');
});

test('buildLeaderGitAutomationContext: agent 는 report.agentName → reporterName → "unknown" 순 폴백', () => {
  const withName = buildLeaderGitAutomationContext(
    reportOf({ agentName: 'Joker', summary: 'x' }),
    'fallback',
  );
  assert.equal(withName.agent, 'Joker', 'report.agentName 이 있으면 그대로 쓴다');

  const withoutName = buildLeaderGitAutomationContext(
    reportOf({ agentName: undefined, summary: 'x' }),
    'fallbackName',
  );
  assert.equal(withoutName.agent, 'fallbackName', 'agentName 비면 reporterName 으로 폴백');

  const allMissing = buildLeaderGitAutomationContext(
    reportOf({ agentName: '', summary: 'x' }),
    '',
  );
  assert.equal(allMissing.agent, 'unknown', '둘 다 비면 "unknown" 으로 고정해 커밋 작성자 필드가 누락되지 않게 한다');

  const nullishReporter = buildLeaderGitAutomationContext(
    reportOf({ agentName: '   ', summary: 'x' }),
    null,
  );
  assert.equal(nullishReporter.agent, 'unknown');
});

test('buildLeaderGitAutomationContext: 알 수 없는 category 도 chore 로 안전 폴백', () => {
  // 타입 시스템 밖에서 흘러 들어온 값(예: 구버전 DB 레코드)이 와도 runGitAutomation
  // 호출이 터지지 않고 기본 chore 로 돌아야 한다.
  const rogue = buildLeaderGitAutomationContext(
    // @ts-expect-error — 계약 위반 입력에 대한 방어 경로 테스트
    reportOf({ category: 'wtf', summary: '이상한 카테고리' }),
    'A',
  );
  assert.equal(rogue.type, 'chore');
});
