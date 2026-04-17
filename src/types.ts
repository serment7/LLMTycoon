
export type AgentRole = 'Leader' | 'Developer' | 'QA' | 'Designer' | 'Researcher';

export interface CodeFile {
  id: string;
  name: string;
  x: number;
  y: number;
  projectId: string;
  type: 'component' | 'service' | 'util' | 'style';
}

export interface CodeDependency {
  from: string; // file id
  to: string; // file id
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  spriteTemplate: string;
  persona?: string;
  x: number;
  y: number;
  status: 'idle' | 'working' | 'meeting' | 'thinking';
  currentTask?: string;
  lastMessage?: string;
  lastMessageTo?: string;
  workingOnFileId?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  workspacePath: string;
  agents: string[]; // Agent IDs
  status: 'active' | 'completed' | 'on-hold';
}

export interface GameState {
  projects: Project[];
  agents: Agent[];
  files: CodeFile[];
  dependencies: CodeDependency[];
}

export interface Task {
  id: string;
  projectId: string;
  assignedTo: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed';
}

export type SourceProvider = 'github' | 'gitlab';

export interface SourceIntegration {
  id: string;
  provider: SourceProvider;
  label: string;
  accessToken: string;
  host?: string; // 자체 서버(Enterprise/Self-hosted) 베이스 URL. 비우면 공식 호스트 사용.
  createdAt: string;
}

// 사용자의 로컬 UI 선호. 서버 DB가 아니라 브라우저(localStorage)에 저장되며,
// 협업 동료의 선택과 충돌하지 않도록 "이 단말에서의 기본값" 용도로만 사용한다.
export interface UserPreferences {
  // 최근에 확정한 PR 대상 프로젝트 ID. 다음 접속 시 라디오 기본값으로 자동 복원되고,
  // 사용자가 "변경" 버튼을 눌러 잠금을 풀기 전에는 다른 항목 선택을 막는다.
  pinnedPrTargetProjectId?: string;
  // Git 자동화 설정(flowLevel, 템플릿 등). 재접속 시에도 마지막 선택이 복원되어야
  // "실수로 매번 초기 플로우로 돌아가는" 회귀를 방지한다. 형식은 GitAutomationConfig.
  gitAutomation?: GitAutomationPreference;
}

// 저장용 축약 타입. utils/gitAutomation.ts 의 GitAutomationConfig 와 1:1 로 매핑되나,
// 순환 import 를 피하기 위해 types.ts 에서 구조만 재선언한다. 키 변경 시 양쪽을 함께 수정.
export interface GitAutomationPreference {
  flowLevel: 'commitOnly' | 'commitPush' | 'commitPushPR';
  branchTemplate: string;
  commitConvention: 'conventional' | 'plain';
  commitScope: string;
  prTitleTemplate: string;
  reviewers: string[];
}

// 서버 DB(git_automation_settings) 에 프로젝트별로 1:1 저장되는 레코드.
// projectId 가 주키. enabled=false 면 리더가 자동 실행을 건너뛴다.
export interface GitAutomationSettings {
  projectId: string;
  enabled: boolean;
  flowLevel: 'commitOnly' | 'commitPush' | 'commitPushPR';
  branchTemplate: string;
  commitConvention: 'conventional' | 'plain';
  commitScope: string;
  prTitleTemplate: string;
  reviewers: string[];
  updatedAt: string;
}

export const USER_PREFERENCES_KEY = 'llm-tycoon:user-preferences';

export interface ManagedProject {
  id: string;
  provider: SourceProvider;
  integrationId: string;
  remoteId: string;
  name: string;
  fullName: string;
  description?: string;
  url: string;
  defaultBranch?: string;
  // 사용자가 선택·저장한 PR 대상(base) 브랜치. 비어있으면 defaultBranch로 폴백.
  prBaseBranch?: string;
  // 사용자가 PR 작업 대상으로 지정한 프로젝트만 관리 화면 기본 목록에 노출된다.
  // 선택은 별도 모달의 검색 UI에서 토글하며, 서버 DB(managed_projects 컬렉션)에 영속된다.
  prTarget?: boolean;
  private: boolean;
  importedAt: string;
}
