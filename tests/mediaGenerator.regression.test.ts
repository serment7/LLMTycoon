// Run with: npx tsx --test tests/mediaGenerator.regression.test.ts
//
// 회귀 테스트: `src/server/mediaGenerator.ts` 의 멀티미디어 "생성" 축 계약을
// 잠근다. 지시 #b425328e §1 의 3종(PDF 리포트·PPT 덱·영상) 과 §4 폴백 가드를
// 외부 라이브러리(pdf-lib/pptxgenjs) 의존성 없이 mock 어댑터로 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMediaGenerator,
  mockPdfGenerator,
  mockPptxGenerator,
  mockVideoGenAdapter,
  ExhaustedBlockedError,
} from '../src/server/mediaGenerator.ts';
import {
  registerVideoGenAdapter,
  resetVideoGenAdapter,
} from '../src/server/mediaProcessor.ts';

test('generatePdfReport 는 mock 어댑터 결과를 MediaAsset 으로 래핑한다', async () => {
  const gen = createMediaGenerator();
  const asset = await gen.generatePdfReport({
    projectId: 'proj-1',
    assets: [],
    template: { title: '결제 모듈 감사 리포트', sections: [{ heading: '요약', body: '…' }] },
  });
  assert.equal(asset.kind, 'pdf');
  assert.equal(asset.projectId, 'proj-1');
  assert.match(asset.name, /결제-모듈-감사-리포트\.pdf$/);
  assert.equal(asset.mimeType, 'application/pdf');
  assert.ok(asset.sizeBytes > 0, 'mock PDF 는 placeholder 바이트를 포함해야 한다');
  assert.equal(asset.generatedBy?.adapter, mockPdfGenerator.id);
});

test('generatePptxDeck 는 슬라이드 개수를 요약 prompt 에 반영한다', async () => {
  const gen = createMediaGenerator();
  const asset = await gen.generatePptxDeck({
    projectId: 'proj-2',
    slides: [
      { title: '표지', body: '공동 목표 보고' },
      { title: '진행 현황' },
      { title: '다음 단계', body: 'Q2 KPI' },
    ],
  });
  assert.equal(asset.kind, 'pptx');
  assert.equal(asset.projectId, 'proj-2');
  assert.equal(asset.mimeType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(asset.generatedBy?.adapter, mockPptxGenerator.id);
  assert.equal(asset.generatedBy?.prompt, 'slides:3');
});

test('generateVideo 는 등록된 어댑터에 prompt/projectId 를 전달해 결과를 돌려준다', async () => {
  resetVideoGenAdapter();
  registerVideoGenAdapter(mockVideoGenAdapter);
  try {
    const gen = createMediaGenerator();
    const asset = await gen.generateVideo({ projectId: 'proj-3', prompt: '제품 소개 30초' });
    assert.equal(asset.kind, 'video');
    assert.equal(asset.projectId, 'proj-3');
    assert.equal(asset.generatedBy?.adapter, 'video-mock');
    assert.equal(asset.generatedBy?.prompt, '제품 소개 30초');
  } finally {
    resetVideoGenAdapter();
  }
});

test('영상 어댑터 미등록 시 generateVideo 는 명확한 에러를 던진다', async () => {
  resetVideoGenAdapter();
  const gen = createMediaGenerator();
  await assert.rejects(
    () => gen.generateVideo({ projectId: 'proj-4', prompt: 'x' }),
    /영상 생성 어댑터가 등록되어 있지 않습니다\./,
  );
});

test('§4 가드 — sessionStatus=exhausted 이면 generateVideo 는 즉시 ExhaustedBlockedError', async () => {
  registerVideoGenAdapter(mockVideoGenAdapter);
  try {
    const gen = createMediaGenerator({ sessionStatusProvider: () => 'exhausted' });
    await assert.rejects(
      () => gen.generateVideo({ projectId: 'p', prompt: 'any' }),
      (err: unknown) => err instanceof ExhaustedBlockedError,
    );
  } finally {
    resetVideoGenAdapter();
  }
});

test('§4 가드는 PDF/PPT 에는 영향을 주지 않는다 (로컬 생성은 세션 소진과 무관)', async () => {
  const gen = createMediaGenerator({ sessionStatusProvider: () => 'exhausted' });
  const pdf = await gen.generatePdfReport({
    projectId: 'p', assets: [], template: { title: 't', sections: [] },
  });
  assert.equal(pdf.kind, 'pdf', 'exhausted 세션이어도 PDF 는 생성되어야 한다');
  const pptx = await gen.generatePptxDeck({
    projectId: 'p', slides: [{ title: 'a' }],
  });
  assert.equal(pptx.kind, 'pptx', 'exhausted 세션이어도 PPT 는 생성되어야 한다');
});

test('커스텀 PDF 어댑터 주입이 기본 mock 을 대체한다', async () => {
  const gen = createMediaGenerator({
    pdf: {
      id: 'custom-pdf',
      async generate({ projectId }) {
        return {
          kind: 'pdf',
          buffer: new Uint8Array([1, 2, 3]),
          mimeType: 'application/pdf',
          suggestedName: `custom-${projectId}.pdf`,
        };
      },
    },
  });
  const asset = await gen.generatePdfReport({
    projectId: 'proj-x', assets: [], template: { title: 't', sections: [] },
  });
  assert.equal(asset.generatedBy?.adapter, 'custom-pdf');
  assert.equal(asset.name, 'custom-proj-x.pdf');
  assert.equal(asset.sizeBytes, 3);
});
