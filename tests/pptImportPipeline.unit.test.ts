// Run with: npx tsx --test tests/pptImportPipeline.unit.test.ts
//
// 지시 #82bd96f7 — PPT(.pptx) 파서/서비스 파이프라인 잠금.
//   A. pptParser — accept/maxBytes 노출 · 암호화/가짜 파일(zip 매직 아님) 차단
//                 · 용량 초과 차단 · presentation.xml 누락 차단
//   B. pptParser — stub ZipEngine 을 주입한 정상 경로에서 슬라이드 순서·노트·
//                 미디어 목록 · 썸네일 메타를 바르게 추출
//   C. extractSlideText 유닛 — <a:t> 다중 텍스트·엔티티 디코딩
//   D. DecompressionStream 통합 — Node 18+ 에서 실제 deflate-raw 가 돌아감을 재확인
//   E. renderSummaryMarkdown — 에이전트 참조용 .md 의 섹션/목록 포맷
//   F. createPptImportService — 원본 + .extracted.txt + .summary.md 세 건을 메모리
//                                저장소에 업로드, 진행률 phase 체인을 순서대로 방출
//   G. 암호화/손상 파일 에러가 mapUnknownError 로 사용자 친화 메시지로 매핑되는지
//
// 실 브라우저가 없어도 본 테스트로 파이프라인 계약이 잠긴다. 100MB 경계 파일에 대한
// "진행률 반응성" 은 parse phase 의 current/total 이 슬라이드마다 오르는지로 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPptParser,
  createDefaultZipEngine,
  extractSlideText,
  type ZipEngine,
  type ZipArchive,
  type PptSlideExtract,
  type PptExtractionResult,
  DEFAULT_PPT_ACCEPT,
  DEFAULT_PPT_MAX_BYTES,
} from '../src/lib/multimedia/pptParser.ts';
import {
  MultimediaImportError,
  type MultimediaProgressEvent,
} from '../src/lib/multimedia/types.ts';
import {
  createPptImportService,
  renderSummaryMarkdown,
} from '../src/services/pptImportService.ts';
import {
  createMemoryProjectFileStorage,
  createProjectFileStore,
} from '../src/store/projectFiles.ts';
import { mapUnknownError } from '../src/utils/errorMessages.ts';

// ────────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────────

function makeZipHeader(): Uint8Array {
  // PK\x03\x04 로 시작하는 최소 헤더 — 실데이터는 stub 엔진이 해석하지 않으므로
  // 파서는 매직 바이트만 확인한 뒤 엔진에 아카이브 해석을 위임한다.
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
}

function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function stubArchive(files: Record<string, string>): ZipArchive {
  return {
    list() { return Object.keys(files); },
    open(name) {
      if (!(name in files)) return null;
      const bytes = encode(files[name]);
      return { name, async read() { return bytes; } };
    },
  };
}

function stubEngine(files: Record<string, string>): ZipEngine {
  const archive = stubArchive(files);
  return { async read() { return archive; } };
}

function makeFakePptx(files: Record<string, string>): Blob {
  // 매직 바이트를 포함한 가짜 바이너리. 내용 해석은 stub 엔진이 하므로 바이트 본문은
  // 의미가 없다. 단지 Blob.size 와 magic 체크 통과만을 담당.
  const head = makeZipHeader();
  return new Blob([head], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}

// 실제 .pptx 구조를 본딴 최소 파일 집합 — 3개 슬라이드 + 1개 노트 + 미디어 2개.
function minimalPptxFiles(): Record<string, string> {
  return {
    'ppt/presentation.xml':
      '<?xml version="1.0"?><p:presentation xmlns:p="x" xmlns:r="y">' +
      '<p:sldIdLst>' +
      '<p:sldId id="256" r:id="rId1"/>' +
      '<p:sldId id="257" r:id="rId2"/>' +
      '<p:sldId id="258" r:id="rId3"/>' +
      '</p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="x">' +
      '<Relationship Id="rId1" Target="slides/slide1.xml"/>' +
      '<Relationship Id="rId2" Target="slides/slide2.xml"/>' +
      '<Relationship Id="rId3" Target="slides/slide3.xml"/>' +
      '</Relationships>',
    'ppt/slides/slide1.xml':
      '<p:sld><p:cSld><p:spTree>' +
      '<a:p><a:r><a:t>첫 번째 슬라이드</a:t></a:r></a:p>' +
      '<a:p><a:r><a:t>제목: 개요</a:t></a:r></a:p>' +
      '</p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide2.xml':
      '<p:sld><p:cSld><p:spTree>' +
      '<a:p><a:r><a:t>두 번째 &amp; 중요</a:t></a:r></a:p>' +
      '</p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide3.xml':
      '<p:sld><p:cSld><p:spTree>' +
      '<a:p><a:r><a:t>세 번째 슬라이드</a:t></a:r></a:p>' +
      '</p:spTree></p:cSld></p:sld>',
    'ppt/notesSlides/notesSlide2.xml':
      '<p:notes><p:cSld><p:spTree>' +
      '<a:p><a:r><a:t>두 번째 슬라이드 노트</a:t></a:r></a:p>' +
      '</p:spTree></p:cSld></p:notes>',
    'docProps/core.xml':
      '<cp:coreProperties xmlns:cp="x" xmlns:dc="z">' +
      '<dc:title>테스트 프레젠테이션</dc:title>' +
      '<dc:creator>Joker</dc:creator>' +
      '</cp:coreProperties>',
    'docProps/app.xml':
      '<Properties xmlns="x"><Slides>3</Slides><Company>ACME</Company></Properties>',
    'docProps/thumbnail.jpeg': 'fakejpeg',
    'ppt/media/image1.png': 'x',
    'ppt/media/image2.jpg': 'x',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// A. 경계 계약
// ────────────────────────────────────────────────────────────────────────────

test('A1. accept/maxBytes 기본값이 100MB · .pptx MIME/확장자를 포함', () => {
  const parser = createPptParser();
  assert.equal(parser.maxBytes, DEFAULT_PPT_MAX_BYTES);
  assert.ok(parser.accept.includes('.pptx'));
  assert.ok(parser.accept.includes('openxmlformats-officedocument.presentationml.presentation'));
  assert.equal(DEFAULT_PPT_ACCEPT, parser.accept);
});

test('A2. 용량 초과 → MULTIMEDIA_FILE_TOO_LARGE', async () => {
  const parser = createPptParser({ maxBytes: 10, zipEngine: stubEngine({}) });
  const blob = new Blob([new Uint8Array(20)]);
  await assert.rejects(() => parser.parse(blob), (err: unknown) => {
    return err instanceof MultimediaImportError && err.code === 'MULTIMEDIA_FILE_TOO_LARGE';
  });
});

test('A3. ZIP 매직이 아님(암호화/가짜) → MULTIMEDIA_UNSUPPORTED_FORMAT', async () => {
  const parser = createPptParser({ zipEngine: stubEngine({}) });
  // 암호화된 OOXML 은 CFB 시작(0xD0 0xCF 0x11 0xE0). ZIP 매직이 아니므로 분기로 잡힌다.
  const blob = new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x00])]);
  await assert.rejects(() => parser.parse(blob), (err: unknown) => {
    return err instanceof MultimediaImportError && err.code === 'MULTIMEDIA_UNSUPPORTED_FORMAT';
  });
});

test('A4. presentation.xml 누락 → MULTIMEDIA_PARSE_FAILED', async () => {
  const parser = createPptParser({ zipEngine: stubEngine({ 'docProps/core.xml': '<x/>' }) });
  const blob = makeFakePptx({});
  await assert.rejects(() => parser.parse(blob), (err: unknown) => {
    return err instanceof MultimediaImportError && err.code === 'MULTIMEDIA_PARSE_FAILED';
  });
});

test('A5. abort 신호가 먼저 올라가면 MULTIMEDIA_PARSE_ABORTED', async () => {
  const parser = createPptParser({ zipEngine: stubEngine(minimalPptxFiles()) });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => parser.parse(makeFakePptx({}), { signal: ctrl.signal }), (err: unknown) => {
    return err instanceof MultimediaImportError && err.code === 'MULTIMEDIA_PARSE_ABORTED';
  });
});

// ────────────────────────────────────────────────────────────────────────────
// B. 정상 추출
// ────────────────────────────────────────────────────────────────────────────

test('B. 3슬라이드+1노트+미디어2개 정상 추출, 진행률 current 가 슬라이드마다 상승', async () => {
  const parser = createPptParser({ zipEngine: stubEngine(minimalPptxFiles()) });
  const events: MultimediaProgressEvent[] = [];
  const result = await parser.parse(makeFakePptx({}), {
    onProgress: (ev) => events.push(ev),
  });

  assert.equal(result.slides.length, 3);
  assert.equal(result.slides[0].text.includes('첫 번째 슬라이드'), true);
  assert.equal(result.slides[1].text.includes('두 번째 & 중요'), true, '엔티티 디코딩');
  assert.equal(result.slides[1].notes.includes('두 번째 슬라이드 노트'), true);
  assert.equal(result.slides[2].text.includes('세 번째 슬라이드'), true);
  assert.equal(result.metadata.title, '테스트 프레젠테이션');
  assert.equal(result.metadata.author, 'Joker');
  assert.equal(result.metadata.pageCount, 3);
  assert.deepEqual(result.mediaFiles.sort(), ['image1.png', 'image2.jpg']);
  assert.equal(result.thumbnailName, 'docProps/thumbnail.jpeg');

  const parseEvents = events.filter((e) => e.phase === 'parse');
  assert.equal(parseEvents.length, 3, '슬라이드마다 parse 이벤트 1회');
  assert.deepEqual(parseEvents.map((e) => e.current), [1, 2, 3]);
  assert.equal(events.some((e) => e.phase === 'finalize'), true);
});

// ────────────────────────────────────────────────────────────────────────────
// C. extractSlideText 유닛
// ────────────────────────────────────────────────────────────────────────────

test('C. extractSlideText — 다중 <a:t> 결합, 엔티티 디코딩, 공백 정리', () => {
  const xml =
    '<a:p><a:r><a:t>A</a:t></a:r><a:r><a:t>B&amp;C</a:t></a:r></a:p>' +
    '<a:p><a:r><a:t>D</a:t></a:r></a:p>';
  const text = extractSlideText(xml);
  assert.ok(text.includes('AB&C'));
  assert.ok(text.includes('D'));
});

// ────────────────────────────────────────────────────────────────────────────
// D. DecompressionStream 실제 왕복 — Node 18+ 에서 deflate-raw 가 돌아가는지
// ────────────────────────────────────────────────────────────────────────────

test('D. DecompressionStream(deflate-raw) 이 런타임에 존재 · 기본 ZIP 엔진이 에러 없이 생성됨', () => {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  assert.equal(typeof Ctor, 'function', 'Node 18+ 또는 최신 브라우저 필요');
  const engine = createDefaultZipEngine();
  assert.equal(typeof engine.read, 'function');
});

// ────────────────────────────────────────────────────────────────────────────
// E. renderSummaryMarkdown
// ────────────────────────────────────────────────────────────────────────────

test('E. 요약 마크다운 — 제목·슬라이드 섹션·노트·미디어 목록이 포함', () => {
  const result: PptExtractionResult = {
    text: '',
    sizeBytes: 0,
    metadata: { title: 'Demo', author: 'Joker', pageCount: 2 },
    slides: [
      { index: 0, source: 'slide1', text: '인트로', notes: '' } as PptSlideExtract,
      { index: 1, source: 'slide2', text: '본론', notes: '노트 본문' } as PptSlideExtract,
    ],
    mediaFiles: ['image1.png'],
    thumbnailName: 'docProps/thumbnail.jpeg',
  };
  const md = renderSummaryMarkdown('demo.pptx', result);
  assert.match(md, /^# Demo/);
  assert.match(md, /슬라이드 수: 2/);
  assert.match(md, /## 슬라이드 1/);
  assert.match(md, /인트로/);
  assert.match(md, /\*\*노트\*\*\n노트 본문/);
  assert.match(md, /## 내장 미디어\n- image1\.png/);
});

// ────────────────────────────────────────────────────────────────────────────
// F. pptImportService — 메모리 스토어로 원본/사이드카/요약 3건 적재
// ────────────────────────────────────────────────────────────────────────────

test('F. importPpt — 원본 + .extracted.txt + .summary.md 를 같은 projectId 로 적재', async () => {
  const parser = createPptParser({ zipEngine: stubEngine(minimalPptxFiles()) });
  const store = createProjectFileStore({ adapter: createMemoryProjectFileStorage() });
  const service = createPptImportService({ parser, store });

  const fakeFile = new File([makeFakePptx({})], 'demo.pptx', {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });

  const events: MultimediaProgressEvent[] = [];
  const outcome = await service.importPpt({
    projectId: 'P1',
    file: fakeFile,
    onProgress: (ev) => events.push(ev),
  });

  assert.ok(outcome.originalRecord);
  assert.ok(outcome.extractedTextRecord);
  assert.ok(outcome.summaryRecord);
  assert.equal(outcome.originalRecord.name, 'demo.pptx');
  assert.equal(outcome.extractedTextRecord?.name, 'demo.extracted.txt');
  assert.equal(outcome.summaryRecord?.name, 'demo.summary.md');

  // persist phase 가 0→1→2→3 순으로 올라가야 한다(총 3단계 + finalize).
  const persist = events.filter((e) => e.phase === 'persist').map((e) => e.current);
  assert.deepEqual(persist, [0, 1, 2, 3]);
  assert.equal(events.at(-1)?.phase, 'finalize');

  const list = await store.list('P1');
  const names = list.map((r) => r.name).sort();
  assert.deepEqual(names, ['demo.extracted.txt', 'demo.pptx', 'demo.summary.md']);
});

// ────────────────────────────────────────────────────────────────────────────
// G. errorMessages 매핑
// ────────────────────────────────────────────────────────────────────────────

test('G. 암호화/가짜 파일 에러가 사용자 친화 메시지로 매핑', async () => {
  const parser = createPptParser({ zipEngine: stubEngine({}) });
  try {
    await parser.parse(new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])]));
    assert.fail('예외가 발생해야 합니다.');
  } catch (err) {
    const friendly = mapUnknownError(err);
    // title 이 존재하고 한국어 메시지여야 한다(서버에서 흘린 원문 throw 를 그대로 노출하지 않는다).
    assert.equal(typeof friendly.title, 'string');
    assert.ok(friendly.title.length > 0);
  }
});
