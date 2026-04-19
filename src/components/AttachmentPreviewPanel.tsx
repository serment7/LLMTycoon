// AttachmentPreviewPanel(#25c6969c) — 업로드/생성된 `MediaPreview` 목록을 렌더한다.
//
// 책임
//   1) 각 첨부의 "무엇/얼마나/어디서" 를 한 줄로 요약해 보여 준다.
//   2) 실패·재시도 상태를 시각화해, 사용자가 실패한 항목만 재시도 버튼을 눌러
//      복구할 수 있게 한다.
//   3) 각 항목 제거 콜백을 노출해 상위가 상태에서 제외할 수 있게 한다.
//
// 스타일은 `--attachment-preview-*` 토큰으로 분리. 본 파일은 색/크기 상수를 직접
// 쓰지 않고 var() 체인으로 감싸 디자이너 시안이 합류했을 때 스킨 교체가 즉시 되도록
// 두었다.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, File as FileIcon, Film, Image as ImageIcon, RotateCcw, X, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

import type { MediaPreview } from '../utils/mediaLoaders';
import { formatBytes } from './UploadDropzone';

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 — 테스트 대상
// ────────────────────────────────────────────────────────────────────────────

/** 항목별 상태 — 상위 App 이 업로드 수명주기를 추적하며 바꿔 준다. */
export type AttachmentStatus = 'uploading' | 'ready' | 'failed';

export interface AttachmentItem {
  /** 상위 상태에서의 안정 id(재시도 후에도 유지). */
  id: string;
  /** 업로드/생성 성공 시 채워지는 미리보기 데이터. failed 상태면 undefined 가능. */
  preview?: MediaPreview;
  /** 실패 메시지(한국어 짧은 라벨). UserFacingMessage.title 을 그대로 넣으면 된다. */
  errorTitle?: string;
  /** 사용자에게 보여줄 파일명(미리보기가 비어 있어도 표시). */
  name: string;
  status: AttachmentStatus;
}

/**
 * "PDF · 3페이지 · 250KB" · "MP4 · 영상 생성(hero shot) · 1.2MB" 같은 한 줄 요약을
 * 만든다. preview 가 비어 있으면 파일명만으로 최소한의 라벨을 돌려준다.
 */
export function formatAttachmentSummary(item: AttachmentItem): string {
  const kindLabel = (kind?: string): string => {
    if (kind === 'pdf') return 'PDF';
    if (kind === 'pptx') return 'PPTX';
    if (kind === 'video') return '영상';
    if (kind === 'image') return '이미지';
    return '파일';
  };
  const preview = item.preview;
  if (!preview) return `${kindLabel()} · ${item.name}`;
  const parts: string[] = [kindLabel(preview.kind)];
  if (preview.pageCount && preview.pageCount > 0) parts.push(`${preview.pageCount}페이지`);
  if (preview.generatedBy?.prompt) parts.push(`생성: ${preview.generatedBy.prompt}`);
  parts.push(formatBytes(preview.sizeBytes));
  return parts.join(' · ');
}

function IconFor(kind?: string): React.ReactElement {
  if (kind === 'pdf' || kind === 'pptx') return <FileText size={14} aria-hidden="true" />;
  if (kind === 'video') return <Film size={14} aria-hidden="true" />;
  if (kind === 'image') return <ImageIcon size={14} aria-hidden="true" />;
  return <FileIcon size={14} aria-hidden="true" />;
}

/**
 * 방향키/Home/End 에 따라 다음 포커스 인덱스를 계산한다. 경계에서는 래핑 없이
 * 끝에 고정 — WAI-ARIA listbox 권장 동작(비순환). total=0 이면 -1 을 돌려 포커스
 * 대상이 없음을 표시한다.
 */
export function pickFocusIndexOnKey(params: {
  current: number;
  total: number;
  key: string;
}): number {
  if (params.total <= 0) return -1;
  const last = params.total - 1;
  const clamp = (n: number) => Math.max(0, Math.min(last, n));
  const safeCurrent = Number.isFinite(params.current) && params.current >= 0 && params.current <= last
    ? params.current
    : 0;
  switch (params.key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return clamp(safeCurrent + 1);
    case 'ArrowUp':
    case 'ArrowLeft':
      return clamp(safeCurrent - 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return safeCurrent;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// React 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

export interface AttachmentPreviewPanelProps {
  items: ReadonlyArray<AttachmentItem>;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  /** 빈 상태 문구 커스터마이즈. 생략 시 기본값. */
  emptyLabel?: string;
  className?: string;
}

export function AttachmentPreviewPanel({
  items,
  onRemove,
  onRetry,
  emptyLabel,
  className,
}: AttachmentPreviewPanelProps): React.ReactElement {
  // 포커스 추적 + Space 로 상세(추출 본문) 토글.
  const [focusIndex, setFocusIndex] = useState<number>(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLUListElement | null>(null);

  // 항목 수가 줄어들면 포커스 인덱스를 현실에 맞게 자연스럽게 당겨 온다.
  useEffect(() => {
    if (focusIndex >= items.length) setFocusIndex(Math.max(0, items.length - 1));
  }, [items.length, focusIndex]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLLIElement>) => {
    const NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (NAV_KEYS.includes(e.key)) {
      e.preventDefault();
      const next = pickFocusIndexOnKey({ current: focusIndex, total: items.length, key: e.key });
      if (next >= 0 && next !== focusIndex) {
        setFocusIndex(next);
        const ul = listRef.current;
        const li = ul?.querySelectorAll('[data-testid="attachment-preview-item"]')[next] as HTMLElement | undefined;
        li?.focus();
      }
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      // Space = 상세(추출 본문) 토글. 버튼 위에서 발화하면 기본 동작(클릭) 이 우선하도록
      // target 이 버튼일 때는 그대로 통과.
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      e.preventDefault();
      const item = items[focusIndex];
      if (!item) return;
      setExpanded(prev => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    }
  }, [focusIndex, items]);

  if (!items || items.length === 0) {
    return (
      <div
        data-testid="attachment-preview-empty"
        className={`attachment-preview attachment-preview--empty${className ? ` ${className}` : ''}`}
        style={{
          background: 'var(--attachment-preview-bg, var(--pixel-card))',
          border: '1px dashed var(--attachment-preview-border, var(--pixel-border))',
          color: 'var(--attachment-preview-muted-fg, var(--token-usage-tooltip-subtle-fg))',
          padding: '14px 16px',
          fontSize: 12,
        }}
      >
        {emptyLabel ?? '아직 업로드하거나 생성된 첨부가 없어요.'}
      </div>
    );
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="업로드한 첨부 목록"
      data-testid="attachment-preview-list"
      className={`attachment-preview attachment-preview--list${className ? ` ${className}` : ''}`}
      style={{
        background: 'var(--attachment-preview-bg, var(--pixel-card))',
        border: '1px solid var(--attachment-preview-border, var(--pixel-border))',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {items.map((item, idx) => {
        const summary = formatAttachmentSummary(item);
        const failed = item.status === 'failed';
        const uploading = item.status === 'uploading';
        const isFocused = idx === focusIndex;
        const isExpanded = expanded.has(item.id);
        return (
          <li
            key={item.id}
            role="option"
            aria-selected={isFocused}
            aria-expanded={item.preview?.extractedText ? isExpanded : undefined}
            tabIndex={isFocused ? 0 : -1}
            onKeyDown={onKeyDown}
            onFocus={() => setFocusIndex(idx)}
            data-testid="attachment-preview-item"
            data-status={item.status}
            data-expanded={isExpanded ? 'true' : 'false'}
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              padding: '8px 10px',
              border: '1px solid var(--attachment-preview-item-border, var(--pixel-border))',
              background: failed
                ? 'var(--attachment-preview-failed-bg, var(--error-state-bg))'
                : 'var(--attachment-preview-item-bg, transparent)',
            }}
          >
            <span
              aria-hidden="true"
              style={{ color: failed ? 'var(--error-state-icon-fg)' : 'var(--attachment-preview-icon-fg, var(--pixel-accent))' }}
            >
              {failed ? <AlertTriangle size={14} aria-hidden="true" /> : IconFor(item.preview?.kind)}
            </span>
            {/* 스페이스로 토글 가능함을 시각적으로도 알려 준다. 추출 본문이 없으면 토글 의미가 없어 숨김. */}
            {item.preview?.extractedText ? (
              <span
                aria-hidden="true"
                data-testid="attachment-preview-toggle"
                style={{ color: 'var(--attachment-preview-muted-fg, var(--token-usage-tooltip-subtle-fg))' }}
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
            ) : null}
            <div className="flex-1 min-w-0">
              <div
                className="text-[12px] font-bold"
                style={{ color: 'var(--attachment-preview-title-fg, var(--shared-goal-modal-header-fg))' }}
              >
                {item.name}
              </div>
              <div
                className="text-[11px] mt-0.5"
                style={{ color: failed ? 'var(--error-state-title-fg)' : 'var(--attachment-preview-muted-fg, var(--token-usage-tooltip-subtle-fg))' }}
              >
                {uploading ? '업로드 중…' : (failed ? (item.errorTitle ?? '업로드 실패') : summary)}
              </div>
              {item.preview?.extractedText ? (
                <div
                  data-testid="attachment-preview-excerpt"
                  className={`text-[10px] mt-1 whitespace-pre-wrap${isExpanded ? '' : ' line-clamp-2'}`}
                  style={{ color: 'var(--attachment-preview-muted-fg, var(--token-usage-tooltip-subtle-fg))' }}
                >
                  {isExpanded
                    ? item.preview.extractedText
                    : `${item.preview.extractedText.slice(0, 120)}${item.preview.extractedText.length > 120 ? '…' : ''}`}
                </div>
              ) : null}
            </div>
            {failed && onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(item.id)}
                data-testid="attachment-preview-retry"
                aria-label={`${item.name} 다시 시도`}
                className="px-2 py-1 text-[11px] font-bold uppercase flex items-center gap-1"
                style={{
                  background: 'var(--attachment-preview-retry-bg, var(--pixel-accent))',
                  color: 'var(--attachment-preview-retry-fg, black)',
                  border: '1px solid var(--attachment-preview-retry-border, var(--pixel-accent))',
                }}
              >
                <RotateCcw size={11} aria-hidden="true" /> 다시 시도
              </button>
            ) : null}
            {onRemove ? (
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                data-testid="attachment-preview-remove"
                aria-label={`${item.name} 제거`}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--attachment-preview-muted-fg, var(--token-usage-tooltip-subtle-fg))',
                  cursor: 'pointer',
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
