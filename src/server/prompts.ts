import type { Agent, AgentRole, CodeFile, Project, Task } from '../types';

// 프롬프트 생성 로직은 기존에 클라이언트(App.tsx)에 있었다. 워커 아키텍처로
// 전환하면서 서버가 태스크를 직접 dispatch 하게 되므로, 같은 규칙을 서버에서
// 재사용할 수 있도록 순수 함수로 분리한다.

export function translateRole(role: AgentRole): string {
  switch (role) {
    case 'Leader': return '리더';
    case 'Developer': return '개발자';
    case 'QA': return 'QA';
    case 'Designer': return '디자이너';
    case 'Researcher': return '리서처';
    default: return role;
  }
}

export function personaLine(agent: Agent): string {
  const trimmed = agent.persona?.trim();
  return trimmed ? `페르소나: ${trimmed}\n` : '';
}

// 공통 시스템 프롬프트. 한 번 spawn 된 워커에 append-system-prompt 로 주입되어
// 이후 모든 유저 턴에 기본 컨텍스트로 따라 붙는다. 개별 턴에서 반복 서술하지
// 않도록 "불변" 규칙을 여기 모은다.
export function buildSystemPrompt(agent: Agent): string {
  return [
    '[언어 규칙 — 최우선]',
    '- 모든 사용자 응답·동료 메시지·로그 문장은 반드시 한국어로 작성한다.',
    '- 코드·식별자·파일명·커맨드는 원문(영문) 그대로 두되, 주석과 설명은 한국어.',
    '- 영어로 답하고 싶더라도 한국어로 번역해 출력한다. (게임 UI가 한국어 전용이다)',
    '',
    `당신은 ${translateRole(agent.role)} "${agent.name}" 입니다.`,
    agent.persona?.trim() ? `페르소나: ${agent.persona.trim()}` : '',
    '',
    '당신은 프로젝트 워크스페이스 디렉터리에서 직접 코드를 읽고/쓰고/편집하는 개발 에이전트입니다.',
    '',
    '[빌트인 도구]',
    '- Read / Glob / Grep: 워크스페이스 파일 탐색·이해',
    '- Write / Edit: 파일 생성·수정 (실제 디스크에 반영)',
    '- Bash: 빌드·테스트·git 등 명령 실행',
    '',
    '[MCP 도구 — 게임 상태/코드그래프 동기화]',
    '- list_files(): 현재 프로젝트의 코드그래프 파일 노드 목록/ID 조회',
    '- add_file(name, type?): 그래프에 파일 노드를 추가. 이미 존재하면 서버가 기존 노드를 반환(멱등). 호출이 과해서 생기는 부작용은 없다.',
    '- add_dependency(from_file_id, to_file_id): 두 파일 사이 의존성 엣지 기록',
    '- update_status(status, working_on_file_id): 작업 시작/종료 시 상태 보고',
    '- whoami(): 현재 컨텍스트 확인',
    '',
    '[필수 체크리스트 — 매 지시마다 반드시 이 순서로 수행]',
    '1) update_status("working", <파일ID 또는 "">)로 착수 보고',
    '2) list_files() 를 한 번 호출해 현재 코드그래프 상태를 **반드시** 캡처',
    '3) Read/Glob/Grep 으로 워크스페이스 현황 파악',
    '4) Write/Edit 로 실제 코드 변경 수행',
    '5) **그래프 동기화 — 누락 금지 규칙**:',
    '   - 이번 턴에 Read/Write/Edit 로 한 번이라도 건드린 모든 파일에 대해 add_file 을 호출한다.',
    '   - "이미 등록돼 있을 것 같다" 는 판단으로 스킵하지 말 것. add_file 은 멱등하므로 중복 호출이 안전하다.',
    '   - import / require / include / from ... import 구문으로 끌어오는 모든 파일마다 add_dependency 를 호출한다.',
    '   - 2) 에서 list_files 로 얻은 ID 목록을 이 단계에서 매칭 근거로 사용한다.',
    '6) update_status("idle", "") 로 종료 보고',
    '7) 최종 출력: 동료에게 전달할 한국어 한 줄(≤20단어). 따옴표·이름표·도구 호출 로그 금지.',
    '',
    '체크리스트 5) 는 게임 코드그래프의 정합성을 유지하기 위한 핵심 단계다. 누락되면 UI 가 실제 코드 구조를 추적하지 못해 게임이 깨진다. 의심되면 더 많이 호출하는 쪽을 택하라.',
  ].filter(Boolean).join('\n');
}

interface TaskPromptInput {
  agent: Agent;
  task: Task;
  project?: Project | null;
  candidateFile?: CodeFile | null;
  peer?: Agent | null;
}

export function buildTaskPrompt(input: TaskPromptInput): string {
  const { agent, task, project, candidateFile, peer } = input;
  const lines: string[] = [];
  lines.push(`[새 지시 #${task.id.slice(0, 8)}]`);
  lines.push(`할당된 업무: ${task.description}`);
  if (project) lines.push(`프로젝트: ${project.name}${project.description ? ` — ${project.description}` : ''}`);
  if (candidateFile) lines.push(`우선 검토 파일: "${candidateFile.name}" (id: ${candidateFile.id})`);
  if (peer && peer.id !== agent.id) {
    lines.push(`완료 후 소통 대상: ${translateRole(peer.role)} "${peer.name}" (id: ${peer.id})`);
  }
  lines.push('');
  lines.push('시스템 프롬프트의 체크리스트 1~7 순서를 그대로 따라 작업하라.');
  lines.push('특히 5) "그래프 동기화" 단계에서 이번 턴에 건드린 모든 파일에 add_file 을, import/require 관계에는 add_dependency 를 빠짐없이 호출하라.');
  lines.push('최종 메시지는 반드시 한국어로 한 줄만 출력한다(영어 금지).');
  return lines.join('\n');
}

interface LeaderPlanPromptInput {
  agent: Agent;
  project: Project;
  peers: Agent[];
  trigger: 'auto-dev' | 'user-command';
  userCommand?: string;
}

// 리더가 팀원에게 업무를 분배하기 위해 사용하는 프롬프트. 출력은 엄격한 JSON.
// JSON 파싱 로직은 dispatcher 측에서 처리한다.
export function buildLeaderPlanPrompt(input: LeaderPlanPromptInput): string {
  const { agent, project, peers, trigger, userCommand } = input;
  const memberList = peers
    .filter(p => p.id !== agent.id)
    .map(p => `- ${p.name} (${translateRole(p.role)}, id: ${p.id}, 상태: ${p.status})`)
    .join('\n') || '- (없음)';
  const lines: string[] = [];
  lines.push(`당신은 팀 리더 "${agent.name}" 입니다. ${agent.persona?.trim() ? `페르소나: ${agent.persona.trim()}` : ''}`.trim());
  lines.push(`프로젝트: ${project.name} — ${project.description || ''}`);
  lines.push('');
  lines.push('팀원 목록:');
  lines.push(memberList);
  lines.push('');
  if (trigger === 'user-command' && userCommand) {
    lines.push(`사용자 지시: ${userCommand}`);
    lines.push('위 지시를 팀원이 수행 가능한 구체 업무로 쪼개 분배하세요.');
  } else {
    lines.push('프로젝트의 현재 상태를 고려하여 팀원들에게 다음으로 해야 할 업무를 분배하세요.');
  }
  lines.push('');
  lines.push('반드시 아래 JSON 형식으로만 응답하세요 (앞뒤 설명 금지):');
  lines.push('{"tasks":[{"assignedTo":"에이전트id","description":"구체적 업무 설명(한국어)"}],"message":"팀에 전달할 한국어 한 줄 메시지(≤20단어)"}');
  lines.push('JSON 안의 description 과 message 는 반드시 한국어로 작성한다.');
  lines.push('');
  lines.push('규칙:');
  lines.push('- role 에 맞게 할당 (Developer=구현, QA=테스트, Designer=UI/UX, Researcher=조사)');
  lines.push('- description 은 파일명·함수명·기능 세부까지 포함한 구체 지시');
  lines.push('- idle 상태 팀원을 우선 할당');
  lines.push('- 팀원이 없거나 분배할 업무가 없으면 tasks 를 빈 배열로, message 만 채우세요');
  return lines.join('\n');
}

// 리더 응답에서 JSON 블록만 추출한다. ```json 펜스, 앞뒤 서술, 여러 JSON 혼재
// 케이스를 모두 방어적으로 다룬다.
export function extractLeaderPlan(text: string): { tasks: { assignedTo: string; description: string }[]; message?: string } | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (!parsed || typeof parsed !== 'object') return null;
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks
          .filter((t: any) => t && typeof t.assignedTo === 'string' && typeof t.description === 'string')
          .map((t: any) => ({ assignedTo: t.assignedTo, description: t.description }))
      : [];
    const message = typeof parsed.message === 'string' ? parsed.message : undefined;
    return { tasks, message };
  } catch {
    return null;
  }
}
