// FileHistoryPanel(#472c5b8d) 이 호출하는 프로젝트별 파일 내역 API 래퍼.
//
// 서버 계약(Thanos 제공):
//   GET  /api/projects/:id/files                  → { items: MediaAsset[] } (최신 순)
//   DELETE /api/projects/:id/files/:fileId        → { ok: boolean }
//
// 본 모듈은 네트워크 I/O 만 담당하고, UI 상태(로딩/에러) 는 호출자가 관리한다.
// 그래야 테스트가 fetch 를 모킹해도 컴포넌트 렌더는 순수하게 남는다.

import type { MediaAsset } from '../types';

export interface ListProjectFilesOptions {
  /** 테스트에서 주입. 생략 시 전역 fetch. */
  fetchImpl?: typeof fetch;
  /** 취소 가능. StrictMode 이중 호출 방어. */
  signal?: AbortSignal;
}

/** `GET /api/projects/:id/files` → MediaAsset[]. 실패 시 Error throw. */
export async function listProjectFiles(
  projectId: string,
  opts: ListProjectFilesOptions = {},
): Promise<MediaAsset[]> {
  if (!projectId) throw new Error('projectId 가 필요합니다.');
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`/api/projects/${encodeURIComponent(projectId)}/files`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await readMaybeJson(res);
    const msg = typeof body?.error === 'string' ? body.error : `파일 내역 조회 실패 (HTTP ${res.status})`;
    throw new Error(msg);
  }
  const payload = await readMaybeJson(res);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items as MediaAsset[];
}

/** `DELETE /api/projects/:id/files/:fileId`. 실패 시 Error throw. */
export async function deleteProjectFile(
  projectId: string,
  fileId: string,
  opts: ListProjectFilesOptions = {},
): Promise<void> {
  if (!projectId || !fileId) throw new Error('projectId 와 fileId 가 모두 필요합니다.');
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
    { method: 'DELETE', headers: { Accept: 'application/json' }, signal: opts.signal },
  );
  if (!res.ok) {
    const body = await readMaybeJson(res);
    const msg = typeof body?.error === 'string' ? body.error : `파일 삭제 실패 (HTTP ${res.status})`;
    throw new Error(msg);
  }
}

async function readMaybeJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

// ────────────────────────────────────────────────────────────────────────────
// 순수 헬퍼 — 테스트 대상 (FileHistoryPanel 에서 재사용)
// ────────────────────────────────────────────────────────────────────────────

export type FileCategoryFilter = 'all' | 'image' | 'video' | 'document';

/** MediaKind 를 카테고리 칩(전체/이미지/영상/문서) 단위로 축약한다. pdf·pptx 는 문서. */
export function mediaKindToCategory(kind: MediaAsset['kind']): Exclude<FileCategoryFilter, 'all'> {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  return 'document';
}

/** 필터가 all 이면 전체 통과, 그 외엔 카테고리 매칭만 통과. */
export function filterByCategory(
  assets: readonly MediaAsset[],
  filter: FileCategoryFilter,
): MediaAsset[] {
  if (filter === 'all') return assets.slice();
  return assets.filter(a => mediaKindToCategory(a.kind) === filter);
}

/** "방금", "3분 전", "2시간 전", "어제", "yyyy-MM-dd" 형태 상대 시각 라벨. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Math.max(0, now - t);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 30) return '방금';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '어제';
  if (day < 7) return `${day}일 전`;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
