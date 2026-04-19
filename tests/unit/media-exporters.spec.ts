// Run with: npx tsx --test tests/unit/media-exporters.spec.ts
//
// 지시 #f3eca898 — src/utils/mediaExporters 의 PDF/PPT/영상 출력 어댑터와
// prepareDownload 헬퍼의 경로별 단위 테스트. 실제 네트워크·DOM 을 타지 않도록
// 모든 호출은 `fetcher` mock 을 주입한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exportPdfReport,
  exportPptxDeck,
  exportVideo,
  prepareDownload,
  MediaExporterError,
} from '../../src/utils/mediaExporters.ts';
import type { MediaPreview } from '../../src/utils/mediaLoaders.ts';

function jsonResponse(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(extra ?? {}) },
  });
}

function fakeAsset(partial: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: partial.id ?? 'asset-1',
    projectId: partial.projectId ?? 'proj-1',
    kind: partial.kind ?? 'pdf',
    name: partial.name ?? 'out.pdf',
    mimeType: partial.mimeType ?? 'application/pdf',
    sizeBytes: partial.sizeBytes ?? 120,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    ...partial,
  };
}

// ─── 검증 계약 ────────────────────────────────────────────────────────────────

test('exportPdfReport — 빈 제목은 VALIDATION_FAILED', async () => {
  await assert.rejects(
    () => exportPdfReport(
      { template: { title: '   ', sections: [] } },
      { projectId: 'proj-1', fetcher: async () => jsonResponse({}) },
    ),
    (err: unknown) => err instanceof MediaExporterError && err.code === 'VALIDATION_FAILED',
  );
});

test('exportPptxDeck — 유효 title 을 가진 슬라이드가 0 개이면 VALIDATION_FAILED', async () => {
  await assert.rejects(
    () => exportPptxDeck(
      { slides: [{ title: '   ' }, { title: '' }] },
      { projectId: 'proj-1', fetcher: async () => jsonResponse({}) },
    ),
    (err: unknown) => err instanceof MediaExporterError && err.code === 'VALIDATION_FAILED',
  );
});

test('exportVideo — 빈 프롬프트는 VALIDATION_FAILED', async () => {
  await assert.rejects(
    () => exportVideo(
      { prompt: '   ' },
      { projectId: 'proj-1', fetcher: async () => jsonResponse({}) },
    ),
    (err: unknown) => err instanceof MediaExporterError && err.code === 'VALIDATION_FAILED',
  );
});

// ─── 정상 경로 ────────────────────────────────────────────────────────────────

test('exportPdfReport — 서버에 kind/template/projectId 를 JSON 으로 보낸다', async () => {
  let capturedUrl = '';
  let capturedBody: unknown;
  const fetcher = async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init!.body));
    return jsonResponse(fakeAsset({ kind: 'pdf', name: 'quarterly.pdf' }));
  };
  const preview = await exportPdfReport(
    {
      template: { title: '분기 리포트', sections: [{ heading: '요약', body: '본문' }] },
      assetIds: ['a1', 'a2'],
    },
    { projectId: 'proj-1', fetcher },
  );
  assert.equal(capturedUrl, '/api/media/generate');
  assert.deepEqual(capturedBody, {
    kind: 'pdf',
    template: { title: '분기 리포트', sections: [{ heading: '요약', body: '본문' }] },
    assetIds: ['a1', 'a2'],
    projectId: 'proj-1',
  });
  assert.equal(preview.kind, 'pdf');
  assert.equal(preview.name, 'quarterly.pdf');
});

test('exportPptxDeck — 빈/공백 슬라이드는 제거하고 남은 것만 보낸다', async () => {
  let capturedBody: { slides?: unknown } = {};
  const fetcher = async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init!.body));
    return jsonResponse(fakeAsset({ kind: 'pptx', name: 'deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
  };
  const preview = await exportPptxDeck(
    {
      slides: [
        { title: ' 첫 슬라이드 ', body: '본문' },
        { title: '' },
        { title: '   ' },
        { title: '두번째' },
      ],
    },
    { projectId: 'proj-1', fetcher },
  );
  assert.deepEqual(capturedBody.slides, [
    { title: '첫 슬라이드', body: '본문' },
    // 두 번째 항목은 body 가 undefined 로 실려 JSON 에서 제외된다.
    { title: '두번째' },
  ]);
  assert.equal(preview.kind, 'pptx');
});

test('exportVideo — { kind, prompt, projectId } 를 보낸다', async () => {
  let capturedBody: unknown;
  const fetcher = async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init!.body));
    return jsonResponse(fakeAsset({
      kind: 'video', name: 'hero.mp4', mimeType: 'video/mp4',
      generatedBy: { adapter: 'video-mock', prompt: 'hero shot' },
    }));
  };
  const preview = await exportVideo({ prompt: 'hero shot' }, { projectId: 'proj-1', fetcher });
  assert.deepEqual(capturedBody, { kind: 'video', prompt: 'hero shot', projectId: 'proj-1' });
  assert.equal(preview.generatedBy?.adapter, 'video-mock');
});

// ─── 상태 코드 분류 ──────────────────────────────────────────────────────────

test('503 + category:session_exhausted → SESSION_EXHAUSTED', async () => {
  const fetcher = async () => jsonResponse(
    { error: '세션이 소진되어 외부 영상 생성 호출이 차단되었습니다.', category: 'session_exhausted' },
    503,
  );
  await assert.rejects(
    () => exportVideo({ prompt: '샷' }, { projectId: 'proj-1', fetcher }),
    (err: unknown) => err instanceof MediaExporterError
      && err.code === 'SESSION_EXHAUSTED'
      && err.status === 503,
  );
});

test('501 → ADAPTER_NOT_REGISTERED (kind 미구현)', async () => {
  const fetcher = async () => jsonResponse({ error: '생성 미구현: kind=video' }, 501);
  await assert.rejects(
    () => exportVideo({ prompt: '샷' }, { projectId: 'proj-1', fetcher }),
    (err: unknown) => err instanceof MediaExporterError
      && err.code === 'ADAPTER_NOT_REGISTERED'
      && err.status === 501,
  );
});

test('400 → VALIDATION_FAILED (서버 측 입력 거절)', async () => {
  const fetcher = async () => jsonResponse({ error: 'slides required' }, 400);
  await assert.rejects(
    () => exportPptxDeck({ slides: [{ title: '유효' }] }, { projectId: 'proj-1', fetcher }),
    (err: unknown) => err instanceof MediaExporterError
      && err.code === 'VALIDATION_FAILED'
      && err.status === 400,
  );
});

test('500 → EXPORT_FAILED', async () => {
  const fetcher = async () => jsonResponse({ error: '미디어 생성에 실패했습니다.' }, 500);
  await assert.rejects(
    () => exportPdfReport({ template: { title: '리포트', sections: [] } }, { projectId: 'proj-1', fetcher }),
    (err: unknown) => err instanceof MediaExporterError
      && err.code === 'EXPORT_FAILED'
      && err.status === 500,
  );
});

test('사전 abort 된 signal — ABORTED', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => exportPdfReport(
      { template: { title: '리포트', sections: [] } },
      { projectId: 'proj-1', fetcher: async () => jsonResponse({}), signal: ac.signal },
    ),
    (err: unknown) => err instanceof MediaExporterError && err.code === 'ABORTED',
  );
});

// ─── 다운로드 헬퍼 ───────────────────────────────────────────────────────────

test('prepareDownload — extractedText·generatedBy 를 합쳐 data: URL 을 만든다', () => {
  const preview: MediaPreview = {
    id: 'asset-1',
    kind: 'pdf',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    createdAt: '2026-04-19T00:00:00Z',
    extractedText: '추출된 본문',
    generatedBy: { adapter: 'pdf-mock', prompt: '리포트' },
  };
  const dl = prepareDownload(preview);
  assert.equal(dl.filename, 'report.pdf');
  assert.ok(dl.url.startsWith('data:text/plain;charset=utf-8,'));
  const decoded = decodeURIComponent(dl.url.replace('data:text/plain;charset=utf-8,', ''));
  assert.match(decoded, /# report\.pdf/);
  assert.match(decoded, /kind=pdf/);
  assert.match(decoded, /generatedBy=pdf-mock/);
  assert.match(decoded, /추출된 본문/);
});

test('prepareDownload — 확장자 없는 이름은 kind 기본 확장자를 붙인다', () => {
  const preview: MediaPreview = {
    id: 'v1',
    kind: 'video',
    name: 'hero-shot',
    mimeType: 'video/mp4',
    sizeBytes: 0,
    createdAt: '2026-04-19T00:00:00Z',
  };
  const dl = prepareDownload(preview);
  assert.equal(dl.filename, 'hero-shot.mp4');
});

test('prepareDownload — name 이 비어 있으면 kind-id 폴백', () => {
  const preview: MediaPreview = {
    id: 'asset-7',
    kind: 'pptx',
    name: '',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sizeBytes: 0,
    createdAt: '2026-04-19T00:00:00Z',
  };
  const dl = prepareDownload(preview);
  assert.equal(dl.filename, 'pptx-asset-7.pptx');
});
