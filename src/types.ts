
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
  // idle 전환 시 currentTask 가 비워지지만, 새로고침 후에도 "마지막 작업 컨텍스트"
  // 를 복원해야 하는 UI(에이전트 카드의 최근 담당 태스크 표시) 가 있어 별도 필드로
  // 보존한다. 서버 재기동/클라이언트 재접속 직후에도 working→idle 이력이 남도록
  // PATCH /api/agents/:id/status 와 /api/tasks/:id 완료 분기에서 함께 갱신된다.
  lastActiveTask?: string;
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
  // 태스크 출처. 사용자가 직접 지시한 'user' 와 자동개발 루프가 생성한 'auto-dev',
  // 리더 에이전트가 계획한 'leader' 를 구분한다. 분석·필터링 용도이며, 비우면
  // 'user' 로 간주한다. (UI 배지·리더 자동 commit 트리거 등에서 활용)
  source?: 'user' | 'auto-dev' | 'leader';
  attachments?: DirectiveAttachment[];
}

// 사용자가 리더 지시 입력창에서 업로드한 첨부파일 메타. 업로드 엔드포인트가
// 반환한 fileId 로 서버가 실제 바이너리/추출 본문을 역참조한다. extractedText 는
// OCR/텍스트 추출 결과, images 는 base64 로 인코딩된 이미지 페이로드(프롬프트
// 주입용). 둘 중 하나만 있는 케이스도 허용한다 (예: 순수 텍스트 첨부는 images 생략).
export interface DirectiveAttachment {
  fileId: string;
  name: string;
  type: string;
  extractedText?: string;
  images?: string[];
}

// 전역 자동개발(auto-dev) 상태. 서버가 source of truth 를 소유해 어느 브라우저에서
// 토글해도 동일하게 반영되도록 MongoDB 에 영속화한다. 클라이언트는 REST 로
// 조회/갱신하고 socket 이벤트로 푸시된 최신 값을 반영한다.
export interface AutoDevSettings {
  enabled: boolean;
  // projectId 를 지정하면 해당 프로젝트의 에이전트만 자동 실행 대상.
  // 비우면 모든 프로젝트를 대상으로 한다.
  projectId?: string;
  updatedAt: string;
}

export type SourceProvider = 'github' | 'gitlab';

export interface SourceIntegration {
  id: string;
  // 관리 메뉴 데이터는 게임 프로젝트별로 격리된다. 서버는 projectId 스코프 밖의
  // 연동을 조회/삭제/가져오기 대상으로 삼지 않는다.
  projectId: string;
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
  // 관리 메뉴 데이터는 게임 프로젝트별로 격리된다. 동일한 remote 저장소라도 다른
  // 게임 프로젝트에 속하면 별개 레코드로 관리한다.
  projectId: string;
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
