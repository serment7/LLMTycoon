// 워크스페이스 파일 CRUD — 스트리밍/청크 기반 (#llm-provider-abstraction)
//
// 에이전트(로컬 LLM)가 워크스페이스 파일을 실제로 읽고·검색하고·편집할 수 있도록
// 제공하는 핵심 기반. 설계 목표:
//
//   1. **대용량 파일 대응**: 수십만 줄 파일도 전체를 한 번에 메모리에 올리지 않는다.
//      readline 스트림으로 offset까지 스킵하고 필요한 청크만 수집한다. 편집도
//      offset/limit 으로 청크만 메모리에 올리고 나머지는 스트림으로 임시파일에
//      그대로 pass-through → atomic rename.
//
//   2. **동시 편집 안전성**: 같은 워크스페이스+상대경로 키로 FIFO promise-chain mutex
//      를 건다. 쓰기/편집은 직렬화되어 두 에이전트가 같은 파일을 동시에 수정해도
//      최종 상태가 깨지지 않는다. 읽기·검색은 락 없이 병렬 허용.
//
//   3. **샌드박스**: path.resolve 후 workspacePath 외부 접근을 차단하고, `.git/` /
//      `node_modules/` / `dist/` / `build/` / `coverage/` 쓰기는 금지한다(기존
//      GIT_STAGE_EXCLUDED_PATHS 재활용).
//
//   4. **커서 기반 검색**: grepFiles 는 매칭 limit 개 수집되면 조기 종료하고
//      next_cursor(file:line) 를 돌려준다. 다음 호출에 그대로 넘기면 이어서 재개.
//
// 이 모듈은 HTTP/REST 에 의존하지 않는다 — tools-adapter 가 in-process 로 직접 호출.

import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, readdirSync } from 'fs';
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { randomBytes } from 'crypto';
import { GIT_STAGE_EXCLUDED_PATHS } from '../../utils/codeGraphFilter';

// ─── 샌드박스 ────────────────────────────────────────────────────────────────

/**
 * 파일 작업의 "외부 저장소" 옵션. centralDocsRoot 가 주어지면 `docs/` prefix
 * 경로를 workspacePath 가 아닌 centralDocsRoot 안으로 라우팅한다 — 사용자가
 * 프로젝트 폴더 대신 LLMTycoon 자체 저장소에 docs 를 격리하도록 선택했을 때 사용.
 */
export interface WorkspaceFsOptions {
  centralDocsRoot?: string;
}

/**
 * 정규화된 상대경로가 docs/ 권역에 속하는지 판정. forward-slash·OS-slash 를 모두
 * 수용하고, 'docs' 단독·'docs/...' 모두 true. './docs/...' 같은 입력도 잘라내 같은
 * 판정으로 수렴시키기 위해 호출자(resolveSafePath)가 normalize 를 거친 뒤에 사용한다.
 */
function isDocsRelativePath(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  return norm === 'docs' || norm.startsWith('docs/');
}

/**
 * docs/ prefix 를 제거한 경로를 돌려준다. central root 안에서의 상대경로로 쓰려면
 * "docs/" 토큰 자체가 중복돼 들어가는 것을 막아야 한다(centralRoot 자체가 이미
 * .../docs 를 가리키므로). 'docs' 단독은 빈 문자열로 변환해 root 자기 자신을 의미.
 */
function stripDocsPrefix(rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm === 'docs') return '';
  if (norm.startsWith('docs/')) return norm.slice('docs/'.length);
  return norm;
}

/**
 * workspacePath 를 기준으로 상대경로를 정규화하고, 결과 절대경로가 workspace 내부
 * 인지 확인한다. `../` 로 빠져나가려는 시도는 throw. 반환값은 항상 sandbox 내부
 * 절대경로.
 *
 * options.centralDocsRoot 가 주어지고 rel 이 docs/ 권역이면 sandbox root 가
 * centralDocsRoot 로 전환되고, rel 의 'docs/' prefix 는 제거된 뒤 그 root 안에서
 * 다시 검증된다. 즉 같은 함수가 두 종류의 sandbox 를 모두 지킨다.
 */
export function resolveSafePath(
  workspacePath: string,
  rel: string,
  options?: WorkspaceFsOptions,
): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('path 가 비어 있습니다');
  }
  const useCentral = Boolean(options?.centralDocsRoot) && isDocsRelativePath(rel);
  const rootAbs = useCentral
    ? path.resolve(options!.centralDocsRoot!)
    : path.resolve(workspacePath);
  const inRoot = useCentral ? stripDocsPrefix(rel) : rel;
  // path.resolve 는 절대경로 입력을 root 가 아닌 그 자체로 반환하므로, 앞에 root
  // 를 강제로 붙여 정규화한다. `/etc/passwd` 같은 절대경로도 rootAbs 내부로
  // 끌어오면 startsWith 체크에서 정확히 걸러진다. central 모드에서 prefix 제거
  // 후 빈 문자열이 되면 root 자체를 가리킨다.
  const target = inRoot.length === 0 ? '.' : inRoot;
  const joined = path.isAbsolute(target) ? path.join(rootAbs, target) : path.join(rootAbs, target);
  const normalized = path.normalize(joined);
  if (!normalized.startsWith(rootAbs + path.sep) && normalized !== rootAbs) {
    throw new Error(`path 가 ${useCentral ? 'docs root' : 'workspace'} 밖을 가리킵니다: ${rel}`);
  }
  return normalized;
}

/**
 * 쓰기 금지 경로(`.git/`, `node_modules/`, `dist/` 등) 에 해당하는지 판정. 정규화된
 * 상대경로를 forward-slash 로 바꿔서 prefix 매칭한다.
 */
export function isWriteForbidden(
  workspacePath: string,
  rel: string,
  options?: WorkspaceFsOptions,
): boolean {
  const useCentral = Boolean(options?.centralDocsRoot) && isDocsRelativePath(rel);
  const rootAbs = useCentral ? path.resolve(options!.centralDocsRoot!) : path.resolve(workspacePath);
  const inRoot = useCentral ? stripDocsPrefix(rel) || '.' : rel;
  const abs = path.resolve(rootAbs, inRoot);
  const relNorm = path.relative(rootAbs, abs).split(path.sep).join('/') + '/';
  return GIT_STAGE_EXCLUDED_PATHS.some(p => relNorm.startsWith(p));
}

// ─── 파일 단위 mutex ──────────────────────────────────────────────────────────
// 키 = `${workspacePath}::${relPath}`. withFileLock 이 직렬 promise 체인을 돌려 두
// 쓰기가 겹치지 않도록 보장한다. 읽기는 이 락을 쓰지 않는다.

const fileLocks = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  // next 는 prev 가 끝난 뒤 새 Promise 를 생성해 체인의 tail 이 된다.
  const next = prev.then(() => new Promise<void>(r => { release = r; }));
  fileLocks.set(key, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // 내가 tail 이었다면 맵에서 정리. 새 작업이 그 사이 fileLocks 를 갱신했다면 그대로 둔다.
    if (fileLocks.get(key) === next) fileLocks.delete(key);
  }
}

// ─── 읽기 (청크) ─────────────────────────────────────────────────────────────

export interface ReadFileResult {
  content: string;
  start_line: number;       // 0-based inclusive
  end_line: number;         // 0-based exclusive — end_line-1 이 마지막 반환 줄
  total_lines: number;
  has_more: boolean;
  /**
   * has_more=true 일 때 다음 호출에 그대로 넘기면 이어읽기가 되는 offset 값.
   * 8B 급 로컬 모델이 end_line 으로부터 next offset 을 산술 계산하지 못하는 회귀가
   * 있어, 명시 필드로 노출한다. has_more=false 면 null.
   */
  next_offset: number | null;
}

const DEFAULT_READ_LIMIT = 1000;
const MAX_READ_LIMIT = 10000;

/**
 * offset 줄부터 최대 limit 줄을 읽는다. 파일 전체를 메모리에 올리지 않고 readline
 * 스트림으로 줄 수를 세며 필요한 창만 수집한다. 모델 응답 토큰 폭발을 막기 위해
 * limit 은 MAX_READ_LIMIT 으로 하드캡.
 */
export async function readFileChunk(
  workspacePath: string,
  rel: string,
  offset = 0,
  limit = DEFAULT_READ_LIMIT,
  options?: WorkspaceFsOptions,
): Promise<ReadFileResult> {
  const abs = resolveSafePath(workspacePath, rel, options);
  const effectiveLimit = Math.max(1, Math.min(limit, MAX_READ_LIMIT));
  const lines: string[] = [];
  let lineNo = 0;
  const stream = createReadStream(abs, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (lineNo >= offset && lineNo < offset + effectiveLimit) {
      lines.push(line);
    }
    lineNo++;
    // offset+limit 에 도달하면 더 읽을 필요 없지만, total_lines 를 알아야 has_more
    // 을 정확히 돌려주므로 끝까지 줄 수만 세고 내용은 버린다.
  }
  const total = lineNo;
  const endLineExclusive = Math.min(offset + effectiveLimit, total);
  const hasMore = endLineExclusive < total;
  return {
    content: lines.join('\n'),
    start_line: offset,
    end_line: endLineExclusive,
    total_lines: total,
    has_more: hasMore,
    next_offset: hasMore ? endLineExclusive : null,
  };
}

// ─── 쓰기 ────────────────────────────────────────────────────────────────────

/**
 * 파일을 덮어쓴다(또는 신규 생성). 부모 디렉터리가 없으면 자동 생성. 쓰기 금지
 * 경로면 throw. 쓰기는 파일 단위 mutex 로 직렬화된다.
 *
 * 데이터 손실 가드(#local-llm-empty-args): 7-8B급 로컬 모델이 "무엇을 쓸지" 모를 때
 * 빈 문자열을 content 로 넘겨 실제 파일을 통째로 비워 버리는 사고가 관측됐다
 * (llama3.1:8b 실사례, 2026-04). 빈 content 를 명시적으로 거부해 덮어쓰기를 차단하고,
 * 모델이 read_file 로 먼저 내용을 확인하도록 유도하는 에러 메시지를 돌려 준다.
 * 빈 파일이 꼭 필요한 경우는 드물지만 있으면 그 때 별도 경로를 마련한다.
 */
export async function writeFileContent(
  workspacePath: string,
  rel: string,
  content: string,
  options?: WorkspaceFsOptions,
): Promise<{ bytes: number }> {
  // 쓰기 금지 경로 검사는 실제로 쓰일 sandbox(workspace 또는 central docs root)
  // 기준으로 해야 의도한 분기가 일관된다. central 모드에서 docs/ 안의 .git/ 같은
  // 경로는 사실상 도달하기 어렵지만, 동일한 안전 규칙을 양쪽에 적용해 둔다.
  if (isWriteForbidden(workspacePath, rel, options)) {
    throw new Error(`쓰기 금지 경로입니다: ${rel}`);
  }
  if (typeof content !== 'string') {
    throw new Error('content 는 문자열이어야 합니다');
  }
  if (content.length === 0) {
    throw new Error(
      'write_file 에 빈 content 를 넘길 수 없습니다. 파일을 덮어쓰려면 실제 내용을 담으세요. 내용을 모른다면 먼저 read_file 로 확인하세요.',
    );
  }
  const abs = resolveSafePath(workspacePath, rel, options);
  const key = lockKeyFor(workspacePath, rel, options);
  return withFileLock(key, async () => {
    mkdirSync(path.dirname(abs), { recursive: true });
    await fsWriteFile(abs, content, 'utf8');
    return { bytes: Buffer.byteLength(content, 'utf8') };
  });
}

/**
 * 같은 sandbox+rel 조합을 동일한 락 키로 수렴시키는 헬퍼. central 모드에서는
 * centralDocsRoot 자체가 키 prefix 가 되므로 다른 프로젝트의 docs/ 끼리는 자연히
 * 키가 분리된다. workspace 모드 키는 기존 포맷을 그대로 유지한다(과거 기록과의
 * 형식 호환을 위해).
 */
function lockKeyFor(
  workspacePath: string,
  rel: string,
  options?: WorkspaceFsOptions,
): string {
  if (options?.centralDocsRoot && isDocsRelativePath(rel)) {
    return `${path.resolve(options.centralDocsRoot)}::${rel}`;
  }
  return `${path.resolve(workspacePath)}::${rel}`;
}

// ─── 편집 (전체 / 청크) ─────────────────────────────────────────────────────

export interface EditFileOptions {
  offset?: number;   // 청크 모드: 이 줄부터
  limit?: number;    // 청크 모드: 이 줄 수만큼만 대상
  replaceAll?: boolean;
  /** 동일한 의미. workspace-fs 의 다른 함수와 매개변수를 일관되게 받기 위한 통로. */
  centralDocsRoot?: string;
}

export interface EditFileResult {
  replacements: number;
  target_range: { start_line: number; end_line: number };
  total_lines_before: number;
  total_lines_after: number;
}

/**
 * old_string 을 new_string 으로 교체한다. offset/limit 이 지정되면 해당 줄 범위만
 * 메모리에 올리고 나머지 줄은 스트림으로 임시 파일에 그대로 복사한다. 이후
 * atomic rename 으로 원자성을 확보.
 *
 * replaceAll=false 기본: 범위 내 old_string 이 정확히 1회만 나와야 성공. 0 회면
 * "찾지 못함" 에러, 2+ 회면 "모호함, 더 긴 맥락으로 재시도" 에러 — 수십만 줄 파일
 * 에서 잘못된 위치를 건드리는 사고를 원천 차단.
 */
export async function editFileContent(
  workspacePath: string,
  rel: string,
  oldString: string,
  newString: string,
  options: EditFileOptions = {},
): Promise<EditFileResult> {
  const fsOpts: WorkspaceFsOptions = options.centralDocsRoot
    ? { centralDocsRoot: options.centralDocsRoot }
    : {};
  if (isWriteForbidden(workspacePath, rel, fsOpts)) {
    throw new Error(`쓰기 금지 경로입니다: ${rel}`);
  }
  // #local-llm-empty-args — 빈 old_string 은 replaceWithCheck 심층에서도 잡히지만,
  // 락을 잡고 파일을 열기 전 단계에서 미리 돌려보내 에러 메시지가 모델에 더 빨리
  // 도달하도록 한다(락 점유·tmp 파일 생성 비용 절감).
  if (typeof oldString !== 'string' || oldString.length === 0) {
    throw new Error(
      'edit_file 에 빈 old_string 을 넘길 수 없습니다. 먼저 read_file 로 대상 구간을 확인하고 고유한 문자열을 old_string 으로 지정하세요.',
    );
  }
  if (typeof newString !== 'string') {
    throw new Error('new_string 은 문자열이어야 합니다');
  }
  if (oldString === newString) {
    throw new Error('old_string 과 new_string 이 동일합니다');
  }
  const abs = resolveSafePath(workspacePath, rel, fsOpts);
  const key = lockKeyFor(workspacePath, rel, fsOpts);
  const offset = options.offset ?? 0;
  const limit = options.limit; // undefined → 전체
  const replaceAll = options.replaceAll === true;

  return withFileLock(key, async () => {
    if (!existsSync(abs)) {
      throw new Error(`파일이 존재하지 않습니다: ${rel}`);
    }

    // 전체 모드: 작은 파일용 fallback. readFile → 치환 → writeFile.
    if (limit === undefined && offset === 0) {
      const original = await fsReadFile(abs, 'utf8');
      const { replaced, count } = replaceWithCheck(original, oldString, newString, replaceAll);
      await fsWriteFile(abs, replaced, 'utf8');
      const beforeLines = countLines(original);
      const afterLines = countLines(replaced);
      return {
        replacements: count,
        target_range: { start_line: 0, end_line: beforeLines },
        total_lines_before: beforeLines,
        total_lines_after: afterLines,
      };
    }

    // 청크 모드: pre-chunk/chunk/post-chunk 세 구간으로 나눠 처리.
    //   pre-chunk [0, offset)        — tmp 에 그대로 복사
    //   chunk     [offset, chunkEnd) — 메모리에 모아 치환 후 tmp 에 기록
    //   post      [chunkEnd, EOF)    — 다시 tmp 에 그대로 복사
    // 치환이 flushChunk 시점에 수행되고 나머지 구간은 순수 pass-through 라 대용량
    // 파일의 메모리 피크는 chunkLimit 만큼으로 고정된다.
    const tmpAbs = `${abs}.edit-${Date.now()}-${randomBytes(6).toString('hex')}.tmp`;
    const input = createReadStream(abs, { encoding: 'utf8' });
    const output = createWriteStream(tmpAbs, { encoding: 'utf8' });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    const chunkLines: string[] = [];
    const effectiveLimit = limit ?? Number.MAX_SAFE_INTEGER;
    const chunkEnd = offset + effectiveLimit;
    let replacementCount = 0;
    let chunkFlushed = false;
    let lineNo = 0;

    // tmp 에 한 줄씩 이어 쓸 때 개행 위치를 정확히 맞추기 위한 헬퍼. 파일의 첫 줄
    // 앞에는 개행을 붙이지 않고, 이후 줄부터 \n + content 를 쓴다.
    let wroteAny = false;
    const writeLine = (s: string) => {
      if (wroteAny) output.write('\n');
      output.write(s);
      wroteAny = true;
    };
    const writeChunk = (s: string) => {
      // 청크 문자열 자체가 join('\n') 으로 만들어졌으므로 내부 개행은 이미 포함.
      // 외부와의 경계만 개행 한 번 추가.
      if (wroteAny) output.write('\n');
      output.write(s);
      wroteAny = true;
    };

    try {
      for await (const line of rl) {
        if (lineNo < offset) {
          writeLine(line);
        } else if (lineNo < chunkEnd) {
          chunkLines.push(line);
        } else {
          // post-chunk 의 첫 줄을 만났으니 chunk 를 먼저 flush.
          if (!chunkFlushed) {
            const processed = replaceWithCheck(chunkLines.join('\n'), oldString, newString, replaceAll);
            writeChunk(processed.replaced);
            replacementCount = processed.count;
            chunkFlushed = true;
          }
          writeLine(line);
        }
        lineNo++;
      }
      const totalBefore = lineNo;

      // 파일이 청크 범위 안에서 끝났거나, 청크가 EOF 와 정확히 일치하는 경우.
      if (!chunkFlushed) {
        if (chunkLines.length === 0) {
          throw new Error(`offset ${offset} 가 파일 줄 수(${totalBefore}) 를 벗어났습니다`);
        }
        const processed = replaceWithCheck(chunkLines.join('\n'), oldString, newString, replaceAll);
        writeChunk(processed.replaced);
        replacementCount = processed.count;
      }

      output.end();
      await new Promise<void>((resolve, reject) => {
        output.on('finish', () => resolve());
        output.on('error', reject);
      });

      const afterLines = await countLinesOfFile(tmpAbs);
      renameSync(tmpAbs, abs);
      return {
        replacements: replacementCount,
        target_range: { start_line: offset, end_line: Math.min(chunkEnd, totalBefore) },
        total_lines_before: totalBefore,
        total_lines_after: afterLines,
      };
    } catch (err) {
      try { unlinkSync(tmpAbs); } catch { /* cleanup best-effort */ }
      throw err;
    }
  });
}

function replaceWithCheck(src: string, oldString: string, newString: string, replaceAll: boolean): { replaced: string; count: number } {
  if (oldString.length === 0) throw new Error('old_string 이 비어 있습니다');
  // 매칭 개수 센다(indexOf 루프). 수 MB 문자열에서도 수 ms.
  let count = 0;
  let idx = 0;
  while (true) {
    const pos = src.indexOf(oldString, idx);
    if (pos < 0) break;
    count++;
    idx = pos + oldString.length;
    if (!replaceAll && count > 1) break; // 조기 종료
  }
  if (count === 0) {
    throw new Error('old_string 을 찾을 수 없습니다 (범위 내). 더 긴 맥락을 포함해 다시 시도하세요');
  }
  if (!replaceAll && count > 1) {
    throw new Error(`old_string 이 ${count}회 이상 일치합니다. 고유한 맥락을 포함하거나 replace_all=true 를 사용하세요`);
  }
  if (replaceAll) {
    // split/join 이 한 번에 모두 교체해 준다.
    const replaced = src.split(oldString).join(newString);
    return { replaced, count };
  }
  const pos = src.indexOf(oldString);
  return { replaced: src.slice(0, pos) + newString + src.slice(pos + oldString.length), count: 1 };
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

async function countLinesOfFile(abs: string): Promise<number> {
  const stream = createReadStream(abs, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  for await (const _ of rl) n++;
  return n;
}

// ─── 파일 트리 ───────────────────────────────────────────────────────────────

export interface ListEntry {
  path: string;     // workspace 상대경로
  type: 'file' | 'dir';
  size?: number;    // 파일만
}

const LIST_MAX_ENTRIES = 500;
const DEFAULT_EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache']);

/**
 * dir(기본 루트) 하위를 재귀 탐색해 상대경로 리스트를 돌려준다. 노이즈 디렉터리는
 * 자동 제외. glob 매칭은 간단한 `*.ext` / prefix 필터만 지원한다(본격 glob 엔진은
 * 과함 — 모델이 필요하면 grep_files 로 우회).
 *
 * maxDepth: dir 기준 깊이 상한(0 = dir 자체 직속만, 1 = 한 단계 하위까지). 기본은
 * Infinity(전체 재귀). LLMTycoon 같은 200+ 파일 프로젝트에서 모델에게 한 번에
 * 전체 트리를 던지면 토큰이 폭발하므로, 첫 호출은 maxDepth=1~2 로 좁히는 것이 좋다.
 */
export async function listFiles(
  workspacePath: string,
  dir = '.',
  globPattern?: string,
  maxDepth: number = Number.POSITIVE_INFINITY,
  options?: WorkspaceFsOptions,
): Promise<ListEntry[]> {
  // central 모드에서 dir 이 docs 권역이면 sandbox root 를 docs root 로 전환하고,
  // 결과 path 는 사용자 시점의 'docs/...' 표기로 다시 prefix 를 붙여 돌려준다 —
  // 호출자는 mode 변경을 인지할 필요 없이 일관된 상대경로 표면을 받는다.
  const useCentral = Boolean(options?.centralDocsRoot) && isDocsRelativePath(dir);
  const rootAbs = useCentral
    ? path.resolve(options!.centralDocsRoot!, stripDocsPrefix(dir) || '.')
    : resolveSafePath(workspacePath, dir, options);
  const sandboxRoot = useCentral ? path.resolve(options!.centralDocsRoot!) : path.resolve(workspacePath);
  const presentationPrefix = useCentral ? 'docs' : '';
  const results: ListEntry[] = [];
  // depth 를 함께 들고 다닌다. base(dir) 의 직속 자식이 depth 0.
  const stack: { abs: string; depth: number }[] = [{ abs: rootAbs, depth: 0 }];
  while (stack.length > 0 && results.length < LIST_MAX_ENTRIES) {
    const cur = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(cur.abs); } catch { continue; }
    for (const name of entries) {
      if (results.length >= LIST_MAX_ENTRIES) break;
      if (DEFAULT_EXCLUDE_DIRS.has(name)) continue;
      const abs = path.join(cur.abs, name);
      const rawRel = path.relative(sandboxRoot, abs).split(path.sep).join('/');
      const rel = presentationPrefix
        ? (rawRel ? `${presentationPrefix}/${rawRel}` : presentationPrefix)
        : rawRel;
      let st: ReturnType<typeof statSync>;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        // 현재 깊이에서 이 디렉터리는 항상 결과에 노출(glob 미지정시). 더 들어갈지는
        // depth + 1 < maxDepth 인지로 결정 — maxDepth=1 이면 dir 직속(depth 0)
        // 디렉터리는 보이지만 그 안으로 내려가진 않는다.
        if (cur.depth + 1 < maxDepth) {
          stack.push({ abs, depth: cur.depth + 1 });
        }
        if (!globPattern) results.push({ path: rel, type: 'dir' });
      } else if (st.isFile()) {
        if (globPattern && !matchSimpleGlob(rel, globPattern)) continue;
        results.push({ path: rel, type: 'file', size: st.size });
      }
    }
  }
  return results;
}

function matchSimpleGlob(relPath: string, pat: string): boolean {
  // `**/*.ts`, `src/**/*.tsx`, `*.md` 정도만 지원. 별표를 정규식으로 번역.
  const rx = new RegExp(
    '^' +
      pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*') +
      '$',
  );
  return rx.test(relPath);
}

// ─── grep (커서 기반) ──────────────────────────────────────────────────────

export interface GrepMatch {
  path: string;
  line: number;    // 1-based
  text: string;    // 길이 상한 300자
}

export interface GrepCursor {
  file: string;    // 마지막으로 처리 중이던 파일(상대경로)
  line: number;    // 그 파일의 다음 시작 줄(0-based)
  fileIndex: number; // 파일 리스트 인덱스 — 다음 파일로 넘어갈 때 빠른 재개용
}

export interface GrepResult {
  results: GrepMatch[];
  next_cursor: string | null; // null 이면 스캔 완료
  scanned_files: number;
}

const GREP_DEFAULT_LIMIT = 20;
const GREP_MAX_LIMIT = 100;
const GREP_LINE_MAX = 300;

export async function grepFiles(
  workspacePath: string,
  pattern: string,
  globPattern?: string,
  cursor?: string,
  limit = GREP_DEFAULT_LIMIT,
  options?: WorkspaceFsOptions,
): Promise<GrepResult> {
  const effectiveLimit = Math.max(1, Math.min(limit, GREP_MAX_LIMIT));
  let re: RegExp;
  try { re = new RegExp(pattern); } catch (e) {
    throw new Error(`pattern 이 유효한 정규식이 아닙니다: ${(e as Error).message}`);
  }
  // 파일 리스트는 grep 시작 시점에 한 번만 수집. cursor 는 그 정렬된 리스트의
  // 인덱스·줄 번호로 재개 위치를 가리킨다. central docs 모드에서는 workspace
  // 트리와 docs 트리 양쪽을 모두 모아 단일 정렬 리스트로 합친다 — 호출자는 분리
  // 저장을 인지하지 않고도 'docs/...' 매칭을 그대로 받을 수 있다.
  const wsFiles = (await listFiles(workspacePath, '.', globPattern ?? '**/*'))
    .filter(e => e.type === 'file')
    .map(e => e.path);
  const docsFiles = options?.centralDocsRoot
    ? (await listFiles(workspacePath, 'docs', globPattern ?? '**/*', Number.POSITIVE_INFINITY, options))
        .filter(e => e.type === 'file')
        .map(e => e.path)
    : [];
  const files = Array.from(new Set([...wsFiles, ...docsFiles])).sort();

  const parsed = parseGrepCursor(cursor);
  let startFileIdx = parsed?.fileIndex ?? 0;
  let startLine = parsed?.line ?? 0;
  const results: GrepMatch[] = [];
  let scanned = 0;

  for (let i = startFileIdx; i < files.length; i++) {
    const rel = files[i];
    const abs = resolveSafePath(workspacePath, rel, options);
    const stream = createReadStream(abs, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    scanned++;
    for await (const line of rl) {
      if (lineNo < startLine) { lineNo++; continue; }
      if (re.test(line)) {
        results.push({ path: rel, line: lineNo + 1, text: line.length > GREP_LINE_MAX ? line.slice(0, GREP_LINE_MAX) + '…' : line });
        if (results.length >= effectiveLimit) {
          rl.close(); stream.destroy();
          // 같은 파일에서 다음 줄부터 재개.
          return {
            results,
            next_cursor: encodeGrepCursor({ file: rel, line: lineNo + 1, fileIndex: i }),
            scanned_files: scanned,
          };
        }
      }
      lineNo++;
    }
    // 다음 파일은 처음부터.
    startLine = 0;
  }
  return { results, next_cursor: null, scanned_files: scanned };
}

function parseGrepCursor(s?: string): GrepCursor | null {
  if (!s) return null;
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);
    if (typeof obj.file === 'string' && typeof obj.line === 'number' && typeof obj.fileIndex === 'number') {
      return obj;
    }
  } catch { /* 무효 커서는 무시 */ }
  return null;
}

function encodeGrepCursor(c: GrepCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64');
}
