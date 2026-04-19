// ExportButtons(#25c6969c) — 멀티미디어 "출력" 진입 컴포넌트.
//
// 책임
//   1) PDF 리포트·PPTX 덱·영상 생성 3개 액션을 한 줄에 묶어 노출한다.
//   2) 내보내기 진행 중(busyKind != null) 에는 해당 버튼만 비활성화하고 스피너를
//      표시해 다른 액션은 계속 사용 가능하도록 한다.
//   3) 실패는 상위에서 errorMessages.mapMediaExporterError → toast 로 연결한다.
//      본 컴포넌트는 액션 위임만 담당 — 단위 테스트 경계 분리.

import React from 'react';
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

export const EXPORT_BUTTONS: ReadonlyArray<ExportButtonDescriptor> = Object.freeze([
  {
    kind: 'pdf',
    label: 'PDF 리포트',
    description: '현재 첨부·토론을 PDF 문서로 내보냅니다.',
    icon: <FileText size={14} aria-hidden="true" />,
  },
  {
    kind: 'pptx',
    label: 'PPTX 덱',
    description: '주요 포인트를 슬라이드 덱으로 조립합니다.',
    icon: <FileDown size={14} aria-hidden="true" />,
  },
  {
    kind: 'video',
    label: '영상 생성',
    description: '프롬프트로 짧은 영상을 생성합니다(어댑터 필요).',
    icon: <Video size={14} aria-hidden="true" />,
  },
]) as ReadonlyArray<ExportButtonDescriptor>;

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
  return (
    <div
      data-testid="export-buttons"
      className={`export-buttons${className ? ` ${className}` : ''}`}
      role="group"
      aria-label="멀티미디어 내보내기"
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
        return (
          <button
            key={desc.kind}
            type="button"
            onClick={() => onExport(desc.kind)}
            disabled={btnDisabled}
            data-testid={`export-button-${desc.kind}`}
            data-busy={busy ? 'true' : 'false'}
            title={desc.description}
            aria-label={`${label} 내보내기`}
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
            {label}
          </button>
        );
      })}
    </div>
  );
}
