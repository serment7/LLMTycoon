// 리더 에이전트가 분배 계획을 JSON 으로 응답하면 서버 taskRunner 가 두 번에
// 걸쳐 emit 한다 — 한 번은 parsed.message 만, 한 번은 final.slice(0, 400) 로
// 원문 전체. 후자가 그대로 LogPanel·말풍선에 노출되면 사용자에게 코드 덩어리만
// 쏟아진다. 본 파서는 렌더 단계에서 한 번 더 JSON 을 풀어 message·tasks 를
// 구조화된 형태로 돌려준다. 이미 정제된 한 줄 텍스트는 match 가 실패해 null 이
// 반환되므로 호출부가 원문 폴백을 그대로 쓰면 된다.

export type LeaderPlanMode = 'dispatch' | 'reply';

export type LeaderPlan = {
  // mode="reply" 면 사용자 질문에 대한 단순 답변이라는 뜻 — UI 는 tasks 섹션을
  // 생략하고 message 만 본문으로 렌더해야 한다. mode 가 누락된 과거 응답은
  // tasks 길이 기반으로 추정한다.
  mode: LeaderPlanMode;
  message?: string;
  tasks: { assignedTo: string; description: string }[];
};

export function parseLeaderPlanMessage(text: string | undefined | null): LeaderPlan | null {
  if (!text || typeof text !== 'string') return null;
  // 빠른 컷오프: '{' 가 없는 일반 문장은 정규식·JSON.parse 까지 갈 필요 없다.
  if (!text.includes('{')) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (!parsed || typeof parsed !== 'object') return null;
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks
          .filter(
            (t: any) =>
              t && typeof t.assignedTo === 'string' && typeof t.description === 'string',
          )
          .map((t: any) => ({
            assignedTo: String(t.assignedTo),
            description: String(t.description),
          }))
      : [];
    const message = typeof parsed.message === 'string' ? parsed.message : undefined;
    // tasks 도 message 도 없으면 의미 있는 plan 이 아님 → null 반환해 폴백.
    if (tasks.length === 0 && !message) return null;
    const rawMode = typeof parsed.mode === 'string' ? parsed.mode.toLowerCase() : '';
    const mode: LeaderPlanMode =
      rawMode === 'reply' || rawMode === 'dispatch'
        ? (rawMode as LeaderPlanMode)
        : tasks.length > 0
          ? 'dispatch'
          : 'reply';
    return { mode, message, tasks };
  } catch {
    return null;
  }
}

// 본문 표시에 쓸 한 줄 요약. parsed.message 가 있으면 그것을 우선,
// 없으면 첫 task description 으로 폴백, 둘 다 없으면 원문 그대로.
// 말풍선·컨텍스트 라인처럼 공간이 좁은 곳에서 사용한다.
export function summarizeLeaderMessage(text: string | undefined | null): string {
  if (!text) return '';
  const plan = parseLeaderPlanMessage(text);
  if (!plan) return text;
  if (plan.message) return plan.message;
  if (plan.tasks.length > 0) return plan.tasks[0].description;
  return text;
}

// 리더 메시지 시각 구분용 분류.
//   - 'delegate' : tasks 가 1건 이상이거나 mode==='dispatch' 인 "업무 분배". 강조 배경 + 화살표 아이콘.
//   - 'reply'    : tasks 없이 message 만 있거나 mode==='reply' 인 "답변 전용". 연한 배경 + 말풍선 아이콘.
//   - 'plain'    : 리더 계획 JSON 이 아닌 자유 텍스트 혹은 빈 값. 기존 중립 톤 유지.
// 디자인 배경: 사용자가 "지시가 팀에 퍼졌는지" 를 한 눈에 구분할 수 있도록
// Leader 역할이 남긴 모든 lastMessage·로그 라인에 공통으로 적용한다.
export type LeaderMessageKind = 'delegate' | 'reply' | 'plain';

export function classifyLeaderMessage(text: string | undefined | null): LeaderMessageKind {
  if (!text) return 'plain';
  const plan = parseLeaderPlanMessage(text);
  if (!plan) return 'plain';
  if (plan.mode === 'dispatch' || plan.tasks.length > 0) return 'delegate';
  if (plan.mode === 'reply' || plan.message) return 'reply';
  return 'plain';
}

// '답변 전용' 여부만 묻는 불리언 헬퍼. 서버 taskRunner 는 agent:messaged 페이로드에
// 이 플래그를 태워 보내고, UI 는 배지 렌더 여부 판단에 별도 JSON 파싱 없이 곧바로
// 이 함수를 쓸 수 있다. classifyLeaderMessage 의 래퍼지만, 의도를 문장으로 드러내기
// 위해 export 한다.
export function isLeaderAnswerOnly(text: string | undefined | null): boolean {
  return classifyLeaderMessage(text) === 'reply';
}

// '답변 전용' 배지 라벨. 리더 카드(AgentStatusPanel)·머리 위 말풍선(AgentContextBubble)·
// 채팅 로그가 동일 단어를 쓰도록 단일 출처로 묶는다. 한국어 어휘 변경(예: "답변만") 시
// 이 한 줄만 고치면 세 곳이 동시에 따라간다.
export const LEADER_ANSWER_ONLY_LABEL = '답변 전용';

// 위 배지에 붙는 호버 툴팁. 기존엔 App.tsx / AgentContextBubble / AgentStatusPanel
// 세 곳이 "팀원 분배 없이...", "최근 리더 응답은 분배 없이...", "분배 없이 사용자
// 질문에..." 식으로 제각각 문구를 들고 있어, 같은 배지가 패널마다 다른 설명을
// 달고 나타났다. 문구를 이 상수 하나로 고정해 어휘 드리프트를 차단한다.
//
// 배지 자체는 "이 리더의 최근 응답이 답변 전용이었음" 을 드러내는 경우(Agent
// 카드·컨텍스트 말풍선)와 "이 특정 로그 라인이 답변 전용" 인 경우(LogPanel)
// 두 가지 문맥에서 쓰이지만, 사용자에게 설명해야 할 핵심은 동일하다 —
// "팀원 분배 없이 사용자 질문에만 답한 리더 응답" 이라는 사실. 따라서 한 문장으로
// 수렴시켜도 두 문맥을 모두 정확히 설명한다.
export const LEADER_ANSWER_ONLY_TOOLTIP =
  '팀원 분배 없이 사용자 질문에만 답한 리더 응답입니다.';

// 리더 메시지 종류별 "짧은 칩 라벨" 과 "툴팁 문구" 의 단일 출처.
// 같은 kind 를 화면 여러 곳에서 렌더할 때 표기가 미세하게 어긋나면("업무 분배",
// "팀 분배", "분배 메시지" 식으로 제각각) 사용자는 같은 개념을 세 번 학습해야 한다.
// AgentStatusSnapshot 의 mix-chip, AgentContextBubble 의 헤더 배지, App.tsx 의 로그
// 패널 배지가 모두 이 두 상수를 읽어 표기를 한 곳으로 수렴시킨다.
//
//   - delegate : 업무 분배. 팀원 1명 이상에게 태스크가 흘러간 상태.
//   - reply    : 답변 전용. 사용자 질문에만 응답하고 분배는 없음.
//   - plain    : 자유 텍스트. 리더 plan JSON 이 아닌 일반 발화.
export const LEADER_MESSAGE_KIND_LABEL: Record<LeaderMessageKind, string> = {
  delegate: '분배',
  reply: '답변',
  plain: '일반',
};

// 툴팁 문구는 "이 칩/배지가 무엇을 의미하는지" 를 한 문장으로 설명한다. 라벨이
// 짧아 의미가 묻힐 때 호버로 보강하는 용도이며, 같은 칩이 여러 패널에서 재사용될
// 때 문구가 달라져 혼란을 주지 않도록 여기서 한 곳에 고정한다. 문구 수정 시 이
// 레코드만 갱신하면 AgentStatusSnapshot·로그 패널 배지·통합 테스트가 동시에 따라
// 온다.
export const LEADER_MESSAGE_KIND_TOOLTIP: Record<LeaderMessageKind, string> = {
  delegate: '팀원에게 태스크가 분배된 리더 메시지입니다.',
  reply: '분배 없이 사용자 질문에만 답한 리더 메시지입니다.',
  plain: '리더 plan JSON 이 아닌 자유 텍스트 발화입니다.',
};

// ---------------------------------------------------------------------------
// 개선 보고(ImprovementReport) — 에이전트가 태스크 종료 직후 "다음에 손 볼 거리"
// 를 리더 큐로 흘려 보내는 협업 메시지. 직렬화된 본문은 JSON 한 줄로 유지되어
// agentWorker → taskRunner → dispatchTask → 리더 워커 enqueue 파이프라인을 그대로
// 통과한다. 리더는 formatImprovementReportForLeader 로 변환된 한국어 지시문을
// 태스크 description 으로 받아 평소의 mode="dispatch"/"reply" 분기에 투입한다.
// ---------------------------------------------------------------------------

export type ImprovementReportCategory =
  | 'bug'
  | 'refactor'
  | 'doc'
  | 'test'
  | 'followup'
  | 'other';

export interface ImprovementReport {
  schema: 'improvement-report/1';
  agentId: string;
  agentName?: string;
  role?: string;
  projectId: string;
  taskId?: string;
  focusFiles: string[];
  category: ImprovementReportCategory;
  summary: string;
  detail?: string;
  at: number;
}

interface CreateImprovementReportInput {
  agentId: string;
  projectId: string;
  summary: string;
  agentName?: string;
  role?: string;
  taskId?: string;
  focusFiles?: string[];
  category?: ImprovementReportCategory;
  detail?: string;
  at?: number;
}

const IMPROVEMENT_FOCUS_FILE_CAP = 8;
const IMPROVEMENT_CATEGORY_SET = new Set<ImprovementReportCategory>([
  'bug', 'refactor', 'doc', 'test', 'followup', 'other',
]);

// summary 가 비면 null 을 돌려 파이프라인이 빈 지시를 리더에게 넘기지 않도록
// 차단한다. focusFiles 는 중복 제거 후 상한으로 잘라 리더 프롬프트에 붙는 본문이
// 비대해지는 것을 막는다.
export function createImprovementReport(
  input: CreateImprovementReportInput,
): ImprovementReport | null {
  const summary = input.summary?.trim();
  if (!summary) return null;
  if (!input.agentId || !input.projectId) return null;
  const focusFiles = Array.from(
    new Set(
      (input.focusFiles ?? [])
        .map(s => (typeof s === 'string' ? s.trim() : ''))
        .filter((s): s is string => s.length > 0),
    ),
  ).slice(0, IMPROVEMENT_FOCUS_FILE_CAP);
  const category = IMPROVEMENT_CATEGORY_SET.has(input.category as ImprovementReportCategory)
    ? (input.category as ImprovementReportCategory)
    : 'other';
  return {
    schema: 'improvement-report/1',
    agentId: input.agentId,
    agentName: input.agentName?.trim() || undefined,
    role: input.role?.trim() || undefined,
    projectId: input.projectId,
    taskId: input.taskId,
    focusFiles,
    category,
    summary: summary.slice(0, 400),
    detail: input.detail?.trim().slice(0, 600) || undefined,
    at: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now(),
  };
}

export function serializeImprovementReport(report: ImprovementReport): string {
  return JSON.stringify(report);
}

// 직렬화된 본문이 다른 로그 라인과 함께 섞여 와도 복원 가능하도록, 첫 번째
// '{…}' 블록에서 JSON 을 잘라 내고 schema 고정값을 확인한다. schema 가 맞지 않거나
// 필수 필드(agentId/projectId/summary) 가 비면 null 을 돌려 호출부가 폴백 경로로
// 빠질 수 있게 한다.
export function parseImprovementReport(
  text: string | null | undefined,
): ImprovementReport | null {
  if (!text || typeof text !== 'string') return null;
  if (!text.includes('"improvement-report/1"')) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schema !== 'improvement-report/1') return null;
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const agentId = typeof parsed.agentId === 'string' ? parsed.agentId : '';
    const projectId = typeof parsed.projectId === 'string' ? parsed.projectId : '';
    if (!summary || !agentId || !projectId) return null;
    const focusFiles = Array.isArray(parsed.focusFiles)
      ? parsed.focusFiles.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
      : [];
    const category = IMPROVEMENT_CATEGORY_SET.has(parsed.category as ImprovementReportCategory)
      ? (parsed.category as ImprovementReportCategory)
      : 'other';
    return {
      schema: 'improvement-report/1',
      agentId,
      agentName: typeof parsed.agentName === 'string' ? parsed.agentName : undefined,
      role: typeof parsed.role === 'string' ? parsed.role : undefined,
      projectId,
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : undefined,
      focusFiles: focusFiles.slice(0, IMPROVEMENT_FOCUS_FILE_CAP),
      category,
      summary: summary.slice(0, 400),
      detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
      at: typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : Date.now(),
    };
  } catch {
    return null;
  }
}

const IMPROVEMENT_CATEGORY_LABEL: Record<ImprovementReportCategory, string> = {
  bug: '버그',
  refactor: '리팩터링',
  doc: '문서',
  test: '테스트',
  followup: '후속 작업',
  other: '기타',
};

// 리더가 팀원 개선 보고를 받았을 때, Git 자동화 파이프라인 (runGitAutomation /
// executeGitAutomation / MCP trigger_git_automation) 에 넘길 context 를 만든다.
// report.category 를 conventional commit 타입으로 매핑하고, summary 는 64자 상한으로
// 잘라 브랜치·커밋 메시지에 안전한 길이로 유지한다. agent 필드는 report.agentName →
// 호출자 reporterName → 'unknown' 순서로 폴백해, 리더가 "누구의 완료를 커밋하는지"
// 를 항상 명시할 수 있게 한다.
//
// 왜 순수 함수로 분리하는가:
//   - taskRunner.handleImprovementReport 의 리더 분기 가 이 함수를 호출해
//     runGitAutomation 에 넘긴다. MongoDB/Socket.IO 의존 없이 단위 테스트로 매핑
//     규칙을 고정할 수 있어, conventional commit 타입이 드리프트하는 회귀를 막는다.
//   - leaderDispatch.test.ts 의 시뮬레이터가 동일한 순수 함수를 써 서버 분기와
//     "리더 경유 자동화" 계약을 이중으로 가둔다.
const IMPROVEMENT_CATEGORY_TO_COMMIT_TYPE: Record<ImprovementReportCategory, string> = {
  bug: 'fix',
  refactor: 'refactor',
  doc: 'docs',
  test: 'test',
  followup: 'chore',
  other: 'chore',
};

export interface LeaderGitAutomationContext {
  type: string;
  summary: string;
  agent: string;
}

export function buildLeaderGitAutomationContext(
  report: ImprovementReport,
  reporterName: string | undefined | null,
): LeaderGitAutomationContext {
  const type = IMPROVEMENT_CATEGORY_TO_COMMIT_TYPE[report.category] ?? 'chore';
  const summary = (report.summary || '').trim().slice(0, 64) || 'auto update';
  const nameCandidate = (report.agentName || '').trim()
    || (reporterName || '').trim();
  return {
    type,
    summary,
    agent: nameCandidate || 'unknown',
  };
}

// 리더 큐에 밀어 넣기 전에 한국어 지시문으로 변환한다. dispatchTask 가 이 문자열을
// 그대로 description 으로 소비하고, 리더의 buildLeaderPlanPrompt 가 같은 문장을
// 사용자 커맨드로 읽어 "누가 낸 개선점인지" 맥락을 잃지 않도록 보고자를 첫 줄에
// 박아 둔다.
export function formatImprovementReportForLeader(report: ImprovementReport): string {
  const who = report.agentName
    ? `${report.agentName}${report.role ? `(${report.role})` : ''}`
    : report.agentId;
  const lines: string[] = [];
  lines.push(`[개선 보고] ${who} 가 방금 태스크를 마치고 다음 개선점을 제안했습니다.`);
  lines.push(`· 분류: ${IMPROVEMENT_CATEGORY_LABEL[report.category]}`);
  lines.push(`· 요약: ${report.summary}`);
  if (report.detail) lines.push(`· 세부: ${report.detail}`);
  if (report.focusFiles.length > 0) {
    lines.push(`· 관련 파일: ${report.focusFiles.join(', ')}`);
  }
  lines.push('위 제안을 검토하고 필요하면 적합한 팀원에게 구체 업무로 분배하거나, 지금 분배할 필요가 없다면 mode="reply" 로 사유를 남기세요.');
  return lines.join('\n');
}
