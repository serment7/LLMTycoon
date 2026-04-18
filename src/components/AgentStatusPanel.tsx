import React, { useMemo } from 'react';
import { Agent, CodeFile } from '../types';
import type { DirectiveStatus } from '../utils/directiveLog';
import {
  derivePipelineRole,
  type PipelineRole,
} from '../utils/workspaceInsights';
import { useReducedMotion } from '../utils/useReducedMotion';
import {
  classifyLeaderMessage,
  LEADER_ANSWER_ONLY_LABEL,
  LEADER_ANSWER_ONLY_TOOLTIP,
  type LeaderMessageKind,
} from '../utils/leaderMessage';
import { getLeaderMessageIcon } from './AgentContextBubble';
import {
  GitAutomationStageBadge,
  AutoFlowProgressBar,
  deriveAutoFlowFromGitStages,
  type AutoFlowStages,
  type GitAutomationBadgeState,
} from './GitAutomationStageBadge';

type AgentStatus = Agent['status'];

// 리더 대시보드에서 "오늘 지시 N건 / 위임 M건" 한 줄을 즉시 보여주기 위한 요약 패이로드.
// 파싱·집계는 `directiveLog.ts`가 담당하고, 이 컴포넌트는 순수 뷰 역할만 한다.
// 디자인 합의는 docs/reports/2026-04-17-directive-logging.md §4 참고.
export interface DirectiveDigest {
  today: string;
  total: number;
  delegated: number;
  soloWithException: number;
  inboxPath: string;
  latestEntries: ReadonlyArray<{ digest: string; status: DirectiveStatus }>;
  /**
   * 위임률 (0~1). 미지정 시 total/delegated 로 `showInsights` 내부에서 파생한다.
   * 근거: docs/handoffs/2026-04-17-alpha-to-beta-collab-audit.md §④.
   */
  delegationRate?: number;
  /** ❌ 단독 처리율 (0~1). 미지정이면 "협업 지표" 서브블록은 렌더되지 않는다. */
  forbiddenSoloRate?: number;
  /** 단독 처리율 임계값. 생략 시 0.2 를 사용. 값 초과 시 붉은 톤 + 펄스 애니메이션. */
  forbiddenSoloThreshold?: number;
  /** linked_directive 없는 고아 HANDOFF 건수. 0 보다 크면 노란 경고 행 표시. */
  orphanHandoffCount?: number;
}

// Git 자동화 단계(commit/push/pr)의 실행 상태.
// 디자인 합의 2026-04-18 §Git 자동화 패널 UX: 4단계 — 대기/진행중/성공/실패.
// 배지 톤과 재시도 버튼 가드는 이 문자열을 단일 원천으로 쓴다.
export type GitAutomationStageState = 'idle' | 'running' | 'success' | 'failed';

export type GitAutomationStageKey = 'commit' | 'push' | 'pr';

export interface GitAutomationStage {
  state: GitAutomationStageState;
  /** 사용자에게 보일 부가 설명(예: 커밋 해시, 실패 원인). 생략 시 상태 라벨만 표시. */
  detail?: string;
  /** 실패 시 노출할 에러 메시지. state 가 failed 일 때만 사용. */
  errorMessage?: string;
}

export interface GitAutomationDigest {
  stages: Record<GitAutomationStageKey, GitAutomationStage>;
  /**
   * 재시도 훅. 실패 단계별 버튼을 누르면 전달된다. 생략되면 버튼은 숨겨진다.
   * (엔진이 아직 재시도 미구현이면 undefined 로 두어 UX 를 정확히 반영.)
   */
  onRetryStage?: (stage: GitAutomationStageKey) => void;
  /** 특정 단계가 현재 재시도 중인지. 버튼을 잠시 비활성화해 중복 클릭을 막는다. */
  retryingStage?: GitAutomationStageKey | null;
  /** 서버가 체크아웃한 브랜치 이름(예: chore/auto-2026-04-18-abcd). 단계 행 아래 풋노트로 표시. */
  branch?: string;
  /** 자동 커밋의 단축 SHA(7+자리). App.tsx 가 git stdout 에서 파싱. */
  commitSha?: string;
  /** `gh pr create` 가 뱉은 PR URL. 링크로 렌더하고 새 탭에서 연다. */
  prUrl?: string;
}

type Props = {
  agents: Agent[];
  files: CodeFile[];
  translateRole: (role: string) => string;
  translateStatus: (status: string) => string;
  showSummary?: boolean;
  // 연구 관점 지표(활성률·역할 분포)를 함께 렌더할지 여부.
  showInsights?: boolean;
  // 품질 진단(상태-필드 불일치, 댕글링 참조 등) 배지와 요약을 표시할지 여부.
  showQualityWarnings?: boolean;
  // 오늘 인박스 지시 요약 행을 렌더할지 여부. 데이터(`directiveDigest`)가 함께 있어야 렌더된다.
  showDirectiveDigest?: boolean;
  directiveDigest?: DirectiveDigest;
  // Git 자동화 단계별 진행 인디케이터(대기/진행중/성공/실패)를 렌더할지 여부.
  // `gitAutomation` 데이터가 함께 있어야 렌더되며, 실패 단계에는 재시도 버튼이 붙는다.
  showGitAutomation?: boolean;
  gitAutomation?: GitAutomationDigest;
  // 자동 개발 메타 루프(개선 보고 → 리더 재분배 → 전원 완료 → Git 자동화 발동)
  // 상태를 상위에서 명시할 때 넘긴다. 생략하면 gitAutomation 으로부터 보수적으로
  // 유추한 기본 값이 사용된다.
  autoFlow?: AutoFlowStages;
  /**
   * 인박스 경로 클릭 훅. 상위 컨테이너에서 FileTooltip/문서 뷰어로 연결할 수 있게 주입한다.
   * 누락되면 경로는 읽기 전용 텍스트로만 노출된다.
   */
  onInboxPathClick?: (path: string) => void;
};

// 단계 키 → 한국어 라벨. 패널 전역에서 동일 언어를 유지한다.
const GIT_AUTOMATION_STAGE_LABEL: Record<GitAutomationStageKey, string> = {
  commit: '자동 커밋',
  push: '원격 푸시',
  pr: 'PR 생성',
};

// 상태 → 글리프(스크린리더용 텍스트와 동일 의미). CSS 에도 동일 매핑 존재.
const GIT_AUTOMATION_STATE_GLYPH: Record<GitAutomationStageState, string> = {
  idle: '○',
  running: '◔',
  success: '◉',
  failed: '✕',
};

const GIT_AUTOMATION_STATE_LABEL: Record<GitAutomationStageState, string> = {
  idle: '대기',
  running: '진행중',
  success: '성공',
  failed: '실패',
};

// 단계 순서 고정(커밋 → 푸시 → PR). 화면 읽기 방향과 동일하게 좌→우 진행감을 준다.
const GIT_AUTOMATION_STAGE_ORDER: ReadonlyArray<GitAutomationStageKey> = [
  'commit',
  'push',
  'pr',
];

// 지시 상태 → 유니코드 글리프. CollabTimeline(팀 축)과 동일한 매핑을 유지해
// 대시보드 전체에서 상태 언어를 통일한다.
const DIRECTIVE_STATUS_GLYPH: Record<DirectiveStatus, string> = {
  open: '○',
  wip: '◔',
  done: '◉',
  blocked: '◆',
};

const DIRECTIVE_STATUS_LABEL: Record<DirectiveStatus, string> = {
  open: '대기',
  wip: '진행',
  done: '완료',
  blocked: '차단',
};

export function getDirectiveStatusGlyph(status: DirectiveStatus): string {
  return DIRECTIVE_STATUS_GLYPH[status];
}

export function getDirectiveStatusLabel(status: DirectiveStatus): string {
  return DIRECTIVE_STATUS_LABEL[status];
}

// 에이전트 레코드의 품질 이슈 종류.
// - stale-working: working 상태인데 작업 파일/태스크가 전혀 지정되지 않음
// - missing-file: workingOnFileId가 현재 파일 목록에 존재하지 않음
// - missing-recipient: lastMessageTo가 현재 에이전트 목록에 존재하지 않음
// - file-contention: 동일 파일을 두 명 이상이 동시에 working 상태로 점유 중
//   (실제 개발 현장의 머지 충돌 리스크를 조기 경고하기 위한 항목)
// - self-message: 자기 자신에게 메시지를 보낸 흔적 (협업 로그 오염)
// - idle-with-task: idle인데 작업 파일/태스크가 남아 있음(전환 누락으로 추정)
// - orphan-message: 메시지 본문은 있는데 lastMessageTo가 비어 있음.
//   수신자를 알 수 없어 협업 네트워크 엣지에서 누락되고, 후속 중심성 분석이 왜곡된다.
export type QualityIssue =
  | 'stale-working'
  | 'missing-file'
  | 'missing-recipient'
  | 'file-contention'
  | 'self-message'
  | 'idle-with-task'
  | 'orphan-message';

const QUALITY_ISSUE_LABEL: Record<QualityIssue, string> = {
  'stale-working': '작업 정보 없음',
  'missing-file': '파일 참조 유실',
  'missing-recipient': '수신자 유실',
  'file-contention': '동시 편집 충돌 위험',
  'self-message': '자기 참조 메시지',
  'idle-with-task': '정리되지 않은 작업',
  'orphan-message': '수신자 없는 메시지',
};

// 경고 배지 정렬/집계에 쓰는 심각도 가중치(클수록 심각).
// - 충돌은 즉시 머지 사고로 이어지므로 최우선.
// - 참조 유실(파일·수신자)은 데이터 일관성 사고.
// - orphan-message는 네트워크 엣지를 잃는 수준이라 self-message와 동일 등급으로 본다.
// - 상태·태스크 불일치는 관측 노이즈 수준.
const QUALITY_ISSUE_SEVERITY: Record<QualityIssue, number> = {
  'file-contention': 4,
  'missing-file': 3,
  'missing-recipient': 3,
  'self-message': 2,
  'orphan-message': 2,
  'stale-working': 1,
  'idle-with-task': 1,
};

// 심각도 내림차순으로 정렬된 이슈 배열을 반환. UI 배지 표기 순서를 일관화한다.
export function sortIssuesBySeverity(issues: ReadonlyArray<QualityIssue>): QualityIssue[] {
  return [...issues].sort(
    (a, b) => QUALITY_ISSUE_SEVERITY[b] - QUALITY_ISSUE_SEVERITY[a],
  );
}

// 외부에서 동일한 가중치로 정렬·집계할 수 있도록 읽기 전용 뷰로 노출한다.
// (내부 상수를 직접 수정하지 못하게 하면서 계산만 공유하기 위한 장치)
export const QUALITY_SEVERITY_WEIGHTS: Readonly<Record<QualityIssue, number>> =
  QUALITY_ISSUE_SEVERITY;

// 팀 전체의 품질 위험도를 단일 점수로 환산. 배지 개수만으로는 묻히는
// "치명 이슈 하나" vs "경미 이슈 다수"의 차이를 드러내기 위한 스칼라 지표.
export function computeTotalSeverity(
  issuesByAgent: ReadonlyMap<string, ReadonlyArray<QualityIssue>>,
): number {
  let total = 0;
  for (const issues of issuesByAgent.values()) {
    for (const issue of issues) {
      total += QUALITY_ISSUE_SEVERITY[issue];
    }
  }
  return total;
}

// 3명 이상이 한 파일을 점유하면 머지 충돌 사고가 거의 확정적이므로
// 리더가 즉시 개입할 수 있도록 임계치를 모듈 상수로 고정한다.
const CRITICAL_CONTENTION_THRESHOLD = 3;

// 위 임계치를 넘는 경쟁 파일이 하나라도 있는지 검사. 경고 배너 톤 전환에 사용.
export function hasCriticalContention(
  contentionCounts: ReadonlyMap<string, number>,
): boolean {
  for (const count of contentionCounts.values()) {
    if (count >= CRITICAL_CONTENTION_THRESHOLD) return true;
  }
  return false;
}

// 팀 건강도 밴드. 배너 톤/아이콘/알림 우선순위를 한 곳에서 분기하기 위한 분류축.
// - clean: 이슈 없음
// - minor: 관측 노이즈 수준(정리 누락 등)
// - major: 참조 유실·충돌 위험이 쌓였지만 아직 치명은 아님
// - critical: 3명 이상 동시 편집 등 즉시 개입이 필요한 상태
export type SeverityBand = 'clean' | 'minor' | 'major' | 'critical';

// minor → major 승격 임계치. severity=missing-file(3) + stale-working(1) 정도가
// 동시에 누적되면 더 이상 "관찰" 수준이 아니라는 경험칙. 마법 숫자를 분리해
// 후속 튜닝(가중치 재학습) 시 한 곳만 고치면 되도록 한다.
export const MAJOR_SEVERITY_THRESHOLD = 5;

// 위험도 점수와 치명 경쟁 여부를 단일 밴드로 접는다. 경고 UI 분기와
// 상위 대시보드의 팀별 상태 비교 양쪽에서 동일 기준으로 쓸 수 있게 노출.
export function classifySeverity(
  totalSeverity: number,
  criticalContention: boolean,
): SeverityBand {
  if (criticalContention) return 'critical';
  if (totalSeverity === 0) return 'clean';
  if (totalSeverity >= MAJOR_SEVERITY_THRESHOLD) return 'major';
  return 'minor';
}

// 가장 경쟁이 심한 파일 1건을 뽑는다. 상위 대시보드나 알림 메시지에서
// "어디부터 손대야 하는지"만 필요할 때 굳이 전체 정렬을 반복하지 않도록 분리.
export function getTopContendedFile(
  contentionCounts: ReadonlyMap<string, number>,
): { fileId: string; count: number } | null {
  let best: { fileId: string; count: number } | null = null;
  for (const [fileId, count] of contentionCounts) {
    if (!best || count > best.count) best = { fileId, count };
  }
  return best;
}

// 활성 상태로 간주하는 status 집합. idle은 유휴로 분류한다.
const ACTIVE_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'working',
  'meeting',
  'thinking',
]);

// 역할 간 활성률 격차 임계치. 50%p 이상 벌어지면 업무 재배분을 권장한다.
// 경험적 값이며, 향후 과제 난이도·마감 거리 가중치와 결합해 재학습할 수 있도록 모듈 상수로 분리.
const ROLE_IMBALANCE_THRESHOLD = 0.5;

// "활성" 여부 판정의 단일 진실 공급원. ACTIVE_STATUSES를 직접 참조하는 흩어진
// 인라인 조건을 이 헬퍼로 모아 회귀 시 수정 지점을 하나로 유지한다.
export function isActiveAgent(agent: Agent): boolean {
  return ACTIVE_STATUSES.has(agent.status);
}

// idle 점은 단색 배경만으로는 어두운 패널에서 시인성이 떨어져
// 미세한 외곽선을 더해 "비활성이지만 존재함"을 분명히 표시한다.
// animate-pulse 는 prefers-reduced-motion 사용자에게 적용하지 않도록
// `pulseFor`/`useReducedMotion` 결합으로 렌더 타임에 부착한다.
const STATUS_DOT: Record<AgentStatus, string> = {
  idle: 'bg-white/15 ring-1 ring-white/25',
  working: 'bg-green-500/70',
  meeting: 'bg-yellow-500/70',
  thinking: 'bg-blue-500/70',
};

// 활성 3종만 펄스 대상. idle 은 어떤 경우에도 깜빡이지 않는다.
const PULSING_DOT_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'working',
  'meeting',
  'thinking',
]);

// reducedMotion 가드를 한 곳에 모아 중복을 줄인다. 단순한 헬퍼지만
// 유닛 테스트와 호출부 모두에서 동일 규칙을 공유하기 위해 export.
export function shouldPulse(status: AgentStatus, reducedMotion: boolean): boolean {
  return !reducedMotion && PULSING_DOT_STATUSES.has(status);
}

const STATUS_LABEL_COLOR: Record<AgentStatus, string> = {
  idle: 'text-white/40',
  working: 'text-green-200/80',
  meeting: 'text-yellow-200/80',
  thinking: 'text-blue-200/80',
};

// 아바타 외곽에 깔리는 상태 링. 점(dot) 하나로는 멀리서 식별이 어려워
// 역할 배지 자체가 상태를 발산하도록 이중 시그널을 제공한다.
const STATUS_AVATAR_RING: Record<AgentStatus, string> = {
  idle: 'ring-1 ring-white/10',
  working: 'ring-2 ring-green-400/40',
  meeting: 'ring-2 ring-yellow-300/40',
  thinking: 'ring-2 ring-blue-300/40',
};

// 활동 중인 에이전트를 상단에 노출하기 위한 정렬 가중치.
const STATUS_SORT_WEIGHT: Record<AgentStatus, number> = {
  working: 0,
  meeting: 1,
  thinking: 2,
  idle: 3,
};

// 상태별 유니코드 글리프. 색 도트 하나만으로는 색약/색맹 사용자가
// 상태를 식별하기 어려워, 색과 무관한 모양 축을 하나 더 겹쳐 이중 시그널을 제공한다.
// 이모지는 픽셀 UI 톤을 깨므로 흑백 기하 기호만 사용한다.
const STATUS_GLYPH: Record<AgentStatus, string> = {
  idle: '○',
  working: '▶',
  meeting: '◆',
  thinking: '◉',
};

export function getStatusGlyph(status: string): string {
  return (STATUS_GLYPH as Record<string, string>)[status] ?? STATUS_GLYPH.idle;
}

// 역할별 아바타 배경 색조. 역할이 팔레트에 없으면 FALLBACK_AVATAR_TINTS에서
// 결정론적으로 고른다. 디자인 의도: 한눈에 역할군을 구분할 수 있도록 명도·채도를
// 일정 범위로 통제하면서, 신규 역할이 추가돼도 회색 덩어리로 뭉치지 않도록 한다.
const ROLE_AVATAR_TINT: Record<string, string> = {
  leader: 'bg-amber-400/45 text-black',
  designer: 'bg-pink-400/45 text-black',
  engineer: 'bg-cyan-400/45 text-black',
  researcher: 'bg-purple-400/45 text-black',
  qa: 'bg-emerald-400/45 text-black',
  pm: 'bg-orange-400/45 text-black',
};

// 팔레트 밖 역할에 배정할 후보 색조. 기존 역할 팔레트와 충돌하지 않도록
// 채도를 한 단계 낮춘 톤만 골라, 공식 역할 색과 "비공식" 역할 색이 구분되게 한다.
const FALLBACK_AVATAR_TINTS: readonly string[] = [
  'bg-sky-300/35 text-black',
  'bg-rose-300/35 text-black',
  'bg-lime-300/35 text-black',
  'bg-indigo-300/35 text-black',
  'bg-fuchsia-300/35 text-black',
  'bg-teal-300/35 text-black',
];

// 문자열을 고정 팔레트 인덱스로 환산하는 단순 해시.
// 신규 역할이 추가돼도 같은 이름이면 같은 색으로 매핑되어 기억에 남는 "색 아이덴티티"를 제공한다.
function hashRoleToPaletteIndex(role: string, length: number): number {
  if (length <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < role.length; i += 1) {
    hash = (hash * 31 + role.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % length;
}

export function resolveAvatarTint(role: string): string {
  const known = ROLE_AVATAR_TINT[role];
  if (known) return known;
  if (!role) return 'bg-white/20 text-white';
  const idx = hashRoleToPaletteIndex(role, FALLBACK_AVATAR_TINTS.length);
  return FALLBACK_AVATAR_TINTS[idx];
}

// 이름에서 아바타에 쓸 이니셜 한 글자를 뽑는다.
// 한글은 첫 음절, 영문은 대문자, 빈 문자열은 물음표로 폴백.
function getAgentInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return trimmed.charAt(0).toUpperCase();
}

// status 문자열이 알려진 AgentStatus가 아닐 수도 있으므로(런타임 데이터 유입 대비)
// 안전하게 idle로 폴백한다. 캐스팅을 내부로 격리해 호출부 타입은 단순하게 유지.
function getStatusClass<T extends string>(
  map: Record<AgentStatus, T>,
  status: string,
): T {
  return (map as Record<string, T>)[status] ?? map.idle;
}

export function summarize(agents: Agent[]): Record<AgentStatus, number> {
  const counts: Record<AgentStatus, number> = {
    idle: 0,
    working: 0,
    meeting: 0,
    thinking: 0,
  };
  for (const agent of agents) {
    if (agent.status in counts) {
      counts[agent.status] += 1;
    }
  }
  return counts;
}

// 전체 에이전트 중 활성 상태(working/meeting/thinking) 비율을 0~1 범위로 반환.
// 팀 가동률을 한눈에 파악하기 위한 연구 지표.
export function computeActiveRatio(agents: Agent[]): number {
  if (agents.length === 0) return 0;
  const active = agents.reduce(
    (acc, agent) => acc + (isActiveAgent(agent) ? 1 : 0),
    0,
  );
  return active / agents.length;
}

// 역할별 인원 분포 집계. 조직 편성 균형을 빠르게 진단하기 위한 용도.
export function summarizeByRole(agents: Agent[]): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const agent of agents) {
    map.set(agent.role, (map.get(agent.role) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

// 역할별 활성률(활성 인원 / 해당 역할 총원). 단일 평균 활성률로는 보이지 않는
// "엔지니어는 전부 풀가동인데 디자이너는 놀고 있다" 같은 편차를 드러내기 위한 지표.
// 연구 관점: 팀 활용도는 평균이 아니라 분산으로 판단해야 실제 병목이 보인다.
export function computeRoleActivity(
  agents: Agent[],
): Array<{ role: string; total: number; active: number; ratio: number }> {
  const totals = new Map<string, number>();
  const actives = new Map<string, number>();
  for (const agent of agents) {
    totals.set(agent.role, (totals.get(agent.role) ?? 0) + 1);
    if (isActiveAgent(agent)) {
      actives.set(agent.role, (actives.get(agent.role) ?? 0) + 1);
    }
  }
  return [...totals.entries()]
    .map(([role, total]) => {
      const active = actives.get(role) ?? 0;
      return { role, total, active, ratio: total === 0 ? 0 : active / total };
    })
    .sort((a, b) => a.ratio - b.ratio);
}

// 역할 간 활성률 격차(0~1). 전원이 활성이거나 전원이 유휴이거나 역할군이 하나뿐이면 0.
// 임계치를 넘으면 리더가 업무 재배분을 고려할 타이밍으로 해석한다.
export function computeRoleImbalanceGap(
  activity: ReadonlyArray<{ ratio: number; total: number }>,
): number {
  const populated = activity.filter(a => a.total > 0);
  if (populated.length < 2) return 0;
  const ratios = populated.map(a => a.ratio);
  return Math.max(...ratios) - Math.min(...ratios);
}

// 동일 파일을 두 명 이상이 working 상태로 점유 중인 파일 ID → 점유 인원 수.
// 머지 충돌이 발생하기 전에 리더가 작업을 재배분할 수 있도록 돕는 신호.
// 맵으로 반환해 상위 N개 경쟁 파일 정렬 등 후속 지표 계산에 재사용하도록 설계.
export function computeContentionCounts(agents: Agent[]): ReadonlyMap<string, number> {
  const workingCount = new Map<string, number>();
  for (const agent of agents) {
    if (agent.status !== 'working' || !agent.workingOnFileId) continue;
    const id = agent.workingOnFileId;
    workingCount.set(id, (workingCount.get(id) ?? 0) + 1);
  }
  const contended = new Map<string, number>();
  for (const [id, count] of workingCount) {
    if (count > 1) contended.set(id, count);
  }
  return contended;
}

// 경쟁 파일 ID 집합만 필요한 호출자를 위한 얇은 어댑터.
export function computeContendedFileIds(agents: Agent[]): ReadonlySet<string> {
  return new Set(computeContentionCounts(agents).keys());
}

// 단일 에이전트에 대한 품질 이슈 목록을 계산한다.
// 판정 기준은 QA 규약: 상태와 필드가 일관적이어야 하고, 참조는 반드시 유효해야 한다.
export function detectIssues(
  agent: Agent,
  fileIds: ReadonlySet<string>,
  agentIds: ReadonlySet<string>,
  contendedFileIds: ReadonlySet<string>,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (
    agent.status === 'working' &&
    !agent.workingOnFileId &&
    !agent.currentTask
  ) {
    issues.push('stale-working');
  }
  if (agent.workingOnFileId && !fileIds.has(agent.workingOnFileId)) {
    issues.push('missing-file');
  }
  if (agent.lastMessageTo && !agentIds.has(agent.lastMessageTo)) {
    issues.push('missing-recipient');
  }
  if (
    agent.status === 'working' &&
    agent.workingOnFileId &&
    contendedFileIds.has(agent.workingOnFileId)
  ) {
    issues.push('file-contention');
  }
  if (agent.lastMessageTo && agent.lastMessageTo === agent.id) {
    issues.push('self-message');
  }
  // idle 전환 시점에 working_on_file_id/currentTask를 비우지 않으면
  // 이후 활성률·점유 지표가 왜곡된다. 이 조합이 감지되면 정리 누락으로 간주.
  if (
    agent.status === 'idle' &&
    (agent.workingOnFileId || agent.currentTask)
  ) {
    issues.push('idle-with-task');
  }
  // 메시지는 있는데 수신자가 비어 있으면 협업 엣지에서 이 레코드가 누락된다.
  // 자기 참조(self-message)와는 별도 축으로 집계해, 로그 오염이 아닌 "경로 소실"로 구분한다.
  if (agent.lastMessage && !agent.lastMessageTo) {
    issues.push('orphan-message');
  }
  return sortIssuesBySeverity(issues);
}

// 단일 에이전트의 이슈 목록을 누적 심각도 점수로 환산. 같은 상태 밴드 안에서
// "치명 이슈를 들고 있는 사람"이 먼저 보이도록 정렬 타이브레이커로 쓴다.
export function computeAgentSeverity(issues: ReadonlyArray<QualityIssue>): number {
  let score = 0;
  for (const issue of issues) score += QUALITY_ISSUE_SEVERITY[issue];
  return score;
}

// 이슈 종류별 누적 건수를 반환한다. 0건은 포함하지 않는다.
// 품질 대시보드나 시간대별 추이 분석 등 후속 지표에서 재사용.
export function summarizeIssueCounts(
  issuesByAgent: ReadonlyMap<string, ReadonlyArray<QualityIssue>>,
): ReadonlyMap<QualityIssue, number> {
  const counts = new Map<QualityIssue, number>();
  for (const issues of issuesByAgent.values()) {
    for (const issue of issues) {
      counts.set(issue, (counts.get(issue) ?? 0) + 1);
    }
  }
  return counts;
}

// 배너에서 "먼저 살필 이슈" 한 건을 뽑기 위한 헬퍼.
// 1차 정렬: 심각도 가중치 내림차순, 2차: 발생 건수 내림차순.
// 같은 심각도라면 누적 건수가 많은 쪽이 구조적 문제일 확률이 높다는 경험칙.
export function getPrimaryIssue(
  counts: ReadonlyMap<QualityIssue, number>,
): { issue: QualityIssue; count: number } | null {
  let top: { issue: QualityIssue; count: number } | null = null;
  for (const [issue, count] of counts) {
    if (!top) {
      top = { issue, count };
      continue;
    }
    const currSev = QUALITY_ISSUE_SEVERITY[issue];
    const bestSev = QUALITY_ISSUE_SEVERITY[top.issue];
    if (currSev > bestSev || (currSev === bestSev && count > top.count)) {
      top = { issue, count };
    }
  }
  return top;
}

// 밴드 → 사람이 읽을 라벨. 접근성 속성/툴팁 문구를 일관되게 유지하기 위한 단일 공급원.
const SEVERITY_BAND_LABEL: Record<SeverityBand, string> = {
  clean: '정상',
  minor: '관찰',
  major: '주의',
  critical: '긴급',
};

// 밴드별 글리프. 텍스트 라벨과 같이 표기해 색맹 사용자도 배너 톤을 식별할 수 있게 한다.
// 픽셀 UI 톤을 해치지 않도록 이모지 대신 유니코드 기호만 사용.
const SEVERITY_BAND_GLYPH: Record<SeverityBand, string> = {
  clean: '○',
  minor: '◔',
  major: '◑',
  critical: '◉',
};

export function getSeverityBandLabel(band: SeverityBand): string {
  return SEVERITY_BAND_LABEL[band];
}

export function getSeverityBandGlyph(band: SeverityBand): string {
  return SEVERITY_BAND_GLYPH[band];
}

// 스냅샷 시점의 단방향 메시지 엣지 목록(보낸 쪽 → 받은 쪽).
// 자기 참조·유실된 수신자는 제외해 실제 유효한 협업 링크만 반환한다.
// 추후 협업 네트워크 중심성 분석(who is the hub)의 기본 재료로 활용.
export function computeCollaborationEdges(
  agents: ReadonlyArray<Agent>,
  agentIds: ReadonlySet<string>,
): ReadonlyArray<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const agent of agents) {
    const to = agent.lastMessageTo;
    if (!to) continue;
    if (to === agent.id) continue;
    if (!agentIds.has(to)) continue;
    edges.push({ from: agent.id, to });
  }
  return edges;
}

// 최근 메시지를 주고받은 흔적이 전혀 없는 에이전트 ID 집합.
// 연구 관점: 혼자 떠도는 팀원은 정보 공유 사각지대에 있을 가능성이 높으므로
// 리더의 1:1 개입 대상 후보로 삼기 위한 신호.
export function computeIsolatedAgentIds(
  agents: ReadonlyArray<Agent>,
  edges: ReadonlyArray<{ from: string; to: string }>,
): ReadonlySet<string> {
  const touched = new Set<string>();
  for (const edge of edges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }
  const isolated = new Set<string>();
  for (const agent of agents) {
    if (!touched.has(agent.id)) isolated.add(agent.id);
  }
  return isolated;
}

// 고립 비율(0~1). 전원이 서로 엮여 있으면 0, 아무도 대화하지 않으면 1.
// 팀 커뮤니케이션 밀도를 단일 스칼라로 접어 대시보드 추이 비교에 쓴다.
export function computeIsolationRatio(
  agents: ReadonlyArray<Agent>,
  isolatedIds: ReadonlySet<string>,
): number {
  if (agents.length === 0) return 0;
  return isolatedIds.size / agents.length;
}

// 협업 엣지에서 각 에이전트의 수신(in-degree) 빈도를 집계한다.
// 연구 관점: "누가 가장 많이 호출되는가"를 식별해 정보 병목/허브 후보를 드러낸다.
// 단일 평균 연결수로는 보이지 않는 네트워크 편중(소수에 쏠림)을 진단하기 위한 기본 지표.
export function computeIncomingMessageCounts(
  edges: ReadonlyArray<{ from: string; to: string }>,
): ReadonlyMap<string, number> {
  const incoming = new Map<string, number>();
  for (const { to } of edges) {
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }
  return incoming;
}

// 가장 많이 호출되는 에이전트 1명. 팀 내 "허브" 식별용.
// 동률이면 먼저 발견된 후보를 유지해 결과 재현성을 보장한다.
export function getCommunicationHub(
  incomingCounts: ReadonlyMap<string, number>,
): { agentId: string; count: number } | null {
  let best: { agentId: string; count: number } | null = null;
  for (const [agentId, count] of incomingCounts) {
    if (!best || count > best.count) best = { agentId, count };
  }
  return best;
}

// 허브 쏠림 지수(0~1). 상위 1명이 전체 엣지에서 차지하는 비율.
// 1에 가까울수록 한 사람에게 과부하가 집중돼 있음을 의미하며,
// 0.5 이상이면 단일 실패점(SPOF) 위험 신호로 해석한다.
export function computeHubConcentration(
  edges: ReadonlyArray<{ from: string; to: string }>,
  hub: { agentId: string; count: number } | null,
): number {
  if (!hub || edges.length === 0) return 0;
  return hub.count / edges.length;
}

// 고립률을 세 단계로 접은 밴드. 단순 퍼센트 수치만으로는 "언제 개입할지"가 드러나지 않아
// UI 톤/알림 임계를 한 곳에서 분기하기 위해 연속값을 이산화한다.
// - healthy: 모두 연결됨(0%)
// - watch:   일부 고립(0% < 고립률 < 50%)
// - alert:   절반 이상 고립(>= 50%) — 팀 커뮤니케이션 붕괴 신호
export type IsolationBand = 'healthy' | 'watch' | 'alert';

// alert 승격 임계치. 절반을 넘으면 "팀이 둘 이상의 침묵 그룹으로 쪼개졌다"는
// 신호로 간주한다. 밴드 분기 로직과 외부 알림 모듈이 같은 값을 참조하도록 노출.
export const ISOLATION_ALERT_THRESHOLD = 0.5;

export function classifyIsolationBand(ratio: number): IsolationBand {
  if (ratio <= 0) return 'healthy';
  if (ratio >= ISOLATION_ALERT_THRESHOLD) return 'alert';
  return 'watch';
}

// 고립 밴드 → 사람이 읽을 라벨/글리프. 품질 배너와 동일한 표기 패턴을 따라
// 상위 대시보드에서 두 축(품질·고립)을 나란히 비교할 수 있게 한다.
const ISOLATION_BAND_LABEL: Record<IsolationBand, string> = {
  healthy: '연결됨',
  watch: '주의',
  alert: '고립 경보',
};

const ISOLATION_BAND_GLYPH: Record<IsolationBand, string> = {
  healthy: '◇',
  watch: '◈',
  alert: '◆',
};

export function getIsolationBandLabel(band: IsolationBand): string {
  return ISOLATION_BAND_LABEL[band];
}

export function getIsolationBandGlyph(band: IsolationBand): string {
  return ISOLATION_BAND_GLYPH[band];
}

// 허브 집중도 밴드. 수신 메시지가 한 명에게 쏠리는 정도를 이산화한다.
// - balanced: 허브가 없거나 쏠림이 미미(<30%)
// - watch:    한 명에게 30~50% 사이의 수신이 집중
// - spof:     50% 이상이 한 명에게 집중 — 단일 실패점(SPOF) 위험 신호
// 이전에는 JSX에서 0.3/0.5 리터럴을 직접 비교했으나, 같은 기준을 배너·알림·
// 상위 대시보드가 공유할 수 있도록 중앙화한다.
export type HubConcentrationBand = 'balanced' | 'watch' | 'spof';

// watch 승격 임계치. 이 아래는 균형, 이 이상부터 주의 구간으로 본다.
export const HUB_WATCH_THRESHOLD = 0.3;
// spof 승격 임계치. 절반 이상이 한 명에게 쏠리면 단일 실패점으로 간주.
export const HUB_SPOF_THRESHOLD = 0.5;

export function classifyHubBand(concentration: number): HubConcentrationBand {
  if (concentration >= HUB_SPOF_THRESHOLD) return 'spof';
  if (concentration >= HUB_WATCH_THRESHOLD) return 'watch';
  return 'balanced';
}

const HUB_BAND_LABEL: Record<HubConcentrationBand, string> = {
  balanced: '균형',
  watch: '주의',
  spof: '단일 병목',
};

const HUB_BAND_GLYPH: Record<HubConcentrationBand, string> = {
  balanced: '◇',
  watch: '◈',
  spof: '◆',
};

// 배너·카드에서 허브 수치의 톤을 결정할 때 쓰는 텍스트 색 유틸.
// 인라인 삼항 분기를 제거해 밴드 추가·튜닝 시 수정 지점을 단일 위치로 모은다.
const HUB_BAND_TONE: Record<HubConcentrationBand, string> = {
  balanced: 'text-white/70',
  watch: 'text-yellow-200',
  spof: 'text-red-300',
};

export function getHubBandLabel(band: HubConcentrationBand): string {
  return HUB_BAND_LABEL[band];
}

export function getHubBandGlyph(band: HubConcentrationBand): string {
  return HUB_BAND_GLYPH[band];
}

export function getHubBandTone(band: HubConcentrationBand): string {
  return HUB_BAND_TONE[band];
}

// 외부 감사/대시보드용 단일 진입점. 흩어진 지표 호출을 한 객체로 모아
// 호출자가 어떤 함수를 어떤 순서로 불러야 하는지 추측하지 않게 한다.
// 변경 비용을 이 모듈 안에 가두기 위한 파사드.
export type QualityReport = {
  totalIssues: number;
  totalSeverity: number;
  severityBand: SeverityBand;
  primaryIssue: { issue: QualityIssue; count: number } | null;
  topContendedFile: { fileId: string; count: number } | null;
  issueCounts: ReadonlyMap<QualityIssue, number>;
  isolationRatio: number;
  isolationBand: IsolationBand;
  communicationHub: { agentId: string; count: number } | null;
  hubConcentration: number;
  hubBand: HubConcentrationBand;
};

export function buildQualityReport(
  agents: ReadonlyArray<Agent>,
  files: ReadonlyArray<CodeFile>,
): QualityReport {
  const fileIds = new Set(files.map(f => f.id));
  const agentIds = new Set(agents.map(a => a.id));
  const contentionCounts = computeContentionCounts([...agents]);
  const contendedFileIds = new Set(contentionCounts.keys());

  const issuesByAgent = new Map<string, QualityIssue[]>();
  for (const agent of agents) {
    const issues = detectIssues(agent, fileIds, agentIds, contendedFileIds);
    if (issues.length > 0) issuesByAgent.set(agent.id, issues);
  }

  const totalIssues = [...issuesByAgent.values()].reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  const totalSeverity = computeTotalSeverity(issuesByAgent);
  const criticalContention = hasCriticalContention(contentionCounts);
  const severityBand = classifySeverity(totalSeverity, criticalContention);
  const issueCounts = summarizeIssueCounts(issuesByAgent);
  const primaryIssue = getPrimaryIssue(issueCounts);
  const topContendedFile = getTopContendedFile(contentionCounts);

  const edges = computeCollaborationEdges(agents, agentIds);
  const isolatedIds = computeIsolatedAgentIds(agents, edges);
  const isolationRatio = computeIsolationRatio(agents, isolatedIds);
  const isolationBand = classifyIsolationBand(isolationRatio);

  const incomingCounts = computeIncomingMessageCounts(edges);
  const communicationHub = getCommunicationHub(incomingCounts);
  const hubConcentration = computeHubConcentration(edges, communicationHub);

  return {
    totalIssues,
    totalSeverity,
    severityBand,
    primaryIssue,
    topContendedFile,
    issueCounts,
    isolationRatio,
    isolationBand,
    communicationHub,
    hubConcentration,
    hubBand: classifyHubBand(hubConcentration),
  };
}

// 파이프라인 역할(라우터/실작업자/검수자/대기/결원) 배지.
// 디자이너 §7.1 합의안: 색 도트 금지, 사각 배지만, 접근성을 위해 한국어 aria-label 고정.
// 글리프는 상태 배지(STATUS_GLYPH)와 혼동될 수 있어 사용하지 않는다.
const PIPELINE_BADGE_CLASS: Record<PipelineRole, string> = {
  router: 'border-amber-300/60 bg-amber-400/10 text-amber-100/90',
  executor: 'border-emerald-300/60 bg-emerald-400/10 text-emerald-100/90',
  verifier: 'border-sky-300/55 bg-sky-400/10 text-sky-100/90',
  standby: 'border-white/25 bg-white/5 text-white/60',
  vacant: 'border-white/25 bg-white/5 text-white/40 line-through',
};

const PIPELINE_BADGE_LABEL: Record<PipelineRole, string> = {
  router: '라우터',
  executor: '실작업',
  verifier: '검수',
  standby: '대기',
  vacant: '결원',
};

export function getPipelineRoleLabel(role: PipelineRole): string {
  return PIPELINE_BADGE_LABEL[role];
}

// forbiddenSoloRate 를 0/경고/임계 초과 3단계 톤으로 접는다.
// 단일 임계(기본 0.2)를 기준으로 한 2진 분기 + 0 특례를 더한 형태.
// 근거: docs/handoffs/2026-04-17-alpha-to-beta-collab-audit.md §④ 톤 매핑 표.
export type ForbiddenSoloBand = 'clear' | 'caution' | 'exceeded';

export const DEFAULT_FORBIDDEN_SOLO_THRESHOLD = 0.2;

export function classifyForbiddenSoloBand(
  rate: number,
  threshold: number = DEFAULT_FORBIDDEN_SOLO_THRESHOLD,
): ForbiddenSoloBand {
  if (rate <= 0) return 'clear';
  if (rate > threshold) return 'exceeded';
  return 'caution';
}

const FORBIDDEN_SOLO_BAND_TONE: Record<ForbiddenSoloBand, string> = {
  clear: 'border-green-400/40 text-green-300',
  caution: 'border-yellow-300/40 text-yellow-200',
  exceeded: 'border-red-500/60 text-red-300',
};

export function getForbiddenSoloBandTone(band: ForbiddenSoloBand): string {
  return FORBIDDEN_SOLO_BAND_TONE[band];
}

// Git 자동화 단계 배지 + 실패 시 재시도 버튼.
// 디자인 결정:
//   - 단계 3개는 좌→우 파이프라인으로 시각화(사이에 얇은 커넥터).
//   - state 는 data-state 속성으로 CSS 에 위임(톤·펄스·펜던트 글리프 모두 CSS 책임).
//   - 실패 시 "재시도" 버튼이 배지 옆에 붙고, 재시도 중(retryingStage 일치)에는
//     버튼을 disabled 로 잠가 중복 호출을 막고, CSS 가 로딩 톤으로 전환.
function GitAutomationStageRow({
  digest,
  reducedMotion,
  autoFlow,
}: {
  digest: GitAutomationDigest;
  reducedMotion: boolean;
  autoFlow?: AutoFlowStages;
}) {
  const { stages, onRetryStage, retryingStage, branch, commitSha, prUrl } = digest;
  // autoFlow 가 명시되지 않으면 commit/push/pr 상태로부터 보수적인 기본 값을
  // 유추한다. 상위 데이터가 풍부해지는 즉시 호출부에서 autoFlow 를 직접 넘겨
  // 이 파생 경로를 대체하는 것이 이상적이다.
  const resolvedAutoFlow: AutoFlowStages =
    autoFlow ??
    deriveAutoFlowFromGitStages({
      commit: stages.commit.state as GitAutomationBadgeState,
      push: stages.push.state as GitAutomationBadgeState,
      pr: stages.pr.state as GitAutomationBadgeState,
    });
  const hasAnyFailure = GIT_AUTOMATION_STAGE_ORDER.some(
    key => stages[key].state === 'failed',
  );
  const hasAnyRunning = GIT_AUTOMATION_STAGE_ORDER.some(
    key => stages[key].state === 'running',
  );
  // 디자이너: "커밋이 안 됐다" 를 즉각 인지시키기 위한 경고 배너 진단.
  // 첫 번째 실패 단계의 라벨·에러 메시지를 뽑아, 단계 배지 이전에 배너로 노출.
  // 성공/대기 상태에서는 배너를 아예 렌더하지 않아 노이즈를 만들지 않는다.
  const firstFailedKey = GIT_AUTOMATION_STAGE_ORDER.find(
    key => stages[key].state === 'failed',
  );
  const firstFailedStage = firstFailedKey ? stages[firstFailedKey] : null;
  const firstFailedLabel = firstFailedKey ? GIT_AUTOMATION_STAGE_LABEL[firstFailedKey] : null;
  // "진행 흔적이 전혀 없는" 상태 — 즉 트리거 자체가 오지 않았을 가능성. 단계 배지만으로는
  // "대기 중" 과 구분이 어렵기 때문에, 전부 idle 이면서 branch/commitSha/prUrl 도 비어
  // 있을 때만 "자동화가 아직 트리거되지 않았습니다" 힌트 배너를 노출한다.
  const allIdle = GIT_AUTOMATION_STAGE_ORDER.every(key => stages[key].state === 'idle');
  const hasAnyArtifact = Boolean(branch || commitSha || prUrl);
  const showNotTriggeredHint = !hasAnyFailure && !hasAnyRunning && allIdle && !hasAnyArtifact;

  const toneClass = hasAnyFailure
    ? 'git-auto-stages--failed'
    : hasAnyRunning
      ? 'git-auto-stages--running'
      : '';

  return (
    <div
      className={`git-auto-stages ${toneClass}`.trim()}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      role="group"
      aria-label="Git 자동화 단계 진행 상황"
    >
      <div
        className="git-auto-stages__header"
        title="자동 개발 ON 상태에서 태스크 완료 시 트리거됩니다"
      >
        <span
          className="git-auto-stages__title"
          aria-describedby="git-auto-stages-trigger-hint"
        >
          Git 자동화 파이프라인
        </span>
        <span
          id="git-auto-stages-trigger-hint"
          className="sr-only"
        >
          자동 개발 ON 상태에서 태스크 완료 시 트리거됩니다
        </span>
        <span className="git-auto-stages__summary" aria-hidden>
          {hasAnyFailure ? '실패' : hasAnyRunning ? '진행중' : '대기/완료'}
        </span>
      </div>
      <AutoFlowProgressBar stages={resolvedAutoFlow} />
      {hasAnyFailure && firstFailedLabel && (
        <div
          className="git-auto-alert"
          role="alert"
          data-tone="failure"
          aria-label={`Git 자동화 ${firstFailedLabel} 단계 실패`}
        >
          <span className="git-auto-alert__icon" aria-hidden>✕</span>
          <div className="git-auto-alert__body">
            <div className="git-auto-alert__title">
              커밋이 완료되지 않았습니다 — {firstFailedLabel} 단계에서 실패
            </div>
            {firstFailedStage?.errorMessage && (
              <div
                className="git-auto-alert__reason"
                title={firstFailedStage.errorMessage}
              >
                사유: {firstFailedStage.errorMessage}
              </div>
            )}
            {!firstFailedStage?.errorMessage && (
              <div className="git-auto-alert__reason">
                사유: 서버 로그를 확인하거나 아래 재시도 버튼을 눌러 주세요.
              </div>
            )}
          </div>
        </div>
      )}
      {showNotTriggeredHint && (
        <div
          className="git-auto-alert"
          role="status"
          data-tone="not-triggered"
          aria-label="Git 자동화가 아직 트리거되지 않았습니다"
        >
          <span className="git-auto-alert__icon" aria-hidden>!</span>
          <div className="git-auto-alert__body">
            <div className="git-auto-alert__title">
              자동화가 아직 트리거되지 않았습니다
            </div>
            <div className="git-auto-alert__reason">
              자동 개발이 ON 이고 태스크가 성공 종료되면 이 영역에 커밋·푸시·PR 결과가 표시됩니다.
            </div>
          </div>
        </div>
      )}
      <ol className="git-auto-stages__list">
        {GIT_AUTOMATION_STAGE_ORDER.map((key, idx) => {
          const stage = stages[key];
          const label = GIT_AUTOMATION_STAGE_LABEL[key];
          const stateLabel = GIT_AUTOMATION_STATE_LABEL[stage.state];
          const glyph = GIT_AUTOMATION_STATE_GLYPH[stage.state];
          const isRetrying = retryingStage === key;
          const canRetry =
            stage.state === 'failed' && Boolean(onRetryStage) && !isRetrying;

          return (
            <li
              key={key}
              className="git-auto-stages__item"
              data-stage={key}
              data-state={stage.state}
              aria-label={`${label} ${stateLabel}`}
            >
              {idx > 0 && (
                <span
                  className="git-auto-stages__connector"
                  data-prev-state={stages[GIT_AUTOMATION_STAGE_ORDER[idx - 1]].state}
                  aria-hidden
                />
              )}
              <GitAutomationStageBadge
                stage={key}
                state={stage.state as GitAutomationBadgeState}
                label={label}
                detail={stage.detail}
                errorMessage={stage.errorMessage}
              />
              {stage.state === 'failed' && stage.errorMessage && (
                <span
                  className="git-auto-stages__error"
                  role="alert"
                  title={stage.errorMessage}
                >
                  {stage.errorMessage}
                </span>
              )}
              {canRetry && onRetryStage && (
                <button
                  type="button"
                  className="git-auto-retry"
                  onClick={() => onRetryStage(key)}
                  aria-label={`${label} 재시도`}
                >
                  <span aria-hidden>↻</span>
                  <span>재시도</span>
                </button>
              )}
              {isRetrying && (
                <button
                  type="button"
                  className="git-auto-retry"
                  data-retrying="true"
                  disabled
                  aria-label={`${label} 재시도 중`}
                >
                  <span aria-hidden>◔</span>
                  <span>재시도 중…</span>
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {(branch || commitSha || prUrl) && (
        <div
          className="git-auto-stages__footer"
          aria-label="Git 자동화 실행 결과"
        >
          {branch && (
            <span className="git-auto-stages__footer-item" title={`브랜치 ${branch}`}>
              <span className="git-auto-stages__footer-label">브랜치</span>
              <code className="git-auto-stages__footer-value">{branch}</code>
            </span>
          )}
          {commitSha && (
            <span className="git-auto-stages__footer-item" title={`커밋 ${commitSha}`}>
              <span className="git-auto-stages__footer-label">커밋</span>
              <code className="git-auto-stages__footer-value">{commitSha}</code>
            </span>
          )}
          {prUrl && (
            <span className="git-auto-stages__footer-item">
              <span className="git-auto-stages__footer-label">PR</span>
              <a
                className="git-auto-stages__footer-value git-auto-stages__footer-link"
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={prUrl}
              >
                {prUrl.replace(/^https?:\/\//, '')}
              </a>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function CollabIndicatorRows({ digest }: { digest: DirectiveDigest }) {
  const reducedMotion = useReducedMotion();
  const threshold = digest.forbiddenSoloThreshold ?? DEFAULT_FORBIDDEN_SOLO_THRESHOLD;
  const soloRate = digest.forbiddenSoloRate ?? 0;
  const delegationRate =
    digest.delegationRate ??
    (digest.total === 0 ? 0 : digest.delegated / digest.total);
  const soloBand = classifyForbiddenSoloBand(soloRate, threshold);
  const orphanCount = digest.orphanHandoffCount ?? 0;
  const delegationPct = Math.round(delegationRate * 100);
  const soloPct = Math.round(soloRate * 1000) / 10; // 소수점 1자리
  const thresholdPct = Math.round(threshold * 100);

  return (
    <div
      className="pt-1 space-y-1"
      data-testid="collab-indicator"
      aria-label="협업 지표"
    >
      <div
        className="flex items-center justify-between text-[9px] uppercase tracking-wider border border-green-400/20 px-1 py-0.5"
        role="status"
        aria-label={`위임률 ${delegationPct}%`}
        title="분모=전체 지시, 분자=HANDOFF 위임된 지시 수"
      >
        <span className="text-white/60">위임률</span>
        <span className="text-green-300 flex items-center gap-1">
          <span aria-hidden>◈</span>
          {delegationPct}% · {digest.delegated}/{digest.total}
        </span>
      </div>
      <div
        className={`flex items-center justify-between text-[9px] uppercase tracking-wider border px-1 py-0.5 ${
          getForbiddenSoloBandTone(soloBand)
        } ${soloBand === 'exceeded' && !reducedMotion ? 'animate-pulse' : ''}`}
        role="status"
        aria-label={`단독 처리율 ${soloPct}%, 임계 ${thresholdPct}%`}
        title="라우팅 매트릭스에서 ❌ 판정인 지시 중 알파가 단독 처리한 비율"
        data-solo-band={soloBand}
      >
        <span className="text-white/60">❌ 단독 처리율</span>
        <span className="flex items-center gap-1">
          <span aria-hidden>⚠</span>
          {soloPct}% · 임계 {thresholdPct}%
        </span>
      </div>
      {orphanCount > 0 && (
        <div
          className="flex items-center justify-between text-[9px] uppercase tracking-wider border border-yellow-300/40 text-yellow-200 px-1 py-0.5"
          role="status"
          aria-label={`고아 HANDOFF ${orphanCount}건`}
          title="linked_directive 필드가 없는 HANDOFF — 회수 대상"
        >
          <span className="text-white/60">고아 HANDOFF</span>
          <span className="flex items-center gap-1">
            <span aria-hidden>⚑</span>
            {orphanCount}건
          </span>
        </div>
      )}
    </div>
  );
}

export function PipelineBadge({ role }: { role: PipelineRole }) {
  return (
    <span
      role="img"
      aria-label={`파이프라인 역할: ${PIPELINE_BADGE_LABEL[role]}`}
      className={`inline-flex items-center gap-1 border px-1 text-[9px] uppercase tracking-wider leading-[14px] ${PIPELINE_BADGE_CLASS[role]}`}
      data-pipeline-role={role}
    >
      {PIPELINE_BADGE_LABEL[role]}
    </span>
  );
}

export function AgentStatusPanel({
  agents,
  files,
  translateRole,
  translateStatus,
  showSummary = true,
  showInsights = false,
  showQualityWarnings = false,
  showDirectiveDigest = false,
  directiveDigest,
  showGitAutomation = false,
  gitAutomation,
  autoFlow,
  onInboxPathClick,
}: Props) {
  // STATUS_DOT/품질 경고 배너 등 패널 전역 애니메이션 게이트.
  // CollabIndicatorRows 와 동일한 훅을 공유해 한 사용자 환경에서 규칙이 갈리지 않게 한다.
  const reducedMotion = useReducedMotion();
  // 동일 컬렉션을 두 번(이름 맵 + ID 셋) 훑지 않도록 단일 순회로 인덱스를 만든다.
  // 에이전트/파일 수가 늘어날수록 매 렌더의 비용 차이가 커지는 부분.
  const { fileNameById, fileIdSet } = useMemo(() => {
    const nameMap = new Map<string, string>();
    const idSet = new Set<string>();
    for (const f of files) {
      nameMap.set(f.id, f.name);
      idSet.add(f.id);
    }
    return { fileNameById: nameMap, fileIdSet: idSet };
  }, [files]);

  const { agentNameById, agentIdSet } = useMemo(() => {
    const nameMap = new Map<string, string>();
    const idSet = new Set<string>();
    for (const a of agents) {
      nameMap.set(a.id, a.name);
      idSet.add(a.id);
    }
    return { agentNameById: nameMap, agentIdSet: idSet };
  }, [agents]);
  const contentionCounts = useMemo(() => computeContentionCounts(agents), [agents]);
  const contendedFileIds = useMemo(
    () => new Set(contentionCounts.keys()),
    [contentionCounts],
  );

  // 경쟁이 심한 순으로 정렬한 상위 파일명 목록(최대 3개).
  // 리더가 어느 파일부터 재배분할지 즉시 판단할 수 있도록 경고 배너에 노출한다.
  const topContendedNames = useMemo(() => {
    return [...contentionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, count]) => {
        const name = fileNameById.get(id) ?? '알 수 없는 파일';
        return `${name}×${count}`;
      });
  }, [contentionCounts, fileNameById]);

  // 각 에이전트의 품질 이슈를 사전 계산. 렌더 루프 내부 재계산을 피한다.
  const issuesByAgent = useMemo(() => {
    const map = new Map<string, QualityIssue[]>();
    for (const agent of agents) {
      const issues = detectIssues(agent, fileIdSet, agentIdSet, contendedFileIds);
      if (issues.length > 0) map.set(agent.id, issues);
    }
    return map;
  }, [agents, fileIdSet, agentIdSet, contendedFileIds]);

  const totalIssues = useMemo(
    () => [...issuesByAgent.values()].reduce((sum, arr) => sum + arr.length, 0),
    [issuesByAgent],
  );

  // 스칼라 위험도 점수 및 치명 경쟁 여부. 배너 강조 톤과 수치 표기에 모두 사용.
  const totalSeverity = useMemo(() => computeTotalSeverity(issuesByAgent), [issuesByAgent]);
  const criticalContention = useMemo(
    () => hasCriticalContention(contentionCounts),
    [contentionCounts],
  );
  // 점수·충돌 여부를 한 번에 접어 배너 톤 분기를 단일 밴드로 통일.
  const severityBand = useMemo(
    () => classifySeverity(totalSeverity, criticalContention),
    [totalSeverity, criticalContention],
  );

  // 이슈 종류별 누적 건수(심각도 내림차순). 경고 배너 하단에 칩으로 노출한다.
  const issueCounts = useMemo(() => summarizeIssueCounts(issuesByAgent), [issuesByAgent]);
  const issueBreakdown = useMemo(
    () =>
      [...issueCounts.entries()].sort(
        ([a], [b]) => QUALITY_ISSUE_SEVERITY[b] - QUALITY_ISSUE_SEVERITY[a],
      ),
    [issueCounts],
  );
  // 가장 먼저 처리해야 하는 이슈 한 건. 배너 헤더에 노출해 리더의 첫 조치를 안내한다.
  const primaryIssue = useMemo(() => getPrimaryIssue(issueCounts), [issueCounts]);

  // 정렬 우선순위:
  //   1) 상태 밴드(working → meeting → thinking → idle)
  //   2) 품질 경고 표시 중이면 심각도 높은 순(즉시 조치가 필요한 에이전트를 상단에 고정)
  //   3) 이름 로케일 정렬
  const sortedAgents = useMemo(
    () =>
      [...agents].sort((a, b) => {
        const weightDiff =
          STATUS_SORT_WEIGHT[a.status] - STATUS_SORT_WEIGHT[b.status];
        if (weightDiff !== 0) return weightDiff;
        if (showQualityWarnings) {
          const severityDiff =
            computeAgentSeverity(issuesByAgent.get(b.id) ?? []) -
            computeAgentSeverity(issuesByAgent.get(a.id) ?? []);
          if (severityDiff !== 0) return severityDiff;
        }
        return a.name.localeCompare(b.name, 'ko');
      }),
    [agents, issuesByAgent, showQualityWarnings],
  );

  const counts = useMemo(() => summarize(agents), [agents]);
  const activeRatio = useMemo(() => computeActiveRatio(agents), [agents]);
  const roleDistribution = useMemo(() => summarizeByRole(agents), [agents]);
  const roleActivity = useMemo(() => computeRoleActivity(agents), [agents]);
  const roleGap = useMemo(() => computeRoleImbalanceGap(roleActivity), [roleActivity]);
  const activeRatioPct = Math.round(activeRatio * 100);
  const showImbalanceHint = roleGap >= ROLE_IMBALANCE_THRESHOLD;

  // 협업 엣지와 고립 비율. 연구 관점의 "누가 대화에서 소외됐나"를 수치로 드러낸다.
  const collaborationEdges = useMemo(
    () => computeCollaborationEdges(agents, agentIdSet),
    [agents, agentIdSet],
  );
  const isolatedAgentIds = useMemo(
    () => computeIsolatedAgentIds(agents, collaborationEdges),
    [agents, collaborationEdges],
  );
  const isolationRatio = useMemo(
    () => computeIsolationRatio(agents, isolatedAgentIds),
    [agents, isolatedAgentIds],
  );
  const isolationPct = Math.round(isolationRatio * 100);

  // 수신 빈도 기반 허브 탐지. 허브가 전체 엣지의 절반 이상을 점유하면
  // 단일 실패점 위험으로 간주해 인사이트 패널에서 강조 표기한다.
  const incomingCounts = useMemo(
    () => computeIncomingMessageCounts(collaborationEdges),
    [collaborationEdges],
  );
  const communicationHub = useMemo(
    () => getCommunicationHub(incomingCounts),
    [incomingCounts],
  );
  const hubConcentration = useMemo(
    () => computeHubConcentration(collaborationEdges, communicationHub),
    [collaborationEdges, communicationHub],
  );
  const hubPct = Math.round(hubConcentration * 100);
  const hubBand = useMemo(() => classifyHubBand(hubConcentration), [hubConcentration]);
  const hubName = communicationHub
    ? (agentNameById.get(communicationHub.agentId) ?? communicationHub.agentId)
    : null;

  if (agents.length === 0) {
    return (
      <div
        className="border-2 border-dashed border-white/20 bg-black/20 p-3 text-center space-y-1"
        role="status"
      >
        <div className="text-[14px]" aria-hidden>
          ▧
        </div>
        <p className="text-[11px] text-white/60">
          고용된 에이전트가 없습니다.
        </p>
        <p className="text-[9px] uppercase tracking-wider text-white/40">
          팀원을 영입해 첫 스프린트를 시작하세요
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {showSummary && (
        <div
          className="flex gap-2 text-[9px] uppercase tracking-wider"
          aria-label="상태별 에이전트 수"
        >
          {(Object.keys(STATUS_SORT_WEIGHT) as AgentStatus[]).map(status => (
            <span
              key={status}
              className={`flex items-center gap-1 ${getStatusClass(STATUS_LABEL_COLOR, status)}`}
            >
              <span
                className={`inline-block w-1.5 h-1.5 ${getStatusClass(STATUS_DOT, status)}${
                  shouldPulse(status, reducedMotion) ? ' animate-pulse' : ''
                }`}
                aria-hidden
              />
              <span className="text-[9px] leading-none" aria-hidden>
                {getStatusGlyph(status)}
              </span>
              {translateStatus(status)} {counts[status]}
            </span>
          ))}
        </div>
      )}

      {showQualityWarnings && totalIssues > 0 && (
        <div
          className={`border-2 p-3 space-y-1 text-[10px] ${
            severityBand === 'critical'
              ? `border-red-500/70 bg-red-600/15 text-red-100/90${reducedMotion ? '' : ' animate-pulse'}`
              : severityBand === 'major'
                ? 'border-red-400/50 bg-red-500/10 text-red-200/85'
                : 'border-amber-400/40 bg-amber-500/5 text-amber-100/85'
          }`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-severity={severityBand}
          aria-label="품질 경고 요약"
        >
          <div className="uppercase tracking-wider font-bold flex items-center justify-between gap-2">
            <span>
              품질 경고 · {issuesByAgent.size}명 · {totalIssues}건
            </span>
            <span
              className="text-[9px] font-normal opacity-90 flex items-center gap-1"
              title="이슈별 심각도 가중치의 합. 클수록 즉시 개입이 필요."
            >
              <span aria-hidden>{getSeverityBandGlyph(severityBand)}</span>
              {getSeverityBandLabel(severityBand)} · 위험도 {totalSeverity}
            </span>
          </div>
          <div className="opacity-80 mt-0.5">
            상태-필드 불일치 또는 유실된 참조가 감지되었습니다.
          </div>
          {primaryIssue && (
            <div
              className="opacity-95 mt-1 text-[10px]"
              title="심각도와 건수를 종합해 가장 먼저 살필 이슈 한 건"
            >
              먼저 살필 이슈: {QUALITY_ISSUE_LABEL[primaryIssue.issue]} · {primaryIssue.count}건
            </div>
          )}
          {topContendedNames.length > 0 && (
            <div className="opacity-90 mt-1 truncate" title={topContendedNames.join(', ')}>
              경쟁 파일: {topContendedNames.join(', ')}
            </div>
          )}
          {issueBreakdown.length > 0 && (
            <div
              className="flex flex-wrap gap-1 mt-1"
              aria-label="이슈 유형별 건수"
            >
              {issueBreakdown.map(([issue, count]) => (
                <span
                  key={issue}
                  className="text-[9px] uppercase tracking-wider border border-red-400/40 bg-red-500/10 px-1"
                  title={QUALITY_ISSUE_LABEL[issue]}
                >
                  {QUALITY_ISSUE_LABEL[issue]} · {count}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {showDirectiveDigest && directiveDigest && (
        <div
          className="border-2 border-[var(--pixel-border)] bg-black/30 p-3 space-y-1 text-[10px]"
          role="status"
          aria-label="오늘 지시 요약"
          data-testid="directive-digest"
        >
          <div className="flex items-center justify-between uppercase tracking-wider">
            <span className="text-white/70">오늘 지시 {directiveDigest.today}</span>
            <span className="text-[var(--pixel-accent)] font-bold">
              {directiveDigest.total}건 · 위임 {directiveDigest.delegated} · 단독(예외) {directiveDigest.soloWithException}
            </span>
          </div>
          {directiveDigest.latestEntries.length > 0 && (
            <ul className="space-y-0.5 mt-1" aria-label="최근 지시 목록">
              {directiveDigest.latestEntries.map((entry, idx) => (
                <li
                  key={`${idx}-${entry.digest}`}
                  className="text-white/80 truncate flex items-center gap-1"
                  title={`${entry.digest} · ${getDirectiveStatusLabel(entry.status)}`}
                >
                  <span aria-hidden>▸</span>
                  <span className="truncate flex-1">{entry.digest}</span>
                  <span
                    className="text-[9px] uppercase tracking-wider text-white/60"
                    aria-label={getDirectiveStatusLabel(entry.status)}
                  >
                    <span aria-hidden>{getDirectiveStatusGlyph(entry.status)}</span>{' '}
                    {getDirectiveStatusLabel(entry.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="text-[9px] uppercase tracking-wider text-white/50 pt-1">
            원문:{' '}
            {onInboxPathClick ? (
              <button
                type="button"
                onClick={() => onInboxPathClick(directiveDigest.inboxPath)}
                className="underline underline-offset-2 text-[var(--pixel-accent)] hover:opacity-80"
              >
                {directiveDigest.inboxPath}
              </button>
            ) : (
              <span className="text-white/70">{directiveDigest.inboxPath}</span>
            )}
          </div>
        </div>
      )}

      {showGitAutomation && gitAutomation && (
        <GitAutomationStageRow
          digest={gitAutomation}
          reducedMotion={reducedMotion}
          autoFlow={autoFlow}
        />
      )}

      {showInsights && (
        <div
          className="border-2 border-[var(--pixel-border)] bg-black/30 p-3 space-y-2"
          aria-label="팀 가동률 및 역할 분포"
        >
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider">
            <span className="text-white/70">활성률</span>
            <span className="text-[var(--pixel-accent)] font-bold">
              {activeRatioPct}%
            </span>
          </div>
          <div
            className="h-1.5 bg-white/10 overflow-hidden"
            role="progressbar"
            aria-valuenow={activeRatioPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-green-400/70 transition-all"
              style={{ width: `${activeRatioPct}%` }}
            />
          </div>
          {roleDistribution.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {roleDistribution.map(([role, count]) => (
                <span
                  key={role}
                  className="text-[9px] uppercase tracking-wider text-white/70 bg-white/5 px-1"
                >
                  {translateRole(role)} · {count}
                </span>
              ))}
            </div>
          )}
          {roleActivity.length > 1 && (
            <div
              className="flex flex-wrap gap-1 pt-1"
              aria-label="역할별 활성률"
            >
              {roleActivity.map(({ role, total, active, ratio }) => {
                const pct = Math.round(ratio * 100);
                const tone =
                  ratio === 0
                    ? 'text-white/40'
                    : ratio < 0.34
                      ? 'text-yellow-300'
                      : 'text-green-300';
                return (
                  <span
                    key={role}
                    className={`text-[9px] uppercase tracking-wider bg-white/5 px-1 ${tone}`}
                    title={`${translateRole(role)} 활성 ${active}/${total}`}
                  >
                    {translateRole(role)} {pct}%
                  </span>
                );
              })}
            </div>
          )}
          {showImbalanceHint && (
            <div
              className="text-[9px] uppercase tracking-wider text-yellow-200/90 pt-1"
              role="status"
            >
              역할 편차 {Math.round(roleGap * 100)}%p · 재배분 권장
            </div>
          )}
          {agents.length > 1 && (
            <div
              className="flex items-center justify-between text-[9px] uppercase tracking-wider pt-1"
              title="최근 메시지 송수신 이력이 전혀 없는 에이전트 비율"
            >
              <span className="text-white/60">고립률</span>
              <span
                className={
                  isolationRatio === 0
                    ? 'text-green-300'
                    : isolationRatio >= 0.5
                      ? 'text-red-300'
                      : 'text-yellow-200'
                }
              >
                {isolationPct}% · {isolatedAgentIds.size}/{agents.length}
              </span>
            </div>
          )}
          {directiveDigest && directiveDigest.forbiddenSoloRate !== undefined && (
            <CollabIndicatorRows digest={directiveDigest} />
          )}
          {communicationHub && hubName && agents.length > 1 && (
            <div
              className="flex items-center justify-between text-[9px] uppercase tracking-wider pt-1"
              title="수신 메시지가 가장 많은 에이전트. 50% 이상이면 단일 병목 신호."
              data-hub-band={hubBand}
            >
              <span className="text-white/60">커뮤니케이션 허브</span>
              <span className={`flex items-center gap-1 ${getHubBandTone(hubBand)}`}>
                <span aria-hidden>{getHubBandGlyph(hubBand)}</span>
                {hubName} · {communicationHub.count}건 · {hubPct}% · {getHubBandLabel(hubBand)}
              </span>
            </div>
          )}
        </div>
      )}

      <ul
        className="space-y-2"
        role="list"
        aria-label="에이전트 작업 현황"
      >
        {sortedAgents.map(agent => {
          const dotBase = getStatusClass(STATUS_DOT, agent.status);
          const dot = shouldPulse(agent.status, reducedMotion)
            ? `${dotBase} animate-pulse`
            : dotBase;
          const labelColor = getStatusClass(STATUS_LABEL_COLOR, agent.status);
          const workingFile = agent.workingOnFileId
            ? fileNameById.get(agent.workingOnFileId)
            : undefined;
          const statusLabel = translateStatus(agent.status);
          const agentIssues = issuesByAgent.get(agent.id) ?? [];
          const hasIssues = showQualityWarnings && agentIssues.length > 0;
          // 고립 표시는 팀 규모가 2명 이상일 때만 의미 있음(1인 팀은 정의상 항상 고립).
          const isIsolated =
            showInsights && agents.length > 1 && isolatedAgentIds.has(agent.id);

          return (
            // 에이전트 카드는 클릭 가능한 대상이 아니라 상태 요약 전용이다.
            // 이전에는 onAgentClick 이 주입되면 role="button"·cursor-pointer 로 승격됐지만,
            // 호출부가 없어 접근성 안내(버튼으로 보이지만 반응 없음)만 남는 부작용이 있었다.
            <li
              key={agent.id}
              aria-label={`${agent.name} · ${translateRole(agent.role)} · ${statusLabel}`}
              className="bg-black/25 border-2 border-[var(--pixel-border)] p-3 space-y-1 transition-colors"
              title={agent.persona ?? translateRole(agent.role)}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold ${
                    resolveAvatarTint(agent.role)
                  } ${getStatusClass(STATUS_AVATAR_RING, agent.status)}`}
                  aria-hidden
                >
                  {getAgentInitial(agent.name)}
                </span>
                <span className={`inline-block w-2 h-2 ${dot}`} aria-hidden />
                <span className="text-[12px] font-bold text-[var(--pixel-accent)] truncate flex-1">
                  {agent.name}
                </span>
                {isIsolated && (
                  <span
                    className="text-[9px] uppercase tracking-wider text-white/50 border border-white/20 px-1"
                    title="최근 송수신 메시지가 없는 고립 상태"
                    aria-label="고립"
                  >
                    고립
                  </span>
                )}
                <span
                  className={`text-[9px] uppercase tracking-wider ${labelColor}`}
                >
                  {statusLabel}
                </span>
              </div>
              <div className="flex items-center gap-1 text-[10px] opacity-70 mt-1">
                <span>{translateRole(agent.role)}</span>
                <span aria-hidden className="text-white/30">·</span>
                <PipelineBadge role={derivePipelineRole(agent)} />
                {/*
                  '답변 전용' 배지는 lastMessage TTL 이 만료돼도 lastLeaderMessageKind
                  값으로 판단하므로 메시지가 사라진 뒤에도 "최근 응답 유형" 을 계속
                  드러낸다. 리더 역할에 한해 노출해 비리더 에이전트에 오인된 배지가
                  붙지 않도록 방어.
                */}
                {agent.role === 'Leader' && agent.lastLeaderMessageKind === 'reply' && (
                  <>
                    <span aria-hidden className="text-white/30">·</span>
                    <span
                      className="text-[9px] uppercase tracking-wider text-cyan-200 border border-cyan-300/40 bg-cyan-400/10 px-1"
                      data-leader-kind="reply"
                      title={LEADER_ANSWER_ONLY_TOOLTIP}
                    >
                      {LEADER_ANSWER_ONLY_LABEL}
                    </span>
                  </>
                )}
              </div>
              {agent.persona && (
                <div
                  className="kr-msg text-[10px] mt-1 text-white/60 line-clamp-2 italic"
                  title={agent.persona}
                  data-testid="agent-persona"
                >
                  {agent.persona}
                </div>
              )}
              {workingFile && (
                <div className="text-[10px] mt-1 text-[var(--pixel-accent)] truncate">
                  <span className="kr-label">작업 파일:</span> <span className="opacity-90">{workingFile}</span>
                </div>
              )}
              {agent.currentTask && (
                <div
                  className="kr-msg text-[10px] mt-1 text-white/80 line-clamp-2"
                  title={agent.currentTask}
                >
                  할 일: {agent.currentTask}
                </div>
              )}
              {agent.lastMessage && (() => {
                // 리더가 남긴 메시지는 "업무 분배" 인지 "답변 전용" 인지가 팀 운영의 핵심
                // 구분 신호라, 다른 역할의 메시지와는 다른 톤/아이콘으로 한 번에 식별하게 한다.
                // 비리더 에이전트의 lastMessage 는 기존 중립 톤(plain) 을 유지한다.
                const kind: LeaderMessageKind =
                  agent.role === 'Leader'
                    ? classifyLeaderMessage(agent.lastMessage)
                    : 'plain';
                return (
                  <div
                    className={`leader-msg leader-msg--${kind} kr-msg text-[10px] mt-1 line-clamp-2 italic`}
                    data-leader-kind={kind}
                    title={agent.lastMessage}
                  >
                    <span className="leader-msg__icon" aria-hidden>
                      {getLeaderMessageIcon(kind)}
                    </span>
                    {agent.lastMessageTo
                      ? `${agentNameById.get(agent.lastMessageTo) ?? agent.lastMessageTo}: `
                      : ''}
                    “{agent.lastMessage}”
                  </div>
                );
              })()}
              {hasIssues && (
                <div
                  className="flex flex-wrap gap-1 mt-1"
                  aria-label={`품질 경고 · 위험도 ${computeAgentSeverity(agentIssues)}`}
                  data-agent-severity={computeAgentSeverity(agentIssues)}
                >
                  {agentIssues.map(issue => (
                    <span
                      key={issue}
                      className="text-[9px] uppercase tracking-wider text-red-200 border border-red-400/50 bg-red-500/10 px-1"
                      title={QUALITY_ISSUE_LABEL[issue]}
                    >
                      ⚠ {QUALITY_ISSUE_LABEL[issue]}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
