// Run with: npx tsx --test tests/mediaProcessor.unit.test.ts
//
// 단위 테스트: src/server/mediaProcessor.ts — 지시 #f6052a91 의 1차 스켈레톤 계약.
//
// 네 축을 잠근다:
//   1) inferMediaKind — 확장자/MIME 로 4종 MediaKind 를 분류하고, 미지는 null.
//   2) defaultPptParser — 아직 어댑터가 없으므로 NotImplementedMediaError 를 던진다.
//   3) createMediaProcessor — 이미지/영상은 파싱 없이 kind 만 반환, PPT 는 스텁 전파.
//   4) VideoGenAdapter 레지스트리 — register/get/reset 의 기본 동작.
//
// 본 테스트는 실제 pdf-parse 를 타지 않도록 PDF 어댑터를 주입 가능한 형태로만 확인한다
// (overrides.pdf 를 모의 함수로 주입). CI 에서 native canvas/pdfjs 를 건드리지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferMediaKind,
  createMediaProcessor,
  defaultPptParser,
  NotImplementedMediaError,
  registerVideoGenAdapter,
  getVideoGenAdapter,
  resetVideoGenAdapter,
  type PdfParser,
  type VideoGenAdapter,
} from '../src/server/mediaProcessor.ts';

// ─── inferMediaKind ──────────────────────────────────────────────────────────

test('inferMediaKind — 확장자만으로 4종을 분류한다', () => {
  assert.equal(inferMediaKind('report.pdf'), 'pdf');
  assert.equal(inferMediaKind('slides.pptx'), 'pptx');
  assert.equal(inferMediaKind('legacy.ppt'), 'pptx');
  assert.equal(inferMediaKind('intro.mp4'), 'video');
  assert.equal(inferMediaKind('poster.png'), 'image');
});

test('inferMediaKind — MIME 이 이미지/영상/PDF 접두면 확장자 불일치라도 승격한다', () => {
  // 확장자가 비어 있어도 MIME 만으로 분류 가능해야 한다(업로더가 임의 이름을 썼을 때).
  assert.equal(inferMediaKind('blob', 'application/pdf'), 'pdf');
  assert.equal(inferMediaKind('blob', 'video/mp4'), 'video');
  assert.equal(inferMediaKind('blob', 'image/png'), 'image');
  assert.equal(
    inferMediaKind('blob',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    'pptx',
  );
});

test('inferMediaKind — 인식 불가는 null', () => {
  assert.equal(inferMediaKind('archive.tar.gz'), null);
  assert.equal(inferMediaKind('note'), null);
  assert.equal(inferMediaKind('', 'application/octet-stream'), null);
});

// ─── createMediaProcessor — overrides 주입 가능 ──────────────────────────────

test('createMediaProcessor — PDF 는 주입 어댑터로 라우팅된다', async () => {
  const calls: string[] = [];
  const fakePdf: PdfParser = {
    id: 'test-pdf',
    async parse({ name }) {
      calls.push(name);
      return { kind: 'pdf', extractedText: '모의 본문', pageCount: 1 };
    },
  };
  const mp = createMediaProcessor({ pdf: fakePdf });
  const r = await mp.parse({ buffer: Buffer.from(''), name: 'a.pdf', mimeType: 'application/pdf' });
  assert.equal(r.kind, 'pdf');
  assert.equal(r.extractedText, '모의 본문');
  assert.equal(r.pageCount, 1);
  assert.deepEqual(calls, ['a.pdf']);
});

test('createMediaProcessor — 이미지/영상은 파싱을 건너뛰고 kind 만 돌려준다', async () => {
  const mp = createMediaProcessor();
  const img = await mp.parse({ buffer: Buffer.from(''), name: 'p.png' });
  const vid = await mp.parse({ buffer: Buffer.from(''), name: 'c.mp4' });
  assert.equal(img.kind, 'image');
  assert.equal(vid.kind, 'video');
  assert.equal(img.extractedText, undefined);
  assert.equal(vid.extractedText, undefined);
});

test('createMediaProcessor — 알 수 없는 형식은 NotImplementedMediaError(kind="unknown")', async () => {
  const mp = createMediaProcessor();
  await assert.rejects(
    () => mp.parse({ buffer: Buffer.from(''), name: 'archive.tar.gz' }),
    (e: unknown) => e instanceof NotImplementedMediaError && (e as NotImplementedMediaError).kind === 'unknown',
  );
});

test('createMediaProcessor — PPT 기본 어댑터는 미구현 에러를 던진다(지시 #f6052a91 1차 스텁)', async () => {
  const mp = createMediaProcessor();
  await assert.rejects(
    () => mp.parse({ buffer: Buffer.from(''), name: 's.pptx' }),
    (e: unknown) => e instanceof NotImplementedMediaError && (e as NotImplementedMediaError).kind === 'pptx',
  );
});

test('defaultPptParser — id 가 "stub" 이고 parse 는 NotImplementedMediaError', async () => {
  assert.equal(defaultPptParser.id, 'stub');
  await assert.rejects(
    () => defaultPptParser.parse({ buffer: Buffer.from(''), name: 's.pptx' }),
    (e: unknown) => e instanceof NotImplementedMediaError,
  );
});

// ─── VideoGenAdapter 레지스트리 ─────────────────────────────────────────────

test('registerVideoGenAdapter — register/get/reset 의 기본 동작', () => {
  resetVideoGenAdapter();
  assert.equal(getVideoGenAdapter(), null);

  const fake: VideoGenAdapter = {
    id: 'fake',
    async generate({ projectId, prompt }) {
      return {
        id: 'gen-1', projectId, kind: 'video', name: 'gen.mp4',
        mimeType: 'video/mp4', sizeBytes: 0, createdAt: new Date().toISOString(),
        generatedBy: { adapter: 'fake', prompt },
      };
    },
  };
  registerVideoGenAdapter(fake);
  assert.equal(getVideoGenAdapter(), fake);

  registerVideoGenAdapter(null);
  assert.equal(getVideoGenAdapter(), null);
});

test('VideoGenAdapter — generate 호출 시 MediaAsset 모양을 유지한다', async () => {
  resetVideoGenAdapter();
  const fake: VideoGenAdapter = {
    id: 'fake',
    async generate({ projectId, prompt }) {
      return {
        id: 'v1', projectId, kind: 'video', name: 'g.mp4',
        mimeType: 'video/mp4', sizeBytes: 0, createdAt: '2026-04-19T00:00:00.000Z',
        generatedBy: { adapter: 'fake', prompt },
      };
    },
  };
  registerVideoGenAdapter(fake);
  const adapter = getVideoGenAdapter();
  assert.ok(adapter);
  const out = await adapter!.generate({ projectId: 'p1', prompt: '짧은 소개 영상' });
  assert.equal(out.kind, 'video');
  assert.equal(out.generatedBy?.adapter, 'fake');
  assert.equal(out.generatedBy?.prompt, '짧은 소개 영상');
  resetVideoGenAdapter();
});
