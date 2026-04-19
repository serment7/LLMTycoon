// Run with: npx tsx --test tests/unit/multimedia/pdfImportService.spec.ts
//
// 지시 #c82b4df9 — PDF import 서비스의 계약 테스트.
// pdfjs-dist 의존은 stub MultimediaHandler 주입으로 끊고, 저장소는 메모리 어댑터로
// 치환해 Node 단독으로 전체 경로(원본 저장 + 사이드카 저장 + 진행률 중계 + 에러 코드)를
// 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProjectFileStore,
  createMemoryProjectFileStorage,
} from '../../../src/store/projectFiles.ts';
import { createPdfImportService } from '../../../src/lib/multimedia/pdfImportService.ts';
import {
  MultimediaImportError,
  type MultimediaExtractionResult,
  type MultimediaHandler,
  type MultimediaParseOptions,
  type MultimediaProgressEvent,
} from '../../../src/lib/multimedia/types.ts';

function stubHandler(result: Partial<MultimediaExtractionResult> & { text: string }): MultimediaHandler {
  return {
    id: 'pdf',
    accept: '.pdf,application/pdf',
    maxBytes: 50 * 1024 * 1024,
    async parse(input, opts): Promise<MultimediaExtractionResult> {
      opts?.onProgress?.({ phase: 'open', current: 0, total: input.size });
      opts?.onProgress?.({ phase: 'parse', current: 1, total: 1 });
      return {
        text: result.text,
        sizeBytes: input.size,
        metadata: result.metadata ?? { pageCount: 1 },
      };
    },
  };
}

function makePdf(name: string, content: string, size?: number): File {
  const blob = new Blob([content], { type: 'application/pdf' });
  const file = new File([blob], name, { type: 'application/pdf' });
  if (typeof size === 'number') {
    Object.defineProperty(file, 'size', { value: size });
  }
  return file;
}

test('importPdf — 원본 PDF + 추출 텍스트 사이드카가 같은 프로젝트에 저장된다', async () => {
  const store = createProjectFileStore({ adapter: createMemoryProjectFileStorage(), now: () => 1000 });
  const service = createPdfImportService({ store, parser: stubHandler({ text: '안녕 세계' }) });
  const outcome = await service.importPdf({ projectId: 'proj-A', file: makePdf('doc.pdf', 'dummy') });

  assert.equal(outcome.originalRecord.projectId, 'proj-A');
  assert.equal(outcome.originalRecord.category, 'pdf');
  assert.equal(outcome.originalRecord.name, 'doc.pdf');
  assert.ok(outcome.extractedTextRecord, '사이드카가 생성되어야 한다');
  assert.equal(outcome.extractedTextRecord!.name, 'doc.extracted.txt');
  assert.equal(outcome.extractedTextRecord!.category, 'etc');
  assert.equal(outcome.result.text, '안녕 세계');

  const files = await store.list('proj-A');
  assert.equal(files.length, 2, '원본 + 사이드카 총 2개');
});

test('importPdf — 추출 텍스트가 비어 있으면 사이드카를 저장하지 않는다', async () => {
  const store = createProjectFileStore({ adapter: createMemoryProjectFileStorage(), now: () => 1000 });
  const service = createPdfImportService({ store, parser: stubHandler({ text: '' }) });
  const outcome = await service.importPdf({ projectId: 'proj-B', file: makePdf('scan.pdf', 'dummy') });

  assert.equal(outcome.extractedTextRecord, null, '사이드카가 null 이어야 한다');
  const files = await store.list('proj-B');
  assert.equal(files.length, 1, '원본만 저장');
  assert.equal(files[0].name, 'scan.pdf');
});

test('importPdf — 용량 상한 초과 시 MULTIMEDIA_FILE_TOO_LARGE 로 거절', async () => {
  const store = createProjectFileStore({ adapter: createMemoryProjectFileStorage(), now: () => 1000 });
  const parser: MultimediaHandler = { ...stubHandler({ text: 'x' }), maxBytes: 100 };
  const service = createPdfImportService({ store, parser });
  const tooBig = makePdf('big.pdf', 'x', 500);
  await assert.rejects(
    () => service.importPdf({ projectId: 'proj-C', file: tooBig }),
    (err: unknown) => err instanceof MultimediaImportError && err.code === 'MULTIMEDIA_FILE_TOO_LARGE',
  );
  const files = await store.list('proj-C');
  assert.equal(files.length, 0, '거절된 import 는 저장소를 건드리지 않는다');
});

test('importPdf — 진행률은 parser 단계 → persist → finalize 순으로 관찰된다', async () => {
  const store = createProjectFileStore({ adapter: createMemoryProjectFileStorage(), now: () => 1000 });
  const service = createPdfImportService({ store, parser: stubHandler({ text: 'body' }) });
  const events: MultimediaProgressEvent[] = [];
  await service.importPdf({
    projectId: 'proj-D',
    file: makePdf('p.pdf', 'dummy'),
    onProgress: (ev) => events.push(ev),
  });
  const phases = events.map((e) => e.phase);
  // stub handler 는 open/parse 를 내보내고, 서비스가 persist 3회 + finalize 를 추가한다.
  assert.deepEqual(phases.slice(0, 2), ['open', 'parse']);
  assert.ok(phases.includes('persist'), 'persist 이벤트가 있어야 한다');
  assert.equal(phases[phases.length - 1], 'finalize');
});

test('importPdf — parser 가 MULTIMEDIA_UNSUPPORTED_FORMAT 를 던지면 저장소에 아무 것도 남지 않는다', async () => {
  const store = createProjectFileStore({ adapter: createMemoryProjectFileStorage(), now: () => 1000 });
  const throwingParser: MultimediaHandler = {
    id: 'pdf',
    accept: '.pdf',
    maxBytes: 1_000_000,
    async parse(): Promise<MultimediaExtractionResult> {
      throw new MultimediaImportError('MULTIMEDIA_UNSUPPORTED_FORMAT', '매직 바이트 없음');
    },
  };
  const service = createPdfImportService({ store, parser: throwingParser });
  await assert.rejects(
    () => service.importPdf({ projectId: 'proj-E', file: makePdf('bad.pdf', 'not-pdf') }),
    (err: unknown) => err instanceof MultimediaImportError && err.code === 'MULTIMEDIA_UNSUPPORTED_FORMAT',
  );
  assert.equal((await store.list('proj-E')).length, 0);
});

test('importPdf — 이미 abort 된 signal 이면 parser 호출 없이 즉시 거절', async () => {
  const store = createProjectFileStore({ adapter: createMemoryProjectFileStorage(), now: () => 1000 });
  let parseCalls = 0;
  const parser: MultimediaHandler = {
    ...stubHandler({ text: 't' }),
    async parse(input, opts?: MultimediaParseOptions): Promise<MultimediaExtractionResult> {
      parseCalls += 1;
      return { text: 't', sizeBytes: input.size, metadata: {} };
    },
  };
  const service = createPdfImportService({ store, parser });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => service.importPdf({ projectId: 'proj-F', file: makePdf('a.pdf', 'dummy'), signal: controller.signal }),
    (err: unknown) => err instanceof MultimediaImportError && err.code === 'MULTIMEDIA_PARSE_ABORTED',
  );
  assert.equal(parseCalls, 0, 'abort 된 signal 은 parser 호출을 건너뛴다');
});

test('importPdf — projectId 가 비어 있으면 즉시 거절', async () => {
  const store = createProjectFileStore({ adapter: createMemoryProjectFileStorage(), now: () => 1000 });
  const service = createPdfImportService({ store, parser: stubHandler({ text: 't' }) });
  await assert.rejects(
    () => service.importPdf({ projectId: '', file: makePdf('a.pdf', 'dummy') }),
    (err: unknown) => err instanceof MultimediaImportError,
  );
});

test('service.accept / maxBytes 는 주입된 parser 의 값을 그대로 노출', () => {
  const parser: MultimediaHandler = { ...stubHandler({ text: '' }), accept: '.pdf', maxBytes: 12345 };
  const service = createPdfImportService({
    store: createProjectFileStore({ adapter: createMemoryProjectFileStorage() }),
    parser,
  });
  assert.equal(service.accept, '.pdf');
  assert.equal(service.maxBytes, 12345);
});
