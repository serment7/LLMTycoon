/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 디자이너: 리더가 지시(directive) 를 입력할 때, 텍스트 프롬프트와 함께 첨부파일을
 * 끌어 올릴 수 있어야 한다. 첨부는 "한 장면의 근거"가 되므로 (1) 끌어다 놓기 영역이
 * 지시 본문보다 아래·작게 배치돼 본문 작성의 흐름을 끊지 않고, (2) 업로드된 파일은
 * 즉시 리스트로 피드백되어 "이 지시가 무엇을 근거로 하는지" 재확인할 수 있으며,
 * (3) 타입(PDF/이미지/텍스트)은 색과 형태로 구분해 색약 사용자도 형태로 구별 가능하다.
 *
 * 본 파일은 presentational 컴포넌트다. 업로드 I/O 는 부모가 주입한 콜백으로만 수행하고,
 * 상태(진행률·에러)는 props 로 받아 그린다. 이렇게 하면 시뮬레이터/스토리북에서도
 * 동일한 UI 를 결정적으로 렌더할 수 있다.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  RotateCcw,
  Upload,
  UploadCloud,
  X,
} from 'lucide-react';
import { useReducedMotion } from '../utils/useReducedMotion';
import type { MediaAsset, MediaKind } from '../types';
import { TABBABLE_SELECTORS, computeNextFocusIndex, toQuerySelector } from '../utils/focusTrap';

/** 첨부 종류. 확장자·MIME 에서 일반화된 세 축으로만 구분한다. */
export type AttachmentKind = 'pdf' | 'image' | 'text' | 'other';

/** 업로드 라이프사이클. 한 번 에러가 찍히면 `errorMessage` 가 토스트로 뜬다. */
export type AttachmentStatus = 'queued' | 'uploading' | 'done' | 'error';

export interface DirectiveAttachment {
  id: string;
  name: string;
  /** 바이트 단위. 사람이 읽을 표시는 `formatFileSize` 로 렌더한다. */
  size: number;
  /** MIME 또는 확장자. `classifyAttachment` 가 kind 로 축약한다. */
  mime: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  /** 0~100. uploading 상태에서만 의미가 있다. */
  progress?: number;
  errorMessage?: string;
}

export interface DirectivePromptProps {
  value: string;
  onChange: (next: string) => void;
  attachments: ReadonlyArray<DirectiveAttachment>;
  /**
   * 파일이 드래그 또는 파일 선택으로 들어왔을 때 부모에 위임.
   * 부모는 업로드를 시작하고 attachments 목록을 갱신한다.
   */
  onFilesAdded: (files: File[]) => void;
  onRemove: (id: string) => void;
  onPreview?: (attachment: DirectiveAttachment) => void;
  /** 에러 토스트 문자열. 비어 있으면 토스트를 숨긴다. */
  errorToast?: string | null;
  onDismissError?: () => void;
  /** 제출 버튼 핸들러. 미지정 시 제출 버튼을 감춘다. */
  onSubmit?: () => void;
  submitLabel?: string;
  placeholder?: string;
  /** 허용 MIME · 확장자. input[type=file] accept 와 드롭 필터에 모두 쓰인다. */
  accept?: string;
  /** 최대 파일 크기(바이트). 초과 시 onFilesAdded 이전 단계에서 에러 토스트를 띄운다. */
  maxBytes?: number;
  disabled?: boolean;
  /**
   * 읽기 전용 모드(#cdaaabf3) — 토큰 소진/구독 만료로 서버가 claude-session:status
   * exhausted 를 방송한 동안 부모(App)가 이 값을 true 로 내려 준다. true 이면 본문
   * 편집은 허용하지만 전송 버튼·드롭존·파일 선택이 전부 잠긴다(= `disabled` 와 동등
   * 동작). 시각 라벨은 별도 배너(ClaudeTokenUsage/ToastProvider)가 담당하고, 본 컴포
   * 넌트는 상호작용 잠금만 책임진다.
   */
  readOnlyMode?: boolean;
  /**
   * 최근 생성된 멀티미디어 자산(#c0ba95a1). 서버 /api/media/generate 응답 또는
   * socket 누적 결과에서 상위가 최신순으로 내려 준다. 비어 있으면 본 블록은 렌더되지
   * 않는다. 본 컴포넌트는 아이콘·파일명·다운로드·재생성 버튼만 배치하고, 실제 업로드/
   * 재생성 네트워크 호출은 `onMediaDownload` / `onMediaRegenerate` 콜백에 위임한다.
   */
  recentMedia?: ReadonlyArray<MediaAsset>;
  /** 다운로드 클릭 시 호출. storageUrl 기반 window.open 이나 fetch+blob 경로는 부모 책임. */
  onMediaDownload?: (asset: MediaAsset) => void;
  /** 재생성 클릭 시 호출. readOnlyMode 에서는 버튼이 비활성화되어 이 훅이 호출되지 않는다. */
  onMediaRegenerate?: (asset: MediaAsset) => void;
}

// MediaKind → 시각 스트립 토큰. CollabTimeline 과 동일 토큰을 참조해 "같은 매체는
// 같은 색" 이 두 영역에서 유지되도록 한다.
const MEDIA_STRIP_TOKEN: Record<MediaKind, string> = {
  video: 'var(--media-asset-video-strip)',
  pdf:   'var(--media-asset-pdf-strip)',
  pptx:  'var(--media-asset-pptx-strip)',
  image: 'var(--media-asset-image-strip)',
};

const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  video: '영상',
  pdf:   'PDF',
  pptx:  'PPT',
  image: '이미지',
};

function MediaIcon({ kind, size = 12 }: { kind: MediaKind; size?: number }) {
  if (kind === 'video') return <Film size={size} aria-hidden="true" />;
  if (kind === 'image') return <ImageIcon size={size} aria-hidden="true" />;
  return <FileText size={size} aria-hidden="true" />;
}

// 바이트 표기. 천 단위를 쓰지 않고 2진 단위(KB=1024)를 쓰는 것은 개발자 친화 톤에 맞춘 선택.
// 소수점은 1자리까지만 — "1.234 MB" 는 과잉 정보다.
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

// MIME/확장자 → kind. 목록에 없는 바이너리는 'other' 로 떨어져 회색 아이콘이 붙는다.
export function classifyAttachment(mime: string, name: string): AttachmentKind {
  const m = (mime || '').toLowerCase();
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    return 'image';
  }
  if (
    m.startsWith('text/') ||
    ['txt', 'md', 'markdown', 'json', 'csv', 'yml', 'yaml', 'log'].includes(ext)
  ) {
    return 'text';
  }
  return 'other';
}

/** kind 별 시각 토큰. 색(border/bg)·이모지 유사 글리프·라벨을 한 곳에서만 관리. */
const KIND_TOKENS: Record<AttachmentKind, { label: string; className: string }> = {
  // PDF 는 "문서 묶음" — 진한 주홍 톤.
  pdf: {
    label: 'PDF',
    className: 'directive-attachment__kind--pdf',
  },
  // 이미지 — 청록. 텍스트와의 혼동을 피하기 위해 확실히 다른 hue.
  image: {
    label: 'IMG',
    className: 'directive-attachment__kind--image',
  },
  // 텍스트/코드 — 연두. "읽기 쉬운 원문" 의 함의.
  text: {
    label: 'TXT',
    className: 'directive-attachment__kind--text',
  },
  // 그 외 — 중립 회색.
  other: {
    label: 'FILE',
    className: 'directive-attachment__kind--other',
  },
};

function KindIcon({ kind, className }: { kind: AttachmentKind; className?: string }) {
  if (kind === 'image') return <ImageIcon className={className} aria-hidden="true" />;
  if (kind === 'pdf' || kind === 'text') return <FileText className={className} aria-hidden="true" />;
  return <Paperclip className={className} aria-hidden="true" />;
}

function filterByAccept(files: File[], accept: string | undefined): File[] {
  if (!accept) return files;
  const tokens = accept
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return files;
  return files.filter((f) => {
    const ext = '.' + (f.name.toLowerCase().split('.').pop() ?? '');
    const mime = f.type.toLowerCase();
    return tokens.some((tok) => {
      if (tok.startsWith('.')) return tok === ext;
      if (tok.endsWith('/*')) return mime.startsWith(tok.slice(0, -1));
      return tok === mime;
    });
  });
}

/** `src/components/DirectivePrompt.tsx` 의 주 컴포넌트. */
export function DirectivePrompt(props: DirectivePromptProps) {
  const {
    value,
    onChange,
    attachments,
    onFilesAdded,
    onRemove,
    onPreview,
    errorToast,
    onDismissError,
    onSubmit,
    submitLabel = '지시 전송',
    placeholder = '지시 내용을 입력하세요… (Enter 로 전송 · Shift+Enter 로 줄바꿈)',
    accept,
    maxBytes,
    disabled,
  } = props;

  const reducedMotion = useReducedMotion();
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  // readOnlyMode 와 disabled 를 같은 축으로 합친다(#cdaaabf3). 개별 `disabled` 는
  // 호출자가 폼 단위로 컨트롤하고, `readOnlyMode` 는 전역 세션 폴백에서 내려온다.
  // 둘 중 하나라도 true 이면 상호작용이 잠긴다.
  const locked = disabled || props.readOnlyMode === true;
  // 드래그 이벤트는 자식 요소 위에서 dragleave 가 발생해도 루트에서는 계속 드래그 중이어야
  // 한다. 깊이 카운터로 중첩된 enter/leave 를 상쇄해 깜빡임을 막는다.
  const dragDepthRef = useRef(0);

  const onDropOrPick = useCallback(
    (raw: File[]) => {
      if (disabled) return;
      let files = filterByAccept(raw, accept);
      if (maxBytes != null) files = files.filter((f) => f.size <= maxBytes);
      if (files.length === 0) return;
      onFilesAdded(files);
    },
    [accept, disabled, maxBytes, onFilesAdded],
  );

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    if (dragDepthRef.current === 1) setIsDragOver(true);
  };
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    onDropOrPick(files);
  };

  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    onDropOrPick(files);
    // 같은 파일을 재업로드해도 onChange 가 다시 발생하도록 value 리셋.
    e.target.value = '';
  };

  const uploadingCount = useMemo(
    () => attachments.filter((a) => a.status === 'uploading').length,
    [attachments],
  );

  const submit = () => {
    if (!onSubmit || locked) return;
    onSubmit();
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    // 한글/일본어 등 IME 조합 중의 Enter 는 조합 확정 신호이지 전송 의도가 아니다.
    // 이 체크 없이 전송하면 "안녕" 을 치다가 자음 조합 확정하는 순간 지시가 날아간다.
    if (e.nativeEvent.isComposing) return;
    // Shift+Enter → 개행(기본 동작 유지). preventDefault 하지 않는다.
    // Alt+Enter 는 전송도 개행도 아닌 NOP (일부 OS 창 단축키와 충돌 가능).
    if (e.shiftKey || e.altKey) return;
    // 업로드 진행 중이면 제출 버튼처럼 키보드 경로도 잠근다. preventDefault 를 하지
    // 않아 사용자가 친 본문이 이상한 자리에서 잘리지 않게 둔다 (자연스러운 newline 허용).
    if (locked || uploadingCount > 0) return;
    // Enter 단독 또는 Cmd/Ctrl+Enter → 전송. 하위 호환을 위해 둘 다 동일 취급.
    e.preventDefault();
    submit();
  };

  return (
    <section
      className="directive-prompt"
      data-reduced-motion={reducedMotion ? 'reduce' : 'ok'}
      // 외부 관찰자(E2E 스모크·감사 훅) 가 "지금 업로드 중인가" 를 DOM 으로 즉시
      // 읽을 수 있도록 data 속성을 노출한다. submit 버튼 disabled 상태는 이미
      // reflected 되지만, footer 문자열이 i18n 등으로 바뀌어도 계약이 흔들리지
      // 않도록 숫자 축과 분리된 boolean 축을 명시한다.
      data-uploading={uploadingCount > 0 ? 'true' : 'false'}
      data-read-only={props.readOnlyMode ? 'true' : 'false'}
      aria-disabled={locked || undefined}
    >
      <label htmlFor={inputId} className="directive-prompt__label">
        지시(directive)
      </label>
      <textarea
        id={inputId}
        className="directive-prompt__textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={5}
      />

      <div
        className="directive-prompt__dropzone"
        data-drag-over={isDragOver ? 'true' : 'false'}
        data-disabled={disabled ? 'true' : 'false'}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="첨부 파일 드래그 앤 드롭 영역"
        onClick={() => !disabled && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
      >
        <UploadCloud className="directive-prompt__dropicon" aria-hidden="true" />
        <div className="directive-prompt__droptext">
          <strong>파일을 여기로 끌어다 놓거나</strong>
          <span> 클릭해 선택하세요</span>
          <em className="directive-prompt__drophint">PDF · 이미지 · 텍스트 지원</em>
        </div>
        <button
          type="button"
          className="directive-prompt__pickbtn"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            fileInputRef.current?.click();
          }}
        >
          <Upload aria-hidden="true" />
          <span>파일 선택</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={accept}
          className="directive-prompt__fileinput"
          onChange={handlePick}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      {attachments.length > 0 && (
        <ul className="directive-prompt__list" aria-label="첨부된 파일 목록">
          {attachments.map((att) => (
            // Fragment 로 key 를 감싼다 — `AttachmentRow` 의 props 타입에 `key` 가
            // 없어 엄격 모드 tsc 가 거부하기 때문(React 리스트 추적 prop 을 자식
            // props 로 오인). `ToastProvider.tsx` 의 Toast 와 동일 패턴. #cdaa2a86.
            <React.Fragment key={att.id}>
              <AttachmentRow
                attachment={att}
                onRemove={onRemove}
                onPreview={onPreview}
                disabled={disabled}
              />
            </React.Fragment>
          ))}
        </ul>
      )}

      {props.recentMedia && props.recentMedia.length > 0 && (
        <section
          className="directive-prompt__media"
          data-testid="directive-prompt-recent-media"
          data-read-only={props.readOnlyMode ? 'true' : 'false'}
          aria-label="최근 생성된 매체"
          style={{
            marginTop: 8,
            padding: 8,
            background: 'var(--media-asset-surface-bg)',
            border: `1px solid var(--media-asset-surface-border)`,
          }}
        >
          <div
            className="text-[10px] uppercase tracking-wider mb-1"
            style={{ color: 'var(--media-asset-meta-fg)' }}
          >
            최근 생성된 매체 · {props.recentMedia.length}
          </div>
          <ul className="flex flex-col gap-1" data-testid="directive-prompt-recent-media-list">
            {props.recentMedia.map((asset) => {
              const canRegenerate = !!props.onMediaRegenerate && !props.readOnlyMode;
              return (
                <li
                  key={asset.id}
                  data-testid={`directive-media-${asset.id}`}
                  data-media-kind={asset.kind}
                  className="flex items-center gap-2 px-2 py-1"
                  style={{
                    borderLeft: `2px solid ${MEDIA_STRIP_TOKEN[asset.kind]}`,
                    background: 'var(--media-asset-thumb-bg)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{ color: MEDIA_STRIP_TOKEN[asset.kind] }}
                  >
                    <MediaIcon kind={asset.kind} size={14} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div
                      className="truncate text-[11px]"
                      style={{ color: 'var(--media-asset-name-fg)' }}
                      title={asset.name}
                      data-testid={`directive-media-name-${asset.id}`}
                    >
                      <span
                        className="uppercase tracking-wider text-[9px] px-1 mr-1 border border-white/20"
                        data-testid={`directive-media-kind-${asset.id}`}
                      >
                        {MEDIA_KIND_LABEL[asset.kind]}
                      </span>
                      {asset.name}
                    </div>
                    <div
                      className="text-[10px]"
                      style={{ color: 'var(--media-asset-meta-fg)' }}
                    >
                      {formatFileSize(asset.sizeBytes)}
                      {asset.generatedBy?.adapter ? ` · ${asset.generatedBy.adapter}` : ''}
                    </div>
                  </div>
                  {props.onMediaDownload ? (
                    <button
                      type="button"
                      onClick={() => props.onMediaDownload?.(asset)}
                      data-testid={`directive-media-download-${asset.id}`}
                      aria-label={`${asset.name} 다운로드`}
                      className="text-[10px] px-2 py-0.5 inline-flex items-center gap-1"
                      style={{
                        color: 'var(--media-asset-download-fg)',
                        border: `1px solid var(--media-asset-download-border)`,
                        background: 'transparent',
                      }}
                    >
                      <Download size={10} aria-hidden="true" />
                      다운로드
                    </button>
                  ) : null}
                  {props.onMediaRegenerate ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (canRegenerate) props.onMediaRegenerate?.(asset);
                      }}
                      disabled={!canRegenerate}
                      data-testid={`directive-media-regenerate-${asset.id}`}
                      data-disabled-reason={props.readOnlyMode ? 'read-only' : undefined}
                      aria-label={
                        props.readOnlyMode
                          ? `${asset.name} 재생성 (읽기 전용 모드에서는 사용 불가)`
                          : `${asset.name} 재생성`
                      }
                      title={
                        props.readOnlyMode
                          ? '세션 토큰이 소진되어 재생성이 일시 중지되었습니다'
                          : '같은 프롬프트로 다시 생성합니다'
                      }
                      className="text-[10px] px-2 py-0.5 inline-flex items-center gap-1 disabled:cursor-not-allowed"
                      style={{
                        color: canRegenerate
                          ? 'var(--media-asset-regenerate-fg)'
                          : 'var(--media-asset-regenerate-disabled-fg)',
                        border: `1px solid ${
                          canRegenerate
                            ? 'var(--media-asset-regenerate-border)'
                            : 'var(--media-asset-regenerate-disabled-border)'
                        }`,
                        background: 'transparent',
                      }}
                    >
                      <RotateCcw size={10} aria-hidden="true" />
                      재생성
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {onSubmit && (
        <div className="directive-prompt__footer">
          <span className="directive-prompt__footer-hint">
            {uploadingCount > 0
              ? `업로드 중 (${uploadingCount})…`
              : `첨부 ${attachments.length}개`}
          </span>
          <button
            type="button"
            className="directive-prompt__submit"
            onClick={submit}
            disabled={locked || uploadingCount > 0}
            data-read-only={props.readOnlyMode ? 'true' : 'false'}
            aria-label={props.readOnlyMode ? `${submitLabel} (읽기 전용 모드에서는 전송 불가)` : undefined}
          >
            {submitLabel}
          </button>
        </div>
      )}

      {errorToast ? (
        <div
          className="directive-prompt__toast"
          role="alert"
          aria-live="assertive"
        >
          <AlertTriangle aria-hidden="true" />
          <span className="directive-prompt__toast-text">{errorToast}</span>
          {onDismissError && (
            <button
              type="button"
              className="directive-prompt__toast-close"
              onClick={onDismissError}
              aria-label="에러 닫기"
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

function AttachmentRow({
  attachment,
  onRemove,
  onPreview,
  disabled,
}: {
  attachment: DirectiveAttachment;
  onRemove: (id: string) => void;
  onPreview?: (a: DirectiveAttachment) => void;
  disabled?: boolean;
}) {
  const tokens = KIND_TOKENS[attachment.kind];
  const isUploading = attachment.status === 'uploading';
  const isError = attachment.status === 'error';
  const clickable = attachment.status === 'done' && !!onPreview;
  return (
    <li
      className="directive-attachment"
      data-status={attachment.status}
      data-kind={attachment.kind}
    >
      <span className={`directive-attachment__kind ${tokens.className}`} aria-hidden="true">
        <KindIcon kind={attachment.kind} className="directive-attachment__kind-icon" />
        <span className="directive-attachment__kind-label">{tokens.label}</span>
      </span>

      <button
        type="button"
        className="directive-attachment__main"
        onClick={() => clickable && onPreview?.(attachment)}
        disabled={!clickable}
        aria-label={clickable ? `${attachment.name} 미리보기` : attachment.name}
      >
        <span className="directive-attachment__name" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="directive-attachment__meta">
          <span className="directive-attachment__size">{formatFileSize(attachment.size)}</span>
          {isUploading && (
            <span className="directive-attachment__progress" aria-live="polite">
              <Loader2 className="directive-attachment__spinner" aria-hidden="true" />
              <span>{Math.round(attachment.progress ?? 0)}%</span>
            </span>
          )}
          {isError && (
            <span className="directive-attachment__error" title={attachment.errorMessage}>
              실패
            </span>
          )}
        </span>
        {isUploading && (
          <span
            className="directive-attachment__bar"
            aria-hidden="true"
            style={{ width: `${Math.min(100, Math.max(0, attachment.progress ?? 0))}%` }}
          />
        )}
      </button>

      <button
        type="button"
        className="directive-attachment__remove"
        onClick={() => onRemove(attachment.id)}
        disabled={disabled}
        aria-label={`${attachment.name} 삭제`}
      >
        <X aria-hidden="true" />
      </button>
    </li>
  );
}

export interface AttachmentPreviewModalProps {
  attachment: DirectiveAttachment | null;
  /** 미리보기 원본 URL. 부모가 blob URL 등으로 생성해 주입한다. */
  previewUrl?: string | null;
  /** 텍스트 미리보기용 원문. 없으면 플레이스홀더를 보여준다. */
  previewText?: string | null;
  onClose: () => void;
}

/**
 * 디자이너: 첨부 미리보기 모달 레이아웃. 세 가지 kind 마다 뷰어가 다르지만
 * 모달 자체의 레이아웃(헤더/컨텐츠/푸터)은 공유해, 사용자가 "어떤 파일이든
 * 같은 자리에 닫기 버튼이 있다" 는 안전한 예측을 하게 한다.
 */
export function AttachmentPreviewModal({
  attachment,
  previewUrl,
  previewText,
  onClose,
}: AttachmentPreviewModalProps) {
  // 다이얼로그 루트 ref — 포커스 가능 요소 질의와 Tab 순환 계산의 기준점.
  // 외부로 포커스가 빠지는 것을 막는 시안 §4.1 포커스 트랩 계약을 `focusTrap.ts`
  // 의 공용 유틸(`TABBABLE_SELECTORS` + `computeNextFocusIndex`) 로 구현한다.
  const cardRef = useRef<HTMLDivElement>(null);
  // 모달이 열리기 직전 포커스가 있던 요소 — 닫힐 때 이 자리로 포커스를 복원해
  // 키보드 사용자가 "어디에 있었는지" 를 잃지 않게 한다(§4.1 lastFocus 규약).
  const lastFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!attachment) return;
    lastFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // 오픈 직후 카드 내 첫 포커스 가능 요소로 포커스를 이동해 즉시 Esc/닫기 버튼을
    // 읽힐 수 있게 한다. 카드가 아직 DOM 에 붙지 않은 첫 프레임을 피하려고 micro-task.
    const t = setTimeout(() => {
      const card = cardRef.current;
      if (!card) return;
      const nodes = card.querySelectorAll<HTMLElement>(toQuerySelector(TABBABLE_SELECTORS));
      if (nodes.length > 0) nodes[0].focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      // Array.from + 제네릭 querySelectorAll 조합이 TS 5.x 에서 `unknown[]` 로
      // 역추론되는 케이스가 있어, forEach 로 명시 수집해 HTMLElement[] 를 보장한다.
      const rawNodes = card.querySelectorAll<HTMLElement>(toQuerySelector(TABBABLE_SELECTORS));
      const nodes: HTMLElement[] = [];
      rawNodes.forEach((el) => {
        if (!el.hasAttribute('aria-hidden') && el.offsetParent !== null) nodes.push(el);
      });
      if (nodes.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? nodes.indexOf(active) : -1;
      const next = computeNextFocusIndex(
        idx,
        nodes.length,
        e.shiftKey ? 'backward' : 'forward',
      );
      if (next < 0) return;
      e.preventDefault();
      nodes[next].focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [attachment, onClose]);

  // 모달이 언마운트되는 순간 포커스 복원 — Escape/닫기 경로가 모두 onClose 를
  // 호출해 attachment=null 로 돌아오므로, 이 effect 가 한 곳에서 복원을 책임진다.
  useEffect(() => {
    if (attachment) return;
    if (lastFocusRef.current) {
      try { lastFocusRef.current.focus(); } catch { /* ignore */ }
      lastFocusRef.current = null;
    }
  }, [attachment]);

  if (!attachment) return null;

  return (
    <div
      className="directive-preview-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`${attachment.name} 미리보기`}
      onClick={onClose}
    >
      <div
        ref={cardRef}
        data-testid="directive-preview-modal-card"
        className="directive-preview-modal__card"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="directive-preview-modal__header">
          <KindIcon
            kind={attachment.kind}
            className="directive-preview-modal__icon"
          />
          <h3 className="directive-preview-modal__title" title={attachment.name}>
            {attachment.name}
          </h3>
          <span className="directive-preview-modal__size">
            {formatFileSize(attachment.size)}
          </span>
          <button
            type="button"
            className="directive-preview-modal__close"
            onClick={onClose}
            aria-label="미리보기 닫기"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="directive-preview-modal__body" data-kind={attachment.kind}>
          {attachment.kind === 'image' && previewUrl && (
            <img
              className="directive-preview-modal__image"
              src={previewUrl}
              alt={attachment.name}
            />
          )}
          {attachment.kind === 'pdf' && previewUrl && (
            <iframe
              className="directive-preview-modal__pdf"
              src={previewUrl}
              title={attachment.name}
            />
          )}
          {attachment.kind === 'text' && (
            <pre className="directive-preview-modal__text">
              {previewText ?? '(본문을 불러오는 중…)'}
            </pre>
          )}
          {attachment.kind === 'other' && (
            <div className="directive-preview-modal__fallback">
              이 파일 형식은 미리보기를 지원하지 않습니다. 파일 이름으로만
              참조됩니다.
            </div>
          )}
        </div>
        <footer className="directive-preview-modal__footer">
          <button
            type="button"
            className="directive-preview-modal__dismiss"
            onClick={onClose}
          >
            닫기
          </button>
        </footer>
      </div>
    </div>
  );
}

export default DirectivePrompt;
