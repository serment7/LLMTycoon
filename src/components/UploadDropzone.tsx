// UploadDropzone(#25c6969c) — 멀티미디어 파이프라인의 "입력" 진입 컴포넌트.
//
// 책임
//   1) 드래그&드롭 + `<input type="file">` 두 경로를 모두 지원한다.
//   2) 로컬에서 파일 용량/확장자를 사전 검증해 네트워크를 아끼고, 실패한 파일은
//      ToastProvider 로 즉시 사용자 친화 메시지를 내보낸다.
//   3) 통과한 파일은 상위에 그대로 전달만 하고(mediaLoaders.loadMediaFile 호출은
//      상위의 책임), 본 컴포넌트는 "선택·검증·취소" 에만 집중한다 — 테스트 경계 분리.
//
// 스타일은 `--upload-dropzone-*` 토큰으로 분리해 두어 디자이너 시안이 확정되면
// CSS 변수 교체만으로 스킨이 바뀐다. 본 파일은 JSX·순수 함수만 정의.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { UploadCloud, FilePlus2, AlertCircle } from 'lucide-react';

import { useToast } from './ToastProvider';
import {
  mapMediaLoaderError,
  messageToToastInput,
  type UserFacingMessage,
} from '../utils/errorMessages';
import { detectMediaKind, DEFAULT_MAX_BYTES, type MediaKind } from '../utils/mediaLoaders';

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 — Node 테스트에서 직접 호출
// ────────────────────────────────────────────────────────────────────────────

/**
 * 드롭존 시각 상태. UI 는 `data-state` 속성으로 CSS 가 팔레트를 가른다.
 *   · idle     — 평상 (점선 테두리)
 *   · dragover — 유효한 파일을 끌어온 상태(강조 테두리)
 *   · invalid  — 드롭은 가능하나 대상 아이템이 파일이 아닌 경우
 *   · disabled — 업로드가 일시적으로 불가(프로젝트 미선택 등)
 */
export type DropzoneVisualState = 'idle' | 'dragover' | 'invalid' | 'disabled';

/** 파일 사전 검증 결과. 통과/거부 중 하나. 거부 사유는 UserFacingMessage 로 승격돼 토스트로 나간다. */
export type FileGateResult =
  | { ok: true; kind: MediaKind }
  | { ok: false; message: UserFacingMessage; reason: 'UNSUPPORTED_KIND' | 'FILE_TOO_LARGE' };

/**
 * 단일 파일에 대한 사전 검증. 본 함수는 네트워크/DOM 접근이 없다. 호출자는 통과된
 * 파일만 `loadMediaFile` 로 넘기고, 거부된 파일은 `toast(...)` 로 흘려 보낸다.
 */
export function gateFile(file: File, opts?: { maxBytes?: number }): FileGateResult {
  const kind = detectMediaKind(file.name, file.type);
  if (!kind) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_KIND',
      message: mapMediaLoaderError('UNSUPPORTED_KIND'),
    };
  }
  const limit = typeof opts?.maxBytes === 'number' && opts.maxBytes > 0
    ? opts.maxBytes
    : DEFAULT_MAX_BYTES;
  if (file.size > limit) {
    return {
      ok: false,
      reason: 'FILE_TOO_LARGE',
      message: mapMediaLoaderError('FILE_TOO_LARGE'),
    };
  }
  return { ok: true, kind };
}

/**
 * DragEvent 를 해석해 `DropzoneVisualState` 를 돌려준다. 드래그 중 파일이 아닌
 * 대상(텍스트 선택 등) 이면 `invalid` 를 반환해 UI 가 빨간 테두리로 "여기엔 못
 * 넣어요" 를 고지한다. SSR 환경(이벤트 없음) 에선 호출되지 않는다.
 */
export function classifyDragState(params: {
  types: ReadonlyArray<string> | null | undefined;
  disabled?: boolean;
}): DropzoneVisualState {
  if (params.disabled) return 'disabled';
  const types = params.types ?? [];
  if (types.length === 0) return 'idle';
  // DataTransfer.types 에 'Files' 가 포함되면 파일 드래그. 그 외엔 유효하지 않음.
  if (types.includes('Files') || types.includes('application/x-file')) return 'dragover';
  return 'invalid';
}

/** 바이트 → 사람 친화 라벨. 테스트로 잠글 수 있게 export. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let v = n;
  while (v >= 1024 && idx < units.length - 1) { v /= 1024; idx += 1; }
  return `${v.toFixed(v >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

// ────────────────────────────────────────────────────────────────────────────
// React 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

export interface UploadDropzoneProps {
  /** 사전 검증을 통과한 파일들이 상위로 올라온다. 상위가 loadMediaFile 을 호출. */
  onFilesAccepted: (files: File[]) => void;
  /** 프로젝트 미선택 등으로 업로드가 막혀 있을 때 true. UI 는 "disabled" 상태. */
  disabled?: boolean;
  /** 단일 파일 용량 상한(바이트). 생략 시 DEFAULT_MAX_BYTES. */
  maxBytes?: number;
  /** input 의 accept 속성. 생략 시 PDF/PPTX/이미지/영상. */
  accept?: string;
  /** 보조 라벨(예: "프로젝트를 먼저 선택하세요"). disabled 시 안내에 쓰인다. */
  hint?: string;
  /** 외부에서 넣는 추가 클래스. 레이아웃 조정용. */
  className?: string;
  /**
   * 테스트 전용: `detectMediaKind`/`gateFile` 을 그대로 두지만, 토스트 발화 타이밍을
   * 관찰하려는 상위가 토스트 대신 직접 콜백을 받고 싶을 때 쓴다.
   */
  onRejected?: (file: File, message: UserFacingMessage) => void;
}

const DEFAULT_ACCEPT = '.pdf,.pptx,.ppt,image/*,video/*';

export function UploadDropzone({
  onFilesAccepted,
  disabled = false,
  maxBytes,
  accept = DEFAULT_ACCEPT,
  hint,
  className,
  onRejected,
}: UploadDropzoneProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<DropzoneVisualState>(disabled ? 'disabled' : 'idle');
  const toast = useToast();

  const processFiles = useCallback((files: FileList | File[] | null | undefined) => {
    if (!files) return;
    const list = Array.from(files);
    const accepted: File[] = [];
    for (const file of list) {
      const gate = gateFile(file, { maxBytes });
      if (gate.ok) {
        accepted.push(file);
      } else if (onRejected) {
        onRejected(file, gate.message);
      } else {
        toast.push(messageToToastInput(gate.message));
      }
    }
    if (accepted.length > 0) onFilesAccepted(accepted);
  }, [maxBytes, onFilesAccepted, onRejected, toast]);

  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    setState(classifyDragState({ types: e.dataTransfer?.types as unknown as string[], disabled }));
  }, [disabled]);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // dragover 기본 동작을 막아야 drop 이 발화한다.
    if (disabled) return;
    e.preventDefault();
    setState(classifyDragState({ types: e.dataTransfer?.types as unknown as string[], disabled }));
  }, [disabled]);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    // 자식 요소로 들어갈 때 발화되는 leave 는 무시 — relatedTarget 이 컨테이너 내부면 skip.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setState('idle');
  }, [disabled]);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    setState('idle');
    processFiles(e.dataTransfer?.files ?? null);
  }, [disabled, processFiles]);

  const openPicker = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(e.target.files);
    // 같은 파일을 다시 선택할 수 있도록 값 초기화.
    e.target.value = '';
  }, [processFiles]);

  const resolvedState: DropzoneVisualState = disabled ? 'disabled' : state;
  const description = useMemo(() => {
    if (disabled) return hint ?? '업로드가 비활성 상태입니다.';
    if (resolvedState === 'invalid') return '이 항목은 업로드할 수 없어요 — 파일만 드롭해 주세요.';
    if (resolvedState === 'dragover') return '여기에 놓으면 업로드됩니다.';
    return 'PDF·PPTX·이미지·영상을 끌어오거나 클릭해 선택하세요.';
  }, [disabled, resolvedState, hint]);

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label="멀티미디어 파일 업로드 드롭존"
      data-testid="upload-dropzone"
      data-state={resolvedState}
      className={`upload-dropzone${className ? ` ${className}` : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={openPicker}
      onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPicker(); } }}
      style={{
        // 토큰 기반 스킨 — 디자이너 시안이 index.css 에 값을 넣으면 그대로 반영된다.
        background: 'var(--upload-dropzone-bg, var(--pixel-card))',
        border: '2px dashed var(--upload-dropzone-border, var(--pixel-border))',
        borderColor: resolvedState === 'dragover'
          ? 'var(--upload-dropzone-border-active, var(--pixel-accent))'
          : resolvedState === 'invalid'
            ? 'var(--upload-dropzone-border-invalid, var(--error-state-border))'
            : undefined,
        color: 'var(--upload-dropzone-fg, var(--shared-goal-modal-header-fg))',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: '18px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span
        className="shrink-0"
        style={{ color: 'var(--upload-dropzone-icon, var(--pixel-accent))' }}
        aria-hidden="true"
      >
        {resolvedState === 'invalid'
          ? <AlertCircle size={20} />
          : resolvedState === 'dragover'
            ? <FilePlus2 size={20} />
            : <UploadCloud size={20} />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-bold uppercase tracking-wider">멀티미디어 업로드</div>
        <div className="text-[11px] mt-1 opacity-80">{description}</div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        onChange={onInputChange}
        data-testid="upload-dropzone-input"
        // 시각적으로 숨기되 스크린리더에는 존재해야 하므로 `hidden` 대신 .sr-only 상수 인라인.
        style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}
      />
    </div>
  );
}
