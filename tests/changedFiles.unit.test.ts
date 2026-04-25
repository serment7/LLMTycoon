// Run with: npx tsx --test tests/changedFiles.unit.test.ts
//
// 지시 #2c317183 — 변경 파일 수집 + 에이전트 매핑 헬퍼 단위 테스트.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectChangedFiles,
  mapFilesToAgents,
  type ChangedFile,
} from '../src/services/git/changedFiles.ts';

// ─── collectChangedFiles — porcelain 파싱 ────────────────────────────────────

test('porcelain — staged·unstaged·untracked·rename 분류가 정확하다', () => {
  const fakeOutput = [
    'M  src/services/llm/responseCache.ts', // staged 수정
    ' M src/server/llm/oneshot.ts',         // unstaged 수정
    'MM tests/responseCache.unit.test.ts',  // 양쪽 모두 수정
    '?? scripts/new-script.ts',             // untracked
    'R  src/old/path.ts -> src/new/path.ts',// rename(staged)
    '',
  ].join('\n');
  const files = collectChangedFiles({
    cwd: '/fake',
    runner: () => fakeOutput,
  });
  assert.equal(files.length, 5);
  assert.deepEqual(files[0], {
    path: 'src/services/llm/responseCache.ts',
    oldPath: undefined,
    indexStatus: 'M',
    workTreeStatus: ' ',
    kind: 'staged',
  });
  assert.equal(files[1].kind, 'unstaged');
  assert.equal(files[2].kind, 'both');
  assert.equal(files[3].kind, 'untracked');
  assert.equal(files[4].kind, 'staged');
  assert.equal(files[4].path, 'src/new/path.ts');
  assert.equal(files[4].oldPath, 'src/old/path.ts');
});

test('porcelain — 빈 출력은 빈 배열', () => {
  const files = collectChangedFiles({ cwd: '/fake', runner: () => '' });
  assert.deepEqual(files, []);
});

test('porcelain — 백슬래시 경로는 슬래시로 정규화된다', () => {
  const files = collectChangedFiles({
    cwd: '/fake',
    runner: () => 'M  src\\components\\Foo.tsx\n',
  });
  assert.equal(files[0].path, 'src/components/Foo.tsx');
});

// ─── mapFilesToAgents — 매핑 우선순위 ────────────────────────────────────────

function file(path: string): ChangedFile {
  return { path, indexStatus: 'M', workTreeStatus: ' ', kind: 'staged' };
}

test('명시적 task.files 가 description 매칭보다 우선', () => {
  const tasks = [
    { agentId: 'a1', description: 'oneshot 통합 작업', files: ['src/server/llm/oneshot.ts'] },
    { agentId: 'a2', description: 'oneshot 회귀 방지', files: [] },
  ];
  const changed = [file('src/server/llm/oneshot.ts')];
  const r = mapFilesToAgents(tasks, changed);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].agentId, 'a1');
  assert.equal(r.unassigned.length, 0);
});

test('description 토큰이 파일명 stem 과 일치하면 매핑된다', () => {
  const tasks = [
    { agentId: 'cache', description: '응답 캐싱 레이어 responseCache 구현' },
    { agentId: 'commit', description: '변경 파일 헬퍼 changedFiles 추가' },
  ];
  const changed = [
    file('src/services/llm/responseCache.ts'),
    file('src/services/git/changedFiles.ts'),
  ];
  const r = mapFilesToAgents(tasks, changed);
  assert.equal(r.groups.length, 2);
  const byId = Object.fromEntries(r.groups.map(g => [g.agentId, g.files.map(f => f.path)]));
  assert.deepEqual(byId.cache, ['src/services/llm/responseCache.ts']);
  assert.deepEqual(byId.commit, ['src/services/git/changedFiles.ts']);
  assert.equal(r.unassigned.length, 0);
});

test('어디에도 매칭 안 되면 unassigned 로 분류', () => {
  const tasks = [{ agentId: 'a1', description: '문서 수정' }];
  const changed = [file('src/util/strangeName.ts')];
  const r = mapFilesToAgents(tasks, changed);
  assert.equal(r.groups.length, 0);
  assert.equal(r.unassigned.length, 1);
  assert.equal(r.unassigned[0].path, 'src/util/strangeName.ts');
});

test('rename 의 oldPath 도 명시적 파일 매칭에 인정된다', () => {
  const tasks = [
    { agentId: 'a1', description: '경로 이동', files: ['src/old/path.ts'] },
  ];
  const renamed: ChangedFile = {
    path: 'src/new/path.ts',
    oldPath: 'src/old/path.ts',
    indexStatus: 'R',
    workTreeStatus: ' ',
    kind: 'staged',
  };
  const r = mapFilesToAgents(tasks, [renamed]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].files[0].path, 'src/new/path.ts');
});

test('description 의 더 이른 토큰을 가진 태스크가 우선', () => {
  const tasks = [
    { agentId: 'late', description: '기타 정리 oneshot 보조' },
    { agentId: 'early', description: 'oneshot 캐시 통합' },
  ];
  const changed = [file('src/server/llm/oneshot.ts')];
  const r = mapFilesToAgents(tasks, changed);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].agentId, 'early');
});

test('빈 입력 — tasks 든 changedFiles 든 비어 있으면 빈 결과', () => {
  assert.deepEqual(mapFilesToAgents([], []), { groups: [], unassigned: [] });
  assert.deepEqual(
    mapFilesToAgents([{ agentId: 'a', description: 'x' }], []),
    { groups: [], unassigned: [] },
  );
  const r = mapFilesToAgents([], [file('a.ts')]);
  assert.equal(r.groups.length, 0);
  assert.equal(r.unassigned.length, 1);
});
