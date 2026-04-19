// 지시 #82bd96f7 — .pptx(OOXML PresentationML) 로컬 파서.
//
// 배경 / 라이브러리 평가
//   · `pptxgenjs` · `officegen` 은 쓰기 전용(내보내기). 읽기에 사용 불가.
//   · `pptx2json` 계열은 브라우저 번들링·ESM 호환성이 고르지 않고 마지막 배포가
//     오래됐다. 읽기 경로의 핵심(텍스트·노트·미디어 파일명·썸네일 메타) 만 필요하므로
//     외부 의존을 피하고 `DecompressionStream('deflate-raw')` + 직접 파싱으로 간다.
//     이 전략은 pdfParser 의 "라이브러리 주입 가능" 설계를 그대로 따라, 테스트에서는
//     stub `ZipEngine` 을 넣으면 DOM · 실 ZIP 데이터 없이도 계약을 잠글 수 있다.
//
// 구조 요약 (.pptx 는 ZIP 아카이브)
//   · ppt/presentation.xml      — 슬라이드 순서(`sldIdLst` 의 `r:id` 목록)
//   · ppt/_rels/presentation.xml.rels — rId → 슬라이드 경로 매핑
//   · ppt/slides/slideN.xml     — 슬라이드 본문 텍스트(<a:t>...</a:t>)
//   · ppt/notesSlides/notesSlideN.xml — 발표자 노트
//   · ppt/media/*               — 이미지·영상 등 내장 미디어(파일명 목록만 수집)
//   · docProps/core.xml         — title, creator(저자)
//   · docProps/app.xml          — slideCount, company 등
//   · docProps/thumbnail.jpeg   — 썸네일(존재 여부만 메타에 기록)
//
// 에러 분기
//   · ZIP 매직 아님                 → MULTIMEDIA_UNSUPPORTED_FORMAT (암호화된 OOXML 은
//                                    CFB 로 시작해 ZIP 매직이 아니므로 여기서 잡힌다)
//   · deflate 해제 실패/엔트리 깨짐 → MULTIMEDIA_PARSE_FAILED (손상 파일)
//   · presentation.xml 누락         → MULTIMEDIA_PARSE_FAILED
//   · abort 신호                   → MULTIMEDIA_PARSE_ABORTED
//
// TODO(영상 생성 모듈 연결점) — 지시 #82bd96f7 말미 요구 반영.
//   본 모듈은 MultimediaHandler<PptExtractionResult> 를 구현한다. 영상 생성 기능이
//   추가될 때는 `VideoGenerationHandler` 인터페이스를 본 파일 하단 주석 블록에 남긴
//   스펙대로 별도 모듈로 신설하고, pptParser 가 만든 slides[] 와 같은 구조화 결과를
//   그대로 생성 엔진에 흘려 넣을 수 있게 한다(슬라이드 → 영상 프레임 순서 보장).

import {
  MultimediaImportError,
  type MultimediaExtractionResult,
  type MultimediaHandler,
  type MultimediaParseOptions,
  type MultimediaProgressEvent,
} from './types';

export const DEFAULT_PPT_MAX_BYTES = 100 * 1024 * 1024;
// PowerPoint MIME 과 확장자. application/octet-stream 를 동반 허용해
// 일부 브라우저가 확장자만 제공할 때도 DropZone 이 막지 않도록 한다.
export const DEFAULT_PPT_ACCEPT =
  '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation';

const ZIP_LFH_SIG = 0x04034b50;
const ZIP_CDH_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04

/** 한 엔트리의 메타. read() 는 필요한 순간에만 해제해 메모리 스파이크를 줄인다. */
export interface ZipEntry {
  name: string;
  /** 압축 해제된 바이트. lazy 하게 가져오는 것을 기본 계약으로 한다. */
  read(): Promise<Uint8Array>;
}

export interface ZipArchive {
  list(): string[];
  /** 존재하지 않으면 null. */
  open(name: string): ZipEntry | null;
}

export interface ZipEngine {
  read(data: Uint8Array): Promise<ZipArchive>;
}

export interface PptSlideExtract {
  index: number;
  /** XML 경로(`ppt/slides/slide1.xml`). 로그·디버그용. */
  source: string;
  /** <a:t> 본문을 한 문자열로 합친 값. 문단 경계는 '\n' 으로 보존. */
  text: string;
  /** 발표자 노트. 없으면 빈 문자열. */
  notes: string;
}

export interface PptExtractionResult extends MultimediaExtractionResult {
  slides: PptSlideExtract[];
  /** ppt/media/ 이하 내장 미디어의 파일명 목록(경로 제외). */
  mediaFiles: string[];
  /** 썸네일(docProps/thumbnail.jpeg 등) 파일명. 없으면 null. */
  thumbnailName: string | null;
}

export interface CreatePptParserOptions {
  /** ZIP 엔진 주입. 기본은 DecompressionStream 기반 내장 리더. */
  zipEngine?: ZipEngine;
  maxBytes?: number;
  accept?: string;
}

function hasZipMagic(bytes: Uint8Array): boolean {
  if (bytes.length < ZIP_MAGIC.length) return false;
  for (let i = 0; i < ZIP_MAGIC.length; i += 1) {
    if (bytes[i] !== ZIP_MAGIC[i]) return false;
  }
  return true;
}

function readU16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset]) |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    (data[offset + 3] * 0x1000000)
  );
}

/** Node 18+ · 최신 브라우저에서 제공. 없으면 null 을 돌려 명시적으로 실패하게 한다. */
function resolveDecompressionStream(): typeof DecompressionStream | null {
  const g = globalThis as { DecompressionStream?: typeof DecompressionStream };
  return typeof g.DecompressionStream === 'function' ? g.DecompressionStream : null;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const Ctor = resolveDecompressionStream();
  if (!Ctor) {
    throw new MultimediaImportError(
      'MULTIMEDIA_PARSE_FAILED',
      '현재 런타임에 DecompressionStream 이 없어 .pptx 를 해제할 수 없습니다.',
    );
  }
  const blob = new Blob([data]);
  const stream = blob.stream().pipeThrough(new Ctor('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/**
 * 외부 의존 없는 ZIP 리더. `.pptx` 는 대부분 store(0) 또는 deflate(8) 만 사용한다.
 * 분할 아카이브·ZIP64 · 암호화는 지원하지 않는다 — 그런 파일이 들어오면 파싱이
 * MULTIMEDIA_PARSE_FAILED 로 돌려 상위가 사용자에게 명확하게 알린다.
 */
export function createDefaultZipEngine(): ZipEngine {
  return {
    async read(data) {
      // 1) EOCD 스캔(끝 22B + 주석 최대 65535B). 긴 주석은 희귀하므로 64KB 근처만 훑는다.
      const decoder = new TextDecoder('utf-8');
      const scanStart = Math.max(0, data.length - (22 + 0xFFFF));
      let eocd = -1;
      for (let i = data.length - 22; i >= scanStart; i -= 1) {
        if (readU32LE(data, i) === ZIP_EOCD_SIG) { eocd = i; break; }
      }
      if (eocd < 0) {
        throw new MultimediaImportError('MULTIMEDIA_PARSE_FAILED', 'ZIP 아카이브 경계(EOCD) 를 찾지 못했습니다.');
      }
      const totalEntries = readU16LE(data, eocd + 10);
      const cdOffset = readU32LE(data, eocd + 16);

      interface Entry {
        name: string;
        method: number;
        compSize: number;
        uncompSize: number;
        localOffset: number;
      }
      const entries = new Map<string, Entry>();
      let p = cdOffset;
      for (let i = 0; i < totalEntries; i += 1) {
        if (readU32LE(data, p) !== ZIP_CDH_SIG) {
          throw new MultimediaImportError('MULTIMEDIA_PARSE_FAILED', `ZIP 중앙 디렉터리 시그니처 깨짐(#${i}).`);
        }
        const method = readU16LE(data, p + 10);
        const compSize = readU32LE(data, p + 20);
        const uncompSize = readU32LE(data, p + 24);
        const nameLen = readU16LE(data, p + 28);
        const extraLen = readU16LE(data, p + 30);
        const commentLen = readU16LE(data, p + 32);
        const localOffset = readU32LE(data, p + 42);
        const name = decoder.decode(data.subarray(p + 46, p + 46 + nameLen));
        entries.set(name, { name, method, compSize, uncompSize, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
      }

      function open(name: string): ZipEntry | null {
        const entry = entries.get(name);
        if (!entry) return null;
        return {
          name,
          async read(): Promise<Uint8Array> {
            if (readU32LE(data, entry.localOffset) !== ZIP_LFH_SIG) {
              throw new MultimediaImportError('MULTIMEDIA_PARSE_FAILED', `ZIP 로컬 헤더 깨짐(${name}).`);
            }
            const lNameLen = readU16LE(data, entry.localOffset + 26);
            const lExtraLen = readU16LE(data, entry.localOffset + 28);
            const start = entry.localOffset + 30 + lNameLen + lExtraLen;
            const end = start + entry.compSize;
            const chunk = data.subarray(start, end);
            if (entry.method === 0) return chunk;
            if (entry.method === 8) return inflateRaw(chunk);
            throw new MultimediaImportError(
              'MULTIMEDIA_PARSE_FAILED',
              `지원하지 않는 압축 방식(${entry.method}) — ${name}.`,
            );
          },
        };
      }

      return {
        list() { return Array.from(entries.keys()); },
        open,
      };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// XML 텍스트 추출 — DOMParser 없는 경량 정규식 기반
// ────────────────────────────────────────────────────────────────────────────

const XML_TEXT_RE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
const PARA_CLOSE_RE = /<\/a:p>/g;

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

export function extractSlideText(xml: string): string {
  // 문단 단위 경계를 보존: 문단 종료 태그를 개행으로 치환한 뒤 <a:t> 를 이어붙인다.
  const normalized = xml.replace(PARA_CLOSE_RE, '</a:p>\n');
  const pieces: string[] = [];
  for (const m of normalized.matchAll(XML_TEXT_RE)) {
    pieces.push(decodeXmlEntities(m[1]));
  }
  return pieces.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function extractCoreProp(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return undefined;
  const v = decodeXmlEntities(m[1]).trim();
  return v.length > 0 ? v : undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// 파서 팩토리
// ────────────────────────────────────────────────────────────────────────────

function emit(cb: ((ev: MultimediaProgressEvent) => void) | undefined, ev: MultimediaProgressEvent): void {
  if (!cb) return;
  try { cb(ev); } catch { /* progress 예외는 파싱에 영향 없음 */ }
}

function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return input;
  const enc = new TextEncoder();
  const bytes = enc.encode(input);
  if (bytes.length <= maxBytes) return input;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, maxBytes));
}

function slideOrderFromPresentationXml(xml: string): string[] {
  // presentation.xml.rels 에서 r:id → Target 매핑을 만들어야 하지만 대부분의 .pptx 는
  // rId 번호가 곧 slideN 순서라 slideN.xml 를 직접 순회해도 동일 결과. 본 구현은
  // 더 안전하게 `sldIdLst` 의 등장 순서를 신뢰하되, 실제 파일 존재 여부는 아카이브
  // 스캔에서 필터링한다.
  const ids = Array.from(xml.matchAll(/<p:sldId\b[^/]*r:id="([^"]+)"/g)).map((m) => m[1]);
  return ids;
}

function parseRelsToTargets(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"[^>]*?\/?>/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

export function createPptParser(options: CreatePptParserOptions = {}): MultimediaHandler<PptExtractionResult> {
  const zipEngine = options.zipEngine ?? createDefaultZipEngine();
  const maxBytes = options.maxBytes ?? DEFAULT_PPT_MAX_BYTES;
  const accept = options.accept ?? DEFAULT_PPT_ACCEPT;

  async function parse(
    input: Blob,
    opts: MultimediaParseOptions = {},
  ): Promise<PptExtractionResult> {
    if (opts.signal?.aborted) {
      throw new MultimediaImportError('MULTIMEDIA_PARSE_ABORTED', 'PPT 파싱이 시작 전에 취소되었습니다.');
    }
    if (input.size > maxBytes) {
      throw new MultimediaImportError(
        'MULTIMEDIA_FILE_TOO_LARGE',
        `PPT 크기 ${input.size}B 가 상한 ${maxBytes}B 를 초과합니다.`,
      );
    }

    emit(opts.onProgress, { phase: 'open', current: 0, total: input.size });

    const buffer = await input.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (!hasZipMagic(bytes)) {
      // 암호화된 OOXML 은 ZIP 이 아닌 CFB 로 시작 → 본 분기로 사용자에게 안내.
      throw new MultimediaImportError(
        'MULTIMEDIA_UNSUPPORTED_FORMAT',
        '지원하지 않는 파일 형식입니다(암호화된 PPT 이거나 .pptx 가 아닐 수 있음).',
      );
    }

    let archive: ZipArchive;
    try {
      archive = await zipEngine.read(bytes);
    } catch (err) {
      if (err instanceof MultimediaImportError) throw err;
      throw new MultimediaImportError(
        'MULTIMEDIA_PARSE_FAILED',
        `ZIP 해제 실패: ${(err as Error).message}`,
        err,
      );
    }

    const names = archive.list();
    if (!names.includes('ppt/presentation.xml')) {
      throw new MultimediaImportError(
        'MULTIMEDIA_PARSE_FAILED',
        '.pptx 핵심 파일(ppt/presentation.xml) 이 없습니다 — 손상되었거나 PPT 가 아닌 ZIP 일 수 있어요.',
      );
    }

    async function readText(name: string): Promise<string | null> {
      const entry = archive.open(name);
      if (!entry) return null;
      const raw = await entry.read();
      return new TextDecoder('utf-8').decode(raw);
    }

    // 1) presentation.xml + rels 로 슬라이드 순서 확정.
    const presXml = (await readText('ppt/presentation.xml')) ?? '';
    const relsXml = (await readText('ppt/_rels/presentation.xml.rels')) ?? '';
    const rels = parseRelsToTargets(relsXml);
    const rids = slideOrderFromPresentationXml(presXml);

    // 2) 슬라이드 본문 + 노트.
    const slides: PptSlideExtract[] = [];
    const total = rids.length > 0 ? rids.length : names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
    let index = 0;
    async function processSlide(slidePath: string) {
      if (opts.signal?.aborted) {
        throw new MultimediaImportError('MULTIMEDIA_PARSE_ABORTED', 'PPT 파싱이 취소되었습니다.');
      }
      const xml = await readText(slidePath);
      if (!xml) return;
      // 노트: slide1.xml 에 대응되는 notes 는 `ppt/notesSlides/notesSlide<N>.xml` 명명.
      const nMatch = slidePath.match(/slide(\d+)\.xml$/);
      let notes = '';
      if (nMatch) {
        const notePath = `ppt/notesSlides/notesSlide${nMatch[1]}.xml`;
        const noteXml = await readText(notePath);
        if (noteXml) notes = extractSlideText(noteXml);
      }
      slides.push({ index, source: slidePath, text: extractSlideText(xml), notes });
      index += 1;
      emit(opts.onProgress, { phase: 'parse', current: index, total });
    }

    if (rids.length > 0) {
      for (const rid of rids) {
        const target = rels.get(rid);
        if (!target) continue;
        // 상대경로 해석: target 은 대부분 `slides/slide1.xml`.
        const resolved = target.startsWith('/') ? target.slice(1) : `ppt/${target}`;
        await processSlide(resolved);
      }
    } else {
      // rels 없거나 비표준 — 파일명을 직접 수집하고 번호순 정렬.
      const slidePaths = names
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => {
          const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
          const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
          return na - nb;
        });
      for (const sp of slidePaths) await processSlide(sp);
    }

    // 3) 메타데이터.
    const coreXml = (await readText('docProps/core.xml')) ?? '';
    const appXml = (await readText('docProps/app.xml')) ?? '';
    const title = extractCoreProp(coreXml, 'dc:title');
    const author = extractCoreProp(coreXml, 'dc:creator');
    const company = extractCoreProp(appXml, 'Company');
    const slideCountFromApp = extractCoreProp(appXml, 'Slides');

    // 4) 미디어 파일 목록 + 썸네일.
    const mediaFiles = names
      .filter((n) => n.startsWith('ppt/media/'))
      .map((n) => n.replace(/^ppt\/media\//, ''));
    const thumbnailName = names.find((n) => /^docProps\/thumbnail\.(?:jpe?g|png)$/i.test(n)) ?? null;

    emit(opts.onProgress, { phase: 'finalize', current: 1, total: 1 });

    const joined = slides
      .map((s, i) => {
        const noteBlock = s.notes ? `\n\n[노트]\n${s.notes}` : '';
        return `# 슬라이드 ${i + 1}\n${s.text}${noteBlock}`;
      })
      .join('\n\n')
      .trim();
    const capped = truncateUtf8(joined, opts.maxTextBytes ?? 5 * 1024 * 1024);

    const extra: Record<string, string | number | boolean> = {};
    if (company) extra.Company = company;
    if (mediaFiles.length > 0) extra.mediaFileCount = mediaFiles.length;
    if (thumbnailName) extra.thumbnail = thumbnailName;

    return {
      text: capped,
      sizeBytes: input.size,
      metadata: {
        title,
        author,
        pageCount: slides.length || (slideCountFromApp ? Number(slideCountFromApp) : undefined),
        pageTexts: slides.length > 0 ? slides.map((s) => s.text) : undefined,
        extra: Object.keys(extra).length > 0 ? Object.freeze(extra) : undefined,
      },
      slides,
      mediaFiles,
      thumbnailName,
    };
  }

  return {
    id: 'pptx',
    accept,
    maxBytes,
    parse,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// TODO — VideoGenerationHandler 인터페이스 공백(지시 #82bd96f7 §영상 모듈 대비)
// ────────────────────────────────────────────────────────────────────────────
//
// 추후 "슬라이드 → 영상 생성" 모듈을 추가할 때, 본 파서가 돌려주는
// PptExtractionResult.slides[] 를 그대로 소비하도록 아래 계약을 제안한다:
//
//   export interface VideoGenerationHandler {
//     readonly id: string;                 // 예: 'slides-to-mp4'
//     readonly maxDurationMs: number;      // 생성 가능한 최대 영상 길이
//     generate(input: {
//       slides: PptSlideExtract[];         // 슬라이드 순서 보장
//       voiceover?: Blob | null;           // 선택적 TTS/내레이션 오디오
//       signal?: AbortSignal;
//       onProgress?: (ev: MultimediaProgressEvent) => void;
//     }): Promise<{
//       videoBlob: Blob;
//       durationMs: number;
//       thumbnail: Blob | null;
//     }>;
//   }
//
// 진행률은 phase='parse' 를 유지하되 `current/total` 을 "렌더된 슬라이드 수" 로
// 매핑하면 UI 변경 없이 재사용 가능하다. 핸들러 등록은 `MediaHub` 에서 조건부 탭으로
// 노출하고, 구현 모듈은 `src/lib/multimedia/videoGenerator.ts` 에 둔다.
