// 지시 #f6052a91 · App.tsx 용 멀티미디어 파이프라인 패널 — 1차 스켈레톤.
//
// MediaAttachmentPanel(업로드 UI) + src/utils/mediaLoaders(업로드·생성 디스패처) 를
// 연결하고, 각 처리 결과를 그대로 그려 주는 미리보기 영역을 포함한다. 지시에서 요구한
// "업로드 → 종류 판별 → 각 로더 호출 → 결과 미리보기" 흐름의 단일 위치 구현이다.
//
// 본 컴포넌트는 parent 가 projectId 만 넘기면 된다. 네트워크 경로(/api/media/*) 는
// mediaLoaders 가 소유하고, 패널 자체는 상태·렌더만 책임진다(presentational 분리).

import React, { useCallback, useState } from 'react';
import type { MediaAsset, MediaKind } from '../types';
import { MediaAttachmentPanel, useMediaAttachmentPanel } from './MediaAttachmentPanel';
import {
  detectMediaKind,
  loadMediaFile,
  requestVideoGeneration,
  MediaLoaderError,
  type MediaPreview,
} from '../utils/mediaLoaders';

export interface MediaPipelinePanelProps {
  projectId: string | null;
  /** 선택 — 주입하면 업로드/생성 성공 시 동일 자산을 부모 상태에도 반영할 수 있다. */
  onAssetReady?: (asset: MediaAsset) => void;
  /** SSR/테스트 환경에서 fetch 를 직접 주입하고 싶을 때만 사용. */
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}

const KIND_LABEL: Record<MediaKind, string> = {
  video: '영상',
  pdf: 'PDF',
  pptx: 'PPT',
  image: '이미지',
};

export function MediaPipelinePanel(props: MediaPipelinePanelProps) {
  const { assets, addAssets, removeAsset } = useMediaAttachmentPanel();
  const [previews, setPreviews] = useState<MediaPreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFilesAdded = useCallback(async (files: File[]) => {
    if (!props.projectId) {
      setError('프로젝트를 먼저 선택해 주세요.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      for (const file of files) {
        const kind = detectMediaKind(file.name, file.type);
        if (!kind) {
          setError(`지원하지 않는 파일 형식: ${file.name}`);
          continue;
        }
        try {
          const preview = await loadMediaFile(file, {
            projectId: props.projectId,
            fetcher: props.fetcher,
          });
          setPreviews((prev) => [...prev, preview]);
          const asset: MediaAsset = {
            id: preview.id,
            projectId: props.projectId,
            kind: preview.kind,
            name: preview.name,
            mimeType: preview.mimeType,
            sizeBytes: preview.sizeBytes,
            createdAt: preview.createdAt,
            extractedText: preview.extractedText,
            generatedBy: preview.generatedBy,
          };
          addAssets([asset]);
          props.onAssetReady?.(asset);
        } catch (err) {
          const msg = err instanceof MediaLoaderError
            ? err.message
            : `${file.name}: 업로드 실패`;
          setError(msg);
        }
      }
    } finally {
      setBusy(false);
    }
  }, [addAssets, props]);

  const handleGenerate = useCallback(async ({ kind, prompt }: { kind: MediaKind; prompt: string }) => {
    if (!props.projectId) {
      setError('프로젝트를 먼저 선택해 주세요.');
      return;
    }
    if (kind !== 'video') {
      setError('현재 1차 스켈레톤은 영상 생성만 지원합니다.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const preview = await requestVideoGeneration(
        { prompt, projectId: props.projectId },
        { fetcher: props.fetcher },
      );
      setPreviews((prev) => [...prev, preview]);
      const asset: MediaAsset = {
        id: preview.id,
        projectId: props.projectId,
        kind: preview.kind,
        name: preview.name,
        mimeType: preview.mimeType,
        sizeBytes: preview.sizeBytes,
        createdAt: preview.createdAt,
        generatedBy: preview.generatedBy,
      };
      addAssets([asset]);
      props.onAssetReady?.(asset);
    } catch (err) {
      setError(err instanceof MediaLoaderError ? err.message : '영상 생성 요청 실패');
    } finally {
      setBusy(false);
    }
  }, [addAssets, props]);

  return (
    <div data-testid="media-pipeline-panel" className="space-y-2">
      <MediaAttachmentPanel
        assets={assets}
        onFilesAdded={handleFilesAdded}
        onRemove={removeAsset}
        onGenerate={handleGenerate}
        disabled={busy || !props.projectId}
      />
      {error && (
        <p
          role="alert"
          data-testid="media-pipeline-error"
          className="text-[11px] text-red-400 border border-red-400/50 px-2 py-1"
        >
          {error}
        </p>
      )}
      {previews.length > 0 && (
        <section
          aria-label="미디어 처리 결과 미리보기"
          data-testid="media-pipeline-previews"
          className="border-2 border-[var(--pixel-border)] p-2 bg-black/20 space-y-2"
        >
          <h4 className="text-[11px] uppercase tracking-wider">미리보기</h4>
          <ul className="space-y-2">
            {previews.map((p) => (
              <li
                key={p.id}
                data-testid={`media-preview-${p.id}`}
                data-kind={p.kind}
                className="text-[11px] border border-[var(--pixel-border)] p-2"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-1 border border-[var(--pixel-border)]">
                    {KIND_LABEL[p.kind]}
                  </span>
                  <span className="truncate" title={p.name}>{p.name}</span>
                </div>
                {p.extractedText && (
                  <pre
                    data-testid={`media-preview-text-${p.id}`}
                    className="whitespace-pre-wrap text-[10px] opacity-80 max-h-32 overflow-y-auto"
                  >
                    {p.extractedText.slice(0, 400)}
                    {p.extractedText.length > 400 ? '…' : ''}
                  </pre>
                )}
                {p.generatedBy && (
                  <p className="text-[10px] opacity-70" data-testid={`media-preview-gen-${p.id}`}>
                    생성자: {p.generatedBy.adapter} · "{p.generatedBy.prompt}"
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default MediaPipelinePanel;
