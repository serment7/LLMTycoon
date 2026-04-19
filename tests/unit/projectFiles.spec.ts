// Run with: npx tsx --test tests/unit/projectFiles.spec.ts
//
// 지시 #1fd1b3c6 — 프로젝트별 파일 저장소의 순수 계약 테스트. 브라우저 IDB 는 Node
// 전역에 없으므로 `createMemoryProjectFileStorage` 를 주입해 계약을 돌리고, IDB 팩토리
// 는 폴백 경로를 확인하는 스모크로 한 번 돌린다(draftStore.spec.ts 와 동일 구도).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  categorizeFile,
  createIndexedDbProjectFileStorage,
  createMemoryProjectFileStorage,
  createProjectFileStore,
} from '../../src/store/projectFiles.ts';

// Node 20+ 에도 File 전역이 있으나 타입 정의가 선언만 되어 있어 생성자 호출이 필요.
// 일부 tsx 런타임에서는 `File` 글로벌이 없을 수 있으니 폴리필을 대비해 Blob 기반 래퍼를 둔다.
type FileCtor = new (bits: BlobPart[], name: string, opts?: FilePropertyBag) => File;
const FileImpl: FileCtor = (globalThis as { File?: FileCtor }).File ?? class FakeFile extends Blob {
  name: string;
  lastModified: number;
  constructor(bits: BlobPart[], name: string, opts?: FilePropertyBag) {
    super(bits, opts);
    this.name = name;
    this.lastModified = opts?.lastModified ?? Date.now();
  }
} as unknown as FileCtor;

function fakeFile(name: string, type: string, body = 'x'): File {
  return new FileImpl([body], name, { type });
}

test('categorizeFile — MIME 과 확장자를 겹쳐 보고 이미지/영상/PDF/PPT/기타로 분류', () => {
  assert.equal(categorizeFile('image/png', 'cover.png'), 'image');
  assert.equal(categorizeFile('', 'thumb.jpg'), 'image');
  assert.equal(categorizeFile('video/mp4', 'teaser.mp4'), 'video');
  assert.equal(categorizeFile('application/pdf', 'spec.pdf'), 'pdf');
  assert.equal(categorizeFile('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx'), 'ppt');
  assert.equal(categorizeFile('', 'notes.ppt'), 'ppt');
  assert.equal(categorizeFile('application/zip', 'archive.zip'), 'etc');
});

test('upload — 메타데이터 + Blob 이 동시에 저장되고 category 가 MIME 기반으로 결정된다', async () => {
  const adapter = createMemoryProjectFileStorage();
  let id = 0;
  const store = createProjectFileStore({
    adapter,
    now: () => 100,
    newId: () => `file-${++id}`,
  });
  const rec = await store.upload('proj-A', fakeFile('cover.png', 'image/png', 'abcd'));
  assert.equal(rec.projectId, 'proj-A');
  assert.equal(rec.fileId, 'file-1');
  assert.equal(rec.category, 'image');
  assert.equal(rec.size, 4);
  assert.equal(rec.uploadedAt, 100);
  const blob = await store.getBlob('proj-A', 'file-1');
  assert.ok(blob);
  assert.equal(blob!.size, 4);
});

test('list — 프로젝트 단위로 격리되고 uploadedAt 내림차순', async () => {
  let t = 0;
  let id = 0;
  const store = createProjectFileStore({
    adapter: createMemoryProjectFileStorage(),
    now: () => ++t,
    newId: () => `f-${++id}`,
  });
  await store.upload('A', fakeFile('1.png', 'image/png'));
  await store.upload('B', fakeFile('2.mp4', 'video/mp4'));
  await store.upload('A', fakeFile('3.pdf', 'application/pdf'));

  const aList = await store.list('A');
  assert.deepEqual(aList.map((r) => r.name), ['3.pdf', '1.png']);
  const bList = await store.list('B');
  assert.deepEqual(bList.map((r) => r.name), ['2.mp4']);
});

test('remove — 자기 프로젝트 파일만 지우고 타 프로젝트 요청은 no-op', async () => {
  let id = 0;
  const store = createProjectFileStore({
    adapter: createMemoryProjectFileStorage(),
    newId: () => `f-${++id}`,
  });
  const a1 = await store.upload('A', fakeFile('a.png', 'image/png'));
  const b1 = await store.upload('B', fakeFile('b.png', 'image/png'));

  // B 가 A 의 파일 id 로 remove 요청 — 침범되지 않는다.
  await store.remove('B', a1.fileId);
  assert.equal((await store.list('A')).length, 1);

  await store.remove('A', a1.fileId);
  assert.equal((await store.list('A')).length, 0);
  assert.equal(await store.getBlob('A', a1.fileId), null);
  // B 파일은 그대로.
  assert.equal((await store.list('B'))[0].fileId, b1.fileId);
});

test('removeAll — 프로젝트 삭제 cascade. 삭제 개수 반환 + 타 프로젝트 보존', async () => {
  let id = 0;
  const store = createProjectFileStore({
    adapter: createMemoryProjectFileStorage(),
    newId: () => `f-${++id}`,
  });
  await store.upload('A', fakeFile('1.png', 'image/png'));
  await store.upload('A', fakeFile('2.mp4', 'video/mp4'));
  await store.upload('A', fakeFile('3.pdf', 'application/pdf'));
  await store.upload('B', fakeFile('b.png', 'image/png'));

  const removed = await store.removeAll('A');
  assert.equal(removed, 3);
  assert.deepEqual(await store.list('A'), []);
  assert.equal((await store.list('B')).length, 1);
});

test('subscribe — upload/remove/removeAll 시 구독자에게 통지', async () => {
  let id = 0;
  const store = createProjectFileStore({
    adapter: createMemoryProjectFileStorage(),
    newId: () => `f-${++id}`,
  });
  const calls: string[] = [];
  const unsubscribe = store.subscribe('A', () => calls.push('A'));
  store.subscribe('B', () => calls.push('B'));

  await store.upload('A', fakeFile('x.png', 'image/png'));
  const f = await store.upload('A', fakeFile('y.png', 'image/png'));
  await store.upload('B', fakeFile('z.png', 'image/png'));
  await store.remove('A', f.fileId);
  await store.removeAll('A');

  assert.ok(calls.filter((c) => c === 'A').length >= 3);
  assert.ok(calls.includes('B'));

  unsubscribe();
  calls.length = 0;
  await store.upload('A', fakeFile('after.png', 'image/png'));
  // A 구독 해지 이후로는 A 가 찍히지 않는다.
  assert.equal(calls.includes('A'), false);
});

test('clearAll — 모든 프로젝트의 메타/Blob 이 비워진다', async () => {
  const store = createProjectFileStore({ adapter: createMemoryProjectFileStorage() });
  await store.upload('A', fakeFile('1.png', 'image/png'));
  await store.upload('B', fakeFile('2.pdf', 'application/pdf'));
  await store.clearAll();
  assert.deepEqual(await store.list('A'), []);
  assert.deepEqual(await store.list('B'), []);
});

test('IDB 팩토리 — Node 환경(IDB 미존재)에서는 메모리 폴백으로 계약 유지', async () => {
  const adapter = createIndexedDbProjectFileStorage();
  const store = createProjectFileStore({ adapter });
  const rec = await store.upload('Z', fakeFile('ok.png', 'image/png'));
  const list = await store.list('Z');
  assert.equal(list[0].fileId, rec.fileId);
});
