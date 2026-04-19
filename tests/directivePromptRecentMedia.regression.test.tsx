// Run with: npx tsx --test tests/directivePromptRecentMedia.regression.test.tsx
//
// 회귀 테스트(#c0ba95a1) — DirectivePrompt 의 "최근 생성된 매체" 블록과 readOnly 게이팅.
// 다섯 불변을 잠근다:
//   1) recentMedia 미전달/빈 배열이면 섹션이 DOM 에 나타나지 않는다.
//   2) 전달 시 kind 배지·파일명·크기·어댑터 칩이 노출된다.
//   3) onMediaDownload 는 readOnlyMode 여부와 무관하게 항상 활성.
//   4) onMediaRegenerate 는 readOnlyMode=true 이면 disabled + data-disabled-reason='read-only'.
//   5) readOnlyMode=false 이면 재생성 클릭 시 콜백에 자산이 그대로 전달.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup } from '@testing-library/react';

import { DirectivePrompt } from '../src/components/DirectivePrompt.tsx';
import type { MediaAsset } from '../src/types.ts';

function asset(partial: Partial<MediaAsset> & { id: string; kind: MediaAsset['kind'] }): MediaAsset {
  return {
    id: partial.id,
    projectId: partial.projectId ?? 'p1',
    kind: partial.kind,
    name: partial.name ?? `${partial.id}.bin`,
    mimeType: partial.mimeType ?? 'application/octet-stream',
    sizeBytes: partial.sizeBytes ?? 0,
    createdAt: partial.createdAt ?? '2026-04-19T00:00:00Z',
    extractedText: partial.extractedText,
    thumbnails: partial.thumbnails,
    generatedBy: partial.generatedBy,
    storageUrl: partial.storageUrl,
  };
}

function mount(args: {
  recentMedia?: ReadonlyArray<MediaAsset>;
  readOnlyMode?: boolean;
  onMediaDownload?: (a: MediaAsset) => void;
  onMediaRegenerate?: (a: MediaAsset) => void;
}) {
  return render(React.createElement(DirectivePrompt, {
    value: '',
    onChange: () => {},
    attachments: [],
    onFilesAdded: () => {},
    onRemove: () => {},
    recentMedia: args.recentMedia,
    readOnlyMode: args.readOnlyMode,
    onMediaDownload: args.onMediaDownload,
    onMediaRegenerate: args.onMediaRegenerate,
  }));
}

test('recentMedia 미전달 — 섹션이 렌더되지 않는다', () => {
  const handle = mount({});
  assert.equal(document.querySelector('[data-testid="directive-prompt-recent-media"]'), null);
  handle.unmount();
  cleanup();
});

test('recentMedia 2건 + 다운로드·재생성 콜백 — 정상 모드에서 둘 다 활성', () => {
  const downloads: MediaAsset[] = [];
  const regens: MediaAsset[] = [];
  const items: MediaAsset[] = [
    asset({ id: 'a1', kind: 'pdf',  name: '리포트.pdf',  sizeBytes: 2048, generatedBy: { adapter: 'stub', prompt: 'x' } }),
    asset({ id: 'a2', kind: 'video', name: '짧은.mp4', sizeBytes: 10 * 1024 * 1024 }),
  ];
  const handle = mount({
    recentMedia: items,
    onMediaDownload: (a) => downloads.push(a),
    onMediaRegenerate: (a) => regens.push(a),
  });
  assert.ok(document.querySelector('[data-testid="directive-prompt-recent-media"]'));
  assert.equal(document.querySelector('[data-testid="directive-media-kind-a1"]')?.textContent, 'PDF');
  assert.equal(document.querySelector('[data-testid="directive-media-kind-a2"]')?.textContent, '영상');

  const dl = document.querySelector('[data-testid="directive-media-download-a1"]') as HTMLButtonElement;
  assert.ok(dl);
  assert.equal(dl.disabled, false);
  act(() => { dl.click(); });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].id, 'a1');

  const regen = document.querySelector('[data-testid="directive-media-regenerate-a2"]') as HTMLButtonElement;
  assert.ok(regen);
  assert.equal(regen.disabled, false);
  act(() => { regen.click(); });
  assert.deepEqual(regens.map((a) => a.id), ['a2']);

  handle.unmount();
  cleanup();
});

test('readOnlyMode=true — 재생성 버튼 비활성·data-disabled-reason 설정, 다운로드는 그대로 활성', () => {
  const downloads: MediaAsset[] = [];
  const regens: MediaAsset[] = [];
  const items = [asset({ id: 'lock', kind: 'pptx', name: '잠김.pptx' })];
  const handle = mount({
    recentMedia: items,
    readOnlyMode: true,
    onMediaDownload: (a) => downloads.push(a),
    onMediaRegenerate: (a) => regens.push(a),
  });

  const dl = document.querySelector('[data-testid="directive-media-download-lock"]') as HTMLButtonElement;
  assert.ok(dl);
  assert.equal(dl.disabled, false, '다운로드는 readOnly 에서도 항상 허용');
  act(() => { dl.click(); });
  assert.equal(downloads.length, 1);

  const regen = document.querySelector('[data-testid="directive-media-regenerate-lock"]') as HTMLButtonElement;
  assert.ok(regen);
  assert.equal(regen.disabled, true, 'readOnly 에서는 재생성 비활성');
  assert.equal(regen.getAttribute('data-disabled-reason'), 'read-only');
  // 비활성 상태에서 클릭해도 콜백이 발사되지 않아야 한다.
  act(() => { regen.click(); });
  assert.equal(regens.length, 0);

  const section = document.querySelector('[data-testid="directive-prompt-recent-media"]');
  assert.equal(section?.getAttribute('data-read-only'), 'true');

  handle.unmount();
  cleanup();
});

test('onMediaRegenerate 미제공 시 재생성 버튼 자체가 DOM 에 없다', () => {
  const handle = mount({
    recentMedia: [asset({ id: 'q', kind: 'image' })],
    onMediaDownload: () => {},
    // onMediaRegenerate 미제공
  });
  assert.equal(document.querySelector('[data-testid="directive-media-regenerate-q"]'), null);
  // 다운로드 버튼은 존재.
  assert.ok(document.querySelector('[data-testid="directive-media-download-q"]'));
  handle.unmount();
  cleanup();
});
