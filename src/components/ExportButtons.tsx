// ExportButtons(#25c6969c) — 멀티미디어 "출력" 진입 컴포넌트.
//
// 책임
//   1) PDF 리포트·PPTX 덱·영상 생성 3개 액션을 한 줄에 묶어 노출한다.
//   2) 내보내기 진행 중(busyKind != null) 에는 해당 버튼만 비활성화하고 스피너를
//      표시해 다른 액션은 계속 사용 가능하도록 한다.
//   3) 실패는 상위에서 errorMessages.mapMediaExporterError → toast 로 연결한다.
//      본 컴포넌트는 액션 위임만 담당 — 단위 테스트 경계 분리.

import React, { useEffect } from 'react';
import { FileText, FileDown, Video, Loader2 } from 'lucide-react';

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 — 버튼 활성화/라벨 파생
// ────────────────────────────────────────────────────────────────────────────

export type ExportKind = 'pdf' | 'pptx' | 'video';

/**
 * 상위가 Promise 를 호출할 때 넘겨주는 현재 진행 상태. 한 번에 하나의 종류만 busy.
 * 동시에 여러 export 를 허용하고 싶으면 이 타입을 `readonly ExportKind[]` 로 확장.
 */
export type ExportBusyState = ExportKind | null;

export interface ExportButtonDescriptor {
  kind: ExportKind;
  label: string;
  description: string;
  icon: React.ReactElement;
}

/**
 * 단축키 맵. 디자이너 시안이 "Alt + 영문 한 글자" 규약을 고정했다 — P=PDF, S=PPT(slides),
 * V=Video. 한글 IME 상태에서도 Alt 조합은 동일하게 발화된다(브라우저 레벨 키코드 우선).
 */
const EXPORT_SHORTCUT: Readonly<Record<ExportKind, { alt: true; key: string; label: string }>> = Object.freeze({
  pdf:   { alt: true, key: 'p', label: 'Alt+P' },
  pptx:  { alt: true, key: 's', label: 'Alt+S' },
  video: { alt: true, key: 'v', label: 'Alt+V' },
});

export const EXPORT_BUTTONS: ReadonlyArray<ExportButtonDescriptor> = Object.freeze([
  {
    kind: 'pdf',
    label: 'PDF 리포트',
    description: '현재 첨부·토론을 PDF 문서로 내보냅니다. (Alt+P)',
    icon: <FileText size={14} aria-hidden="true" />,
  },
  {
    kind: 'pptx',
    label: 'PPTX 덱',
    description: '주요 포인트를 슬라이드 덱으로 조립합니다. (Alt+S)',
    icon: <FileDown size={14} aria-hidden="true" />,
  },
  {
    kind: 'video',
    label: '영상 생성',
    description: '프롬프트로 짧은 영상을 생성합니다(어댑터 필요). (Alt+V)',
    icon: <Video size={14} aria-hidden="true" />,
  },
]) as ReadonlyArray<ExportButtonDescriptor>;

/**
 * Alt 조합 키보드 이벤트를 `ExportKind` 로 매핑한다. Alt 없이 같은 글자를 눌러도
 * 매칭되지 않는다 — 본문 입력과의 충돌을 피하는 계약. 매칭 없으면 null.
 */
export function resolveExportShortcut(params: {
  key: string;
  altKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): ExportKind | null {
  if (!params.altKey) return null;
  // Alt + Ctrl 또는 Alt + Meta 조합은 시스템/브라우저 단축키일 가능성이 높아 제외한다.
  if (params.ctrlKey || params.metaKey) return null;
  const k = (params.key ?? '').toLowerCase();
  for (const kind of Object.keys(EXPORT_SHORTCUT) as ExportKind[]) {
    if (EXPORT_SHORTCUT[kind].key === k) return kind;
  }
  return null;
}

/** `EXPORT_SHORTCUT` 을 외부(툴팁·테스트) 에서 읽기 전용으로 노출한다. */
export function exportShortcutLabel(kind: ExportKind): string {
  return EXPORT_SHORTCUT[kind]?.label ?? '';
}

/**
 * 버튼별 활성/비활성 + 라벨을 파생한다. `disabled` 가 전역 차단(예: 프로젝트 미선택),
 * `busyKind` 는 "이 종류만 로딩 중" 이라 나머지는 계속 활성 상태로 둔다. 이 함수는
 * React 없이 테스트로 계약을 잠근다.
 */
export function deriveExportButtonState(params: {
  kind: ExportKind;
  disabled?: boolean;
  busyKind?: ExportBusyState;
}): { disabled: boolean; label: string; busy: boolean } {
  const descriptor = EXPORT_BUTTONS.find(b => b.kind === params.kind);
  const label = descriptor?.label ?? params.kind;
  if (params.disabled) return { disabled: true, label, busy: false };
  const busy = params.busyKind === params.kind;
  return { disabled: busy, label: busy ? `${label} 중…` : label, busy };
}

// ────────────────────────────────────────────────────────────────────────────
// React 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

export interface ExportButtonsProps {
  onExport: (kind: ExportKind) => void;
  /** 전역 차단(프로젝트 미선택 등). true 면 모든 버튼이 disabled. */
  disabled?: boolean;
  /** 특정 종류가 진행 중이면 그 버튼만 비활성 + 스피너. */
  busyKind?: ExportBusyState;
  className?: string;
}

export function ExportButtons({
  onExport,
  disabled = false,
  busyKind = null,
  className,
}: ExportButtonsProps): React.ReactElement {
  // 전역 단축키 청취 — 입력 요소(input/textarea/contenteditable) 안에서는 발화하지
  // 않아 본문 작성과 충돌하지 않는다. disabled 이거나 해당 종류가 busy 이면 무시.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: KeyboardEvent) => {
      const kind = resolveExportShortcut({
        key: e.key,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      });
      if (!kind) return;
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      if (disabled) return;
      if (busyKind === kind) return;
      e.preventDefault();
      onExport(kind);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [disabled, busyKind, onExport]);

  return (
    <div
      data-testid="export-buttons"
      data-tour-anchor="export-buttons"
      className={`export-buttons${className ? ` ${className}` : ''}`}
      role="group"
      aria-label="멀티미디어 내보내기 (Alt+P: PDF, Alt+S: PPTX, Alt+V: 영상)"
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      {EXPORT_BUTTONS.map(desc => {
        const { disabled: btnDisabled, label, busy } = deriveExportButtonState({
          kind: desc.kind, disabled, busyKind,
        });
        const shortcut = exportShortcutLabel(desc.kind);
        return (
          <button
            key={desc.kind}
            type="button"
            onClick={() => onExport(desc.kind)}
            disabled={btnDisabled}
            data-testid={`export-button-${desc.kind}`}
            data-busy={busy ? 'true' : 'false'}
            data-shortcut={shortcut}
            title={`${desc.description}`}
            aria-label={`${label} 내보내기 (단축키 ${shortcut})`}
            aria-keyshortcuts={shortcut}
            className="px-3 py-2 text-[11px] font-bold uppercase flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: 'var(--export-button-bg, var(--pixel-card))',
              color: 'var(--export-button-fg, var(--shared-goal-modal-header-fg))',
              border: '2px solid var(--export-button-border, var(--pixel-border))',
              borderLeft: `6px solid ${
                desc.kind === 'pdf'
                  ? 'var(--export-button-accent-pdf, var(--pixel-accent))'
                  : desc.kind === 'pptx'
                    ? 'var(--export-button-accent-pptx, var(--token-usage-caution-border))'
                    : 'var(--export-button-accent-video, var(--token-usage-warning-border))'
              }`,
            }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : desc.icon}
            <span>{label}</span>
            {/* 단축키 배지 — 시각 사용자에게 "Alt+X" 를 노출. aria 는 중복 낭독을 피하려 hidden. */}
            <span
              aria-hidden="true"
              data-testid={`export-button-${desc.kind}-shortcut`}
              style={{
                marginLeft: 6,
                padding: '0 4px',
                fontSize: 9,
                lineHeight: '14px',
                letterSpacing: '0.05em',
                border: '1px solid currentColor',
                opacity: 0.7,
                borderRadius: 2,
              }}
            >
              {shortcut}
            </span>
          </button>
        );
      })}
    </div>
  );
}
