// 지시 #f3eca898 · 1차 스켈레톤 — 클라이언트 측 멀티미디어 "생성(출력)" 어댑터.
//
// mediaLoaders(입력 축) 와 대칭되는 출력 축이다. 서버 `POST /api/media/generate` 를
// 호출해 `MediaAsset` 을 받아 UI 가 그대로 보여줄 수 있는 `MediaPreview` 로 투영한다.
// 세 가지 kind 를 지원한다:
//   - exportPdfReport  — pdf-lib(또는 mock) 기반 PDF 리포트 생성. 제목·섹션을 넘긴다.
//   - exportPptxDeck   — pptxgenjs(또는 mock) 기반 PPT 덱 생성. 슬라이드 배열을 넘긴다.
//   - exportVideo      — 외부 영상 생성 API 어댑터 스텁. 프롬프트만 받는다.
// 마지막으로 `prepareDownload(preview)` 는 storageUrl 이 아직 비어 있는 1차 상태에서도
// "추출 본문/프롬프트/생성자 메타" 를 엮어 data: URL 과 파일명을 돌려줘, App.tsx 가
// anchor[download] 에 즉시 매달 수 있게 한다.
//
// 본 모듈은 mediaLoaders 와 동일하게 외부 호출을 `fetcher` 로 주입 가능하고, 테스트는
// Node(20+) 의 전역 fetch/FormData 대신 mock 만 사용한다.

import type { MediaAsset } from '../types';
import type { FetchLike, MediaPreview } from './mediaLoaders';

// ────────────────────────────────────────────────────────────────────────────
// 공개 타입
// ────────────────────────────────────────────────────────────────────────────

export type MediaExporterErrorCode =
  | 'VALIDATION_FAILED'
  | 'EXPORT_FAILED'
  | 'ADAPTER_NOT_REGISTERED'
  | 'SESSION_EXHAUSTED'
  | 'ABORTED';

export class MediaExporterError extends Error {
  readonly code: MediaExporterErrorCode;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(code: MediaExporterErrorCode, message: string, opts?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = 'MediaExporterError';
    this.code = code;
    if (typeof opts?.status === 'number') this.status = opts.status;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

export interface PdfReportSection {
  heading: string;
  body: string;
}

export interface PdfReportTemplate {
  title: string;
  sections: readonly PdfReportSection[];
}

export interface PptxSlide {
  title: string;
  body?: string;
}

export interface MediaExporterOptions {
  projectId: string;
  /** 기본 globalThis.fetch. 테스트에서 주입으로 교체. */
  fetcher?: FetchLike;
  signal?: AbortSignal;
  /** 기본 '/api'. */
  apiBase?: string;
}

export interface DownloadDescriptor {
  /** anchor[href] 로 바로 쓸 수 있는 URL. 1차는 data: URL. */
  url: string;
  filename: string;
  /** brower 에서 URL.createObjectURL 로 만든 경우 해제 콜백. data: URL 이면 undefined. */
  cleanup?: () => void;
}

// ────────────────────────────────────────────────────────────────────────────
// 내부 유틸 (mediaLoaders 의 내부 헬퍼와 의도적으로 독립 — 테스트가 서로 얽히지 않게)
// ────────────────────────────────────────────────────────────────────────────

function pickFetcher(opts: MediaExporterOptions): FetchLike {
  if (opts.fetcher) return opts.fetcher;
  const g = (globalThis as { fetch?: FetchLike }).fetch;
  if (!g) {
    throw new MediaExporterError(
      'EXPORT_FAILED',
      'fetch 구현체를 찾을 수 없습니다. options.fetcher 로 주입해 주세요.',
    );
  }
  return g;
}

function apiBaseOf(opts: MediaExporterOptions): string {
  const raw = (opts.apiBase ?? '/api').replace(/\/+$/, '');
  return raw || '/api';
}

async function readErrorMessage(res: Response): Promise<{ message: string; category?: string }> {
  try {
    const payload = (await res.clone().json()) as { error?: unknown; category?: unknown };
    const message = typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : (res.statusText || `HTTP ${res.status}`);
    const category = typeof payload?.category === 'string' ? payload.category : undefined;
    return { message, category };
  } catch {
    return { message: res.statusText || `HTTP ${res.status}` };
  }
}

function assetToPreview(asset: MediaAsset): MediaPreview {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    createdAt: asset.createdAt,
    extractedText: asset.extractedText,
    generatedBy: asset.generatedBy,
  };
}

async function callGenerate(body: Record<string, unknown>, opts: MediaExporterOptions): Promise<MediaPreview> {
  if (opts.signal?.aborted) {
    throw new MediaExporterError('ABORTED', '호출자가 생성을 중단했습니다.');
  }
  const payload = { ...body, projectId: opts.projectId };

  let res: Response;
  try {
    res = await pickFetcher(opts)(`${apiBaseOf(opts)}/media/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new MediaExporterError('ABORTED', '호출자가 생성을 중단했습니다.', { cause: err });
    }
    throw new MediaExporterError('EXPORT_FAILED', '생성 요청이 실패했습니다.', { cause: err });
  }

  if (!res.ok) {
    const { message, category } = await readErrorMessage(res);
    // 서버는 exhausted 세션에서 { error, category: 'session_exhausted' } 로 503 을 돌려
    // 주기로 계약돼 있다(server.ts:565). category 필드를 우선 신뢰하고, 누락이면 메시지
    // 패턴으로 폴백한다.
    let code: MediaExporterErrorCode = 'EXPORT_FAILED';
    if (category === 'session_exhausted' || (res.status === 503 && /세션|exhausted|소진/i.test(message))) {
      code = 'SESSION_EXHAUSTED';
    } else if (res.status === 503 || res.status === 501) {
      code = 'ADAPTER_NOT_REGISTERED';
    } else if (res.status === 400) {
      code = 'VALIDATION_FAILED';
    }
    throw new MediaExporterError(code, message, { status: res.status });
  }

  const asset = (await res.json()) as MediaAsset;
  return assetToPreview(asset);
}

// ────────────────────────────────────────────────────────────────────────────
// 공개 API — PDF / PPT / 영상 생성
// ────────────────────────────────────────────────────────────────────────────

export function exportPdfReport(
  input: { template: PdfReportTemplate; assetIds?: readonly string[] },
  opts: MediaExporterOptions,
): Promise<MediaPreview> {
  const title = input.template?.title?.trim() ?? '';
  if (!title) {
    return Promise.reject(new MediaExporterError('VALIDATION_FAILED', 'PDF 리포트 제목(title)이 비어 있습니다.'));
  }
  const sections = (input.template.sections ?? []).map(s => ({
    heading: typeof s.heading === 'string' ? s.heading : '',
    body: typeof s.body === 'string' ? s.body : '',
  }));
  return callGenerate(
    {
      kind: 'pdf',
      template: { title, sections },
      ...(input.assetIds && input.assetIds.length > 0 ? { assetIds: [...input.assetIds] } : {}),
    },
    opts,
  );
}

export function exportPptxDeck(
  input: { slides: readonly PptxSlide[] },
  opts: MediaExporterOptions,
): Promise<MediaPreview> {
  const slides = (input.slides ?? []).filter(s => s && typeof s.title === 'string' && s.title.trim().length > 0)
    .map(s => ({ title: s.title.trim(), body: typeof s.body === 'string' ? s.body : undefined }));
  if (slides.length === 0) {
    return Promise.reject(
      new MediaExporterError('VALIDATION_FAILED', 'PPT 덱은 최소 1개 이상의 슬라이드(title)가 필요합니다.'),
    );
  }
  return callGenerate({ kind: 'pptx', slides }, opts);
}

export function exportVideo(
  input: { prompt: string },
  opts: MediaExporterOptions,
): Promise<MediaPreview> {
  const prompt = input.prompt?.trim() ?? '';
  if (!prompt) {
    return Promise.reject(new MediaExporterError('VALIDATION_FAILED', '영상 생성 프롬프트가 비어 있습니다.'));
  }
  return callGenerate({ kind: 'video', prompt }, opts);
}

// ────────────────────────────────────────────────────────────────────────────
// 다운로드 헬퍼
// ────────────────────────────────────────────────────────────────────────────

/**
 * MediaPreview 를 anchor[download] 에 매달 수 있는 형태로 변환한다. storageUrl 이
 * 비어 있는 1차 스켈레톤에서는 "추출 본문 / 생성 프롬프트 / 생성자 메타" 를 한
 * 텍스트로 묶어 data: URL 을 만든다. 서버가 바이트를 내려주는 후속 PR 에서는 본 함수
 * 내부만 storageUrl 우선 반환으로 교체하면 된다 — 호출부 계약은 유지된다.
 */
export function prepareDownload(preview: MediaPreview): DownloadDescriptor {
  const lines: string[] = [];
  lines.push(`# ${preview.name}`);
  lines.push(`kind=${preview.kind}`);
  lines.push(`createdAt=${preview.createdAt}`);
  if (preview.generatedBy) {
    lines.push(`generatedBy=${preview.generatedBy.adapter}`);
    lines.push(`prompt=${preview.generatedBy.prompt}`);
  }
  if (preview.extractedText) {
    lines.push('');
    lines.push(preview.extractedText);
  }
  const text = lines.join('\n');
  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  return { url, filename: safeDownloadName(preview) };
}

function safeDownloadName(preview: MediaPreview): string {
  const base = preview.name?.trim() || `${preview.kind}-${preview.id}`;
  // 이미 확장자가 있으면 그대로, 없으면 kind 기반 기본 확장자 붙이기.
  if (/\.[A-Za-z0-9]{2,5}$/.test(base)) return base;
  const extByKind: Record<MediaPreview['kind'], string> = {
    pdf: 'pdf', pptx: 'pptx', video: 'mp4', image: 'png',
  };
  return `${base}.${extByKind[preview.kind]}`;
}
