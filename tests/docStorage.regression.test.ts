// 문서 저장 위치(docStorage) 회귀 테스트.
//
// 검증 범위
//   1) docStorage 헬퍼 — extractDocStorage/mergeDocStorage/resolveCentralDocsRoot.
//   2) workspace-fs 의 5 도구가 centralDocsRoot 옵션을 받았을 때 'docs/' prefix 경로
//      를 별도 root 로 라우팅하는지(write→read→list→grep→edit 순으로 한 번씩).
//
// 본 테스트는 외부 네트워크나 MongoDB 의존이 없고, 모든 파일 입출력은 OS tmpdir
// 아래 격리된 폴더에서만 수행한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

import {
  DEFAULT_DOC_STORAGE,
  DOC_STORAGE_MODE_VALUES,
  extractDocStorage,
  mergeDocStorage,
  resolveCentralDocsRoot,
} from '../src/utils/docStorage';
import {
  editFileContent,
  grepFiles,
  listFiles,
  readFileChunk,
  writeFileContent,
} from '../src/server/llm/workspace-fs';

// ────────────────────────────────────────────────────────────────────────────
// 헬퍼 단위 테스트
// ────────────────────────────────────────────────────────────────────────────

test('extractDocStorage — 누락/잘못된 입력은 workspace 모드로 폴백한다', () => {
  assert.deepEqual(extractDocStorage(undefined), { mode: 'workspace' });
  assert.deepEqual(extractDocStorage(null), { mode: 'workspace' });
  assert.deepEqual(extractDocStorage({}), { mode: 'workspace' });
  assert.deepEqual(extractDocStorage({ docStorage: 'not-an-object' }), { mode: 'workspace' });
  assert.deepEqual(extractDocStorage({ docStorage: { mode: 'unknown' } }), { mode: 'workspace' });
});

test('extractDocStorage — central 모드는 정확히 통과한다', () => {
  assert.deepEqual(extractDocStorage({ docStorage: { mode: 'central' } }), { mode: 'central' });
});

test('mergeDocStorage — central 은 키를 추가하고 workspace 는 키를 제거한다', () => {
  const seed = { other: 1, docStorage: { mode: 'central' as const } };
  const removed = mergeDocStorage(seed, { mode: 'workspace' });
  assert.deepEqual(removed, { other: 1 });
  const added = mergeDocStorage({ other: 2 }, { mode: 'central' });
  assert.deepEqual(added, { other: 2, docStorage: { mode: 'central' } });
});

test('resolveCentralDocsRoot — repoRoot/.llmtycoon/projects/<id>/docs 로 고정', () => {
  const got = resolveCentralDocsRoot('/repo', 'p-42');
  assert.equal(got, path.resolve('/repo', '.llmtycoon', 'projects', 'p-42', 'docs'));
  assert.equal(resolveCentralDocsRoot('/repo', ''), '');
});

test('DOC_STORAGE_MODE_VALUES — 두 모드가 정확히 노출된다', () => {
  assert.deepEqual([...DOC_STORAGE_MODE_VALUES], ['workspace', 'central']);
  assert.equal(DEFAULT_DOC_STORAGE.mode, 'workspace');
});

// ────────────────────────────────────────────────────────────────────────────
// workspace-fs 라우팅 — docs/ prefix 가 centralDocsRoot 로 라우팅되는지
// ────────────────────────────────────────────────────────────────────────────

test('workspace-fs — central 모드에서 docs/ 쓰기는 centralDocsRoot 로 라우팅된다', async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'docstorage-fs-'));
  try {
    const workspacePath = path.join(baseDir, 'workspace');
    const centralDocsRoot = path.join(baseDir, 'central-docs');
    mkdirSync(workspacePath, { recursive: true });

    // central 모드: write 가 centralDocsRoot 안에 파일을 만들고, workspace 안에는
    // 동일 경로가 생성되지 않아야 한다.
    await writeFileContent(workspacePath, 'docs/spec/hello.md', 'central body', { centralDocsRoot });
    const centralAbs = path.join(centralDocsRoot, 'spec', 'hello.md');
    const workspaceAbs = path.join(workspacePath, 'docs', 'spec', 'hello.md');
    assert.equal(existsSync(centralAbs), true, 'central 위치에 파일이 생성돼야 한다');
    assert.equal(existsSync(workspaceAbs), false, 'workspace 위치에는 파일이 없어야 한다');
    assert.equal(readFileSync(centralAbs, 'utf8'), 'central body');

    // 비-docs 경로는 그대로 workspace 에 저장되어야 한다.
    await writeFileContent(workspacePath, 'src/util.ts', 'export const x = 1', { centralDocsRoot });
    assert.equal(existsSync(path.join(workspacePath, 'src', 'util.ts')), true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('workspace-fs — central 모드에서 docs/ 읽기/리스트/grep/edit 가 동일하게 라우팅된다', async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'docstorage-fs-'));
  try {
    const workspacePath = path.join(baseDir, 'workspace');
    const centralDocsRoot = path.join(baseDir, 'central-docs');
    mkdirSync(workspacePath, { recursive: true });

    // 시드 — central 에 두 파일, workspace 에 한 파일.
    await writeFileContent(workspacePath, 'docs/a.md', 'alpha needle', { centralDocsRoot });
    await writeFileContent(workspacePath, 'docs/sub/b.md', 'beta', { centralDocsRoot });
    await writeFileContent(workspacePath, 'src/c.ts', 'export const c = 1', { centralDocsRoot });

    // read: docs/ 경로는 central 에서 읽혀야 한다.
    const r = await readFileChunk(workspacePath, 'docs/a.md', 0, 100, { centralDocsRoot });
    assert.equal(r.content, 'alpha needle');
    assert.equal(r.total_lines, 1);

    // list(dir='docs') — central 트리를 순회하고, 결과 path 는 'docs/' 표기로 돌려준다.
    const entries = await listFiles(workspacePath, 'docs', undefined, Infinity, { centralDocsRoot });
    const filePaths = entries.filter(e => e.type === 'file').map(e => e.path).sort();
    assert.deepEqual(filePaths, ['docs/a.md', 'docs/sub/b.md']);

    // grep — workspace + docs 두 트리를 합쳐 검색하고, docs 매칭은 docs/ prefix 로 표기.
    const g = await grepFiles(workspacePath, 'needle', '**/*', undefined, undefined, { centralDocsRoot });
    const docHit = g.results.find(m => m.path === 'docs/a.md');
    assert.ok(docHit, 'docs/a.md 매칭이 결과에 있어야 한다');
    assert.match(docHit!.text, /alpha needle/);

    // edit: docs/ 경로 편집도 central 의 실제 파일에 반영되어야 한다.
    const e = await editFileContent(
      workspacePath,
      'docs/a.md',
      'alpha needle',
      'gamma needle',
      { centralDocsRoot },
    );
    assert.equal(e.replacements, 1);
    assert.equal(readFileSync(path.join(centralDocsRoot, 'a.md'), 'utf8'), 'gamma needle');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('workspace-fs — workspace 모드(centralDocsRoot 미지정) 동작은 기존 그대로다', async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'docstorage-fs-ws-'));
  try {
    const workspacePath = path.join(baseDir, 'workspace');
    mkdirSync(workspacePath, { recursive: true });
    await writeFileContent(workspacePath, 'docs/spec.md', 'in workspace');
    const abs = path.join(workspacePath, 'docs', 'spec.md');
    assert.equal(existsSync(abs), true);
    const r = await readFileChunk(workspacePath, 'docs/spec.md', 0, 10);
    assert.equal(r.content, 'in workspace');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
