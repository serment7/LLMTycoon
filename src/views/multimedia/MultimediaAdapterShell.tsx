// 지시 #95de334d · 멀티미디어 어댑터 세부 뷰 공용 껍질.
//
// 시안(docs/designs/multimedia-hub.md) §3 "작업 영역" 의 4상태(빈·로딩·성공·오류) 를
// 5축(영상·PDF·PPT·웹검색·리서치·QA) 공통 골격으로 그려낸다. 본 컴포넌트는 입력 폼·
// 진행률·결과 프리뷰·오류 배너의 슬롯만 제공하고, 실제 내용은 각 어댑터 뷰가 주입한다.
//
// 레이아웃 규약(H-01~H-10 계승)
//   · min-height 는 `--media-hub-work-min-h`(360px) 토큰 값 그대로 — layout shift 0.
//   · 테두리는 `--attachment-preview-border`, 배경 `--media-asset-surface-bg`.
//   · 헤더는 아이콘 + 라벨 + 보조(경로 슬러그) · 우측에 [× 닫기] CTA.
//   · 오류 배너는 `role="alert"` · 좌 4px `--error-state-strip`.
//   · 진행률은 phase 3단계(precheck/upload/finalize) 세그먼트 바 + ratio 라벨.
//
// 본 파일은 `<canvas>` 등 외부 의존을 사용하지 않는다. 순수 Tailwind + 인라인 토큰만
// 사용해 SSR·테스트 렌더링에서도 즉시 동작한다.

import React from 'react';
import { X, AlertTriangle, Sparkles, CheckCircle2, Lock } from 'lucide-react';

import type { MultimediaCardMeta } from './routes';
import type { MultimediaJob } from './useMultimediaJobs';

export type MultimediaAdapterPhase = 'empty' | 'form' | 'loading' | 'success' | 'error';

export interface MultimediaAdapterShellProps {
  readonly card: MultimediaCardMeta;
  readonly phase: MultimediaAdapterPhase;
  readonly onClose?: () => void;
  /** 잠금(기본 OFF) 배지 노출 여부. 눌렀을 때 설정 화면으로 이동시키는 콜백. */
  readonly locked?: boolean;
  readonly unlockHint?: string;
  readonly onUnlockClick?: () => void;
  /** 진행 중인 작업(useMultimediaJobs 연결). 없으면 단일 run 상태로 대체. */
  readonly runningJob?: MultimediaJob;
  /** phase='error' 일 때 채워진다. */
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  /** 슬롯 — 각 어댑터 세부 뷰가 주입. */
  readonly formSlot?: React.ReactNode;
  readonly previewSlot?: React.ReactNode;
  readonly children?: React.ReactNode;
}

const PHASE_ROLE: Record<MultimediaAdapterPhase, { role: string; ariaLive: 'polite' | 'assertive' | 'off' }> = {
  empty: { role: 'region', ariaLive: 'off' },
  form: { role: 'region', ariaLive: 'off' },
  loading: { role: 'status', ariaLive: 'polite' },
  success: { role: 'status', ariaLive: 'polite' },
  error: { role: 'alert', ariaLive: 'polite' },
};

export function MultimediaAdapterShell(props: MultimediaAdapterShellProps): React.ReactElement {
  const { card, phase, runningJob } = props;
  const roleMeta = PHASE_ROLE[phase];
  const titleId = `mm-shell-${card.route}-title`;

  return (
    <section
      role={roleMeta.role}
      aria-labelledby={titleId}
      aria-live={roleMeta.ariaLive === 'off' ? undefined : roleMeta.ariaLive}
      aria-busy={phase === 'loading' || undefined}
      data-testid={`multimedia-shell-${card.route}`}
      data-phase={phase}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        minHeight: 'var(--media-hub-work-min-h, 360px)',
        background: 'var(--media-asset-surface-bg)',
        border: '1px solid var(--attachment-preview-border)',
        borderRadius: 8,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2
            id={titleId}
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            {card.label}
          </h2>
          <p style={{ margin: 0, fontSize: 11, opacity: 0.7 }}>
            {card.urlPath} · {card.subtitle}
          </p>
        </div>
        {props.onClose ? (
          <button
            type="button"
            onClick={props.onClose}
            data-testid={`multimedia-shell-${card.route}-close`}
            aria-label="닫기"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 10px',
              fontSize: 11,
              fontWeight: 700,
              background: 'transparent',
              color: 'var(--shared-goal-modal-header-fg, #fff)',
              border: '1px solid var(--attachment-preview-border)',
              cursor: 'pointer',
            }}
          >
            <X size={10} aria-hidden={true} /> 닫기
          </button>
        ) : null}
      </header>

      {props.locked ? (
        <div
          role="status"
          data-testid={`multimedia-shell-${card.route}-lock`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: 12,
            background: 'var(--token-usage-caution-bg, rgba(251,191,36,0.12))',
            border: '1px solid var(--token-usage-caution-border, rgba(251,191,36,0.45))',
            borderLeft: '4px solid var(--token-usage-caution-icon, #fbbf24)',
          }}
        >
          <Lock size={14} aria-hidden={true} />
          <div style={{ flex: 1, fontSize: 12 }}>
            <strong>활성화가 필요합니다.</strong>
            <p style={{ margin: '2px 0 0 0', fontSize: 11, opacity: 0.85 }}>
              {props.unlockHint ?? '관리자가 설정에서 해당 기능을 켜야 사용할 수 있어요.'}
            </p>
          </div>
          {props.onUnlockClick ? (
            <button
              type="button"
              onClick={props.onUnlockClick}
              data-testid={`multimedia-shell-${card.route}-unlock-cta`}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 700,
                background: 'var(--shared-goal-modal-confirm-bg)',
                color: 'var(--shared-goal-modal-confirm-fg)',
                border: '1px solid var(--attachment-preview-border)',
                cursor: 'pointer',
              }}
            >
              설정 열기
            </button>
          ) : null}
        </div>
      ) : null}

      {phase === 'empty' ? (
        <EmptyState card={card} />
      ) : null}

      {phase === 'form' ? (
        <div data-testid={`multimedia-shell-${card.route}-form`}>
          {props.formSlot}
        </div>
      ) : null}

      {phase === 'loading' ? (
        <LoadingState card={card} job={runningJob} />
      ) : null}

      {phase === 'success' ? (
        <SuccessState
          card={card}
          slot={props.previewSlot}
        />
      ) : null}

      {phase === 'error' ? (
        <ErrorBanner
          card={card}
          code={props.errorCode}
          message={props.errorMessage}
          onRetry={props.onRetry}
        />
      ) : null}

      {props.children}
    </section>
  );
}

function EmptyState({ card }: { card: MultimediaCardMeta }): React.ReactElement {
  return (
    <div
      data-testid={`multimedia-shell-${card.route}-empty`}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 24,
        color: 'var(--empty-state-subtle-fg, rgba(255,255,255,0.6))',
      }}
    >
      <Sparkles size={18} aria-hidden={true} />
      <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--empty-state-title-fg, #fff)' }}>
        {card.label} 을(를) 시작해 보세요
      </p>
      <p style={{ margin: 0, fontSize: 11 }}>
        위 카드에서 파이프라인을 골라 바로 실행할 수 있어요.
      </p>
    </div>
  );
}

function LoadingState({
  card,
  job,
}: {
  card: MultimediaCardMeta;
  job?: MultimediaJob;
}): React.ReactElement {
  const ratio = typeof job?.progress === 'number' ? Math.max(0, Math.min(1, job.progress)) : 0;
  const percent = Math.round(ratio * 100);
  return (
    <div data-testid={`multimedia-shell-${card.route}-loading`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ margin: 0, fontSize: 12 }}>
        {card.label} 진행 중 · {job?.phase ?? '처리'} · {percent}%
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        data-testid={`multimedia-shell-${card.route}-progress`}
        style={{
          height: 8,
          background: 'var(--token-gauge-track, rgba(255,255,255,0.12))',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            background: 'var(--shared-goal-modal-field-focus, #7fd4ff)',
            transition: 'width var(--motion-duration-sm, 140ms) ease',
          }}
        />
      </div>
      {job?.etaMs ? (
        <p style={{ margin: 0, fontSize: 11, opacity: 0.7 }}>
          남은 시간 약 {Math.max(1, Math.round(job.etaMs / 1000))}초
        </p>
      ) : null}
    </div>
  );
}

function SuccessState({
  card,
  slot,
}: {
  card: MultimediaCardMeta;
  slot?: React.ReactNode;
}): React.ReactElement {
  return (
    <div data-testid={`multimedia-shell-${card.route}-success`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <CheckCircle2 size={14} aria-hidden={true} color="var(--shared-goal-modal-confirm-bg, #34d399)" />
        <span style={{ fontSize: 12, fontWeight: 700 }}>
          {card.label} 가 완료됐어요
        </span>
      </header>
      <div style={{ fontSize: 12 }}>{slot}</div>
    </div>
  );
}

function ErrorBanner({
  card,
  code,
  message,
  onRetry,
}: {
  card: MultimediaCardMeta;
  code?: string;
  message?: string;
  onRetry?: () => void;
}): React.ReactElement {
  return (
    <div
      role="alert"
      data-testid={`multimedia-shell-${card.route}-error`}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: 12,
        background: 'var(--error-state-bg, rgba(248,113,113,0.08))',
        border: '1px solid var(--error-state-border, rgba(248,113,113,0.45))',
        borderLeft: '4px solid var(--error-state-strip, #f87171)',
      }}
    >
      <AlertTriangle size={14} aria-hidden={true} color="var(--error-state-fg, #fecaca)" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <strong style={{ fontSize: 12, color: 'var(--error-state-fg, #fecaca)' }}>
          {code ?? '실패'}
        </strong>
        <span style={{ fontSize: 11, opacity: 0.9 }}>
          {message ?? '작업이 실패했어요. 잠시 후 다시 시도해 주세요.'}
        </span>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          data-testid={`multimedia-shell-${card.route}-retry`}
          style={{
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 700,
            background: 'var(--attachment-preview-retry-bg, var(--pixel-accent, #00d2ff))',
            color: 'var(--attachment-preview-retry-fg, #000)',
            border: '1px solid var(--attachment-preview-retry-border, var(--pixel-accent, #00d2ff))',
            cursor: 'pointer',
          }}
        >
          재시도
        </button>
      ) : null}
    </div>
  );
}
