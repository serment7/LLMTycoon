/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Git 자동화 파이프라인(커밋·푸시·PR) 단계의 현재 상태를 4가지(대기/실행중/성공/
 * 실패) 시각으로 그리는 재사용 뱃지.
 *
 * 리더 단일 브랜치 정책(2026-04-18): 이 뱃지는 리더 에이전트가 트리거한
 * **단일 브랜치 파이프라인**의 단계 상태만 표현한다. 에이전트별로 여러 브랜치 축을
 * 나눠 그리지 않는다. 호출부가 넘기는 `recent.branch` 값은 항상 리더 기준의 한 줄이며,
 * 호스트(AgentContextBubble/AgentStatusPanel)가 에이전트별로 중복 렌더하지 않도록
 * "가장 최근 리더 트리거 1건" 만 고른 뒤 이 뱃지에 주입하는 계약이다.
 *
 * 배경: `AgentStatusPanel` 안에 동일 마크업이 인라인으로 묻혀 있어 `AgentContextBubble`
 * 처럼 공간이 다른 호스트에서 재사용할 수 없었다. 뱃지 자체를 독립 컴포넌트로
 * 분리하고, types.ts 의 `GitAutomationLogEntry` 를 단일 입력 채널로 삼아
 * outcome(started/succeeded/failed/skipped) → 4상태(state)로 접어 렌더한다.
 *
 * CSS 재사용: 기존 `.git-auto-stages__badge[data-state]` 팔레트를 그대로 쓴다.
 * AgentContextBubble 처럼 좁은 공간용으로는 `compact` 변형을 부여해 CSS 가
 * 간격·폰트 크기를 추가 축소하도록 둔다.
 */

import React from 'react';
import type { GitAutomationLogEntry, GitAutomationLogOutcome } from '../types';

// 4상태 뱃지 축. GitAutomationLogEntry.outcome 과 다른 층의 개념이라(스킵은
// UI 상 "대기" 와 동치로 접는다) 별도 alias 로 유지한다.
export type GitAutomationBadgeState = 'idle' | 'running' | 'success' | 'failed';
export type GitAutomationBadgeStage = GitAutomationLogEntry['stage'];

const STAGE_LABEL: Record<GitAutomationBadgeStage, string> = {
  commit: '자동 커밋',
  push: '원격 푸시',
  pr: 'PR 생성',
};

const STATE_GLYPH: Record<GitAutomationBadgeState, string> = {
  idle: '○',
  running: '◔',
  success: '◉',
  failed: '✕',
};

const STATE_LABEL: Record<GitAutomationBadgeState, string> = {
  idle: '대기',
  running: '실행중',
  success: '성공',
  failed: '실패',
};

// outcome → state 매핑. 'skipped' 는 "이번 실행에서 해당 단계를 건너뜀" 이라
// 사용자 관점에서는 "대기" 와 동일 시각으로 묶는다. 이력이 아예 없으면 idle.
const OUTCOME_TO_STATE: Record<GitAutomationLogOutcome, GitAutomationBadgeState> = {
  started: 'running',
  succeeded: 'success',
  failed: 'failed',
  skipped: 'idle',
};

export function deriveBadgeStateFromLog(
  entry: GitAutomationLogEntry | undefined,
): GitAutomationBadgeState {
  if (!entry) return 'idle';
  return OUTCOME_TO_STATE[entry.outcome] ?? 'idle';
}

export function getGitAutomationStageLabel(stage: GitAutomationBadgeStage): string {
  return STAGE_LABEL[stage];
}

export function getGitAutomationBadgeStateLabel(state: GitAutomationBadgeState): string {
  return STATE_LABEL[state];
}

export function getGitAutomationBadgeGlyph(state: GitAutomationBadgeState): string {
  return STATE_GLYPH[state];
}

// 엔트리 배열에서 stage 별로 at(epoch ms) 가 가장 큰 최신 1건만 뽑는다.
// AgentContextBubble 처럼 "요약만" 필요한 호스트가 반복 탐색하지 않도록 공용화.
// 리더 단일 브랜치 정책: entries 가 여러 에이전트의 로그를 섞어 담고 있어도
// stage 별로 "가장 최근 1건" 만 남기므로, 반환값은 항상 단일 브랜치 관점의 요약이다.
export function pickLatestByStage(
  entries: ReadonlyArray<GitAutomationLogEntry>,
): Record<GitAutomationBadgeStage, GitAutomationLogEntry | undefined> {
  const out: Partial<Record<GitAutomationBadgeStage, GitAutomationLogEntry>> = {};
  for (const e of entries) {
    const prev = out[e.stage];
    if (!prev || e.at > prev.at) out[e.stage] = e;
  }
  return { commit: out.commit, push: out.push, pr: out.pr };
}

// 뱃지에 노출할 툴팁 문자열. 접근성 도구는 title 을 읽어 주지 않으므로,
// 호출부는 aria-label 을 별도로 부여한다. 여기서는 시각 사용자용 보조 정보만.
export function formatGitAutomationTooltip(args: {
  stage: GitAutomationBadgeStage;
  state: GitAutomationBadgeState;
  recent?: GitAutomationLogEntry;
  detail?: string;
  errorMessage?: string;
}): string {
  const lines = [`${STAGE_LABEL[args.stage]} · ${STATE_LABEL[args.state]}`];
  const err = args.errorMessage ?? args.recent?.errorMessage;
  if (err) lines.push(`오류: ${err}`);
  if (args.detail) lines.push(args.detail);
  if (args.recent?.branch) lines.push(`브랜치: ${args.recent.branch}`);
  if (args.recent?.commitSha) lines.push(`커밋: ${args.recent.commitSha}`);
  if (args.recent?.prUrl) lines.push(`PR: ${args.recent.prUrl}`);
  if (args.recent?.at && Number.isFinite(args.recent.at)) {
    // epoch ms → "YYYY-MM-DD HH:mm:ss UTC". 서버/클라이언트 타임존 차이가 감사에서
    // 문제되지 않도록 일관성 있게 UTC 로 표기한다.
    const iso = new Date(args.recent.at).toISOString().replace('T', ' ').slice(0, 19);
    lines.push(`최근 실행: ${iso} UTC`);
  }
  return lines.join('\n');
}

interface Props {
  stage: GitAutomationBadgeStage;
  state: GitAutomationBadgeState;
  /** 기본 한국어 단계명을 덮어쓸 때만 사용. 생략 시 STAGE_LABEL 사용. */
  label?: string;
  detail?: string;
  errorMessage?: string;
  /** 최근 실행 로그 1건. 툴팁에 브랜치·커밋·PR·실행 시각을 덧붙인다. */
  recent?: GitAutomationLogEntry;
  className?: string;
  /** 좁은 호스트(AgentContextBubble)용 축약 변형. CSS 가 간격/폰트를 줄인다. */
  compact?: boolean;
}

export function GitAutomationStageBadge({
  stage,
  state,
  label,
  detail,
  errorMessage,
  recent,
  className,
  compact,
}: Props) {
  const stageLabel = label ?? STAGE_LABEL[stage];
  const stateLabel = STATE_LABEL[state];
  const tooltip = formatGitAutomationTooltip({
    stage,
    state,
    recent,
    detail,
    errorMessage,
  });
  const cls = [
    'git-auto-stages__badge',
    compact ? 'git-auto-stages__badge--compact' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={cls}
      data-stage={stage}
      data-state={state}
      data-compact={compact ? 'true' : undefined}
      title={tooltip}
      aria-label={`${stageLabel} ${stateLabel}`}
    >
      <span className="git-auto-stages__glyph" aria-hidden>
        {STATE_GLYPH[state]}
      </span>
      <span className="git-auto-stages__badge-label">{stageLabel}</span>
      <span className="git-auto-stages__badge-state">{stateLabel}</span>
    </span>
  );
}

// ── AutoFlowProgressBar ──────────────────────────────────────────────
// 자동 개발 루프의 메타 단계 4개(개선 보고 → 리더 재분배 → 전원 완료 →
// Git 자동화 발동)를 한 줄 진행 표시줄로 보여준다. GitAutomationStageRow
// 가 커밋/푸시/PR "내부" 파이프라인을 그린다면, 이 컴포넌트는 "왜 Git 자동화가
// 아직 돌지 않았는가" 를 상위 문맥에서 설명한다. 시각은 3단계가 모두 done 일
// 때만 git 단계가 running/done 으로 진입하는 순서를 가정하고,
// 전원 완료 순간 Git 자동화 패널이 활성화되는 글로우 애니메이션을 트리거한다.

export type AutoFlowStageKey = 'report' | 'redistribute' | 'complete' | 'git';
export type AutoFlowStageState = 'idle' | 'running' | 'done' | 'failed';

export type AutoFlowStages = Record<AutoFlowStageKey, AutoFlowStageState>;

export const AUTO_FLOW_STAGE_ORDER: ReadonlyArray<AutoFlowStageKey> = [
  'report',
  'redistribute',
  'complete',
  'git',
];

const AUTO_FLOW_STAGE_LABEL: Record<AutoFlowStageKey, string> = {
  report: '개선 보고',
  redistribute: '리더 재분배',
  complete: '전원 완료',
  git: 'Git 자동화 발동',
};

const AUTO_FLOW_STAGE_GLYPH: Record<AutoFlowStageKey, string> = {
  report: '✎',
  redistribute: '⤴',
  complete: '✓',
  git: '⚙',
};

const AUTO_FLOW_STATE_LABEL: Record<AutoFlowStageState, string> = {
  idle: '대기',
  running: '진행중',
  done: '완료',
  failed: '실패',
};

export function getAutoFlowStageLabel(stage: AutoFlowStageKey): string {
  return AUTO_FLOW_STAGE_LABEL[stage];
}

export function getAutoFlowStateLabel(state: AutoFlowStageState): string {
  return AUTO_FLOW_STATE_LABEL[state];
}

// GitAutomationDigest 의 commit/push/pr 상태만 있을 때 4단계 메타 상태를
// 보수적으로 유추한다. 호출부가 직접 AutoFlowStages 를 계산해 넘겨주는 쪽을
// 선호하되, 데이터가 없는 과도기에는 이 헬퍼로 기본 값을 채운다.
export function deriveAutoFlowFromGitStages(args: {
  commit: GitAutomationBadgeState;
  push: GitAutomationBadgeState;
  pr: GitAutomationBadgeState;
}): AutoFlowStages {
  const anyRunning =
    args.commit === 'running' || args.push === 'running' || args.pr === 'running';
  const anyFailed =
    args.commit === 'failed' || args.push === 'failed' || args.pr === 'failed';
  const anySuccess =
    args.commit === 'success' || args.push === 'success' || args.pr === 'success';
  const allSuccess =
    args.commit === 'success' && args.push === 'success' && args.pr === 'success';

  // 앞 3단계(보고/재분배/전원완료)는 Git 자동화가 한 번이라도 시도됐다면
  // 이미 지나간 단계로 간주한다. 데이터 소스가 더 풍부해지면 호출부에서
  // 개별 단계를 명시적으로 넘겨 이 휴리스틱을 대체해야 한다.
  const priorState: AutoFlowStageState =
    anyRunning || anyFailed || anySuccess ? 'done' : 'idle';

  const git: AutoFlowStageState = anyFailed
    ? 'failed'
    : allSuccess
      ? 'done'
      : anyRunning
        ? 'running'
        : 'idle';

  return {
    report: priorState,
    redistribute: priorState,
    complete: priorState,
    git,
  };
}

interface AutoFlowProgressBarProps {
  stages: AutoFlowStages;
  /** 좁은 호스트(예: AgentContextBubble)용 축약 변형. 아이콘만 보이고 라벨이 줄어든다. */
  compact?: boolean;
  className?: string;
  /** 접근성 라벨 덮어쓰기. 생략 시 기본 한국어 라벨 사용. */
  ariaLabel?: string;
}

export function AutoFlowProgressBar({
  stages,
  compact,
  className,
  ariaLabel,
}: AutoFlowProgressBarProps) {
  const allDone = AUTO_FLOW_STAGE_ORDER.every(key => stages[key] === 'done');
  const anyFailed = AUTO_FLOW_STAGE_ORDER.some(key => stages[key] === 'failed');
  const gitActivated =
    stages.git === 'running' || stages.git === 'done';

  const cls = [
    'auto-flow-progress',
    compact ? 'auto-flow-progress--compact' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <ol
      className={cls}
      data-all-done={allDone ? 'true' : undefined}
      data-any-failed={anyFailed ? 'true' : undefined}
      data-git-activated={gitActivated ? 'true' : undefined}
      aria-label={ariaLabel ?? '자동 개발 루프 진행 상태'}
    >
      {AUTO_FLOW_STAGE_ORDER.map((key, idx) => {
        const state = stages[key];
        const label = AUTO_FLOW_STAGE_LABEL[key];
        const stateLabel = AUTO_FLOW_STATE_LABEL[state];
        const glyph = AUTO_FLOW_STAGE_GLYPH[key];
        const prevKey = idx > 0 ? AUTO_FLOW_STAGE_ORDER[idx - 1] : null;
        const prevState = prevKey ? stages[prevKey] : null;
        return (
          <li
            key={key}
            className="auto-flow-progress__step"
            data-stage={key}
            data-state={state}
            aria-label={`${idx + 1}단계 ${label} ${stateLabel}`}
            title={`${label} · ${stateLabel}`}
          >
            {prevState && (
              <span
                className="auto-flow-progress__connector"
                data-prev-state={prevState}
                aria-hidden
              />
            )}
            <span className="auto-flow-progress__body">
              <span className="auto-flow-progress__glyph" aria-hidden>
                {glyph}
              </span>
              <span className="auto-flow-progress__label">{label}</span>
              <span className="auto-flow-progress__state" aria-hidden>
                {stateLabel}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default GitAutomationStageBadge;
