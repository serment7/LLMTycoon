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
import { GitCommit, FileText, Image as ImageIcon, Film, Download } from 'lucide-react';
import type {
  HandoffStatus,
  LedgerEntry,
  LedgerSummary,
  StatusFilter,
} from '../utils/handoffLedger';
import { buildTimelineRows, collectRoleOptions, summarize } from '../utils/handoffLedger';
import { useReducedMotion } from '../utils/useReducedMotion';
import { EmptyState } from './EmptyState';
import type {
  TaskCommitTimelineEvent,
  CommitStrategy,
  MediaTimelineEvent,
  MediaKind,
} from '../types';
import { COMMIT_STRATEGY_LABEL } from '../types';

type Props = {
  entries: ReadonlyArray<LedgerEntry>;
  /**
   * 태스크 경계 커밋 이벤트(#f1d5ce51). 서버가 자동 커밋을 잘라낼 때마다
   * socket 으로 전달된 페이로드를 상위가 누적해 내려 준다. 본 컴포넌트는 HANDOFF
   * 축과 별개의 "리더 태스크 → 커밋 SHA" 매핑 축을 상단에 렌더한다.
   * 미지정 시에는 이 영역이 아예 렌더되지 않아 기존 화면과 동일하다.
   */
  taskCommits?: ReadonlyArray<TaskCommitTimelineEvent>;
  /** 커밋 이벤트를 클릭했을 때 상위가 PR/커밋 링크로 이동하도록 알림. */
  onTaskCommitSelect?: (event: TaskCommitTimelineEvent) => void;
  /**
   * 멀티미디어 생성 이벤트(#c0ba95a1). Thanos 의 /api/media/generate 경로가 만들어
   * 낸 MediaAsset 을 socket 으로 받아 상위가 누적해 내려 준다. CollabTimeline 은
   * HANDOFF·커밋 축과 별개로 "최근 생성된 매체" 섹션을 렌더하고, 다운로드 버튼만
   * 노출한다 — 재생성 버튼은 DirectivePrompt 영역이 전담한다(축 분리).
   */
  mediaEvents?: ReadonlyArray<MediaTimelineEvent>;
  /** 매체 다운로드 클릭 시 상위가 storageUrl 을 열거나 fetch 를 수행하도록 위임. */
  onMediaDownload?: (event: MediaTimelineEvent) => void;
  /** 행 선택 시 파일 경로를 상위(FileTooltip 등)에 전달. */
  onSelect?: (path: string) => void;
  /** 호버 행과 연결된 에이전트 이름(from/to)을 상위에 알려 `AgentContextBubble` 하이라이트에 사용. */
  onHoverAgent?: (name: string | null) => void;
};

// MediaKind → 시각 스트립 토큰 매핑. --media-asset-*-strip 네 변수만으로 4종 축을 색상
// 으로 구분한다. 컴포넌트 내부에서는 inline style 로만 주입해 tailwind jit 누락을 피한다.
const MEDIA_KIND_STRIP: Record<MediaKind, string> = {
  video: 'var(--media-asset-video-strip)',
  pdf:   'var(--media-asset-pdf-strip)',
  pptx:  'var(--media-asset-pptx-strip)',
  image: 'var(--media-asset-image-strip)',
};

const MEDIA_KIND_SHORT: Record<MediaKind, string> = {
  video: '영상',
  pdf:   'PDF',
  pptx:  'PPT',
  image: '이미지',
};

function MediaKindIcon({ kind, size = 12 }: { kind: MediaKind; size?: number }) {
  if (kind === 'video') return <Film size={size} aria-hidden="true" />;
  if (kind === 'image') return <ImageIcon size={size} aria-hidden="true" />;
  // PDF/PPT 모두 FileText 로 묶되 색 스트립으로 구분한다.
  return <FileText size={size} aria-hidden="true" />;
}

function formatMediaSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// 전략별 배지 톤. Git 자동화의 "위험 누적" 색 계열(초록 안전 → 보라 결합 → 회색 수동)
// 로 단계적으로 상승시켜, 같은 화면의 다른 tone 체계(HANDOFF 상태 색) 와 충돌하지 않게 한다.
const COMMIT_STRATEGY_TONE: Record<CommitStrategy, string> = {
  'per-task': 'border-emerald-400/60 text-emerald-100 bg-emerald-500/10',
  'per-goal': 'border-violet-400/60 text-violet-100 bg-violet-500/10',
  'manual':   'border-white/30 text-white/70 bg-white/5',
};

function shortSha(sha: string): string {
  const clean = (sha || '').trim();
  return clean ? clean.slice(0, 7) : '';
}

function formatTaskCommitLabel(event: TaskCommitTimelineEvent): string {
  const sha = shortSha(event.commitSha);
  const title = event.taskTitle?.trim() || event.taskId;
  const strategy = COMMIT_STRATEGY_LABEL[event.strategy];
  return `${strategy} · ${title} · ${sha}`;
}

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

export function CollabTimeline({
  entries,
  taskCommits,
  onTaskCommitSelect,
  mediaEvents,
  onMediaDownload,
  onSelect,
  onHoverAgent,
}: Props) {
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

      {mediaEvents && mediaEvents.length > 0 && (
        <section
          data-testid="collab-timeline-media"
          aria-label="최근 생성된 매체"
          className="border-b border-[var(--pixel-border)]"
        >
          <div className="px-2 py-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/60">
            <FileText size={11} aria-hidden="true" />
            <span>최근 생성된 매체</span>
            <span className="text-white/40" data-testid="collab-timeline-media-count">
              · {mediaEvents.length}
            </span>
          </div>
          <ul className="divide-y divide-[var(--pixel-border)]/50">
            {mediaEvents.map((event) => {
              const asset = event.mediaAsset;
              const thumb = (asset as unknown as { thumbnails?: string[] }).thumbnails?.[0];
              // BaseTimelineEvent 는 thumbnails 를 Pick 하지 않으므로 MediaAsset 전체에서
              // 가져오지 못한다. 서버가 첫 썸네일을 summary 옆에 같이 내려 주면 그 시점
              // 에 본 블록을 MediaAsset 전체 소비로 확장한다(현재는 placeholder 만).
              const kindLabel = MEDIA_KIND_SHORT[asset.kind];
              const downloadable = !!onMediaDownload;
              const adapter = asset.generatedBy?.adapter?.trim();
              return (
                <li
                  key={event.id}
                  data-testid={`collab-timeline-media-${asset.id}`}
                  data-media-kind={asset.kind}
                  className="px-2 py-1 flex items-center gap-2"
                  style={{
                    borderLeft: `2px solid ${MEDIA_KIND_STRIP[asset.kind]}`,
                    background: 'var(--media-asset-surface-bg)',
                  }}
                >
                  <div
                    data-testid={`collab-timeline-media-thumb-${asset.id}`}
                    className="w-8 h-8 shrink-0 flex items-center justify-center"
                    style={{
                      background: 'var(--media-asset-thumb-bg)',
                      border: `1px solid var(--media-asset-thumb-border)`,
                      color: MEDIA_KIND_STRIP[asset.kind],
                      overflow: 'hidden',
                    }}
                    aria-hidden="true"
                  >
                    {thumb
                      ? <img src={thumb} alt="" className="w-full h-full object-cover" />
                      : <MediaKindIcon kind={asset.kind} size={14} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className="truncate text-[11px]"
                      style={{ color: 'var(--media-asset-name-fg)' }}
                      title={asset.name}
                      data-testid={`collab-timeline-media-name-${asset.id}`}
                    >
                      <span
                        className="uppercase tracking-wider text-[9px] px-1 mr-1 border border-white/20"
                        data-testid={`collab-timeline-media-kind-${asset.id}`}
                      >
                        {kindLabel}
                      </span>
                      {asset.name}
                    </div>
                    <div
                      className="text-[10px] flex items-center gap-2"
                      style={{ color: 'var(--media-asset-meta-fg)' }}
                    >
                      <span data-testid={`collab-timeline-media-size-${asset.id}`}>
                        {formatMediaSize(asset.sizeBytes)}
                      </span>
                      {adapter ? (
                        <span title={`어댑터: ${adapter}`} data-testid={`collab-timeline-media-adapter-${asset.id}`}>
                          · {adapter}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {downloadable ? (
                    <button
                      type="button"
                      onClick={() => onMediaDownload?.(event)}
                      data-testid={`collab-timeline-media-download-${asset.id}`}
                      aria-label={`${asset.name} 다운로드`}
                      className="text-[10px] px-2 py-0.5 inline-flex items-center gap-1"
                      style={{
                        color: 'var(--media-asset-download-fg)',
                        border: `1px solid var(--media-asset-download-border)`,
                        background: 'transparent',
                      }}
                    >
                      <Download size={10} aria-hidden="true" />
                      다운로드
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {taskCommits && taskCommits.length > 0 && (
        <section
          data-testid="collab-timeline-task-commits"
          aria-label="태스크 경계 커밋"
          className="border-b border-[var(--pixel-border)]"
        >
          <div className="px-2 py-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/60">
            <GitCommit size={11} aria-hidden="true" />
            <span>태스크 경계 커밋</span>
            <span className="text-white/40" data-testid="collab-timeline-task-commit-count">
              · {taskCommits.length}
            </span>
          </div>
          <ul className="divide-y divide-[var(--pixel-border)]/50">
            {taskCommits.map((event) => {
              const sha = shortSha(event.commitSha);
              const tone = COMMIT_STRATEGY_TONE[event.strategy];
              const clickable = !!onTaskCommitSelect;
              const label = formatTaskCommitLabel(event);
              return (
                <li
                  key={event.id}
                  data-testid={`collab-timeline-task-commit-${event.id}`}
                  data-commit-strategy={event.strategy}
                  data-commit-sha={sha}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={label}
                  onClick={clickable ? () => onTaskCommitSelect?.(event) : undefined}
                  onKeyDown={clickable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onTaskCommitSelect?.(event);
                        }
                      }
                    : undefined}
                  className={`px-2 py-1 border-l-2 ${tone} ${clickable ? 'cursor-pointer focus-visible:ring-1 focus-visible:ring-white/60 outline-none' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="uppercase tracking-wider text-[9px] px-1 border border-white/30"
                        aria-hidden="true"
                        data-testid={`task-commit-strategy-${event.id}`}
                      >
                        {COMMIT_STRATEGY_LABEL[event.strategy]}
                      </span>
                      <span className="truncate" title={event.taskTitle || event.taskId}>
                        {event.taskTitle || event.taskId}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-[10px] text-white/60">
                      {event.branch ? (
                        <span
                          className="truncate max-w-[120px]"
                          title={event.branch}
                          data-testid={`task-commit-branch-${event.id}`}
                        >
                          {event.branch}
                        </span>
                      ) : null}
                      <span
                        className="font-mono px-1 border border-white/20 bg-black/30"
                        data-testid={`task-commit-sha-${event.id}`}
                      >
                        {sha || '-------'}
                      </span>
                    </span>
                  </div>
                  {event.prUrl ? (
                    <div className="pl-3 text-[10px] text-white/50 truncate" title={event.prUrl}>
                      ↳ PR {event.prUrl}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <ul className="divide-y divide-[var(--pixel-border)]">
        {rows.length === 0 ? (
          <li className="px-2 py-3" data-testid="collab-timeline-empty-wrap">
            <EmptyState
              variant="empty"
              title="표시할 협업 항목이 없습니다"
              description="필터 조건을 바꾸거나 새로운 HANDOFF/REPORT 가 쌓이면 이 자리에 나타납니다."
              fillMinHeight={false}
              testId="collab-timeline-empty"
            />
          </li>
        ) : (
          rows.map((row) => {
            const tone = STATUS_TONE[row.status];
            const glyph = STATUS_GLYPH[row.status];
            const isBlocked = row.status === 'blocked';
            // 스크린리더가 행의 역할(버튼) 과 함께 "누가 누구에게, 무엇을, 어떤 상태" 를
            // 한 문장으로 낭독할 수 있도록 aria-label 을 구성한다. 글리프(● ◔ ○ ⊘)·색으로
            // 만 전달되던 상태를 텍스트로도 병기해, 색각 이상 + 스크린리더 사용자 모두
            // 동일한 정보량에 도달한다.
            const ariaLabel = [
              `${row.from} → ${row.to}`,
              row.slug || '제목 없음',
              STATUS_LABEL[row.status],
              row.statusFallback ? '알 수 없는 status' : null,
              row.orphan ? '원본 지시 유실' : null,
            ].filter(Boolean).join(' · ');
            return (
              <li
                key={row.id}
                role="button"
                tabIndex={0}
                aria-label={ariaLabel}
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
