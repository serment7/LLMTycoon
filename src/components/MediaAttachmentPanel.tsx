/**
 * 멀티미디어 첨부 패널 — 지시 #f6052a91 의 UI 측 스켈레톤.
 *
 * 공동 목표가 확장되면서 영상·PDF·PPT 자산을 지시에 첨부하거나 직접 "생성 요청" 할
 * 수 있어야 한다. 본 컴포넌트는 그 첫 단계로, DirectivePrompt 와 나란히 놓을 수 있는
 * 독립 presentational 영역이다. 실제 업로드/생성 호출(fetch) 은 부모가 수행하고, 본
 * 컴포넌트는 자산 목록·선택 버튼·생성 프롬프트만 그린다.
 *
 * DirectivePrompt.tsx 와의 합성은 `useMediaAttachmentPanel()` 훅이 제공한다 — 현재는
 * 자산 배열과 add/remove/clear 헬퍼만 돌려 주지만, 이후 업로드 진행률·에러 토스트와
 * 엮이면 훅 내부만 확장하면 된다(호출 쪽 마이그레이션 없음).
 *
 * 아직 DirectivePrompt.tsx 는 건드리지 않는다 — 병합 충돌을 피하기 위한 의도적 선택.
 * DirectivePrompt 가 "지시 본문 + 텍스트 첨부" 축을 책임지고, 본 패널이 "멀티미디어"
 * 축을 소유한 뒤, 상위 레이아웃(App.tsx 또는 ProjectManagement.tsx) 이 두 영역을 같은
 * 지시 컨텍스트로 묶는다.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { MediaAsset, MediaKind } from '../types';

export interface MediaAttachmentPanelProps {
  assets: ReadonlyArray<MediaAsset>;
  onFilesAdded: (files: File[]) => void;
  onRemove: (id: string) => void;
  /**
   * 생성 요청. 미제공 시 "생성 요청" 영역을 감춘다 — 업로드 전용 모드 지원.
   */
  onGenerate?: (params: { kind: MediaKind; prompt: string }) => void;
  /** input[type=file] accept. 미지정 시 4종 MediaKind 기본값. */
  accept?: string;
  disabled?: boolean;
}

const KIND_LABEL: Record<MediaKind, string> = {
  video: '영상',
  pdf: 'PDF',
  pptx: 'PPT',
  image: '이미지',
};

// DirectivePrompt 와 동일 토큰 계열(픽셀 테두리)을 쓴다. 컬러는 향후 디자이너가
// 별도 변수(--media-attachment-*)로 분리할 수 있도록 className 훅을 남겨 둔다.
export function MediaAttachmentPanel(props: MediaAttachmentPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [genPrompt, setGenPrompt] = useState('');
  const [genKind, setGenKind] = useState<MediaKind>('video');

  const handleChoose = useCallback(() => {
    if (!props.disabled) inputRef.current?.click();
  }, [props.disabled]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    const files: File[] = list ? Array.from(list) : [];
    if (files.length > 0) props.onFilesAdded(files);
    // 같은 파일을 다시 선택해도 change 이벤트가 터지도록 값을 초기화한다.
    e.target.value = '';
  }, [props]);

  const handleSubmitGenerate = useCallback(() => {
    const trimmed = genPrompt.trim();
    if (!trimmed || !props.onGenerate) return;
    props.onGenerate({ kind: genKind, prompt: trimmed });
    setGenPrompt('');
  }, [genKind, genPrompt, props]);

  const grouped = useMemo(() => {
    const by: Record<MediaKind, MediaAsset[]> = { video: [], pdf: [], pptx: [], image: [] };
    for (const a of props.assets) {
      if (a.kind in by) by[a.kind].push(a);
    }
    return by;
  }, [props.assets]);

  return (
    <section
      data-testid="media-attachment-panel"
      aria-label="멀티미디어 첨부"
      className="media-attachment-panel border-2 border-[var(--pixel-border)] p-3 bg-black/20"
    >
      <header className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] uppercase tracking-wider" id="media-attachment-title">
          멀티미디어 첨부
        </h3>
        <button
          type="button"
          onClick={handleChoose}
          disabled={props.disabled}
          data-testid="media-attachment-choose"
          aria-describedby="media-attachment-title"
          className="text-[11px] px-2 py-1 border border-[var(--pixel-border)] disabled:opacity-50"
        >
          파일 선택
        </button>
      </header>

      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        accept={props.accept ?? '.pdf,.pptx,.ppt,video/*,image/*'}
        onChange={handleChange}
        data-testid="media-attachment-input"
        aria-hidden="true"
      />

      {props.assets.length === 0 ? (
        <p
          className="text-[11px] opacity-70"
          data-testid="media-attachment-empty"
          role="status"
        >
          아직 첨부된 미디어가 없습니다.
        </p>
      ) : (
        <ul className="space-y-1" data-testid="media-attachment-list">
          {props.assets.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between text-[11px]"
              data-testid={`media-asset-${a.id}`}
              data-kind={a.kind}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className="px-1 border border-[var(--pixel-border)] shrink-0"
                  data-testid={`media-asset-kind-${a.id}`}
                >
                  {KIND_LABEL[a.kind]}
                </span>
                <span className="truncate" title={a.name}>{a.name}</span>
              </span>
              <button
                type="button"
                onClick={() => props.onRemove(a.id)}
                aria-label={`${a.name} 제거`}
                data-testid={`media-asset-remove-${a.id}`}
                className="text-[10px] opacity-70 hover:opacity-100 ml-2"
              >
                제거
              </button>
            </li>
          ))}
        </ul>
      )}

      {props.onGenerate && (
        <div
          className="mt-3 pt-2 border-t border-[var(--pixel-border)]"
          data-testid="media-generate-panel"
        >
          <label
            className="text-[11px] block mb-1"
            htmlFor="media-generate-prompt-input"
          >
            생성 프롬프트
          </label>
          <textarea
            id="media-generate-prompt-input"
            value={genPrompt}
            onChange={(e) => setGenPrompt(e.target.value)}
            placeholder="생성할 미디어를 한 문장으로 설명하세요"
            className="w-full text-[11px] p-2 bg-black/40 border border-[var(--pixel-border)]"
            rows={2}
            data-testid="media-generate-prompt"
            disabled={props.disabled}
          />
          <div className="flex gap-2 mt-2 items-center">
            <label className="text-[11px] opacity-70" htmlFor="media-generate-kind-select">
              종류
            </label>
            <select
              id="media-generate-kind-select"
              value={genKind}
              onChange={(e) => setGenKind(e.target.value as MediaKind)}
              data-testid="media-generate-kind"
              className="text-[11px] bg-black/40 border border-[var(--pixel-border)] px-1"
              disabled={props.disabled}
            >
              <option value="video">영상</option>
              <option value="pdf">PDF</option>
              <option value="pptx">PPT</option>
            </select>
            <button
              type="button"
              onClick={handleSubmitGenerate}
              disabled={props.disabled || !genPrompt.trim()}
              data-testid="media-generate-submit"
              className="text-[11px] px-2 py-1 border border-[var(--pixel-border)] disabled:opacity-50 ml-auto"
            >
              생성 요청
            </button>
          </div>
          {/* 카운트 뱃지: 종류별 첨부된 자산 수. 본 숫자는 자산 리스트 상단에서 빠른 요약 용도. */}
          <dl
            className="mt-2 flex gap-3 text-[10px] opacity-70"
            data-testid="media-generate-counts"
          >
            {(Object.keys(grouped) as MediaKind[]).map((k) => (
              <div key={k} className="flex gap-1">
                <dt>{KIND_LABEL[k]}</dt>
                <dd data-testid={`media-generate-count-${k}`}>{grouped[k].length}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

/**
 * 공용 퍼블릭 API · DirectivePrompt 와 합성할 때 부모가 쓰는 상태 훅.
 * 실제 업로드·생성 호출은 이 훅이 수행하지 않는다. 호출자가 `onFilesAdded` 내부에서
 * `/api/media/upload` 를 쏘아 받은 MediaAsset 을 `addAssets([asset])` 로 밀어 넣고,
 * `onGenerate` 내부에서 `/api/media/generate` 를 쏘아 받은 MediaAsset 도 같은 방식으로
 * 넣는다(presentational / I/O 분리 원칙, DirectivePrompt.tsx 와 동일한 설계).
 */
export function useMediaAttachmentPanel(initial: MediaAsset[] = []): {
  assets: MediaAsset[];
  addAssets: (next: MediaAsset[]) => void;
  removeAsset: (id: string) => void;
  clear: () => void;
} {
  const [assets, setAssets] = useState<MediaAsset[]>(initial);
  const addAssets = useCallback((next: MediaAsset[]) => {
    setAssets((prev) => [...prev, ...next]);
  }, []);
  const removeAsset = useCallback((id: string) => {
    setAssets((prev) => prev.filter((a) => a.id !== id));
  }, []);
  const clear = useCallback(() => setAssets([]), []);
  return { assets, addAssets, removeAsset, clear };
}

export default MediaAttachmentPanel;
