/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 지시 #4a9402f3 · 헤더 지표 통합 아이콘.
 *
 * 종전 헤더에는 "커버리지 / 활성률 / 협업" 세 개의 칩이 가로로 나란히 놓여 한 줄을
 * 빠르게 차지했다. Thanos 가 진행하는 "헤더 한 줄 유지" 작업과 충돌을 피하면서도
 * 동일한 정보를 잃지 않도록, 본 컴포넌트는 세 지표를 단일 SVG 아이콘(다층 링)으로
 * 압축하고 마우스오버 · 키보드 포커스 시 popover 로 상세 줄을 펼친다.
 *
 * 디자인 결정
 *   · 별도 라이브러리(radix-ui Tooltip · shadcn HoverCard) 없이 자체 popover 를
 *     쓴다. 프로젝트 의존성에 해당 패키지가 없으며, 한 곳에서만 쓰이는 컴포넌트라
 *     CSS-only hover/focus-within 패턴으로 충분히 깔끔하다.
 *   · 접근성: 상위 트리거에 role="button" + tabIndex=0 + aria-describedby 를 부여,
 *     popover 는 role="tooltip" + 고유 id 로 연결한다. focus-visible 시에도 popover
 *     가 열리도록 onFocus/onBlur 핸들러로 상태를 토글.
 *   · 시각화: 외곽 ring=커버리지, 중간 ring=활성률, 내부 dot=협업. 각 ring 의 색상은
 *     getMetricTierColor 와 같은 임계 분류로 계산해 칩 시절과 동일한 의미를 유지한다.
 *
 * 데이터는 호출자가 계산해 props 로 주입한다. 본 컴포넌트는 표시 전용 — 테스트가
 * 결정 트리(라벨/색/aria) 만 잠그면 되도록 부수효과 없는 함수 컴포넌트로 둔다.
 */

import React, { useId, useMemo, useState } from 'react';

export type MetricTier = 'good' | 'warn' | 'bad' | 'unknown';

export interface StatsCoverage {
  /** 0~100 정수 퍼센트. */
  readonly percent: number;
  /** 의존성 그래프에 연결되지 않은 파일 목록. 길이가 0 이면 popover 에서 안내 문구로 대체. */
  readonly isolatedFiles: readonly string[];
}

export interface StatsActivity {
  /** 0~100 정수 퍼센트. total === 0 이면 percent 는 0 이지만 unknown 톤으로 표시된다. */
  readonly percent: number;
  readonly active: number;
  readonly total: number;
  /** 역할별 (활성/전체) 등 상세 한 줄. popover 보조 텍스트로 노출. */
  readonly breakdown?: string;
}

export interface StatsCollaboration {
  /** 참여율 0~100. messageCount === 0 이면 null 로 넘겨 unknown 톤이 된다. */
  readonly percent: number | null;
  readonly messageCount: number;
  /** "메시지 N · 채널 M …" 같은 한 줄 상세. */
  readonly detail: string;
}

export interface StatsIndicatorProps {
  readonly coverage: StatsCoverage;
  readonly activity: StatsActivity;
  readonly collaboration: StatsCollaboration;
  /** 테스트가 popover 강제 노출을 검증할 때만 사용. 평소엔 hover/focus 가 결정. */
  readonly forceOpen?: boolean;
  readonly className?: string;
}

/**
 * 임계 분류. getMetricTierColor 와 동일한 임계값(70/40) 을 사용해 헤더 칩 시절과
 * 의미가 같도록 한다. value === null 또는 messageCount === 0 같은 "데이터 없음" 은
 * 'unknown' 으로 분류해 회색 톤으로 그린다.
 */
export function classifyTier(value: number | null): MetricTier {
  if (value === null) return 'unknown';
  if (value >= 70) return 'good';
  if (value >= 40) return 'warn';
  return 'bad';
}

const TIER_COLOR: Record<MetricTier, string> = {
  good: '#7bd389',
  warn: '#ffd166',
  bad: '#ff6b6b',
  unknown: 'var(--pixel-border, #4a5468)',
};

/** popover 한 줄에 들어가는 데이터. 테스트가 라벨·퍼센트·티어를 일괄 검증할 수 있도록 분리. */
export interface StatsLine {
  readonly key: 'coverage' | 'activity' | 'collaboration';
  readonly label: string;
  readonly percent: number | null;
  readonly tier: MetricTier;
  readonly detail: string;
}

/**
 * 세 지표를 popover 줄 데이터로 변환. 컴포넌트 외부에서도 재사용 가능하도록 export.
 *   · coverage: 항상 percent 가 정의됨. isolatedFiles 가 비면 "고립 파일 없음" 안내.
 *   · activity: total === 0 이면 unknown 톤 + "에이전트 없음" 안내.
 *   · collaboration: percent === null 이면 unknown + "협업 로그 없음".
 */
export function buildStatsLines(args: {
  coverage: StatsCoverage;
  activity: StatsActivity;
  collaboration: StatsCollaboration;
}): StatsLine[] {
  const { coverage, activity, collaboration } = args;
  const coverageDetail =
    coverage.isolatedFiles.length > 0
      ? `고립 파일 ${coverage.isolatedFiles.length}건: ${coverage.isolatedFiles.join(', ')}`
      : '의존성에 연결되지 않은 파일 없음';
  const activityPercent = activity.total === 0 ? null : activity.percent;
  const activityDetail = activity.breakdown
    ? `${activity.breakdown}`
    : `활성 ${activity.active} / 전체 ${activity.total}`;
  return [
    {
      key: 'coverage',
      label: '커버리지',
      percent: coverage.percent,
      tier: classifyTier(coverage.percent),
      detail: coverageDetail,
    },
    {
      key: 'activity',
      label: '활성률',
      percent: activityPercent,
      tier: classifyTier(activityPercent),
      detail: activityDetail,
    },
    {
      key: 'collaboration',
      label: '협업',
      percent: collaboration.percent,
      tier: classifyTier(collaboration.percent),
      detail: collaboration.messageCount === 0 ? '협업 로그 없음' : collaboration.detail,
    },
  ];
}

/** 트리거 SVG 한 점에 표시할 한 줄 요약(스크린리더 라벨용). */
export function buildAriaSummary(lines: readonly StatsLine[]): string {
  return lines
    .map(line => {
      const value = line.percent === null ? '데이터 없음' : `${line.percent}%`;
      return `${line.label} ${value}`;
    })
    .join(', ');
}

interface RingSpec {
  readonly tier: MetricTier;
  readonly percent: number | null;
  readonly radius: number;
  readonly stroke: number;
}

function Ring({ tier, percent, radius, stroke }: RingSpec): React.ReactElement {
  const circumference = 2 * Math.PI * radius;
  const ratio = percent === null ? 0 : Math.max(0, Math.min(100, percent)) / 100;
  const dash = circumference * ratio;
  const color = TIER_COLOR[tier];
  return (
    <g>
      <circle
        cx={16}
        cy={16}
        r={radius}
        fill="none"
        stroke="var(--pixel-border, #2a3140)"
        strokeWidth={stroke}
        opacity={0.45}
      />
      <circle
        cx={16}
        cy={16}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeDashoffset={circumference / 4}
        strokeLinecap="butt"
        transform="rotate(-90 16 16)"
      />
    </g>
  );
}

export function StatsIndicator(props: StatsIndicatorProps): React.ReactElement {
  const { coverage, activity, collaboration, forceOpen, className } = props;
  const popoverId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = Boolean(forceOpen) || hovered || focused;

  const lines = useMemo(
    () => buildStatsLines({ coverage, activity, collaboration }),
    [coverage, activity, collaboration],
  );
  const ariaSummary = useMemo(() => buildAriaSummary(lines), [lines]);

  return (
    <span
      className={['stats-indicator', className].filter(Boolean).join(' ')}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      data-testid="stats-indicator"
    >
      <span
        role="button"
        tabIndex={0}
        aria-label={`프로젝트 지표 요약: ${ariaSummary}`}
        aria-describedby={popoverId}
        aria-expanded={open}
        data-testid="stats-indicator-trigger"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setFocused(false);
            setHovered(false);
          }
        }}
        className="stats-indicator__trigger focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--pixel-accent,#7fd4ff)]"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          cursor: 'pointer',
          background: 'transparent',
          border: 'none',
          padding: 0,
        }}
      >
        <svg width={32} height={32} viewBox="0 0 32 32" aria-hidden="true">
          <Ring tier={lines[0].tier} percent={lines[0].percent} radius={13} stroke={3} />
          <Ring tier={lines[1].tier} percent={lines[1].percent} radius={9} stroke={3} />
          <circle cx={16} cy={16} r={4} fill={TIER_COLOR[lines[2].tier]} />
        </svg>
      </span>
      <div
        id={popoverId}
        role="tooltip"
        data-testid="stats-indicator-popover"
        data-open={open ? 'true' : 'false'}
        // 마우스 진입에도 popover 가 닫히지 않도록 hover 가 wrapping span 으로 위임됨.
        style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 6,
          minWidth: 240,
          padding: '8px 10px',
          background: 'var(--pixel-card, #11182a)',
          border: '2px solid var(--pixel-border, #2a3140)',
          color: 'var(--pixel-text, #e6edf6)',
          fontSize: 11,
          lineHeight: 1.4,
          boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
          zIndex: 40,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transform: open ? 'translateY(0)' : 'translateY(-2px)',
          transition: 'opacity 80ms ease-out, transform 80ms ease-out',
        }}
      >
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
          {lines.map((line) => (
            <li key={line.key} data-testid={`stats-indicator-line-${line.key}`} data-tier={line.tier}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--pixel-accent, #7fd4ff)', fontWeight: 700 }}>{line.label}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                  {line.percent === null ? '—' : `${line.percent}%`}
                </span>
              </div>
              <div
                aria-hidden="true"
                style={{
                  marginTop: 3,
                  height: 4,
                  background: 'var(--pixel-border, #2a3140)',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: `${line.percent === null ? 0 : Math.max(0, Math.min(100, line.percent))}%`,
                    background: TIER_COLOR[line.tier],
                  }}
                />
              </div>
              <div style={{ marginTop: 3, color: 'var(--pixel-text-dim, #97a3b6)' }}>
                {line.detail}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </span>
  );
}

export default StatsIndicator;
