import React, { useSyncExternalStore, useState, useEffect, useMemo } from 'react';
import { Cpu, Settings, AlertTriangle, RotateCcw, Ban } from 'lucide-react';
import {
  claudeTokenUsageStore,
  cacheHitRate,
  resolveUsageSeverity,
} from '../utils/claudeTokenUsageStore';
import {
  loadThresholdsFromStorage,
} from '../utils/claudeTokenUsageThresholds';
import { TokenUsageSettingsPanel } from './TokenUsageSettingsPanel';
import { classifyClaudeError } from '../server/claudeErrors';
import type {
  ClaudeTokenUsageTotals,
  ClaudeTokenUsageThresholds,
  ClaudeTokenUsageSeverity,
} from '../types';

// 상단 툴바(App.tsx <header>) 에 표시되는 Claude 토큰 사용량 위젯.
// 본 버전(#3b8038c7) 은 다음 네 확장을 포함:
//   1) localStorage 영속화 — 스토어가 마운트 시 자체 restoreFromStorage 수행.
//   2) '오늘/전체' 토글 — 툴팁 하단 버튼 2개. 로컬 자정 경계에서 today 자동 리셋.
//   3) 사용자 임계값 — 우클릭 또는 설정 아이콘 클릭으로 TokenUsageSettingsPanel 오픈.
//      저장된 임계값을 넘으면 배지 색상이 --token-usage-caution/warning-* 로 전환.
//   4) 에러 상태 — 스토어 loadError 가 비어있지 않으면 --error-state-* 토큰으로
//      배지 테두리를 교체해 "집계 실패" 를 시각적으로 드러낸다.
//
// 파일 충돌 범위: 본 위젯·TokenUsageSettingsPanel·스토어 3개만 편집하고, 상단바
// 마운트 지점인 App.tsx 는 건드리지 않는다(Joker PR 과의 충돌 회피).

function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function formatCostUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(1)}`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

type ViewMode = 'today' | 'all';

function pickTotals(state: { all: ClaudeTokenUsageTotals; today: ClaudeTokenUsageTotals }, view: ViewMode): ClaudeTokenUsageTotals {
  return view === 'today' ? state.today : state.all;
}

// severity → 테두리/아이콘 색 토큰 매핑.
// normal 단계는 SharedGoalModal 의 `--shared-goal-modal-field-focus` (cyan #7fd4ff)
// 와 숫자를 맞춰 "기본 중립 포커스/정보 색 = cyan" 의 프로젝트 전역 규약을 유지한다.
// caution / warning 은 각각 amber / red 로 SharedGoalModal 의 editing / error-strip
// 과 동일 숫자이므로, 상단바 상태 전이가 모달 입력·검증 상태 색과 시각적으로 묶인다.
function severityPalette(sev: ClaudeTokenUsageSeverity) {
  if (sev === 'warning') {
    return {
      borderColor: 'var(--token-usage-warning-border)',
      iconColor: 'var(--token-usage-warning-icon)',
      fg: 'var(--token-usage-warning-fg)',
      bg: 'var(--token-usage-warning-bg)',
    };
  }
  if (sev === 'caution') {
    return {
      borderColor: 'var(--token-usage-caution-border)',
      iconColor: 'var(--token-usage-caution-icon)',
      fg: 'var(--token-usage-caution-fg)',
      bg: 'var(--token-usage-caution-bg)',
    };
  }
  return {
    borderColor: 'var(--shared-goal-modal-field-focus)',
    iconColor: 'var(--token-usage-axis-input-fg)',
    fg: 'var(--shared-goal-modal-header-fg)',
    bg: 'var(--token-usage-badge-bg)',
  };
}

export function ClaudeTokenUsage() {
  const state = useSyncExternalStore(
    claudeTokenUsageStore.subscribe,
    claudeTokenUsageStore.getSnapshot,
    claudeTokenUsageStore.getSnapshot,
  );
  const [hovered, setHovered] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<ViewMode>('today');
  const [thresholds, setThresholds] = useState<ClaudeTokenUsageThresholds>(() => loadThresholdsFromStorage());

  // 최초 마운트 시 localStorage 에서 이전 세션의 누적을 복원한다. 서버 hydrate 는
  // App.tsx 가 초기 fetch + socket 으로 흘려주고, 이 복원은 서버 응답이 오기 전까지
  // 사용자가 "새로고침 직후 0 플리커" 를 보지 않게 해주는 역할이다.
  useEffect(() => {
    claudeTokenUsageStore.restoreFromStorage();
    // 에러 상태 감지용 자체 fetch — App.tsx 경로는 실패를 조용히 무시하므로, 본 위젯이
    // 재시도 책임을 소유한다. 성공 시 hydrate 가 loadError 를 null 로 되돌린다.
    fetch('/api/claude/token-usage')
      .then(async r => {
        if (!r.ok) {
          const headersObj: Record<string, string> = {};
          r.headers.forEach((v, k) => { headersObj[k] = v; });
          // `classifyClaudeError` 가 status/headers 를 읽을 수 있도록 원 에러 객체를 확장.
          const err = Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, headers: headersObj });
          throw err;
        }
        return r.json() as Promise<ClaudeTokenUsageTotals>;
      })
      .then(totals => claudeTokenUsageStore.hydrate(totals))
      .catch(err => {
        // 서버 응답 실패/네트워크 실패 모두 7종 카테고리 중 하나로 수렴시켜
        // 스토어의 errors 축에 누적한다. 기존 loadError UX(배지 빨강 테두리)는 유지.
        const classified = classifyClaudeError(err);
        try { claudeTokenUsageStore.recordError(classified.category); }
        catch { /* 누적 실패는 UI 에 영향 없음 */ }
        claudeTokenUsageStore.setError(classified.message || '네트워크 오류');
      });
  }, []);

  // 자정 경계 자동 롤오버: 페이지를 오래 켜 둔 상태에서 날짜가 바뀌면 today 축이
  // 자동으로 0 으로 떨어져야 한다. 1분 간격 타이머가 현재 날짜를 다시 찍어보고,
  // 스토어 내부 maybeRollOverDay 가 동일 날짜면 no-op. 부담 없는 비용.
  useEffect(() => {
    const id = setInterval(() => {
      // hydrate(all) 을 현재 all 로 호출하면 내부적으로 maybeRollOverDay 만 수행된다.
      claudeTokenUsageStore.hydrate(claudeTokenUsageStore.getSnapshot().all);
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const totals = useMemo(() => pickTotals(state, view), [state, view]);
  const severity = useMemo(() => resolveUsageSeverity(state.all, thresholds), [state.all, thresholds]);
  const palette = severityPalette(severity);
  const sumIO = totals.inputTokens + totals.outputTokens;
  const hitRate = cacheHitRate(totals);
  const hasError = Boolean(state.loadError);
  // 세션 폴백 상태(#cdaaabf3) — exhausted 이면 배지 위에 영구 배너가 덮이고 상호작용
  // 의미가 read-only 로 수렴된다. hasError 보다 우선순위가 낮지만(배지 테두리는
  // 에러가 이긴다), 상단 배너는 공존 가능.
  const isExhausted = state.sessionStatus === 'exhausted';
  // 아직 단 한 번의 Claude 호출도 집계되지 않은 "대기" 상태. hasError 와는 명확히
  // 다른 의미이므로(실패가 아님), --empty-state-* 팔레트의 subtle 톤을 빌려 배지
  // 글자만 한 단계 흐리게 내린다. 프로젝트 전역의 "빈 상태 = dimmer" 규약과 일치.
  const isEmpty = !hasError && totals.callCount === 0;

  const summaryLabel = totals.callCount === 0
    ? '호출 없음'
    : `${formatNumber(sumIO)} · ${formatCostUsd(totals.estimatedCostUsd)}`;

  // 에러 상태면 디자이너의 --error-state-* 팔레트로 테두리 교체. severity 와 동시
  // 충돌 시 에러가 우선한다(실패가 조치 1순위).
  const borderColor = hasError ? 'var(--error-state-border)' : palette.borderColor;
  const bg = hasError ? 'var(--error-state-bg)' : palette.bg;
  const iconColor = hasError ? 'var(--error-state-icon-fg)' : palette.iconColor;
  const fg = hasError
    ? 'var(--error-state-title-fg)'
    : (isEmpty ? 'var(--empty-state-subtle-fg)' : palette.fg);

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onContextMenu={e => { e.preventDefault(); setSettingsOpen(v => !v); }}
      data-testid="claude-token-usage"
      data-severity={severity}
      data-has-error={hasError ? 'true' : 'false'}
      data-empty={isEmpty ? 'true' : 'false'}
      data-view={view}
      data-session-status={state.sessionStatus}
    >
      <div
        tabIndex={0}
        role="button"
        aria-haspopup="dialog"
        aria-expanded={hovered || settingsOpen}
        aria-label={`Claude 토큰 사용량(${view === 'today' ? '오늘' : '전체'}): 입출력 ${formatNumber(sumIO)}, 대략 비용 ${formatCostUsd(totals.estimatedCostUsd)}, 호출 ${totals.callCount}회${hasError ? ', 집계 실패' : ''}`}
        title={hasError ? '토큰 집계 API 호출에 실패했습니다. 우클릭으로 임계값을 조정하거나 재시도하세요.' : 'Claude 토큰 사용량 (우클릭으로 임계값 설정)'}
        className="px-3 py-1 border-2 border-l-[6px] flex items-center gap-2 cursor-help"
        style={{
          background: bg,
          borderColor: 'var(--pixel-border)',
          borderLeftColor: borderColor,
          color: fg,
        }}
      >
        {hasError ? (
          <AlertTriangle size={12} style={{ color: iconColor }} data-testid="claude-token-error-icon" />
        ) : (
          <Cpu size={12} style={{ color: iconColor }} />
        )}
        <span data-testid="claude-token-summary" style={{ color: fg }}>
          {hasError ? '집계 실패' : `토큰: ${summaryLabel}`}
        </span>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); setSettingsOpen(v => !v); }}
          aria-label="토큰 사용량 임계값 설정 열기"
          data-testid="claude-token-settings-toggle"
          className="ml-1 text-white/50 hover:text-white"
        >
          <Settings size={11} />
        </button>
      </div>

      {hovered && !settingsOpen && (
        <div
          role="dialog"
          aria-label="Claude 토큰 사용량 상세"
          data-testid="claude-token-usage-tooltip"
          className="absolute top-full right-0 mt-1 z-50 min-w-[280px] p-3 text-[11px]"
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
              Claude 토큰 사용량
            </span>
            <span className="text-[10px]" style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>
              호출 {totals.callCount}회
            </span>
          </div>

          {hasError && (
            <div
              role="alert"
              data-testid="claude-token-error-banner"
              className="mb-2 p-2 text-[10px] flex items-start gap-2"
              style={{
                background: 'var(--error-state-bg)',
                border: `1px solid var(--error-state-border)`,
                borderLeft: `var(--error-state-strip-width) solid var(--error-state-strip)`,
                color: 'var(--error-state-title-fg)',
              }}
            >
              <AlertTriangle size={12} style={{ color: 'var(--error-state-icon-fg)' }} />
              <span>토큰 집계 API 호출이 실패했습니다: {state.loadError}</span>
            </div>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" style={{ color: 'var(--token-usage-tooltip-fg)' }}>
            <dt style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>입력</dt>
            <dd data-testid="claude-token-breakdown-input" className="text-right" style={{ color: 'var(--token-usage-axis-input-fg)' }}>{formatNumber(totals.inputTokens)}</dd>
            <dt style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>출력</dt>
            <dd data-testid="claude-token-breakdown-output" className="text-right" style={{ color: 'var(--token-usage-axis-output-fg)' }}>{formatNumber(totals.outputTokens)}</dd>
            <dt style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>캐시 읽기</dt>
            <dd data-testid="claude-token-breakdown-cache-read" className="text-right" style={{ color: 'var(--token-usage-axis-cache-read-fg)' }}>{formatNumber(totals.cacheReadTokens)}</dd>
            <dt style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>캐시 쓰기</dt>
            <dd data-testid="claude-token-breakdown-cache-write" className="text-right" style={{ color: 'var(--token-usage-axis-cache-create-fg)' }}>{formatNumber(totals.cacheCreationTokens)}</dd>
            <dt style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>캐시 히트율</dt>
            <dd data-testid="claude-token-breakdown-hit-rate" className="text-right" style={{ color: 'var(--token-usage-axis-cache-read-fg)' }}>{formatPercent(hitRate)}</dd>
            <dt style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>대략 비용</dt>
            <dd data-testid="claude-token-breakdown-cost" className="text-right" style={{ color: severity === 'normal' ? 'var(--token-usage-cost-fg)' : (severity === 'warning' ? 'var(--token-usage-cost-warning-fg)' : 'var(--token-usage-cost-caution-fg)') }}>{formatCostUsd(totals.estimatedCostUsd)}</dd>
          </dl>

          {Object.keys(totals.byModel).length > 0 && (
            <div className="mt-2 pt-2" style={{ borderTop: `1px solid var(--token-usage-tooltip-divider)` }}>
              <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>모델별</div>
              <ul data-testid="claude-token-by-model" className="space-y-0.5">
                {(Object.entries(totals.byModel) as [string, ClaudeTokenUsageTotals['byModel'][string]][]).map(([model, m]) => (
                  <li key={model} className="flex items-center justify-between gap-2">
                    <span className="truncate max-w-[140px]" title={model}>{model}</span>
                    <span style={{ color: 'var(--token-usage-tooltip-subtle-fg)' }}>
                      {formatNumber(m.inputTokens + m.outputTokens)} · {formatCostUsd(m.estimatedCostUsd)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 오늘/전체 토글 — 툴팁 하단 */}
          <div
            className="mt-2 pt-2 flex items-center justify-between"
            style={{ borderTop: `1px solid var(--token-usage-tooltip-divider)` }}
            data-testid="claude-token-view-toggle"
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setView('today')}
                aria-pressed={view === 'today'}
                data-testid="claude-token-view-today"
                className="text-[10px] px-2 py-1 border transition-colors"
                style={{
                  background: view === 'today' ? 'var(--token-usage-axis-input-fg)' : 'transparent',
                  color: view === 'today' ? 'var(--shared-goal-modal-surface)' : 'var(--token-usage-tooltip-fg)',
                  borderColor: 'var(--token-usage-tooltip-border)',
                }}
              >
                오늘 ({state.todayDate})
              </button>
              <button
                type="button"
                onClick={() => setView('all')}
                aria-pressed={view === 'all'}
                data-testid="claude-token-view-all"
                className="text-[10px] px-2 py-1 border transition-colors"
                style={{
                  background: view === 'all' ? 'var(--token-usage-axis-input-fg)' : 'transparent',
                  color: view === 'all' ? 'var(--shared-goal-modal-surface)' : 'var(--token-usage-tooltip-fg)',
                  borderColor: 'var(--token-usage-tooltip-border)',
                }}
              >
                전체
              </button>
            </div>
            <button
              type="button"
              onClick={() => claudeTokenUsageStore.resetToday()}
              aria-label="오늘 축만 0 으로 리셋"
              data-testid="claude-token-reset-today-inline"
              className="inline-flex items-center gap-1 text-[10px] px-2 py-1"
              style={{
                color: 'var(--token-usage-reset-fg)',
                border: `1px solid var(--token-usage-reset-border)`,
              }}
            >
              <RotateCcw size={10} /> 오늘 리셋
            </button>
          </div>

          <div className="mt-2 pt-2 text-[10px]" style={{ borderTop: `1px solid var(--token-usage-tooltip-divider)`, color: 'var(--token-usage-tooltip-subtle-fg)' }}>
            * 누적은 새로고침 후에도 유지됩니다(localStorage). 배지를 우클릭하면 임계값 설정이 열립니다.
          </div>
        </div>
      )}

      {settingsOpen && (
        <TokenUsageSettingsPanel
          initial={thresholds}
          onClose={() => setSettingsOpen(false)}
          onApply={next => setThresholds(next)}
          onResetToday={() => claudeTokenUsageStore.resetToday()}
        />
      )}

      {isExhausted && (
        /* 세션 토큰 소진 영구 배너(#cdaaabf3) — 배지 바로 아래 고정. 상호작용 없이 읽기
           전용 안내만 담당한다(버튼 비활성은 DirectivePrompt·SharedGoalForm 이 별도로 책임).
           role="alert" + aria-live="assertive" 로 접근성 경로에 즉시 고지된다. */
        <div
          role="alert"
          aria-live="assertive"
          data-testid="claude-token-exhausted-banner"
          className="absolute top-full right-0 mt-1 z-40 min-w-[260px] p-2 text-[11px] flex items-start gap-2"
          style={{
            background: 'var(--error-state-bg)',
            border: `2px solid var(--error-state-border)`,
            borderLeft: `var(--error-state-strip-width) solid var(--error-state-strip)`,
            color: 'var(--error-state-title-fg)',
            boxShadow: 'var(--token-usage-tooltip-shadow)',
          }}
        >
          <Ban size={14} style={{ color: 'var(--error-state-icon-fg)', marginTop: 1 }} aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <div className="font-bold">토큰 소진 — 읽기 전용</div>
            <div className="mt-0.5 opacity-90">
              {state.sessionStatusReason?.trim()
                || '구독 세션 토큰이 모두 사용되었습니다. 지시 전송과 자동 개발 트리거가 일시 중지됩니다.'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
