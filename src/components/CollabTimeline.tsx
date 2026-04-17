/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 팀 축 협업 타임라인. docs/handoffs · docs/reports의 frontmatter를
 * `handoffLedger` 파서가 변환한 LedgerEntry[]만 받아 렌더하는 pure presentational.
 *
 * 감마 QA 6.1 차단 이슈 대응: AgentStatusPanel/AgentContextBubble의 글리프
 * 집합과 겹치지 않는 전용 글리프(done=●, blocked=⊘)를 사용한다.
 */

import { useMemo, useState } from 'react';
import type {
  HandoffStatus,
  LedgerEntry,
  LedgerSummary,
  StatusFilter,
} from '../utils/handoffLedger';
import { buildTimelineRows, collectRoleOptions, summarize } from '../utils/handoffLedger';
import { useReducedMotion } from '../utils/useReducedMotion';

type Props = {
  entries: ReadonlyArray<LedgerEntry>;
  /** 행 선택 시 파일 경로를 상위(FileTooltip 등)에 전달. */
  onSelect?: (path: string) => void;
  /** 호버 행과 연결된 에이전트 이름(from/to)을 상위에 알려 `AgentContextBubble` 하이라이트에 사용. */
  onHoverAgent?: (name: string | null) => void;
};

// 감마 지적에 따라 AgentStatusPanel의 thinking(◉)·meeting(◆)과 충돌하지 않도록
// 전용 모양을 사용. 색약/reduced-motion 사용자도 형태만으로 식별 가능해야 한다.
const STATUS_GLYPH: Record<HandoffStatus, string> = {
  open: '○',
  wip: '◔',
  done: '●',
  blocked: '⊘',
};

const STATUS_TONE: Record<HandoffStatus, string> = {
  open: 'border-white/25 text-white/60 bg-black/25',
  wip: 'border-yellow-300/40 text-yellow-200/80 bg-yellow-500/5',
  done: 'border-green-400/40 text-green-200/80 bg-green-500/5',
  blocked: 'border-red-500/60 text-red-100/90 bg-red-600/10',
};

const STATUS_LABEL: Record<HandoffStatus, string> = {
  open: 'open',
  wip: 'wip',
  done: 'done',
  blocked: 'blocked',
};

const FILTER_CHIPS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'open', label: 'open' },
  { value: 'wip', label: 'wip' },
  { value: 'done', label: 'done' },
  { value: 'blocked', label: 'blocked' },
];

function formatTime(opened: string): string {
  return opened || '--';
}

export function CollabTimeline({ entries, onSelect, onHoverAgent }: Props) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const reducedMotion = useReducedMotion();

  const summary: LedgerSummary = useMemo(() => summarize(entries), [entries]);

  // 필터: handoff만 나열하고 대응 report는 각 행의 status에 반영. 양쪽을 따로
  // 렌더하면 "대기열 부풀림"이 생겨 §6.1의 정보 피로를 악화시킨다.
  // 병합·필터·정렬 로직은 `handoffLedger.buildTimelineRows` 에 추출되어 단위 테스트 대상.
  const rows = useMemo(
    () => buildTimelineRows(entries, { status: statusFilter, role: roleFilter }),
    [entries, statusFilter, roleFilter],
  );

  const roleOptions = useMemo(() => collectRoleOptions(entries), [entries]);

  return (
    <section
      className="border border-[var(--pixel-border)] bg-black/30 text-white/80 text-[11px] font-mono"
      aria-label="협업 타임라인"
    >
      <header
        className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[var(--pixel-border)]"
        aria-label="협업 상태 요약"
      >
        <span className="text-white/80">협업 타임라인</span>
        <span className="text-white/60">
          open {summary.open} · wip {summary.wip} · done {summary.done}
          {summary.blocked > 0 ? ` · blocked ${summary.blocked}` : ''}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-[var(--pixel-border)]">
        {FILTER_CHIPS.map((chip) => {
          const active = statusFilter === chip.value;
          return (
            <button
              key={chip.value}
              type="button"
              onClick={() => setStatusFilter(chip.value)}
              className={`px-2 py-0.5 border ${
                active
                  ? 'border-white/70 text-white bg-white/10'
                  : 'border-white/20 text-white/60 hover:text-white/80'
              }`}
              aria-pressed={active}
            >
              {chip.label}
            </button>
          );
        })}
        <span className="mx-1 text-white/30">|</span>
        <label className="flex items-center gap-1 text-white/60">
          역할
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="bg-black/50 border border-white/20 text-white/80 px-1 py-0.5"
            aria-label="역할 필터"
          >
            <option value="all">전체</option>
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ul className="divide-y divide-[var(--pixel-border)]">
        {rows.length === 0 ? (
          <li className="px-2 py-3 text-white/40">표시할 협업 항목이 없습니다.</li>
        ) : (
          rows.map((row) => {
            const tone = STATUS_TONE[row.status];
            const glyph = STATUS_GLYPH[row.status];
            const isBlocked = row.status === 'blocked';
            return (
              <li
                key={row.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect?.(row.path)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(row.path);
                  }
                }}
                onMouseEnter={() => onHoverAgent?.(row.to)}
                onMouseLeave={() => onHoverAgent?.(null)}
                className={`px-2 py-1 cursor-pointer outline-none border-l-2 ${tone} ${
                  isBlocked && !reducedMotion ? 'animate-pulse' : ''
                } focus-visible:ring-1 focus-visible:ring-white/60`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-white/70">
                    <span aria-hidden="true">● </span>
                    {formatTime(row.opened)} · {row.from} → {row.to}
                  </span>
                  <span className="flex items-center gap-2 text-white/50 uppercase tracking-wider text-[10px]">
                    <span>
                      <span aria-hidden="true">{glyph}</span> {STATUS_LABEL[row.status]}
                      {row.statusFallback ? (
                        <span
                          title="알 수 없는 status 값 — open으로 폴백"
                          className="ml-1 text-yellow-300/80"
                        >
                          !?
                        </span>
                      ) : null}
                    </span>
                    {row.orphan ? (
                      <span
                        aria-label="원본 지시 유실 경고"
                        title="linked_directive 필드 없음 — v2 이전 생성분일 수 있음"
                        className="border border-yellow-300/40 text-yellow-200/80 bg-yellow-500/5 text-[9px] uppercase tracking-wider px-1"
                      >
                        <span aria-hidden="true">⚑</span> 원본 유실
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="pl-3 text-white/80 truncate" title={row.slug}>
                  ▸ {row.slug || '(제목 없음)'}
                </div>
                {row.report ? (
                  <div className="pl-3 text-white/50">↳ REPORT {row.report.slug}</div>
                ) : null}
              </li>
            );
          })
        )}
      </ul>
    </section>
  );
}

export default CollabTimeline;
