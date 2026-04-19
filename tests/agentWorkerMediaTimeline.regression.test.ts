// Run with: npx tsx --test tests/agentWorkerMediaTimeline.regression.test.ts
//
// 회귀 테스트: `src/server/agentWorker.ts` 의 MediaAsset → CollabTimeline 브리지.
// 지시 #b425328e §3 — 에이전트 결과 파이프라인에서 생성된 MediaAsset 이
// `TimelineEvent` 로 변환되어 등록된 emitter 로 흘러가는 계약을 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  notifyAgentMediaGenerated,
  resetMediaTimelineEmitter,
  setMediaTimelineEmitter,
} from '../src/server/agentWorker.ts';
import type { MediaAsset, MediaTimelineEvent } from '../src/types.ts';
import { mediaAssetToTimelineEvent } from '../src/types.ts';

function sampleAsset(): MediaAsset {
  return {
    id: 'asset-1',
    projectId: 'proj-1',
    kind: 'pdf',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    createdAt: '2026-04-19T00:00:00.000Z',
    generatedBy: { adapter: 'pdf-mock', prompt: '보고서 제목' },
  };
}

test('emitter 미등록 시 notifyAgentMediaGenerated 는 no-op 로 null 을 돌려준다', () => {
  resetMediaTimelineEmitter();
  const result = notifyAgentMediaGenerated(sampleAsset());
  assert.equal(result, null);
});

test('emitter 등록 후에는 MediaTimelineEvent 가 생성되어 싱크로 방출된다', () => {
  resetMediaTimelineEmitter();
  const received: MediaTimelineEvent[] = [];
  setMediaTimelineEmitter(e => received.push(e));
  const asset = sampleAsset();
  const result = notifyAgentMediaGenerated(asset, { from: 'system', to: 'leader' });
  assert.ok(result, '이벤트 객체를 돌려주어야 한다');
  assert.equal(received.length, 1, '등록된 emitter 가 한 번 호출되어야 한다');
  const event = received[0];
  assert.equal(event.kind, 'media');
  assert.equal(event.from, 'system');
  assert.equal(event.to, 'leader');
  assert.equal(event.mediaAsset.id, 'asset-1');
  assert.equal(event.mediaAsset.kind, 'pdf');
  assert.equal(event.mediaAsset.name, 'report.pdf');
  resetMediaTimelineEmitter();
});

test('emitter 예외는 파이프라인을 중단시키지 않는다 (안전망)', () => {
  resetMediaTimelineEmitter();
  setMediaTimelineEmitter(() => { throw new Error('boom'); });
  // 예외가 던져지지 않아야 한다.
  const result = notifyAgentMediaGenerated(sampleAsset());
  // emitter 예외가 내부적으로 잡혔어도 event 자체는 반환된다 — 계약상 이벤트
  // 생성 자체는 성공한 것으로 본다(싱크 장애와 무관).
  assert.ok(result);
  resetMediaTimelineEmitter();
});

test('mediaAssetToTimelineEvent — 필수 필드 투영이 올바르다', () => {
  const asset = sampleAsset();
  const event = mediaAssetToTimelineEvent(asset, { from: 'a', to: 'b' });
  assert.equal(event.kind, 'media');
  assert.equal(event.id, 'media-asset-1');
  assert.equal(event.at, asset.createdAt);
  assert.equal(event.from, 'a');
  assert.equal(event.to, 'b');
  assert.match(event.summary ?? '', /PDF · report\.pdf/);
  // buffer/storageUrl 같은 본체는 포함되지 않아야 한다 — 타임라인은 메타만.
  const mediaKeys = Object.keys(event.mediaAsset).sort();
  assert.deepEqual(mediaKeys, ['createdAt', 'generatedBy', 'id', 'kind', 'name', 'sizeBytes']);
});
