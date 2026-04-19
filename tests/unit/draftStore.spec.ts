// Run with: npx tsx --test tests/unit/draftStore.spec.ts
//
// 지시 #222ece09 §2 — IndexedDB 래퍼 초안 저장소의 순수 계약 테스트.
// 실제 IDB 는 브라우저 전역이라 Node 테스트에서는 `createMemoryDraftStorage` 를
// 주입해 동일 계약을 돌린다. 브라우저 어댑터는 `createIndexedDbDraftStorage` 안에서
// `globalThis.indexedDB` 미존재 시 자동으로 메모리 폴백으로 수렴하도록 설계됐다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDraftStore,
  createMemoryDraftStorage,
  createIndexedDbDraftStorage,
  type DraftEnvelope,
} from '../../src/utils/draftStore.ts';
import type { MediaChatAttachment } from '../../src/utils/mediaLoaders.ts';

function sampleAttachment(over: Partial<MediaChatAttachment> = {}): MediaChatAttachment {
  return {
    id: 'att-1', kind: 'pdf', name: 'report.pdf', mimeType: 'application/pdf',
    sizeBytes: 1024, summary: 'PDF · 1KB · report.pdf',
    ...over,
  };
}

test('save/load — 같은 대화 id 로 저장한 초안이 그대로 돌아온다', async () => {
  const store = createDraftStore({ adapter: createMemoryDraftStorage(), now: () => 1000 });
  await store.save('conv-A', { conversationId: 'conv-A', bodyText: '안녕', attachments: [sampleAttachment()] });
  const loaded = await store.load('conv-A');
  assert.ok(loaded);
  assert.equal(loaded!.bodyText, '안녕');
  assert.equal(loaded!.attachments.length, 1);
  assert.equal(loaded!.savedAtMs, 1000);
  assert.equal(loaded!.schemaVersion, 1);
});

test('대화별 격리 — 서로 다른 id 는 서로의 초안을 침범하지 않는다', async () => {
  const store = createDraftStore({ adapter: createMemoryDraftStorage() });
  await store.save('conv-A', { conversationId: 'conv-A', bodyText: 'A', attachments: [] });
  await store.save('conv-B', { conversationId: 'conv-B', bodyText: 'B', attachments: [sampleAttachment({ id: 'b1' })] });
  const a = await store.load('conv-A');
  const b = await store.load('conv-B');
  assert.equal(a?.bodyText, 'A');
  assert.equal(b?.bodyText, 'B');
  assert.equal(b?.attachments[0].id, 'b1');
});

test('remove — 단일 대화 초안만 제거, 나머지는 유지', async () => {
  const store = createDraftStore({ adapter: createMemoryDraftStorage() });
  await store.save('conv-A', { conversationId: 'conv-A', bodyText: 'A', attachments: [] });
  await store.save('conv-B', { conversationId: 'conv-B', bodyText: 'B', attachments: [] });
  await store.remove('conv-A');
  assert.equal(await store.load('conv-A'), null);
  const b = await store.load('conv-B');
  assert.equal(b?.bodyText, 'B');
});

test('listAll — 최신 저장 순(savedAtMs 내림차순)으로 돌려준다', async () => {
  let t = 0;
  const store = createDraftStore({ adapter: createMemoryDraftStorage(), now: () => ++t });
  await store.save('conv-A', { conversationId: 'conv-A', bodyText: 'A', attachments: [] });
  await store.save('conv-B', { conversationId: 'conv-B', bodyText: 'B', attachments: [] });
  await store.save('conv-C', { conversationId: 'conv-C', bodyText: 'C', attachments: [] });
  const all = await store.listAll();
  assert.deepEqual(all.map(e => e.conversationId), ['conv-C', 'conv-B', 'conv-A']);
});

test('load — conversationId 가 키와 다른 봉투는 null 로 거절(손상 방지)', async () => {
  const adapter = createMemoryDraftStorage();
  // 엉뚱한 키로 봉투를 심어 두고 load 가 이를 감지하는지 확인.
  const tampered: DraftEnvelope = {
    schemaVersion: 1, conversationId: 'conv-X', bodyText: 'X', attachments: [], savedAtMs: 1,
  };
  await adapter.put('conv-A', tampered);
  const store = createDraftStore({ adapter });
  const loaded = await store.load('conv-A');
  assert.equal(loaded, null);
});

test('clearAll — 전역 초기화. listAll 이 빈 배열', async () => {
  const store = createDraftStore({ adapter: createMemoryDraftStorage() });
  await store.save('conv-A', { conversationId: 'conv-A', bodyText: 'A', attachments: [] });
  await store.save('conv-B', { conversationId: 'conv-B', bodyText: 'B', attachments: [] });
  await store.clearAll();
  assert.deepEqual(await store.listAll(), []);
});

test('createIndexedDbDraftStorage — Node 환경(IDB 미존재)에서는 메모리 폴백으로 계약 유지', async () => {
  // Node 20+ 전역에 indexedDB 가 없다. 폴백이 동작하면 저장·로드가 성립한다.
  const adapter = createIndexedDbDraftStorage();
  const store = createDraftStore({ adapter });
  await store.save('conv-Z', { conversationId: 'conv-Z', bodyText: 'Z', attachments: [] });
  const loaded = await store.load('conv-Z');
  assert.equal(loaded?.bodyText, 'Z');
});
