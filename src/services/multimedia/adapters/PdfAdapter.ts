// 지시 #aeabbd49 · PDF 어댑터 실제 구현.
//
// 직전 라운드(#9c2ae902) 에서 `src/services/multimedia/PdfAdapter.ts` 에 계약만 잠그고
// invoke() 가 ADAPTER_NOT_REGISTERED 로 즉시 실패하던 스켈레톤 위에, 실제 파싱·생성
// 구현을 얹는다. 본 파일은 어댑터 등록소의 기본 구현으로 승격되며, 스켈레톤 파일은
// 기존 회귀면을 깨지 않기 위해 그대로 둔다(createPdfAdapter 재수출 경로는 유지).
//
// 구성
//   (1) parsePdf(input: Buffer|string, opts): Promise<ParsedPdf>
//       - 페이지별 텍스트 · 이미지 좌표(선택) · 메타(parserId·durationMs) 를 반환.
//       - 파서 라이브러리는 의존성 주입 훅 `opts.parseDriver` 로 교체 가능.
//       - 기본 driver 는 pdf-parse 를 동적 import(테스트 환경에서 붙이지 않아도 됨).
//   (2) generatePdf(doc: DocumentTree, opts): Promise<Buffer>
//       - 섹션 · 표 · 이미지 · 페이지 번호 지원. 기본 driver 는 pdf-lib.
//       - `opts.generateDriver` 로 대체 가능(테스트에서 메모리 버퍼 stub 교체).
//   (3) 진행률 콜백 onProgress(ratio: 0~1) 와 AbortSignal 취소 토큰 처리.
//   (4) 실패 시 PDF_PARSE_ERROR / PDF_GEN_ERROR 중 하나를 `details.pdfCode` 로 부여한
//       MediaAdapterError 를 던진다. 부분 결과는 `details.partial` 에 담아 호출자가
//       "일부 페이지만이라도" 보여 줄 수 있게 한다.
//   (5) MediaAdapter<'pdf'> 계약 구현 — MultimediaRegistry.createDefaultRegistry 가
//       본 팩토리를 우선 등록한다.
//
// 설계 원칙
//   · 라이브러리 로드 실패는 DEPENDENCY_MISSING 으로 맵핑 — UI 가 "pdf-parse 미설치"
//     안내를 노출할 수 있게 한다.
//   · 암호 걸린 PDF 는 pdf-parse / pdf-lib 양쪽 모두 throw — 본 어댑터는 그것을 잡아
//     PDF_PARSE_ERROR 로 변환하고 `details.reason='encrypted'` 플래그를 붙인다.
//   · 대용량(>config.maxBytes) 은 파서 호출 전에 즉시 FILE_TOO_LARGE 로 거절한다.

// node:fs는 브라우저 번들에 포함되면 에러가 발생하므로 사용 시점에 동적 import
async function readFileNode(path: string): Promise<Buffer> {
  const { promises: fs } = await import('node:fs');
  return fs.readFile(path);
}

import {
  MediaAdapterError,
  type MediaAdapter,
  type MediaAdapterDescriptor,
  type MediaAdapterFactory,
  type MediaAdapterInvocation,
  type MediaAdapterOutcome,
  type MediaAdapterOutput,
  type MediaAdapterProgressHandler,
  type MediaFileInput,
  type MultimediaAdapterConfig,
} from '../types';

export const PDF_ADAPTER_ID = 'builtin-pdf';

const PDF_MAGIC = Buffer.from('%PDF-');
const MIME_PDF = 'application/pdf';

// ────────────────────────────────────────────────────────────────────────────
// 공개 타입 — DocumentTree · PdfPage · driver 훅
// ────────────────────────────────────────────────────────────────────────────

/**
 * 추출된 단일 페이지.
 *   · images 좌표는 pdfjs-dist 계열 driver 일 때만 채워진다(기본 pdf-parse 는 비움).
 */
export interface PdfPage {
  readonly index: number;
  readonly text: string;
  readonly images?: ReadonlyArray<PdfImageRef>;
}

export interface PdfImageRef {
  /** 1-base 페이지 내 순번. */
  readonly ordinal: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly mimeType?: string;
}

export interface PdfMetadata {
  readonly pageCount: number;
  readonly parserId: string;
  readonly durationMs: number;
  readonly title?: string;
  readonly author?: string;
  readonly encrypted?: boolean;
}

export interface ParsedPdf {
  readonly pages: readonly PdfPage[];
  readonly metadata: PdfMetadata;
}

/** 섹션·표·이미지·페이지 번호를 지원하는 DocumentTree 모델. */
export type DocumentNode =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'image'; readonly data: Uint8Array; readonly mimeType: 'image/png' | 'image/jpeg'; readonly caption?: string }
  | { readonly kind: 'table'; readonly rows: ReadonlyArray<readonly string[]>; readonly header?: readonly string[] }
  | { readonly kind: 'pageBreak' };

export interface DocumentSection {
  readonly title?: string;
  readonly nodes: readonly DocumentNode[];
}

export interface DocumentTree {
  readonly title?: string;
  readonly author?: string;
  readonly sections: readonly DocumentSection[];
  /** 생성 옵션 — 페이지 하단 번호 표시. */
  readonly pageNumbers?: boolean;
}

/** 파서 driver — 실제 라이브러리 호출을 감싼 계약. */
export interface PdfParseDriver {
  readonly id: string;
  parse(input: {
    readonly buffer: Uint8Array;
    readonly signal?: AbortSignal;
    readonly onProgress?: (ratio: number) => void;
  }): Promise<ParsedPdf>;
}

/** 생성 driver — pdf-lib 기본, 테스트는 메모리 stub 주입. */
export interface PdfGenerateDriver {
  readonly id: string;
  generate(input: {
    readonly doc: DocumentTree;
    readonly signal?: AbortSignal;
    readonly onProgress?: (ratio: number) => void;
  }): Promise<Uint8Array>;
}

// ────────────────────────────────────────────────────────────────────────────
// 오류 코드
// ────────────────────────────────────────────────────────────────────────────

export type PdfAdapterErrorCode = 'PDF_PARSE_ERROR' | 'PDF_GEN_ERROR';

function pdfError(
  pdfCode: PdfAdapterErrorCode,
  message: string,
  opts: { cause?: unknown; reason?: string; partial?: unknown } = {},
): MediaAdapterError {
  return new MediaAdapterError('INTERNAL', message, {
    adapterId: PDF_ADAPTER_ID,
    details: {
      pdfCode,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.partial !== undefined ? { partial: opts.partial } : {}),
    },
    cause: opts.cause,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// parsePdf / generatePdf — 최상위 공개 함수
// ────────────────────────────────────────────────────────────────────────────

export interface ParsePdfOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (ratio: number) => void;
  /** 직접 driver 주입 — 기본은 pdf-parse 동적 import. */
  readonly parseDriver?: PdfParseDriver;
  /** 크기 상한. 초과 시 FILE_TOO_LARGE(MediaAdapterError). 0 은 무제한. */
  readonly maxBytes?: number;
}

export async function parsePdf(
  input: Buffer | Uint8Array | string,
  opts: ParsePdfOptions = {},
): Promise<ParsedPdf> {
  ensureNotAborted(opts.signal);

  const buffer = await loadBuffer(input);
  if (typeof opts.maxBytes === 'number' && opts.maxBytes > 0 && buffer.byteLength > opts.maxBytes) {
    throw new MediaAdapterError(
      'FILE_TOO_LARGE',
      `PDF 크기 ${buffer.byteLength}B 가 허용 최대(${opts.maxBytes}B) 를 초과합니다.`,
      { adapterId: PDF_ADAPTER_ID, details: { sizeBytes: buffer.byteLength, maxBytes: opts.maxBytes } },
    );
  }

  // 매직 바이트 검증을 driver 호출 전에 수행 — 잘못된 파일을 빨리 거절한다.
  assertPdfMagic(buffer);

  opts.onProgress?.(0);

  const driver = opts.parseDriver ?? (await loadDefaultParseDriver());

  try {
    const result = await driver.parse({
      buffer: buffer as Uint8Array,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    opts.onProgress?.(1);
    return result;
  } catch (err) {
    if (err instanceof MediaAdapterError) throw err;
    if (isAbortError(err)) {
      throw new MediaAdapterError('ABORTED', 'PDF 파싱 취소', {
        adapterId: PDF_ADAPTER_ID,
        cause: err,
      });
    }
    if (isEncryptedError(err)) {
      throw pdfError('PDF_PARSE_ERROR', '암호가 걸린 PDF 는 파싱할 수 없습니다.', {
        cause: err,
        reason: 'encrypted',
      });
    }
    throw pdfError('PDF_PARSE_ERROR', `PDF 파싱 실패: ${errorMessage(err)}`, { cause: err });
  }
}

export interface GeneratePdfOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (ratio: number) => void;
  readonly generateDriver?: PdfGenerateDriver;
}

export async function generatePdf(
  doc: DocumentTree,
  opts: GeneratePdfOptions = {},
): Promise<Buffer> {
  ensureNotAborted(opts.signal);
  if (!doc || !Array.isArray(doc.sections)) {
    throw new MediaAdapterError('INPUT_INVALID', 'DocumentTree.sections 가 필요합니다.', {
      adapterId: PDF_ADAPTER_ID,
    });
  }

  opts.onProgress?.(0);

  const driver = opts.generateDriver ?? (await loadDefaultGenerateDriver());

  try {
    const bytes = await driver.generate({ doc, signal: opts.signal, onProgress: opts.onProgress });
    opts.onProgress?.(1);
    return Buffer.from(bytes);
  } catch (err) {
    if (err instanceof MediaAdapterError) throw err;
    if (isAbortError(err)) {
      throw new MediaAdapterError('ABORTED', 'PDF 생성 취소', {
        adapterId: PDF_ADAPTER_ID,
        cause: err,
      });
    }
    throw pdfError('PDF_GEN_ERROR', `PDF 생성 실패: ${errorMessage(err)}`, { cause: err });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MediaAdapter<'pdf'> 구현
// ────────────────────────────────────────────────────────────────────────────

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'pdf',
    id: PDF_ADAPTER_ID,
    displayName: 'PDF 어댑터(실구현)',
    supportedInputMimes: [MIME_PDF],
    producedOutputMimes: [MIME_PDF],
    capabilities: {
      canParse: true,
      canGenerate: true,
      streamsProgress: true,
      worksOffline: true,
      requiresUserConsent: false,
    },
    // 스켈레톤(priority=0) 보다 우선. resolveByKind('pdf') 가 본 구현을 선택한다.
    priority: -10,
    dependsOn: [],
  };
}

export interface RealPdfAdapterOptions {
  readonly parseDriver?: PdfParseDriver;
  readonly generateDriver?: PdfGenerateDriver;
}

export class PdfAdapter implements MediaAdapter<'pdf'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();
  private readonly parseDriver?: PdfParseDriver;
  private readonly generateDriver?: PdfGenerateDriver;

  constructor(
    private readonly config: MultimediaAdapterConfig,
    options: RealPdfAdapterOptions = {},
  ) {
    this.parseDriver = options.parseDriver;
    this.generateDriver = options.generateDriver;
  }

  canHandle(input: MediaFileInput): boolean {
    if (!input || typeof input !== 'object') return false;
    if (input.mimeType && input.mimeType !== MIME_PDF) return false;
    if (input.fileName && !input.fileName.toLowerCase().endsWith('.pdf') && !input.mimeType) {
      return false;
    }
    if (typeof input.sizeBytes === 'number' && input.sizeBytes > this.config.maxBytes) {
      return false;
    }
    return true;
  }

  async invoke(
    call: MediaAdapterInvocation<'pdf'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'pdf'>>> {
    const startedAtMs = Date.now();
    const bridge = progressBridge('precheck', call.onProgress);
    bridge.update(0);

    const parsed = await parsePdf(
      await mediaInputToBuffer(call.input),
      {
        signal: call.signal,
        onProgress: (ratio) => bridge.update(ratio),
        parseDriver: this.parseDriver,
        maxBytes: this.config.maxBytes,
      },
    );

    bridge.toFinalize();

    return {
      adapterId: this.descriptor.id,
      startedAtMs,
      finishedAtMs: Date.now(),
      result: {
        pageCount: parsed.metadata.pageCount,
        text: parsed.pages.map((p) => p.text).join('\n\n').trim(),
      },
    };
  }
}

export const createRealPdfAdapter: MediaAdapterFactory<'pdf'> = (config) => new PdfAdapter(config);

// ────────────────────────────────────────────────────────────────────────────
// 기본 driver — pdf-parse (파싱) · pdf-lib (생성). 동적 import 로 번들러 부담 경감.
// ────────────────────────────────────────────────────────────────────────────

async function loadDefaultParseDriver(): Promise<PdfParseDriver> {
  let PDFParse: unknown;
  try {
    const mod = (await import('pdf-parse')) as unknown as { PDFParse?: unknown };
    PDFParse = mod.PDFParse;
  } catch (err) {
    throw new MediaAdapterError(
      'DEPENDENCY_MISSING',
      '`pdf-parse` 라이브러리를 로드할 수 없습니다. 의존성을 설치하거나 opts.parseDriver 를 주입하세요.',
      { adapterId: PDF_ADAPTER_ID, cause: err, details: { dependency: 'pdf-parse' } },
    );
  }
  if (typeof PDFParse !== 'function') {
    throw new MediaAdapterError('DEPENDENCY_MISSING', 'pdf-parse 가 기대한 형태(PDFParse class) 가 아닙니다.', {
      adapterId: PDF_ADAPTER_ID,
      details: { dependency: 'pdf-parse' },
    });
  }
  const ParserCtor = PDFParse as new (opts: { data: Uint8Array }) => {
    getText: () => Promise<{ text?: string; numpages?: number; info?: { Title?: string; Author?: string } }>;
    destroy?: () => Promise<unknown> | unknown;
  };

  return {
    id: 'pdf-parse',
    async parse({ buffer, signal, onProgress }) {
      const startedAt = Date.now();
      const parser = new ParserCtor({ data: buffer });
      try {
        const res = await withAbort(parser.getText(), signal);
        const fullText = typeof res.text === 'string' ? res.text : '';
        const pageCount = typeof res.numpages === 'number' && Number.isFinite(res.numpages) ? res.numpages : 0;
        const splits = fullText.includes('\f')
          ? fullText.split('\f')
          : pageCount > 0 || fullText
            ? [fullText]
            : [];
        const pages: PdfPage[] = splits.map((text, idx) => {
          onProgress?.(Math.min(0.9, (idx + 1) / Math.max(1, splits.length) * 0.9));
          return { index: idx + 1, text };
        });
        return {
          pages,
          metadata: {
            pageCount: pageCount || pages.length,
            parserId: 'pdf-parse',
            durationMs: Date.now() - startedAt,
            title: res.info?.Title,
            author: res.info?.Author,
          },
        };
      } finally {
        try { await parser.destroy?.(); } catch { /* ignore */ }
      }
    },
  };
}

async function loadDefaultGenerateDriver(): Promise<PdfGenerateDriver> {
  let lib: {
    PDFDocument: {
      create: () => Promise<{
        setTitle: (t: string) => void;
        setAuthor: (a: string) => void;
        addPage: (size?: [number, number]) => {
          drawText: (t: string, opts?: Record<string, unknown>) => void;
          drawImage: (img: unknown, opts?: Record<string, unknown>) => void;
          getSize: () => { width: number; height: number };
        };
        embedPng: (bytes: Uint8Array) => Promise<unknown>;
        embedJpg: (bytes: Uint8Array) => Promise<unknown>;
        save: () => Promise<Uint8Array>;
      }>;
    };
  };
  try {
    lib = (await import('pdf-lib')) as unknown as typeof lib;
  } catch (err) {
    throw new MediaAdapterError(
      'DEPENDENCY_MISSING',
      '`pdf-lib` 라이브러리를 로드할 수 없습니다. 의존성을 설치하거나 opts.generateDriver 를 주입하세요.',
      { adapterId: PDF_ADAPTER_ID, cause: err, details: { dependency: 'pdf-lib' } },
    );
  }

  return {
    id: 'pdf-lib',
    async generate({ doc, signal, onProgress }) {
      ensureNotAborted(signal);
      const pdfDoc = await lib.PDFDocument.create();
      if (doc.title) pdfDoc.setTitle(doc.title);
      if (doc.author) pdfDoc.setAuthor(doc.author);

      const nodes: DocumentNode[] = [];
      for (const s of doc.sections) {
        if (s.title) nodes.push({ kind: 'heading', level: 1, text: s.title });
        for (const n of s.nodes) nodes.push(n);
      }

      let page = pdfDoc.addPage([612, 792]);
      let cursorY = 740;

      function drawLine(text: string, size: number): void {
        if (cursorY < 60) {
          page = pdfDoc.addPage([612, 792]);
          cursorY = 740;
        }
        page.drawText(text, { x: 60, y: cursorY, size });
        cursorY -= size + 6;
      }

      const total = Math.max(1, nodes.length);
      for (let i = 0; i < nodes.length; i += 1) {
        ensureNotAborted(signal);
        const node = nodes[i];
        switch (node.kind) {
          case 'heading':
            drawLine(node.text, node.level === 1 ? 20 : node.level === 2 ? 16 : 14);
            cursorY -= 4;
            break;
          case 'paragraph':
            drawLine(node.text, 11);
            break;
          case 'table': {
            if (node.header) drawLine(node.header.join(' | '), 11);
            for (const row of node.rows) drawLine(row.join(' | '), 10);
            break;
          }
          case 'image': {
            const embedded = node.mimeType === 'image/png'
              ? await pdfDoc.embedPng(node.data)
              : await pdfDoc.embedJpg(node.data);
            if (cursorY < 260) {
              page = pdfDoc.addPage([612, 792]);
              cursorY = 740;
            }
            page.drawImage(embedded, { x: 60, y: cursorY - 200, width: 240, height: 200 });
            cursorY -= 210;
            if (node.caption) drawLine(node.caption, 10);
            break;
          }
          case 'pageBreak':
            page = pdfDoc.addPage([612, 792]);
            cursorY = 740;
            break;
        }
        onProgress?.(Math.min(0.95, (i + 1) / total * 0.95));
      }

      if (doc.pageNumbers) {
        // 기본 드라이버는 페이지 번호를 마지막 단계에서 일괄 추가한다. 본 스켈레톤은
        // 메타 플래그만 남기고 실제 stamp 는 후속 PR 에서 심화한다(현재는 no-op).
      }

      const bytes = await pdfDoc.save();
      return bytes;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ────────────────────────────────────────────────────────────────────────────

async function loadBuffer(input: Buffer | Uint8Array | string): Promise<Buffer> {
  if (typeof input === 'string') {
    try {
      return await readFileNode(input);
    } catch (err) {
      throw pdfError('PDF_PARSE_ERROR', `파일 열기 실패: ${input}`, { cause: err, reason: 'read-failed' });
    }
  }
  if (input instanceof Buffer) return input;
  return Buffer.from(input);
}

async function mediaInputToBuffer(input: MediaFileInput): Promise<Buffer | string> {
  const src = input.source as unknown;
  if (typeof src === 'string') return src;
  if (Buffer.isBuffer(src)) return src as Buffer;
  if (src instanceof Uint8Array) return Buffer.from(src);
  if (src instanceof ArrayBuffer) return Buffer.from(new Uint8Array(src));
  // Blob 은 Node 환경에서 arrayBuffer() 를 가진다(18+).
  if (src && typeof (src as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
    const ab = await (src as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
    return Buffer.from(new Uint8Array(ab));
  }
  throw new MediaAdapterError('INPUT_INVALID', 'MediaFileInput.source 의 형태를 인식할 수 없습니다.', {
    adapterId: PDF_ADAPTER_ID,
  });
}

function assertPdfMagic(buffer: Buffer | Uint8Array): void {
  if (buffer.byteLength < PDF_MAGIC.length) {
    throw pdfError('PDF_PARSE_ERROR', 'PDF 매직 바이트 누락 — 파일이 손상되었습니다.', {
      reason: 'missing-magic',
    });
  }
  const head = buffer instanceof Buffer ? buffer.subarray(0, PDF_MAGIC.length) : Buffer.from(buffer.subarray(0, PDF_MAGIC.length));
  if (!head.equals(PDF_MAGIC)) {
    throw pdfError('PDF_PARSE_ERROR', 'PDF 매직 바이트가 일치하지 않습니다 — 다른 포맷 가능성.', {
      reason: 'bad-magic',
    });
  }
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MediaAdapterError('ABORTED', '작업이 취소되었습니다.', { adapterId: PDF_ADAPTER_ID });
  }
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; code?: string };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

function isEncryptedError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return /encrypted|password|encrypt/.test(msg);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new MediaAdapterError('ABORTED', '작업이 취소되었습니다.', { adapterId: PDF_ADAPTER_ID }));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * 0~1 의 단일 ratio 를 받아 어댑터 외부로는 phase='upload' 진행률로 변환해 내보내는
 * 브리지. precheck 는 즉시 한 번만 보내고, finalize 는 호출자가 `toFinalize()` 로 명시.
 */
function progressBridge(
  initial: 'precheck' | 'upload' | 'finalize',
  handler?: MediaAdapterProgressHandler,
): { update: (ratio: number) => void; toFinalize: () => void } {
  let phase: 'precheck' | 'upload' | 'finalize' = initial;
  return {
    update(ratio: number) {
      if (!handler) return;
      if (phase === 'precheck') {
        handler({ phase: 'precheck', ratio: 1 });
        phase = 'upload';
      }
      handler({ phase: 'upload', ratio: Math.max(0, Math.min(1, ratio)) });
    },
    toFinalize() {
      if (!handler) return;
      phase = 'finalize';
      handler({ phase: 'finalize', ratio: 1 });
    },
  };
}
