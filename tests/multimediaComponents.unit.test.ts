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
  exportShortcutLabel,
  resolveExportShortcut,
} from '../src/components/ExportButtons.tsx';
import { pickFocusIndexOnKey } from '../src/components/AttachmentPreviewPanel.tsx';
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

// ---------------------------------------------------------------------------
// 내보내기 단축키 — Alt+P/S/V 매핑과 라벨
// ---------------------------------------------------------------------------

test('resolveExportShortcut · Alt + p/s/v 만 각각 pdf/pptx/video 로 매핑', () => {
  assert.equal(resolveExportShortcut({ key: 'p', altKey: true }), 'pdf');
  assert.equal(resolveExportShortcut({ key: 's', altKey: true }), 'pptx');
  assert.equal(resolveExportShortcut({ key: 'v', altKey: true }), 'video');
  // 대소문자를 구분하지 않는다 — 한/영 전환 등에서 Shift 와 함께 눌려도 매핑 유지.
  assert.equal(resolveExportShortcut({ key: 'P', altKey: true }), 'pdf');
});

test('resolveExportShortcut · Alt 없는 키는 항상 null', () => {
  assert.equal(resolveExportShortcut({ key: 'p', altKey: false }), null);
  assert.equal(resolveExportShortcut({ key: 's', altKey: false }), null);
});

test('resolveExportShortcut · Alt + Ctrl/Meta 조합은 시스템 충돌 방지로 매핑하지 않는다', () => {
  assert.equal(resolveExportShortcut({ key: 'p', altKey: true, ctrlKey: true }), null);
  assert.equal(resolveExportShortcut({ key: 'p', altKey: true, metaKey: true }), null);
});

test('resolveExportShortcut · 매칭되지 않는 글자는 null', () => {
  assert.equal(resolveExportShortcut({ key: 'z', altKey: true }), null);
  assert.equal(resolveExportShortcut({ key: '', altKey: true }), null);
});

test('exportShortcutLabel · 각 kind 는 Alt+X 문자열을 돌려준다', () => {
  assert.equal(exportShortcutLabel('pdf'), 'Alt+P');
  assert.equal(exportShortcutLabel('pptx'), 'Alt+S');
  assert.equal(exportShortcutLabel('video'), 'Alt+V');
});

// ---------------------------------------------------------------------------
// AttachmentPreviewPanel · pickFocusIndexOnKey — 비순환 listbox 계약
// ---------------------------------------------------------------------------

test('pickFocusIndexOnKey · total=0 이면 -1 로 "포커스 없음" 신호', () => {
  assert.equal(pickFocusIndexOnKey({ current: 0, total: 0, key: 'ArrowDown' }), -1);
  assert.equal(pickFocusIndexOnKey({ current: 2, total: 0, key: 'Home' }), -1);
});

test('pickFocusIndexOnKey · ArrowDown/ArrowRight 는 +1, 마지막에서는 경계 고정', () => {
  assert.equal(pickFocusIndexOnKey({ current: 0, total: 3, key: 'ArrowDown' }), 1);
  assert.equal(pickFocusIndexOnKey({ current: 1, total: 3, key: 'ArrowRight' }), 2);
  // 경계에서 래핑 없음(비순환).
  assert.equal(pickFocusIndexOnKey({ current: 2, total: 3, key: 'ArrowDown' }), 2);
});

test('pickFocusIndexOnKey · ArrowUp/ArrowLeft 는 -1, 처음에서는 0 고정', () => {
  assert.equal(pickFocusIndexOnKey({ current: 2, total: 3, key: 'ArrowUp' }), 1);
  assert.equal(pickFocusIndexOnKey({ current: 1, total: 3, key: 'ArrowLeft' }), 0);
  assert.equal(pickFocusIndexOnKey({ current: 0, total: 3, key: 'ArrowUp' }), 0);
});

test('pickFocusIndexOnKey · Home/End 는 항상 0/last', () => {
  assert.equal(pickFocusIndexOnKey({ current: 2, total: 5, key: 'Home' }), 0);
  assert.equal(pickFocusIndexOnKey({ current: 2, total: 5, key: 'End' }), 4);
});

test('pickFocusIndexOnKey · 알 수 없는 키는 안전한 current 를 유지', () => {
  assert.equal(pickFocusIndexOnKey({ current: 2, total: 5, key: 'Tab' }), 2);
  // NaN/음수/범위 밖 current 는 0 으로 폴백된 뒤 그대로 반환.
  assert.equal(pickFocusIndexOnKey({ current: Number.NaN, total: 5, key: 'Escape' }), 0);
  assert.equal(pickFocusIndexOnKey({ current: -3, total: 5, key: 'Escape' }), 0);
  assert.equal(pickFocusIndexOnKey({ current: 99, total: 5, key: 'Escape' }), 0);
});

// ---------------------------------------------------------------------------
// formatAttachmentSummary · 모든 kind 분기 + generatedBy 경로
// ---------------------------------------------------------------------------

test('formatAttachmentSummary · PPTX/이미지/영상 kind 라벨이 각각 매핑된다', () => {
  const pptx = formatAttachmentSummary({
    id: 'p', name: 'deck.pptx', status: 'ready',
    preview: makePreview({ kind: 'pptx', name: 'deck.pptx', pageCount: 12, sizeBytes: 1024 * 1024 }),
  });
  assert.match(pptx, /^PPTX · 12페이지/);
  assert.match(pptx, /1\.0 MB/);

  const image = formatAttachmentSummary({
    id: 'i', name: 'cover.png', status: 'ready',
    preview: makePreview({ kind: 'image', name: 'cover.png', pageCount: undefined, sizeBytes: 300 * 1024 }),
  });
  assert.match(image, /^이미지 · /);
  // 페이지 수가 없는 kind 는 "N페이지" 조각을 붙이지 않아야 한다.
  assert.doesNotMatch(image, /페이지/);

  const video = formatAttachmentSummary({
    id: 'v', name: 'hero.mp4', status: 'ready',
    preview: makePreview({ kind: 'video', name: 'hero.mp4', pageCount: undefined, sizeBytes: 5 * 1024 * 1024 }),
  });
  assert.match(video, /^영상 · /);
  assert.match(video, /5\.0 MB/);
});

test('formatAttachmentSummary · generatedBy.prompt 가 있으면 "생성: …" 조각이 삽입된다', () => {
  const generated = formatAttachmentSummary({
    id: 'g', name: 'hero.mp4', status: 'ready',
    preview: makePreview({
      kind: 'video',
      name: 'hero.mp4',
      pageCount: undefined,
      sizeBytes: 2 * 1024 * 1024,
      generatedBy: { prompt: 'hero shot', adapter: 'stub' },
    }),
  });
  assert.match(generated, /생성: hero shot/);
  // 용량은 항상 마지막 조각.
  assert.ok(generated.trim().endsWith('2.0 MB'));
});

test('formatAttachmentSummary · pageCount 가 0 이면 페이지 조각을 생략한다', () => {
  const zeroPages = formatAttachmentSummary({
    id: 'z', name: 'empty.pdf', status: 'ready',
    preview: makePreview({ pageCount: 0, sizeBytes: 2048 }),
  });
  assert.doesNotMatch(zeroPages, /페이지/);
  assert.match(zeroPages, /^PDF · /);
});

// ---------------------------------------------------------------------------
// classifyDragState · 경계 케이스 (application/x-file · 빈 types · null)
// ---------------------------------------------------------------------------

test('classifyDragState · types 가 비어 있거나 null 이면 idle', () => {
  assert.equal(classifyDragState({ types: [] }), 'idle');
  assert.equal(classifyDragState({ types: null }), 'idle');
  assert.equal(classifyDragState({ types: undefined }), 'idle');
});

test('classifyDragState · application/x-file 도 파일 드래그로 간주해 dragover', () => {
  assert.equal(classifyDragState({ types: ['application/x-file'] }), 'dragover');
});

test('classifyDragState · disabled 가 true 면 types 와 무관하게 disabled', () => {
  assert.equal(classifyDragState({ types: ['Files'], disabled: true }), 'disabled');
  assert.equal(classifyDragState({ types: [], disabled: true }), 'disabled');
});
