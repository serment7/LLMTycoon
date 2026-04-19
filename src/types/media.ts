// Thanos #3a049e55 — 멀티미디어(PDF·PPT) 입력 파이프라인 공용 타입.
// `src/services/media/` 의 로더와 향후 UI(MediaAttachmentPanel/DirectivePrompt) 가
// 공유한다. 영상/이미지 타입은 동일 디스크리미네이션('kind') 으로 확장 가능.
//
// 기존 `src/types.ts::MediaAsset` 는 "프로젝트 자산 축(서버 영속·타임라인 노출)"
// 의 합쳐진 모델이다. 본 파일의 타입은 그보다 한 단계 앞 — "추출 결과를 모델 컨텍스트
// 에 주입하기 직전" 의 표현으로, 페이지/노트/원문 본문을 그대로 보존한다. 두 모델은
// MediaAttachment 변환기를 통해 한 방향으로만 흐른다(loader → MediaAsset).

// 한 페이지(또는 슬라이드) 단위 추출 결과. 청크 단위 파싱·진행률 콜백이
// 페이지를 1차 단위로 사용한다.
export interface MediaPage {
  // 1-base. 사용자/UI 가 보는 인덱스와 동일하게 맞춘다.
  index: number;
  text: string;
  // PPTX 의 슬라이드 노트(notesSlide) — PDF 는 항상 undefined.
  notes?: string;
}

// 추출 메타. 어떤 라이브러리가, 얼마나, 언제 파싱했는지 프롬프트 디버깅에서
// 추적 가능하도록 모든 로더 결과에 동일한 모양으로 포함한다.
export interface MediaSourceMeta {
  filePath: string;
  sizeBytes: number;
  mimeType: string;
  // ISO 8601, 서버 시계.
  parsedAt: string;
  // 'pdf-parse', 'officeparser' 등 로더가 사용한 어댑터 식별자.
  parserId: string;
  // 파싱에 걸린 실시간(ms). 청크/타임아웃 튜닝의 근거.
  durationMs: number;
}

export interface PdfDocument {
  kind: 'pdf';
  source: MediaSourceMeta;
  // 원본 PDF 가 보고하는 총 페이지 수. pages.length 와 다를 수 있다(maxPages 절단).
  pageCount: number;
  pages: MediaPage[];
  // 모델에 그대로 주입 가능한 평문 — pages 를 join 한 결과.
  text: string;
  // maxPages 절단으로 일부 페이지가 잘렸으면 true.
  truncated?: boolean;
}

export interface PptxDocument {
  kind: 'pptx';
  source: MediaSourceMeta;
  slideCount: number;
  pages: MediaPage[];
  text: string;
  truncated?: boolean;
}

export type MediaDocument = PdfDocument | PptxDocument;

// 첨부 메시지 직렬화 형태 — 모델 컨텍스트에 그대로 들어간다.
// pages/notes 같이 큰 필드는 떨어뜨리고, 이미 join 된 text 와 식별 메타만 담는다.
export interface MediaAttachment {
  kind: MediaDocument['kind'];
  name: string;
  pageCount: number;
  text: string;
  truncated?: boolean;
}

export interface MediaParseProgress {
  // 'open' = 파일 헤더/매직 검증, 'parse' = 페이지 단위 파싱, 'finalize' = 결과 직렬화.
  phase: 'open' | 'parse' | 'finalize';
  current: number;
  total: number;
}

// 모든 로더가 공통으로 받는 옵션. 서버/CLI/테스트가 이 한 모양만 알면 된다.
export interface MediaLoaderOptions {
  // 50MB 이상 파일 차단. 0 이면 무제한(테스트 전용).
  maxBytes?: number;
  // 100페이지 이상 절단. 0 이면 무제한(테스트 전용).
  maxPages?: number;
  // 단일 파싱 호출 타임아웃. 기본 30s.
  timeoutMs?: number;
  onProgress?: (progress: MediaParseProgress) => void;
  signal?: AbortSignal;
}

// 청크 단위 파싱이 내부적으로 사용하는 기본값들. 호출자가 옵션으로 덮을 수 있다.
export const MEDIA_LOADER_DEFAULTS = Object.freeze({
  maxBytes: 50 * 1024 * 1024,
  maxPages: 100,
  timeoutMs: 30_000,
});

// 추출 결과 → 모델 컨텍스트 첨부 변환. text 를 join 한 본문과 식별 메타만 남겨
// MCP add_file 경로/채팅 첨부 양쪽이 같은 모양으로 모델에 주입할 수 있게 한다.
export function toMediaAttachment(doc: MediaDocument, name: string): MediaAttachment {
  const pageCount = doc.kind === 'pdf' ? doc.pageCount : doc.slideCount;
  return {
    kind: doc.kind,
    name,
    pageCount,
    text: doc.text,
    truncated: doc.truncated,
  };
}
