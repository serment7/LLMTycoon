// Run with: npx tsx --test src/server/leaderDispatch.test.ts
//
// QA: 리더 응답 분기(user question vs. work-distribution) 회귀 고정.
// src/server/taskRunner.ts 의 dispatchTask() 가 리더 태스크를 처리할 때
// extractLeaderPlan() 결과의 두 갈래 — (A) tasks 가 빈 배열인 단순 질문 응답,
// (B) tasks 가 채워진 실제 분배 응답 — 에서 각각
//   1) 자식 태스크 생성 건수
//   2) 리더/팀원 상태 전이(working ↔ idle)
//   3) 'agent:messaged' 로 UI 에 흘러갈 displayText
// 를 전부 고정한다. taskRunner 전체를 Mongo 까지 물고 띄우지 않도록, dispatch
// 내부의 분배 루프만 순수 함수 형태로 시뮬레이션한다. taskRunner.ts 의 원본
// 로직과 한 줄씩 대응되므로, 원본이 바뀌면 시뮬레이터도 함께 수정해 계약을
// 이중으로 가둬둔다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLeaderPlanPrompt, extractLeaderPlan } from './prompts.ts';
import {
  ProjectCompletionTracker,
  evaluateAgentsCompletion,
} from './completionWatcher.ts';
import {
  buildLeaderGitAutomationContext,
  createImprovementReport,
  formatImprovementReportForLeader,
  parseLeaderPlanMessage,
  summarizeLeaderMessage,
  type ImprovementReport,
  type LeaderGitAutomationContext,
} from '../utils/leaderMessage.ts';
import type { Agent, Project, Task } from '../types.ts';
import type { GitAutomationRunResult } from '../utils/gitAutomation.ts';

// ---------------------------------------------------------------------------
// 시뮬레이터 — taskRunner.dispatchTask 의 리더 분기와 1:1 대응.
// ---------------------------------------------------------------------------

interface EmittedMessage {
  agentId: string;
  message: string;
}

interface DispatchOutcome {
  childTasks: Task[];
  emits: EmittedMessage[];
  leaderFinalStatus: Agent['status'];
  memberFinalStatuses: Array<{ id: string; status: Agent['status'] }>;
  displayText: string;
}

function simulateLeaderBranch(
  leader: Agent,
  peers: Agent[],
  project: Pick<Project, 'id' | 'agents'>,
  rawLeaderResponse: string,
): DispatchOutcome {
  // taskRunner 와 동일하게: working 상태에서 시작해 JSON 파싱 후
  // parsed.tasks.length 분기 → displayText 계산 → idle 복귀.
  const leaderState: Agent = { ...leader, status: 'working' };
  const memberStates = peers.map(p => ({ ...p, status: p.status }));

  const parsed = extractLeaderPlan(rawLeaderResponse);
  const childTasks: Task[] = [];
  let displayText: string;

  if (parsed) {
    // reply 모드 또는 빈 tasks 는 "단순 답변" 경로 — 자식 태스크를 만들지 않는다.
    const isReplyOnly = parsed.mode === 'reply' || parsed.tasks.length === 0;
    if (!isReplyOnly) {
      for (const t of parsed.tasks) {
        if (!project.agents?.includes(t.assignedTo)) continue;
        // taskRunner.ts 와 동일한 child 태스크 형태(실제 uuid 는 생략).
        childTasks.push({
          id: `child-${childTasks.length + 1}`,
          projectId: project.id,
          assignedTo: t.assignedTo,
          description: t.description,
          status: 'pending',
          source: 'leader',
        });
      }
    }
    if (isReplyOnly) {
      const reply = parsed.message?.trim();
      displayText = reply || '리더가 이번 지시에는 별도의 분배 없이 상황만 확인했습니다.';
    } else {
      const nameById = new Map(peers.map(p => [p.id, p.name]));
      const briefings = parsed.tasks.map(
        t => `@${nameById.get(t.assignedTo) ?? t.assignedTo}: ${t.description}`,
      );
      const parts: string[] = [];
      const headline = parsed.message?.trim();
      if (headline) parts.push(headline);
      if (briefings.length > 0) parts.push(...briefings);
      displayText = parts.length > 0
        ? parts.join('\n')
        : '리더가 지금은 분배할 업무를 찾지 못했습니다.';
    }
  } else {
    displayText = '리더 응답을 해석하지 못해 이번 지시는 분배를 건너뜁니다.';
  }

  const clipped = displayText.slice(0, 400);
  const emits: EmittedMessage[] = [{ agentId: leaderState.id, message: clipped }];

  // 리더 자신의 태스크는 completed → idle 복귀. 팀원 상태는 child 태스크가 이후
  // dispatch 되기 전까지는 건드리지 않는다(시뮬레이터 기준: 이번 턴에는 pending 만).
  leaderState.status = 'idle';

  return {
    childTasks,
    emits,
    leaderFinalStatus: leaderState.status,
    memberFinalStatuses: memberStates.map(m => ({ id: m.id, status: m.status })),
    displayText: clipped,
  };
}

// ---------------------------------------------------------------------------
// 공용 픽스처.
// ---------------------------------------------------------------------------

const LEADER: Agent = {
  id: 'leader-1',
  name: '리더',
  role: 'Leader',
  spriteTemplate: '',
  persona: '팀의 진행을 조율한다',
  status: 'idle',
  x: 0, y: 0,
};

const MEMBERS: Agent[] = [
  { id: 'dev-1', name: 'Joker', role: 'Developer', spriteTemplate: '', persona: '', status: 'idle', x: 0, y: 0 },
  { id: 'qa-1',  name: 'Gamma', role: 'QA',        spriteTemplate: '', persona: '', status: 'idle', x: 0, y: 0 },
];

const PROJECT: Pick<Project, 'id' | 'agents'> = {
  id: 'proj-leader-branch',
  agents: [LEADER.id, ...MEMBERS.map(m => m.id)],
};

// ---------------------------------------------------------------------------
// 시나리오 A — 단순 질문: tasks=[], message 만 채워진 응답.
// ---------------------------------------------------------------------------

test('시나리오 A — 단순 질문: tasks 빈 배열 + message 만 있는 리더 응답은 자식 태스크 0건을 만들고 리더/팀원이 idle 로 복귀한다', () => {
  const raw = JSON.stringify({
    tasks: [],
    message: '현재 상태: 모든 팀원이 대기 중이고 분배할 긴급 업무가 없습니다.',
  });

  const out = simulateLeaderBranch(LEADER, MEMBERS, PROJECT, raw);

  // (1) 자식 태스크 생성 0건.
  assert.equal(out.childTasks.length, 0, '빈 tasks 응답에서 자식 태스크가 생성되면 안 된다');
  // (2) 리더는 idle, 팀원은 원래 상태(idle) 를 유지.
  assert.equal(out.leaderFinalStatus, 'idle');
  for (const m of out.memberFinalStatuses) {
    assert.equal(m.status, 'idle', `팀원 ${m.id} 가 idle 이 아니다`);
  }
  // (3) UI 로 흘려질 메시지는 parsed.message 를 그대로 쓴다.
  assert.equal(
    out.displayText,
    '현재 상태: 모든 팀원이 대기 중이고 분배할 긴급 업무가 없습니다.',
  );
  // (4) 'agent:messaged' 는 리더 1회만 발사.
  assert.equal(out.emits.length, 1);
  assert.equal(out.emits[0].agentId, LEADER.id);
});

test('시나리오 A 회귀 — summarizeLeaderMessage 는 JSON raw 에서도 message 만 뽑아 채팅 UI 한 줄로 노출한다', () => {
  // App.tsx / AgentContextBubble 가 소켓으로 받은 원문을 렌더할 때 쓰는 경로.
  // 이 계약이 깨지면 사용자에게 '{"tasks":[],"message":"…"}' 덩어리가 그대로 보인다.
  const raw = JSON.stringify({
    tasks: [],
    message: '현재 상태 알려드립니다: 팀원 모두 idle, 진행 중 작업 없음.',
  });
  const summary = summarizeLeaderMessage(raw);
  assert.equal(summary, '현재 상태 알려드립니다: 팀원 모두 idle, 진행 중 작업 없음.');

  const plan = parseLeaderPlanMessage(raw);
  assert.ok(plan);
  assert.equal(plan!.tasks.length, 0);
  assert.equal(plan!.message, '현재 상태 알려드립니다: 팀원 모두 idle, 진행 중 작업 없음.');
});

// ---------------------------------------------------------------------------
// 시나리오 B — 실제 분배: tasks 가 채워진 응답.
// ---------------------------------------------------------------------------

test('시나리오 B — 실제 지시: tasks 가 채워진 응답은 팀원 각각에 자식 태스크를 만들고 리더 본인은 idle 로 복귀한다', () => {
  const raw = JSON.stringify({
    tasks: [
      { assignedTo: 'dev-1', description: 'LoginForm 유효성 검증 보강' },
      { assignedTo: 'qa-1',  description: '로그인 플로우 QA 시나리오 확장' },
    ],
    message: '로그인 흐름 개선 작업을 팀에 분배합니다',
  });

  const out = simulateLeaderBranch(LEADER, MEMBERS, PROJECT, raw);

  // (1) 팀원 수 만큼 자식 태스크 생성.
  assert.equal(out.childTasks.length, 2);
  assert.deepEqual(
    out.childTasks.map(t => t.assignedTo).sort(),
    ['dev-1', 'qa-1'],
  );
  for (const t of out.childTasks) {
    assert.equal(t.status, 'pending');
    assert.equal(t.source, 'leader');
  }
  // (2) 리더 본인은 즉시 idle 복귀(자식은 이후 dispatch 틱에 올라간다).
  assert.equal(out.leaderFinalStatus, 'idle');
  // (3) 메시지에는 headline + @이름 브리핑이 합쳐져 노출된다.
  assert.match(out.displayText, /^로그인 흐름 개선 작업을 팀에 분배합니다/);
  assert.match(out.displayText, /@Joker: LoginForm/);
  assert.match(out.displayText, /@Gamma: 로그인 플로우 QA/);
});

test('시나리오 B 회귀 — 프로젝트 멤버가 아닌 assignedTo 는 스킵되어 child 가 만들어지지 않는다', () => {
  const raw = JSON.stringify({
    tasks: [
      { assignedTo: 'dev-1',  description: '정상 할당' },
      { assignedTo: 'ghost',  description: '유령 에이전트에게 할당된 잘못된 태스크' },
    ],
    message: '분배합니다',
  });
  const out = simulateLeaderBranch(LEADER, MEMBERS, PROJECT, raw);
  assert.equal(out.childTasks.length, 1, '멤버가 아닌 assignedTo 는 스킵되어야 한다');
  assert.equal(out.childTasks[0].assignedTo, 'dev-1');
});

// ---------------------------------------------------------------------------
// 파싱 실패 / 방어 경로.
// ---------------------------------------------------------------------------

test('파싱 실패 — JSON 이 아니면 fallback 메시지로 차단되고 자식 태스크는 0건', () => {
  const raw = '그냥 자연어 문장입니다. JSON 아닙니다.';
  const out = simulateLeaderBranch(LEADER, MEMBERS, PROJECT, raw);
  assert.equal(out.childTasks.length, 0);
  assert.equal(out.leaderFinalStatus, 'idle');
  assert.equal(out.displayText, '리더 응답을 해석하지 못해 이번 지시는 분배를 건너뜁니다.');
});

test('파싱 성공 + tasks/message 둘 다 비었을 때는 reply 경로 폴백 문구로 사용자에게 신호를 준다', () => {
  // 빈 JSON {} 은 extractLeaderPlan 이 tasks=[] 로 복원 — mode 는 reply 로 추정된다.
  // message 도 없으므로 reply 경로의 고정 폴백 문구로 넘어간다.
  const raw = '{}';
  const out = simulateLeaderBranch(LEADER, MEMBERS, PROJECT, raw);
  assert.equal(out.childTasks.length, 0);
  assert.equal(out.displayText, '리더가 이번 지시에는 별도의 분배 없이 상황만 확인했습니다.');
});

// ---------------------------------------------------------------------------
// 프롬프트 계약 — buildLeaderPlanPrompt 가 "빈 tasks 배열" 규칙을 명문화한다.
// 모델이 이 규칙을 학습 없이도 따르게 하려면 프롬프트 본문에 직접 기재돼야 한다.
// 문구가 지워지면 리더가 단순 질문에도 억지로 태스크를 만들어 팀이 오염된다.
// ---------------------------------------------------------------------------

test('프롬프트 회귀 — buildLeaderPlanPrompt 는 "빈 배열/메시지만" 규칙과 JSON 출력 예제를 포함한다', () => {
  const prompt = buildLeaderPlanPrompt({
    agent: LEADER,
    project: { id: 'p', name: 'Demo', description: 'd', agents: [], workspacePath: '' } as Project,
    peers: MEMBERS,
    trigger: 'user-command',
    userCommand: '현재 상태 알려줘',
  });
  // 현행 프롬프트는 mode="dispatch"/"reply" 분기로 빈 배열 규칙을 명시한다.
  // 문구가 다소 바뀌어도 "빈 배열" 키워드와 reply/dispatch 분기는 남아 있어야 한다.
  assert.match(prompt, /빈 배열/);
  assert.match(prompt, /mode="reply"|reply/);
  assert.match(prompt, /JSON 형식/);
  // 사용자 커맨드가 프롬프트에 그대로 흘러 들어가야 한다.
  assert.match(prompt, /현재 상태 알려줘/);
});

// ---------------------------------------------------------------------------
// 상태 복귀 불변 — 빈 tasks 경로든 채워진 tasks 경로든, 리더 본인의 최종 상태는
// 항상 idle. 이 불변이 깨지면 리더가 영원히 working 으로 고착돼 다음 user-command
// 가 enqueue 되지 못한다.
// ---------------------------------------------------------------------------

test('상태 복귀 불변 — 어떤 리더 응답이어도 시뮬레이션 종료 시 리더는 idle 로 복귀한다', () => {
  const samples = [
    JSON.stringify({ tasks: [], message: '상태 요약만' }),
    JSON.stringify({ tasks: [{ assignedTo: 'dev-1', description: 'x' }], message: '분배' }),
    '{}',
    'not-json',
  ];
  for (const raw of samples) {
    const out = simulateLeaderBranch(LEADER, MEMBERS, PROJECT, raw);
    assert.equal(out.leaderFinalStatus, 'idle', `raw=${raw} 에서 리더가 idle 로 복귀하지 않았다`);
  }
});

// ---------------------------------------------------------------------------
// 리더 프롬프트 — 에이전트 개선 보고 재분배 로직 회귀 고정.
// 이 문구들이 없으면 리더가 완료 보고를 받고도 후속 분배를 생략해, 전체 팀이
// "개선 한 건 → 수면" 상태로 빠지는 회귀가 생긴다. prompts.ts 의 해당 섹션이
// 사라지거나 키워드가 바뀌면 이 테스트가 먼저 터진다.
// ---------------------------------------------------------------------------

test('프롬프트 회귀 — buildLeaderPlanPrompt 는 "개선 보고 수신 시 재분배" 섹션과 QA/Developer 연계 규칙을 포함한다', () => {
  const prompt = buildLeaderPlanPrompt({
    agent: LEADER,
    project: { id: 'p', name: 'Demo', description: 'd', agents: [], workspacePath: '' } as Project,
    peers: MEMBERS,
    trigger: 'user-command',
    userCommand: 'dev-1 이 LoginForm 유효성 검증 개선을 완료했습니다',
  });
  // 섹션 헤더 자체.
  assert.match(prompt, /재분배/);
  // QA 회귀 시나리오·연관 모듈 점검을 언급해야 "후속 dispatch 대상" 이 명확해진다.
  assert.match(prompt, /QA/);
  assert.match(prompt, /(회귀|시나리오)/);
  // 한 번만 재분배한다는 중복 금지 규칙.
  assert.match(prompt, /중복 분배 금지|한 번만 재분배/);
});

// ---------------------------------------------------------------------------
// allAgentsCompletedWatcher 통합 — 프로젝트 에이전트들이 모두 idle 로 수렴하는
// rising-edge 에서 정확히 1회만 git 자동화가 트리거되는지 검증. server.ts 의
// executeGitAutomation 을 직접 띄우지 않도록, tracker 에 "fire 했다면 카운터 증가"
// 로직을 달아 호출 횟수를 관찰한다.
// ---------------------------------------------------------------------------

test('allAgentsCompletedWatcher — 전원 idle 로 수렴하는 첫 전이에서만 자동화가 1회 발사된다', () => {
  const tracker = new ProjectCompletionTracker();
  const projectId = 'proj-watcher';
  let fired = 0;
  const tick = (statuses: Agent['status'][]) => {
    const { fire } = tracker.observe(projectId, statuses);
    if (fire) fired++;
  };
  // 1) 초기 관측 — 아무도 working 중이 아닌 idle 상태에서 트래커가 처음 만난다.
  //    rising-edge 규칙: previousPhase 가 undefined 인 첫 관측은 fire 하지 않는다.
  tick(['idle', 'idle']);
  assert.equal(fired, 0, '첫 관측부터 fire 하면 기동 직후마다 자동화가 돌아 사고 난다');
  // 2) 실제 작업 개시 — 누군가 working 으로 바뀐 시점. phase 는 busy 로 내려간다.
  tick(['working', 'idle']);
  assert.equal(fired, 0);
  // 3) 모든 에이전트가 idle 로 돌아온다 — busy → completed 전이. 여기서 1회 fire.
  tick(['idle', 'idle']);
  assert.equal(fired, 1, 'busy → completed 첫 전이에서 정확히 1회 발사되어야 한다');
  // 4) 같은 completed 상태가 이어지는 동안에는 재발사되지 않는다.
  tick(['idle', 'idle']);
  tick(['idle', 'idle']);
  assert.equal(fired, 1, '같은 completed 구간에서 재발사되면 안 된다');
  // 5) 다시 busy 로 떨어졌다가 수렴 — 두 번째 rising-edge 에서 재발사된다.
  tick(['working', 'idle']);
  tick(['idle', 'idle']);
  assert.equal(fired, 2, '새 busy 구간 이후 다시 수렴하면 1회 재발사되어야 한다');
});

test('allAgentsCompletedWatcher — 팀원이 0명인 프로젝트는 자동화를 발사하지 않는다', () => {
  const tracker = new ProjectCompletionTracker();
  const { fire, nextPhase } = tracker.observe('proj-empty', []);
  // 비교 대상 자체가 없으므로 이전 phase 를 유지한다(=완료로 간주하지 않는다).
  assert.equal(fire, false, '에이전트가 없는 프로젝트에서 자동화가 돌면 의미 없는 커밋이 발사된다');
  assert.equal(nextPhase, 'completed'); // 초기 undefined → 기본 completed 로 고정.
});

test('allAgentsCompletedWatcher — reset 이후 첫 completed 관측은 fire 하지 않는다(재가입 직후 오발사 방지)', () => {
  const tracker = new ProjectCompletionTracker();
  const projectId = 'proj-reset';
  tracker.observe(projectId, ['working']);
  tracker.observe(projectId, ['idle']); // fire=true, phase=completed
  tracker.reset(projectId);
  // reset 직후의 첫 관측은 previousPhase=undefined 로 돌아가 rising-edge 조건을
  // 만족하지 않는다. 프로젝트가 삭제되고 같은 id 로 재생성되는 경로에서 발생.
  const { fire } = tracker.observe(projectId, ['idle']);
  assert.equal(fire, false);
});

test('allAgentsCompletedWatcher — working 과 thinking/meeting 이 섞여 있으면 busy 로 본다', () => {
  // idle 이 아닌 모든 상태(working/thinking/meeting)는 "아직 작업 중" 으로 취급해야
  // 한다. 한 명이라도 회의 중이면 집계 커밋을 내지 않는다.
  const tracker = new ProjectCompletionTracker();
  tracker.observe('proj-mixed', ['idle']);
  const a = tracker.observe('proj-mixed', ['thinking', 'idle']);
  assert.equal(a.nextPhase, 'busy');
  const b = tracker.observe('proj-mixed', ['meeting', 'idle']);
  assert.equal(b.nextPhase, 'busy');
  const c = tracker.observe('proj-mixed', ['working', 'idle']);
  assert.equal(c.nextPhase, 'busy');
  const d = tracker.observe('proj-mixed', ['idle', 'idle']);
  assert.equal(d.nextPhase, 'completed');
  assert.equal(d.fire, true);
});

test('evaluateAgentsCompletion — 순수 함수 계약: previousPhase=busy + 현재 전원 idle 이면 fire=true', () => {
  // ProjectCompletionTracker 는 이 순수 함수의 얇은 wrapper 이므로, 함수 자체의
  // 입력/출력 계약도 별도로 회귀 고정한다(맵 상태 누수 없이 판정 가능한지).
  const r1 = evaluateAgentsCompletion('busy', ['idle', 'idle']);
  assert.deepEqual(r1, { nextPhase: 'completed', fire: true });
  const r2 = evaluateAgentsCompletion('completed', ['idle', 'idle']);
  assert.deepEqual(r2, { nextPhase: 'completed', fire: false });
  const r3 = evaluateAgentsCompletion('busy', ['working', 'idle']);
  assert.deepEqual(r3, { nextPhase: 'busy', fire: false });
  const r4 = evaluateAgentsCompletion(undefined, ['idle', 'idle']);
  assert.deepEqual(r4, { nextPhase: 'completed', fire: false });
});

// ---------------------------------------------------------------------------
// E2E 시뮬레이션 — 리더 분배 → 팀원 전원 완료 → 자동화 발사 (한 플로우).
// server.ts 의 실제 executeGitAutomation 대신 스파이 함수를 주입해, 분배 → 완료
// 전이 → 발사 순서가 계약대로 흐르는지 한 묶음으로 검증한다.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 리더 경유 Git 자동화 트리거 — taskRunner.handleImprovementReport 가 팀원 완료
// 이벤트를 받으면 리더 태스크를 만들기 전(전) 단계에서 runGitAutomation 을
// 호출해야 한다. 기존에는 이 경로가 비어 있어, 팀원 본인의 handleWorkerTaskComplete
// 훅이 한국어 게이트 재시도·워커 재사용 타이밍·훅 unset 등으로 건너뛰면 커밋/
// 푸시/PR 이 전부 침묵했다. 여기서는 taskRunner 를 직접 띄우는 대신 동일 로직을
// 1:1 로 시뮬레이션해 "완료 이벤트 수신 → 자동화 spy 가 호출됐는가" 를 회귀로 고정.
// ---------------------------------------------------------------------------

interface ImprovementDispatchOutcome {
  gitCalls: Array<{ projectId: string; ctx: LeaderGitAutomationContext }>;
  leaderTask: Task | null;
  dispatched: Task[];
}

// taskRunner.handleImprovementReport 의 순서를 그대로 흉내 낸다:
//   1) leader role / summary 가드
//   2) 프로젝트에 리더가 없으면 조기 종료 (조용히 스킵)
//   3) [NEW] runGitAutomation(gitContext) — 본 회귀가 보호하는 지점
//   4) formatImprovementReportForLeader 로 description 조립
//   5) 리더 태스크 insert + dispatchTask(fire-and-forget)
// 팀원 훅(handleWorkerTaskComplete) 과의 중복은 서버 측 executeGitAutomation 의
// skipped/firedTaskIds 가드가 흡수하므로, 시뮬레이터는 "leader 경유 1회 호출" 만
// 검증한다. 본문이 taskRunner.ts 와 1:1 이므로 원본이 바뀌면 이 시뮬레이터도 함께
// 수정해 계약이 깨지지 않게 한다.
function simulateImprovementReportDispatch(
  reporter: Agent,
  project: Pick<Project, 'id' | 'agents'>,
  leaderInProject: Agent | null,
  report: ImprovementReport,
  runGitAutomation: (
    projectId: string,
    ctx: LeaderGitAutomationContext,
  ) => Promise<GitAutomationRunResult>,
): ImprovementDispatchOutcome {
  const outcome: ImprovementDispatchOutcome = {
    gitCalls: [],
    leaderTask: null,
    dispatched: [],
  };
  if (reporter.role === 'Leader') return outcome;
  if (!report.summary) return outcome;
  if (!leaderInProject) return outcome;

  const gitContext = buildLeaderGitAutomationContext(report, reporter.name);
  outcome.gitCalls.push({ projectId: project.id, ctx: gitContext });
  // taskRunner 는 fire-and-forget 로 호출하고 에러를 catch 한다 — 시뮬레이터도
  // 동일한 비차단 호출 규약을 지키되, Promise 결과는 무시한다.
  void runGitAutomation(project.id, gitContext).catch(() => {});

  const description = formatImprovementReportForLeader(report);
  const leaderTask: Task = {
    id: 'leader-task-1',
    projectId: project.id,
    assignedTo: leaderInProject.id,
    description,
    status: 'pending',
    source: 'user',
  };
  outcome.leaderTask = leaderTask;
  outcome.dispatched.push(leaderTask);
  return outcome;
}

test('handleImprovementReport 경유 — 팀원 개선 보고가 리더 분기로 들어오는 순간 runGitAutomation 이 1회 호출된다', () => {
  const report = createImprovementReport({
    agentId: 'dev-1',
    agentName: 'Joker',
    role: 'Developer',
    projectId: PROJECT.id,
    taskId: 't-worker-1',
    summary: 'LoginForm 빈 이메일 가드 추가',
    category: 'bug',
    focusFiles: ['src/components/LoginForm.tsx'],
  });
  assert.ok(report, '유효한 improvement report 가 생성돼야 한다');

  const calls: Array<{ projectId: string; ctx: LeaderGitAutomationContext }> = [];
  const runGitAutomation = async (
    projectId: string,
    ctx: LeaderGitAutomationContext,
  ): Promise<GitAutomationRunResult> => {
    calls.push({ projectId, ctx });
    return { ok: true, results: [] };
  };

  const reporter: Agent = {
    id: 'dev-1',
    name: 'Joker',
    role: 'Developer',
    spriteTemplate: '',
    persona: '',
    status: 'working',
    x: 0, y: 0,
  };

  const out = simulateImprovementReportDispatch(
    reporter,
    PROJECT,
    LEADER,
    report!,
    runGitAutomation,
  );

  // (1) runGitAutomation 이 정확히 1회 호출됐다 — 회귀 방지의 핵심 단언.
  assert.equal(out.gitCalls.length, 1, '리더 경유 분기에서 git 자동화가 호출되지 않으면 본 회귀가 깨진 것');
  assert.equal(calls.length, 1);
  // (2) 프로젝트 ID 와 컨텍스트가 리더 관점에서 보고자(Joker) 를 기록한다.
  assert.equal(calls[0].projectId, PROJECT.id);
  assert.equal(calls[0].ctx.type, 'fix', 'category=bug → conventional type=fix');
  assert.match(calls[0].ctx.summary, /LoginForm/);
  assert.equal(calls[0].ctx.agent, 'Joker');
  // (3) 리더 태스크가 생성됐고 사용자 커맨드 출처로 큐에 올라갔다.
  assert.ok(out.leaderTask);
  assert.equal(out.leaderTask!.assignedTo, LEADER.id);
  assert.equal(out.leaderTask!.source, 'user');
});

test('handleImprovementReport 경유 — 리더 본인이 보고자이면 자동화가 발사되지 않는다(무한 루프 방지)', () => {
  const leaderAsReporter: Agent = { ...LEADER, status: 'working' };
  const report = createImprovementReport({
    agentId: LEADER.id,
    projectId: PROJECT.id,
    summary: '의심스러운 자기 보고',
  });
  assert.ok(report);

  const calls: Array<unknown> = [];
  const runGitAutomation = async () => {
    calls.push('fired');
    return { ok: true, results: [] } as GitAutomationRunResult;
  };

  const out = simulateImprovementReportDispatch(
    leaderAsReporter,
    PROJECT,
    LEADER,
    report!,
    runGitAutomation,
  );
  assert.equal(out.gitCalls.length, 0, '리더 자체 보고는 자동화 경로를 건너뛰어야 한다');
  assert.equal(calls.length, 0);
  assert.equal(out.leaderTask, null);
});

test('handleImprovementReport 경유 — 프로젝트에 리더가 없으면 자동화/태스크 모두 스킵', () => {
  const report = createImprovementReport({
    agentId: 'dev-1',
    projectId: PROJECT.id,
    summary: '리더 없는 1인 프로젝트에서의 보고',
  });
  assert.ok(report);
  const calls: Array<unknown> = [];
  const runGitAutomation = async () => {
    calls.push('fired');
    return { ok: true, results: [] } as GitAutomationRunResult;
  };
  const out = simulateImprovementReportDispatch(
    { ...MEMBERS[0], status: 'working' },
    PROJECT,
    null, // 리더 없음
    report!,
    runGitAutomation,
  );
  assert.equal(out.gitCalls.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(out.leaderTask, null);
});

test('E2E — 리더 분배 후 팀원이 모두 idle 로 돌아오면 git 자동화가 1회 트리거된다', () => {
  const tracker = new ProjectCompletionTracker();
  const automationCalls: { projectId: string; summary: string }[] = [];
  const triggerGitAutomation = (projectId: string, summary: string) => {
    automationCalls.push({ projectId, summary });
  };
  const projectId = PROJECT.id;

  // 초기 상태 — 리더/팀원 모두 idle.
  const initial = tracker.observe(projectId, [LEADER, ...MEMBERS].map(a => a.status));
  assert.equal(initial.fire, false);

  // 리더 분배 응답을 해석해 자식 태스크가 만들어진다(시뮬레이터 재사용).
  const raw = JSON.stringify({
    mode: 'dispatch',
    tasks: [
      { assignedTo: 'dev-1', description: 'LoginForm 유효성 검증 보강' },
      { assignedTo: 'qa-1',  description: '로그인 플로우 QA 시나리오 확장' },
    ],
    message: '개선 분배',
  });
  const dispatch = simulateLeaderBranch(LEADER, MEMBERS, PROJECT, raw);
  assert.equal(dispatch.childTasks.length, 2);

  // 분배된 태스크가 dispatch 되는 순간 팀원들이 working 으로 전이. 이 시점의 관측은
  // busy 로 떨어진다.
  const busyTick = tracker.observe(projectId, ['idle', 'working', 'working']);
  assert.equal(busyTick.nextPhase, 'busy');
  assert.equal(busyTick.fire, false);
  // 자동화는 아직 발사되지 않아야 한다 — 한 명이라도 작업 중이면 집계 커밋은 보류.
  assert.equal(automationCalls.length, 0);

  // dev-1 이 먼저 완료 → idle 복귀. 하지만 qa-1 이 아직 working 이므로 busy 유지.
  const midTick = tracker.observe(projectId, ['idle', 'idle', 'working']);
  assert.equal(midTick.nextPhase, 'busy');
  assert.equal(midTick.fire, false);

  // 마지막 qa-1 이 완료 → 전원 idle 로 수렴. 이 전이에서 1회 발사.
  const finalTick = tracker.observe(projectId, ['idle', 'idle', 'idle']);
  assert.equal(finalTick.nextPhase, 'completed');
  assert.equal(finalTick.fire, true);
  if (finalTick.fire) triggerGitAutomation(projectId, 'all agents completed');

  assert.equal(automationCalls.length, 1, '전원 idle 수렴에서 정확히 1회 자동화가 발사되어야 한다');
  assert.equal(automationCalls[0].projectId, projectId);
  assert.match(automationCalls[0].summary, /all agents completed/);

  // 이어지는 tick 에서는 재발사되지 않는다.
  const idleHold = tracker.observe(projectId, ['idle', 'idle', 'idle']);
  assert.equal(idleHold.fire, false);
  assert.equal(automationCalls.length, 1, 'completed 구간이 이어지는 동안에는 재발사가 없어야 한다');
});
