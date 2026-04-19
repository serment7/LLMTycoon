// Run with: npx tsx --test tests/mediaProcessor.regression.test.ts
//
// QA 1차 회귀(#154cb987) — 멀티미디어 처리 기반 `src/server/mediaProcessor.ts`.
//
// 본 파일은 지시 본문의 표현을 실제 구현에 맞춰 조정했다:
//   · 에러 클래스 이름은 `MediaProcessorError` 가 아닌 **`NotImplementedMediaError`**
//     (src/server/mediaProcessor.ts line 61~68). 분류 단서는 `.kind` 필드.
//   · PPT 파서는 현재 **스텁(stub) 상태**라 파싱 시 즉시 NotImplementedMediaError 를
//     던진다. 따라서 "슬라이드 수·텍스트 추출 스냅샷" 대신 "스텁이 정확한 kind
//     라벨로 즉시 거부한다" 를 계약으로 잠근다(라이브러리 설치 전 회귀 안전망).
//   · PDF 비밀번호 보호 파일은 현재 테스트 환경에서 실파일을 합성하기 어렵다 —
//     `pdf-parse` 가 빈/손상 입력을 거부할 때 **래핑된 NotImplementedMediaError
//     ('pdf', ...)** 로 수렴한다는 계약만 잠근다. 실제 암호 PDF 샘플이 도입되면
//     같은 어설션이 그대로 재사용 가능하다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NotImplementedMediaError,
  createMediaProcessor,
  defaultPdfParser,
  defaultPptParser,
  inferMediaKind,
  getVideoGenAdapter,
  registerVideoGenAdapter,
  resetVideoGenAdapter,
  type PdfParser,
  type VideoGenAdapter,
} from '../src/server/mediaProcessor.ts';

// ────────────────────────────────────────────────────────────────────────────
// inferMediaKind — 확장자 우선 + MIME 보정 4종 판정
// ────────────────────────────────────────────────────────────────────────────

test('inferMediaKind — PDF 는 확장자 또는 MIME 만으로 pdf 로 판정된다', () => {
  assert.equal(inferMediaKind('spec.pdf'), 'pdf');
  assert.equal(inferMediaKind('임의이름', 'application/pdf'), 'pdf');
  assert.equal(inferMediaKind('SPEC.PDF'), 'pdf', '대소문자 무시');
});

test('inferMediaKind — PPT 는 pptx/ppt 확장자와 MS/OpenXML MIME 을 모두 흡수한다', () => {
  assert.equal(inferMediaKind('deck.pptx'), 'pptx');
  assert.equal(inferMediaKind('deck.ppt'), 'pptx');
  assert.equal(
    inferMediaKind('x', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    'pptx',
  );
  assert.equal(inferMediaKind('x', 'application/vnd.ms-powerpoint'), 'pptx');
  // `presentation` 부분 문자열 보정 — OSS 뷰어가 변형 MIME 을 쓸 때 안전.
  assert.equal(inferMediaKind('x', 'application/x-unknown-presentation'), 'pptx');
});

test('inferMediaKind — 영상/이미지는 각각 video/image 로 수렴한다', () => {
  for (const ext of ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']) {
    assert.equal(inferMediaKind(`clip.${ext}`), 'video', `${ext} → video`);
  }
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']) {
    assert.equal(inferMediaKind(`img.${ext}`), 'image', `${ext} → image`);
  }
  assert.equal(inferMediaKind('임의이름', 'image/png'), 'image');
  assert.equal(inferMediaKind('임의이름', 'video/quicktime'), 'video');
});

test('inferMediaKind — 지원하지 않는 형식은 null 을 돌려 준다(415 수렴 경로)', () => {
  assert.equal(inferMediaKind('readme.txt'), null);
  assert.equal(inferMediaKind('data', 'application/octet-stream'), null);
  assert.equal(inferMediaKind(''), null, '빈 이름도 안전하게 null');
});

// ────────────────────────────────────────────────────────────────────────────
// defaultPdfParser — 빈/손상 버퍼는 NotImplementedMediaError('pdf', ...) 로 래핑
// ────────────────────────────────────────────────────────────────────────────

test('defaultPdfParser — 빈 Buffer 입력은 NotImplementedMediaError("pdf") 로 래핑된다', async () => {
  const err = await defaultPdfParser
    .parse({ buffer: Buffer.alloc(0), name: 'empty.pdf', mimeType: 'application/pdf' })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NotImplementedMediaError, 'NotImplementedMediaError 여야 한다');
  assert.equal((err as NotImplementedMediaError).kind, 'pdf', '.kind 는 "pdf"');
  assert.match((err as NotImplementedMediaError).message, /PDF 파싱 실패/);
});

test('defaultPdfParser — 손상된 바이트(비 PDF 헤더) 도 같은 분류로 수렴한다', async () => {
  const corrupted = Buffer.from('이건 PDF 가 아닙니다 — 순수 한글 텍스트 바이트입니다.', 'utf8');
  const err = await defaultPdfParser
    .parse({ buffer: corrupted, name: 'corrupted.pdf' })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NotImplementedMediaError);
  assert.equal((err as NotImplementedMediaError).kind, 'pdf');
});

// ────────────────────────────────────────────────────────────────────────────
// defaultPptParser — 현재는 스텁, 즉시 NotImplementedMediaError('pptx')
// ────────────────────────────────────────────────────────────────────────────

test('defaultPptParser — 호출 즉시 NotImplementedMediaError("pptx") 를 던진다(스텁 계약)', async () => {
  const err = await defaultPptParser
    .parse({ buffer: Buffer.from([0, 1, 2, 3]), name: 'deck.pptx' })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NotImplementedMediaError);
  assert.equal((err as NotImplementedMediaError).kind, 'pptx');
  assert.match((err as NotImplementedMediaError).message, /PPT 파서 어댑터가 등록되지 않았습니다/);
});

// ────────────────────────────────────────────────────────────────────────────
// createMediaProcessor — 파사드 라우팅 · overrides · 지원 불가 kind 분류
// ────────────────────────────────────────────────────────────────────────────

test('createMediaProcessor — 지원 불가 확장자는 NotImplementedMediaError("unknown") 로 분류된다', async () => {
  const processor = createMediaProcessor();
  const err = await processor
    .parse({ buffer: Buffer.alloc(1), name: 'readme.txt' })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof NotImplementedMediaError);
  assert.equal((err as NotImplementedMediaError).kind, 'unknown');
  assert.match((err as NotImplementedMediaError).message, /지원하지 않는 미디어 형식/);
});

test('createMediaProcessor — overrides 로 PDF/PPT 어댑터를 주입하면 기본 구현 대신 호출된다', async () => {
  const calls: string[] = [];
  const fakePdf: PdfParser = {
    id: 'fake-pdf',
    async parse(input) {
      calls.push(`pdf:${input.name}`);
      return { kind: 'pdf', extractedText: '주입된 PDF 본문', pageCount: 3 };
    },
  };
  const fakePpt = {
    id: 'fake-ppt',
    async parse(input: { buffer: Buffer | Uint8Array; name: string; mimeType?: string }) {
      calls.push(`pptx:${input.name}`);
      return {
        kind: 'pptx' as const,
        extractedText: '슬라이드 1\n슬라이드 2',
        pageCount: 2,
      };
    },
  };
  const processor = createMediaProcessor({ pdf: fakePdf, pptx: fakePpt });
  const pdfResult = await processor.parse({ buffer: Buffer.alloc(1), name: 'spec.pdf' });
  const pptResult = await processor.parse({ buffer: Buffer.alloc(1), name: 'deck.pptx' });
  assert.deepEqual(calls, ['pdf:spec.pdf', 'pptx:deck.pptx']);
  assert.equal(pdfResult.pageCount, 3, '주입 어댑터의 pageCount 가 그대로 전달');
  assert.equal(pptResult.extractedText, '슬라이드 1\n슬라이드 2');
});

test('createMediaProcessor — 이미지/영상은 kind 만 돌려주고 extractedText 는 비어 있다(1차 스켈레톤 계약)', async () => {
  const processor = createMediaProcessor();
  const image = await processor.parse({ buffer: Buffer.alloc(1), name: 'photo.png' });
  const video = await processor.parse({ buffer: Buffer.alloc(1), name: 'clip.mp4' });
  assert.deepEqual(image, { kind: 'image' });
  assert.deepEqual(video, { kind: 'video' });
});

// ────────────────────────────────────────────────────────────────────────────
// VideoGenAdapter 레지스트리 — register/get/reset 의 단일 슬롯 계약
// ────────────────────────────────────────────────────────────────────────────

test('registerVideoGenAdapter — get/reset 이 동일 인스턴스를 돌려주고 null 로 해제된다', () => {
  resetVideoGenAdapter();
  assert.equal(getVideoGenAdapter(), null, '초기 상태는 미등록');

  const adapter: VideoGenAdapter = {
    id: 'fake-video',
    async generate({ projectId }) {
      return {
        id: 'asset-1',
        projectId,
        kind: 'video',
        name: 'generated.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 0,
        createdAt: '2026-04-19T10:00:00.000Z',
      };
    },
  };
  registerVideoGenAdapter(adapter);
  assert.equal(getVideoGenAdapter(), adapter, '동일 인스턴스 반환');
  resetVideoGenAdapter();
  assert.equal(getVideoGenAdapter(), null, 'reset 후 다시 미등록');
});
