// 지시 #97bdee2b · multimedia-ui-spec.md §5 — 생성 카드 버튼 3종 공용 컴포넌트.
//
// 기존 `MediaPipelinePanel` 의 평면 버튼(`onGenerate({kind, prompt})`) 을 스펙 §5
// 가 요구하는 "카드 3장(영상 · PDF · PPT)" 형태로 승격할 때 재사용할 단일 프레젠테이션
// 카드. 본 컴포넌트는 네트워크 호출을 직접 하지 않는다 — 부모가 `onStart` 핸들러에서
// 실제 export 흐름(`exportVideo` / `exportPdfReport` / `exportPptxDeck`) 을 트리거한다.
//
// 상태 3종(§4.3):
//   · ready       — 기본 상태. 카드 hover 시 상단 1px cyan 강조선, 클릭 가능.
//   · generating  — 부모가 생성을 시작하면 넘겨 준다. 버튼 disabled + aria-busy.
//   · failed      — 실패하면 "재생성" 라벨로 바뀌고 오류 카피가 2번째 줄에 노출된다.
//
// 접근성
//   · 루트는 `<article role="group">` + 카드별 `aria-labelledby`/`aria-describedby`.
//   · CTA 는 실제 `<button type="button">` 로 키보드 Enter/Space 기본 동작 유지.
//   · `prefers-reduced-motion` 시 hover 모션 전이 시간은 CSS 변수 선언에 맡긴다.

import React from 'react';
import { Film, FileText, Presentation, Sparkles } from 'lucide-react';

export type MediaGenerationKind = 'video' | 'pdf' | 'pptx';

export type MediaGenerationCardStatus = 'ready' | 'generating' | 'failed';

export interface MediaGenerationCardProps {
  kind: MediaGenerationKind;
  /** 제목 — 예: "영상 생성". 미지정 시 kind 기본값. */
  title?: string;
  /** 1번째 설명줄(모델·분량). 예: "Sora / Veo · 30초 · 1080p". */
  subtitle?: string;
  /** 2번째 설명줄(선택) — 카드 높이를 일정하게 유지하기 위해 비어 있어도 자리는 남긴다. */
  detail?: string;
  status?: MediaGenerationCardStatus;
  /** status==='failed' 일 때 2번째 줄에 노출될 오류 카피(§3.1). */
  errorMessage?: string;
  onStart: (kind: MediaGenerationKind) => void;
  disabled?: boolean;
  className?: string;
}

interface KindPreset {
  title: string;
  subtitle: string;
  detail: string;
  Icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}

const PRESETS: Record<MediaGenerationKind, KindPreset> = {
  video: {
    title: '영상 생성',
    subtitle: 'Sora / Veo',
    detail: '30초 · 1080p',
    Icon: Film,
  },
  pdf: {
    title: 'PDF 리포트',
    subtitle: '요약 · 차트',
    detail: '12쪽 · A4',
    Icon: FileText,
  },
  pptx: {
    title: 'PPT 덱 생성',
    subtitle: '24슬 표준',
    detail: '제목/본문/이미지',
    Icon: Presentation,
  },
};

const STATUS_CTA_LABEL: Record<MediaGenerationCardStatus, string> = {
  ready: '생성 시작 →',
  generating: '생성 중…',
  failed: '재생성',
};

export function MediaGenerationCard(props: MediaGenerationCardProps): React.ReactElement {
  const {
    kind,
    status = 'ready',
    errorMessage,
    onStart,
    disabled,
    className,
  } = props;
  const preset = PRESETS[kind];
  const title = props.title ?? preset.title;
  const subtitle = props.subtitle ?? preset.subtitle;
  const detail = props.detail ?? preset.detail;
  const Icon = preset.Icon;

  const titleId = `media-gen-card-${kind}-title`;
  const descId = `media-gen-card-${kind}-desc`;
  const cta = STATUS_CTA_LABEL[status];
  const isGenerating = status === 'generating';
  const isFailed = status === 'failed';

  return (
    <article
      role="group"
      aria-labelledby={titleId}
      aria-describedby={descId}
      aria-busy={isGenerating || undefined}
      data-testid={`media-generation-card-${kind}`}
      data-status={status}
      className={`media-generation-card${className ? ` ${className}` : ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 12,
        minWidth: 160,
        background: 'var(--media-asset-surface-bg)',
        border: `1px solid ${isFailed ? 'var(--error-state-border)' : 'var(--attachment-preview-border)'}`,
        borderRadius: 8,
        transition: 'border-color var(--motion-duration-xs, 120ms) ease',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon size={14} aria-hidden={true} />
        <h4
          id={titleId}
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          {title}
        </h4>
      </header>

      <p
        id={descId}
        style={{
          margin: 0,
          fontSize: 11,
          opacity: 0.85,
          lineHeight: 1.4,
        }}
      >
        {subtitle}
        {detail ? <><br />{detail}</> : null}
      </p>

      {isFailed && errorMessage ? (
        <p
          role="alert"
          data-testid={`media-generation-card-${kind}-error`}
          style={{
            margin: 0,
            fontSize: 10,
            color: 'var(--error-state-fg)',
          }}
        >
          {errorMessage}
        </p>
      ) : null}

      <button
        type="button"
        data-testid={`media-generation-card-${kind}-cta`}
        onClick={() => onStart(kind)}
        disabled={disabled || isGenerating}
        style={{
          marginTop: 4,
          padding: '6px 10px',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          background: isFailed
            ? 'var(--error-state-bg)'
            : 'var(--shared-goal-modal-confirm-bg)',
          color: isFailed
            ? 'var(--error-state-fg)'
            : 'var(--shared-goal-modal-confirm-fg)',
          border: `1px solid ${isFailed ? 'var(--error-state-border)' : 'var(--attachment-preview-border)'}`,
          cursor: disabled || isGenerating ? 'not-allowed' : 'pointer',
          opacity: disabled || isGenerating ? 0.7 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          justifyContent: 'center',
        }}
      >
        {isGenerating ? <Sparkles size={10} aria-hidden={true} /> : null}
        {cta}
      </button>
    </article>
  );
}

export default MediaGenerationCard;
