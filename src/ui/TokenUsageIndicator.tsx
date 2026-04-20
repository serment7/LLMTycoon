// 지시 #17e58c0f · 상단 토큰 사용량 인디케이터.
//
// 정책
//   · UI 는 `TokenUsageViewModel` 을 props 로 받아 렌더만. 실시간 구독 로직은
//     `usageSource` 프로퍼티 훅(선택)을 통해 외부(예: Thanos 의 usageLog JSON lines
//     또는 소켓) 이 결정한다 — 본 모듈은 transport 비중립.
//   · 고정폭 숫자 정렬을 위해 수치 노출 요소에 className `tw-numeric` 을 부여(스타일
//     토큰은 별도 PR 담당).
//   · 자동 컨텍스트 압축 감지 — `compactions` 배열의 마지막 항목이 변하면
//     `tokenUsage.toast.compacted` 키로 토스트 1회 발화. `onCompacted` 콜백이 주어지면
//     콜백을 우선 호출(상위가 제어). 토스트 발화는 `components/ToastProvider::toastBus`
//     을 사용한다.

import React, { useEffect, useMemo, useRef } from 'react';

import { toastBus } from '../components/ToastProvider';
import { translate, useLocale } from '../i18n';
import {
  computeSegmentRatios,
  computeUsageRatio,
  formatCompactTokens,
  formatPercent,
  type CompactionEvent,
  type TokenFormatterLocale,
  type TokenUsageSnapshot,
  type TokenUsageViewModel,
} from './tokenFormatting';

export interface UsageSource {
  readonly snapshot: () => TokenUsageViewModel;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface TokenUsageIndicatorProps {
  /** 정적 데이터. `usageSource` 와 동시에 주면 usageSource 가 우선한다. */
  readonly viewModel?: TokenUsageViewModel;
  /** 실시간 스트림. 본 props 가 오면 useSyncExternalStore 로 구독. */
  readonly usageSource?: UsageSource;
  /** 테스트 결정성 위해 locale 강제. 미주입 시 useLocale. */
  readonly forceLocale?: TokenFormatterLocale;
  /**
   * 자동 압축 감지 콜백. 정의되면 toast 발화 대신 콜백만 실행 → 상위가
   * 정책(토스트/배너/조용) 을 결정한다. 정의 안 되면 toastBus 로 `tokenUsage.toast.compacted` 토스트.
   */
  readonly onCompacted?: (event: CompactionEvent) => void;
}

function useViewModel(props: TokenUsageIndicatorProps): TokenUsageViewModel {
  const source = props.usageSource;
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!source) return;
    return source.subscribe(() => force());
  }, [source]);
  if (source) return source.snapshot();
  return (
    props.viewModel ?? {
      current: { input: 0, output: 0, cacheHit: 0 },
    }
  );
}

function useAutoCompactWatcher(
  vm: TokenUsageViewModel,
  locale: TokenFormatterLocale,
  onCompacted?: (event: CompactionEvent) => void,
): void {
  const lastSeenAtRef = useRef<string | null>(null);
  const compactions = vm.compactions ?? [];
  const latest = compactions.length > 0 ? compactions[compactions.length - 1] : null;

  useEffect(() => {
    if (!latest) return;
    if (lastSeenAtRef.current === latest.at) return;
    const isFirstSeen = lastSeenAtRef.current === null;
    lastSeenAtRef.current = latest.at;
    // 첫 렌더(lastSeenAtRef=null) 는 "과거 이력을 읽어들인" 상황일 수 있으므로 토스트를
    // 쏘지 않는다. 실제 신규 이벤트(=두 번째 이후) 부터 발화해 스팸을 방지.
    if (isFirstSeen) return;
    if (onCompacted) {
      onCompacted(latest);
      return;
    }
    const savedTokens = Math.max(0, latest.savedTokens);
    const template = translate('tokenUsage.toast.compacted', locale);
    const title = template.replace(
      '{count}',
      formatCompactTokens(savedTokens, locale),
    );
    toastBus.emit({ variant: 'info', title });
  }, [latest?.at, latest?.savedTokens, locale, onCompacted]);
}

export function TokenUsageIndicator(props: TokenUsageIndicatorProps): React.ReactElement {
  const hookLocale = useLocale();
  const locale = (props.forceLocale ?? hookLocale.locale) as TokenFormatterLocale;
  const vm = useViewModel(props);
  useAutoCompactWatcher(vm, locale, props.onCompacted);

  const snapshot: TokenUsageSnapshot = vm.current;
  const segments = useMemo(() => computeSegmentRatios(snapshot), [snapshot]);
  const usageRatio = computeUsageRatio(snapshot);

  const t = (key: string) => translate(key, locale);
  const totalUsed = snapshot.input + snapshot.output;

  return (
    <div className="token-usage-indicator" role="group" aria-label={t('tokenUsage.indicator.label')}>
      <span className="tui-label">{t('tokenUsage.indicator.label')}</span>
      <span className="tui-total tw-numeric" aria-live="polite">
        {formatCompactTokens(totalUsed, locale)}
      </span>
      <div
        className="tui-bar"
        role="meter"
        aria-label={t('tokenUsage.indicator.label')}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={usageRatio ?? 0}
      >
        <span
          className="tui-seg tui-seg-input"
          style={{ flexGrow: segments.input }}
          aria-label={t('tokenUsage.indicator.input')}
        />
        <span
          className="tui-seg tui-seg-output"
          style={{ flexGrow: segments.output }}
          aria-label={t('tokenUsage.indicator.output')}
        />
        <span
          className="tui-seg tui-seg-cache"
          style={{ flexGrow: segments.cacheHit }}
          aria-label={t('tokenUsage.indicator.cacheHit')}
        />
      </div>
      <span className="tui-remaining tw-numeric">
        {usageRatio === null
          ? t('tokenUsage.indicator.noLimit')
          : t('tokenUsage.indicator.remaining').replace('{percent}', formatPercent(usageRatio, locale))}
      </span>
    </div>
  );
}
