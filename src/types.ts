
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
  // 프로젝트 관리 옵션. 스키마리스 저장(MongoDB) 환경이라 필드 누락을 허용하되,
  // 서버는 POST /api/projects 에서 기본값을 채워 넣고 읽기 경로에서는 누락된
  // 필드를 undefined 로 노출해 클라이언트가 기본값 폴백을 수행한다.
  autoDevEnabled?: boolean;
  autoCommitEnabled?: boolean;
  autoPushEnabled?: boolean;
  defaultBranch?: string;
  gitRemoteUrl?: string;
  // 활성 공동 목표(SharedGoal) 의 id. 프로젝트는 단일 목표를 가리키며, 서버가
  // setAutoDev / autoDevTick 에서 이 포인터 또는 최신 active goal 을 사용한다.
  sharedGoalId?: string;
  // 관리 UI 가 자유롭게 저장하는 키-값 묶음. Jsonb 대체 — MongoDB 문서 필드에
  // 그대로 포함되며, 클라이언트 변경은 PATCH /api/projects/:id 를 통해 저장한다.
  settingsJson?: Record<string, unknown>;
  // Git 자동화 브랜치 전략. 기본 'per-session' — 자동 개발 세션 1회당 단일
  // 브랜치를 재사용해 커밋마다 새 브랜치가 만들어지는 회귀를 막는다.
  branchStrategy?: BranchStrategy;
  // strategy === 'fixed-branch' 에서 사용하는 고정 브랜치 이름.
  fixedBranchName?: string;
  // strategy ∈ {per-task, per-session} 에서 사용하는 브랜치 이름 템플릿.
  // `{date}` `{shortId}` `{type}` `{slug}` `{agent}` 토큰을 치환한다.
  branchNamePattern?: string;
  // 푸시 성공 후 defaultBranch 로 자동 병합할지 여부. 기본 false.
  autoMergeToMain?: boolean;
  // 'per-session' 전략 하에서 현재 서버가 재사용 중인 브랜치명. executeGitAutomation
  // 이 첫 호출에 기록하고, 이후 같은 세션에서는 이 값을 재사용한다. 프로세스
  // 재기동 시에도 같은 세션이 이어지도록 DB 에 영속화한다.
  currentAutoBranch?: string;
}

export type BranchStrategy = 'per-commit' | 'per-task' | 'per-session' | 'fixed-branch';

export const BRANCH_STRATEGY_VALUES: readonly BranchStrategy[] = [
  'per-commit',
  'per-task',
  'per-session',
  'fixed-branch',
] as const;

// 프로젝트 옵션 부분 업데이트(PATCH /api/projects/:id) 입력. Zod 가 설치돼 있지
// 않은 저장소라 서버가 직접 필드별 타입·열거값을 검사한다. 지정하지 않은 필드는
// 기존 값을 유지하며, null 명시는 "해제"(미설정) 의도로 해석된다.
export interface ProjectOptionsUpdate {
  autoDevEnabled?: boolean;
  autoCommitEnabled?: boolean;
  autoPushEnabled?: boolean;
  defaultBranch?: string;
  gitRemoteUrl?: string | null;
  sharedGoalId?: string | null;
  settingsJson?: Record<string, unknown>;
  branchStrategy?: BranchStrategy;
  fixedBranchName?: string;
  branchNamePattern?: string;
  autoMergeToMain?: boolean;
}

export const PROJECT_OPTION_DEFAULTS = {
  autoDevEnabled: false,
  autoCommitEnabled: false,
  autoPushEnabled: false,
  defaultBranch: 'main',
  settingsJson: {} as Record<string, unknown>,
  branchStrategy: 'per-session' as BranchStrategy,
  fixedBranchName: 'auto/dev',
  branchNamePattern: 'auto/{date}-{shortId}',
  autoMergeToMain: false,
} as const;

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
  // 지시 #75971d83 — 태스크가 생성·참조한 docs/ 하위 임시/사인오프 문서 경로.
  // 리포지토리 루트 기준 상대경로(예: "docs/design/foo.md"). 태스크가 completed 로
  // 전이되는 순간 taskDocCleanupService.planTaskDocCleanup 이 이 목록을 순회한다.
  // 에이전트가 docs/ 경로를 새로 만들거나 참조할 때 recordTaskDocReference 를 통해
  // 이 배열이 누적되며, 문자열 경로만 보관해 DB 저장과 socket 직렬화가 가볍다.
  relatedDocs?: string[];
  // 지시 #75971d83 — 사용자가 '유지' 플래그를 건 문서 경로 집합. relatedDocs 의
  // 부분집합이며, 완료 시 정리 단계에서 이 목록에 포함된 경로는 보존한다(= 삭제 대상
  // 아님). UI(태스크 인스펙터) 에서 개별 문서 옆 '유지' 토글로 쌓이고, 사용자가 이후
  // 태스크에서 언제든 다시 활용할 수 있도록 docs/ 원본은 그대로 남긴다.
  keepDocs?: string[];
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
  // 지시 #a933c3c9 — 백엔드는 키만 채우고 UI 가 t() 로 번역하는 i18n 경로.
  // errorMessage 는 하위 호환을 위해 유지되며, errorKey 가 있으면 UI 가 우선해 번역한다.
  // errorParams 는 {status}, {reason}, {label}, {code}, {body} 같은 placeholder 치환 값.
  errorKey?: string;
  errorParams?: Record<string, string | number>;
}

// MCP `trigger_git_automation` / GET `get_git_automation_settings` 단에서만 쓰이는
// "브랜치 분기 모드". Project.branchStrategy(`per-commit` 등 네이밍 정책)와는 축이
// 다르다 — 여기서는 "checkout 단계를 어떻게 내보낼지" 만 결정한다:
//   - 'new'    : branchName 을 대상으로 `git checkout -B` 로 새 브랜치를 만들고 커밋.
//   - 'current': checkout 단계를 건너뛰고 현재 HEAD 브랜치에 그대로 커밋/푸시.
// 과거 값이 유실된(Row 가 이 필드를 모르는) 레거시 프로젝트는 server.ts 의
// withDefaultSettings 가 env 기본값으로 보정해 응답한다.
export type GitAutomationBranchStrategy = 'new' | 'current';

export const GIT_AUTOMATION_BRANCH_STRATEGY_VALUES: readonly GitAutomationBranchStrategy[] = [
  'new',
  'current',
] as const;

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
  // 'new' 면 branchName 으로 `checkout -B`, 'current' 면 HEAD 에 그대로 커밋.
  // optional 인 이유: 저장 row 가 이 필드를 모르는 레거시 프로젝트, 그리고 기존 설정
  // 입력 픽스처(둘 다 이 필드를 몰랐음)와의 구조적 호환. server withDefaultSettings 가
  // 응답 직전 env 기본값으로 반드시 채워서 UI/리더는 항상 값 하나를 받게 된다.
  branchStrategy?: GitAutomationBranchStrategy;
  // 'new' 모드에서 사용할 브랜치명. 빈/누락이면 server 가 Project.branchStrategy
  // 기반 resolveBranch 로 폴백해 기존 네이밍 정책을 유지한다.
  branchName?: string;
  // 태스크 경계 커밋(#f1d5ce51) — 자동 개발 ON 상태에서 "언제 커밋을 잘라 낼 것인가" 를
  // 결정하는 축. UI 라디오 3종(per-task/on-goal-complete/manual) 와 1:1 매핑된다.
  // 본 필드는 과거 row 와 호환되도록 optional 로 두고, 누락되면 server/UI 둘 다
  // `DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG` 로 폴백한다.
  commitStrategy?: CommitStrategy;
  // 모든 자동 커밋 제목 앞에 무조건 붙이는 접두어. Conventional Commits 의 타입
  // 접두어(예: "feat: ") 와 별개 축이며, 사용자가 팀 관례대로 "auto: " 같은 고정
  // 표식을 강제하고 싶을 때 사용. 빈 문자열이면 접두어 없이 원문 그대로.
  commitMessagePrefix?: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 태스크 경계 커밋 (#f1d5ce51 · Thanos 공유 타입) — agentWorker 의 실행 루프가
// 에이전트 완료 신호를 관측할 때마다 onTaskBoundary 훅을 발사하고, 본 설정이
// 분기를 결정한다. UI(GitAutomationPanel), 모달(SharedGoalModal), 타임라인
// (CollabTimeline) 이 모두 이 열거·기본값을 재사용한다.
// ────────────────────────────────────────────────────────────────────────────

export type CommitStrategy = 'per-task' | 'per-goal' | 'manual';

export const COMMIT_STRATEGY_VALUES: readonly CommitStrategy[] = Object.freeze([
  'per-task', 'per-goal', 'manual',
]) as readonly CommitStrategy[];

/** UI 라벨 — 설정 패널/모달이 사용자에게 노출하는 한국어 요약. */
export const COMMIT_STRATEGY_LABEL: Record<CommitStrategy, string> = {
  'per-task': '태스크마다 커밋',
  'per-goal': '공동 목표 완료 시 커밋',
  'manual':   '수동(자동 커밋 안 함)',
};

export interface TaskBoundaryCommitConfig {
  commitStrategy: CommitStrategy;
  /**
   * 세션이 `exhausted` 일 때 실제 git 실행을 차단하고 내부 큐에만 보관할지 여부.
   * 기본 true — 세션 복구 후 `flushQueuedTaskBoundaries()` 로 되감기. false 면
   * 즉시 실행하여(운영자가 의도적으로 통과시킨 경우) 실패를 감수.
   */
  queueOnExhausted: boolean;
  /**
   * 태스크 범위에 stage 된 변경이 전혀 없으면 경계 이벤트를 스킵할지 여부.
   * 기본 true — 빈 커밋을 만들지 않는다.
   */
  skipIfNoStagedChanges: boolean;
}

export const DEFAULT_TASK_BOUNDARY_COMMIT_CONFIG: TaskBoundaryCommitConfig = {
  commitStrategy: 'per-task',
  queueOnExhausted: true,
  skipIfNoStagedChanges: true,
};

/**
 * CollabTimeline 이 HANDOFF/REPORT 와 같은 축에 렌더할 수 있는 "태스크 경계 커밋"
 * 이벤트. 서버가 자동 커밋을 잘라 내면 이 페이로드를 socket 으로 푸시하고, 프론트
 * 타임라인이 해당 태스크와 커밋 SHA 의 대응을 한 줄로 보여준다.
 */
export interface TaskCommitTimelineEvent {
  id: string;
  type: 'task-commit';
  taskId: string;
  // 태스크 이름. 서버가 조회해 채우지 못하면 undefined.
  taskTitle?: string;
  commitSha: string; // 7자 이상(풀 해시 허용), UI 는 앞 7자만 노출.
  branch?: string;
  // ISO 8601 타임스탬프. 정렬과 포맷 모두 문자열 그대로 사용.
  at: string;
  // 어떤 정책이 잘라 낸 커밋인지. 'manual' 경로로 들어온 커밋은 수동.
  strategy: CommitStrategy;
  // PR URL 이 있으면 함께 표기(UI 가 링크로 전환).
  prUrl?: string;
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

// Claude API 호출에서 발생할 수 있는 실패 유형. `src/server/claudeErrors.ts::classifyClaudeError`
// 가 HTTP status·SDK type·Node code·Error name·메시지 패턴을 읽어 이 중 하나로 수렴한다.
// 재시도 정책(`retryPolicyFor`) 이 각 카테고리별 maxRetries·백오프 기본값을 보유한다.
// `token_exhausted` / `subscription_expired` (#cdaaabf3) 는 구독 세션이 소진되거나 만료된
// 경우로, 둘 다 재시도 불가이며 UI 를 '읽기 전용' 모드로 전환시키는 근거가 된다.
export type ClaudeErrorCategory =
  | 'rate_limit'
  | 'overloaded'
  | 'api_error'
  | 'bad_request'
  | 'auth'
  | 'timeout'
  | 'network'
  | 'token_exhausted'
  | 'subscription_expired';

export const CLAUDE_ERROR_CATEGORIES: readonly ClaudeErrorCategory[] = Object.freeze([
  'rate_limit', 'overloaded', 'api_error', 'bad_request', 'auth', 'timeout', 'network',
  'token_exhausted', 'subscription_expired',
]) as readonly ClaudeErrorCategory[];

// 세션 토큰 가용 상태 — 상단바 위젯·DirectivePrompt·SharedGoalForm·agentWorker 가
// 공통으로 참조해 읽기 전용 모드 전환 여부를 결정한다. 디자이너가 정리한 4단계
// 시각 언어(정상·경고·임박·만료) 중 '임박' 과 '경고' 는 모두 `warning` 으로 수렴하고,
// `exhausted` 는 토큰 소진 또는 구독 만료가 확정된 시점을 의미한다.
export type ClaudeSessionStatus = 'active' | 'warning' | 'exhausted';

export const CLAUDE_SESSION_STATUSES: readonly ClaudeSessionStatus[] = Object.freeze([
  'active', 'warning', 'exhausted',
]) as readonly ClaudeSessionStatus[];

// 카테고리별 누적 카운터. `claudeTokenUsageStore::recordError` 가 today/all 축에 누적한다.
export type ClaudeErrorCounters = Record<ClaudeErrorCategory, number>;

// Claude(앤트로픽) API/CLI 한 번 호출당 보고되는 토큰 사용량. Anthropic SDK 의
// response.usage 필드 shape 을 그대로 수용하도록 네 필드를 스네이크 케이스로 유지
// (input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens).
// 본 프로젝트는 실제로 Claude CLI 를 spawn 하므로, 서버가 CLI stdout 의 --output-format
// json 결과에서 해당 블록을 파싱해 채운다(server.ts::parseClaudeUsageFromStdout).
// model 필드는 단가 계산에 필요하며, 미지 모델이면 보수적으로 Sonnet 단가를 적용한다.
export interface ClaudeTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  // 호출에 사용된 모델 식별자. 예: 'claude-opus-4-7', 'claude-sonnet-4-6'. 미상 시 빈 문자열.
  model?: string;
  // ISO 타임스탬프. 미설정 시 수집 시점이 들어간다.
  at?: string;
}

// 임계값 설정: 사용자가 "이 정도 쓰면 주의/경고로 표시" 를 본인 판단으로 설정.
// tokens 또는 usd 중 하나 이상이 채워지면 활성. 본 프로젝트의 상단바 배지에서
// estimatedCostUsd 와 inputTokens+outputTokens 합계를 각각 비교해 둘 중 가장 높은
// severity 를 채택한다(warning > caution > normal). 미설정 시 항상 normal.
export interface ClaudeTokenUsageThresholdEntry {
  tokens?: number;
  usd?: number;
}

export interface ClaudeTokenUsageThresholds {
  caution: ClaudeTokenUsageThresholdEntry;
  warning: ClaudeTokenUsageThresholdEntry;
}

export type ClaudeTokenUsageSeverity = 'normal' | 'caution' | 'warning';

// localStorage 에 저장되는 영속 페이로드. 새로고침·세션 재시작 이후에도 일별 누적이
// 유지되도록 today 블록을 보존하고, 다음 마운트 시점에 로컬 자정 경계를 넘었으면
// today 만 0 으로 리셋한 뒤 all-time 은 그대로 유지한다. 스키마 버전을 키 접미
// (`.v1`) 로 관리한다 — 구조가 바뀌면 `.v2` 로 올리고 deserialize 가 모르는 버전은
// 조용히 무시해 새로고침이 실패하지 않게 한다.
export interface ClaudeTokenUsagePersisted {
  schemaVersion: 1;
  all: ClaudeTokenUsageTotals;
  today: ClaudeTokenUsageTotals;
  // 오늘 날짜(로컬). 다음 마운트 시 이 문자열이 현재 로컬 날짜와 다르면 today 만 리셋.
  todayDate: string; // 'YYYY-MM-DD'
  // 과거 일자별 스냅샷(최신순). 자정 롤오버 시 이전 today 가 맨 앞에 push 된다.
  // 구 v1 저장본은 history 가 누락되어 있을 수 있다 — deserialize 가 빈 배열로 초기화.
  history?: { date: string; totals: ClaudeTokenUsageTotals }[];
  savedAt: string; // ISO
}

// tokenUsageStore 가 유지하는 누적 총계. 한 UI 세션(=브라우저 탭) 이 시작된 이후의
// 값을 단일 출처로 보관하며, 서버 재기동 시 in-memory 총계가 0 으로 리셋되는 것과
// 동기화되도록 UI 도 `claude-usage:reset` 이벤트를 수신하면 0 으로 되돌린다.
export interface ClaudeTokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  // 호출 횟수. 한 번도 누적되지 않은 상태면 0, 이 값이 0 인 동안 비용·히트율은 의미 없음.
  callCount: number;
  // 누적 대략 비용(USD). Anthropic 공식 가격표가 변경되면 claudeTokenPricing.ts 의
  // 단가 테이블만 갱신하면 된다. 본 값은 표시 전용 참고값이며 결제 정산 근거가 아니다.
  estimatedCostUsd: number;
  // 모델별 누적. breakdown 툴팁에서 "어느 모델이 얼마나 먹었는지" 를 보여주는 데 쓴다.
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    callCount: number;
    estimatedCostUsd: number;
  }>;
  // 마지막 갱신 시각 ISO. 표시용.
  updatedAt: string;
  // 카테고리별 에러 누적. 과거 저장본(v1) 에는 없을 수 있어 optional. 스토어는
  // 항상 전체 카테고리 키를 채워서 유지한다.
  errors?: ClaudeErrorCounters;
}

// ────────────────────────────────────────────────────────────────────────────
// 멀티미디어 자산(#f6052a91) — 공동 목표가 추가로 요구하는 영상 생성·PDF/PPT 입출력
// 의 공통 모델. 지시 첨부(DirectiveAttachment) 는 "현재 턴의 근거" 라서 일시적이지만,
// MediaAsset 은 프로젝트 단위 리소스 축에 들어가 생성/파싱 결과를 재사용한다.
// 서버는 업로드/생성 두 경로 모두 최종적으로 이 레코드를 돌려 준다.
// ────────────────────────────────────────────────────────────────────────────

export type MediaKind = 'video' | 'pdf' | 'pptx' | 'image';

export const MEDIA_KINDS: readonly MediaKind[] = Object.freeze([
  'video', 'pdf', 'pptx', 'image',
]) as readonly MediaKind[];

export interface MediaAsset {
  id: string;
  projectId: string;
  kind: MediaKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  // ISO 8601. 서버가 채운다(클라이언트 시계 드리프트 방지).
  createdAt: string;
  // PDF/PPT 파싱 결과 본문. 모델에 그대로 주입 가능한 평문. 이미지/영상은 비움.
  extractedText?: string;
  // 썸네일(base64 data URL 또는 상대 경로). PDF 페이지 이미지·PPT 슬라이드 preview
  // 를 모델이나 UI 가 재사용한다. 영상은 1프레임 포스터가 들어갈 수 있다.
  thumbnails?: string[];
  // 생성된 자산에만 채워진다. 업로드 자산은 undefined.
  generatedBy?: { adapter: string; prompt: string };
  // 업로드 후 영속 저장된 파일의 URL 또는 상대 경로. 1차 스켈레톤은 비워 둔다.
  storageUrl?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 협업 타임라인 이벤트 (#b425328e §3) — CollabTimeline 이 표시할 통합 이벤트 레코드.
// 기존 handoffLedger 의 LedgerEntry 는 `docs/handoffs`·`docs/reports` frontmatter 에서
// 파생된 텍스트 축 타임라인이다. 본 TimelineEvent 는 거기에 **생성된 MediaAsset** 을
// 같은 타임라인에 끼워 넣기 위한 합집합 타입이다(1차 스켈레톤 — UI 통합은 후속).
// ────────────────────────────────────────────────────────────────────────────

export type TimelineEventKind = 'handoff' | 'report' | 'media';

export interface BaseTimelineEvent {
  id: string;
  kind: TimelineEventKind;
  /** ISO 8601. 서버가 채우거나 MediaAsset.createdAt 을 그대로 쓴다. */
  at: string;
  from?: string;
  to?: string;
  /** 스크린리더 낭독에 바로 쓸 수 있는 한 줄 요약. */
  summary?: string;
}

export interface MediaTimelineEvent extends BaseTimelineEvent {
  kind: 'media';
  /** 원본 자산의 식별용 메타만 투영 — 본체 버퍼는 타임라인에 싣지 않는다. */
  mediaAsset: Pick<MediaAsset, 'id' | 'kind' | 'name' | 'createdAt' | 'sizeBytes' | 'generatedBy'>;
  /**
   * 이벤트가 어떤 사유로 타임라인에 실렸는지. 에이전트 도구 호출(#bc9843bb)이
   * 실제로 매체를 생성한 경우 'generated', 세션 소진 폴백으로 호출이 큐잉만 된
   * 경우 'queued-exhausted'. 기존 업로드/수동 경로와의 구분은 UI 배지·스크린
   * 리더 낭독에 그대로 노출되어, 사용자가 "왜 여기에 이 자산이 찍혔는가" 를
   * 한 줄로 이해할 수 있게 한다. 선택 필드라 기존 호출자(업로드/수동)는 영향 없음.
   */
  reason?: 'generated' | 'queued-exhausted';
}

export type TimelineEvent =
  | (BaseTimelineEvent & { kind: 'handoff' | 'report' })
  | MediaTimelineEvent;

/** MediaAsset 을 그대로 타임라인 이벤트로 투영. 서버/테스트 양쪽에서 공용. */
export function mediaAssetToTimelineEvent(
  asset: MediaAsset,
  meta?: { from?: string; to?: string; reason?: 'generated' | 'queued-exhausted' },
): MediaTimelineEvent {
  const reason = meta?.reason ?? 'generated';
  const reasonLabel = reason === 'queued-exhausted' ? ' · 토큰 소진 대기' : '';
  return {
    id: `media-${asset.id}`,
    kind: 'media',
    at: asset.createdAt,
    from: meta?.from,
    to: meta?.to,
    summary: `${asset.kind.toUpperCase()} · ${asset.name}${reasonLabel}`,
    reason,
    mediaAsset: {
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      createdAt: asset.createdAt,
      sizeBytes: asset.sizeBytes,
      generatedBy: asset.generatedBy,
    },
  };
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
