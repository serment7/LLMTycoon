// TokenUsageIndicator — Claude 구독 세션(5시간 롤링 창) 의 남은 토큰량을
// 상단바에 한 줄 배지로 표시한다.
//
// 기존 `<ClaudeTokenUsage/>` 는 "누적 토큰·비용" 뷰, 본 위젯은 "현재 세션 남은 잔량"
// 뷰로 축을 분리한다. 두 배지는 상단바에 나란히 놓이며 상호 간섭이 없다.
//
// 계산 로직은 `utils/claudeSubscriptionSession.ts` 의 순수 함수로 분리해 단위
// 테스트에서 5시간 경계·severity·폴백을 모두 잠갔다. 본 파일은:
//   1) claudeTokenUsageStore 의 `all` 축(= 서버 권위 cumulative) 을 구독
//   2) 매 분 1회 타이머로 now 를 갱신해 리셋 감지·툴팁 시각을 신선하게 유지
//   3) 누적 합계 변화·now 변화 시 순수 함수를 호출, 결과 스냅샷을 렌더
//   4) 리셋 감지 시 (isReset===true) 같은 렌더에서 useState 로 세션 상태 커밋
//   5) 스토어 loadError 가 있으면 폴백 배지("토큰 정보 없음") 로 전환
//
// a11y: role="status" + aria-live="polite" 로 수치 변동을 조용히 고지하고,
// 배지는 role="img" 로 "토큰 게이지" 라는 한 덩어리로 들린다(= 칩 안의 퍼센트
// 숫자를 개별 텍스트로 두 번 읽히지 않도록).

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BatteryMedium, BatteryFull, BatteryWarning } from 'lucide-react';

import { claudeTokenUsageStore } from '../utils/claudeTokenUsageStore';
import {
  DEFAULT_SUBSCRIPTION_TOKEN_LIMIT,
  SUBSCRIPTION_SESSION_WINDOW_MS,
  computeSubscriptionSessionSnapshot,
  formatResetClock,
  formatTimeUntilReset,
  type SubscriptionSessionSeverity,
  type SubscriptionSessionState,
} from '../utils/claudeSubscriptionSession';

// 상단 사용량 위젯 팔레트와 결이 맞도록 기존 토큰(`--token-usage-*`) 과 공통
// 에러 토큰(`--error-state-*`)을 재사용한다. "녹/황/적" 은 팔레트 규약과 매핑:
//   ok      → normal 팔레트(shared-goal-modal-field-focus = cyan)
//   caution → caution 팔레트 (amber)
//   critical→ warning 팔레트 (red)
//
// WCAG 1.4.3 대비: 전경색(fg)은 --pixel-card(#16213e) 기반 헤더 배경 위에서
// 4.5:1 이상을 갖도록 토큰(`--token-usage-*-fg` / `--shared-goal-modal-header-fg`)
// 을 선택했다. 배경 오버레이(`*-bg`)는 rgba 투명이라 대비 측정 기준은 헤더 배경을
// 그대로 쓴다(index.css "토큰 사용량 팔레트" 주석 참조). 심각도 구분은 색 단독이
// 아니라 `색 + 아이콘(Battery*) + 진행 바(bar)` 3중으로 중첩해, 색맹·저대비
// 환경에서도 최소 2개 이상의 단서가 남도록 설계되어 있다.
function severityPalette(sev: SubscriptionSessionSeverity) {
  if (sev === 'critical') {
    return {
      borderColor: 'var(--token-usage-warning-border)',
      iconColor: 'var(--token-usage-warning-icon)',
      fg: 'var(--token-usage-warning-fg)',
      bg: 'var(--token-usage-warning-bg)',
      barColor: 'var(--token-usage-warning-border)',
    };
  }
  if (sev === 'caution') {
    return {
      borderColor: 'var(--token-usage-caution-border)',
      iconColor: 'var(--token-usage-caution-icon)',
      fg: 'var(--token-usage-caution-fg)',
      bg: 'var(--token-usage-caution-bg)',
      barColor: 'var(--token-usage-caution-border)',
    };
  }
  return {
    borderColor: 'var(--shared-goal-modal-field-focus)',
    iconColor: 'var(--token-usage-axis-input-fg)',
    fg: 'var(--shared-goal-modal-header-fg)',
    bg: 'var(--token-usage-badge-bg)',
    barColor: 'var(--shared-goal-modal-field-focus)',
  };
}

// 배터리 단계는 "가득 → 중간 → 경고" 로 자연 하강해, 사용률이 올라갈수록
// 시각적 긴박도가 단조 증가한다. BatteryLow 는 심각도 4단계화가 도입되기 전
// 임시로 caution 에 매핑됐었지만, 현 3단계 모델(ok/caution/critical)에서는
// "중간"(Medium) 이 의미상 더 일관적이어서 한 단계씩 정비.
function SeverityIcon({ severity }: { severity: SubscriptionSessionSeverity }): React.ReactElement {
  const common = { size: 12 } as const;
  if (severity === 'critical') return <BatteryWarning {...common} />;
  if (severity === 'caution') return <BatteryMedium {...common} />;
  return <BatteryFull {...common} />;
}

function formatTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export interface TokenUsageIndicatorProps {
  /** 세션 한도(토큰). 생략 시 DEFAULT_SUBSCRIPTION_TOKEN_LIMIT. */
  tokenLimit?: number;
  /** 창 길이(ms). 생략 시 5시간. 테스트에서만 주입. */
  windowMs?: number;
  /** now() 주입 슬롯. 테스트에서만 사용. */
  nowProvider?: () => number;
}

export function TokenUsageIndicator({
  tokenLimit = DEFAULT_SUBSCRIPTION_TOKEN_LIMIT,
  windowMs = SUBSCRIPTION_SESSION_WINDOW_MS,
  nowProvider,
}: TokenUsageIndicatorProps = {}): React.ReactElement {
  const state = useSyncExternalStore(
    claudeTokenUsageStore.subscribe,
    claudeTokenUsageStore.getSnapshot,
    claudeTokenUsageStore.getSnapshot,
  );

  // 매 60초마다 now 를 갱신해 리셋 감지와 "X시간 Y분 후 리셋" 라벨을 최신화.
  // 30초 이하로 낮추면 매 카운트다운 분마다 두 번씩 리렌더되어 비용 대비 이득이 작다.
  const getNow = nowProvider ?? (() => Date.now());
  const [now, setNow] = useState<number>(() => getNow());
  useEffect(() => {
    const id = setInterval(() => setNow(getNow()), 60_000);
    return () => clearInterval(id);
    // getNow 가 prop 으로 바뀌는 케이스는 테스트 전용이라 deps 에서 제외.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 세션 상태는 useState 로 영속. 새로고침 시엔 null 로 리셋되는데, 순수 함수가
  // "prev=null → 지금을 시작점으로" 처리하므로 카운터가 이월되지 않는다.
  const [sessionState, setSessionState] = useState<SubscriptionSessionState | null>(null);
  // 리셋 감지 시 한 번만 스냅되는 "최근 리셋" 표식. UX 상 별도 배지/애니메이션에 쓰인다.
  const lastResetRef = useRef<number | null>(null);
  // 만료→재리셋 순간을 ~3초간 배지에 강조한다. 긴 깜빡임은 시선 분산 비용이 크므로
  // 1회성 펄스로만 노출하고 자동으로 평상시 팔레트로 복귀한다.
  const [justReset, setJustReset] = useState<boolean>(false);

  const hasError = Boolean(state.loadError);
  const cumulative = state.all.inputTokens + state.all.outputTokens;

  // 스냅샷을 렌더 단계에서 한 번 계산. 상태 쓰기는 useEffect 로 분리.
  const snapshot = useMemo(
    () => computeSubscriptionSessionSnapshot({
      prev: sessionState,
      cumulativeTokens: cumulative,
      nowMs: now,
      limit: tokenLimit,
      windowMs,
    }),
    [sessionState, cumulative, now, tokenLimit, windowMs],
  );

  // 스냅샷의 next state 가 prev 와 달라졌을 때만 커밋해 무한 루프를 방지.
  useEffect(() => {
    if (!sessionState
      || sessionState.windowStartMs !== snapshot.state.windowStartMs
      || sessionState.tokensAtWindowStart !== snapshot.state.tokensAtWindowStart) {
      setSessionState(snapshot.state);
      if (snapshot.isReset) lastResetRef.current = snapshot.state.windowStartMs;
    }
  }, [snapshot.state.windowStartMs, snapshot.state.tokensAtWindowStart, snapshot.isReset, sessionState]);

  // isReset 감지 후 ~3초간 배지를 강조. 새로고침 직후(최초 마운트) 는 isReset=false 이므로
  // 평시 팔레트 그대로 유지된다 — "재리셋 피드백" 이 깜빡임 대신 한 번의 펄스로만 보인다.
  useEffect(() => {
    if (!snapshot.isReset) return;
    setJustReset(true);
    const id = setTimeout(() => setJustReset(false), 3000);
    return () => clearTimeout(id);
  }, [snapshot.isReset, snapshot.state.windowStartMs]);

  const [hovered, setHovered] = useState(false);

  if (hasError) {
    // 폴백 배지 — 클릭/호버 상호작용 없이 "토큰 정보 없음" 한 줄만 표시해 UI 가 깨지지 않게.
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="토큰 정보 없음 — 잠시 후 다시 시도하세요"
        data-testid="token-usage-indicator"
        data-fallback="true"
        className="px-3 py-1 border-2 border-l-[6px] flex items-center gap-2"
        style={{
          background: 'var(--error-state-bg)',
          borderColor: 'var(--pixel-border)',
          borderLeftColor: 'var(--error-state-border)',
          color: 'var(--error-state-title-fg)',
        }}
      >
        <BatteryMedium size={12} style={{ color: 'var(--error-state-icon-fg)' }} aria-hidden="true" />
        <span>세션 토큰: --</span>
      </div>
    );
  }

  const palette = severityPalette(snapshot.severity);
  const ratioPct = Math.min(100, Math.max(0, Math.round(snapshot.ratioUsed * 100)));
  const resetClock = formatResetClock(snapshot.resetAtMs);
  const untilReset = formatTimeUntilReset(snapshot.resetAtMs, now);

  // 스크린리더 축은 시각 바(사용률) 와 같은 방향으로 읽히도록 "사용 N%, 남은
  // 토큰 X" 순서로 맞춘다. 이전 구현은 "(남은 N 퍼센트)" 였는데 바는 사용 비율을
  // 칠해 음성/시각이 반대를 가리켰다. 리셋 레이블은 `formatTimeUntilReset` 의
  // `Xh Ym / Ym / <1m` 포맷을 그대로 읽히게 둔다.
  const ariaLabel = `구독 세션 사용 ${ratioPct}%, 남은 토큰 ${formatTokensShort(snapshot.remaining)}, 약 ${untilReset} 뒤 리셋`;

  return (
    <div
      className="relative token-usage-indicator"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      data-testid="token-usage-indicator"
      data-severity={snapshot.severity}
      data-reset={snapshot.isReset ? 'true' : 'false'}
      data-just-reset={justReset ? 'true' : 'false'}
    >
      <div
        role="status"
        aria-live="polite"
        aria-label={ariaLabel}
        tabIndex={0}
        title={`구독 세션 남은 토큰 — ${untilReset} 뒤(${resetClock}) 리셋`}
        className="token-usage-indicator__badge px-3 py-1 border-2 border-l-[6px] flex items-center gap-2 cursor-help"
        style={{
          background: palette.bg,
          borderColor: 'var(--pixel-border)',
          borderLeftColor: palette.borderColor,
          color: palette.fg,
        }}
      >
        <span style={{ color: palette.iconColor }} aria-hidden="true">
          <SeverityIcon severity={snapshot.severity} />
        </span>
        <span data-testid="token-usage-indicator-summary">
          세션 토큰: {formatTokensShort(snapshot.remaining)} 남음
        </span>
        {/* 한눈 그래프 — 높이 3px 얇은 막대. 상단바 세로 공간에 과부하를 주지 않는다. */}
        <span
          role="presentation"
          aria-hidden="true"
          className="ml-1 inline-block relative"
          style={{
            width: 40,
            height: 3,
            background: 'var(--pixel-border)',
          }}
          data-testid="token-usage-indicator-bar"
          data-ratio={ratioPct}
        >
          <span
            className="absolute left-0 top-0 bottom-0"
            style={{
              width: `${ratioPct}%`,
              background: palette.barColor,
            }}
          />
        </span>
      </div>

      {hovered && (
        <div
          role="tooltip"
          data-testid="token-usage-indicator-tooltip"
          className="absolute top-full right-0 mt-1 z-50 min-w-[240px] p-3 text-[11px]"
          style={{
            background: 'var(--token-usage-tooltip-bg)',
            border: `2px solid var(--token-usage-tooltip-border)`,
            borderRadius: 'var(--token-usage-tooltip-radius)',
            boxShadow: 'var(--token-usage-tooltip-shadow)',
            color: 'var(--token-usage-tooltip-fg)',
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--token-usage-axis-input-fg)' }}>
              구독 세션(5시간)
            </span>
            <span className="text-[10px]" style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>
              {ratioPct}% 사용
            </span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>남은 토큰</dt>
            <dd className="text-right" style={{ color: palette.fg }} data-testid="token-usage-indicator-remaining">
              {formatTokensShort(snapshot.remaining)} / {formatTokensShort(snapshot.limit)}
            </dd>
            <dt style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>사용 토큰</dt>
            <dd className="text-right">{formatTokensShort(snapshot.used)}</dd>
            <dt style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>리셋 예정</dt>
            <dd className="text-right" data-testid="token-usage-indicator-reset">
              {resetClock} (약 {untilReset} 뒤)
            </dd>
          </dl>
          <div className="mt-2 pt-2 text-[10px]" style={{ borderTop: `1px solid var(--token-usage-tooltip-divider)`, color: 'var(--token-usage-tooltip-subtle-fg)' }}>
            * 구독 세션 한도는 대략치이며 실제 앤트로픽 정산 기준과 다를 수 있습니다. 기본 한도: {formatTokensShort(snapshot.limit)} / 5시간.
          </div>
        </div>
      )}
    </div>
  );
}
