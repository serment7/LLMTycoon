// Run with: npx tsx --test src/services/multimedia/adapters/__tests__/PdfAdapter.spec.ts
//
// 지시 #aeabbd49 · PdfAdapter 실제 구현 단위 테스트.
//
// 실제 pdf-parse / pdf-lib 라이브러리는 느리고 플랫폼 의존적이므로, 본 스펙은 driver
// 주입 훅(PdfParseDriver · PdfGenerateDriver) 을 이용해 파싱·생성 결과를 결정론적으로
// 고정한다. 실제 라이브러리 경로는 smoke 수준으로 1건만(동적 import 성공 여부) 확인.
//
// 테스트 축
//   A. parsePdf — 정상 파일(매직·페이지 분리·메타 반환), 진행률, 취소
//   B. parsePdf — 손상 파일(매직 불일치) · 암호 걸린 PDF(라이브러리 예외 번역)
//   C. parsePdf — 대용량 경계(>50MB 초과 즉시 FILE_TOO_LARGE)
//   D. generatePdf — 섹션/표/이미지/페이지 번호 요청이 driver 로 그대로 흘러간다
//   E. PdfAdapter.invoke — MediaAdapter 계약 대로 MediaAdapterOutcome 반환 + 진행률 bridge
//   F. MultimediaRegistry — createDefaultRegistry 가 실구현(priority=-10) 을 우선 선택

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MediaAdapterError,
  createDefaultRegistry,
} from '../../index.ts';
import {
  PdfAdapter,
  parsePdf,
  generatePdf,
  createRealPdfAdapter,
  PDF_ADAPTER_ID,
  type PdfParseDriver,
  type PdfGenerateDriver,
  type DocumentTree,
} from '../PdfAdapter.ts';
import { DEFAULT_ADAPTER_CONFIG } from '../../types.ts';

// ────────────────────────────────────────────────────────────────────────────
// 공통 유틸 — 매직 바이트 + 실험용 driver
// ────────────────────────────────────────────────────────────────────────────

function makePdfBuffer(body = 'page 1\fpage 2\fpage 3'): Buffer {
  // 진짜 PDF 는 아니지만, 매직 바이트만 통과하면 driver 가 파싱을 맡는다.
  const magic = Buffer.from('%PDF-1.7\n');
  const payload = Buffer.from(body, 'utf8');
  return Buffer.concat([magic, payload]);
}

function fakeParseDriver(override: Partial<PdfParseDriver['parse']> | null = null): PdfParseDriver {
  return {
    id: 'fake',
    async parse({ buffer, signal, onProgress }) {
      if (override && typeof override === 'function') {
        return (override as unknown as PdfParseDriver['parse'])({ buffer, signal, onProgress });
      }
      onProgress?.(0.5);
      return {
        pages: [
          { index: 1, text: 'page 1' },
          { index: 2, text: 'page 2' },
          { index: 3, text: 'page 3' },
        ],
        metadata: { pageCount: 3, parserId: 'fake', durationMs: 1 },
      };
    },
  };
}

function fakeGenerateDriver(bytes = Buffer.from('%PDF-1.7\nFAKE')): PdfGenerateDriver {
  let lastCall: { doc: DocumentTree | null } = { doc: null };
  const driver: PdfGenerateDriver & { lastCall: typeof lastCall } = {
    id: 'fake-gen',
    lastCall,
    async generate({ doc, onProgress }) {
      lastCall.doc = doc;
      onProgress?.(0.5);
      return new Uint8Array(bytes);
    },
  };
  return driver;
}

// ────────────────────────────────────────────────────────────────────────────
// A. parsePdf — 정상
// ────────────────────────────────────────────────────────────────────────────

test('A1. parsePdf — Buffer 입력, fake driver 결과가 그대로 반환된다', async () => {
  const progress: number[] = [];
  const result = await parsePdf(makePdfBuffer(), {
    parseDriver: fakeParseDriver(),
    onProgress: (r) => progress.push(r),
  });
  assert.equal(result.pages.length, 3);
  assert.deepEqual(result.pages.map((p) => p.text), ['page 1', 'page 2', 'page 3']);
  assert.equal(result.metadata.parserId, 'fake');
  // 최소 한 번은 진행률 콜백이 울려야 하고 마지막은 1.
  assert.ok(progress.length >= 2);
  assert.equal(progress[progress.length - 1], 1);
});

test('A2. parsePdf — AbortSignal 이 이미 abort 상태면 즉시 ABORTED 로 실패', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    parsePdf(makePdfBuffer(), { parseDriver: fakeParseDriver(), signal: ctrl.signal }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'ABORTED',
  );
});

test('A3. parsePdf — driver 가 AbortError 를 던지면 ABORTED 로 번역', async () => {
  const driver: PdfParseDriver = {
    id: 'abort-driver',
    async parse() {
      const err = new Error('aborted');
      (err as { name?: string }).name = 'AbortError';
      throw err;
    },
  };
  await assert.rejects(
    parsePdf(makePdfBuffer(), { parseDriver: driver }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'ABORTED',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// B. 손상 · 암호
// ────────────────────────────────────────────────────────────────────────────

test('B1. parsePdf — 매직 바이트 없음은 PDF_PARSE_ERROR(reason=bad-magic)', async () => {
  await assert.rejects(
    parsePdf(Buffer.from('NOTPDF'), { parseDriver: fakeParseDriver() }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const details = err.details as { pdfCode?: string; reason?: string } | undefined;
      return details?.pdfCode === 'PDF_PARSE_ERROR' && details?.reason === 'bad-magic';
    },
  );
});

test('B2. parsePdf — 빈/짧은 파일은 PDF_PARSE_ERROR(reason=missing-magic)', async () => {
  await assert.rejects(
    parsePdf(Buffer.from(''), { parseDriver: fakeParseDriver() }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const details = err.details as { reason?: string } | undefined;
      return details?.reason === 'missing-magic';
    },
  );
});

test('B3. parsePdf — 암호 걸린 PDF(라이브러리가 encrypted 메시지 throw) 는 PDF_PARSE_ERROR + reason=encrypted', async () => {
  const driver: PdfParseDriver = {
    id: 'encrypted-driver',
    async parse() {
      throw new Error('File is encrypted');
    },
  };
  await assert.rejects(
    parsePdf(makePdfBuffer(), { parseDriver: driver }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const details = err.details as { pdfCode?: string; reason?: string } | undefined;
      return details?.pdfCode === 'PDF_PARSE_ERROR' && details?.reason === 'encrypted';
    },
  );
});

test('B4. parsePdf — 일반 라이브러리 예외는 PDF_PARSE_ERROR(reason 없음, cause 보존)', async () => {
  const underlying = new Error('some internal crash');
  const driver: PdfParseDriver = {
    id: 'crash-driver',
    async parse() { throw underlying; },
  };
  await assert.rejects(
    parsePdf(makePdfBuffer(), { parseDriver: driver }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const details = err.details as { pdfCode?: string; reason?: string } | undefined;
      return details?.pdfCode === 'PDF_PARSE_ERROR' && !details?.reason && err.cause === underlying;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// C. 대용량 경계
// ────────────────────────────────────────────────────────────────────────────

test('C1. parsePdf — maxBytes 초과 시 FILE_TOO_LARGE 즉시 실패(driver 호출 전)', async () => {
  let driverCalls = 0;
  const driver: PdfParseDriver = {
    id: 'never',
    async parse() { driverCalls += 1; return { pages: [], metadata: { pageCount: 0, parserId: 'never', durationMs: 0 } }; },
  };
  const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200)]);
  await assert.rejects(
    parsePdf(big, { parseDriver: driver, maxBytes: 20 }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'FILE_TOO_LARGE',
  );
  assert.equal(driverCalls, 0, 'maxBytes 검사 후 driver 는 호출되지 않아야 한다');
});

test('C2. parsePdf — maxBytes=0 이면 무제한(대용량도 통과)', async () => {
  const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200)]);
  const out = await parsePdf(big, { parseDriver: fakeParseDriver(), maxBytes: 0 });
  assert.equal(out.metadata.parserId, 'fake');
});

// ────────────────────────────────────────────────────────────────────────────
// D. generatePdf — DocumentTree 가 driver 로 전달된다
// ────────────────────────────────────────────────────────────────────────────

test('D1. generatePdf — sections 누락이면 INPUT_INVALID', async () => {
  await assert.rejects(
    generatePdf({} as unknown as DocumentTree),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'INPUT_INVALID',
  );
});

test('D2. generatePdf — fake driver 가 DocumentTree 를 받아 Uint8Array 를 돌려준다', async () => {
  const gen = fakeGenerateDriver(Buffer.from('%PDF-1.7\nFAKE-OUT'));
  const doc: DocumentTree = {
    title: '리포트',
    author: 'Joker',
    sections: [
      {
        title: '요약',
        nodes: [
          { kind: 'paragraph', text: '본문' },
          { kind: 'table', header: ['a', 'b'], rows: [['1', '2']] },
        ],
      },
      { nodes: [{ kind: 'pageBreak' }] },
    ],
    pageNumbers: true,
  };
  const progress: number[] = [];
  const out = await generatePdf(doc, { generateDriver: gen, onProgress: (r) => progress.push(r) });
  assert.ok(out instanceof Uint8Array);
  // 브라우저 호환을 위해 Buffer → Uint8Array 로 전환했으므로(커밋 b2fdfe8) 디코딩은
  // TextDecoder 를 사용한다. Uint8Array.toString('utf8') 는 인자를 무시하고 쉼표
  // 구분 숫자열을 돌려주기 때문에 과거 방식은 'FAKE-OUT' 을 찾지 못한다.
  assert.ok(new TextDecoder('utf-8').decode(out).includes('FAKE-OUT'));
  const inspector = gen as unknown as { lastCall: { doc: DocumentTree } };
  assert.equal(inspector.lastCall.doc.title, '리포트');
  assert.equal(inspector.lastCall.doc.sections.length, 2);
  assert.equal(progress[progress.length - 1], 1);
});

test('D3. generatePdf — driver 실패는 PDF_GEN_ERROR 로 번역', async () => {
  const gen: PdfGenerateDriver = {
    id: 'broken-gen',
    async generate() { throw new Error('disk full'); },
  };
  await assert.rejects(
    generatePdf({ sections: [] }, { generateDriver: gen }),
    (err: unknown) => {
      if (!(err instanceof MediaAdapterError)) return false;
      const details = err.details as { pdfCode?: string } | undefined;
      return details?.pdfCode === 'PDF_GEN_ERROR';
    },
  );
});

test('D4. generatePdf — 이미 abort 된 signal 은 즉시 ABORTED', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    generatePdf({ sections: [] }, { generateDriver: fakeGenerateDriver(), signal: ctrl.signal }),
    (err: unknown) => err instanceof MediaAdapterError && err.code === 'ABORTED',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// E. PdfAdapter.invoke — MediaAdapter 계약
// ────────────────────────────────────────────────────────────────────────────

test('E1. PdfAdapter.invoke — 파싱 결과를 MediaAdapterOutcome 으로 래핑', async () => {
  const adapter = new PdfAdapter(DEFAULT_ADAPTER_CONFIG, { parseDriver: fakeParseDriver() });
  const progressPhases: string[] = [];
  const outcome = await adapter.invoke({
    input: { source: makePdfBuffer(), mimeType: 'application/pdf' },
    onProgress: (p) => progressPhases.push(p.phase),
  });
  assert.equal(outcome.adapterId, PDF_ADAPTER_ID);
  assert.equal(outcome.result.pageCount, 3);
  assert.match(outcome.result.text, /page 1/);
  assert.ok(outcome.finishedAtMs >= outcome.startedAtMs);
  // 진행률 bridge 는 precheck → upload* → finalize 순서.
  assert.equal(progressPhases[0], 'precheck');
  assert.equal(progressPhases[progressPhases.length - 1], 'finalize');
  assert.ok(progressPhases.includes('upload'));
});

test('E2. PdfAdapter.canHandle — MIME 불일치/크기 초과 거절', () => {
  const adapter = new PdfAdapter({ ...DEFAULT_ADAPTER_CONFIG, maxBytes: 1000 });
  assert.equal(adapter.canHandle({ source: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 100 }), true);
  assert.equal(adapter.canHandle({ source: 'x.pdf', mimeType: 'image/png' }), false);
  assert.equal(
    adapter.canHandle({ source: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 5000 }),
    false,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// F. 레지스트리 등록 경로
// ────────────────────────────────────────────────────────────────────────────

test('F1. createDefaultRegistry — resolveByKind("pdf") 가 실구현(priority=-10) 을 돌려준다', () => {
  const reg = createDefaultRegistry();
  const adapter = reg.resolveByKind('pdf');
  assert.equal(adapter.descriptor.id, PDF_ADAPTER_ID);
  assert.equal(adapter.descriptor.priority, -10);
  assert.equal(adapter.descriptor.displayName, 'PDF 어댑터(실구현)');
  assert.equal(adapter.descriptor.supportedInputMimes[0], 'application/pdf');
});

test('F2. createRealPdfAdapter 팩토리 — DEFAULT_ADAPTER_CONFIG 주입 시 descriptor 가 PDF 에 한정', () => {
  const a = createRealPdfAdapter(DEFAULT_ADAPTER_CONFIG);
  assert.equal(a.descriptor.kind, 'pdf');
  assert.ok(a.descriptor.supportedInputMimes.includes('application/pdf'));
  assert.equal(a.descriptor.capabilities.canParse, true);
  assert.equal(a.descriptor.capabilities.canGenerate, true);
});
