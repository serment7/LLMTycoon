// 멀티미디어 입력(PDF/PPT/이미지/영상) 파싱 및 영상 생성 어댑터의 "공용 진입점".
// 지시 #f6052a91 의 1차 구현(스켈레톤) — 본 모듈은 세 가지 책임을 가진다.
//
//  1) `inferMediaKind(name, mimeType)` · 확장자/MIME 만 보고 4종 MediaKind 를 결정.
//     서버 업로드 핸들러와 UI `MediaAttachmentPanel` 양쪽이 같은 규칙을 쓰도록 공개한다.
//
//  2) `PdfParser` · `PptParser` · `VideoGenAdapter` 세 인터페이스와 기본 구현.
//     - PDF 는 이미 설치돼 있는 `pdf-parse` 를 기본 어댑터로 꽂아 두고,
//       `fileProcessor.ts` 의 기존 호출과 충돌하지 않도록 별도 인스턴스로 격리한다.
//     - PPT 는 npm 의존성이 아직 없어 "미구현" 에러를 던지는 스텁. 추후 `officeparser`
//       또는 `pptxgenjs` 를 설치하면 동적 import 만 교체한다.
//     - 영상 생성은 외부 API(예: Runway, Sora 호환) 교체를 대비해 전역 레지스트리로만
//       묶어 둔다. `registerVideoGenAdapter(adapter)` 로 주입한 뒤 서버 엔드포인트가
//       조회해 쓴다.
//
//  3) `createMediaProcessor()` · 위 어댑터를 하나로 묶어 `{ parse, supports }` 를 돌려주는
//     팩토리. server.ts 의 `/api/media/upload` 가 요청마다 이 처리를 호출한다.
//     테스트와 서버에서 공유 가능하도록 순수 함수·클래스 없이 모듈 공용 상태는
//     video 어댑터 레지스트리 하나로 최소화했다.

import type { MediaAsset, MediaKind } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// 공개 타입
// ────────────────────────────────────────────────────────────────────────────

export interface MediaParseInput {
  buffer: Buffer | Uint8Array;
  name: string;
  mimeType?: string;
}

export interface MediaParseResult {
  kind: MediaKind;
  extractedText?: string;
  thumbnails?: string[];
  // PDF/PPT 에서 알 수 있을 때만 채움. 영상/이미지는 비움.
  pageCount?: number;
}

export interface PdfParser {
  readonly id: string;
  parse(input: MediaParseInput): Promise<MediaParseResult>;
}

export interface PptParser {
  readonly id: string;
  parse(input: MediaParseInput): Promise<MediaParseResult>;
}

export interface VideoGenAdapter {
  readonly id: string;
  generate(options: {
    prompt: string;
    projectId: string;
    // 초·해상도·레퍼런스 이미지 등 어댑터 고유 옵션. 본 코어는 해석하지 않는다.
    options?: Record<string, unknown>;
  }): Promise<MediaAsset>;
}

export class NotImplementedMediaError extends Error {
  readonly kind: MediaKind | 'unknown';
  constructor(kind: MediaKind | 'unknown', reason: string) {
    super(`[mediaProcessor] ${kind} 처리 미구현: ${reason}`);
    this.name = 'NotImplementedMediaError';
    this.kind = kind;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 분류기 — 확장자 우선, MIME 보정
// ────────────────────────────────────────────────────────────────────────────

const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const PPT_EXT   = new Set(['ppt', 'pptx']);

/**
 * 공용 퍼블릭 API · 파일명 + (선택) MIME 으로 4종 MediaKind 를 결정한다.
 * 식별 실패 시 null 을 돌려 호출자가 415(Unsupported Media Type) 로 수렴하도록 한다.
 * 확장자가 가장 신뢰 가능한 신호이지만, 업로더가 임의 이름을 쓸 수 있으므로 MIME 이
 * 이미지/영상/PDF 접두를 가지면 확장자 불일치라도 해당 kind 로 승격한다.
 */
export function inferMediaKind(name: string, mimeType?: string): MediaKind | null {
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
// 기본 어댑터
// ────────────────────────────────────────────────────────────────────────────

/**
 * pdf-parse 기반 기본 PDF 파서. `fileProcessor.ts::extractPdf` 와 같은 라이브러리를
 * 쓰지만, 이쪽은 "MediaAsset 축을 위한" 경량 경로라 pdfjs 기반 페이지 렌더링은 생략한다.
 * 썸네일이 필요해지면 향후 `thumbnails` 를 채우도록 확장한다.
 */
export const defaultPdfParser: PdfParser = {
  id: 'pdf-parse',
  async parse({ buffer, name }) {
    const { PDFParse } = await import('pdf-parse');
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const parser = new PDFParse({ data: bytes });
    try {
      const r = await parser.getText();
      const extractedText = typeof r?.text === 'string' ? r.text : '';
      const pageCountRaw = (r as { numpages?: unknown })?.numpages;
      const pageCount = typeof pageCountRaw === 'number' && Number.isFinite(pageCountRaw)
        ? pageCountRaw
        : undefined;
      return { kind: 'pdf', extractedText, pageCount };
    } catch (e) {
      throw new NotImplementedMediaError('pdf', `PDF 파싱 실패(${name}): ${(e as Error).message}`);
    } finally {
      await parser.destroy?.();
    }
  },
};

/**
 * PPT 파서 스텁. 1차 구현에서는 의존성을 추가하지 않고 호출 시 즉시 NotImplementedMediaError
 * 를 던져, 서버 엔드포인트가 501(Not Implemented) 로 돌려주게 한다. 이후 `officeparser`
 * 또는 `pptxgenjs` 설치 후 `parse` 내부만 교체하면 전체 경로가 살아난다.
 */
export const defaultPptParser: PptParser = {
  id: 'stub',
  async parse() {
    throw new NotImplementedMediaError('pptx', 'PPT 파서 어댑터가 등록되지 않았습니다.');
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 영상 생성 어댑터 레지스트리
// ────────────────────────────────────────────────────────────────────────────

interface VideoGenRegistry {
  adapter: VideoGenAdapter | null;
}
const videoGenRegistry: VideoGenRegistry = { adapter: null };

/**
 * 공용 퍼블릭 API · 영상 생성 어댑터 주입. 서버 기동 시 1회 호출한다. null 을 넘기면
 * 등록을 해제한다. 테스트는 `resetVideoGenAdapter()` 로 초기화 가능.
 */
export function registerVideoGenAdapter(adapter: VideoGenAdapter | null): void {
  videoGenRegistry.adapter = adapter;
}

export function getVideoGenAdapter(): VideoGenAdapter | null {
  return videoGenRegistry.adapter;
}

/** 테스트 전용: 레지스트리 초기화. */
export function resetVideoGenAdapter(): void {
  videoGenRegistry.adapter = null;
}

// ────────────────────────────────────────────────────────────────────────────
// 프로세서 파사드
// ────────────────────────────────────────────────────────────────────────────

export interface MediaProcessor {
  parse(input: MediaParseInput): Promise<MediaParseResult>;
  supports(kind: MediaKind): boolean;
}

/**
 * 공용 퍼블릭 API · PDF/PPT/이미지/영상 4종을 하나의 `parse(input)` 로 받아 내는 파사드.
 * 호출자는 `inferMediaKind` 결과를 미리 알 필요 없이 `{ buffer, name, mimeType }` 만
 * 넘기면 된다. overrides 로 PDF/PPT 어댑터를 교체할 수 있어 테스트가 외부 I/O 없이
 * 주입 어댑터를 검증할 수 있다.
 */
export function createMediaProcessor(overrides?: Partial<{
  pdf: PdfParser;
  pptx: PptParser;
}>): MediaProcessor {
  const pdf = overrides?.pdf ?? defaultPdfParser;
  const pptx = overrides?.pptx ?? defaultPptParser;

  return {
    supports: () => true,
    async parse(input) {
      const kind = inferMediaKind(input.name, input.mimeType);
      if (!kind) {
        throw new NotImplementedMediaError('unknown', `지원하지 않는 미디어 형식: ${input.name}`);
      }
      if (kind === 'pdf') return pdf.parse(input);
      if (kind === 'pptx') return pptx.parse(input);
      // 이미지·영상은 1차 스켈레톤에서 파싱을 생략하고 kind 만 반환한다.
      return { kind };
    },
  };
}
