// FileHistoryPanel(#472c5b8d) — 프로젝트 상세의 "업로드 파일 내역" 탭/패널.
//
// 책임
//   1) `listProjectFiles(projectId)` 로 현재 프로젝트의 MediaAsset 을 최신순 리스트로 표시.
//   2) 이미지/영상은 썸네일, pdf/pptx 는 아이콘으로 항목 시각화.
//   3) 카테고리 필터 칩(전체/이미지/영상/문서) 제공 — 단일 선택, 키보드 네비게이션.
//   4) 각 항목에 다운로드/삭제 버튼 제공 — 다운로드는 thumbnails[0] (data URL) 또는
//      storageUrl 을 우선 사용, 없으면 비활성화 + 안내.
//   5) 빈 상태(아직 업로드 없음) 전용 카드 — EmptyState 토큰과 시각 언어 일관.
//
// 표시/네트워크 I/O 는 본 컴포넌트가 소유하고, 상위는 projectId 와 옵션 훅만 주입한다.
// 업로드 직후 목록 갱신은 `refreshKey` prop 으로 상위가 튕겨 준다(낙관적 갱신 필요 시).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  File as FileIcon,
  FileText,
  Film,
  Image as ImageIcon,
  Inbox,
  RefreshCw,
  Trash2,
} from 'lucide-react';

import type { MediaAsset } from '../types';
import { formatBytes } from './UploadDropzone';
import { EmptyState } from './EmptyState';
import {
  deleteProjectFile,
  filterByCategory,
  formatRelativeTime,
  listProjectFiles,
  mediaKindToCategory,
  type FileCategoryFilter,
} from '../utils/listProjectFiles';

const CATEGORY_CHIPS: ReadonlyArray<{ id: FileCategoryFilter; label: string }> = [
  { id: 'all', label: '전체' },
  { id: 'image', label: '이미지' },
  { id: 'video', label: '영상' },
  { id: 'document', label: '문서' },
];

export interface FileHistoryPanelProps {
  projectId: string;
  /**
   * 상위가 값을 증가시키면 패널이 목록을 다시 조회한다. 업로드 성공 직후 상위가
   * `setKey(k => k + 1)` 로 튕겨 주면 별도 소켓 없이도 즉시 갱신된다.
   */
  refreshKey?: number;
  /** 테스트용 fetch 주입. */
  fetchImpl?: typeof fetch;
  /** 테스트용 시계 주입(상대 시각 라벨). */
  now?: () => number;
  className?: string;
}

export function FileHistoryPanel({
  projectId,
  refreshKey,
  fetchImpl,
  now,
  className,
}: FileHistoryPanelProps): React.ReactElement {
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FileCategoryFilter>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const fetched = await listProjectFiles(projectId, { fetchImpl, signal: controller.signal });
      setItems(fetched);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError((err as Error)?.message ?? '파일 내역을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [projectId, fetchImpl]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load, refreshKey]);

  const filtered = useMemo(() => filterByCategory(items, filter), [items, filter]);
  const countsByCategory = useMemo(() => {
    const counts: Record<FileCategoryFilter, number> = { all: items.length, image: 0, video: 0, document: 0 };
    for (const a of items) counts[mediaKindToCategory(a.kind)] += 1;
    return counts;
  }, [items]);

  const onDelete = useCallback(async (asset: MediaAsset) => {
    if (!projectId) return;
    if (typeof window !== 'undefined') {
      const ok = window.confirm(`"${asset.name}" 을(를) 삭제할까요?`);
      if (!ok) return;
    }
    setDeletingId(asset.id);
    try {
      await deleteProjectFile(projectId, asset.id, { fetchImpl });
      // 낙관적 제거. 서버 실패는 catch 에서 전체 재조회로 복원.
      setItems(prev => prev.filter(a => a.id !== asset.id));
    } catch (err) {
      setError((err as Error)?.message ?? '삭제에 실패했습니다.');
      void load();
    } finally {
      setDeletingId(null);
    }
  }, [projectId, fetchImpl, load]);

  return (
    <section
      data-testid="file-history-panel"
      className={className}
      aria-label="업로드 파일 내역"
    >
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <h3
            className="text-sm font-bold uppercase tracking-wider"
            style={{ color: 'var(--pixel-accent)' }}
          >
            업로드 파일 내역
          </h3>
          <span
            aria-label={`총 ${items.length}개 파일`}
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 border-2"
            style={{
              borderColor: 'var(--pixel-border)',
              background: 'rgba(0,0,0,0.3)',
              color: 'rgba(255,255,255,0.8)',
            }}
          >
            {items.length}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || !projectId}
          aria-label="파일 내역 새로고침"
          title="새로고침"
          data-testid="file-history-refresh"
          className="p-2 border-2 disabled:opacity-40 transition-colors"
          style={{
            background: 'rgba(0,0,0,0.3)',
            borderColor: 'var(--pixel-border)',
          }}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
        </button>
      </div>

      {/* 카테고리 필터 칩 — 단일 선택. 키보드는 Tab 순환, Enter/Space 로 선택. */}
      <div role="tablist" aria-label="카테고리 필터" className="flex gap-2 flex-wrap mb-3">
        {CATEGORY_CHIPS.map(chip => {
          const active = filter === chip.id;
          const count = countsByCategory[chip.id] ?? 0;
          return (
            <button
              key={chip.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`file-history-chip-${chip.id}`}
              onClick={() => setFilter(chip.id)}
              className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider border-2 transition-colors"
              style={{
                background: active ? 'var(--pixel-accent)' : 'rgba(0,0,0,0.3)',
                color: active ? 'black' : 'rgba(255,255,255,0.85)',
                borderColor: active ? 'var(--pixel-accent)' : 'var(--pixel-border)',
              }}
            >
              {chip.label}
              <span
                aria-hidden="true"
                className="ml-2 text-[10px] opacity-80 tabular-nums"
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div
          role="alert"
          aria-live="polite"
          className="border-2 p-3 flex items-center gap-2 text-[11px] mb-3"
          style={{
            background: 'var(--error-state-bg, rgba(127, 29, 29, 0.3))',
            borderColor: 'var(--error-state-border, rgba(239, 68, 68, 0.7))',
            color: 'var(--error-state-title-fg, rgb(254, 202, 202))',
          }}
        >
          <span className="flex-1">{error}</span>
          <button
            onClick={() => void load()}
            className="px-2 py-1 border-2 text-[10px] uppercase font-bold"
            style={{ borderColor: 'var(--error-state-border)', background: 'rgba(0,0,0,0.25)' }}
          >
            재시도
          </button>
        </div>
      )}

      {items.length === 0 && !loading && !error ? (
        <EmptyState
          icon={<Inbox size={28} aria-hidden="true" />}
          title="아직 업로드된 파일이 없습니다"
          description="상단 채팅 입력창의 첨부 버튼이나 업로드 영역으로 PDF·PPT·이미지·영상을 올리면 이 목록에 최신순으로 쌓입니다."
        />
      ) : filtered.length === 0 && !loading ? (
        <EmptyState
          icon={<Inbox size={20} aria-hidden="true" />}
          title="선택한 카테고리에 해당하는 파일이 없습니다"
          description="전체 칩을 눌러 모든 파일을 확인하세요."
        />
      ) : (
        <ul
          role="list"
          aria-label="업로드 파일 목록 (최신순)"
          data-testid="file-history-list"
          className="flex flex-col gap-2"
        >
          {filtered.map(asset => (
            <FileHistoryItem
              key={asset.id}
              asset={asset}
              now={now}
              deleting={deletingId === asset.id}
              onDelete={() => void onDelete(asset)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ItemProps {
  asset: MediaAsset;
  now?: () => number;
  deleting: boolean;
  onDelete: () => void;
  key?: React.Key;
}

function FileHistoryItem({ asset, now, deleting, onDelete }: ItemProps): React.ReactElement {
  const downloadHref = resolveDownloadHref(asset);
  const downloadable = Boolean(downloadHref);
  const timeLabel = formatRelativeTime(asset.createdAt, now?.());
  const thumbUrl = asset.thumbnails?.find(Boolean);
  const category = mediaKindToCategory(asset.kind);
  return (
    <li
      data-testid="file-history-item"
      data-kind={asset.kind}
      data-category={category}
      className="flex items-center gap-3 p-2 border-2"
      style={{
        background: 'rgba(0,0,0,0.25)',
        borderColor: 'var(--pixel-border)',
      }}
    >
      <ThumbOrIcon asset={asset} thumbUrl={thumbUrl} />
      <div className="flex-1 min-w-0">
        <div
          className="text-[12px] font-bold truncate"
          title={asset.name}
          style={{ color: 'var(--pixel-accent)' }}
        >
          {asset.name}
        </div>
        <div className="text-[11px] mt-0.5 opacity-80 flex gap-2 flex-wrap">
          <span className="uppercase tracking-wider">{kindLabel(asset.kind)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(asset.sizeBytes)}</span>
          <span aria-hidden="true">·</span>
          <time
            dateTime={asset.createdAt}
            title={new Date(asset.createdAt).toLocaleString()}
          >
            {timeLabel}
          </time>
          {asset.generatedBy ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="opacity-70">생성: {asset.generatedBy.adapter}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {downloadable ? (
          <a
            href={downloadHref!}
            download={asset.name}
            aria-label={`${asset.name} 다운로드`}
            data-testid="file-history-download"
            className="p-1.5 border-2 transition-colors"
            style={{ background: 'rgba(0,0,0,0.3)', borderColor: 'var(--pixel-border)' }}
          >
            <Download size={12} aria-hidden="true" />
          </a>
        ) : (
          <button
            type="button"
            disabled
            title="다운로드 가능한 원본이 아직 이 세션에 없습니다"
            aria-label={`${asset.name} 다운로드 불가`}
            className="p-1.5 border-2 opacity-40"
            style={{ background: 'rgba(0,0,0,0.3)', borderColor: 'var(--pixel-border)' }}
          >
            <Download size={12} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          aria-label={`${asset.name} 삭제`}
          data-testid="file-history-delete"
          className="p-1.5 border-2 transition-colors"
          style={{
            background: 'rgba(127, 29, 29, 0.25)',
            borderColor: 'rgba(239, 68, 68, 0.6)',
            color: 'rgb(252, 165, 165)',
          }}
        >
          <Trash2 size={12} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

function ThumbOrIcon({
  asset,
  thumbUrl,
}: {
  asset: MediaAsset;
  thumbUrl?: string;
}): React.ReactElement {
  if (thumbUrl && (asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'pdf' || asset.kind === 'pptx')) {
    return (
      <img
        src={thumbUrl}
        alt=""
        aria-hidden="true"
        data-testid="file-history-thumb"
        className="w-12 h-12 object-cover border-2 shrink-0"
        style={{ borderColor: 'var(--pixel-border)', background: 'rgba(0,0,0,0.5)' }}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      data-testid="file-history-icon"
      className="w-12 h-12 border-2 shrink-0 flex items-center justify-center"
      style={{
        background: 'rgba(0,0,0,0.4)',
        borderColor: 'var(--pixel-border)',
        color: 'var(--pixel-accent)',
      }}
    >
      {iconFor(asset.kind)}
    </div>
  );
}

function iconFor(kind: MediaAsset['kind']): React.ReactElement {
  if (kind === 'pdf' || kind === 'pptx') return <FileText size={22} aria-hidden="true" />;
  if (kind === 'video') return <Film size={22} aria-hidden="true" />;
  if (kind === 'image') return <ImageIcon size={22} aria-hidden="true" />;
  return <FileIcon size={22} aria-hidden="true" />;
}

function kindLabel(kind: MediaAsset['kind']): string {
  if (kind === 'pdf') return 'PDF';
  if (kind === 'pptx') return 'PPTX';
  if (kind === 'video') return '영상';
  if (kind === 'image') return '이미지';
  return '파일';
}

/**
 * 다운로드 앵커용 href 를 결정한다. 서버 영속 URL(storageUrl) 이 있으면 최우선,
 * 없으면 썸네일 data URL 을 폴백으로 쓴다(영상은 포스터만 제공되므로 한계).
 * 둘 다 없으면 undefined 를 돌려 UI 가 버튼을 비활성화하게 한다.
 */
function resolveDownloadHref(asset: MediaAsset): string | undefined {
  if (asset.storageUrl) return asset.storageUrl;
  const thumb = asset.thumbnails?.find(Boolean);
  if (thumb) return thumb;
  return undefined;
}
