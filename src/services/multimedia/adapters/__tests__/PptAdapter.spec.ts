// Run with: npx tsx --test src/services/multimedia/adapters/__tests__/PptAdapter.spec.ts
//
// 지시 #4f4b0fc9 · PptAdapter 실구현 단위 테스트.
//
// 실제 pptxgenjs / DecompressionStream 경로는 느리고 플랫폼 의존적이라, 본 스펙은
// PptParseDriver · PptGenerateDriver stub 을 주입해 분기만 결정론적으로 잠근다.
//
// 테스트 축
//   A. parsePpt 정상 (driver 결과·진행률·abort)
//   B. 손상 파일(매직 불일치/누락) · 레거시 .ppt(CFB 매직) · 암호 걸린 PPTX
//   C. 빈 프레젠테이션 · maxSlides 초과 (부분 결과 partial 포함)
//   D. RTL 텍스트가 driver 에서 그대로 전달되는지 · 100 슬라이드 입력
//   E. generatePpt (DeckTree 검증·한글 폰트 플래그·driver 오류→PPT_GEN_ERROR·abort)
//   F. PptAdapter.invoke 계약 + canHandle (레거시 .ppt 거절)
//   G. createDefaultRegistry 가 실구현(priority=-10) 선택

import test from 'node:test';
import assert from 'node:assert/strict';

import { MediaAdapterError, createDefaultRegistry } from '../../index.ts';
import {
  PptAdapter,
  parsePpt,
  generatePpt,
  createRealPptAdapter,
  PPT_ADAPTER_ID,
  type PptParseDriver,
  type PptGenerateDriver,
  type DeckTree,
  type PptSlide,
  type ParsedPpt,
} from '../PptAdapter.ts';
import { DEFAULT_ADAPTER_CONFIG } from '../../types.ts';

// ────────────────────────────────────────────────────────────────────────────
// 공통 유틸
// ────────────────────────────────────────────────────────────────────────────

function makePptxBuffer(): Buffer {
  // ZIP(PK\x03\x04) 매직만 있으면 매직 검사를 통과하고 driver 에 위임된다.
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('PPTX_FAKE_BODY')]);
}

function makeLegacyPptBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(8)]);
}

function makeSlide(index: number, overrides: Partial<PptSlide> = {}): PptSlide {
  return {
    index,
    title: `슬라이드 ${index}`,
    body: `본문 ${index}`,
    notes: `노트 ${index}`,
    images: [],
    shapes: [],
    tables: [],
    ...overrides,
  };
}

function fakeParseDriver(result: ParsedPpt, opts?: { delayProgress?: boolean }): PptParseDriver {
  return {
    id: 'fake',
    async parse({ onProgress }) {
      if (!opts?.delayProgress) onProgress?.(0.5);
      return result;
    },
  };
}

function fakeGenerateDriver(bytes = Buffer.from('PPTX_FAKE_OUT')): PptGenerateDriver & {
  readonly lastCall: { deck: DeckTree | null };
} {
  const state = { deck: null as DeckTree | null };
  return {
    id: 'fake-gen',
    lastCall: state,
    async generate({ deck, onProgress }) {
      state.deck = deck;
      onProgress?.(0.5);
      return new Uint8Array(bytes);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// A. parsePpt 정상
// ────────────────────────────────────────────────────────────────────────────

test('A1. parsePpt — driver 결과 그대로 반환 + 진행률 마지막 1.0', async () => {
  const progress: number[] = [];
  const result = await parsePpt(makePptxBuffer(), {
    parseDriver: fakeParseDriver({
      slides: [makeSlide(1), makeSlide(2), makeSlide(3)],
      metadata: { slideCount: 3, parserId: 'fake', durationMs: 1 },
    }),
    onProgress: (r) => progress.push(r),
  });
  assert.equal(result.slides.length, 3);
  assert.equal(result.metadata.parserId, 'fake');
  assert.equal(progress[progress.length - 1], 1);
});

test('A2. parsePpt — AbortSignal 사전 abort 는 즉시 ABORTED', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    parsePpt(makePptxBuffer(), {
      parseDriver: fakeParseDriver({ slides: [makeSlide(1)], metadata: { slideCount: 1, parserId: 'fake', durationMs: 0 } }),
      signal: ctrl.signal,
    }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'ABORTED',
  );
});

test('A3. parsePpt — driver 의 AbortError 는 ABORTED 로 번역', async () => {
  const driver: PptParseDriver = {
    id: 'abort',
    async parse() {
      const err = new Error('aborted');
      (err as { name?: string }).name = 'AbortError';
      throw err;
    },
  };
  await assert.rejects(
    parsePpt(makePptxBuffer(), { parseDriver: driver }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'ABORTED',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// B. 손상 · 레거시 · 암호
// ────────────────────────────────────────────────────────────────────────────

test('B1. parsePpt — 매직 누락(짧은 파일) 은 PPT_PARSE_ERROR + missing-magic', async () => {
  await assert.rejects(
    parsePpt(Buffer.alloc(2), {
      parseDriver: fakeParseDriver({ slides: [], metadata: { slideCount: 0, parserId: 'fake', durationMs: 0 } }),
    }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { pptCode?: string; reason?: string } | undefined;
      return d?.pptCode === 'PPT_PARSE_ERROR' && d?.reason === 'missing-magic';
    },
  );
});

test('B2. parsePpt — ZIP 매직 불일치는 bad-magic', async () => {
  await assert.rejects(
    parsePpt(Buffer.from('NOTPPT_NO_MAGIC'), {
      parseDriver: fakeParseDriver({ slides: [], metadata: { slideCount: 0, parserId: 'fake', durationMs: 0 } }),
    }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { reason?: string } | undefined;
      return d?.reason === 'bad-magic';
    },
  );
});

test('B3. parsePpt — 레거시 .ppt(CFB 매직) 은 PPT_PARSE_ERROR + reason=legacy-ppt', async () => {
  await assert.rejects(
    parsePpt(makeLegacyPptBuffer()),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { pptCode?: string; reason?: string } | undefined;
      return d?.pptCode === 'PPT_PARSE_ERROR' && d?.reason === 'legacy-ppt';
    },
  );
});

test('B4. parsePpt — 암호 걸린 PPTX(라이브러리 encrypted 메시지) 는 PPT_PARSE_ERROR + encrypted', async () => {
  const driver: PptParseDriver = {
    id: 'encrypted',
    async parse() { throw new Error('File is encrypted'); },
  };
  await assert.rejects(
    parsePpt(makePptxBuffer(), { parseDriver: driver }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { pptCode?: string; reason?: string } | undefined;
      return d?.pptCode === 'PPT_PARSE_ERROR' && d?.reason === 'encrypted';
    },
  );
});

test('B5. parsePpt — 일반 예외는 PPT_PARSE_ERROR(cause 보존)', async () => {
  const cause = new Error('deflate crash');
  const driver: PptParseDriver = { id: 'crash', async parse() { throw cause; } };
  await assert.rejects(
    parsePpt(makePptxBuffer(), { parseDriver: driver }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { pptCode?: string; reason?: string } | undefined;
      return d?.pptCode === 'PPT_PARSE_ERROR' && !d?.reason && err.cause === cause;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// C. 빈 프레젠테이션 · maxSlides
// ────────────────────────────────────────────────────────────────────────────

test('C1. parsePpt — 빈 프레젠테이션은 empty-presentation + partial(slides:[])', async () => {
  await assert.rejects(
    parsePpt(makePptxBuffer(), {
      parseDriver: fakeParseDriver({
        slides: [],
        metadata: { slideCount: 0, parserId: 'fake', durationMs: 0 },
      }),
    }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { reason?: string; partial?: { slides: unknown[] } } | undefined;
      return d?.reason === 'empty-presentation' && Array.isArray(d?.partial?.slides) && d.partial!.slides.length === 0;
    },
  );
});

test('C2. parsePpt — maxSlides 초과는 too-many-slides 로 실패하되 partial 에 잘린 배열 보존', async () => {
  const slides = Array.from({ length: 120 }, (_, i) => makeSlide(i + 1));
  await assert.rejects(
    parsePpt(makePptxBuffer(), {
      parseDriver: fakeParseDriver({
        slides,
        metadata: { slideCount: 120, parserId: 'fake', durationMs: 0 },
      }),
      maxSlides: 100,
    }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { reason?: string; partial?: { slides: unknown[] } } | undefined;
      return d?.reason === 'too-many-slides' && d?.partial?.slides.length === 100;
    },
  );
});

test('C3. parsePpt — FILE_TOO_LARGE 는 driver 호출 전에 실패(slides 0 호출)', async () => {
  let calls = 0;
  const big = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048)]);
  await assert.rejects(
    parsePpt(big, {
      parseDriver: {
        id: 'never',
        async parse() { calls += 1; return { slides: [], metadata: { slideCount: 0, parserId: 'never', durationMs: 0 } }; },
      },
      maxBytes: 256,
    }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'FILE_TOO_LARGE',
  );
  assert.equal(calls, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// D. RTL · 100 슬라이드 입력
// ────────────────────────────────────────────────────────────────────────────

test('D1. parsePpt — RTL 플래그가 driver 에서 그대로 전달된다', async () => {
  const rtlSlide = makeSlide(1, { body: 'مرحبا', rtl: true });
  const res = await parsePpt(makePptxBuffer(), {
    parseDriver: fakeParseDriver({
      slides: [rtlSlide],
      metadata: { slideCount: 1, parserId: 'fake', durationMs: 0 },
    }),
  });
  assert.equal(res.slides[0].rtl, true);
  assert.equal(res.slides[0].body, 'مرحبا');
});

test('D2. parsePpt — 정확히 100 슬라이드(경계) 는 통과', async () => {
  const slides = Array.from({ length: 100 }, (_, i) => makeSlide(i + 1));
  const res = await parsePpt(makePptxBuffer(), {
    parseDriver: fakeParseDriver({
      slides,
      metadata: { slideCount: 100, parserId: 'fake', durationMs: 0 },
    }),
    maxSlides: 100,
  });
  assert.equal(res.slides.length, 100);
  assert.equal(res.metadata.slideCount, 100);
});

// ────────────────────────────────────────────────────────────────────────────
// E. generatePpt
// ────────────────────────────────────────────────────────────────────────────

test('E1. generatePpt — slides 누락은 INPUT_INVALID', async () => {
  await assert.rejects(
    generatePpt({} as unknown as DeckTree),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'INPUT_INVALID',
  );
});

test('E2. generatePpt — 빈 slides 배열은 INPUT_INVALID + reason=empty-deck', async () => {
  await assert.rejects(
    generatePpt({ slides: [] }, { generateDriver: fakeGenerateDriver() }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { reason?: string; pptCode?: string } | undefined;
      return err.code === 'INPUT_INVALID' && d?.reason === 'empty-deck' && d?.pptCode === 'PPT_GEN_ERROR';
    },
  );
});

test('E3. generatePpt — DeckTree 와 embedKoreanFonts 플래그가 driver 로 전달', async () => {
  const gen = fakeGenerateDriver();
  const deck: DeckTree = {
    title: '리포트',
    author: 'Joker',
    embedKoreanFonts: true,
    slides: [
      { layout: 'title', nodes: [{ kind: 'title', text: '표지', subtitle: '부제' }] },
      {
        layout: 'title-content',
        nodes: [
          { kind: 'bullets', title: '요약', items: ['한글 1', '한글 2'] },
          { kind: 'notes', text: '발표 노트' },
        ],
      },
    ],
  };
  const out = await generatePpt(deck, { generateDriver: gen });
  assert.ok(out instanceof Uint8Array);
  assert.equal(gen.lastCall.deck?.embedKoreanFonts, true);
  assert.equal(gen.lastCall.deck?.slides.length, 2);
  assert.equal(gen.lastCall.deck?.slides[0].nodes[0].kind, 'title');
});

test('E4. generatePpt — driver 실패는 PPT_GEN_ERROR 로 번역', async () => {
  const gen: PptGenerateDriver = {
    id: 'broken',
    async generate() { throw new Error('disk full'); },
  };
  await assert.rejects(
    generatePpt({ slides: [{ nodes: [] }] }, { generateDriver: gen }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const d = err.details as { pptCode?: string } | undefined;
      return d?.pptCode === 'PPT_GEN_ERROR';
    },
  );
});

test('E5. generatePpt — 사전 abort 신호는 ABORTED', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    generatePpt({ slides: [{ nodes: [] }] }, { generateDriver: fakeGenerateDriver(), signal: ctrl.signal }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'ABORTED',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// F. PptAdapter.invoke · canHandle
// ────────────────────────────────────────────────────────────────────────────

test('F1. PptAdapter.invoke — 파싱 결과를 MediaAdapterOutcome 으로 래핑 + phase 전이', async () => {
  const adapter = new PptAdapter(DEFAULT_ADAPTER_CONFIG, {
    parseDriver: fakeParseDriver({
      slides: [makeSlide(1), makeSlide(2)],
      metadata: { slideCount: 2, parserId: 'fake', durationMs: 1 },
    }),
  });
  const phases: string[] = [];
  const out = await adapter.invoke({
    input: { source: makePptxBuffer(), mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    onProgress: (p) => phases.push(p.phase),
  });
  assert.equal(out.adapterId, PPT_ADAPTER_ID);
  assert.equal(out.result.slideCount, 2);
  assert.match(out.result.text, /슬라이드 1/);
  assert.equal(phases[0], 'precheck');
  assert.equal(phases[phases.length - 1], 'finalize');
  assert.ok(phases.includes('upload'));
});

test('F2. PptAdapter.canHandle — 레거시 .ppt 확장자/MIME 은 거절', () => {
  const adapter = new PptAdapter(DEFAULT_ADAPTER_CONFIG);
  assert.equal(adapter.canHandle({ source: 'x.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), true);
  assert.equal(adapter.canHandle({ source: 'x.ppt', mimeType: 'application/vnd.ms-powerpoint' }), false, '레거시 MIME 거절');
  assert.equal(adapter.canHandle({ source: 'x.ppt' }), false, '확장자만으로도 레거시 거절');
  assert.equal(adapter.canHandle({ source: 'x.pdf', mimeType: 'application/pdf' }), false, '다른 MIME 거절');
});

test('F3. PptAdapter.canHandle — 크기 초과 거절', () => {
  const adapter = new PptAdapter({ ...DEFAULT_ADAPTER_CONFIG, maxBytes: 1024 });
  assert.equal(
    adapter.canHandle({ source: 'x.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sizeBytes: 2048 }),
    false,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// G. 레지스트리 등록 경로
// ────────────────────────────────────────────────────────────────────────────

test('G1. createDefaultRegistry — resolveByKind("pptx") 가 실구현(priority=-10) 을 돌려준다', () => {
  const reg = createDefaultRegistry();
  const adapter = reg.resolveByKind('pptx');
  assert.equal(adapter.descriptor.id, PPT_ADAPTER_ID);
  assert.equal(adapter.descriptor.priority, -10);
  assert.equal(adapter.descriptor.displayName, 'PPTX 어댑터(실구현)');
});

test('G2. createRealPptAdapter 팩토리 — descriptor 가 pptx 에 한정', () => {
  const a = createRealPptAdapter(DEFAULT_ADAPTER_CONFIG);
  assert.equal(a.descriptor.kind, 'pptx');
  assert.equal(a.descriptor.supportedInputMimes[0], 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(a.descriptor.capabilities.canParse, true);
  assert.equal(a.descriptor.capabilities.canGenerate, true);
});
