// 지시 #f6052a91 · 1차 스켈레톤 — 클라이언트 측 멀티미디어 파이프라인 디스패처.
//
// 책임:
//   1) `detectMediaKind(name, mimeType?)` — 파일명·MIME 로 4종 MediaKind 판정.
//      서버 `src/server/mediaProcessor.ts::inferMediaKind` 와 동일한 규칙을 의도적으로
//      복제했다(모듈 간 의존을 두지 않기 위해). 규칙이 바뀌면 두 곳을 같이 고친다.
//   2) `loadPdfFile` · `loadPptFile` — `/api/media/upload` 로 POST 해 MediaAsset 을
//      받아오고, UI 가 곧바로 보여줄 수 있는 `MediaPreview` 모양으로 돌려준다.
//   3) `requestVideoGeneration` — `/api/media/generate` 어댑터 호출 스텁. 어댑터가
//      서버에 등록되어 있지 않거나 세션이 소진된 상태면 503/에러로 수렴한다.
//   4) `loadMediaFile` — File 을 받아 (1) 로 kind 를 정한 뒤 (2) 를 호출하는 단일
//      진입점. 영상·이미지처럼 업로드만 하고 파싱이 필요 없는 kind 는 kind 메타만
//      채워 MediaPreview 를 돌려준다.
//
// 테스트 용이성:
//   - 모든 외부 호출은 옵션의 `fetcher` 로 주입 가능하다(기본은 globalThis.fetch).
//   - 본 모듈은 Node(20+) 에서도 돌아가도록 File/FormData/Blob 전역만 사용하며,
//     브라우저 전용 DOM API(URL.createObjectURL 등) 는 호출자가 책임진다.
//   - `MediaLoaderError` 는 사용자 토스트에 그대로 쓸 수 있는 한국어 메시지를 담는다.

import type { MediaAsset, MediaKind } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// 공개 타입
// ────────────────────────────────────────────────────────────────────────────

export type MediaLoaderErrorCode =
  | 'UNSUPPORTED_KIND'
  | 'UPLOAD_FAILED'
  | 'GENERATE_FAILED'
  | 'ADAPTER_NOT_REGISTERED'
  | 'SESSION_EXHAUSTED'
  | 'ABORTED';

export class MediaLoaderError extends Error {
  readonly code: MediaLoaderErrorCode;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(code: MediaLoaderErrorCode, message: string, opts?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = 'MediaLoaderError';
    this.code = code;
    if (typeof opts?.status === 'number') this.status = opts.status;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

export interface MediaPreview {
  id: string;
  kind: MediaKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  /** PDF/PPT 파서가 추출한 본문. UI 가 그대로 프리뷰 영역에 표시한다. */
  extractedText?: string;
  /** PDF/PPT 페이지·슬라이드 수(알려져 있을 때). 영상/이미지는 비움. */
  pageCount?: number;
  /** 영상/이미지 생성 경로에서 채운다. */
  generatedBy?: { adapter: string; prompt: string };
}

/**
 * 최소한의 fetch 호환 시그니처. 테스트에서 이 타입만 만족하는 mock 을 주입한다.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MediaLoaderOptions {
  projectId: string;
  /** 기본 globalThis.fetch. 테스트/SSR 환경에서 주입으로 교체한다. */
  fetcher?: FetchLike;
  signal?: AbortSignal;
  /** 기본 '/api'. 서버 prefix 가 바뀌면 이 옵션으로 조정한다. */
  apiBase?: string;
}

export interface VideoGenerationInput {
  prompt: string;
  projectId: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 분류기
// ────────────────────────────────────────────────────────────────────────────

const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const PPT_EXT   = new Set(['ppt', 'pptx']);

/**
 * 파일명 + (선택) MIME 으로 4종 MediaKind 를 판정한다. 확장자를 우선 신뢰하지만,
 * MIME 이 더 강한 힌트(image/*, video/*, application/pdf) 를 주면 그쪽으로 수렴한다.
 * 판정 실패 시 null.
 */
export function detectMediaKind(name: string, mimeType?: string): MediaKind | null {
  const ext = (name.toLowerCase().split('.').pop() ?? '').trim();
  const mime = (mimeType || '').toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (PPT_EXT.has(ext)
      || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      || mime === 'application/vnd.ms-powerpoint'
      || mime.includes('presentation')) return 'pptx';
  if (VIDEO_EXT.has(ext) || mime.startsWith('video/')) return 'video';
  if (IMAGE_EXT.has(ext) || mime.startsWith('image/')) return 'image';
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 내부 유틸
// ────────────────────────────────────────────────────────────────────────────

function pickFetcher(opts: MediaLoaderOptions): FetchLike {
  if (opts.fetcher) return opts.fetcher;
  const g = (globalThis as { fetch?: FetchLike }).fetch;
  if (!g) {
    throw new MediaLoaderError(
      'UPLOAD_FAILED',
      'fetch 구현체를 찾을 수 없습니다. options.fetcher 로 주입해 주세요.',
    );
  }
  return g;
}

function apiBaseOf(opts: MediaLoaderOptions): string {
  const raw = (opts.apiBase ?? '/api').replace(/\/+$/, '');
  return raw || '/api';
}

async function readErrorMessage(res: Response): Promise<string> {
  // 서버는 { error: string } 형태로 돌려준다. 파싱 실패 시 statusText 폴백.
  try {
    const payload = (await res.clone().json()) as { error?: unknown };
    if (payload && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
  } catch {
    /* ignore */
  }
  return res.statusText || `HTTP ${res.status}`;
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

// ────────────────────────────────────────────────────────────────────────────
// PDF · PPT 업로드 경로
// ────────────────────────────────────────────────────────────────────────────

/**
 * `/api/media/upload` 로 파일을 업로드하고, 서버가 돌려준 MediaAsset 을 MediaPreview
 * 로 투영한다. kind 가 'pdf' 또는 'pptx' 여야 하며, 그 외는 UNSUPPORTED_KIND.
 */
async function uploadParseableFile(
  file: File,
  expected: 'pdf' | 'pptx',
  opts: MediaLoaderOptions,
): Promise<MediaPreview> {
  if (opts.signal?.aborted) {
    throw new MediaLoaderError('ABORTED', '호출자가 업로드를 중단했습니다.');
  }
  const form = new FormData();
  form.append('projectId', opts.projectId);
  form.append('file', file, file.name);

  let res: Response;
  try {
    res = await pickFetcher(opts)(`${apiBaseOf(opts)}/media/upload`, {
      method: 'POST',
      body: form,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new MediaLoaderError('ABORTED', '호출자가 업로드를 중단했습니다.', { cause: err });
    }
    throw new MediaLoaderError('UPLOAD_FAILED', '업로드 요청 자체가 실패했습니다.', { cause: err });
  }

  if (!res.ok) {
    const message = await readErrorMessage(res);
    // 서버는 PPT 어댑터 미등록 시 501 로 수렴시킨다.
    const code: MediaLoaderErrorCode = res.status === 501
      ? 'ADAPTER_NOT_REGISTERED'
      : 'UPLOAD_FAILED';
    throw new MediaLoaderError(code, message, { status: res.status });
  }

  const asset = (await res.json()) as MediaAsset;
  if (asset.kind !== expected) {
    // 서버가 판정한 kind 가 기대치와 다르면(드물지만 MIME 불일치) 그 결과를 그대로
    // 유지하되, 호출자에게 확인을 위해 메타만 투영해 돌려준다. 에러는 아니다.
  }
  const preview = assetToPreview(asset);
  // 페이지 수는 /api/media/upload 응답에 포함되지 않는다(파서 출력이 유실된다).
  // 이후 서버가 pageCount 를 반환하면 preview.pageCount 에 그대로 주입 가능.
  return preview;
}

export function loadPdfFile(file: File, opts: MediaLoaderOptions): Promise<MediaPreview> {
  return uploadParseableFile(file, 'pdf', opts);
}

export function loadPptFile(file: File, opts: MediaLoaderOptions): Promise<MediaPreview> {
  return uploadParseableFile(file, 'pptx', opts);
}

// ────────────────────────────────────────────────────────────────────────────
// 영상 생성 요청 어댑터
// ────────────────────────────────────────────────────────────────────────────

/**
 * `/api/media/generate { kind: 'video' }` 호출 스텁. 세션 소진 상태(`exhausted`) 또는
 * 어댑터 미등록 시 서버가 503 을 돌려주므로, 이 함수는 그 응답을 분류된 에러로 매핑한다.
 */
export async function requestVideoGeneration(
  input: VideoGenerationInput,
  opts: Omit<MediaLoaderOptions, 'projectId'>,
): Promise<MediaPreview> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new MediaLoaderError('GENERATE_FAILED', '생성 프롬프트가 비어 있습니다.');
  }
  if (opts.signal?.aborted) {
    throw new MediaLoaderError('ABORTED', '호출자가 영상 생성을 중단했습니다.');
  }
  let res: Response;
  try {
    res = await pickFetcher({ ...opts, projectId: input.projectId })(
      `${apiBaseOf({ ...opts, projectId: input.projectId })}/media/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: input.projectId, kind: 'video', prompt }),
        signal: opts.signal,
      },
    );
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new MediaLoaderError('ABORTED', '호출자가 영상 생성을 중단했습니다.', { cause: err });
    }
    throw new MediaLoaderError('GENERATE_FAILED', '영상 생성 요청이 실패했습니다.', { cause: err });
  }

  if (!res.ok) {
    const message = await readErrorMessage(res);
    // 503 은 두 원인 중 하나 — exhausted 차단(category='session_exhausted') 또는 어댑터
    // 미등록. 메시지 문구로 구분한다. 서버가 명시한 category 필드가 향후 추가되면 그걸
    // 우선 사용하도록 손쉽게 교체 가능.
    let code: MediaLoaderErrorCode = 'GENERATE_FAILED';
    if (res.status === 503) {
      code = /세션|exhausted|소진/i.test(message) ? 'SESSION_EXHAUSTED' : 'ADAPTER_NOT_REGISTERED';
    }
    throw new MediaLoaderError(code, message, { status: res.status });
  }

  const asset = (await res.json()) as MediaAsset;
  return assetToPreview(asset);
}

// ────────────────────────────────────────────────────────────────────────────
// 단일 진입점
// ────────────────────────────────────────────────────────────────────────────

/**
 * File 을 받아 kind 를 판정하고 올바른 로더를 호출한다. 이미지는 업로드 경로가 파싱을
 * 건너뛰므로 별도의 업로드 요청 없이 로컬 메타만 담은 MediaPreview 를 돌려준다(1차
 * 스켈레톤; 서버 영속이 필요해지면 image 도 uploadParseableFile 경로로 전환).
 * 영상은 "업로드된 원본" 이 아닌 "프롬프트로 생성" 이 주 경로라, File 을 받아도
 * UNSUPPORTED_KIND 로 막고 호출자가 requestVideoGeneration 을 쓰도록 유도한다.
 */
export async function loadMediaFile(file: File, opts: MediaLoaderOptions): Promise<MediaPreview> {
  const kind = detectMediaKind(file.name, file.type);
  if (!kind) {
    throw new MediaLoaderError('UNSUPPORTED_KIND', `지원하지 않는 파일 형식: ${file.name}`);
  }
  if (kind === 'pdf') return loadPdfFile(file, opts);
  if (kind === 'pptx') return loadPptFile(file, opts);
  if (kind === 'image') {
    // 1차 스켈레톤 — 이미지는 로컬 메타만 돌려주고, 서버 영속은 후속 턴에 붙인다.
    return {
      id: `local-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      kind: 'image',
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      createdAt: new Date().toISOString(),
    };
  }
  // video — 파일 업로드 경로는 지원하지 않음(현재 파이프라인은 "생성" 위주).
  throw new MediaLoaderError(
    'UNSUPPORTED_KIND',
    '영상 파일은 업로드 대신 requestVideoGeneration 으로 요청해 주세요.',
  );
}
