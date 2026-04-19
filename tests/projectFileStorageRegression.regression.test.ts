// Run with: npx tsx --test tests/projectFileStorageRegression.regression.test.ts
//
// 회귀 테스트: 프로젝트별 파일(MediaAsset) 저장소의 5개 시나리오 묶음.
//   A. 프로젝트 간 격리 (A 에 올린 파일이 B 에 보이지 않는다)
//   B. 타입별(이미지/영상/PDF/PPT) 업로드·조회·삭제 플로우
//   C. 프로젝트 삭제 시 cascade — 현재 인터페이스 갭을 잠가 회귀를 고지한다
//   D. 페이지 새로고침 / 서버 재기동 이후 persist 복원 상태
//   E. 대용량·동일 파일명·UNSUPPORTED_KIND 엣지 케이스
//
// 본 스펙은 "이미 존재하는 계약" 과 "알려진 갭" 을 모두 테스트한다. 갭 테스트는
// 누락 사실이 바뀌지 않음을 확인하는 회귀 감시용이며, 향후 cascade 구현이 들어오면
// 해당 테스트를 빨강으로 전환해 교체 시점을 알아챈다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  createMediaAssetStore,
  getMediaAssetStore,
  resetMediaAssetStore,
  type MediaAssetStore,
} from '../src/server/mediaAssetStore.ts';
import type { MediaAsset, MediaKind } from '../src/types.ts';
import {
  DEFAULT_MAX_BYTES,
  detectMediaKind,
} from '../src/utils/mediaLoaders.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, '..', 'server.ts');
const STORE_PATH = resolve(__dirname, '..', 'src', 'server', 'mediaAssetStore.ts');

// ────────────────────────────────────────────────────────────────────────────
// 헬퍼 — kind 별로 합당한 mimeType 을 채운 MediaAsset 스텁
// ────────────────────────────────────────────────────────────────────────────

function mimeFor(kind: MediaKind): string {
  switch (kind) {
    case 'pdf': return 'application/pdf';
    case 'image': return 'image/png';
    case 'video': return 'video/mp4';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
}

function makeAsset(params: {
  id: string;
  projectId: string;
  kind: MediaKind;
  name?: string;
  sizeBytes?: number;
}): MediaAsset {
  return {
    id: params.id,
    projectId: params.projectId,
    kind: params.kind,
    name: params.name ?? `${params.id}.${params.kind === 'pptx' ? 'pptx' : params.kind}`,
    mimeType: mimeFor(params.kind),
    sizeBytes: params.sizeBytes ?? 2048,
    createdAt: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CAT-A · 프로젝트 간 격리
// ────────────────────────────────────────────────────────────────────────────

test('CAT-A-1: 프로젝트 A 자산은 프로젝트 B 의 목록에 노출되지 않는다', () => {
  const store = createMediaAssetStore();
  store.save(makeAsset({ id: 'a-pdf', projectId: 'projA', kind: 'pdf' }));
  store.save(makeAsset({ id: 'a-img', projectId: 'projA', kind: 'image' }));
  store.save(makeAsset({ id: 'b-video', projectId: 'projB', kind: 'video' }));

  const aList = store.listByProject('projA');
  const bList = store.listByProject('projB');

  assert.equal(aList.length, 2, 'A 의 목록은 A 자산만 포함');
  assert.equal(bList.length, 1, 'B 의 목록은 B 자산만 포함');
  assert.ok(aList.every(x => x.projectId === 'projA'));
  assert.ok(bList.every(x => x.projectId === 'projB'));
  // id 레벨 교차 검증 — A 의 id 가 B 목록에 섞이지 않는다
  assert.equal(bList.find(x => x.id === 'a-pdf'), undefined);
  assert.equal(bList.find(x => x.id === 'a-img'), undefined);
  assert.equal(aList.find(x => x.id === 'b-video'), undefined);
});

test('CAT-A-2: get(id) 은 전역 인덱스라 id 만 알면 프로젝트와 무관하게 조회되지만, listByProject 로 내려오면 타 프로젝트는 걸러진다', () => {
  const store = createMediaAssetStore();
  const a = makeAsset({ id: 'shared-id-a', projectId: 'projA', kind: 'pdf' });
  const b = makeAsset({ id: 'shared-id-b', projectId: 'projB', kind: 'pdf' });
  store.save(a);
  store.save(b);

  // get 은 id 가 유니크면 정확히 하나를 돌려준다 — 저장소의 "자산 원장" 역할
  assert.deepEqual(store.get('shared-id-a'), a);
  assert.deepEqual(store.get('shared-id-b'), b);

  // listByProject 는 격리됨
  assert.deepEqual(store.listByProject('projA').map(x => x.id), ['shared-id-a']);
  assert.deepEqual(store.listByProject('projB').map(x => x.id), ['shared-id-b']);
});

test('CAT-A-3: 존재하지 않는 프로젝트 조회는 빈 배열 (크로스 노출 없음)', () => {
  const store = createMediaAssetStore();
  store.save(makeAsset({ id: 'x', projectId: 'projA', kind: 'image' }));
  const list = store.listByProject('unknown-project');
  assert.deepEqual(list, []);
});

// ────────────────────────────────────────────────────────────────────────────
// CAT-B · 타입별 업로드·조회·삭제
// ────────────────────────────────────────────────────────────────────────────

test('CAT-B-1: 4 종 MediaKind(이미지/영상/PDF/PPTX) 업로드 시 모두 listByProject 로 최신순 조회', () => {
  const store = createMediaAssetStore();
  const kinds: MediaKind[] = ['image', 'video', 'pdf', 'pptx'];
  for (const k of kinds) {
    store.save(makeAsset({ id: `${k}-1`, projectId: 'projA', kind: k }));
  }
  const list = store.listByProject('projA');
  assert.equal(list.length, 4);
  // unshift 규칙: 가장 늦게 저장된 pptx 가 앞
  assert.deepEqual(list.map(a => a.kind), ['pptx', 'pdf', 'video', 'image']);
});

test('CAT-B-2: get(id) 은 kind·mimeType·sizeBytes 를 저장 당시 그대로 돌려준다 (다운로드 메타 재사용)', () => {
  const store = createMediaAssetStore();
  const img = makeAsset({ id: 'i1', projectId: 'projA', kind: 'image', sizeBytes: 12345 });
  store.save(img);
  const got = store.get('i1');
  assert.ok(got);
  assert.equal(got.mimeType, 'image/png');
  assert.equal(got.sizeBytes, 12345);
  assert.equal(got.kind, 'image');
});

test('CAT-B-3: detectMediaKind — 확장자·MIME 조합으로 4 종을 정확히 판별하고 미지원은 null', () => {
  assert.equal(detectMediaKind('slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'pptx');
  assert.equal(detectMediaKind('doc.pdf', 'application/pdf'), 'pdf');
  assert.equal(detectMediaKind('photo.png', 'image/png'), 'image');
  assert.equal(detectMediaKind('clip.mp4', 'video/mp4'), 'video');
  // 지원 외 — exe, txt 등
  assert.equal(detectMediaKind('virus.exe', 'application/octet-stream'), null);
  assert.equal(detectMediaKind('notes.txt', 'text/plain'), null);
});

test('CAT-B-4 (갭): MediaAssetStore 인터페이스는 삭제 API(remove/deleteById) 를 제공하지 않는다 — 단일 파일 삭제 UX 는 상위 레이어가 담당', () => {
  const store: MediaAssetStore = createMediaAssetStore();
  // 타입 수준에서 remove/delete 가 없음을 확인 — 키 목록에 없음
  const keys = Object.keys(store);
  assert.ok(!keys.includes('remove'), 'remove 가 인터페이스에 없어야 한다');
  assert.ok(!keys.includes('delete'), 'delete 가 인터페이스에 없어야 한다');
  assert.ok(!keys.includes('deleteById'), 'deleteById 가 인터페이스에 없어야 한다');
  // clear 는 존재 — 전체 초기화용(회귀/재기동 전용)
  assert.ok(keys.includes('clear'));
});

// ────────────────────────────────────────────────────────────────────────────
// CAT-C · 프로젝트 삭제 cascade
// ────────────────────────────────────────────────────────────────────────────

test('CAT-C-1 (갭 감시): DELETE /api/projects/:id 핸들러(server.ts) 는 mediaAssetStore 정리를 호출하지 않는다 — 고아 자산 누적 가능', () => {
  const src = readFileSync(SERVER_PATH, 'utf8');
  // 핸들러 블록 추출
  const startIdx = src.indexOf("app.delete('/api/projects/:id'");
  assert.ok(startIdx > 0, '핸들러를 찾을 수 있어야 한다');
  const endIdx = src.indexOf("app.post('/api/projects/:id/agents'", startIdx);
  const handler = src.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 4000);
  // mediaAssetStore 의 어떤 메서드도 핸들러 범위에서 호출되지 않음을 잠근다
  assert.doesNotMatch(handler, /mediaAssetStore\.(save|get|listByProject|clear|remove|delete)/);
});

test('CAT-C-2 (갭 감시): mediaAssetStore.ts 는 projectId 단위 삭제 메서드를 export 하지 않는다', () => {
  const src = readFileSync(STORE_PATH, 'utf8');
  // 인터페이스·구현 양쪽에 deleteByProject/removeByProject 가 없어야 한다(지금은 갭)
  assert.doesNotMatch(src, /deleteByProject|removeByProject|purgeProject/);
});

test('CAT-C-3 (수동 시뮬): clear() 로 강제 초기화하면 양 프로젝트 모두 비워진다 — 운영자가 수동으로 내릴 때의 최후 수단', () => {
  const store = createMediaAssetStore();
  store.save(makeAsset({ id: 'a', projectId: 'projA', kind: 'pdf' }));
  store.save(makeAsset({ id: 'b', projectId: 'projB', kind: 'image' }));
  store.clear();
  assert.equal(store.listByProject('projA').length, 0);
  assert.equal(store.listByProject('projB').length, 0);
  assert.equal(store.get('a'), null);
});

// ────────────────────────────────────────────────────────────────────────────
// CAT-D · 새로고침 / 서버 재기동 이후 persist 복원
// ────────────────────────────────────────────────────────────────────────────

test('CAT-D-1: mediaAssetStore 싱글톤은 **서버 프로세스 동안** 동일 인스턴스를 돌려준다 (새로고침은 클라 측이라 싱글톤 영향 없음)', () => {
  resetMediaAssetStore();
  const s1 = getMediaAssetStore();
  const s2 = getMediaAssetStore();
  assert.equal(s1, s2, '탭 리프레시로는 서버 싱글톤이 바뀌지 않는다');
});

test('CAT-D-2 (제약 명시): 서버 재기동을 resetMediaAssetStore 로 시뮬하면 이전 자산은 휘발된다 — 1 차 스켈레톤은 인메모리 전용', () => {
  resetMediaAssetStore();
  const s1 = getMediaAssetStore();
  s1.save(makeAsset({ id: 'persist-probe', projectId: 'projA', kind: 'pdf' }));
  assert.equal(s1.listByProject('projA').length, 1);

  // 재기동 시뮬
  resetMediaAssetStore();
  const s2 = getMediaAssetStore();
  assert.notEqual(s1, s2, '재기동 후에는 새 인스턴스여야 한다');
  assert.equal(s2.listByProject('projA').length, 0, '이전 자산은 사라진다 — Mongo 마이그레이션 전까지의 알려진 제약');
  assert.equal(s2.get('persist-probe'), null);
});

test('CAT-D-3 (메타 제약): src/server/mediaAssetStore.ts 는 fs / mongodb 를 import 하지 않는다 — 아직 디스크 persist 가 연결되지 않음', () => {
  const src = readFileSync(STORE_PATH, 'utf8');
  assert.doesNotMatch(src, /from\s+['"]fs['"]|from\s+['"]node:fs['"]|from\s+['"]mongodb['"]/);
});

// ────────────────────────────────────────────────────────────────────────────
// CAT-E · 대용량 · 동일 파일명 · 미지원 형식
// ────────────────────────────────────────────────────────────────────────────

test('CAT-E-1: DEFAULT_MAX_BYTES 는 서버 multer 상한(200MB) 보다 낮은 50MB 로 사전 가드 역할', () => {
  assert.equal(DEFAULT_MAX_BYTES, 50 * 1024 * 1024);
  assert.ok(DEFAULT_MAX_BYTES < 200 * 1024 * 1024, '클라 가드는 서버 상한보다 낮아야 네트워크가 낭비되지 않는다');
});

test('CAT-E-2: 대용량 경계 — DEFAULT_MAX_BYTES 초과 파일은 클라 사전 판정에서 거절되어 업로드 저장에 이르지 않는다 (계약 시뮬)', () => {
  const store = createMediaAssetStore();
  // 경계 시나리오: gateFile 로직을 저장소 계층으로 끌어와 시뮬 — 초과분은 save 호출 전에 차단돼야 한다
  const huge = makeAsset({
    id: 'huge',
    projectId: 'projA',
    kind: 'video',
    sizeBytes: DEFAULT_MAX_BYTES + 1,
  });
  const wouldPass = huge.sizeBytes <= DEFAULT_MAX_BYTES;
  assert.equal(wouldPass, false, '50MB 초과는 클라 가드에서 차단');
  // 만일 우회돼 저장이 된다면? 저장소 자체는 크기 검증을 하지 않으므로 무차별 보관.
  // 이 사실을 잠가 두어 "상위 가드가 유일한 대용량 방어선" 임을 회귀로 고정한다.
  store.save(huge);
  assert.equal(store.listByProject('projA').length, 1, '저장소는 크기 검증이 없다 — 상위 가드가 유일한 방어선');
});

test('CAT-E-3: 동일 파일명(name) 다중 업로드 — id 가 다르면 중복으로 공존한다', () => {
  const store = createMediaAssetStore();
  store.save(makeAsset({ id: 'id-1', projectId: 'projA', kind: 'pdf', name: 'report.pdf' }));
  store.save(makeAsset({ id: 'id-2', projectId: 'projA', kind: 'pdf', name: 'report.pdf' }));
  const list = store.listByProject('projA');
  assert.equal(list.length, 2, '동일 name 이라도 id 가 다르면 별개 레코드');
  assert.deepEqual(list.map(x => x.id), ['id-2', 'id-1']);
  // UI 쪽 중복 경고는 별도 레이어에 있으므로 저장소는 name 충돌을 강제하지 않음
});

test('CAT-E-4: 동일 id 재저장(덮어쓰기) — 프로젝트 목록에 중복을 만들지 않고 최신 앞으로 갱신', () => {
  const store = createMediaAssetStore();
  store.save(makeAsset({ id: 'dup', projectId: 'projA', kind: 'pdf', name: 'v1.pdf' }));
  store.save(makeAsset({ id: 'other', projectId: 'projA', kind: 'image' }));
  store.save(makeAsset({ id: 'dup', projectId: 'projA', kind: 'pdf', name: 'v2.pdf' }));

  const list = store.listByProject('projA');
  assert.equal(list.length, 2, '중복이 아니라 덮어쓰기');
  assert.equal(list[0].id, 'dup');
  assert.equal(list[0].name, 'v2.pdf', '최신 저장값이 반영');
  assert.equal(list[1].id, 'other');
});

test('CAT-E-5: 미지원 확장자는 detectMediaKind → null 이 되어 UploadDropzone 사전 가드에서 UNSUPPORTED_KIND 로 차단', () => {
  // .zip, .exe, .mp3(오디오는 별도 축) 은 4 종 MediaKind 에 포함되지 않는다
  assert.equal(detectMediaKind('archive.zip', 'application/zip'), null);
  assert.equal(detectMediaKind('bin.exe', 'application/octet-stream'), null);
  assert.equal(detectMediaKind('song.mp3', 'audio/mpeg'), null);
});
