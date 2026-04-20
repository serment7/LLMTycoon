// 지시 #17e58c0f · 설정 내 토큰 사용량 상세 패널.
//
// 구성(시안 `docs/design/token-usage-panel.md` 기준)
//   ① 최근 7세션 추세 스파크라인 — `sessions` 배열을 뒤에서 7개만 잘라 사용. 세로축은
//      정규화(min=0, max=1). 단일 값만 있으면 수평선.
//   ② 에이전트별 상위 3건 — `topAgents` 내림차순 top3. 절대값·비중(%) 을 함께 노출.
//   ③ 자동 컨텍스트 압축 이력 타임라인 — `compactions` 최신 10건. 각 항목에 절감
//      토큰량을 `tokenUsage.panel.savedTokens` 키로 로캘화.
//
// 본 컴포넌트는 순수 렌더 + 단일 prop `viewModel` 만 받는다. 데이터 소스/구독은
// 상위(TokenUsageIndicator + UsageSource) 가 담당.

import React, { useMemo } from 'react';

import { translate, useLocale } from '../../i18n';
import {
  formatCompactTokens,
  formatInteger,
  formatPercent,
  normalizeSparkline,
  type TokenFormatterLocale,
  type TokenUsageViewModel,
} from '../tokenFormatting';

export interface TokenUsagePanelProps {
  readonly viewModel: TokenUsageViewModel;
  readonly forceLocale?: TokenFormatterLocale;
}

function Sparkline({ points }: { points: readonly number[] }): React.ReactElement | null {
  if (points.length === 0) return null;
  const width = 140;
  const height = 36;
  if (points.length === 1) {
    return (
      <svg
        className="tup-sparkline"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
      >
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="currentColor" />
      </svg>
    );
  }
  const step = width / (points.length - 1);
  const d = points
    .map((n, i) => {
      const x = i * step;
      const y = height - n * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg
      className="tup-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

export function TokenUsagePanel({ viewModel, forceLocale }: TokenUsagePanelProps): React.ReactElement {
  const hookLocale = useLocale();
  const locale = (forceLocale ?? hookLocale.locale) as TokenFormatterLocale;
  const t = (key: string) => translate(key, locale);

  const last7 = useMemo(() => {
    const sessions = viewModel.sessions ?? [];
    return sessions.slice(-7);
  }, [viewModel.sessions]);
  const spark = useMemo(() => normalizeSparkline(last7), [last7]);

  const topAgents = useMemo(() => {
    const agents = [...(viewModel.topAgents ?? [])];
    agents.sort((a, b) => b.total - a.total);
    const top3 = agents.slice(0, 3);
    const sum = top3.reduce((acc, a) => acc + Math.max(0, a.total), 0) || 1;
    return top3.map((a) => ({ ...a, share: Math.max(0, a.total) / sum }));
  }, [viewModel.topAgents]);

  const compactions = useMemo(() => {
    const events = viewModel.compactions ?? [];
    return events.slice(-10).reverse();
  }, [viewModel.compactions]);

  const hasAny =
    (viewModel.sessions?.length ?? 0) > 0 ||
    (viewModel.topAgents?.length ?? 0) > 0 ||
    (viewModel.compactions?.length ?? 0) > 0;

  return (
    <section className="token-usage-panel" aria-label={t('tokenUsage.panel.title')}>
      <h3 className="tup-title">{t('tokenUsage.panel.title')}</h3>
      {!hasAny && <p className="tup-empty">{t('tokenUsage.panel.empty')}</p>}

      <div className="tup-section">
        <h4>{t('tokenUsage.panel.trend')}</h4>
        <Sparkline points={spark} />
      </div>

      <div className="tup-section">
        <h4>{t('tokenUsage.panel.topAgents')}</h4>
        <ol className="tup-agents">
          {topAgents.map((a) => (
            <li key={a.agent}>
              <span className="tup-agent-name">{a.agent}</span>
              <span className="tup-agent-total tw-numeric">{formatInteger(a.total, locale)}</span>
              <span className="tup-agent-share tw-numeric">{formatPercent(a.share, locale)}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="tup-section">
        <h4>{t('tokenUsage.panel.compactions')}</h4>
        <ul className="tup-compactions">
          {compactions.map((c) => (
            <li key={`${c.at}-${c.agent ?? 'n/a'}`}>
              <time dateTime={c.at} className="tup-compaction-at tw-numeric">{c.at}</time>
              {c.agent && <span className="tup-compaction-agent">{c.agent}</span>}
              <span className="tup-compaction-saved tw-numeric">
                {t('tokenUsage.panel.savedTokens').replace(
                  '{count}',
                  formatCompactTokens(c.savedTokens, locale),
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
