// Run with: npx tsx --test tests/unit/media-loaders.spec.ts
//
// Thanos #3a049e55 — src/services/media/{pdfLoader,pptLoader,errors} 단위 테스트.
// 잠그는 계약:
//   1) PDF 정상 경로: 텍스트·페이지 메타·소스 메타가 PdfDocument 모양으로 채워진다.
//   2) PDF onProgress: phase 'open' 과 'finalize' 가 최소 1회씩 보고된다.
//   3) PDF 에러 코드 4종: UNSUPPORTED_FORMAT / FILE_TOO_LARGE / ABORTED / TIMEOUT.
//   4) PPTX 어댑터 미설치 폴백: 매직 검증 통과 후 UNSUPPORTED_FORMAT.
//   5) PPTX 형식·크기 가드: 매직 불일치/크기 초과 시 정확한 코드.
//
// PDF 정상 경로는 tests/fixtures/sample.pdf (1 page, ~329B) 를 그대로 사용한다.
// PPTX 는 npm 의존성에 추출 어댑터가 없으므로 fixture 없이 헤더만 가짜로 만든다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractPdf } from '../../src/services/media/pdfLoader.ts';
import { extractPptx } from '../../src/services/media/pptLoader.ts';
import { MediaParseError, MEDIA_ERROR_CODES, isMediaParseError } from '../../src/services/media/errors.ts';
import { toMediaAttachment } from '../../src/types/media.ts';

const FIXTURE_PDF = path.resolve(process.cwd(), 'tests/fixtures/sample.pdf');

async function makeTempFile(name: string, payload: Buffer): Promise<string> {
  const p = path.join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.writeFile(p, payload);
  return p;
}

// ─── pdfLoader ───────────────────────────────────────────────────────────────

test('extractPdf — 샘플 PDF 에서 PdfDocument 모양을 채운다', async () => {
  const doc = await extractPdf(FIXTURE_PDF);
  assert.equal(doc.kind, 'pdf');
  assert.equal(doc.source.parserId, 'pdf-parse');
  assert.equal(doc.source.mimeType, 'application/pdf');
  assert.ok(doc.source.sizeBytes > 0, 'sizeBytes 가 0 보다 커야 한다');
  assert.ok(doc.source.durationMs >= 0, 'durationMs 가 음수일 수 없다');
  assert.match(doc.source.parsedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(doc.pageCount >= 1, '최소 1 페이지 이상이어야 한다');
  assert.ok(Array.isArray(doc.pages));
  assert.ok(doc.pages.length >= 1);
  assert.equal(typeof doc.text, 'string');
});

test('extractPdf — onProgress 가 open/finalize phase 를 최소 1회 보고한다', async () => {
  const phases: string[] = [];
  await extractPdf(FIXTURE_PDF, { onProgress: p => phases.push(p.phase) });
  assert.ok(phases.includes('open'), 'open phase 누락');
  assert.ok(phases.includes('finalize'), 'finalize phase 누락');
});

test('extractPdf — PDF 매직 바이트가 없으면 MEDIA_UNSUPPORTED_FORMAT', async () => {
  const tmp = await makeTempFile('not-a-pdf.pdf', Buffer.from('NOT A PDF FILE\n', 'utf8'));
  try {
    await assert.rejects(
      () => extractPdf(tmp),
      (err: unknown) => isMediaParseError(err) && err.code === 'MEDIA_UNSUPPORTED_FORMAT',
    );
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
});

test('extractPdf — maxBytes 초과 시 MEDIA_FILE_TOO_LARGE', async () => {
  await assert.rejects(
    () => extractPdf(FIXTURE_PDF, { maxBytes: 1 }),
    (err: unknown) => isMediaParseError(err) && err.code === 'MEDIA_FILE_TOO_LARGE',
  );
});

test('extractPdf — 사전 abort 된 signal 은 MEDIA_PARSE_ABORTED', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => extractPdf(FIXTURE_PDF, { signal: ac.signal }),
    (err: unknown) => isMediaParseError(err) && err.code === 'MEDIA_PARSE_ABORTED',
  );
});

// NOTE: timeoutMs 동작은 `setTimeout` 기반의 Promise.race 패턴으로 결정적이지만,
// 샘플 PDF (≈329B) 는 파싱이 1ms 미만으로 끝나 race 가 항상 promise 쪽에 떨어진다.
// 더 큰 fixture 를 추가하거나 어댑터 주입 슬롯을 도입하기 전까지는 timeout 가지를
// 단위 테스트로 잠그지 않는다. 코드 자체는 src/services/media/pdfLoader.ts:runWithTimeout
// 한 함수에 격리되어 있어 추후 fixture 가 들어오면 즉시 검증 가능하다.

test('extractPdf — 존재하지 않는 경로는 MEDIA_PARSE_FAILED', async () => {
  await assert.rejects(
    () => extractPdf(path.join(tmpdir(), `does-not-exist-${Date.now()}.pdf`)),
    (err: unknown) => isMediaParseError(err) && err.code === 'MEDIA_PARSE_FAILED',
  );
});

// ─── pptLoader ───────────────────────────────────────────────────────────────

test('extractPptx — 매직 통과 후 어댑터 미설치이면 MEDIA_UNSUPPORTED_FORMAT', async () => {
  const tmp = await makeTempFile(
    'fake.pptx',
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('payload')]),
  );
  try {
    await assert.rejects(
      () => extractPptx(tmp),
      (err: unknown) => isMediaParseError(err) && err.code === 'MEDIA_UNSUPPORTED_FORMAT',
    );
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
});

test('extractPptx — 매직 바이트 불일치는 MEDIA_UNSUPPORTED_FORMAT', async () => {
  const tmp = await makeTempFile('not-pptx.pptx', Buffer.from('NOT A ZIP'));
  try {
    await assert.rejects(
      () => extractPptx(tmp),
      (err: unknown) => isMediaParseError(err) && err.code === 'MEDIA_UNSUPPORTED_FORMAT',
    );
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
});

test('extractPptx — maxBytes 초과 시 MEDIA_FILE_TOO_LARGE', async () => {
  const tmp = await makeTempFile(
    'big-pptx.pptx',
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048)]),
  );
  try {
    await assert.rejects(
      () => extractPptx(tmp, { maxBytes: 1 }),
      (err: unknown) => isMediaParseError(err) && err.code === 'MEDIA_FILE_TOO_LARGE',
    );
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
});

test('extractPptx — 사전 abort 된 signal 은 MEDIA_PARSE_ABORTED', async () => {
  const tmp = await makeTempFile(
    'abort.pptx',
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('payload')]),
  );
  try {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => extractPptx(tmp, { signal: ac.signal }),
      (err: unknown) => isMediaParseError(err) && err.code === 'MEDIA_PARSE_ABORTED',
    );
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
});

// ─── errors / 공용 타입 ──────────────────────────────────────────────────────

test('MEDIA_ERROR_CODES — 5종 모두 노출된다', () => {
  assert.equal(MEDIA_ERROR_CODES.length, 5);
  for (const code of [
    'MEDIA_PARSE_TIMEOUT',
    'MEDIA_UNSUPPORTED_FORMAT',
    'MEDIA_FILE_TOO_LARGE',
    'MEDIA_PARSE_ABORTED',
    'MEDIA_PARSE_FAILED',
  ] as const) {
    assert.ok(MEDIA_ERROR_CODES.includes(code), `${code} 누락`);
  }
});

test('MediaParseError — code/message/cause 가 보존된다', () => {
  const cause = new Error('원인');
  const err = new MediaParseError('MEDIA_PARSE_FAILED', '실패', cause);
  assert.equal(err.code, 'MEDIA_PARSE_FAILED');
  assert.equal(err.cause, cause);
  assert.match(err.message, /\[MEDIA_PARSE_FAILED\] 실패/);
  assert.equal(err.name, 'MediaParseError');
  assert.ok(isMediaParseError(err));
});

test('toMediaAttachment — PdfDocument 를 첨부 모양으로 압축한다', async () => {
  const doc = await extractPdf(FIXTURE_PDF);
  const attachment = toMediaAttachment(doc, 'sample.pdf');
  assert.equal(attachment.kind, 'pdf');
  assert.equal(attachment.name, 'sample.pdf');
  assert.equal(attachment.pageCount, doc.pageCount);
  assert.equal(attachment.text, doc.text);
});

// ─── src/utils/mediaLoaders (client dispatcher · #f6052a91 1차 스켈레톤) ────
//
// 분류기 · 업로드 어댑터 · 영상 생성 어댑터 스텁의 경로별 단위 테스트. 실제 네트워크
// 를 타지 않도록 모든 테스트는 `fetcher` mock 을 주입한다. 이 축은 `extractPdf/Pptx`
// (Node 전용) 와 같은 파일에서 잠겨 있어야, 멀티미디어 파이프라인 회귀를 단일 spec
// 하나로 관측할 수 있다.

import {
  detectMediaKind,
  loadMediaFile,
  loadPdfFile,
  loadPptFile,
  requestVideoGeneration,
  MediaLoaderError,
} from '../../src/utils/mediaLoaders.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('detectMediaKind — 확장자 우선, MIME 승격, 미판정은 null', () => {
  assert.equal(detectMediaKind('report.pdf'), 'pdf');
  assert.equal(detectMediaKind('deck.pptx'), 'pptx');
  assert.equal(detectMediaKind('slides.ppt'), 'pptx');
  assert.equal(detectMediaKind('promo.mp4'), 'video');
  assert.equal(detectMediaKind('frame.png'), 'image');
  assert.equal(detectMediaKind('unknown.bin'), null);
  // MIME 만으로 승격
  assert.equal(detectMediaKind('bin', 'application/pdf'), 'pdf');
  assert.equal(detectMediaKind('bin', 'video/mp4'), 'video');
  assert.equal(detectMediaKind('bin', 'image/png'), 'image');
  assert.equal(
    detectMediaKind('bin', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    'pptx',
  );
});

test('loadPdfFile — /api/media/upload 로 POST 해 MediaAsset 을 MediaPreview 로 투영한다', async () => {
  const file = new File(['%PDF-1.4 stub'], 'report.pdf', { type: 'application/pdf' });
  let calledUrl = '';
  let sentProjectId: FormDataEntryValue | null = null;
  const fetcher = async (url: string, init?: RequestInit) => {
    calledUrl = url;
    sentProjectId = (init!.body as FormData).get('projectId');
    return jsonResponse({
      id: 'asset-1', projectId: 'proj-1', kind: 'pdf', name: 'report.pdf',
      mimeType: 'application/pdf', sizeBytes: 13,
      createdAt: new Date().toISOString(), extractedText: '안녕',
    });
  };
  const preview = await loadPdfFile(file, { projectId: 'proj-1', fetcher });
  assert.equal(calledUrl, '/api/media/upload');
  assert.equal(sentProjectId, 'proj-1');
  assert.equal(preview.kind, 'pdf');
  assert.equal(preview.extractedText, '안녕');
});

test('loadPptFile — 어댑터 미등록 501 은 ADAPTER_NOT_REGISTERED 로 분류된다', async () => {
  const file = new File(['fake'], 'deck.pptx', {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
  const fetcher = async () => jsonResponse({ error: 'PPT 파서 어댑터가 등록되지 않았습니다.' }, 501);
  await assert.rejects(
    () => loadPptFile(file, { projectId: 'proj-1', fetcher }),
    (err: unknown) => err instanceof MediaLoaderError
      && err.code === 'ADAPTER_NOT_REGISTERED'
      && err.status === 501,
  );
});

test('loadMediaFile — 영상 파일은 UNSUPPORTED_KIND 로 막고 생성 경로로 안내한다', async () => {
  const file = new File([new Uint8Array([0, 0, 0, 32])], 'promo.mp4', { type: 'video/mp4' });
  await assert.rejects(
    () => loadMediaFile(file, { projectId: 'proj-1', fetcher: async () => jsonResponse({}) }),
    (err: unknown) => err instanceof MediaLoaderError && err.code === 'UNSUPPORTED_KIND',
  );
});

test('loadMediaFile — 이미지는 업로드 없이 로컬 메타 MediaPreview 를 돌려준다', async () => {
  const file = new File([new Uint8Array([137, 80])], 'frame.png', { type: 'image/png' });
  let fetchCalled = false;
  const preview = await loadMediaFile(file, {
    projectId: 'proj-1',
    fetcher: async () => { fetchCalled = true; return jsonResponse({}); },
  });
  assert.equal(fetchCalled, false, '이미지 경로는 서버를 호출하지 않는다');
  assert.equal(preview.kind, 'image');
  assert.equal(preview.name, 'frame.png');
});

test('loadMediaFile — 판정 불가 파일은 UNSUPPORTED_KIND 로 거절', async () => {
  const file = new File([new Uint8Array(4)], 'binary.bin', { type: '' });
  await assert.rejects(
    () => loadMediaFile(file, { projectId: 'proj-1', fetcher: async () => jsonResponse({}) }),
    (err: unknown) => err instanceof MediaLoaderError && err.code === 'UNSUPPORTED_KIND',
  );
});

test('requestVideoGeneration — 빈 프롬프트는 즉시 GENERATE_FAILED', async () => {
  await assert.rejects(
    () => requestVideoGeneration(
      { prompt: '   ', projectId: 'proj-1' },
      { fetcher: async () => jsonResponse({}) },
    ),
    (err: unknown) => err instanceof MediaLoaderError && err.code === 'GENERATE_FAILED',
  );
});

test('requestVideoGeneration — 성공 시 MediaAsset → MediaPreview 로 투영된다', async () => {
  const now = new Date().toISOString();
  let sentBody: unknown;
  const fetcher = async (_url: string, init?: RequestInit) => {
    sentBody = JSON.parse(String(init!.body));
    return jsonResponse({
      id: 'video-1', projectId: 'proj-1', kind: 'video',
      name: 'promo.mp4', mimeType: 'video/mp4', sizeBytes: 0, createdAt: now,
      generatedBy: { adapter: 'video-mock', prompt: 'hero shot' },
    });
  };
  const preview = await requestVideoGeneration(
    { prompt: 'hero shot', projectId: 'proj-1' },
    { fetcher },
  );
  assert.deepEqual(sentBody, { projectId: 'proj-1', kind: 'video', prompt: 'hero shot' });
  assert.equal(preview.kind, 'video');
  assert.equal(preview.generatedBy?.adapter, 'video-mock');
});

test('requestVideoGeneration — 세션 소진 503 은 SESSION_EXHAUSTED 로 분류된다', async () => {
  const fetcher = async () => jsonResponse(
    { error: '세션이 소진되어 외부 영상 생성 호출이 차단되었습니다.' },
    503,
  );
  await assert.rejects(
    () => requestVideoGeneration(
      { prompt: '시네마틱 한 장면', projectId: 'proj-1' },
      { fetcher },
    ),
    (err: unknown) => err instanceof MediaLoaderError
      && err.code === 'SESSION_EXHAUSTED'
      && err.status === 503,
  );
});

test('requestVideoGeneration — 어댑터 미등록 503 은 ADAPTER_NOT_REGISTERED 로 분류된다', async () => {
  const fetcher = async () => jsonResponse(
    { error: '영상 생성 어댑터가 등록되어 있지 않습니다.' },
    503,
  );
  await assert.rejects(
    () => requestVideoGeneration(
      { prompt: 'hero shot', projectId: 'proj-1' },
      { fetcher },
    ),
    (err: unknown) => err instanceof MediaLoaderError
      && err.code === 'ADAPTER_NOT_REGISTERED'
      && err.status === 503,
  );
});

test('요청 중단 — 사전 abort 된 signal 은 업로드·생성 모두 ABORTED', async () => {
  const ac = new AbortController();
  ac.abort();
  const file = new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' });
  await assert.rejects(
    () => loadPdfFile(file, { projectId: 'proj-1', signal: ac.signal, fetcher: async () => jsonResponse({}) }),
    (err: unknown) => err instanceof MediaLoaderError && err.code === 'ABORTED',
  );
  await assert.rejects(
    () => requestVideoGeneration(
      { prompt: '샷', projectId: 'proj-1' },
      { signal: ac.signal, fetcher: async () => jsonResponse({}) },
    ),
    (err: unknown) => err instanceof MediaLoaderError && err.code === 'ABORTED',
  );
});
