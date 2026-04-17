import React, { useMemo } from 'react';
import { Agent } from '../types';
import { useReducedMotion } from '../utils/useReducedMotion';

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
};

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
}: Props) {
  const reducedMotion = useReducedMotion();
  const relevant = useMemo(
    () => filterLogsForAgent(agent, logs, maxLines),
    [agent, logs, maxLines],
  );
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
          className="text-white/85 line-clamp-2 mb-1"
          title={agent.currentTask}
        >
          ▸ {agent.currentTask}
        </div>
      )}
      <div className="font-mono text-[9px] space-y-0.5">
        {relevant.length === 0 ? (
          <div className="opacity-40 italic">log idle…</div>
        ) : (
          relevant.map(line => (
            <div key={line.id} className="truncate" title={line.text}>
              <span className="opacity-50">[{line.time}]</span>{' '}
              <span className="opacity-70">{line.from}</span>
              {line.to ? <span className="opacity-50"> → {line.to}</span> : null}
              <span className="opacity-90">: {line.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="absolute bottom-[-6px] left-1/2 -translate-x-1/2 border-x-[5px] border-x-transparent border-t-[6px] border-t-black/85" />
    </div>
  );
}
