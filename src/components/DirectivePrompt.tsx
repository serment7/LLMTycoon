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
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Upload,
  UploadCloud,
  X,
} from 'lucide-react';
import { useReducedMotion } from '../utils/useReducedMotion';

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
    if (!onSubmit || disabled) return;
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
    if (disabled || uploadingCount > 0) return;
    // Enter 단독 또는 Cmd/Ctrl+Enter → 전송. 하위 호환을 위해 둘 다 동일 취급.
    e.preventDefault();
    submit();
  };

  return (
    <section
      className="directive-prompt"
      data-reduced-motion={reducedMotion ? 'reduce' : 'ok'}
      aria-disabled={disabled || undefined}
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
            <AttachmentRow
              key={att.id}
              attachment={att}
              onRemove={onRemove}
              onPreview={onPreview}
              disabled={disabled}
            />
          ))}
        </ul>
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
            disabled={disabled || uploadingCount > 0}
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
  useEffect(() => {
    if (!attachment) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attachment, onClose]);

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
