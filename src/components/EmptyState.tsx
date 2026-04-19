import React from 'react';
import { Inbox, Loader2 } from 'lucide-react';
import { useReducedMotion } from '../utils/useReducedMotion';

// EmptyState · 로딩/빈 상태 일관 표기 컴포넌트.
// 시안: docs/ux-cleanup-visual-2026-04-19.md §5 (로딩·빈·에러 3종 템플릿).
//
// 사용 원칙(시안 §2 원칙 카드 B-03):
//   - null 렌더 금지 — 하이드레이션 중에도 반드시 "자리" 를 차지해 layout shift 를 제거한다.
//   - 로딩은 접근성상 `role="status"` + `aria-live="polite"` 로 스크린리더에 1회 낭독.
//   - 빈은 정적 영역 — `role` 을 붙이지 않는다. 사용자가 탭으로 들어왔을 때만 레이블을 읽힘.
//
// 토큰: src/index.css 의 `--empty-state-*` 를 그대로 소비한다. 새 시각을 만들 때
// 이 컴포넌트를 건드리지 말고 토큰만 조정하라(네이밍 의도: §4.1).

export type EmptyStateVariant = 'empty' | 'loading';

export interface EmptyStateProps {
  variant?: EmptyStateVariant;
  title: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  action?: {
    label: string;
    onClick: () => void;
    testId?: string;
  };
  /** 컨테이너에 `--empty-state-min-height` (160px) 를 적용할지 여부. 기본 true. */
  fillMinHeight?: boolean;
  /** 외부에서 별도의 식별자가 필요할 때(기존 테스트 계약과 맞물림). */
  testId?: string;
  className?: string;
}

export function EmptyState({
  variant = 'empty',
  title,
  description,
  icon,
  action,
  fillMinHeight = true,
  testId,
  className,
}: EmptyStateProps) {
  const reducedMotion = useReducedMotion();
  const isLoading = variant === 'loading';

  const defaultIcon = isLoading ? (
    <Loader2
      size={24}
      aria-hidden="true"
      style={{ color: 'var(--empty-state-icon-fg)' }}
      className={reducedMotion ? undefined : 'animate-spin'}
    />
  ) : (
    <Inbox
      size={24}
      aria-hidden="true"
      style={{ color: 'var(--empty-state-icon-fg)' }}
    />
  );

  return (
    <div
      data-testid={testId}
      data-empty-state-variant={variant}
      role={isLoading ? 'status' : undefined}
      aria-live={isLoading ? 'polite' : undefined}
      className={className}
      style={{
        background: 'var(--empty-state-bg)',
        border: `2px ${`var(--empty-state-border-style)`} var(--empty-state-border)`,
        borderStyle: `var(--empty-state-border-style)` as React.CSSProperties['borderStyle'],
        borderRadius: 'var(--empty-state-radius)',
        padding: 'var(--empty-state-padding)',
        minHeight: fillMinHeight ? 'var(--empty-state-min-height)' : undefined,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        textAlign: 'center',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--empty-state-icon-halo)',
        }}
      >
        {icon ?? defaultIcon}
      </div>
      <div
        className="text-[13px] font-bold tracking-wide"
        style={{ color: 'var(--empty-state-title-fg)' }}
      >
        {title}
      </div>
      {description && (
        <div
          className="text-[11px] leading-relaxed"
          style={{ color: 'var(--empty-state-subtle-fg)', maxWidth: 360 }}
        >
          {description}
        </div>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          data-testid={action.testId}
          className="mt-1 px-3 py-1 text-[11px] uppercase tracking-wider"
          style={{
            background: 'transparent',
            border: `1px solid var(--empty-state-cta-border)`,
            color: 'var(--empty-state-cta-fg)',
            borderRadius: 4,
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
