// 지시 #4f4b0fc9 · PPT 어댑터 실제 구현.
//
// 직전 라운드(#aeabbd49) 에서 PdfAdapter 가 세운 "adapters/ 서브패키지 + 선택형 driver
// 주입 + progress 3 phase bridge + PDF_*_ERROR details.code" 패턴을 그대로 PPT 축에
// 적용한다. 기본 파싱 driver 는 저장소 내 `src/lib/multimedia/pptParser.ts` 의 OOXML
// 추출기를 재사용하고, 생성 driver 는 이미 의존성에 들어 있는 `pptxgenjs` 를 동적
// import 한다. 두 driver 모두 계약 레벨에서 교체 가능 — 실제 외부 라이브러리가 없어도
// 테스트는 stub driver 만으로 모든 분기를 잠글 수 있다.
//
// 핵심 오류 코드는 MediaAdapterError('INTERNAL') 을 상위 래퍼로 쓰고,
// details.pptCode ∈ {'PPT_PARSE_ERROR', 'PPT_GEN_ERROR'} 와 details.reason
// (bad-magic / missing-magic / encrypted / legacy-ppt / empty-presentation /
// too-many-slides / driver-missing) 로 분기 의미를 보존한다. 부분 결과를 돌려줘야
// 할 때는 details.partial 에 성공한 슬라이드 배열을 담아 호출자가 "일부만이라도"
// 보여 줄 수 있게 한다.

async function readFileNode(path: string): Promise<Uint8Array> {
  const { promises: fs } = await import('node:fs');
  const buf = await fs.readFile(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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

export const PPT_ADAPTER_ID = 'builtin-pptx';

const PPT_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const LEGACY_PPT_MIME = 'application/vnd.ms-powerpoint';
/** 브라우저에는 전역 `Buffer` 가 없으므로 Uint8Array 로 매직 검사 */
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
// 레거시 .ppt 는 복합 파일 이진 형식(Compound File Binary) — D0 CF 11 E0 로 시작.
const CFB_MAGIC = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
const DEFAULT_MAX_SLIDES = 500;

function isNodeBuffer(value: unknown): boolean {
  const B = (globalThis as { Buffer?: { isBuffer?: (v: unknown) => boolean } }).Buffer;
  return typeof B?.isBuffer === 'function' && B.isBuffer(value);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Node 에서는 Buffer, 브라우저에서는 chunked btoa */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from: (data: Uint8Array) => { toString: (enc: string) => string } } }).Buffer;
  if (typeof B?.from === 'function') {
    return B.from(bytes).toString('base64');
  }
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

// ────────────────────────────────────────────────────────────────────────────
// 공개 타입 — PptSlide · DeckTree · driver 훅
// ────────────────────────────────────────────────────────────────────────────

/** 슬라이드 내부 도형 · 이미지 · 표의 공통 좌표 박스(EMU 또는 포인트 단위는 driver 합의). */
export interface PptRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PptImageRef {
  readonly ordinal: number;
  readonly rect: PptRect;
  readonly mediaFile?: string;
  readonly mimeType?: string;
  readonly altText?: string;
}

export interface PptShapeRef {
  readonly ordinal: number;
  readonly rect: PptRect;
  readonly kind: 'rect' | 'ellipse' | 'arrow' | 'line' | 'callout' | 'other';
  readonly text?: string;
}

export interface PptTableRef {
  readonly ordinal: number;
  readonly rect: PptRect;
  readonly rows: ReadonlyArray<readonly string[]>;
  readonly header?: readonly string[];
}

export interface PptSlide {
  readonly index: number;
  /** 슬라이드 첫 번째 제목 플레이스홀더(타이틀). 없으면 undefined. */
  readonly title?: string;
  /** 제목을 제외한 본문 텍스트(문단은 '\n' 로 보존). */
  readonly body: string;
  /** 발표자 노트. */
  readonly notes: string;
  readonly images: readonly PptImageRef[];
  readonly shapes: readonly PptShapeRef[];
  readonly tables: readonly PptTableRef[];
  /** 레이아웃 id (예: 'layout-title', 'layout-title-content'). driver 가 감지 가능한 범위 내에서. */
  readonly layoutId?: string;
  /** 주 방향이 RTL(예: 아랍어·히브리어) 인가 여부. driver 가 감지 가능할 때만. */
  readonly rtl?: boolean;
}

export interface PptMetadata {
  readonly slideCount: number;
  readonly parserId: string;
  readonly durationMs: number;
  readonly title?: string;
  readonly author?: string;
  readonly encrypted?: boolean;
  /** 내장 폰트 이름 목록(한글 폰트 임베딩 경계 테스트 용). */
  readonly embeddedFonts?: readonly string[];
}

export interface ParsedPpt {
  readonly slides: readonly PptSlide[];
  readonly metadata: PptMetadata;
}

// Deck 생성 모델 — pptxgenjs 에 매핑하기 쉬운 1차원 노드 집합 + 레이아웃 힌트.
export type DeckNode =
  | { readonly kind: 'title'; readonly text: string; readonly subtitle?: string }
  | { readonly kind: 'bullets'; readonly title?: string; readonly items: readonly string[] }
  | { readonly kind: 'image'; readonly data: Uint8Array; readonly mimeType: 'image/png' | 'image/jpeg'; readonly caption?: string; readonly rect?: PptRect }
  | { readonly kind: 'table'; readonly rows: ReadonlyArray<readonly string[]>; readonly header?: readonly string[]; readonly rect?: PptRect }
  | { readonly kind: 'notes'; readonly text: string };

export interface DeckSlide {
  /** 템플릿 레이아웃 식별자. pptxgenjs 의 masterName 과 매핑. */
  readonly layout?: 'title' | 'title-content' | 'two-content' | 'blank' | 'comparison';
  readonly nodes: readonly DeckNode[];
}

export interface DeckTree {
  readonly title?: string;
  readonly author?: string;
  readonly slides: readonly DeckSlide[];
  /** 커스텀 마스터 슬라이드(템플릿) 정의 — driver 가 지원하면 그대로 pptxgenjs 로 전달. */
  readonly masters?: readonly {
    readonly name: string;
    readonly background?: string;
    readonly title?: string;
  }[];
  /** 한글 폰트를 내장할지 여부. true 면 driver 가 기본 KR 폰트 스택을 slide 마스터에 주입. */
  readonly embedKoreanFonts?: boolean;
}

export interface PptParseDriver {
  readonly id: string;
  parse(input: {
    readonly buffer: Uint8Array;
    readonly signal?: AbortSignal;
    readonly onProgress?: (ratio: number) => void;
    readonly maxSlides?: number;
  }): Promise<ParsedPpt>;
}

export interface PptGenerateDriver {
  readonly id: string;
  generate(input: {
    readonly deck: DeckTree;
    readonly signal?: AbortSignal;
    readonly onProgress?: (ratio: number) => void;
  }): Promise<Uint8Array>;
}

// ────────────────────────────────────────────────────────────────────────────
// 오류 코드
// ────────────────────────────────────────────────────────────────────────────

export type PptAdapterErrorCode = 'PPT_PARSE_ERROR' | 'PPT_GEN_ERROR';

function pptError(
  pptCode: PptAdapterErrorCode,
  message: string,
  opts: { cause?: unknown; reason?: string; partial?: unknown } = {},
): MediaAdapterError {
  return new MediaAdapterError('INTERNAL', message, {
    adapterId: PPT_ADAPTER_ID,
    details: {
      pptCode,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.partial !== undefined ? { partial: opts.partial } : {}),
    },
    cause: opts.cause,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// parsePpt / generatePpt — 최상위 공개 함수
// ────────────────────────────────────────────────────────────────────────────

export interface ParsePptOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (ratio: number) => void;
  readonly parseDriver?: PptParseDriver;
  /** 0 은 무제한. 초과 시 FILE_TOO_LARGE. */
  readonly maxBytes?: number;
  /** 기본 500. 초과 시 details.reason='too-many-slides' + partial 반환. */
  readonly maxSlides?: number;
}

export async function parsePpt(
  input: Buffer | Uint8Array | string,
  opts: ParsePptOptions = {},
): Promise<ParsedPpt> {
  ensureNotAborted(opts.signal);

  const buffer = await loadBuffer(input);
  if (typeof opts.maxBytes === 'number' && opts.maxBytes > 0 && buffer.byteLength > opts.maxBytes) {
    throw new MediaAdapterError(
      'FILE_TOO_LARGE',
      `PPTX 크기 ${buffer.byteLength}B 가 허용 최대(${opts.maxBytes}B) 를 초과합니다.`,
      { adapterId: PPT_ADAPTER_ID, details: { sizeBytes: buffer.byteLength, maxBytes: opts.maxBytes } },
    );
  }

  assertPptMagic(buffer);

  const maxSlides = typeof opts.maxSlides === 'number' && opts.maxSlides > 0
    ? opts.maxSlides
    : DEFAULT_MAX_SLIDES;

  opts.onProgress?.(0);

  const driver = opts.parseDriver ?? (await loadDefaultParseDriver());

  let result: ParsedPpt;
  try {
    result = await driver.parse({
      buffer: buffer as Uint8Array,
      signal: opts.signal,
      onProgress: opts.onProgress,
      maxSlides,
    });
  } catch (err) {
    if (err instanceof MediaAdapterError) throw err;
    if (isAbortError(err)) {
      throw new MediaAdapterError('ABORTED', 'PPT 파싱 취소', {
        adapterId: PPT_ADAPTER_ID,
        cause: err,
      });
    }
    if (isEncryptedError(err)) {
      throw pptError('PPT_PARSE_ERROR', '암호가 걸린 PPTX 는 파싱할 수 없습니다.', {
        cause: err,
        reason: 'encrypted',
      });
    }
    throw pptError('PPT_PARSE_ERROR', `PPT 파싱 실패: ${errorMessage(err)}`, { cause: err });
  }

  // 빈 프레젠테이션은 driver 가 빈 slides[] 로 돌려줘도 의미 있는 실패로 승격한다 —
  // 호출자는 이력 카드에 "내용 없음" 을 표시할 수 있게 된다.
  if (result.slides.length === 0) {
    throw pptError('PPT_PARSE_ERROR', '프레젠테이션에 슬라이드가 없습니다.', {
      reason: 'empty-presentation',
      partial: { slides: [], metadata: result.metadata },
    });
  }

  if (result.slides.length > maxSlides) {
    // 부분 결과 정책 — 초과분은 잘라 내고 partial 로만 실패 details 에 실어 호출자가
    // 일부라도 렌더 가능하게 한다.
    const truncated = result.slides.slice(0, maxSlides);
    throw pptError(
      'PPT_PARSE_ERROR',
      `슬라이드 수(${result.slides.length}) 가 허용 상한(${maxSlides}) 을 초과합니다.`,
      {
        reason: 'too-many-slides',
        partial: { slides: truncated, metadata: result.metadata },
      },
    );
  }

  opts.onProgress?.(1);
  return result;
}

export interface GeneratePptOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (ratio: number) => void;
  readonly generateDriver?: PptGenerateDriver;
}

export async function generatePpt(
  deck: DeckTree,
  opts: GeneratePptOptions = {},
): Promise<Uint8Array> {
  ensureNotAborted(opts.signal);
  if (!deck || !Array.isArray(deck.slides)) {
    throw new MediaAdapterError('INPUT_INVALID', 'DeckTree.slides 가 필요합니다.', {
      adapterId: PPT_ADAPTER_ID,
    });
  }
  if (deck.slides.length === 0) {
    throw new MediaAdapterError('INPUT_INVALID', '슬라이드가 하나도 없어 생성할 수 없습니다.', {
      adapterId: PPT_ADAPTER_ID,
      details: { pptCode: 'PPT_GEN_ERROR', reason: 'empty-deck' },
    });
  }

  opts.onProgress?.(0);

  const driver = opts.generateDriver ?? (await loadDefaultGenerateDriver());

  try {
    const bytes = await driver.generate({ deck, signal: opts.signal, onProgress: opts.onProgress });
    opts.onProgress?.(1);
    return bytes;
  } catch (err) {
    if (err instanceof MediaAdapterError) throw err;
    if (isAbortError(err)) {
      throw new MediaAdapterError('ABORTED', 'PPT 생성 취소', {
        adapterId: PPT_ADAPTER_ID,
        cause: err,
      });
    }
    throw pptError('PPT_GEN_ERROR', `PPT 생성 실패: ${errorMessage(err)}`, { cause: err });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MediaAdapter<'pptx'> 구현
// ────────────────────────────────────────────────────────────────────────────

function createDescriptor(): MediaAdapterDescriptor {
  return {
    kind: 'pptx',
    id: PPT_ADAPTER_ID,
    displayName: 'PPTX 어댑터(실구현)',
    supportedInputMimes: [PPT_MIME],
    producedOutputMimes: [PPT_MIME],
    capabilities: {
      canParse: true,
      canGenerate: true,
      streamsProgress: true,
      worksOffline: true,
      requiresUserConsent: false,
    },
    // 스켈레톤(priority=0) 보다 우선 선택되도록 한다.
    priority: -10,
    dependsOn: [],
  };
}

export interface RealPptAdapterOptions {
  readonly parseDriver?: PptParseDriver;
  readonly generateDriver?: PptGenerateDriver;
  readonly maxSlides?: number;
}

export class PptAdapter implements MediaAdapter<'pptx'> {
  readonly descriptor: MediaAdapterDescriptor = createDescriptor();
  private readonly parseDriver?: PptParseDriver;
  private readonly generateDriver?: PptGenerateDriver;
  private readonly maxSlides?: number;

  constructor(
    private readonly config: MultimediaAdapterConfig,
    options: RealPptAdapterOptions = {},
  ) {
    this.parseDriver = options.parseDriver;
    this.generateDriver = options.generateDriver;
    this.maxSlides = options.maxSlides;
  }

  canHandle(input: MediaFileInput): boolean {
    if (!input || typeof input !== 'object') return false;
    if (input.mimeType) {
      if (input.mimeType === LEGACY_PPT_MIME) return false; // 레거시는 명시적 거절
      if (input.mimeType !== PPT_MIME) return false;
    }
    // 파일명 판정 — fileName 우선, 없으면 source 가 문자열 경로일 때 거기서 확장자 추출.
    const candidateName = input.fileName
      ?? (typeof input.source === 'string' ? input.source : undefined);
    if (candidateName) {
      const lower = candidateName.toLowerCase();
      if (lower.endsWith('.ppt') && !lower.endsWith('.pptx')) return false;
      if (!lower.endsWith('.pptx') && !input.mimeType) return false;
    }
    if (typeof input.sizeBytes === 'number' && input.sizeBytes > this.config.maxBytes) {
      return false;
    }
    return true;
  }

  async invoke(
    call: MediaAdapterInvocation<'pptx'>,
  ): Promise<MediaAdapterOutcome<MediaAdapterOutput<'pptx'>>> {
    const startedAtMs = Date.now();
    const bridge = progressBridge('precheck', call.onProgress);
    bridge.update(0);

    const parsed = await parsePpt(
      await mediaInputToBuffer(call.input),
      {
        signal: call.signal,
        onProgress: (ratio) => bridge.update(ratio),
        parseDriver: this.parseDriver,
        maxBytes: this.config.maxBytes,
        maxSlides: this.maxSlides,
      },
    );

    bridge.toFinalize();

    return {
      adapterId: this.descriptor.id,
      startedAtMs,
      finishedAtMs: Date.now(),
      result: {
        slideCount: parsed.metadata.slideCount,
        text: parsed.slides.map((s) => [s.title, s.body, s.notes].filter(Boolean).join('\n')).join('\n\n').trim(),
      },
    };
  }
}

export const createRealPptAdapter: MediaAdapterFactory<'pptx'> = (config) =>
  new PptAdapter(config);

// ────────────────────────────────────────────────────────────────────────────
// 기본 driver — pptParser(파싱) · pptxgenjs(생성). 동적 import.
// ────────────────────────────────────────────────────────────────────────────

async function loadDefaultParseDriver(): Promise<PptParseDriver> {
  let createPptParser: unknown;
  try {
    const mod = (await import('../../../lib/multimedia/pptParser')) as unknown as {
      createPptParser?: unknown;
    };
    createPptParser = mod.createPptParser;
  } catch (err) {
    throw new MediaAdapterError(
      'DEPENDENCY_MISSING',
      'pptParser 모듈을 로드할 수 없습니다. opts.parseDriver 를 주입하세요.',
      { adapterId: PPT_ADAPTER_ID, cause: err, details: { dependency: 'pptParser' } },
    );
  }
  if (typeof createPptParser !== 'function') {
    throw new MediaAdapterError('DEPENDENCY_MISSING', 'pptParser 가 기대한 형태가 아닙니다.', {
      adapterId: PPT_ADAPTER_ID,
      details: { dependency: 'pptParser' },
    });
  }
  const factory = createPptParser as (opts?: unknown) => {
    parse(blobOrBytes: Blob | File, opts?: unknown): Promise<{
      slides: Array<{ index: number; text: string; notes: string }>;
      metadata?: { title?: string; author?: string; slideCount?: number };
    }>;
  };

  return {
    id: 'pptParser',
    async parse({ buffer, signal, onProgress, maxSlides }) {
      const startedAt = Date.now();
      const parser = factory();
      const blob = new Blob([buffer], { type: PPT_MIME });
      // pptParser.parse 는 MultimediaParseOptions(signal·onProgress) 를 지원한다.
      const res = await (parser.parse(blob as unknown as File, {
        signal,
        onProgress: (e: { phase: string; current: number; total: number }) => {
          if (e.phase === 'parse' && e.total > 0) {
            onProgress?.(Math.min(0.9, (e.current / e.total) * 0.9));
          }
        },
      }) as Promise<{
        slides: Array<{ index: number; text: string; notes: string }>;
        metadata?: { title?: string; author?: string; slideCount?: number };
      }>);

      const slides: PptSlide[] = res.slides.slice(0, maxSlides ?? DEFAULT_MAX_SLIDES).map((s) => {
        // 본문 첫 줄을 타이틀 휴리스틱으로 분리. OOXML 의 엄격한 plcholder 판정은
        // 후속 driver(pizzip+xmldom) 에서 채운다.
        const lines = s.text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const title = lines.length > 0 ? lines[0] : undefined;
        const body = lines.slice(1).join('\n');
        return {
          index: s.index,
          title,
          body,
          notes: s.notes ?? '',
          images: [],
          shapes: [],
          tables: [],
        };
      });

      return {
        slides,
        metadata: {
          slideCount: res.metadata?.slideCount ?? slides.length,
          parserId: 'pptParser',
          durationMs: Date.now() - startedAt,
          title: res.metadata?.title,
          author: res.metadata?.author,
        },
      };
    },
  };
}

async function loadDefaultGenerateDriver(): Promise<PptGenerateDriver> {
  let PptxGenJS: unknown;
  try {
    const mod = (await import('pptxgenjs')) as unknown as { default?: unknown };
    PptxGenJS = mod.default ?? mod;
  } catch (err) {
    throw new MediaAdapterError(
      'DEPENDENCY_MISSING',
      '`pptxgenjs` 라이브러리를 로드할 수 없습니다. 의존성을 설치하거나 opts.generateDriver 를 주입하세요.',
      { adapterId: PPT_ADAPTER_ID, cause: err, details: { dependency: 'pptxgenjs' } },
    );
  }
  const Ctor = PptxGenJS as new () => {
    title?: string;
    author?: string;
    defineLayout?: (opts: Record<string, unknown>) => void;
    defineSlideMaster?: (opts: Record<string, unknown>) => void;
    addSlide: (opts?: Record<string, unknown>) => {
      addText: (text: unknown, opts?: Record<string, unknown>) => void;
      addImage: (opts: Record<string, unknown>) => void;
      addTable: (rows: unknown, opts?: Record<string, unknown>) => void;
      addNotes: (text: string) => void;
    };
    writeFile?: (opts: Record<string, unknown>) => Promise<string>;
    write: (opts: Record<string, unknown>) => Promise<ArrayBuffer | Uint8Array | Buffer>;
  };

  return {
    id: 'pptxgenjs',
    async generate({ deck, signal, onProgress }) {
      ensureNotAborted(signal);
      const pres = new Ctor();
      if (deck.title) pres.title = deck.title;
      if (deck.author) pres.author = deck.author;

      if (deck.embedKoreanFonts) {
        // pptxgenjs 는 폰트 실제 임베딩을 지원하지 않지만, 마스터 텍스트 스타일에
        // 한글 우선 폰트 스택을 지정해 뷰어가 로컬 폰트를 선택하게 한다.
        pres.defineSlideMaster?.({
          title: 'KR_MASTER',
          objects: [],
          textStyle: { fontFace: 'Malgun Gothic' },
        });
      }

      const total = Math.max(1, deck.slides.length);
      for (let i = 0; i < deck.slides.length; i += 1) {
        ensureNotAborted(signal);
        const s = deck.slides[i];
        const slide = pres.addSlide({
          masterName: deck.embedKoreanFonts ? 'KR_MASTER' : undefined,
        });
        let notesBuffer = '';
        for (const node of s.nodes) {
          switch (node.kind) {
            case 'title':
              slide.addText(node.text, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28, bold: true });
              if (node.subtitle) {
                slide.addText(node.subtitle, { x: 0.5, y: 1.3, w: 9, h: 0.6, fontSize: 16 });
              }
              break;
            case 'bullets':
              if (node.title) slide.addText(node.title, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 22, bold: true });
              slide.addText(
                node.items.map((t) => ({ text: t, options: { bullet: true } })),
                { x: 0.5, y: 1.1, w: 9, h: 5, fontSize: 16 },
              );
              break;
            case 'image': {
              const rect = node.rect ?? { x: 0.5, y: 0.5, width: 6, height: 4 };
              slide.addImage({
                data: `data:${node.mimeType};base64,${uint8ArrayToBase64(node.data)}`,
                x: rect.x,
                y: rect.y,
                w: rect.width,
                h: rect.height,
              });
              if (node.caption) slide.addText(node.caption, { x: rect.x, y: rect.y + rect.height, w: rect.width, h: 0.3, fontSize: 10 });
              break;
            }
            case 'table': {
              const rect = node.rect ?? { x: 0.5, y: 0.5, width: 9, height: 4 };
              const rows = node.header ? [node.header, ...node.rows] : node.rows;
              slide.addTable(rows, { x: rect.x, y: rect.y, w: rect.width, h: rect.height });
              break;
            }
            case 'notes':
              notesBuffer += (notesBuffer ? '\n' : '') + node.text;
              break;
          }
        }
        if (notesBuffer) slide.addNotes(notesBuffer);
        onProgress?.(Math.min(0.95, (i + 1) / total * 0.95));
      }

      const out = await pres.write({ outputType: 'nodebuffer' });
      if (isNodeBuffer(out)) return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
      if (out instanceof Uint8Array) return out;
      return new Uint8Array(out);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ────────────────────────────────────────────────────────────────────────────

async function loadBuffer(input: Buffer | Uint8Array | string): Promise<Uint8Array> {
  if (typeof input === 'string') {
    try {
      return await readFileNode(input);
    } catch (err) {
      throw pptError('PPT_PARSE_ERROR', `파일 열기 실패: ${input}`, { cause: err, reason: 'read-failed' });
    }
  }
  if (isNodeBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}

async function mediaInputToBuffer(input: MediaFileInput): Promise<Uint8Array | string> {
  const src = input.source as unknown;
  if (typeof src === 'string') return src;
  if (isNodeBuffer(src)) {
    return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  }
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (src && typeof (src as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
    const ab = await (src as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new MediaAdapterError('INPUT_INVALID', 'MediaFileInput.source 의 형태를 인식할 수 없습니다.', {
    adapterId: PPT_ADAPTER_ID,
  });
}

function assertPptMagic(buffer: Uint8Array): void {
  if (buffer.byteLength < ZIP_MAGIC.length) {
    throw pptError('PPT_PARSE_ERROR', 'PPTX 매직 바이트 누락 — 파일이 손상되었습니다.', {
      reason: 'missing-magic',
    });
  }
  const head = buffer.subarray(0, ZIP_MAGIC.length);
  if (bytesEqual(head, ZIP_MAGIC)) return;
  // 레거시 .ppt 는 CFB 매직으로 시작한다. 별도 reason 으로 UI 가 안내 문구를 분기할
  // 수 있도록 한다.
  if (bytesEqual(head, CFB_MAGIC)) {
    throw pptError(
      'PPT_PARSE_ERROR',
      '레거시 .ppt(97-2003) 형식은 지원하지 않습니다. .pptx 로 다시 저장해 주세요.',
      { reason: 'legacy-ppt' },
    );
  }
  throw pptError('PPT_PARSE_ERROR', 'PPTX 매직 바이트가 일치하지 않습니다.', {
    reason: 'bad-magic',
  });
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MediaAdapterError('ABORTED', '작업이 취소되었습니다.', { adapterId: PPT_ADAPTER_ID });
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
