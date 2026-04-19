// 지시 #c82b4df9 — PDF 업로드·파싱·저장을 한 번에 처리하는 진입 컴포넌트.
//
// 흐름
//   1) UploadDropzone 에 PDF accept 만 걸어 사용자 파일을 받는다.
//   2) 받은 파일은 `pdfImportService.importPdf` 로 밀어 넣고, 진행률 이벤트를
//      진행률바·aria-live 라벨에 동시에 반영한다.
//   3) 완료 시 추출 메타데이터를 카드 UI 로 보여 주고, 사이드카 텍스트 미리보기 3줄.
//   4) 실패 시 `mapUnknownError` 로 매핑한 한국어 메시지를 토스트와 배너 양쪽에 띄운다.
//
// 책임 경계
//   · 본 컴포넌트는 "사용자가 이 패널 안에서 PDF 를 import 하는 시나리오" 만 안다.
//     App.tsx 의 전역 UploadDropzone 과는 별개 경로 — 후자는 혼합 멀티미디어 업로드,
//     이쪽은 PDF 만. 두 경로는 결국 같은 ProjectFileStore 로 수렴한다.
//   · 진행률바·재시도는 단일 import 기준이다. 여러 파일 동시 import 는 상위가 순차로
//     호출하는 걸 전제로 한다(이번 1차 범위 외).

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { FileText, Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';

import { UploadDropzone } from '../UploadDropzone';
import { useToast } from '../ToastProvider';
import {
  mapUnknownError,
  messageToToastInput,
  type UserFacingMessage,
} from '../../utils/errorMessages';
import { createPdfImportService, type PdfImportService } from '../../lib/multimedia/pdfImportService';
import type {
  MultimediaImportOutcome,
  MultimediaProgressEvent,
} from '../../lib/multimedia/types';

export interface PdfImportPanelProps {
  /** 업로드 대상 프로젝트. 비어 있으면 드롭존이 disabled 상태로 잠긴다. */
  projectId: string | null;
  /** import 완료 콜백. 상위 리스트를 새로고침할 때 호출. */
  onImported?: (outcome: MultimediaImportOutcome) => void;
  /**
   * 주입 가능한 서비스. 스토리북/테스트는 stub 서비스를 넘겨 실제 pdfjs-dist 로드를
   * 건너뛴다. 생략 시 모듈 싱글턴을 lazy 하게 만든다.
   */
  service?: PdfImportService;
  /** 외부 레이아웃 보정용 클래스. */
  className?: string;
}

type Phase = MultimediaProgressEvent['phase'];

interface BusyState {
  file: File;
  controller: AbortController;
  progress: MultimediaProgressEvent;
}

const PHASE_LABEL: Record<Phase, string> = {
  open: '파일 열기',
  parse: '페이지 파싱',
  persist: '저장소 기록',
  finalize: '마무리',
};

function formatPercent(ev: MultimediaProgressEvent | null): number {
  if (!ev || ev.total <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, ev.current / ev.total));
  // phase 별 가중치로 실사용 감각과 맞춘다: open 10 / parse 70 / persist 15 / finalize 5.
  const weight: Record<Phase, [number, number]> = {
    open: [0, 0.1],
    parse: [0.1, 0.8],
    persist: [0.8, 0.95],
    finalize: [0.95, 1],
  };
  const [lo, hi] = weight[ev.phase];
  return Math.round((lo + (hi - lo) * ratio) * 100);
}

export function PdfImportPanel(props: PdfImportPanelProps): React.ReactElement {
  const { projectId, onImported, service: injectedService, className } = props;
  const toast = useToast();

  // 서비스는 한 번만 lazy 하게 만든다(pdfjs-dist 동적 import 가 실사용 순간까지 지연됨).
  const serviceRef = useRef<PdfImportService | null>(injectedService ?? null);
  const getService = useCallback((): PdfImportService => {
    if (!serviceRef.current) serviceRef.current = createPdfImportService();
    return serviceRef.current;
  }, []);

  const [busy, setBusy] = useState<BusyState | null>(null);
  const [outcome, setOutcome] = useState<MultimediaImportOutcome | null>(null);
  const [error, setError] = useState<UserFacingMessage | null>(null);

  const maxBytes = useMemo(() => (injectedService ?? getService()).maxBytes, [injectedService, getService]);
  const accept = useMemo(() => (injectedService ?? getService()).accept, [injectedService, getService]);

  const runImport = useCallback(async (file: File) => {
    if (!projectId) return;
    const controller = new AbortController();
    const initial: MultimediaProgressEvent = { phase: 'open', current: 0, total: file.size };
    setBusy({ file, controller, progress: initial });
    setError(null);
    setOutcome(null);
    try {
      const result = await getService().importPdf({
        projectId,
        file,
        signal: controller.signal,
        onProgress: (ev) => {
          setBusy((prev) => (prev && prev.controller === controller ? { ...prev, progress: ev } : prev));
        },
      });
      setOutcome(result);
      onImported?.(result);
      toast.push({
        variant: 'success',
        title: 'PDF 를 가져왔습니다',
        description: result.extractedTextRecord
          ? `${file.name} 의 본문을 추출해 프로젝트에 저장했어요.`
          : `${file.name} 은 저장했지만 추출 가능한 텍스트가 없어요(스캔 문서일 수 있음).`,
      });
    } catch (err) {
      const msg = mapUnknownError(err);
      setError(msg);
      toast.push(messageToToastInput(msg));
    } finally {
      setBusy((prev) => (prev && prev.controller === controller ? null : prev));
    }
  }, [projectId, getService, onImported, toast]);

  const onFilesAccepted = useCallback((files: File[]) => {
    // 1차 구현은 단일 파일만 — 나머지는 토스트로 안내하고 상위가 루프를 붙일 수 있다.
    const [first, ...rest] = files;
    if (!first) return;
    if (rest.length > 0) {
      toast.push({
        variant: 'info',
        title: '첫 PDF 한 개만 처리합니다',
        description: `나머지 ${rest.length}개는 취소되었어요. 한 번에 한 파일만 선택해 주세요.`,
      });
    }
    void runImport(first);
  }, [runImport, toast]);

  const onCancel = useCallback(() => {
    busy?.controller.abort();
  }, [busy]);

  const progressPct = formatPercent(busy?.progress ?? null);
  const statusText = busy ? `${PHASE_LABEL[busy.progress.phase]} · ${progressPct}%` : null;

  return (
    <section
      aria-label="PDF 가져오기"
      className={`pdf-import-panel${className ? ` ${className}` : ''}`}
      data-testid="pdf-import-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        background: 'var(--pixel-card)',
        border: '1px solid var(--pixel-border)',
        borderRadius: 8,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <FileText size={16} aria-hidden="true" />
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
          PDF 가져오기
        </h3>
      </header>

      <UploadDropzone
        onFilesAccepted={onFilesAccepted}
        disabled={!projectId || busy !== null}
        accept={accept}
        maxBytes={maxBytes}
        hint={!projectId ? '먼저 프로젝트를 선택해 주세요.' : undefined}
      />

      {busy && (
        <div
          role="status"
          aria-live="polite"
          data-testid="pdf-import-progress"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: 12,
            background: 'var(--pixel-card-muted, rgba(255,255,255,0.04))',
            border: '1px solid var(--pixel-border)',
            borderRadius: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <Loader2 size={14} aria-hidden="true" className="animate-spin" />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {busy.file.name}
            </span>
            <button
              type="button"
              onClick={onCancel}
              aria-label="PDF 가져오기 취소"
              data-testid="pdf-import-cancel"
              style={{ background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', padding: 2 }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="PDF 처리 진행률"
            style={{ height: 6, background: 'var(--pixel-border)', borderRadius: 3, overflow: 'hidden' }}
          >
            <div
              style={{
                width: `${progressPct}%`,
                height: '100%',
                background: 'var(--pixel-accent)',
                transition: 'width 200ms ease',
              }}
            />
          </div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>{statusText}</div>
        </div>
      )}

      {outcome && !busy && (
        <div
          role="status"
          aria-live="polite"
          data-testid="pdf-import-outcome"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: 12,
            background: 'var(--success-state-bg, rgba(74,222,128,0.08))',
            border: '1px solid var(--success-state-border, rgba(74,222,128,0.4))',
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
            <CheckCircle2 size={14} aria-hidden="true" />
            <span>가져오기 완료</span>
          </div>
          <div>
            원본: <strong>{outcome.originalRecord.name}</strong>
            {' · '}페이지 {outcome.result.metadata.pageCount ?? '?'}개
            {outcome.result.metadata.title ? ` · 제목: ${outcome.result.metadata.title}` : ''}
          </div>
          {outcome.extractedTextRecord ? (
            <div style={{ opacity: 0.85 }}>
              추출 텍스트 저장: <code>{outcome.extractedTextRecord.name}</code>
            </div>
          ) : (
            <div style={{ opacity: 0.85 }}>추출 가능한 텍스트가 없어 사이드카를 저장하지 않았습니다.</div>
          )}
          {outcome.result.text && (
            <pre
              style={{
                margin: 0,
                padding: 8,
                background: 'var(--pixel-card)',
                border: '1px solid var(--pixel-border)',
                borderRadius: 4,
                maxHeight: 96,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 11,
              }}
            >
              {outcome.result.text.slice(0, 400)}
              {outcome.result.text.length > 400 ? '…' : ''}
            </pre>
          )}
        </div>
      )}

      {error && !busy && (
        <div
          role="alert"
          data-testid="pdf-import-error"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: 12,
            background: 'var(--error-state-bg, rgba(248,113,113,0.08))',
            border: '1px solid var(--error-state-border, rgba(248,113,113,0.4))',
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <AlertTriangle size={14} aria-hidden="true" style={{ marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{error.title}</div>
            {error.body && <div style={{ opacity: 0.85 }}>{error.body}</div>}
          </div>
        </div>
      )}
    </section>
  );
}
