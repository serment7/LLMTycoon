import type { Agent, AgentRole, CodeFile, Project, Task, SharedGoal } from '../types';
import { findBalancedJsonCandidates } from './promptsJsonExtract';
import type { LLMProviderName } from './llm/provider';

// 지시 #87cbd107 — 코드 컨벤션/룰을 프롬프트 블록으로 직렬화하는 경량 타입.
// `src/stores/codeRulesStore.ts` 의 CodeRulesRecord 와 같은 모양을 갖지만, 서버
// 프롬프트 모듈이 브라우저 스토어(IndexedDB) 에 의존하지 않도록 타입만 복제한다.
// (실 값은 디스패처(src/services/agentDispatcher.ts) 가 조달한다.)
export interface CodeRulesForPrompt {
  scope: 'local' | 'global';
  indentation: { style: 'space' | 'tab'; size: number };
  quotes: 'single' | 'double' | 'backtick';
  semicolons: 'required' | 'omit';
  filenameConvention: string;
  linterPreset: string;
  forbiddenPatterns: { name: string; pattern: string; message?: string }[];
  extraInstructions?: string;
}

/**
 * 코드 컨벤션 블록을 프롬프트 라인 배열로 직렬화한다. null 이면 빈 배열.
 * 시스템/태스크 프롬프트 상단(언어 규칙 바로 아래) 에 삽입하는 용도.
 */
export function renderCodeRulesBlock(rules: CodeRulesForPrompt | null | undefined): string[] {
  if (!rules) return [];
  const lines: string[] = [];
  lines.push('[코드 컨벤션 / 룰]');
  lines.push(`- 스코프: ${rules.scope === 'local' ? '프로젝트 전용' : '전역 공통'}`);
  lines.push(`- 들여쓰기: ${rules.indentation.style} × ${rules.indentation.size}`);
  lines.push(`- 따옴표: ${rules.quotes}`);
  lines.push(`- 세미콜론: ${rules.semicolons}`);
  lines.push(`- 파일명 규칙: ${rules.filenameConvention}`);
  lines.push(`- 린터 프리셋: ${rules.linterPreset}`);
  if (rules.forbiddenPatterns.length > 0) {
    lines.push('- 금지 패턴(regex) — 아래 패턴에 매치되는 코드를 새로 작성하지 마세요:');
    for (const p of rules.forbiddenPatterns) {
      const msg = p.message ? ` — ${p.message}` : '';
      lines.push(`    · ${p.name}: \`${p.pattern}\`${msg}`);
    }
  }
  if (rules.extraInstructions && rules.extraInstructions.trim()) {
    lines.push('- 추가 지시:');
    for (const l of rules.extraInstructions.split('\n')) lines.push(`    ${l}`);
  }
  lines.push('위 규칙을 위반하는 기존 코드는 새 변경분에 한해 점진적으로 수정하라.');
  lines.push('');
  return lines;
}

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

export interface BuildSystemPromptOptions {
  /**
   * 현재 LLM 프로바이더. 프로바이더에 따라 노출되는 도구 이름과 호출 규약이 다르다:
   *   - 'claude-cli': Read/Write/Edit/Glob/Grep/Bash 빌트인 도구가 기본 제공되며, 도구
   *     호출은 CLI 가 내부적으로 관리한다. 파이썬형 서술을 그대로 두어도 CLI 가 해석.
   *   - 'ollama' / 'vllm': tool schema 는 OpenAI function-calling 포맷으로 read_file /
   *     write_file / edit_file / list_files_fs / grep_files + MCP 도구만 노출된다.
   *     Read/Write 같은 이름은 존재하지 않으므로 프롬프트에 등장하면 모델이 본문에
   *     파이썬 의사 코드로 흘려 쓰는 회귀가 발생한다.
   * 기본값은 'claude-cli'(하위호환).
   */
  provider?: LLMProviderName;
}

// 공통 시스템 프롬프트. 한 번 spawn 된 워커에 append-system-prompt 로 주입되어
// 이후 모든 유저 턴에 기본 컨텍스트로 따라 붙는다. 개별 턴에서 반복 서술하지
// 않도록 "불변" 규칙을 여기 모은다.
export function buildSystemPrompt(agent: Agent, opts: BuildSystemPromptOptions = {}): string {
  const provider = opts.provider ?? 'claude-cli';
  const isLocal = provider === 'ollama' || provider === 'vllm';

  const header = [
    '[언어 규칙 — 최우선]',
    '- 반드시 한국어(한글)로만 응답한다. 코드·식별자·파일명을 제외하고 영어 단어를 섞어 쓰지 않는다. 기술 용어는 가능하면 한국어로 번역하거나 괄호 병기한다.',
    '- 모든 사용자 응답·동료 메시지·로그 문장은 반드시 한국어로 작성한다.',
    '- 코드·식별자·파일명·커맨드는 원문(영문) 그대로 두되, 주석과 설명은 한국어.',
    '- 영어로 답하고 싶더라도 한국어로 번역해 출력한다. (게임 UI가 한국어 전용이다)',
    '',
    `당신은 ${translateRole(agent.role)} "${agent.name}" 입니다.`,
    agent.persona?.trim() ? `페르소나: ${agent.persona.trim()}` : '',
    '',
    '당신은 프로젝트 워크스페이스 디렉터리에서 직접 코드를 읽고/쓰고/편집하는 개발 에이전트입니다.',
    '',
  ];

  const toolSection = isLocal ? localToolSection() : claudeToolSection();
  const checklist = isLocal ? localChecklist() : claudeChecklist();

  return [...header, ...toolSection, ...checklist].filter(Boolean).join('\n');
}

// Claude CLI 경로: 빌트인 도구 + MCP 도구 블록. CLI 자체가 도구 호출을 파이썬 서술로도
// 유연하게 받아 주므로 기존 문구를 그대로 유지한다.
function claudeToolSection(): string[] {
  return [
    '[빌트인 도구]',
    '- Read / Glob / Grep: 워크스페이스 파일 탐색·이해',
    '- Write / Edit: 파일 생성·수정 (실제 디스크에 반영)',
    '- Bash: 빌드·테스트·git 등 명령 실행',
    '',
    '[MCP 도구 — 게임 상태/코드그래프 동기화]',
    '- list_files(): 현재 프로젝트의 코드그래프 파일 노드 목록/ID 조회',
    '- add_file(name, type?): 그래프에 파일 노드를 추가. 이미 존재하면 서버가 기존 노드를 반환(멱등). 호출이 과해서 생기는 부작용은 없다.',
    '- add_dependency(from_file_id, to_file_id): 두 파일 사이 의존성 엣지 기록',
    '- update_status(status, working_on_file_id): 작업 시작/종료뿐 아니라 파일·페이즈 경계마다 **선보고**한다. working_on_file_id 는 코드를 만지는 동안에는 비워두지 말 것.',
    '- whoami(): 현재 컨텍스트 확인',
    '',
  ];
}

function claudeChecklist(): string[] {
  return [
    '[필수 체크리스트 — 매 지시마다 반드시 이 순서로 수행]',
    '1) update_status("working", <파일ID 또는 "">) 로 착수 보고. **상태 선(先)보고 원칙**: 아래 경계 지점에서도 작업을 시작하기 전에 update_status 를 다시 호출해 working_on_file_id 와 짧은 한국어 진행 메시지를 갱신한다(작업이 끝난 뒤 몰아서 보고하는 것은 위반).',
    '   - 파일 경계: 새 파일을 처음 Read/Write/Edit 하기 직전 1회 (같은 파일 연속 수정은 추가 호출 불필요)',
    '   - 페이즈 경계: 탐색 → 구현 → 테스트 → 문서화 등 단계가 바뀌기 직전 1회',
    '2) list_files() 를 한 번 호출해 현재 코드그래프 상태를 **반드시** 캡처',
    '3) Read/Glob/Grep 으로 워크스페이스 현황 파악',
    '4) Write/Edit 로 실제 코드 변경 수행 (새 파일을 처음 만지기 직전 1) 의 경계 재보고 규칙 적용)',
    '5) **그래프 동기화 — 누락 금지 규칙**:',
    '   - 이번 턴에 Read/Write/Edit 로 한 번이라도 건드린 모든 파일에 대해 add_file 을 호출한다.',
    '   - "이미 등록돼 있을 것 같다" 는 판단으로 스킵하지 말 것. add_file 은 멱등하므로 중복 호출이 안전하다.',
    '   - import / require / include / from ... import 구문으로 끌어오는 모든 파일마다 add_dependency 를 호출한다.',
    '   - 2) 에서 list_files 로 얻은 ID 목록을 이 단계에서 매칭 근거로 사용한다.',
    '6) update_status("idle", "") 로 종료 보고',
    '7) 최종 출력: 동료에게 전달할 한국어 한 줄(≤20단어). 따옴표·이름표·도구 호출 로그 금지.',
    '',
    '체크리스트 5) 는 게임 코드그래프의 정합성을 유지하기 위한 핵심 단계다. 누락되면 UI 가 실제 코드 구조를 추적하지 못해 게임이 깨진다. 의심되면 더 많이 호출하는 쪽을 택하라.',
    '항목 1) 의 경계 재보고는 사용자가 "지금 무슨 파일에서 어느 단계를 진행 중인지" 실시간으로 추적하기 위한 핵심 장치다. 토큰 비용이 약간 늘더라도 의심되면 한 번 더 호출하라.',
  ];
}

// 로컬 LLM(ollama/vllm) 경로: 7-8B급 지시 모델은 "번호 매긴 긴 체크리스트"를 주면
// 실행이 아니라 echo(그대로 재출력)로 빠지는 회귀가 있다(실사례: llama3.1:8b 가
// "1) update_status... 2) list_files..." 를 통째로 본문에 복사). 대응책은 두 가지:
//   (a) 서술형·번호매김을 최소화하고 명령형·단문으로 행동 원칙만 제시,
//   (b) "~할 것입니다 / ~합니다" 같은 narration 이 발생하면 실패임을 모델에게 직접 알림.
function localToolSection(): string[] {
  return [
    '[도구 호출 규약]',
    '작업을 말로 설명하지 말고 도구(tool_calls)를 호출해 실제로 실행하라.',
    '"~할 것입니다 / ~합니다 / ~를 작성합니다" 같은 미래형 서술이 본문에 등장하면 실패다 — 그런 문장이 떠오르면 그 행위를 tool_calls 로 바꿔라.',
    '본문(content)에는 모든 도구 호출이 끝난 뒤 동료에게 전할 한국어 한 줄만 쓴다. 도구 이름을 본문에 적거나 체크리스트를 재출력하지 않는다.',
    '',
    '[사용 가능한 도구 이름]',
    'update_status, list_files, add_file, add_dependency, whoami, get_git_automation_settings, trigger_git_automation, read_file, write_file, edit_file, list_files_fs, grep_files',
    '각 도구의 인자 스키마는 tool schema 로 시스템이 제공한다. 여기서는 이름만 기억하라.',
    '',
  ];
}

function localChecklist(): string[] {
  return [
    '[행동 원칙]',
    '- 지시를 받으면 곧바로 update_status 를 호출해 상태 working 을 보고하며 시작한다.',
    '- **상태 선(先)보고**: 새 파일을 처음 read_file / write_file / edit_file 하기 직전, 그리고 단계가 바뀔 때(탐색→구현→테스트→문서화 등)마다 update_status 를 다시 호출해 working_on_file_id 와 짧은 한국어 진행 메시지를 갱신한다. 작업을 다 마친 뒤 한 번에 몰아서 보고하면 실패다.',
    '- 파일 내용을 파악할 땐 list_files_fs / grep_files / read_file 을, 수정할 땐 write_file / edit_file 을 호출한다.',
    '- 건드린 파일마다 add_file 을 호출해 코드그래프에 반영한다(멱등, 중복 안전).',
    '- import 나 require 로 끌어오는 관계가 있으면 add_dependency 로 의존성을 기록한다.',
    '- 작업이 끝나면 update_status 로 idle 을 보고한 뒤, 한국어 한 줄로만 완료 메시지를 남긴다.',
    '- 도구 이름이나 호출 문법(add_file("x","y") 등)을 본문에 쓰지 않는다. 그러면 실행되지 않는다.',
    '',
    '[도구 인자 가드 — 빈 값으로 호출하지 말 것]',
    '- write_file 의 content 는 절대 빈 문자열이면 안 된다. 실제 파일 전체 내용을 담아라. 무엇을 쓸지 모르면 먼저 read_file 로 현재 내용을 확인한다.',
    '- edit_file 의 old_string 은 비우지 말고, 파일 안에서 고유한(유일하게 매칭되는) 문자열을 지정한다. 매칭이 실패하면 더 긴 맥락을 포함해 재시도한다.',
    '- add_dependency 의 from_file_id / to_file_id 는 둘 다 list_files 결과에서 얻은 실제 ID 여야 한다. 빈 문자열·추측 ID 금지.',
    '- list_files 는 인자가 없는 도구다. project_id 같은 추가 인자는 넘기지 말라(무시됨).',
    '',
    '[도구 응답 처리 규칙]',
    '- 도구가 결과를 돌려주면 결과를 영어든 한국어든 "요약·설명"하는 대신, 다음에 필요한 도구를 곧바로 호출한다. 예: list_files_fs 결과 → 바로 read_file 로 후속 호출, 설명 출력 금지.',
    '- 작업이 완전히 끝난 경우에만 content 에 한국어 한 줄을 쓰고 마무리한다. 중간 단계에서는 content 를 비워 두고 tool_calls 만 돌려 준다.',
  ];
}

interface TaskPromptInput {
  agent: Agent;
  task: Task;
  project?: Project | null;
  candidateFile?: CodeFile | null;
  peer?: Agent | null;
  /** 지시 #87cbd107 — 로컬/전역 코드 컨벤션 블록. 디스패처가 조달해 주입. */
  codeRules?: CodeRulesForPrompt | null;
  /**
   * 현재 LLM 프로바이더. 로컬 모델(ollama/vllm) 일 때만 "도구 응답 처리 — 절대 규칙"
   * 블록을 프롬프트 말미에 한 번 더 못박아, list_files_fs 결과를 영문으로 설명만
   * 늘어놓고 후속 도구 호출을 안 하는 8B급 회귀(실사례: llama3.1:8b 가
   * "This is a text file containing a list of files..." 만 출력) 를 차단한다.
   * 미지정·claude-cli 일 때는 추가 블록을 넣지 않는다(CLI 는 이 회귀가 없음).
   */
  provider?: LLMProviderName;
}

export function buildTaskPrompt(input: TaskPromptInput): string {
  const { agent, task, project, candidateFile, peer, codeRules, provider } = input;
  const isLocal = provider === 'ollama' || provider === 'vllm';
  const lines: string[] = [];
  lines.push('[언어 규칙 — 최우선]');
  lines.push('반드시 한국어(한글)로만 응답한다. 코드·식별자·파일명을 제외하고 영어 단어를 섞어 쓰지 않는다. 기술 용어는 가능하면 한국어로 번역하거나 괄호 병기한다.');
  lines.push('');
  for (const l of renderCodeRulesBlock(codeRules)) lines.push(l);
  lines.push(`[새 지시 #${task.id.slice(0, 8)}]`);
  lines.push(`할당된 업무: ${task.description}`);
  if (project) lines.push(`프로젝트: ${project.name}${project.description ? ` — ${project.description}` : ''}`);
  if (candidateFile) lines.push(`우선 검토 파일: "${candidateFile.name}" (id: ${candidateFile.id})`);
  if (peer && peer.id !== agent.id) {
    lines.push(`완료 후 소통 대상: ${translateRole(peer.role)} "${peer.name}" (id: ${peer.id})`);
  }
  lines.push('');
  if (isLocal) {
    lines.push('[도구 응답 처리 — 절대 규칙]');
    lines.push('list_files / list_files_fs / read_file / grep_files 가 결과를 돌려주면, 그 결과를 한국어든 영어든 설명·요약·재구성하지 말고 곧바로 다음 도구(read_file / edit_file / write_file 등) 를 호출하라.');
    lines.push('"This is a ...", "Here\'s a breakdown ...", "The data consists of ...", "이 파일은 ... 입니다" 같은 도구 결과 풀어쓰기 문장이 본문에 등장하면 그 자체로 실패 신호다 — 그 시점에 즉시 후속 도구 호출로 전환하라.');
    lines.push('content(본문) 는 모든 도구 호출이 끝난 뒤 동료에게 전할 한국어 한 줄에만 쓴다. 중간 단계에서는 content 를 비우고 tool_calls 만 돌려준다.');
    lines.push('');
  }
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
  // 프로젝트 전체가 지향하는 활성 공동 목표. 존재하면 리더 프롬프트 상단에
  // "공동 목표" 블록으로 주입되어 분배 판단의 기준점이 된다.
  sharedGoal?: SharedGoal | null;
}

function priorityLabel(priority: SharedGoal['priority']): string {
  switch (priority) {
    case 'high': return '높음';
    case 'low': return '낮음';
    default: return '보통';
  }
}

function renderSharedGoalBlock(goal: SharedGoal | null | undefined): string[] {
  if (!goal) return [];
  const lines: string[] = [];
  lines.push('[공동 목표]');
  lines.push(`- 제목: ${goal.title}`);
  if (goal.description) lines.push(`- 설명: ${goal.description}`);
  lines.push(`- 우선순위: ${priorityLabel(goal.priority)}`);
  if (goal.deadline) lines.push(`- 마감: ${goal.deadline}`);
  lines.push('모든 분배는 위 목표를 향해 수렴해야 한다. 목표와 어긋나는 작업은 배제하라.');
  lines.push('');
  return lines;
}

// 리더가 팀원에게 업무를 분배하기 위해 사용하는 프롬프트. 출력은 엄격한 JSON.
// JSON 파싱 로직은 dispatcher 측에서 처리한다.
export function buildLeaderPlanPrompt(input: LeaderPlanPromptInput): string {
  const { agent, project, peers, trigger, userCommand, sharedGoal } = input;
  const memberList = peers
    .filter(p => p.id !== agent.id)
    .map(p => `- ${p.name} (${translateRole(p.role)}, id: ${p.id}, 상태: ${p.status})`)
    .join('\n') || '- (없음)';
  const lines: string[] = [];
  lines.push('[언어 규칙 — 최우선]');
  lines.push('반드시 한국어(한글)로만 응답한다. 코드·식별자·파일명을 제외하고 영어 단어를 섞어 쓰지 않는다. 기술 용어는 가능하면 한국어로 번역하거나 괄호 병기한다.');
  lines.push('');
  lines.push(`당신은 팀 리더 "${agent.name}" 입니다. ${agent.persona?.trim() ? `페르소나: ${agent.persona.trim()}` : ''}`.trim());
  lines.push(`프로젝트: ${project.name} — ${project.description || ''}`);
  lines.push('');
  for (const l of renderSharedGoalBlock(sharedGoal)) lines.push(l);
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
  lines.push('반드시 아래 JSON 형식으로만 응답하세요 (앞뒤 설명 금지). mode 는 이번 응답의 성격을 선언하는 필수 필드입니다:');
  lines.push('- mode="dispatch": 팀원에게 업무를 분배하는 평상시 경로. tasks 를 한 개 이상 채운다.');
  lines.push('- mode="reply": 사용자의 단순 질문·상태 확인·안부 등에 답만 하고 종료할 때. tasks 는 빈 배열로 두고 message 에 답변을 담는다.');
  lines.push('분배 예:');
  lines.push('{"mode":"dispatch","tasks":[{"assignedTo":"에이전트id","description":"로그인 폼 컴포넌트의 이메일·비밀번호 유효성 검증 함수를 추가한다"}],"message":"로그인 흐름 개선 작업을 팀에 분배합니다"}');
  lines.push('답변 예:');
  lines.push('{"mode":"reply","tasks":[],"message":"현재 프로젝트는 인증 모듈 리팩터링 단계에 있으며, 오늘 처리 중인 태스크는 3건입니다."}');
  lines.push('JSON 안의 description 과 message 는 반드시 한국어 문장으로 작성한다. 영어 단어는 파일명·식별자·코드 토큰에만 허용한다.');
  lines.push('');
  lines.push('규칙:');
  lines.push('- mode 판정: 사용자 지시가 "해줘/추가해/구현해" 류의 실행 요청이면 dispatch, "뭐 해?/어때?/얼마나 진행됐어?" 류의 조회·질문이면 reply.');
  lines.push('- dispatch 일 때: role 에 맞게 할당 (Developer=구현, QA=테스트, Designer=UI/UX, Researcher=조사)');
  lines.push('- description 은 파일명·함수명·기능 세부까지 포함한 구체 지시');
  lines.push('- idle 상태 팀원을 우선 할당');
  lines.push('- reply 일 때: tasks 를 반드시 빈 배열로 두고, message 에 사용자가 바로 읽을 한국어 답변(1~3문장)만 담는다.');
  lines.push('- 분배할 업무를 찾지 못한 경우에도 억지로 tasks 를 만들지 말고 mode="reply" 로 사유를 message 에 적는다.');
  lines.push('');
  lines.push('[에이전트 개선 보고 수신 시 — 재분배 로직]');
  lines.push('- 사용자 지시 또는 이전 턴의 맥락에 "개선/리팩터/버그 수정/테스트 추가/구현 완료" 류의 에이전트 완료 보고가 포함되면,');
  lines.push('  해당 변경이 영향을 줄 수 있는 인접 영역(QA 시나리오·문서·연관 모듈)을 식별하고 후속 업무를 mode="dispatch" 로 배분하라.');
  lines.push('- 한 명이 구현을 마친 경우 기본 분배 규칙:');
  lines.push('  1) QA 팀원에게 해당 변경 범위의 회귀 테스트/시나리오 확장 업무를 할당.');
  lines.push('  2) 다른 Developer 에게 연관 파일의 통합/후속 개선이 필요한지 점검 업무를 할당.');
  lines.push('  3) 후속이 실제로 필요 없다고 판단되면 mode="reply" 로 사유를 기록하고 재분배를 생략한다.');
  lines.push('- 재분배로 생성되는 task.description 에는 원 개선 보고의 요약(무엇을 누가 완료했는지)을 명시해 후속 팀원이 컨텍스트를 잃지 않게 한다.');
  lines.push('- 같은 개선 보고에 대해서는 한 번만 재분배한다(중복 분배 금지) — 이미 분배된 후속 작업이 있다면 mode="reply" 로 상태만 알린다.');
  return lines.join('\n');
}

// 리더 응답에서 JSON 블록만 추출한다. ```json 펜스, 앞뒤 서술, 여러 JSON 혼재,
// description 내부의 `}` 를 모두 방어한다. 상세 전략은 `promptsJsonExtract.ts` 참조.
// mode 는 프롬프트에서 필수 필드로 요구하지만, 과거 응답과의 호환을 위해 누락된
// 경우 tasks 길이로 추정한다(있으면 dispatch, 없으면 reply).
export type LeaderPlanMode = 'dispatch' | 'reply';

export interface ExtractedLeaderPlan {
  mode: LeaderPlanMode;
  tasks: { assignedTo: string; description: string }[];
  message?: string;
}

interface RawTaskCandidate {
  assignedTo?: unknown;
  description?: unknown;
}

interface RawLeaderPlan {
  mode?: unknown;
  tasks?: unknown;
  message?: unknown;
}

function isLeaderPlanShape(value: unknown): value is RawLeaderPlan {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  // 빈 객체 `{}` 는 하위호환(leaderDispatch.test.ts) 상 reply 로 수렴해야 하므로 허용.
  if (keys.length === 0) return true;
  // 그 외에는 최소 한 가지 리더 플랜 관련 필드가 있어야 "리더 플랜 JSON" 으로 인정한다.
  // 전혀 관련 없는 객체(예: 설명 안에 포함된 JSON 예시·스키마 메타) 를 무시하기 위한 식별 휴리스틱.
  return keys.some(k => k === 'mode' || k === 'tasks' || k === 'message');
}

function normalizeLeaderPlan(raw: RawLeaderPlan): ExtractedLeaderPlan {
  const rawTasks = Array.isArray(raw.tasks) ? (raw.tasks as RawTaskCandidate[]) : [];
  // 공백만으로 채워진 assignedTo/description 은 하류 dispatcher 에서 "수신자 ''" /
  // "빈 지시" 로 귀결돼 회귀를 유발한다. 문자열 타입 + trim 길이>0 까지 확인해
  // 무의미한 항목을 사전 차단.
  const tasks = rawTasks
    .filter((t): t is { assignedTo: string; description: string } =>
      !!t
      && typeof t.assignedTo === 'string' && t.assignedTo.trim().length > 0
      && typeof t.description === 'string' && t.description.trim().length > 0)
    .map(t => ({ assignedTo: t.assignedTo, description: t.description }));
  // 빈 문자열 message 는 undefined 로 승격 — UI 가 "메시지 있음" 으로 오인하는 회귀 차단.
  const rawMessage = typeof raw.message === 'string' ? raw.message : '';
  const message = rawMessage.trim().length > 0 ? rawMessage : undefined;
  const rawMode = typeof raw.mode === 'string' ? raw.mode.toLowerCase() : '';
  const mode: LeaderPlanMode =
    rawMode === 'reply' || rawMode === 'dispatch'
      ? (rawMode as LeaderPlanMode)
      : tasks.length > 0
        ? 'dispatch'
        : 'reply';
  return { mode, tasks, message };
}

export function extractLeaderPlan(text: string): ExtractedLeaderPlan | null {
  if (!text) return null;
  const candidates = findBalancedJsonCandidates(text);
  // 빈 객체(`{}`) 는 하위호환 계약상 허용되지만(leaderDispatch.test.ts:247), 여러
  // 후보 중 앞에 있을 때 뒤의 "명시적 mode/tasks/message" 후보를 가리는 회귀가
  // 있었다. 본 루프는 명시적 후보를 우선 채택하고, 명시적 후보가 전혀 없을 때만
  // 빈 객체 후보를 fallback 으로 돌려준다. 단일 `{}` 단독 입력에서는 하위호환대로
  // reply 가 그대로 반환된다.
  let fallback: ExtractedLeaderPlan | null = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isLeaderPlanShape(parsed)) continue;
      const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed as Record<string, unknown>) : [];
      const isExplicit = keys.some(k => k === 'mode' || k === 'tasks' || k === 'message');
      if (isExplicit) return normalizeLeaderPlan(parsed as RawLeaderPlan);
      if (!fallback) fallback = normalizeLeaderPlan(parsed as RawLeaderPlan);
    } catch {
      // 다음 후보를 시도. 균형 잡힌 중괄호여도 내부 값이 잘못된 JSON(예: single-quote
      // 문자열) 인 경우 파싱이 실패한다 — 그다음 후보로 넘어간다.
    }
  }
  return fallback;
}

// ────────────────────────────────────────────────────────────────────────────
// 매체 생성 도구 명세 (#bc9843bb)
// ────────────────────────────────────────────────────────────────────────────
//
// 에이전트가 멀티미디어 생성 기능(PDF 리포트·PPT 덱·영상) 을 쓰고 싶을 때,
// 응답 본문에 JSON 블록으로 "도구 호출 의도" 를 낸다:
//
//   {"tool":"generate_pdf", "input":{"title":"…","sections":[{"heading":"…","body":"…"}],"assetIds":["…"]}}
//   {"tool":"generate_pptx","input":{"slides":[{"title":"…","body":"…"}]}}
//   {"tool":"generate_video","input":{"prompt":"…"}}
//
// 이 블록은 `promptsJsonExtract.findBalancedJsonCandidates` 로 안전하게 추출된다.
// Claude CLI 네이티브 tool_use 프로토콜을 쓰지 않는 이유:
//   (a) 서버 측 MCP 에 새 도구를 등록하려면 에이전트 워커 spawn 파라미터 변경이
//       필요한데, 본 사이클에서는 그 경로를 건드리지 않는 것이 안전하다(Joker 의
//       mediaProcessor/세션 폴백과 충돌 위험).
//   (b) `findBalancedJsonCandidates` 는 이미 리더 경로에서 greedy regex 회귀를
//       견디도록 검증된 파서이므로 재사용 비용이 0 이다.

export type MediaToolName = 'generate_pdf' | 'generate_pptx' | 'generate_video';

export const MEDIA_TOOL_NAMES: readonly MediaToolName[] = Object.freeze([
  'generate_pdf', 'generate_pptx', 'generate_video',
]) as readonly MediaToolName[];

export interface MediaToolRequest {
  tool: MediaToolName;
  /** 요청 본문 — 각 도구별 스키마는 `describeMediaToolSchema` 참조. 소비자가 검증. */
  input: Record<string, unknown>;
}

/** 에이전트 프롬프트에 주입할 한국어 사용법 블록. 시스템 프롬프트 끝에 append. */
export function formatMediaToolGuide(): string {
  return [
    '[매체 생성 도구 — 응답 본문 JSON 블록으로 호출]',
    '멀티미디어 생성이 필요할 때, 아래 JSON 중 하나를 응답 본문에 그대로 포함한다.',
    '여러 건을 연달아 내도 되며, 서버가 순서대로 실행한다.',
    '세션이 소진(exhausted) 상태면 호출이 큐잉되고 타임라인에 "토큰 소진 대기" 로 기록된다.',
    '',
    '1) PDF 리포트 생성',
    '   {"tool":"generate_pdf","input":{"title":"제목","sections":[{"heading":"절 제목","body":"본문"}],"assetIds":["<선택: 첨부 MediaAsset id 배열>"]}}',
    '',
    '2) PPT 덱 생성',
    '   {"tool":"generate_pptx","input":{"slides":[{"title":"슬라이드 제목","body":"선택 본문"}, ...]}}',
    '',
    '3) 영상 생성 (세션 소진 시 차단 — 큐잉됨)',
    '   {"tool":"generate_video","input":{"prompt":"영상 프롬프트"}}',
  ].join('\n');
}

/**
 * 응답 텍스트에서 매체 도구 호출 JSON 블록을 스캔해 구조화된 요청 배열로 돌려준다.
 * `findBalancedJsonCandidates` 가 이미 코드펜스 · 다중 블록 · 문자열 내 중괄호를
 * 모두 처리하므로 본 함수는 "모양 검증" 만 수행한다. 잘못된 모양은 조용히 건너뛴다.
 *
 * 계약:
 *   · `tool` 이 MEDIA_TOOL_NAMES 에 없으면 제외.
 *   · `input` 이 객체가 아니면 제외(배열·null·primitive 거부).
 *   · 본 함수는 입력 값의 세부 스키마(title/slides/prompt 필수 여부) 는 검증하지 않는다
 *     — 상위 디스패처가 mediaGenerator 의 시그니처에 맞춰 2차 검증을 수행한다.
 */
export function parseMediaToolRequests(text: string): MediaToolRequest[] {
  if (!text) return [];
  const candidates = findBalancedJsonCandidates(text);
  const out: MediaToolRequest[] = [];
  for (const c of candidates) {
    let parsed: unknown;
    try { parsed = JSON.parse(c); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const tool = obj.tool;
    if (typeof tool !== 'string') continue;
    if (!MEDIA_TOOL_NAMES.includes(tool as MediaToolName)) continue;
    const input = obj.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    out.push({ tool: tool as MediaToolName, input: input as Record<string, unknown> });
  }
  return out;
}
