// 지시 #95de334d · 세부 뷰 공용 placeholder.
//
// 각 어댑터(PDF·PPT·WebSearch·Research·Video·InputAutomation) 의 입력 폼·결과 프리뷰는
// 이미 선행 시안(multimedia-ui-spec.md §4·§5, video-generation-ui-spec.md §3~§5 등) 이
// 확정해 둔 복잡한 구성이다. 본 라운드에서는 "허브 라우트가 각 축의 shell 을 올바른 카드
// 메타로 렌더한다" 까지만 책임지고, 실제 폼/결과 컴포넌트는 기존 MediaGenerationCard·
// MediaPipelinePanel·PdfImportPanel·PptImportPanel 을 점진적으로 붙이는 후속 PR 에서
// 교체한다. 본 placeholder 는 어댑터 ID + 설명 + shell 계약 체크용 테스트 훅만 노출한다.

import React, { useState } from 'react';
import { MediaAdapterError } from '../../../services/multimedia';

import type { MultimediaCardMeta } from '../routes';
import { MultimediaAdapterShell, type MultimediaAdapterPhase } from '../MultimediaAdapterShell';
import { useMultimediaJobs } from '../useMultimediaJobs';

export interface PlaceholderAdapterViewProps {
  readonly card: MultimediaCardMeta;
  readonly onClose?: () => void;
  readonly locked?: boolean;
  readonly unlockHint?: string;
  readonly onUnlockClick?: () => void;
  /** 어댑터 등록 여부를 외부(레지스트리) 에서 해석해 주입. 미등록은 잠금과 구분해 빈
   *  상태 + 안내 카피로 표시한다. */
  readonly registered?: boolean;
  /** 테스트·스토리북에서 phase 를 강제 지정. 미지정 시 'form' 이 기본. */
  readonly forcePhase?: MultimediaAdapterPhase;
}

export function PlaceholderAdapterView(props: PlaceholderAdapterViewProps): React.ReactElement {
  const { card, registered = true, forcePhase } = props;
  const jobs = useMultimediaJobs();
  const runningJob = jobs.byKind(card.kind).find((j) => j.status === 'running' || j.status === 'queued');

  const initial: MultimediaAdapterPhase = forcePhase
    ?? (!registered ? 'error'
      : runningJob ? 'loading'
        : 'form');
  const [phase, setPhase] = useState<MultimediaAdapterPhase>(initial);

  const [errorState, setErrorState] = useState<{ code?: string; message?: string } | null>(
    !registered
      ? { code: 'ADAPTER_NOT_REGISTERED', message: '현재 워크스페이스에 해당 어댑터가 등록되지 않았어요.' }
      : null,
  );

  const handleRunStub = (): void => {
    setPhase('loading');
    const id = jobs.store.start({ kind: card.kind, title: card.label });
    jobs.store.update(id, { status: 'running', progress: 0.1, phase: 'precheck' });
    // 스텁 경로 — 실제 어댑터 호출은 후속 PR 에서 registry.resolveByKind(kind).invoke() 와 연결.
    setTimeout(() => {
      try {
        // 의도적으로 실패 분기(현재는 실구현 결합 전).
        throw new MediaAdapterError('INTERNAL', '세부 뷰 구현은 후속 라운드에서 합류 예정입니다.');
      } catch (err) {
        const msg = err instanceof MediaAdapterError ? err.message : String(err);
        jobs.store.fail(id, msg);
        setErrorState({ code: 'INTERNAL', message: msg });
        setPhase('error');
      }
    }, 50);
  };

  return (
    <MultimediaAdapterShell
      card={card}
      phase={phase}
      runningJob={runningJob}
      locked={props.locked}
      unlockHint={props.unlockHint}
      onUnlockClick={props.onUnlockClick}
      onClose={props.onClose}
      errorCode={errorState?.code}
      errorMessage={errorState?.message}
      onRetry={phase === 'error' ? handleRunStub : undefined}
      formSlot={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 12 }}>
            {card.label} 세부 입력 폼은 선행 시안(multimedia-ui-spec §4·§5) 과 각 어댑터 전용 컴포넌트를
            인계받는 후속 라운드에서 이 자리에 들어갑니다. 지금은 어댑터 연결만 점검할 수 있는
            "실행" 버튼을 제공합니다.
          </p>
          <div>
            <button
              type="button"
              data-testid={`multimedia-view-${card.route}-run-stub`}
              onClick={handleRunStub}
              disabled={props.locked || !registered}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 700,
                background: 'var(--shared-goal-modal-confirm-bg, #34d399)',
                color: 'var(--shared-goal-modal-confirm-fg, #052e1b)',
                border: '1px solid var(--attachment-preview-border)',
                cursor: props.locked || !registered ? 'not-allowed' : 'pointer',
                opacity: props.locked || !registered ? 0.6 : 1,
              }}
            >
              시작 →
            </button>
          </div>
        </div>
      }
      previewSlot={
        <p style={{ margin: 0, fontSize: 12 }}>
          결과 프리뷰는 각 축 전용 컴포넌트로 교체될 예정이에요.
        </p>
      }
    />
  );
}
