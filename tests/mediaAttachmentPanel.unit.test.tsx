// Run with: npx tsx --test tests/mediaAttachmentPanel.unit.test.tsx
//
// 단위 테스트: src/components/MediaAttachmentPanel.tsx — 지시 #f6052a91 의 UI 스켈레톤
// 계약. DirectivePrompt 통합 전 단계이므로 동작 매트릭스는 "표시 / 제거 / 생성 요청
// / 빈 상태 / 훅" 5 축만 잠근다.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup, fireEvent } from '@testing-library/react';

import {
  MediaAttachmentPanel,
  useMediaAttachmentPanel,
} from '../src/components/MediaAttachmentPanel.tsx';
import type { MediaAsset } from '../src/types.ts';

function makeAsset(partial: Partial<MediaAsset> & { id: string; kind: MediaAsset['kind'] }): MediaAsset {
  return {
    id: partial.id,
    projectId: partial.projectId ?? 'p1',
    kind: partial.kind,
    name: partial.name ?? `${partial.id}.bin`,
    mimeType: partial.mimeType ?? 'application/octet-stream',
    sizeBytes: partial.sizeBytes ?? 0,
    createdAt: partial.createdAt ?? '2026-04-19T00:00:00.000Z',
    extractedText: partial.extractedText,
    thumbnails: partial.thumbnails,
    generatedBy: partial.generatedBy,
    storageUrl: partial.storageUrl,
  };
}

test('MediaAttachmentPanel — 자산이 없으면 빈 상태 안내를 보여준다', () => {
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets: [],
      onFilesAdded: () => {},
      onRemove: () => {},
    }),
  );
  const empty = document.querySelector('[data-testid="media-attachment-empty"]');
  assert.ok(empty, '빈 상태 안내가 렌더되어야 한다');
  assert.match(empty!.textContent ?? '', /아직 첨부된 미디어가 없습니다/);
  handle.unmount();
  cleanup();
});

test('MediaAttachmentPanel — 자산 리스트의 kind 라벨·data-testid 가 각 자산마다 붙는다', () => {
  const assets: MediaAsset[] = [
    makeAsset({ id: 'a1', kind: 'pdf', name: '요약.pdf' }),
    makeAsset({ id: 'a2', kind: 'video', name: '소개.mp4' }),
    makeAsset({ id: 'a3', kind: 'image', name: '표지.png' }),
    makeAsset({ id: 'a4', kind: 'pptx', name: '발표.pptx' }),
  ];
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets,
      onFilesAdded: () => {},
      onRemove: () => {},
    }),
  );
  for (const a of assets) {
    const row = document.querySelector(`[data-testid="media-asset-${a.id}"]`);
    assert.ok(row, `자산 ${a.id} 가 렌더되어야 한다`);
    assert.equal(row!.getAttribute('data-kind'), a.kind);
  }
  assert.equal(
    document.querySelector('[data-testid="media-asset-kind-a1"]')!.textContent,
    'PDF',
  );
  assert.equal(
    document.querySelector('[data-testid="media-asset-kind-a2"]')!.textContent,
    '영상',
  );
  assert.equal(
    document.querySelector('[data-testid="media-asset-kind-a3"]')!.textContent,
    '이미지',
  );
  assert.equal(
    document.querySelector('[data-testid="media-asset-kind-a4"]')!.textContent,
    'PPT',
  );
  handle.unmount();
  cleanup();
});

test('MediaAttachmentPanel — 제거 버튼 클릭 시 onRemove(id) 콜백이 호출된다', () => {
  const removed: string[] = [];
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets: [makeAsset({ id: 'x1', kind: 'pdf', name: '보고서.pdf' })],
      onFilesAdded: () => {},
      onRemove: (id: string) => { removed.push(id); },
    }),
  );
  const btn = document.querySelector('[data-testid="media-asset-remove-x1"]') as HTMLButtonElement;
  assert.ok(btn);
  act(() => { btn.click(); });
  assert.deepEqual(removed, ['x1']);
  handle.unmount();
  cleanup();
});

test('MediaAttachmentPanel — onGenerate 제공 시 생성 패널이 열리고 빈 프롬프트는 제출 불가', () => {
  const gens: Array<{ kind: string; prompt: string }> = [];
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets: [],
      onFilesAdded: () => {},
      onRemove: () => {},
      onGenerate: (p) => { gens.push(p); },
    }),
  );
  const panel = document.querySelector('[data-testid="media-generate-panel"]');
  assert.ok(panel, '생성 패널이 렌더되어야 한다');
  const submit = document.querySelector('[data-testid="media-generate-submit"]') as HTMLButtonElement;
  assert.equal(submit.disabled, true, '빈 프롬프트는 제출 불가');

  const textarea = document.querySelector('[data-testid="media-generate-prompt"]') as HTMLTextAreaElement;
  act(() => { fireEvent.change(textarea, { target: { value: '한 줄 영상 아이디어' } }); });
  assert.equal(submit.disabled, false);

  act(() => { submit.click(); });
  assert.deepEqual(gens, [{ kind: 'video', prompt: '한 줄 영상 아이디어' }]);

  handle.unmount();
  cleanup();
});

test('MediaAttachmentPanel — onGenerate 미제공이면 생성 패널이 숨겨진다(업로드 전용 모드)', () => {
  const handle = render(
    React.createElement(MediaAttachmentPanel, {
      assets: [],
      onFilesAdded: () => {},
      onRemove: () => {},
    }),
  );
  assert.equal(document.querySelector('[data-testid="media-generate-panel"]'), null);
  handle.unmount();
  cleanup();
});

test('useMediaAttachmentPanel — addAssets/removeAsset/clear 기본 흐름', () => {
  let api: ReturnType<typeof useMediaAttachmentPanel> | null = null;
  function Host() {
    api = useMediaAttachmentPanel();
    return null;
  }
  const handle = render(React.createElement(Host));
  assert.ok(api);
  assert.deepEqual(api!.assets, []);

  act(() => {
    api!.addAssets([makeAsset({ id: 'm1', kind: 'pdf' })]);
  });
  assert.equal(api!.assets.length, 1);

  act(() => {
    api!.addAssets([makeAsset({ id: 'm2', kind: 'video' })]);
  });
  assert.equal(api!.assets.length, 2);

  act(() => { api!.removeAsset('m1'); });
  assert.equal(api!.assets.length, 1);
  assert.equal(api!.assets[0].id, 'm2');

  act(() => { api!.clear(); });
  assert.equal(api!.assets.length, 0);

  handle.unmount();
  cleanup();
});
