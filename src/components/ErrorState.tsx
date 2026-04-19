import React from 'react';
import { AlertTriangle } from 'lucide-react';

// ErrorState · 에러 상태 일관 표기 컴포넌트.
// 시안: docs/ux-cleanup-visual-2026-04-19.md §5 (로딩·빈·에러 3종 템플릿).
//
// 사용 원칙(시안 §2 원칙 카드 B-02):
//   - `role="alert"` + `aria-live="assertive"` — 에러가 나타나는 순간 즉시 낭독.
//   - primary CTA 는 [재시도]. secondary 는 [닫기]. 버튼은 optional 이며, 있으면
//     우측 정렬(시안 §5.1).
//   - 좌측 4px 수직 스트립(`--error-state-strip`) 으로 "빨강=조치 필요" 를 색 아닌
//     형태로도 전달(색각 이상 대응).
//
// 토큰: src/index.css 의 `--error-state-*` 를 그대로 소비한다.

export interface ErrorStateProps {
  title: string;
  description?: React.ReactNode;
  onRetry?: () => void;
  onDismiss?: () => void;
  retryLabel?: string;
  dismissLabel?: string;
  retryDisabled?: boolean;
  /** data-testid — 기존 인라인 배너 테스트 계약과 맞물릴 때 사용. */
  testId?: string;
  className?: string;
}

export function ErrorState({
  title,
  description,
  onRetry,
  onDismiss,
  retryLabel = '재시도',
  dismissLabel = '닫기',
  retryDisabled = false,
  testId,
  className,
}: ErrorStateProps) {
  return (
    <div
      data-testid={testId}
      role="alert"
      aria-live="assertive"
      className={className}
      style={{
        background: 'var(--error-state-bg)',
        border: `1px solid var(--error-state-border)`,
        borderLeft: `var(--error-state-strip-width) solid var(--error-state-strip)`,
        borderRadius: 'var(--error-state-radius)',
        padding: 'var(--error-state-padding)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div className="flex items-start gap-2">
        <div
          aria-hidden="true"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--error-state-icon-halo)',
            flexShrink: 0,
          }}
        >
          <AlertTriangle size={14} style={{ color: 'var(--error-state-icon-fg)' }} />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="text-[12px] font-bold tracking-wide"
            style={{ color: 'var(--error-state-title-fg)' }}
          >
            {title}
          </div>
          {description && (
            <div
              className="mt-1 text-[11px] leading-relaxed"
              style={{ color: 'var(--error-state-subtle-fg)' }}
            >
              {description}
            </div>
          )}
        </div>
      </div>
      {(onRetry || onDismiss) && (
        <div className="flex items-center justify-end gap-2">
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              data-testid={testId ? `${testId}-dismiss` : undefined}
              className="px-3 py-1 text-[11px] uppercase tracking-wider"
              style={{
                background: 'transparent',
                border: `1px solid var(--error-state-secondary-border)`,
                color: 'var(--error-state-secondary-fg)',
                borderRadius: 4,
              }}
            >
              {dismissLabel}
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retryDisabled}
              data-testid={testId ? `${testId}-retry` : undefined}
              className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider disabled:cursor-not-allowed"
              style={{
                background: retryDisabled
                  ? 'var(--error-state-retry-disabled-bg)'
                  : 'var(--error-state-retry-bg)',
                border: `1px solid var(--error-state-retry-border)`,
                color: 'var(--error-state-retry-fg)',
                borderRadius: 4,
              }}
            >
              {retryLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
