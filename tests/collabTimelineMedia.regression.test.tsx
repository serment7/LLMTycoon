// Run with: npx tsx --test tests/collabTimelineMedia.regression.test.tsx
//
// 회귀 테스트(#c0ba95a1) — CollabTimeline 의 "최근 생성된 매체" 섹션 렌더링 계약.
// 네 불변을 잠근다:
//   1) mediaEvents 미전달/빈 배열이면 섹션이 DOM 에 아예 렌더되지 않는다.
//   2) 이벤트가 전달되면 헤더 개수·각 row 의 kind·크기·어댑터 칩이 노출된다.
//   3) onMediaDownload 가 주어지면 다운로드 버튼이 클릭 시 이벤트를 그대로 전달.
//   4) 재생성 버튼은 CollabTimeline 에 없다(DirectivePrompt 축이 전담).

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup } from '@testing-library/react';

import { CollabTimeline } from '../src/components/CollabTimeline.tsx';
import type { MediaTimelineEvent } from '../src/types.ts';

function event(overrides: Partial<MediaTimelineEvent['mediaAsset']> & { id: string }, at = '2026-04-19T12:00:00Z'): MediaTimelineEvent {
  const asset: MediaTimelineEvent['mediaAsset'] = {
    id: overrides.id,
    kind: overrides.kind ?? 'video',
    name: overrides.name ?? `${overrides.id}.bin`,
    createdAt: at,
    sizeBytes: overrides.sizeBytes ?? 0,
    generatedBy: overrides.generatedBy,
  };
  return { id: `media-${asset.id}`, kind: 'media', at, mediaAsset: asset, summary: `${asset.kind.toUpperCase()} · ${asset.name}` };
}

function mount(events: MediaTimelineEvent[] | undefined, onDownload?: (e: MediaTimelineEvent) => void) {
  return render(React.createElement(CollabTimeline, {
    entries: [],
    mediaEvents: events,
    onMediaDownload: onDownload,
  }));
}

test('mediaEvents 미전달 — 섹션이 렌더되지 않는다', () => {
  const handle = mount(undefined);
  assert.equal(document.querySelector('[data-testid="collab-timeline-media"]'), null);
  handle.unmount();
  cleanup();
});

test('mediaEvents 빈 배열 — 섹션 여전히 숨겨진다', () => {
  const handle = mount([]);
  assert.equal(document.querySelector('[data-testid="collab-timeline-media"]'), null);
  handle.unmount();
  cleanup();
});

test('mediaEvents 3건 — 헤더·개수·각 row 의 kind 배지가 노출된다', () => {
  const events: MediaTimelineEvent[] = [
    event({ id: 'm1', kind: 'pdf',  name: '결제 보고서.pdf',      sizeBytes: 1024 }),
    event({ id: 'm2', kind: 'pptx', name: '2026 Q2 제안.pptx',     sizeBytes: 1024 * 1024, generatedBy: { adapter: 'stub', prompt: '' } }),
    event({ id: 'm3', kind: 'video', name: '소개 영상.mp4',        sizeBytes: 1024 * 1024 * 10 }),
  ];
  const handle = mount(events);
  const section = document.querySelector('[data-testid="collab-timeline-media"]');
  assert.ok(section);
  const count = document.querySelector('[data-testid="collab-timeline-media-count"]');
  assert.match(count?.textContent ?? '', /3/);
  assert.equal(document.querySelector('[data-testid="collab-timeline-media-kind-m1"]')?.textContent, 'PDF');
  assert.equal(document.querySelector('[data-testid="collab-timeline-media-kind-m2"]')?.textContent, 'PPT');
  assert.equal(document.querySelector('[data-testid="collab-timeline-media-kind-m3"]')?.textContent, '영상');
  assert.match(document.querySelector('[data-testid="collab-timeline-media-size-m1"]')?.textContent ?? '', /KB|B/);
  assert.match(document.querySelector('[data-testid="collab-timeline-media-adapter-m2"]')?.textContent ?? '', /stub/);
  // 썸네일은 플레이스홀더 아이콘만 — 썸네일 이미지는 아직 없다.
  assert.ok(document.querySelector('[data-testid="collab-timeline-media-thumb-m1"]'));
  handle.unmount();
  cleanup();
});

test('onMediaDownload — 다운로드 버튼 클릭 시 event 가 콜백으로 전달된다', () => {
  const received: MediaTimelineEvent[] = [];
  const e = event({ id: 'download-me', kind: 'image', name: '포스터.png' });
  const handle = mount([e], (ev) => received.push(ev));
  const btn = document.querySelector('[data-testid="collab-timeline-media-download-download-me"]') as HTMLButtonElement;
  assert.ok(btn);
  act(() => { btn.click(); });
  assert.equal(received.length, 1);
  assert.equal(received[0].mediaAsset.id, 'download-me');
  handle.unmount();
  cleanup();
});

test('CollabTimeline 에는 재생성 버튼이 없다(축 분리 보장)', () => {
  const e = event({ id: 'no-regen', kind: 'pdf', name: 'x.pdf' });
  const handle = mount([e], () => {});
  assert.equal(document.querySelector('[data-testid^="collab-timeline-media-regenerate-"]'), null);
  handle.unmount();
  cleanup();
});
