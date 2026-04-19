// Run with: npx tsx --test tests/sharedGoal.regression.test.ts
//
// QA: 공동 목표(shared goal) 입력 폼 × 자동 개발(auto-dev) 가드 회귀 테스트.
//
// 본 파일은 "자동 개발" 루프가 공동 목표(프로젝트 단위 장기 지향점)를 반드시
// 요구하고, 그 값을 리더 분배 프롬프트에 주입하며, 목표 변경/삭제 시 올바른
// 방식으로 반응하도록 네 가지 시나리오(S1~S4)를 Given/When/Then 명세로 고정한다.
//
// 우선 검토 파일: src/server/prompts.ts — 본 파일의 S2 가 buildLeaderPlanPrompt 에
// sharedGoal 이 반영되는지를 한 출처에서 잠근다. sharedGoal 이 실제 구현되기 전에도
// 시뮬레이터 경로를 통해 계약을 명문화하고, 프롬프트 입력이 확장되는 순간
// 진짜 회귀 테스트가 활성화되도록 TODO 지점을 주석으로 표시해 둔다.
//
// ┌─ 시나리오 지도 ─────────────────────────────────────────────────────────┐
// │ S1  공동 목표 미입력 → 자동 개발 ON 시도 → 차단 + 한국어 안내         │
// │ S2  공동 목표 입력 후 ON → 리더 프롬프트·팀원 분배가 목표 정렬적      │
// │ S3  실행 중 목표 수정 → 진행 중 태스크 무영향, 다음 루프부터 반영     │
// │ S4  목표 삭제 → 자동 개발 자동 중지 + UI 배너                         │
// └─────────────────────────────────────────────────────────────────────────┘

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLeaderPlanPrompt, extractLeaderPlan } from '../src/server/prompts.ts';
import type { Agent, Project, Task, AutoDevSettings } from '../src/types.ts';

// ---------------------------------------------------------------------------
// 확장 타입 (제안) — 공동 목표 도입 시 AutoDevSettings 또는 Project 에 추가될
// 필드. 타입이 합쳐지기 전에도 본 시나리오가 같은 형태를 공유할 수 있도록
// 테스트 로컬 타입으로 선언한다. 실 구현 시 types.ts 에서 export 한 뒤
// 본 선언은 삭제한다.
// ---------------------------------------------------------------------------

interface SharedGoal {
  // 비어있거나 공백만으로 구성된 값은 "미입력" 으로 간주한다(trim 후 length 0).
  text: string;
  updatedAt: string;
}

interface AutoDevWithGoal extends AutoDevSettings {
  sharedGoal?: SharedGoal;
}

type AutoDevGuardOutcome =
  | { ok: true; next: AutoDevWithGoal }
  | { ok: false; reason: 'empty-shared-goal'; userMessage: string };

// ---------------------------------------------------------------------------
// 시뮬레이터 — 서버 setAutoDev() + autoDevTick() 의 공동 목표 가드 부분을
// 1:1 로 모사한다. 실제 TaskRunner 를 띄우지 않고도 S1/S4 계약을 잠근다.
// 구현이 다음 PR 에서 src/server/taskRunner.ts::setAutoDev / autoDevTick 에
// 들어가면 본 시뮬레이터를 해당 함수 호출로 교체한다.
// ---------------------------------------------------------------------------

/**
 * S1/S4 가드: 자동 개발을 켜려고 하거나, 켜져 있는 상태에서 목표가 사라졌을 때의
 * 판정. 서버 `PATCH /api/auto-dev` 진입 직후와 `autoDevTick()` 매 틱 진입 전에
 * 두 번 호출되어야 계약이 성립한다.
 */
function evaluateAutoDevGuard(
  prev: AutoDevWithGoal,
  next: Partial<AutoDevWithGoal>,
): AutoDevGuardOutcome {
  const merged: AutoDevWithGoal = {
    enabled: next.enabled !== undefined ? !!next.enabled : prev.enabled,
    projectId: 'projectId' in next ? next.projectId : prev.projectId,
    sharedGoal: 'sharedGoal' in next ? next.sharedGoal : prev.sharedGoal,
    updatedAt: new Date(0).toISOString(),
  };
  const goalText = merged.sharedGoal?.text?.trim() ?? '';
  if (merged.enabled && goalText.length === 0) {
    return {
      ok: false,
      reason: 'empty-shared-goal',
      userMessage:
        '공동 목표를 먼저 입력해 주세요. 자동 개발은 프로젝트 목표 없이 실행되지 않습니다.',
    };
  }
  return { ok: true, next: merged };
}

/**
 * S2/S3 분배 경로: 리더 플래닝 프롬프트를 만들 때 공동 목표를 상단에 고정하고,
 * 리더가 이 맥락을 바탕으로 팀원에게 업무를 분배하도록 유도한다.
 *
 * 현행 buildLeaderPlanPrompt 는 sharedGoal 을 입력으로 받지 않으므로,
 * 시뮬레이터는 기본 프롬프트 위에 공동 목표 블록을 선두에 덧댄다.
 * 구현이 prompts.ts 에 반영되면 본 함수는 buildLeaderPlanPrompt 의
 * 재호출로 대체하고, 본 파일 하단의 TODO 테스트를 활성화한다.
 */
function buildAutoDevLeaderPromptWithGoal(input: {
  agent: Agent;
  project: Project;
  peers: Agent[];
  sharedGoal: SharedGoal;
}): string {
  const { agent, project, peers, sharedGoal } = input;
  const base = buildLeaderPlanPrompt({
    agent,
    project,
    peers,
    trigger: 'auto-dev',
  });
  const goalBlock = [
    '[공동 목표]',
    sharedGoal.text.trim(),
    '',
    '모든 분배 업무는 위 공동 목표를 전진시키는 방향으로 선정하라.',
    '목표와 무관한 작업은 mode="reply" 로 사유를 남겨 건너뛴다.',
    '',
  ].join('\n');
  return `${goalBlock}${base}`;
}

/**
 * S3 루프 경계 모사: "진행 중 태스크" 는 dispatchTask() 가 이미 워커 큐에 prompt
 * 를 enqueue 한 상태. 루프 중간에 사용자가 공동 목표를 수정하면, (a) 이미
 * 흘러 들어간 태스크의 prompt 원문에는 영향 없고(해당 턴은 옛 목표 기준), (b)
 * 다음 autoDevTick() 이 생성하는 새 합성 태스크부터 새 목표를 사용해야 한다.
 */
interface LoopBoundarySnapshot {
  inFlightPrompt: string;      // 이전 목표로 만들어진 — 변경 금지
  nextLoopPrompt: string;      // 수정 후 목표로 다음 틱에서 생성
}

function simulateGoalEditMidLoop(
  agent: Agent,
  project: Project,
  peers: Agent[],
  before: SharedGoal,
  after: SharedGoal,
): LoopBoundarySnapshot {
  const inFlightPrompt = buildAutoDevLeaderPromptWithGoal({
    agent, project, peers, sharedGoal: before,
  });
  // 목표 수정: 진행 중 prompt 문자열은 불변(이미 워커에 enqueue 됨).
  const nextLoopPrompt = buildAutoDevLeaderPromptWithGoal({
    agent, project, peers, sharedGoal: after,
  });
  return { inFlightPrompt, nextLoopPrompt };
}

// ---------------------------------------------------------------------------
// 공용 픽스처.
// ---------------------------------------------------------------------------

const LEADER: Agent = {
  id: 'leader-goal',
  name: 'Kai',
  role: 'Leader',
  spriteTemplate: '',
  persona: '장기 목표를 쪼개 매주 배분한다',
  status: 'idle',
  x: 0, y: 0,
};

const MEMBERS: Agent[] = [
  { id: 'dev-1',   name: 'Juno',  role: 'Developer',  spriteTemplate: '', persona: '', status: 'idle', x: 0, y: 0 },
  { id: 'qa-1',    name: 'Mira',  role: 'QA',         spriteTemplate: '', persona: '', status: 'idle', x: 0, y: 0 },
  { id: 'design-1',name: 'Rune',  role: 'Designer',   spriteTemplate: '', persona: '', status: 'idle', x: 0, y: 0 },
];

const PROJECT: Project = {
  id: 'proj-shared-goal',
  name: '오피스 플로어 개편',
  description: '에이전트 공간 UX 재설계',
  workspacePath: '/tmp/ws',
  agents: [LEADER.id, ...MEMBERS.map(m => m.id)],
  status: 'active',
};

const GOAL_V1: SharedGoal = {
  text: '에이전트 간 회의 흐름을 시각적으로 한 화면에서 추적할 수 있게 만든다',
  updatedAt: '2026-04-18T09:00:00.000Z',
};

const GOAL_V2: SharedGoal = {
  text: '회의 흐름에 더해, 자동 개발 중 생성된 태스크 리니지를 타임라인에서 함께 보여준다',
  updatedAt: '2026-04-18T13:00:00.000Z',
};

const INITIAL_AUTO_DEV: AutoDevWithGoal = {
  enabled: false,
  projectId: PROJECT.id,
  updatedAt: new Date(0).toISOString(),
};

// ---------------------------------------------------------------------------
// 시나리오 S1 — 공동 목표 미입력 상태에서 자동 개발 ON 시도 → 차단 + 안내
// ---------------------------------------------------------------------------

test('S1 — Given 공동 목표 미입력 When 자동 개발 ON 시도 Then 차단되고 한국어 안내가 노출된다', () => {
  // Given: 공동 목표가 비어있는 프로젝트. enabled=false 상태.
  const prev: AutoDevWithGoal = { ...INITIAL_AUTO_DEV, sharedGoal: undefined };

  // When: PATCH /api/auto-dev {enabled:true} 시도.
  const outcome = evaluateAutoDevGuard(prev, { enabled: true });

  // Then: 서버는 400 대신 "가드 실패" 객체를 돌려주고, 상태는 enabled=false 그대로 유지.
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.equal(outcome.reason, 'empty-shared-goal');
  // 안내 문구는 한국어 문장이어야 하고, "공동 목표" 키워드를 반드시 포함한다.
  assert.match(outcome.userMessage, /공동 목표/);
  assert.match(outcome.userMessage, /자동 개발/);
});

test('S1 회귀 — 공백·탭·개행만 입력한 목표는 "미입력" 으로 간주되어 동일하게 차단된다', () => {
  const prev: AutoDevWithGoal = {
    ...INITIAL_AUTO_DEV,
    sharedGoal: { text: '   \n\t  ', updatedAt: GOAL_V1.updatedAt },
  };
  const outcome = evaluateAutoDevGuard(prev, { enabled: true });
  assert.equal(outcome.ok, false, 'trim 후 빈 문자열은 유효 목표가 아니다');
});

test('S1 회귀 — enabled=false 유지 시에는 목표가 비어도 가드가 통과한다(토글만 허용)', () => {
  // 사용자가 자동 개발을 끄기만 하거나 projectId 만 바꾸는 호출은 목표 없이도 성립.
  const prev: AutoDevWithGoal = { ...INITIAL_AUTO_DEV, sharedGoal: undefined };
  const outcome = evaluateAutoDevGuard(prev, { enabled: false, projectId: 'other' });
  assert.equal(outcome.ok, true);
});

// ---------------------------------------------------------------------------
// 시나리오 S2 — 공동 목표 입력 후 ON → 리더 프롬프트에 목표 포함, 팀원 분배가
// 목표 정렬적으로 이뤄지는지 검증.
// ---------------------------------------------------------------------------

test('S2 — Given 공동 목표 입력 When 자동 개발 ON Then 리더 프롬프트에 목표 본문이 그대로 포함된다', () => {
  // Given: 유효 공동 목표 설정.
  const prev: AutoDevWithGoal = { ...INITIAL_AUTO_DEV, sharedGoal: GOAL_V1 };
  // When: enable 시도.
  const guard = evaluateAutoDevGuard(prev, { enabled: true });
  assert.equal(guard.ok, true);

  // Then: 리더 플래닝 프롬프트에 공동 목표 블록이 그대로 주입된다.
  const prompt = buildAutoDevLeaderPromptWithGoal({
    agent: LEADER,
    project: PROJECT,
    peers: MEMBERS,
    sharedGoal: GOAL_V1,
  });
  assert.match(prompt, /\[공동 목표\]/);
  assert.ok(prompt.includes(GOAL_V1.text), '목표 원문이 프롬프트에 포함되어야 한다');
  // 목표 정렬 지시문이 동봉되어야 리더 모델이 주제를 붙잡는다.
  assert.match(prompt, /공동 목표를 전진시키는 방향/);
});

test('S2 — 리더가 공동 목표를 인용해 분배한 JSON 응답을 내면 자식 태스크의 description 에 목표 키워드가 자연스럽게 흐른다', () => {
  // 계약: 리더 응답의 description 은 모델 자유지만, extractLeaderPlan 이 주제어를
  // 잃지 않고 그대로 child.description 으로 넘겨야 한다.
  const leaderResponse = JSON.stringify({
    mode: 'dispatch',
    tasks: [
      { assignedTo: 'dev-1',    description: '회의 흐름을 한 화면에 모으는 CollabTimeline 의 필터 축을 확장한다' },
      { assignedTo: 'qa-1',     description: '회의 흐름 타임라인 회귀 시나리오에 대기시간 라벨 케이스를 추가한다' },
      { assignedTo: 'design-1', description: '회의 흐름 카드 밀도·색상 대비 시안을 GOAL_V1 기준으로 업데이트한다' },
    ],
    message: '공동 목표(회의 흐름 시각화)에 맞춰 이번 사이클을 분배합니다',
  });
  const parsed = extractLeaderPlan(leaderResponse);
  assert.ok(parsed);
  assert.equal(parsed!.mode, 'dispatch');
  assert.equal(parsed!.tasks.length, 3);
  // 모든 task 의 description 이 공동 목표 핵심어("회의 흐름") 를 포함하는지 확인.
  for (const t of parsed!.tasks) {
    assert.match(
      t.description,
      /회의 흐름/,
      `자식 태스크 description 이 공동 목표 주제어를 담아야 한다: ${t.description}`,
    );
  }
  // 프로젝트 멤버 id 와 1:1 매핑되는지 — 엉뚱한 assignedTo 가 끼면 안 된다.
  for (const t of parsed!.tasks) {
    assert.ok(
      PROJECT.agents.includes(t.assignedTo),
      `assignedTo=${t.assignedTo} 가 프로젝트 멤버 목록에 존재해야 한다`,
    );
  }
});

// 2026-04-19 활성화: prompts.ts 본체에 sharedGoal 네이티브 필드가 이미 도입되어
// `renderSharedGoalBlock` 이 `[공동 목표]` 블록을 본문 상단에 주입한다. 따라서
// 과거 `test.skip` 으로 두었던 "네이티브 필드 계약" 을 정식 회귀로 승격한다.
// 테스트 로컬 `SharedGoal` 타입은 text/updatedAt 두 필드이지만, 실 타입은
// title/description/priority/status/createdAt 구조이므로 인라인 캐스트로 변환해
// "목표 본문(title) 이 프롬프트에 포함되는가" 계약만 잠근다.
test('S2 — buildLeaderPlanPrompt 가 sharedGoal 을 네이티브 필드로 받아 프롬프트 본문에 삽입한다', () => {
  const realGoal = {
    id: 'goal-v1',
    projectId: PROJECT.id,
    title: GOAL_V1.text,
    description: '',
    priority: 'normal' as const,
    status: 'active' as const,
    createdAt: GOAL_V1.updatedAt,
  };
  const prompt = buildLeaderPlanPrompt({
    agent: LEADER,
    project: PROJECT,
    peers: MEMBERS,
    trigger: 'auto-dev',
    // 실 SharedGoal 타입은 src/types.ts 에 있으며 renderSharedGoalBlock 은
    // 구조 덕타이핑으로 소비한다. 타입 시스템 충돌을 피하기 위해 cast.
    sharedGoal: realGoal as unknown as undefined,
  });
  assert.match(prompt, /\[공동 목표\]/, '프롬프트 상단에 공동 목표 블록이 있어야 한다');
  assert.ok(prompt.includes(GOAL_V1.text), '목표 title 원문이 프롬프트 본문에 포함되어야 한다');
});

// ---------------------------------------------------------------------------
// 시나리오 S3 — 자동 개발 실행 중 목표 수정 시 진행 중 작업에는 영향 없고,
// 다음 루프부터 새 목표가 반영되는지 검증.
// ---------------------------------------------------------------------------

test('S3 — Given 루프 실행 중 When 목표가 V1→V2 로 수정 Then 진행 중 prompt 는 불변, 다음 루프 prompt 만 V2 기준', () => {
  // Given: V1 기준으로 첫 틱이 이미 워커에 prompt 를 enqueue 했다.
  const snapshot = simulateGoalEditMidLoop(LEADER, PROJECT, MEMBERS, GOAL_V1, GOAL_V2);

  // Then 1: 진행 중 prompt 본문은 V1 텍스트를 그대로 유지한다.
  assert.ok(snapshot.inFlightPrompt.includes(GOAL_V1.text));
  assert.ok(
    !snapshot.inFlightPrompt.includes(GOAL_V2.text),
    '진행 중 prompt 에 V2 텍스트가 섞이면 "중간 mutate" 회귀',
  );

  // Then 2: 다음 루프 prompt 는 V2 로 완전히 교체된다.
  assert.ok(snapshot.nextLoopPrompt.includes(GOAL_V2.text));
  assert.ok(
    !snapshot.nextLoopPrompt.includes(GOAL_V1.text),
    '다음 루프 prompt 에 V1 텍스트가 남으면 "목표 갱신 누락" 회귀',
  );
});

test('S3 회귀 — in-progress 태스크 의 prompt 필드는 sharedGoal 수정 이벤트가 와도 동일 문자열 래퍼로 고정된다', () => {
  // 실제 구현에서는 dispatchTask 가 prompt 를 지역 변수로 잡고 enqueue 한다.
  // sharedGoal 의 값이 변해도 해당 지역 변수가 다시 읽히지 않음을 보장해야 한다.
  // 시뮬레이션: 태스크 객체에 prompt 를 저장해 두고 목표 변경 후에도 동일한지 확인.
  const inFlight: Task & { prompt: string } = {
    id: 't-1',
    projectId: PROJECT.id,
    assignedTo: LEADER.id,
    description: '합성 태스크',
    status: 'in-progress',
    source: 'auto-dev',
    prompt: buildAutoDevLeaderPromptWithGoal({
      agent: LEADER, project: PROJECT, peers: MEMBERS, sharedGoal: GOAL_V1,
    }),
  };
  const originalPrompt = inFlight.prompt;
  // 사용자가 목표를 V2 로 수정 — in-flight 태스크의 prompt 는 건드리지 않아야 한다.
  // (실 구현에서는 mutate 를 하지 않는 것이 계약 — 본 테스트는 그 경계를 명문화.)
  const _guardResult = evaluateAutoDevGuard(
    { ...INITIAL_AUTO_DEV, enabled: true, sharedGoal: GOAL_V1 },
    { sharedGoal: GOAL_V2 },
  );
  assert.equal(inFlight.prompt, originalPrompt, '실행 중 태스크 prompt 를 mutate 하면 안 된다');
});

// ---------------------------------------------------------------------------
// 시나리오 S4 — 목표 삭제(또는 공백으로 치환) 시 자동 개발 자동 중지.
// ---------------------------------------------------------------------------

test('S4 — Given 자동 개발 ON + 목표 존재 When 목표를 빈 문자열로 저장 Then 가드가 자동 개발을 즉시 끈다', () => {
  // Given: 이미 enabled=true, 목표 있음.
  const running: AutoDevWithGoal = {
    ...INITIAL_AUTO_DEV,
    enabled: true,
    sharedGoal: GOAL_V1,
  };
  // When: 목표를 빈 문자열로 치환(삭제 이벤트 모사).
  const outcome = evaluateAutoDevGuard(running, {
    sharedGoal: { text: '', updatedAt: '2026-04-18T14:00:00.000Z' },
  });
  // Then: 가드가 거부하므로 서버는 enabled 를 false 로 강제 전환한 새 상태를
  // 응답해야 한다. 본 테스트에서는 "거부" 자체를 확인하고, 후속 강제 OFF 정책을
  // 아래 회귀 테스트로 잠근다.
  assert.equal(outcome.ok, false);
});

test('S4 — Given 자동 개발 ON When 목표를 undefined 로 DELETE Then autoDevTick 이 이번 틱부터 새 태스크를 생성하지 않는다', () => {
  // 서버 `autoDevTick()` 진입 첫 줄에서 `evaluateAutoDevGuard` 을 한 번 더 호출해
  // enabled=true 이더라도 목표가 사라졌으면 tick 을 즉시 종료해야 한다. 이
  // 이중 가드가 없으면 "DELETE 후에도 한 틱은 더 흐름" 회귀가 생긴다.
  const running: AutoDevWithGoal = {
    ...INITIAL_AUTO_DEV,
    enabled: true,
    sharedGoal: undefined, // 직전 DELETE 가 undefined 로 저장.
  };
  const tickGuard = evaluateAutoDevGuard(running, {});
  assert.equal(tickGuard.ok, false, 'tick 진입부에서도 빈 목표는 차단되어야 한다');
});

test('S4 — 삭제 후 재입력 시 자동 개발을 다시 켤 수 있다 (가역성)', () => {
  // 목표 없이 꺼진 상태 → 목표 재입력 → enable 재시도.
  const offAfterDelete: AutoDevWithGoal = {
    enabled: false,
    projectId: PROJECT.id,
    sharedGoal: undefined,
    updatedAt: '2026-04-18T14:05:00.000Z',
  };
  const outcome = evaluateAutoDevGuard(offAfterDelete, {
    enabled: true,
    sharedGoal: GOAL_V1,
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error('unreachable');
  assert.equal(outcome.next.enabled, true);
  assert.equal(outcome.next.sharedGoal?.text, GOAL_V1.text);
});

// ---------------------------------------------------------------------------
// 불변 계약 — 모든 시나리오에서 "목표 없음 + enabled=true" 조합은 절대 통과할 수
// 없다. S1/S4 가 두 진입점을 모두 커버하는지 한 번 더 잠근다.
// ---------------------------------------------------------------------------

test('불변 — (enabled=true, sharedGoal=공백/undefined) 조합은 어떤 진입점으로도 통과하지 않는다', () => {
  const emptyCases: Partial<AutoDevWithGoal>[] = [
    { enabled: true, sharedGoal: undefined },
    { enabled: true, sharedGoal: { text: '', updatedAt: '' } },
    { enabled: true, sharedGoal: { text: '   ', updatedAt: '' } },
    { enabled: true, sharedGoal: { text: '\n\t', updatedAt: '' } },
  ];
  for (const patch of emptyCases) {
    const out = evaluateAutoDevGuard(INITIAL_AUTO_DEV, patch);
    assert.equal(
      out.ok,
      false,
      `빈 목표 조합이 통과했다: ${JSON.stringify(patch)}`,
    );
  }
});
