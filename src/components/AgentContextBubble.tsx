import React, { useMemo } from 'react';
import { Agent, type GitAutomationLogEntry } from '../types';
import { useReducedMotion } from '../utils/useReducedMotion';
import {
  classifyLeaderMessage,
  summarizeLeaderMessage,
  LEADER_ANSWER_ONLY_LABEL,
  LEADER_ANSWER_ONLY_TOOLTIP,
  type LeaderMessageKind,
} from '../utils/leaderMessage';
import {
  GitAutomationStageBadge,
  deriveBadgeStateFromLog,
  pickLatestByStage,
} from './GitAutomationStageBadge';
import { resolveLogEntryMessage } from '../utils/gitAutomationI18n';
import { useI18n } from '../i18n';

export type AgentLogLine = {
  id: string;
  from: string;
  to?: string;
  text: string;
  time: string;
};

type Props = {
  agent: Agent;
  logs: AgentLogLine[];
  workingFileName?: string;
  translateStatus: (status: string) => string;
  maxLines?: number;
  /** CollabTimeline 행 호버 시 해당 에이전트를 하이라이트한다. */
  highlighted?: boolean;
  /**
   * Git 자동화 파이프라인 최근 로그. 존재하면 컨텍스트 버블 하단에 커밋·푸시·PR
   * 3단계의 현재 상태 뱃지(대기/실행중/성공/실패)를 한 줄로 렌더한다. 빈 배열이나
   * undefined 면 스트립은 아예 출력되지 않는다 — 버블 영역 높이를 보존하기 위함.
   */
  gitAutomation?: ReadonlyArray<GitAutomationLogEntry>;
};

const GIT_AUTOMATION_STRIP_STAGES = ['commit', 'push', 'pr'] as const;

const STATUS_GLYPH: Record<Agent['status'], string> = {
  idle: '○',
  working: '▶',
  meeting: '◆',
  thinking: '◉',
};

const STATUS_TONE: Record<Agent['status'], string> = {
  idle: 'text-white/50',
  working: 'text-green-300',
  meeting: 'text-yellow-300',
  thinking: 'text-blue-300',
};

// 펄스 적용 대상 상태. idle 은 정적으로 두고 활성 3종만 깜빡인다.
const PULSING_STATUSES: ReadonlySet<Agent['status']> = new Set<Agent['status']>([
  'working',
  'meeting',
  'thinking',
]);

// 리더 메시지 종류별 라인 앞 글리프.
//   → : 분배 (화살표 — "여러 팀원에게 뻗어나간다")
//   ❝ : 답변 (말풍선 — "질문에만 응답" )
//   · : 일반/자유 텍스트 (중립)
// CSS 에도 data-leader-kind 별 팔레트가 정의되어 있어 색상으로 한 번 더 분리된다.
const LEADER_KIND_ICON: Record<LeaderMessageKind, string> = {
  delegate: '→',
  reply: '❝',
  plain: '·',
};

export function getLeaderMessageIcon(kind: LeaderMessageKind): string {
  return LEADER_KIND_ICON[kind];
}

// 현재 에이전트와 관련된 로그만 추려서 입력 순서를 그대로 유지해 반환한다.
// - 호출부(App.tsx addLog)가 newest-first 로 쌓기 때문에 결과도 newest-first.
// - maxLines 로 잘라 UI 높이를 고정, 렌더 부담과 시선 점유를 억제한다.
// - maxLines 가 0 이하이면 빈 배열을 즉시 반환해 불필요한 순회를 막는다.
export function filterLogsForAgent(
  agent: Agent,
  logs: AgentLogLine[],
  maxLines: number,
): AgentLogLine[] {
  if (maxLines <= 0) return [];
  const out: AgentLogLine[] = [];
  for (const log of logs) {
    if (log.from === agent.name || log.to === agent.name) {
      out.push(log);
      if (out.length >= maxLines) break;
    }
  }
  return out;
}

// 에이전트 머리 위에 항상 떠 있는 verbose 컨텍스트 창.
// - 상태/작업 파일/최근 로그 라인을 한 곳에 모아 "지금 뭘 하고 있나?" 질문에
//   대화 버블(일시적 메시지)보다 오래 살아있는 채널로 답한다.
// - 말풍선과 달리 상시 노출되므로 색상/글리프로 상태를 이중 시그널링 해 색약 대응.
export function AgentContextBubble({
  agent,
  logs,
  workingFileName,
  translateStatus,
  maxLines = 3,
  highlighted = false,
  gitAutomation,
}: Props) {
  const reducedMotion = useReducedMotion();
  // 지시 #a933c3c9 — 백엔드가 채운 errorKey 를 현재 locale 로 풀어 노출.
  const { t } = useI18n();
  const relevant = useMemo(
    () => filterLogsForAgent(agent, logs, maxLines),
    [agent, logs, maxLines],
  );
  // 단계별 최신 1건씩만 뽑아 3개의 뱃지를 렌더한다. 배열 전체를 훑지 않도록
  // pickLatestByStage 결과를 기억해 두되, 엔트리 배열이 바뀌지 않으면 재계산도
  // 피한다. 입력이 없거나 빈 배열이면 전체 스트립을 끈다(hasAny=false).
  const latestByStage = useMemo(
    () => (gitAutomation && gitAutomation.length > 0 ? pickLatestByStage(gitAutomation) : null),
    [gitAutomation],
  );
  const hasAnyGitAutomation = Boolean(latestByStage) && GIT_AUTOMATION_STRIP_STAGES.some(
    key => latestByStage?.[key] !== undefined,
  );
  // 디자이너: 머리 위 버블은 공간이 작아 단계 뱃지만 보고 "실패인지"를 놓치기 쉽다.
  // 첫 실패 단계를 뽑아 경고 한 줄을 단계 스트립 위에 가로로 띄워, 초점 이동 없이
  // "지금 실패했다" 를 알린다. 성공/대기 상태에서는 아예 렌더하지 않는다.
  const firstFailedStripKey = GIT_AUTOMATION_STRIP_STAGES.find(
    key => latestByStage?.[key]?.outcome === 'failed',
  );
  const firstFailedStripEntry = firstFailedStripKey ? latestByStage?.[firstFailedStripKey] : null;
  const failedStageLabelKr: Record<(typeof GIT_AUTOMATION_STRIP_STAGES)[number], string> = {
    commit: '커밋',
    push: '푸시',
    pr: 'PR',
  };
  const statusLabel = translateStatus(agent.status);
  const glyph = STATUS_GLYPH[agent.status] ?? STATUS_GLYPH.idle;
  const baseTone = STATUS_TONE[agent.status] ?? STATUS_TONE.idle;
  const tone = !reducedMotion && PULSING_STATUSES.has(agent.status)
    ? `${baseTone} animate-pulse`
    : baseTone;

  return (
    <div
      className={`absolute bottom-[68px] left-1/2 -translate-x-1/2 w-[200px] bg-black/85 border-2 text-white text-[9px] leading-tight px-2 py-1.5 z-40 pointer-events-none transition-shadow ${
        highlighted
          ? 'border-[var(--pixel-accent)] shadow-[0_0_0_2px_var(--pixel-accent)]'
          : 'border-[var(--pixel-border)]'
      }`}
      role="status"
      aria-live="polite"
      aria-label={`${agent.name} 컨텍스트 로그`}
    >
      <div className="flex items-center justify-between gap-1 mb-1">
        <span className={`uppercase tracking-wider font-bold ${tone}`}>
          <span aria-hidden className="mr-1">{glyph}</span>
          {statusLabel}
        </span>
        {/*
          '답변 전용' 배지는 lastMessage TTL 과 독립적으로 lastLeaderMessageKind
          기반으로 판단한다. 말풍선이 사라진 뒤에도 리더의 최근 응답이 단순 답변이었음을
          머리 위 컨텍스트 버블에서 계속 드러내, 팀원 호출 여부를 한 눈에 알려 준다.
          리더 역할일 때만 노출해 비리더 에이전트에 오인된 배지가 붙지 않게 한다.
        */}
        {agent.role === 'Leader' && agent.lastLeaderMessageKind === 'reply' && (
          <span
            className="text-[8px] uppercase tracking-wider text-cyan-200 border border-cyan-300/50 bg-cyan-400/15 px-1 py-[1px] shrink-0"
            data-leader-kind="reply"
            title={LEADER_ANSWER_ONLY_TOOLTIP}
          >
            {LEADER_ANSWER_ONLY_LABEL}
          </span>
        )}
        {workingFileName && (
          <span
            className="truncate text-[var(--pixel-accent)] max-w-[110px]"
            title={workingFileName}
          >
            {workingFileName}
          </span>
        )}
      </div>
      {agent.currentTask && (
        <div
          className="kr-msg text-white/85 line-clamp-2 mb-1"
          title={agent.currentTask}
        >
          ▸ {agent.currentTask}
        </div>
      )}
      <div className="font-mono text-[9px] space-y-0.5">
        {relevant.length === 0 ? (
          // EmptyProjectPlaceholder 톤과 맞춘 빈 상태 일러스트. 픽셀 accent 컬러 + 연한
          // 시안 배경 + 부드러운 펄스를 공유해, 사용자가 서로 다른 패널에서도 같은 "대기"
          // 의미를 즉시 인지하도록 한다.
          <div className="context-bubble-empty" role="note" aria-label="로그 대기 중">
            <span className="context-bubble-empty__icon" aria-hidden>
              ◇
            </span>
            <span className="context-bubble-empty__label">로그 대기</span>
          </div>
        ) : (
          relevant.map(line => {
            // 리더 분배 JSON 은 한 줄 로그에서 코드 덩어리로 보이므로 summarize 로 줄여 노출.
            // 정상 텍스트는 summarize 가 그대로 돌려준다(원문 폴백).
            const display = summarizeLeaderMessage(line.text);
            const kind: LeaderMessageKind = classifyLeaderMessage(line.text);
            return (
              <div
                key={line.id}
                className={`leader-msg leader-msg--${kind} truncate`}
                data-leader-kind={kind}
                title={display}
              >
                <span className="leader-msg__icon" aria-hidden>
                  {getLeaderMessageIcon(kind)}
                </span>
                <span className="opacity-50">[{line.time}]</span>{' '}
                <span className="opacity-70">{line.from}</span>
                {line.to ? <span className="opacity-50"> → {line.to}</span> : null}
                <span className="kr-msg opacity-90">: {display}</span>
              </div>
            );
          })
        )}
      </div>
      {firstFailedStripKey && firstFailedStripEntry && (
        <div
          className="git-auto-alert git-auto-alert--inline"
          role="alert"
          data-tone="failure"
          aria-label={`Git 자동화 ${failedStageLabelKr[firstFailedStripKey]} 단계 실패`}
          title={resolveLogEntryMessage(firstFailedStripEntry, t) || '자세한 내용은 패널에서 확인하세요'}
        >
          <span className="git-auto-alert__icon" aria-hidden>✕</span>
          <span className="git-auto-alert__title">
            {failedStageLabelKr[firstFailedStripKey]} 실패 — 커밋 미완료
          </span>
        </div>
      )}
      {hasAnyGitAutomation && latestByStage && (
        <div
          className="git-auto-bubble-strip"
          role="group"
          aria-label="Git 자동화 단계 상태 요약"
        >
          {/* 3단계를 명시적으로 나열한다. 배열 map + key 패턴은 이 프로젝트의
              TypeScript 설정에서 Props 외의 key 를 거부해 타입 에러가 나기
              때문에, 형제 배치를 직접 쓰는 편이 읽기도 좋고 TS-safe 하다. */}
          <GitAutomationStageBadge
            stage="commit"
            state={deriveBadgeStateFromLog(latestByStage.commit)}
            recent={latestByStage.commit}
            errorMessage={latestByStage.commit?.outcome === 'failed' ? latestByStage.commit?.errorMessage : undefined}
            compact
          />
          <GitAutomationStageBadge
            stage="push"
            state={deriveBadgeStateFromLog(latestByStage.push)}
            recent={latestByStage.push}
            errorMessage={latestByStage.push?.outcome === 'failed' ? latestByStage.push?.errorMessage : undefined}
            compact
          />
          <GitAutomationStageBadge
            stage="pr"
            state={deriveBadgeStateFromLog(latestByStage.pr)}
            recent={latestByStage.pr}
            errorMessage={latestByStage.pr?.outcome === 'failed' ? latestByStage.pr?.errorMessage : undefined}
            compact
          />
        </div>
      )}
      <div className="absolute bottom-[-6px] left-1/2 -translate-x-1/2 border-x-[5px] border-x-transparent border-t-[6px] border-t-black/85" />
    </div>
  );
}
