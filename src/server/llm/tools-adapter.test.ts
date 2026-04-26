// tools-adapter.ts 의 모델 응답 포맷터 회귀 테스트.
//
// 배경: 8B 급 로컬 모델(llama3.1:8b 실사례) 이 list_files_fs/read_file 결과를
// JSON 으로 받으면 (a) JSON escape 로 토큰이 30~50% 부풀고, (b) 결과를 받자마자
// "This is a JSON-formatted list of file metadata..." 같은 영문 풀어쓰기로 빠지는
// 회귀가 있었다(taskId=cb6fdf69 / 45ba12c1). 응답을 헤더 + raw text 로 직렬화해
// 토큰 비용·환각 유발을 동시에 줄인 변경에 대한 회귀 가드.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatReadFileResult, formatListFilesAsTree } from './tools-adapter';
import type { ReadFileResult, ListEntry } from './workspace-fs';

describe('formatReadFileResult', () => {
  it('has_more=false 인 결과는 (complete) 로 표기하고 next_offset 을 노출하지 않는다', () => {
    const r: ReadFileResult = {
      content: 'export const x = 1;\nexport const y = 2;',
      start_line: 0,
      end_line: 2,
      total_lines: 2,
      has_more: false,
      next_offset: null,
    };
    const out = formatReadFileResult('src/x.ts', r);
    assert.match(out, /^read_file: src\/x\.ts$/m);
    assert.match(out, /range: lines 0-2 of 2 \(complete\)/);
    // next_offset 은 (complete) 케이스에서 텍스트로 등장하면 안 된다(혼동 방지).
    assert.doesNotMatch(out, /next_offset/);
    // 본문이 raw 로 들어가 있는지 — JSON escape 가 아니어야 한다.
    assert.ok(out.includes('export const x = 1;'));
    assert.ok(out.includes('export const y = 2;'));
    assert.ok(!out.includes('\\n'), 'raw 본문이 escape 되면 안 된다');
  });

  it('has_more=true 면 next_offset 을 명시해 모델이 산술 없이 이어 호출 가능', () => {
    const r: ReadFileResult = {
      content: 'a\nb\nc',
      start_line: 0,
      end_line: 200,
      total_lines: 1500,
      has_more: true,
      next_offset: 200,
    };
    const out = formatReadFileResult('big.ts', r);
    assert.match(out, /range: lines 0-200 of 1500 \(has_more=true, next_offset=200\)/);
  });

  it('헤더와 본문 사이는 `---` 구분선 한 줄로 분리된다', () => {
    const r: ReadFileResult = {
      content: 'hello',
      start_line: 0, end_line: 1, total_lines: 1, has_more: false, next_offset: null,
    };
    const out = formatReadFileResult('a', r);
    const lines = out.split('\n');
    // 0: read_file: a
    // 1: range: ...
    // 2: ---
    // 3: hello
    assert.equal(lines[0], 'read_file: a');
    assert.match(lines[1], /^range: /);
    assert.equal(lines[2], '---');
    assert.equal(lines[3], 'hello');
  });
});

describe('formatListFilesAsTree', () => {
  it('디렉터리는 trailing `/`, 파일은 size 첨부, dir 먼저 알파벳 정렬', () => {
    const entries: ListEntry[] = [
      { path: 'README.md', type: 'file', size: 2345 },
      { path: 'src', type: 'dir' },
      { path: 'package.json', type: 'file', size: 789 },
      { path: 'docs', type: 'dir' },
    ];
    const out = formatListFilesAsTree('.', entries);
    const lines = out.split('\n');
    assert.match(lines[0], /^list_files_fs: \. \(4 entries\)$/);
    // dir 먼저(localeCompare 정렬) → 파일(localeCompare 정렬). localeCompare 는
    // 케이스를 무시하는 사전식 비교라 'package.json' 이 'README.md' 보다 앞선다(p<R).
    assert.equal(lines[1], 'docs/');
    assert.equal(lines[2], 'src/');
    assert.equal(lines[3], 'package.json\t789b');
    assert.equal(lines[4], 'README.md\t2345b');
  });

  it('500 entries 도달시 절단 가능성 안내가 헤더에 첨부된다', () => {
    const entries: ListEntry[] = Array.from({ length: 500 }, (_, i) => ({
      path: `file${i}.txt`,
      type: 'file' as const,
      size: 1,
    }));
    const out = formatListFilesAsTree('.', entries);
    const header = out.split('\n')[0];
    assert.match(header, /절단됐을 수 있음/);
    assert.match(header, /max_depth/);
  });

  it('500 미만이면 절단 안내가 붙지 않는다', () => {
    const entries: ListEntry[] = Array.from({ length: 10 }, (_, i) => ({
      path: `file${i}.txt`,
      type: 'file' as const,
      size: 1,
    }));
    const out = formatListFilesAsTree('.', entries);
    const header = out.split('\n')[0];
    assert.doesNotMatch(header, /절단/);
  });

  it('빈 entries 도 헤더만 안전하게 반환', () => {
    const out = formatListFilesAsTree('docs', []);
    assert.equal(out, 'list_files_fs: docs (0 entries)');
  });

  it('JSON 으로 직렬화하지 않아 raw path 가 그대로 노출된다(escape 0)', () => {
    const entries: ListEntry[] = [{ path: 'a/b.ts', type: 'file', size: 100 }];
    const out = formatListFilesAsTree('.', entries);
    // path 의 슬래시가 escape 되면 안 됨.
    assert.ok(out.includes('a/b.ts'));
    assert.ok(!out.includes('\\/'), 'JSON escape 흔적이 남으면 안 됨');
    assert.ok(!out.includes('"path"'), 'JSON 키가 새어 나오면 안 됨');
  });
});
