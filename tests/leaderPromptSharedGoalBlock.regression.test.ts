// Run with: npx tsx --test tests/leaderPromptSharedGoalBlock.regression.test.ts
//
// QA: 지시 #1b66b3da — `src/server/prompts.ts::buildLeaderPlanPrompt` 가
// `sharedGoal` 네이티브 인자로 받아 `[공동 목표]` 블록을 **프롬프트 본문**에
// 주입하는 계약을 직접 잠근다. 기존 `tests/sharedGoal.regression.test.ts` 의
// S2 는 시뮬레이터(goalBlock 을 외부에서 덧대기) 방식이고, 같은 파일 안에
// `test.skip('... [미구현] ...')` 로 남아 있어 실제 구현 호출을 검증하지
// 못한다. 본 파일은 그 공백을 메운다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLeaderPlanPrompt } from '../src/server/prompts.ts';
import type { Agent, Project, SharedGoal } from '../src/types.ts';

const LEADER: Agent = {
  id: 'leader-1', name: 'Kai', role: 'Leader',
  spriteTemplate: '', persona: '장기 목표를 쪼개 분배한다',
  status: 'idle', x: 0, y: 0,
};

const MEMBERS: Agent[] = [
  { id: 'dev-1', name: 'Juno', role: 'Developer', spriteTemplate: '', persona: '', status: 'idle', x: 0, y: 0 },
  { id: 'qa-1',  name: 'Mira', role: 'QA',        spriteTemplate: '', persona: '', status: 'idle', x: 0, y: 0 },
];

const PROJECT: Project = {
  id: 'p-1', name: 'LLMTycoon',
  description: 'AI 에이전트 협업 타이쿤',
  workspacePath: '/tmp/ws',
  agents: [LEADER.id, ...MEMBERS.map(m => m.id)],
  status: 'active',
};

function makeGoal(patch: Partial<SharedGoal> = {}): SharedGoal {
  return {
    id: 'goal-1',
    projectId: PROJECT.id,
    title: '결제 모듈 보안 강화',
    description: '토큰 검증·AES 암호화·PCI 감사로그 추가',
    priority: 'high',
    deadline: '2026-04-25',
    status: 'active',
    createdAt: '2026-04-18T09:00:00.000Z',
    ...patch,
  };
}

test('sharedGoal 주입 — 프롬프트 상단에 [공동 목표] 블록이 들어간다', () => {
  const p = buildLeaderPlanPrompt({
    agent: LEADER, project: PROJECT, peers: MEMBERS,
    trigger: 'auto-dev', sharedGoal: makeGoal(),
  });
  assert.match(p, /\[공동 목표\]/);
  assert.ok(p.includes('결제 모듈 보안 강화'), '제목이 블록에 포함되어야 한다');
  assert.ok(p.includes('토큰 검증·AES 암호화·PCI 감사로그 추가'), '설명이 포함되어야 한다');
});

test('priority 라벨은 한국어로 변환된다(high → 높음, low → 낮음, normal → 보통)', () => {
  const high = buildLeaderPlanPrompt({ agent: LEADER, project: PROJECT, peers: MEMBERS, trigger: 'auto-dev', sharedGoal: makeGoal({ priority: 'high' }) });
  const normal = buildLeaderPlanPrompt({ agent: LEADER, project: PROJECT, peers: MEMBERS, trigger: 'auto-dev', sharedGoal: makeGoal({ priority: 'normal' }) });
  const low = buildLeaderPlanPrompt({ agent: LEADER, project: PROJECT, peers: MEMBERS, trigger: 'auto-dev', sharedGoal: makeGoal({ priority: 'low' }) });
  assert.match(high, /우선순위: 높음/);
  assert.match(normal, /우선순위: 보통/);
  assert.match(low, /우선순위: 낮음/);
});

test('deadline 이 있으면 블록에 포함되고, 없으면 "마감" 라인 자체가 생략된다', () => {
  const withDue = buildLeaderPlanPrompt({ agent: LEADER, project: PROJECT, peers: MEMBERS, trigger: 'auto-dev', sharedGoal: makeGoal({ deadline: '2026-04-25' }) });
  const noDue = buildLeaderPlanPrompt({ agent: LEADER, project: PROJECT, peers: MEMBERS, trigger: 'auto-dev', sharedGoal: makeGoal({ deadline: undefined }) });
  assert.match(withDue, /마감: 2026-04-25/);
  assert.ok(!/마감:/.test(noDue), 'deadline 이 없으면 "마감" 라인 자체가 프롬프트에 등장하지 않아야 한다');
});

test('sharedGoal 이 null 이면 [공동 목표] 블록이 주입되지 않는다', () => {
  const p = buildLeaderPlanPrompt({
    agent: LEADER, project: PROJECT, peers: MEMBERS,
    trigger: 'auto-dev', sharedGoal: null,
  });
  assert.ok(!p.includes('[공동 목표]'), 'null 이면 블록 자체가 등장하면 안 된다');
});

test('sharedGoal 이 undefined(미지정) 이어도 동일하게 블록이 주입되지 않는다', () => {
  const p = buildLeaderPlanPrompt({
    agent: LEADER, project: PROJECT, peers: MEMBERS,
    trigger: 'auto-dev',
  });
  assert.ok(!p.includes('[공동 목표]'));
});

test('공동 목표 블록에는 "분배는 위 목표를 향해 수렴" 안내가 함께 들어간다', () => {
  const p = buildLeaderPlanPrompt({
    agent: LEADER, project: PROJECT, peers: MEMBERS,
    trigger: 'auto-dev', sharedGoal: makeGoal(),
  });
  assert.match(p, /모든 분배는 위 목표를 향해 수렴해야 한다/);
});

test('description 이 빈 문자열이면 "- 설명:" 라인은 생략된다', () => {
  const p = buildLeaderPlanPrompt({
    agent: LEADER, project: PROJECT, peers: MEMBERS,
    trigger: 'auto-dev', sharedGoal: makeGoal({ description: '' }),
  });
  assert.match(p, /- 제목:/);
  assert.match(p, /- 우선순위:/);
  assert.ok(!/- 설명:\s*$/m.test(p), '빈 설명 라인이 남으면 프롬프트에 공백이 섞여 리더가 혼선을 일으킨다');
});

test('user-command 트리거에서도 공동 목표 블록이 동일하게 주입된다', () => {
  const p = buildLeaderPlanPrompt({
    agent: LEADER, project: PROJECT, peers: MEMBERS,
    trigger: 'user-command', userCommand: '로그인 강화해줘',
    sharedGoal: makeGoal({ title: '인증 안정성' }),
  });
  assert.match(p, /\[공동 목표\]/);
  assert.ok(p.includes('인증 안정성'));
  assert.ok(p.includes('로그인 강화해줘'), 'user-command 본문도 함께 포함되어야 한다');
});
