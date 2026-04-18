import React, { useSyncExternalStore, useState } from 'react';
import { Cpu } from 'lucide-react';
import { claudeTokenUsageStore, cacheHitRate } from '../utils/claudeTokenUsageStore';
import type { ClaudeTokenUsageTotals } from '../types';

// 상단 툴바(App.tsx <header>) 에 표시되는 Claude 토큰 사용량 위젯.
//  - 숫자 요약: "입력+출력 합계 토큰 · 대략 비용" 을 한 줄 배지로.
//  - 호버 시 상세 breakdown: 입력/출력/캐시 읽기/캐시 쓰기/호출 횟수/모델별 누적/
//    캐시 히트율 을 작은 패널로 노출.
//  - 동기화: `claudeTokenUsageStore` 외부 스토어 구독(useSyncExternalStore).
//    서버 권위 값은 App.tsx 가 초기 fetch + socket.on('claude-usage:updated')
//    로 store.hydrate/applyDelta 를 호출해 흘려보낸다.
//
// 디자인 톤은 상단바 다른 배지와 맞춰 흑색 30% + 픽셀 보더를 공유하며,
// 비용은 $ 접두 3자리 이상 시 소수점 1자리로 자동 축약해 "$12.3" 형식으로.

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

export function ClaudeTokenUsage() {
  const totals = useSyncExternalStore(
    claudeTokenUsageStore.subscribe,
    claudeTokenUsageStore.getSnapshot,
    claudeTokenUsageStore.getSnapshot,
  );
  const [hovered, setHovered] = useState(false);

  const sumIO = totals.inputTokens + totals.outputTokens;
  const hitRate = cacheHitRate(totals);

  const summaryLabel = totals.callCount === 0
    ? '호출 없음'
    : `${formatNumber(sumIO)} · ${formatCostUsd(totals.estimatedCostUsd)}`;

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      data-testid="claude-token-usage"
    >
      <div
        tabIndex={0}
        role="button"
        aria-haspopup="dialog"
        aria-expanded={hovered}
        aria-label={`Claude 토큰 사용량: 입출력 ${formatNumber(sumIO)}, 대략 비용 ${formatCostUsd(totals.estimatedCostUsd)}, 호출 ${totals.callCount}회`}
        title="Claude 토큰 사용량 (이 브라우저 세션 기준 누적)"
        className="bg-black/30 px-3 py-1 border-2 border-[var(--pixel-border)] border-l-[6px] flex items-center gap-2 cursor-help"
        style={{ borderLeftColor: '#7fd4ff' }}
      >
        <Cpu size={12} className="text-[#7fd4ff]" />
        <span className="text-white/90" data-testid="claude-token-summary">
          토큰: {summaryLabel}
        </span>
      </div>

      {hovered && (
        <div
          role="dialog"
          aria-label="Claude 토큰 사용량 상세"
          data-testid="claude-token-usage-tooltip"
          className="absolute top-full right-0 mt-1 z-50 min-w-[260px] bg-[#0f1b3b] border-2 border-[var(--pixel-border)] p-3 shadow-[0_18px_48px_rgba(0,0,0,0.55)] text-[11px] text-white/85"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wider text-[#7fd4ff]">Claude 토큰 사용량</span>
            <span className="text-white/50 text-[10px]">호출 {totals.callCount}회</span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-white/60">입력</dt>
            <dd data-testid="claude-token-breakdown-input" className="text-right">{formatNumber(totals.inputTokens)}</dd>
            <dt className="text-white/60">출력</dt>
            <dd data-testid="claude-token-breakdown-output" className="text-right">{formatNumber(totals.outputTokens)}</dd>
            <dt className="text-white/60">캐시 읽기</dt>
            <dd data-testid="claude-token-breakdown-cache-read" className="text-right">{formatNumber(totals.cacheReadTokens)}</dd>
            <dt className="text-white/60">캐시 쓰기</dt>
            <dd data-testid="claude-token-breakdown-cache-write" className="text-right">{formatNumber(totals.cacheCreationTokens)}</dd>
            <dt className="text-white/60">캐시 히트율</dt>
            <dd data-testid="claude-token-breakdown-hit-rate" className="text-right" style={{ color: '#34d399' }}>{formatPercent(hitRate)}</dd>
            <dt className="text-white/60">대략 비용</dt>
            <dd data-testid="claude-token-breakdown-cost" className="text-right" style={{ color: '#fbbf24' }}>{formatCostUsd(totals.estimatedCostUsd)}</dd>
          </dl>
          {Object.keys(totals.byModel).length > 0 && (
            <div className="mt-2 pt-2 border-t border-white/10">
              <div className="text-[10px] uppercase tracking-wider text-white/50 mb-1">모델별</div>
              <ul data-testid="claude-token-by-model" className="space-y-0.5">
                {Object.entries(totals.byModel).map(([model, m]) => (
                  <li key={model} className="flex items-center justify-between gap-2">
                    <span className="truncate max-w-[140px]" title={model}>{model}</span>
                    <span className="text-white/70">
                      {formatNumber(m.inputTokens + m.outputTokens)} · {formatCostUsd(m.estimatedCostUsd)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-2 pt-2 border-t border-white/10 text-[10px] text-white/45">
            * 이 브라우저 세션 누적. 서버 재기동 시 총계가 초기화됩니다.
          </div>
        </div>
      )}
    </div>
  );
}
