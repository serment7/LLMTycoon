// 지시 #82bd96f7 — PPT(.pptx) 업로드·파싱·저장 진입 컴포넌트.
//
// PdfImportPanel 과 동일한 UX 패턴을 따라 학습 비용을 없앤다:
//   · UploadDropzone(accept 는 파서 기본값) 을 한 개 마운트
//   · 진행률 단계를 open / parse / persist / finalize 네 phase 로 중계
//   · 완료 시 추출 메타(title, 슬라이드 수, 노트 수, 미디어 파일 수) 를 카드에 표기
//   · 실패 시 mapUnknownError 매핑 결과를 배너 + 토스트로 동시 노출
//
// PDF 패널과 다른 점
//   · "요약 마크다운(.summary.md)" 사이드카 저장을 성공 카드에 명시
//   · 슬라이드 0장(본문 미검출) 특수 케이스 문구 분기

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { FileText, Loader2, CheckCircle2, AlertTriangle, X, Presentation } from 'lucide-react';

import { UploadDropzone } from '../UploadDropzone';
import { useToast } from '../ToastProvider';
import {
  mapUnknownError,
  messageToToastInput,
  type UserFacingMessage,
} from '../../utils/errorMessages';
import {
  createPptImportService,
  type PptImportService,
  type PptImportOutcome,
} from '../../services/pptImportService';
import type { MultimediaProgressEvent } from '../../lib/multimedia/types';

export interface PptImportPanelProps {
  projectId: string | null;
  onImported?: (outcome: PptImportOutcome) => void;
  service?: PptImportService;
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
  parse: '슬라이드 파싱',
  persist: '저장소 기록',
  finalize: '마무리',
};

function formatPercent(ev: MultimediaProgressEvent | null): number {
  if (!ev || ev.total <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, ev.current / ev.total));
  // PDF 패널과 동일한 phase 가중치 — 100MB 경계 .pptx 에서도 parse 구간이 가장
  // 길게 잡혀 사용자가 "멈췄다" 로 오해하지 않도록 60~75% 를 parse 에 배정한다.
  const weight: Record<Phase, [number, number]> = {
    open: [0, 0.1],
    parse: [0.1, 0.75],
    persist: [0.75, 0.95],
    finalize: [0.95, 1],
  };
  const [lo, hi] = weight[ev.phase];
  return Math.round((lo + (hi - lo) * ratio) * 100);
}

export function PptImportPanel(props: PptImportPanelProps): React.ReactElement {
  const { projectId, onImported, service: injectedService, className } = props;
  const toast = useToast();

  // pptParser 의 ZIP 엔진은 경량이지만, 실 사용 순간까지 초기화를 늦춰 초기 번들 영향을 0.
  const serviceRef = useRef<PptImportService | null>(injectedService ?? null);
  const getService = useCallback((): PptImportService => {
    if (!serviceRef.current) serviceRef.current = createPptImportService();
    return serviceRef.current;
  }, []);

  const [busy, setBusy] = useState<BusyState | null>(null);
  const [outcome, setOutcome] = useState<PptImportOutcome | null>(null);
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
      const result = await getService().importPpt({
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
        title: 'PPT 를 가져왔습니다',
        description: result.extractedTextRecord
          ? `${file.name} 의 슬라이드 ${result.result.slides.length}장을 추출해 저장했어요.`
          : `${file.name} 은 저장했지만 추출 가능한 텍스트가 없어요(이미지 기반 슬라이드일 수 있음).`,
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
    const [first, ...rest] = files;
    if (!first) return;
    if (rest.length > 0) {
      toast.push({
        variant: 'info',
        title: '첫 PPT 한 개만 처리합니다',
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
      aria-label="PPT 가져오기"
      className={`ppt-import-panel${className ? ` ${className}` : ''}`}
      data-testid="ppt-import-panel"
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
        <Presentation size={16} aria-hidden="true" />
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>
          PPT 가져오기
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
          data-testid="ppt-import-progress"
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
              aria-label="PPT 가져오기 취소"
              data-testid="ppt-import-cancel"
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
            aria-label="PPT 처리 진행률"
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
          data-testid="ppt-import-outcome"
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
            {' · '}슬라이드 {outcome.result.slides.length}장
            {outcome.result.metadata.title ? ` · 제목: ${outcome.result.metadata.title}` : ''}
          </div>
          <div style={{ opacity: 0.85 }}>
            <FileText size={11} aria-hidden="true" style={{ display: 'inline', marginRight: 4 }} />
            {outcome.extractedTextRecord ? (
              <>추출 텍스트: <code>{outcome.extractedTextRecord.name}</code></>
            ) : (
              <>추출 가능한 텍스트가 없어 사이드카를 저장하지 않았습니다.</>
            )}
          </div>
          {outcome.summaryRecord && (
            <div style={{ opacity: 0.85 }}>
              에이전트용 요약: <code>{outcome.summaryRecord.name}</code>
            </div>
          )}
          {outcome.result.mediaFiles.length > 0 && (
            <div style={{ opacity: 0.75, fontSize: 11 }}>
              내장 미디어 {outcome.result.mediaFiles.length}개 · 썸네일 {outcome.result.thumbnailName ? '있음' : '없음'}
            </div>
          )}
        </div>
      )}

      {error && !busy && (
        <div
          role="alert"
          data-testid="ppt-import-error"
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
