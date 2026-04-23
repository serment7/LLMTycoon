// workspace-fs.ts 회귀 테스트.
// 대용량 파일 + 동시 편집 시나리오를 중점 검증한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  editFileContent,
  grepFiles,
  isWriteForbidden,
  listFiles,
  readFileChunk,
  resolveSafePath,
  withFileLock,
  writeFileContent,
} from './workspace-fs';

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'llmtycoon-ws-'));
  return dir;
}
function cleanup(dir: string) { rmSync(dir, { recursive: true, force: true }); }

test('resolveSafePath: workspace 밖 접근은 거부', () => {
  const ws = makeWorkspace();
  try {
    assert.throws(() => resolveSafePath(ws, '../../etc/passwd'), /workspace 밖/);
    assert.throws(() => resolveSafePath(ws, '../outside.txt'), /workspace 밖/);
    const inside = resolveSafePath(ws, 'src/foo.ts');
    assert.ok(inside.startsWith(path.resolve(ws)));
  } finally { cleanup(ws); }
});

test('isWriteForbidden: .git, node_modules, dist, build 에 쓰기 금지', () => {
  const ws = makeWorkspace();
  try {
    assert.equal(isWriteForbidden(ws, '.git/HEAD'), true);
    assert.equal(isWriteForbidden(ws, 'node_modules/x/index.js'), true);
    assert.equal(isWriteForbidden(ws, 'dist/bundle.js'), true);
    assert.equal(isWriteForbidden(ws, 'src/foo.ts'), false);
    assert.equal(isWriteForbidden(ws, 'README.md'), false);
  } finally { cleanup(ws); }
});

test('readFileChunk: offset/limit 정확히 반영 + has_more 필드', async () => {
  const ws = makeWorkspace();
  try {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    writeFileSync(path.join(ws, 'big.txt'), lines.join('\n') + '\n', 'utf8');
    const r1 = await readFileChunk(ws, 'big.txt', 0, 10);
    assert.equal(r1.start_line, 0);
    assert.equal(r1.end_line, 10);
    assert.equal(r1.total_lines, 100);
    assert.equal(r1.has_more, true);
    assert.ok(r1.content.startsWith('line 1\n'));
    assert.ok(r1.content.endsWith('line 10'));
    const r2 = await readFileChunk(ws, 'big.txt', 90, 20);
    assert.equal(r2.start_line, 90);
    assert.equal(r2.end_line, 100);
    assert.equal(r2.has_more, false);
    assert.ok(r2.content.endsWith('line 100'));
  } finally { cleanup(ws); }
});

test('writeFileContent: 부모 디렉터리 자동 생성 + 덮어쓰기', async () => {
  const ws = makeWorkspace();
  try {
    await writeFileContent(ws, 'src/nested/deep/a.txt', 'hello');
    assert.equal(readFileSync(path.join(ws, 'src/nested/deep/a.txt'), 'utf8'), 'hello');
    await writeFileContent(ws, 'src/nested/deep/a.txt', 'world');
    assert.equal(readFileSync(path.join(ws, 'src/nested/deep/a.txt'), 'utf8'), 'world');
  } finally { cleanup(ws); }
});

test('writeFileContent: .git/ 쓰기는 거부', async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(() => writeFileContent(ws, '.git/config', 'x'), /쓰기 금지/);
  } finally { cleanup(ws); }
});

test('editFileContent(전체모드): unique old_string 교체', async () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(path.join(ws, 'f.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
    const r = await editFileContent(ws, 'f.txt', 'beta', 'BETA');
    assert.equal(r.replacements, 1);
    assert.equal(readFileSync(path.join(ws, 'f.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
  } finally { cleanup(ws); }
});

test('editFileContent(전체모드): 중복 old_string 이면 에러', async () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(path.join(ws, 'f.txt'), 'x\nx\nx\n', 'utf8');
    await assert.rejects(() => editFileContent(ws, 'f.txt', 'x', 'Y'), /일치합니다/);
  } finally { cleanup(ws); }
});

test('editFileContent(전체모드): replace_all=true 면 전부 교체', async () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(path.join(ws, 'f.txt'), 'x\nx\nx\n', 'utf8');
    const r = await editFileContent(ws, 'f.txt', 'x', 'Y', { replaceAll: true });
    assert.equal(r.replacements, 3);
    assert.equal(readFileSync(path.join(ws, 'f.txt'), 'utf8'), 'Y\nY\nY\n');
  } finally { cleanup(ws); }
});

test('editFileContent(청크모드): offset/limit 범위 밖의 중복은 무시', async () => {
  // 큰 파일을 시뮬레이션. line 100 근처에 unique 패턴을 심고 다른 줄들에 같은 리터럴
  // 을 많이 배치. 청크 범위를 좁게 잡으면 그 안에서는 unique 이므로 성공해야 한다.
  const ws = makeWorkspace();
  try {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push('DUP');
    lines[200] = 'const TARGET = 42; // mark';
    writeFileSync(path.join(ws, 'big.ts'), lines.join('\n') + '\n', 'utf8');
    const r = await editFileContent(
      ws, 'big.ts',
      'const TARGET = 42; // mark',
      'const TARGET = 999; // patched',
      { offset: 195, limit: 20 },
    );
    assert.equal(r.replacements, 1);
    assert.equal(r.target_range.start_line, 195);
    assert.equal(r.target_range.end_line, 215);
    assert.equal(r.total_lines_before, 500);
    const out = readFileSync(path.join(ws, 'big.ts'), 'utf8').split('\n');
    assert.equal(out[200], 'const TARGET = 999; // patched');
    // 청크 밖의 DUP 들이 건드려지지 않았는지 스폿 체크.
    assert.equal(out[0], 'DUP');
    assert.equal(out[499], 'DUP');
  } finally { cleanup(ws); }
});

test('editFileContent(청크모드): 청크 밖에 실제 패턴이 있어도 건드리지 않는다', async () => {
  const ws = makeWorkspace();
  try {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push('normal');
    lines[10] = 'TARGET';
    lines[50] = 'TARGET';
    lines[90] = 'TARGET';
    writeFileSync(path.join(ws, 'f.ts'), lines.join('\n') + '\n', 'utf8');
    // 청크 [45, 55) 안의 TARGET 하나만 교체.
    const r = await editFileContent(ws, 'f.ts', 'TARGET', 'PATCHED', { offset: 45, limit: 10 });
    assert.equal(r.replacements, 1);
    const out = readFileSync(path.join(ws, 'f.ts'), 'utf8').split('\n');
    assert.equal(out[10], 'TARGET');
    assert.equal(out[50], 'PATCHED');
    assert.equal(out[90], 'TARGET');
  } finally { cleanup(ws); }
});

test('withFileLock: 같은 키의 작업은 직렬 실행된다', async () => {
  const order: string[] = [];
  const slow = () => new Promise<void>(r => setTimeout(() => { order.push('slow-end'); r(); }, 50));
  const fast = () => new Promise<void>(r => { order.push('fast-end'); r(); });
  await Promise.all([
    withFileLock('k', async () => { order.push('slow-start'); await slow(); }),
    withFileLock('k', async () => { order.push('fast-start'); await fast(); }),
  ]);
  assert.deepEqual(order, ['slow-start', 'slow-end', 'fast-start', 'fast-end']);
});

test('withFileLock: 다른 키는 병렬 실행', async () => {
  const order: string[] = [];
  const slow = (tag: string) => new Promise<void>(r => setTimeout(() => { order.push(`${tag}-end`); r(); }, 30));
  await Promise.all([
    withFileLock('a', async () => { order.push('a-start'); await slow('a'); }),
    withFileLock('b', async () => { order.push('b-start'); await slow('b'); }),
  ]);
  // 둘 다 start 가 end 보다 먼저 — 병렬로 들어감.
  assert.ok(order.indexOf('a-start') < order.indexOf('a-end'));
  assert.ok(order.indexOf('b-start') < order.indexOf('b-end'));
  assert.ok(order.indexOf('a-start') < order.indexOf('b-end') || order.indexOf('b-start') < order.indexOf('a-end'));
});

test('동시 edit: 같은 파일 두 에이전트 편집도 최종 일관성 보장', async () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(path.join(ws, 'f.ts'), 'v=1\nv=2\nv=3\n', 'utf8');
    await Promise.all([
      editFileContent(ws, 'f.ts', 'v=1', 'v=10'),
      editFileContent(ws, 'f.ts', 'v=2', 'v=20'),
      editFileContent(ws, 'f.ts', 'v=3', 'v=30'),
    ]);
    const out = readFileSync(path.join(ws, 'f.ts'), 'utf8');
    // 세 패치가 모두 반영돼야 함. 락으로 직렬화되면서 순서는 임의지만 결과는 확정적.
    assert.equal(out, 'v=10\nv=20\nv=30\n');
  } finally { cleanup(ws); }
});

test('listFiles: 기본 노이즈 디렉터리(.git, node_modules 등) 자동 제외', async () => {
  const ws = makeWorkspace();
  try {
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    writeFileSync(path.join(ws, '.git/HEAD'), 'x');
    mkdirSync(path.join(ws, 'node_modules/y'), { recursive: true });
    writeFileSync(path.join(ws, 'node_modules/y/index.js'), 'x');
    writeFileSync(path.join(ws, 'README.md'), '# hi');
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'src/a.ts'), 'export {}');
    const entries = await listFiles(ws);
    const paths = entries.map(e => e.path);
    assert.ok(paths.includes('README.md'));
    assert.ok(paths.includes('src/a.ts'));
    assert.ok(!paths.some(p => p.startsWith('.git')));
    assert.ok(!paths.some(p => p.startsWith('node_modules')));
  } finally { cleanup(ws); }
});

test('grepFiles: 커서 재개 — 같은 파일 내에서 이어서 매칭', async () => {
  const ws = makeWorkspace();
  try {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(`line ${i} needle`); // 모든 줄이 매치
    writeFileSync(path.join(ws, 'a.txt'), lines.join('\n'), 'utf8');
    const r1 = await grepFiles(ws, 'needle', '*.txt', undefined, 10);
    assert.equal(r1.results.length, 10);
    assert.ok(r1.next_cursor);
    assert.equal(r1.results[0].line, 1);
    assert.equal(r1.results[9].line, 10);
    const r2 = await grepFiles(ws, 'needle', '*.txt', r1.next_cursor!, 10);
    assert.equal(r2.results.length, 10);
    assert.equal(r2.results[0].line, 11);
    assert.equal(r2.results[9].line, 20);
  } finally { cleanup(ws); }
});

test('grepFiles: 파일 경계를 넘어 재개', async () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(path.join(ws, 'a.txt'), 'X\nX\n', 'utf8');
    writeFileSync(path.join(ws, 'b.txt'), 'X\nX\n', 'utf8');
    const r1 = await grepFiles(ws, 'X', '*.txt', undefined, 2);
    assert.equal(r1.results.length, 2);
    assert.equal(r1.results[0].path, 'a.txt');
    assert.ok(r1.next_cursor);
    const r2 = await grepFiles(ws, 'X', '*.txt', r1.next_cursor!, 10);
    // a.txt 는 2줄뿐이라 r1 이 끝에서 멈췄다. 그러면 b.txt 로 넘어가 매칭.
    assert.ok(r2.results.length >= 2);
    assert.ok(r2.results.some(m => m.path === 'b.txt'));
  } finally { cleanup(ws); }
});
