
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
  // 리더 최근 발화 유형. 'reply' = 답변 전용(분배 없이 대화만), 'delegate' = 업무 분배,
  // 'plain' = 일반 텍스트. UI 가 리더 카드·말풍선·로그 배지를 이 값으로 판정한다.
  // 리더가 아닌 에이전트의 발화는 'plain' 으로 남긴다.
  lastLeaderMessageKind?: 'delegate' | 'reply' | 'plain';
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

// Git 자동화 파이프라인 각 단계(commit/push/pr)의 시작·성공·실패를 그대로 보존한
// 불변 이력 엔트리. 같은 단계에 대해 보통 started → (succeeded | failed) 두 건이
// 쌓이며, 설정 비활성/프로젝트 누락 같은 전체 스킵은 단일 'skipped' 엔트리로 요약한다.
// AgentStatusPanel 이 실패 원인 메시지를 사용자에게 노출할 때 errorMessage 를 그대로
// 읽도록 설계했다. 서버는 이 배열을 'git-automation:log' 소켓 이벤트로 방출하고,
// 클라이언트는 동일 태스크 ID 아래로 누적해 과거 실행까지 되짚을 수 있다.
export type GitAutomationLogStage = 'commit' | 'push' | 'pr';
export type GitAutomationLogOutcome = 'started' | 'succeeded' | 'failed' | 'skipped';

export interface GitAutomationLogEntry {
  // 이 엔트리가 속한 파이프라인 실행의 식별자. 같은 taskId 아래 여러 엔트리가
  // 들어올 수 있다. 서버 측 디바운스 키와 동일.
  taskId?: string;
  // 파이프라인을 촉발한 에이전트 이름(로그/감사용 메타데이터). 리더 단일 브랜치 정책
  // (2026-04-18)에 따라 UI 는 이 값을 기반으로 에이전트별 브랜치 축을 그리지 않는다
  // — GitAutomationStageBadge/GitAutomationPanel 은 branch 한 줄만 소비한다.
  // 알 수 없으면 비운다.
  agent?: string;
  stage: GitAutomationLogStage;
  outcome: GitAutomationLogOutcome;
  // 해당 outcome 이 발생한 시각(epoch ms). 시작/종료가 구분되지 않는 경로
  // (예: skipped) 에서는 관측된 순간 하나만 기록한다.
  at: number;
  // 자동화가 대상으로 잡은 브랜치 이름. 리더 트리거당 한 줄로 고정(단일 브랜치).
  // skipped 엔트리에서도 빈 값을 허용한다.
  branch?: string;
  // commit 단계 성공 시 server.ts 가 stdout 에서 파싱한 단축 SHA(7자+).
  commitSha?: string;
  // pr 단계 성공 시 `gh pr create` stdout 에서 파싱한 PR URL.
  prUrl?: string;
  // 단계가 돌려준 종료 코드. 알 수 없으면 null(spawn 실패) 또는 undefined(스킵).
  exitCode?: number | null;
  // 실패/스킵 사유. outcome === 'failed' 일 때 AgentStatusPanel 이 stage.errorMessage
  // 로 그대로 노출하고, 'skipped' 일 때는 스킵 원인(disabled/no-project)을 담는다.
  // 페이로드 비용을 막기 위해 400자 상한으로 잘라 서버가 채운다.
  errorMessage?: string;
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

// 프로젝트 단위 Git 자격증명. 기존 SourceIntegration 은 "저장소 임포트" 용으로
// 공급자별 여러 건을 허용하지만, 프로젝트 설정 화면의 GitCredentialsSection 은
// "이 프로젝트에 딱 한 쌍(provider + username + PAT)" 을 바인딩하는 간소 모델.
// 서버는 projectId 를 주키로 upsert 하고, 클라이언트로 내려줄 때는 token 을
// 반드시 마스킹해서 hasToken 플래그만 전달한다.
export interface GitCredential {
  projectId: string;
  provider: SourceProvider;
  username: string;
  // AES-256-GCM 으로 암호화된 personal access token 바이트를
  // base64 로 인코딩한 문자열(`iv(12) || authTag(16) || ciphertext`). 복호화 키는
  // 환경변수 GIT_TOKEN_ENC_KEY 에만 존재하므로, DB 덤프가 유출돼도 평문 복원은
  // 불가능하다. 응답 페이로드에는 절대 포함되지 않고, 저장 여부만 hasToken 으로 노출된다.
  tokenEncrypted: string;
  createdAt: string;
  updatedAt: string;
}

// 클라이언트가 읽는 형태: 암호문조차 내려보내지 않고 "저장됨" 플래그만 노출해
// UI 가 마스킹 배지를 표시할 수 있게 한다. POST 성공 응답과 GET 응답이 동일 구조를 공유한다.
export type GitCredentialRedacted = Omit<GitCredential, 'tokenEncrypted'> & { hasToken: boolean };

export const USER_PREFERENCES_KEY = 'llm-tycoon:user-preferences';

// 자동 개발 루프 전체가 공유하는 "공동 목표(sharedGoal)". 리더 에이전트가 분배
// 프롬프트를 조립할 때 주입되어 팀원들이 한 방향으로 움직이도록 가이드한다.
// 한 프로젝트에 동시에 활성인 목표는 1개로 한정(서버가 upsert 시 기존 active 를
// archived 로 내린다). 활성 목표가 없으면 /api/auto-dev 가 enabled=true 로
// 전환되는 것을 서버가 거부하고, auto-dev tick 도 해당 프로젝트를 건너뛴다.
export type SharedGoalPriority = 'low' | 'normal' | 'high';
export type SharedGoalStatus = 'active' | 'archived' | 'completed';

export interface SharedGoal {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: SharedGoalPriority;
  // ISO 문자열(YYYY-MM-DD 또는 전체 timestamp). 비우면 마감 미정.
  deadline?: string;
  status: SharedGoalStatus;
  createdAt: string;
}

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
