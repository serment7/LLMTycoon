import React, { useMemo } from 'react';
import { Agent, CodeFile } from '../types';
import {
  summarize,
  computeActiveRatio,
  computeContentionCounts,
  computeCollaborationEdges,
  computeIsolatedAgentIds,
  isActiveAgent,
  PipelineBadge,
  getPipelineRoleLabel,
} from './AgentStatusPanel';
import {
  summarizePipelineRoles,
  type PipelineRole,
} from '../utils/workspaceInsights';
import { useReducedMotion } from '../utils/useReducedMotion';
import {
  classifyLeaderMessage,
  LEADER_MESSAGE_KIND_LABEL,
  LEADER_MESSAGE_KIND_TOOLTIP,
} from '../utils/leaderMessage';
import { getLeaderMessageIcon } from './AgentContextBubble';

type Props = {
  agents: Agent[];
  files: CodeFile[];
  translateStatus: (status: string) => string;
  lastSyncedAt?: number;
  now?: number;
};

// 사용자가 잠시 자리를 비웠다가 다시 돌아왔을 때 첫 1초 안에
// "지금 팀이 무엇을 하고 있는지"를 파악할 수 있도록 설계된 스냅샷 패널.
// 핵심 숫자(활성 인원·진행 중인 파일 수·충돌 여부·마지막 갱신 시각)만
// 상단에 고정 노출해, 상세 리스트를 스크롤하지 않고도 위험 신호를 감지한다.
export function AgentStatusSnapshot({
  agents,
  files,
  translateStatus,
  lastSyncedAt,
  now = Date.now(),
}: Props) {
  // FreshnessDot · 위험 Pill 펄스를 prefers-reduced-motion 사용자에게 차단한다.
  const reducedMotion = useReducedMotion();
  const counts = useMemo(() => summarize(agents), [agents]);
  const activePct = useMemo(
    () => Math.round(computeActiveRatio(agents) * 100),
    [agents],
  );
  const contentionCounts = useMemo(() => computeContentionCounts(agents), [agents]);
  const contentionFiles = contentionCounts.size;

  const agentIdSet = useMemo(() => new Set(agents.map(a => a.id)), [agents]);
  const edges = useMemo(
    () => computeCollaborationEdges(agents, agentIdSet),
    [agents, agentIdSet],
  );
  const isolatedIds = useMemo(
    () => computeIsolatedAgentIds(agents, edges),
    [agents, edges],
  );

  const activeFileNames = useMemo(
    () => computeActiveFileNames(agents, files),
    [agents, files],
  );

  const pipelineRoles = useMemo(() => summarizePipelineRoles(agents), [agents]);
  // 리더 에이전트의 최근 메시지를 "분배 vs 답변" 두 축으로 집계한다.
  // 스냅샷 한 줄에서 "리더가 지시를 팀 전체로 흘려보냈는지" 와 "단답으로만 끝냈는지" 를
  // 즉시 구분할 수 있도록, AgentContextBubble·AgentStatusPanel 과 같은 팔레트/아이콘을 공유한다.
  const leaderMessageMix = useMemo(() => {
    let delegate = 0;
    let reply = 0;
    for (const agent of agents) {
      if (agent.role !== 'Leader' || !agent.lastMessage) continue;
      const kind = classifyLeaderMessage(agent.lastMessage);
      if (kind === 'delegate') delegate += 1;
      else if (kind === 'reply') reply += 1;
    }
    return { delegate, reply };
  }, [agents]);

  const freshness = formatFreshness(lastSyncedAt, now);
  const workloadConcentration = useMemo(() => computeWorkloadConcentration(agents), [agents]);
  const risk = useMemo(
    () => assessRisk({
      contentionFiles,
      isolated: isolatedIds.size,
      total: agents.length,
      staleSec: computeStaleSec(lastSyncedAt, now),
      workloadConcentration,
    }),
    [contentionFiles, isolatedIds.size, agents.length, lastSyncedAt, now, workloadConcentration],
  );

  return (
    <section
      className="border-2 border-[var(--pixel-border)] bg-black/40 p-2 space-y-1"
      role="status"
      aria-live="polite"
      aria-label={`팀 스냅샷 — 품질 신호 ${risk.label}. ${risk.reason}`}
      data-risk={risk.level}
      data-stale-since={lastSyncedAt ?? ''}
    >
      <header className="flex items-center justify-between text-[10px] uppercase tracking-wider text-white/70">
        <span className="kr-label flex items-center gap-1">
          <FreshnessDot lastSyncedAt={lastSyncedAt} now={now} reducedMotion={reducedMotion} />
          팀 스냅샷
        </span>
        <span className="kr-label" title="마지막 서버 동기화 이후 경과 시간">{freshness}</span>
      </header>
      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <Pill
          label="품질"
          value={risk.label}
          tone={risk.tone}
          title={risk.reason}
          emphasized
          reducedMotion={reducedMotion}
        />
        <Pill label="활성" value={`${activePct}%`} tone={activePct > 0 ? 'ok' : 'muted'} reducedMotion={reducedMotion} />
        <Pill
          label={translateStatus('working')}
          value={`${counts.working}`}
          tone={counts.working > 0 ? 'ok' : 'muted'}
          reducedMotion={reducedMotion}
        />
        <Pill
          label={translateStatus('meeting')}
          value={`${counts.meeting}`}
          tone={counts.meeting > 0 ? 'warn' : 'muted'}
          reducedMotion={reducedMotion}
        />
        <Pill
          label={translateStatus('thinking')}
          value={`${counts.thinking}`}
          tone={counts.thinking > 0 ? 'info' : 'muted'}
          reducedMotion={reducedMotion}
        />
        <Pill
          label="충돌 파일"
          value={`${contentionFiles}`}
          tone={contentionFiles > 0 ? 'alert' : 'muted'}
          reducedMotion={reducedMotion}
        />
        <Pill
          label="고립"
          value={`${isolatedIds.size}/${agents.length}`}
          tone={isolatedIds.size > 0 ? 'warn' : 'muted'}
          reducedMotion={reducedMotion}
        />
      </div>
      {activeFileNames.length > 0 && (
        <div
          className="kr-msg text-[10px] text-white/80 truncate"
          title={activeFileNames.join(', ')}
        >
          진행 중: {activeFileNames.slice(0, 3).join(', ')}
          {activeFileNames.length > 3 ? ` 외 ${activeFileNames.length - 3}` : ''}
        </div>
      )}
      {agents.length > 0 && (
        <PipelineRoleChips breakdown={pipelineRoles} />
      )}
      {(leaderMessageMix.delegate > 0 || leaderMessageMix.reply > 0) && (
        <div
          className="leader-msg-mix"
          role="group"
          aria-label={`리더 최근 메시지 — ${LEADER_MESSAGE_KIND_LABEL.delegate} ${leaderMessageMix.delegate}건, ${LEADER_MESSAGE_KIND_LABEL.reply} ${leaderMessageMix.reply}건`}
        >
          <span className="leader-msg-mix__label">리더 메시지</span>
          {/* 라벨/툴팁은 leaderMessage.ts 의 단일 출처를 재사용해 다른 패널과 표기를
              일치시킨다. 이 곳의 title 을 직접 수정하면 패널 간 어휘 드리프트가
              재발하므로, 문구 변경은 LEADER_MESSAGE_KIND_TOOLTIP 에서만 하라. */}
          <span
            className="leader-msg leader-msg--delegate leader-msg-mix__chip"
            data-leader-kind="delegate"
            title={LEADER_MESSAGE_KIND_TOOLTIP.delegate}
          >
            <span className="leader-msg__icon" aria-hidden>
              {getLeaderMessageIcon('delegate')}
            </span>
            {LEADER_MESSAGE_KIND_LABEL.delegate} {leaderMessageMix.delegate}
          </span>
          <span
            className="leader-msg leader-msg--reply leader-msg-mix__chip"
            data-leader-kind="reply"
            title={LEADER_MESSAGE_KIND_TOOLTIP.reply}
          >
            <span className="leader-msg__icon" aria-hidden>
              {getLeaderMessageIcon('reply')}
            </span>
            {LEADER_MESSAGE_KIND_LABEL.reply} {leaderMessageMix.reply}
          </span>
        </div>
      )}
      <ConcentrationBar ratio={workloadConcentration} reducedMotion={reducedMotion} />
    </section>
  );
}

// 활성 인력의 파일 쏠림 정도를 얇은 수평 바로 시각화.
// 경보 임계치를 넘기면 색이 승급해 리뷰 병목을 눈으로 먼저 감지하게 한다.
// 쏠림이 0이면 바 자체를 감춰 빈 공간으로 시선을 빼앗지 않는다.
// 0.95 이상(= 사실상 모든 활성 인력이 한 파일에 붙은 상태)에서는 'alert' 로 승급
// 하여 Pill(품질) 계열과 같은 red-400 톤 + 펄스를 보여 주어, 실질적인 머지 충돌
// 직전 상황임을 도트/펄스/Bar 삼중으로 겹쳐 알린다. reducedMotion 가드는 바깥에서
// 주입해, prefers-reduced-motion 사용자에게는 펄스 없이 색만 유지한다.
function ConcentrationBar({ ratio, reducedMotion = false }: { ratio: number; reducedMotion?: boolean }) {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const tone: PillTone =
    ratio >= RISK_CONCENTRATION_ALERT_THRESHOLD
      ? 'alert'
      : ratio >= RISK_CONCENTRATION_WARN_THRESHOLD
      ? 'warn'
      : ratio >= 0.5
      ? 'info'
      : 'muted';
  const fillClass = CONCENTRATION_FILL[tone];
  const pulse = !reducedMotion && tone === 'alert' ? ' animate-pulse' : '';
  return (
    <div
      className="h-1 w-full bg-white/10"
      role="progressbar"
      aria-label="업무 쏠림"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      data-tone={tone}
      title={`업무 쏠림 ${pct}%`}
    >
      <div className={`h-full ${fillClass}${pulse}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

const CONCENTRATION_FILL: Record<PillTone, string> = {
  ok: 'bg-green-400/70',
  warn: 'bg-yellow-400/80',
  alert: 'bg-red-400/80',
  info: 'bg-blue-400/70',
  muted: 'bg-white/30',
};

// 헤더 옆의 상태 점. 동기화 신선도를 한 픽셀 크기로 즉시 전달한다.
// 긴 텍스트 없이도 "연결이 살아있는가?"를 주변 시야로 인지할 수 있게 한다.
// reducedMotion 신호 시 alert 단계의 펄스를 정적으로 대체해 멀미를 방지한다.
function FreshnessDot({
  lastSyncedAt,
  now,
  reducedMotion,
}: {
  lastSyncedAt?: number;
  now: number;
  reducedMotion: boolean;
}) {
  const staleSec = computeStaleSec(lastSyncedAt, now);
  let cls = 'bg-white/30';
  if (staleSec === Infinity) cls = 'bg-white/20';
  else if (staleSec >= RISK_STALE_ALERT_SEC) cls = reducedMotion ? 'bg-red-400' : 'bg-red-400 animate-pulse';
  else if (staleSec >= RISK_STALE_WARN_SEC) cls = 'bg-yellow-400';
  else cls = 'bg-green-400';
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />;
}

type PillTone = 'ok' | 'warn' | 'alert' | 'info' | 'muted';

// alert 톤은 prefers-reduced-motion 사용자에게 펄스 없이 색만 강조한다.
// 정적 lookup 에서 animate-pulse 를 빼고, Pill 렌더 시 reducedMotion 가드와 조합해 부착한다.
const TONE_CLASS: Record<PillTone, string> = {
  ok: 'border-green-400/60 text-green-200',
  warn: 'border-yellow-400/60 text-yellow-200',
  alert: 'border-red-400/70 text-red-200',
  info: 'border-blue-400/60 text-blue-200',
  muted: 'border-white/15 text-white/50',
};

const PULSING_TONES: ReadonlySet<PillTone> = new Set<PillTone>(['alert']);

function Pill({
  label,
  value,
  tone,
  title,
  emphasized,
  reducedMotion = false,
}: {
  label: string;
  value: string;
  tone: PillTone;
  title?: string;
  // 가장 중요한 품질 신호를 다른 카운터 배지와 시각적으로 분리하기 위해
  // 테두리 두께와 배경 강조를 승급한다.
  emphasized?: boolean;
  // prefers-reduced-motion 사용자에게는 alert 톤 펄스를 끈다.
  reducedMotion?: boolean;
}) {
  const emphasis = emphasized ? 'border-2 bg-white/5 shadow-[0_0_0_1px_rgba(255,255,255,0.05)]' : '';
  const pulse = !reducedMotion && PULSING_TONES.has(tone) ? ' animate-pulse' : '';
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 uppercase tracking-wider ${TONE_CLASS[tone]}${pulse} ${emphasis}`}
      title={title}
    >
      <span className="kr-label opacity-80">{label}</span>
      <span className="font-bold">{value}</span>
    </span>
  );
}

// 동기화 신선도 계산의 단일 출처.
// Pill(품질)·FreshnessDot·buildSnapshotDigest 가 각자 다른 분기로 구현했을 때
// 미래 타임스탬프/NaN 처리가 어긋나 "정상 Pill + 빨간 도트" 같은 표시 드리프트가
// 발생했다. 세 곳 모두 이 헬퍼를 경유하도록 통일한다.
// 반환: 유효한 경과 초(0 이상) 또는 Infinity(미연결·미래·비정상 입력).
export function computeStaleSec(lastSyncedAt: number | undefined, now: number): number {
  if (!lastSyncedAt || !Number.isFinite(lastSyncedAt) || !Number.isFinite(now)) return Infinity;
  if (now < lastSyncedAt) return Infinity;
  return Math.floor((now - lastSyncedAt) / 1000);
}

// 마지막 동기화 이후 경과 시간을 사람이 읽기 쉬운 문자열로 변환.
// 돌아온 사용자가 "이 데이터가 방금 찍힌 건가, 한참 전 것인가"를 즉시 구분하기 위함.
// 비정상 입력(NaN·음수·미래 타임스탬프)은 "동기화 대기"로 수렴시켜
// 잘못된 신뢰를 주지 않도록 방어한다.
export function formatFreshness(lastSyncedAt: number | undefined, now: number): string {
  if (!lastSyncedAt || !Number.isFinite(lastSyncedAt) || !Number.isFinite(now)) {
    return '동기화 대기';
  }
  const deltaMs = now - lastSyncedAt;
  if (deltaMs < 0) return '동기화 대기';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 5) return '방금 전';
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

// 품질 관리 관점의 위험도 평가. 충돌/고립/신선도 세 축을 종합해
// 사용자가 한 눈에 "지금 손대야 하는 상황인지" 판단할 수 있게 한다.
// 임계값은 단위 테스트에서 그대로 재사용할 수 있도록 export.
export const RISK_CONTENTION_ALERT_THRESHOLD = 1;
export const RISK_ISOLATION_WARN_RATIO = 0.5;
export const RISK_STALE_WARN_SEC = 90;
export const RISK_STALE_ALERT_SEC = 300;
// 한 파일에 활성 인력이 75% 이상 몰리면 리뷰 병목·머지 충돌 확률이 급격히 상승.
// 경험적으로 이 이상은 "실수 한 번이 팀 전체를 막는" 구간이라 warn으로 승급한다.
export const RISK_CONCENTRATION_WARN_THRESHOLD = 0.75;
// 95% 이상이면 사실상 모든 활성 인력이 한 파일에 몰려 있어, 다음 커밋 한 번에
// 전원이 머지 충돌을 맞을 확률이 사실상 확정적이다. 이 구간은 충돌 파일 경보와
// 동급의 긴급도로 취급해 Pill·ConcentrationBar 양쪽에서 alert 톤으로 승급한다.
export const RISK_CONCENTRATION_ALERT_THRESHOLD = 0.95;

export type RiskLevel = 'ok' | 'warn' | 'alert';

export type RiskInput = {
  contentionFiles: number;
  isolated: number;
  total: number;
  staleSec: number;
  workloadConcentration?: number;
};

export type RiskSignal = {
  level: RiskLevel;
  label: string;
  tone: PillTone;
  reason: string;
};

const RISK_LEVEL_RANK: Record<RiskLevel, number> = { ok: 0, warn: 1, alert: 2 };
const RISK_LABEL: Record<RiskLevel, string> = { ok: '정상', warn: '주의', alert: '위험' };
const RISK_TONE: Record<RiskLevel, PillTone> = { ok: 'ok', warn: 'warn', alert: 'alert' };

// 파이프라인 역할별 카운트를 칩으로 렌더.
// 0건 칩은 기본 숨김(노이즈 방지) — 단 router가 0이면 파이프라인이 멈춘 신호이므로
// 빨간 링으로 강조해 무조건 노출한다(디자이너 §7.3 합의).
const PIPELINE_CHIP_ORDER: readonly PipelineRole[] = ['router', 'executor', 'verifier', 'standby', 'vacant'];

function PipelineRoleChips({ breakdown }: { breakdown: Record<PipelineRole, number> }) {
  const visible = PIPELINE_CHIP_ORDER.filter(role => breakdown[role] > 0 || role === 'router');
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px]" aria-label="파이프라인 역할 분포">
      {visible.map(role => {
        const count = breakdown[role];
        const stalled = role === 'router' && count === 0;
        return (
          <span
            key={role}
            className={`inline-flex items-center gap-1 ${stalled ? 'ring-1 ring-red-400/40' : ''}`}
            title={stalled ? '라우터 결원 · 파이프라인 정지 신호' : `${getPipelineRoleLabel(role)} ${count}명`}
          >
            <PipelineBadge role={role} />
            <span className={`font-bold ${stalled ? 'text-red-300' : 'text-white/80'}`}>{count}</span>
          </span>
        );
      })}
    </div>
  );
}

// 활성 에이전트가 손대고 있는 파일명을 중복 없이 집계.
// 컴포넌트와 분리해 pure function으로 노출 — 유닛 테스트에서 Agent/CodeFile
// 픽스처만으로 검증할 수 있도록 DOM 의존성을 배제했다.
export function computeActiveFileNames(agents: Agent[], files: CodeFile[]): string[] {
  const nameById = new Map(files.map(f => [f.id, f.name] as const));
  const names = new Set<string>();
  for (const agent of agents) {
    if (!isActiveAgent(agent)) continue;
    if (!agent.workingOnFileId) continue;
    const name = nameById.get(agent.workingOnFileId);
    if (name) names.add(name);
  }
  return [...names];
}

// 단조 증가만 허용하는 escalate 헬퍼. 여러 신호가 경쟁적으로 level을
// 덮어쓰는 과정에서 경보가 실수로 낮아지는 regression을 원천 차단한다.
function escalate(current: RiskLevel, target: RiskLevel): RiskLevel {
  return RISK_LEVEL_RANK[target] > RISK_LEVEL_RANK[current] ? target : current;
}

// 병목 집중도: 활성 에이전트 중 '한 파일'에 가장 많이 몰린 비율.
// 1.0 에 가까울수록 모든 인력이 같은 파일에 붙어 있다는 뜻이라 리뷰 대기/머지 충돌 가능성이 커진다.
// 연구 로그를 뽑을 때 시계열로 쌓으면 스프린트 내 협업 쏠림을 사후 분석할 수 있다.
export function computeWorkloadConcentration(agents: Agent[]): number {
  const byFile = new Map<string, number>();
  let active = 0;
  for (const agent of agents) {
    if (!isActiveAgent(agent) || !agent.workingOnFileId) continue;
    active += 1;
    byFile.set(agent.workingOnFileId, (byFile.get(agent.workingOnFileId) ?? 0) + 1);
  }
  if (active === 0) return 0;
  let peak = 0;
  for (const n of byFile.values()) if (n > peak) peak = n;
  return peak / active;
}

// 연구 분석·외부 로그 적재를 위한 스냅샷 요약본.
// UI 렌더링과 독립적으로 호출해, 동일한 입력에서 결정론적 결과가 나오도록 순수 함수로 유지한다.
export type SnapshotDigest = {
  takenAt: number;
  totalAgents: number;
  activePct: number;
  contentionFiles: number;
  isolatedRatio: number;
  workloadConcentration: number;
  activeFileCount: number;
  risk: RiskSignal;
};

export function buildSnapshotDigest(
  agents: Agent[],
  files: CodeFile[],
  lastSyncedAt: number | undefined,
  now: number,
): SnapshotDigest {
  const agentIdSet = new Set(agents.map(a => a.id));
  const edges = computeCollaborationEdges(agents, agentIdSet);
  const isolated = computeIsolatedAgentIds(agents, edges).size;
  const contentionFiles = computeContentionCounts(agents).size;
  const staleSec = computeStaleSec(lastSyncedAt, now);
  const workloadConcentration = computeWorkloadConcentration(agents);
  const risk = assessRisk({
    contentionFiles,
    isolated,
    total: agents.length,
    staleSec,
    workloadConcentration,
  });
  return {
    takenAt: now,
    totalAgents: agents.length,
    activePct: Math.round(computeActiveRatio(agents) * 100),
    contentionFiles,
    isolatedRatio: agents.length > 0 ? isolated / agents.length : 0,
    workloadConcentration,
    activeFileCount: computeActiveFileNames(agents, files).length,
    risk,
  };
}

export function assessRisk(input: RiskInput): RiskSignal {
  const { contentionFiles, isolated, total, staleSec, workloadConcentration } = input;
  const reasons: Array<{ level: RiskLevel; text: string }> = [];
  let level: RiskLevel = 'ok';

  // NaN은 비교 연산에서 항상 false라 무음 회귀를 만들 수 있다.
  // 알 수 없는 신선도는 보수적으로 '끊김'과 동일 취급해 경보를 올린다.
  const normalizedStale = Number.isFinite(staleSec) ? Math.max(0, staleSec) : Infinity;

  if (contentionFiles >= RISK_CONTENTION_ALERT_THRESHOLD) {
    level = escalate(level, 'alert');
    reasons.push({ level: 'alert', text: `충돌 파일 ${contentionFiles}건` });
  }
  if (normalizedStale >= RISK_STALE_ALERT_SEC) {
    level = escalate(level, 'alert');
    reasons.push({ level: 'alert', text: '동기화 끊김' });
  } else if (normalizedStale >= RISK_STALE_WARN_SEC) {
    level = escalate(level, 'warn');
    reasons.push({ level: 'warn', text: '동기화 지연' });
  }
  if (total > 0 && isolated / total >= RISK_ISOLATION_WARN_RATIO) {
    level = escalate(level, 'warn');
    reasons.push({ level: 'warn', text: `고립 ${isolated}/${total}` });
  }
  if (
    typeof workloadConcentration === 'number' &&
    Number.isFinite(workloadConcentration) &&
    workloadConcentration >= RISK_CONCENTRATION_WARN_THRESHOLD
  ) {
    // 0.95 이상이면 "실제로 다음 커밋 한 번에 전원이 충돌할" 구간이라 alert 로 승급.
    // 그 아래 0.75 이상은 아직 복구 가능한 리뷰 병목 수준이라 warn 을 유지한다.
    const concentrationLevel: RiskLevel =
      workloadConcentration >= RISK_CONCENTRATION_ALERT_THRESHOLD ? 'alert' : 'warn';
    level = escalate(level, concentrationLevel);
    reasons.push({
      level: concentrationLevel,
      text: `쏠림 ${Math.round(workloadConcentration * 100)}%`,
    });
  }

  // 심각도 내림차순(alert → warn)으로 정렬해 가장 급한 신호가 항상 맨 앞에 오도록.
  // 같은 레벨끼리는 삽입 순서를 유지(안정 정렬)해서 기존 호출자 기대치를 깨지 않는다.
  const sorted = reasons
    .map((r, i) => ({ r, i }))
    .sort((a, b) => RISK_LEVEL_RANK[b.r.level] - RISK_LEVEL_RANK[a.r.level] || a.i - b.i)
    .map(({ r }) => r.text);

  return {
    level,
    label: RISK_LABEL[level],
    tone: RISK_TONE[level],
    reason: sorted.length ? sorted.join(' · ') : '이상 신호 없음',
  };
}
