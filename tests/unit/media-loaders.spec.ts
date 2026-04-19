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
  toChatAttachment,
  DEFAULT_MAX_BYTES,
  MediaLoaderError,
  getThumbnail,
  peekThumbnail,
  invalidateThumbnailCache,
  clearThumbnailCache,
  getThumbnailCacheSize,
  type MediaPreview,
  type MediaLoaderProgress,
} from '../../src/utils/mediaLoaders.ts';
import {
  registerVideoExporterProvider,
  resetVideoExporterProvider,
  stubVideoExporterProvider,
  exportVideo,
  MediaExporterError,
} from '../../src/utils/mediaExporters.ts';
import {
  mapMediaExporterError,
  mapUnknownError,
} from '../../src/utils/errorMessages.ts';

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

// ─── 방어적 오류 처리 회귀 점검 (#f3eca898) ──────────────────────────────────
//
// 서버가 손상 파일·미지원 MIME 응답(415/500) 을 돌려줬을 때 mediaLoaders 가 조용히
// 실패하지 않고 `UPLOAD_FAILED` 로 분류해 UI 가 사용자 안내 토스트를 낼 수 있음을
// 잠근다. `ADAPTER_NOT_REGISTERED`(501) 와는 반드시 구분돼야 한다.

test('loadPdfFile — 서버가 415(UNSUPPORTED) 를 돌려 주면 UPLOAD_FAILED 로 분류', async () => {
  const file = new File(['CORRUPT'], 'bad.pdf', { type: 'application/pdf' });
  const fetcher = async () => jsonResponse({ error: '지원하지 않는 미디어 형식입니다.' }, 415);
  await assert.rejects(
    () => loadPdfFile(file, { projectId: 'proj-1', fetcher }),
    (err: unknown) => err instanceof MediaLoaderError
      && err.code === 'UPLOAD_FAILED'
      && err.status === 415,
  );
});

test('loadPdfFile — 서버 500(손상 파일 파싱 실패) 은 UPLOAD_FAILED', async () => {
  const file = new File(['CORRUPT'], 'bad.pdf', { type: 'application/pdf' });
  const fetcher = async () => jsonResponse({ error: 'PDF 해석에 실패했습니다.' }, 500);
  await assert.rejects(
    () => loadPdfFile(file, { projectId: 'proj-1', fetcher }),
    (err: unknown) => err instanceof MediaLoaderError
      && err.code === 'UPLOAD_FAILED'
      && err.status === 500,
  );
});

test('detectMediaKind — 빈 이름과 빈 MIME 모두 null 을 돌려준다', () => {
  assert.equal(detectMediaKind('', ''), null);
  assert.equal(detectMediaKind('noext', ''), null);
  // 확장자·MIME 모두 엉망이면 호출자가 업로드 시도를 하지 않도록 null.
  assert.equal(detectMediaKind('.', 'application/octet-stream'), null);
});

// ─── 대용량 경계값 & 진행률 (#e36d53f8) ──────────────────────────────────────

test('loadPdfFile — maxBytes 초과 시 네트워크 전에 FILE_TOO_LARGE', async () => {
  // 10MB+1 바이트 파일을 만들되, FormData 로 직렬화되기 전에 거절되어야 하므로 실제
  // 버퍼가 크게 할당되지 않도록 Blob 의 size 만 허위로 확장하는 대신 작은 배열을 쓴다.
  const file = new File([new Uint8Array(11)], 'big.pdf', { type: 'application/pdf' });
  let fetchCalled = false;
  await assert.rejects(
    () => loadPdfFile(file, {
      projectId: 'proj-1',
      maxBytes: 10,
      fetcher: async () => { fetchCalled = true; return jsonResponse({}); },
    }),
    (err: unknown) => err instanceof MediaLoaderError && err.code === 'FILE_TOO_LARGE',
  );
  assert.equal(fetchCalled, false, 'maxBytes 초과 시 네트워크를 타면 안 된다');
});

test('loadPdfFile — 진행률 콜백이 precheck → upload → finalize 순서로 호출된다', async () => {
  const file = new File(['%PDF-1.4 small'], 'a.pdf', { type: 'application/pdf' });
  const phases: MediaLoaderProgress[] = [];
  const fetcher = async () => jsonResponse({
    id: 'asset-2', projectId: 'proj-1', kind: 'pdf', name: 'a.pdf',
    mimeType: 'application/pdf', sizeBytes: file.size,
    createdAt: new Date().toISOString(),
  });
  await loadPdfFile(file, {
    projectId: 'proj-1',
    fetcher,
    onProgress: p => phases.push(p),
  });
  const seqs = phases.map(p => p.phase);
  assert.deepEqual(seqs, ['precheck', 'upload', 'upload', 'finalize']);
  assert.ok(phases.every(p => p.total === file.size));
});

test('DEFAULT_MAX_BYTES — 50MB 상한을 수출한다', () => {
  assert.equal(DEFAULT_MAX_BYTES, 50 * 1024 * 1024);
});

// ─── 첨부 정규화 toChatAttachment (#e36d53f8 §2) ──────────────────────────────

test('toChatAttachment — PDF 에서 페이지 인덱스·요약·발췌를 채운다', () => {
  const preview: MediaPreview = {
    id: 'asset-3', kind: 'pdf', name: 'report.pdf',
    mimeType: 'application/pdf', sizeBytes: 2048,
    createdAt: new Date().toISOString(),
    extractedText: '첫 페이지\f둘째 페이지\f셋째 페이지',
    pageCount: 3,
  };
  const att = toChatAttachment(preview);
  assert.equal(att.kind, 'pdf');
  assert.deepEqual(att.pageIndices, [1, 2, 3]);
  assert.match(att.summary, /PDF/);
  assert.match(att.summary, /3페이지/);
  assert.match(att.summary, /report\.pdf/);
  assert.equal(att.textExcerpt, '첫 페이지\f둘째 페이지\f셋째 페이지');
});

test('toChatAttachment — extractedText 가 길면 excerptLength 로 잘라 … 를 붙인다', () => {
  const preview: MediaPreview = {
    id: 'asset-4', kind: 'pdf', name: 'long.pdf',
    mimeType: 'application/pdf', sizeBytes: 10,
    createdAt: new Date().toISOString(),
    extractedText: 'A'.repeat(500),
  };
  const att = toChatAttachment(preview, { excerptLength: 64 });
  assert.equal(att.textExcerpt?.length, 65); // 64자 + … 한 글자
  assert.ok(att.textExcerpt?.endsWith('…'));
});

test('toChatAttachment — PPTX 는 slideIndices, 영상/이미지는 인덱스 없음', () => {
  const pptx = toChatAttachment({
    id: 'p1', kind: 'pptx', name: 'deck.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sizeBytes: 1024, createdAt: new Date().toISOString(), pageCount: 4,
  });
  assert.deepEqual(pptx.slideIndices, [1, 2, 3, 4]);
  assert.equal(pptx.pageIndices, undefined);

  const video = toChatAttachment({
    id: 'v1', kind: 'video', name: 'hero.mp4',
    mimeType: 'video/mp4', sizeBytes: 0, createdAt: new Date().toISOString(),
    generatedBy: { adapter: 'video-mock', prompt: 'hero' },
  });
  assert.equal(video.pageIndices, undefined);
  assert.equal(video.slideIndices, undefined);
  assert.equal(video.textExcerpt, undefined);
  assert.match(video.summary, /영상/);
});

// ─── 썸네일 지연 생성 + 캐시 (#e5965192 §2) ──────────────────────────────────

function fakePreview(over: Partial<MediaPreview> = {}): MediaPreview {
  return {
    id: over.id ?? `asset-${Math.random().toString(36).slice(2, 8)}`,
    kind: over.kind ?? 'pdf',
    name: over.name ?? 'report.pdf',
    mimeType: over.mimeType ?? 'application/pdf',
    sizeBytes: over.sizeBytes ?? 1024,
    createdAt: over.createdAt ?? new Date().toISOString(),
    extractedText: over.extractedText,
    pageCount: over.pageCount,
  };
}

test('getThumbnail — 동일 키 재호출 시 renderer 는 한 번만 실행된다(캐시 히트)', async () => {
  clearThumbnailCache();
  const preview = fakePreview({ id: 'thumb-1' });
  let calls = 0;
  const renderer = async () => { calls += 1; return `data:image/png;base64,AAA${calls}`; };
  const first = await getThumbnail(preview, { pageIndex: 1, renderer });
  const second = await getThumbnail(preview, { pageIndex: 1, renderer });
  assert.equal(calls, 1, 'renderer 는 단 한 번만 실행돼야 한다');
  assert.equal(first, second);
});

test('getThumbnail — renderer 미주입 상태에서 미스는 null, 히트는 캐시 값', async () => {
  clearThumbnailCache();
  const preview = fakePreview({ id: 'thumb-2' });
  assert.equal(await getThumbnail(preview, { pageIndex: 1 }), null);
  // 렌더러를 주입해 한 번 채워 둔다.
  await getThumbnail(preview, {
    pageIndex: 1,
    renderer: async () => 'data:image/png;base64,CACHED',
  });
  assert.equal(await getThumbnail(preview, { pageIndex: 1 }), 'data:image/png;base64,CACHED');
  assert.equal(peekThumbnail(preview, 1), 'data:image/png;base64,CACHED');
});

test('getThumbnail — bypassCache=true 이면 renderer 가 다시 호출되어 덮어쓰기', async () => {
  clearThumbnailCache();
  const preview = fakePreview({ id: 'thumb-3' });
  let calls = 0;
  const renderer = async () => { calls += 1; return `v${calls}`; };
  const a = await getThumbnail(preview, { pageIndex: 1, renderer });
  const b = await getThumbnail(preview, { pageIndex: 1, renderer, bypassCache: true });
  assert.equal(a, 'v1');
  assert.equal(b, 'v2');
});

test('invalidateThumbnailCache — 자산 id 기준 prefix 만 제거한다', async () => {
  clearThumbnailCache();
  const a = fakePreview({ id: 'keep' });
  const b = fakePreview({ id: 'drop' });
  const renderer = async (p: MediaPreview, i?: number) => `${p.id}:${i}`;
  await getThumbnail(a, { pageIndex: 1, renderer });
  await getThumbnail(b, { pageIndex: 1, renderer });
  await getThumbnail(b, { pageIndex: 2, renderer });
  assert.equal(getThumbnailCacheSize(), 3);
  invalidateThumbnailCache('drop');
  assert.equal(getThumbnailCacheSize(), 1);
  assert.equal(peekThumbnail(a, 1), 'keep:1');
  assert.equal(peekThumbnail(b, 1), null);
});

// ─── 영상 Provider 스텁 + 오류 매핑 (#e5965192 §3) ─────────────────────────

test('stubVideoExporterProvider — exportVideo 를 ADAPTER_NOT_REGISTERED 로 수렴시킨다', async () => {
  registerVideoExporterProvider(stubVideoExporterProvider);
  try {
    await assert.rejects(
      () => exportVideo({ prompt: '샷' }, {
        projectId: 'proj-1',
        fetcher: async () => { throw new Error('스텁은 fetch 를 타면 안 된다'); },
      }),
      (err: unknown) => err instanceof MediaExporterError
        && err.code === 'ADAPTER_NOT_REGISTERED'
        && err.status === 503,
    );
  } finally {
    resetVideoExporterProvider();
  }
});

test('errorMessages 매핑 — ADAPTER_NOT_REGISTERED 는 "설정 열기" 조치 버튼을 제공', () => {
  const msg = mapMediaExporterError('ADAPTER_NOT_REGISTERED');
  assert.equal(msg.severity, 'error');
  assert.match(msg.title, /내보내기|엔진/);
  assert.equal(msg.action?.kind, 'open-settings');
});

test('mapUnknownError — MediaExporterError 인스턴스를 code 로 분류한다', () => {
  const err = new MediaExporterError('SESSION_EXHAUSTED', '세션 소진', { status: 503 });
  const msg = mapUnknownError(err);
  assert.equal(msg.severity, 'warning');
  assert.match(msg.title, /세션/);
});

test('loadMediaFile — fetcher 미주입 + 전역 fetch 없음 → UPLOAD_FAILED', async () => {
  // globalThis.fetch 를 일시적으로 가려 "실행 환경에 fetch 가 없을 때" 경로를 잠근다.
  const file = new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' });
  const saved = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = undefined;
  try {
    await assert.rejects(
      () => loadMediaFile(file, { projectId: 'proj-1' }),
      (err: unknown) => err instanceof MediaLoaderError && err.code === 'UPLOAD_FAILED',
    );
  } finally {
    (globalThis as { fetch?: unknown }).fetch = saved;
  }
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
