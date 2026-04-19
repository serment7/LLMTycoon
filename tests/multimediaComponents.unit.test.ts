// Run with: npx tsx --test tests/multimediaComponents.unit.test.ts
//
// 멀티미디어 UI 골격(#25c6969c) — UploadDropzone · AttachmentPreviewPanel · ExportButtons 의
// 순수 파생 함수를 Node 에서 검증한다. 실제 DOM 렌더링은 디자이너 시안 합류 후 jsdom
// 렌더 테스트로 추가하고, 본 파일은 **성공·실패·취소** 3축 계약을 고정한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDragState,
  formatBytes,
  gateFile,
} from '../src/components/UploadDropzone.tsx';
import {
  formatAttachmentSummary,
  type AttachmentItem,
} from '../src/components/AttachmentPreviewPanel.tsx';
import {
  EXPORT_BUTTONS,
  deriveExportButtonState,
} from '../src/components/ExportButtons.tsx';
import type { MediaPreview } from '../src/utils/mediaLoaders.ts';

// 파일 스텁 — Node 의 `File` 을 흉내내는 최소 객체. 필드 3개만 있으면 gateFile 이 동작.
function makeFile(name: string, type: string, size: number): File {
  return { name, type, size } as unknown as File;
}

function makePreview(overrides: Partial<MediaPreview> = {}): MediaPreview {
  return {
    id: 'a-1',
    kind: 'pdf',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 12_800,
    createdAt: new Date('2026-04-19T00:00:00Z').toISOString(),
    pageCount: 3,
    extractedText: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 성공 경로(upload → preview → export)
// ---------------------------------------------------------------------------

test('성공 경로 · gateFile 은 지원 형식+용량 내 파일을 통과시키고 detectMediaKind 로 kind 를 판정', () => {
  const pdf = gateFile(makeFile('report.pdf', 'application/pdf', 50_000));
  assert.equal(pdf.ok, true);
  if (pdf.ok) assert.equal(pdf.kind, 'pdf');

  const video = gateFile(makeFile('demo.mp4', 'video/mp4', 1_000_000));
  assert.equal(video.ok, true);
  if (video.ok) assert.equal(video.kind, 'video');

  // classifyDragState 는 Files 가 포함된 DataTransfer 를 dragover 로 해석.
  const over = classifyDragState({ types: ['Files'] });
  assert.equal(over, 'dragover');

  // formatAttachmentSummary — kind + 페이지 수 + 용량이 이어 붙는다.
  const summary = formatAttachmentSummary({
    id: 'a', name: 'report.pdf', status: 'ready', preview: makePreview({ pageCount: 3, sizeBytes: 204_800 }),
  });
  assert.match(summary, /^PDF · 3페이지/);
  assert.match(summary, /200 KB/);

  // 내보내기 활성 상태: 전역 차단 없고 busyKind 도 없음 → 모두 활성.
  for (const btn of EXPORT_BUTTONS) {
    const s = deriveExportButtonState({ kind: btn.kind });
    assert.equal(s.disabled, false);
    assert.equal(s.busy, false);
  }
});

// ---------------------------------------------------------------------------
// 실패 경로(미지원 형식 · 용량 초과 · 내보내기 전역 차단)
// ---------------------------------------------------------------------------

test('실패 경로 · gateFile 은 미지원 형식/용량 초과를 UserFacingMessage 와 함께 거부', () => {
  // 미지원 확장자/MIME → UNSUPPORTED_KIND.
  const rej = gateFile(makeFile('doc.xyz', 'application/octet-stream', 1_000));
  assert.equal(rej.ok, false);
  if (!rej.ok) {
    assert.equal(rej.reason, 'UNSUPPORTED_KIND');
    assert.equal(rej.message.severity, 'warning');
    assert.match(rej.message.title, /지원하지 않는/);
  }

  // 용량 초과 — 50MB 기본을 1 바이트로 축소해 강제 발동.
  const tooBig = gateFile(makeFile('huge.pdf', 'application/pdf', 2_000), { maxBytes: 1_000 });
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.equal(tooBig.reason, 'FILE_TOO_LARGE');

  // 실패 상태의 미리보기 요약은 업로드되기 전 이름만으로 최소 라벨을 돌려준다.
  const failedItem: AttachmentItem = {
    id: 'f', name: 'broken.pdf', status: 'failed', errorTitle: '파일을 읽을 수 없어요',
  };
  const label = formatAttachmentSummary(failedItem);
  assert.equal(label, '파일 · broken.pdf');

  // 내보내기 전역 차단(예: 프로젝트 미선택) → 모든 버튼 disabled.
  const pdfDisabled = deriveExportButtonState({ kind: 'pdf', disabled: true });
  assert.equal(pdfDisabled.disabled, true);
  assert.equal(pdfDisabled.busy, false);
});

// ---------------------------------------------------------------------------
// 취소/진행 중 경로 — busyKind 하나만 비활성, 나머지는 계속 활성
// ---------------------------------------------------------------------------

test('취소/진행 중 경로 · busyKind 에 해당하는 버튼만 스피너+disabled, 나머지는 계속 활성', () => {
  const pdfBusy = deriveExportButtonState({ kind: 'pdf', busyKind: 'pdf' });
  assert.equal(pdfBusy.busy, true);
  assert.equal(pdfBusy.disabled, true);
  assert.match(pdfBusy.label, /중…$/, 'busy 라벨은 "…중" 접미로 진행 중임을 알려야 한다');

  const pptxIdle = deriveExportButtonState({ kind: 'pptx', busyKind: 'pdf' });
  assert.equal(pptxIdle.busy, false);
  assert.equal(pptxIdle.disabled, false);

  // classifyDragState — 파일이 아닌 드래그(텍스트 선택)는 invalid 로 수렴.
  assert.equal(classifyDragState({ types: ['text/plain'] }), 'invalid');
  // disabled=true 면 상태 파생은 무조건 'disabled' — 드래그 중에도 UI 가 오해되지 않음.
  assert.equal(classifyDragState({ types: ['Files'], disabled: true }), 'disabled');

  // formatBytes — 0/음수/비숫자 폴백 계약.
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-10), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});
