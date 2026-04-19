// Run with: npx tsx --test tests/mediaAssetStore.regression.test.ts
//
// 회귀 테스트: `src/server/mediaAssetStore.ts` 의 프로젝트 단위 MediaAsset 저장소
// 계약을 잠근다. 토큰 사용량 저장소(`claudeTokenUsageStore`) 와 분리돼 있음을
// 호출·모듈 참조 그래프 수준에서 재확인한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  createMediaAssetStore,
  getMediaAssetStore,
  resetMediaAssetStore,
} from '../src/server/mediaAssetStore.ts';
import type { MediaAsset } from '../src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = resolve(__dirname, '..', 'src', 'server', 'mediaAssetStore.ts');

function makeAsset(id: string, projectId = 'p1', kind: MediaAsset['kind'] = 'pdf'): MediaAsset {
  return {
    id,
    projectId,
    kind,
    name: `${id}.${kind}`,
    mimeType: kind === 'pdf' ? 'application/pdf' : 'application/octet-stream',
    sizeBytes: 1024,
    createdAt: new Date().toISOString(),
  };
}

test('save → get 으로 동일한 레코드를 돌려준다', () => {
  const store = createMediaAssetStore();
  const a = makeAsset('a1');
  store.save(a);
  assert.deepEqual(store.get('a1'), a);
  assert.equal(store.get('missing'), null);
});

test('listByProject 는 최신 저장 순으로 돌려준다 (unshift)', () => {
  const store = createMediaAssetStore();
  store.save(makeAsset('first', 'p1'));
  store.save(makeAsset('second', 'p1'));
  store.save(makeAsset('third', 'p1'));
  const list = store.listByProject('p1');
  assert.deepEqual(list.map(a => a.id), ['third', 'second', 'first']);
});

test('동일 id 재저장은 중복 없이 최신 앞으로 재삽입된다', () => {
  const store = createMediaAssetStore();
  store.save(makeAsset('x', 'p1'));
  store.save(makeAsset('y', 'p1'));
  const updated = { ...makeAsset('x', 'p1'), name: 'x-updated.pdf' };
  store.save(updated);
  const list = store.listByProject('p1');
  assert.equal(list.length, 2, '중복되지 않아야 한다');
  assert.equal(list[0].id, 'x');
  assert.equal(list[0].name, 'x-updated.pdf');
});

test('프로젝트 격리 — 다른 projectId 는 서로 보이지 않는다', () => {
  const store = createMediaAssetStore();
  store.save(makeAsset('a', 'p1'));
  store.save(makeAsset('b', 'p2'));
  assert.equal(store.listByProject('p1').length, 1);
  assert.equal(store.listByProject('p2').length, 1);
  assert.equal(store.listByProject('p3').length, 0);
});

test('getMediaAssetStore 싱글톤 — 같은 인스턴스를 돌려주고 reset 으로 초기화된다', () => {
  resetMediaAssetStore();
  const s1 = getMediaAssetStore();
  const s2 = getMediaAssetStore();
  assert.equal(s1, s2, '같은 싱글톤이어야 한다');
  s1.save(makeAsset('singleton-a'));
  assert.equal(s1.listByProject('p1').length, 1);
  resetMediaAssetStore();
  const s3 = getMediaAssetStore();
  assert.notEqual(s1, s3, 'reset 후에는 새 인스턴스여야 한다');
  assert.equal(s3.listByProject('p1').length, 0, 'reset 후 초기 상태여야 한다');
});

test('mediaAssetStore.ts 는 claudeTokenUsageStore 를 import 하지 않는다 (축 분리 계약)', () => {
  const src = readFileSync(STORE_PATH, 'utf8');
  assert.doesNotMatch(
    src,
    /from\s+['"][^'"]*claudeTokenUsageStore['"]/,
    '두 저장소는 서로 다른 축 — MediaAsset 저장소가 토큰 사용량 저장소를 참조하면 안 된다',
  );
});
