// 지시 #2c317183 — 커밋 메시지 작성 시 사용할 변경 파일 수집·에이전트 매핑 헬퍼.
//
// 책임 두 가지
//   1) collectChangedFiles — `git status --porcelain` 출력을 파싱해 staged·unstaged·
//      untracked 변경 파일 목록을 ChangedFile 배열로 반환한다. simple-git 의존을
//      들이지 않고 child_process 만 사용해 추가 패키지 설치 없이 동작.
//   2) mapFilesToAgents — 태스크 목록(에이전트별 description) 과 ChangedFile 목록을
//      받아 "어느 파일이 어느 에이전트의 산출물인지" 추론해 그룹화한다. Thanos 의
//      buildCommitMessage 가 이 결과를 받아 에이전트별 섹션을 조립한다.
//
// 매핑 우선순위
//   (a) task.files 에 명시적으로 적힌 경로 — 가장 확실. 정규화 후 정확 일치.
//   (b) description 에 등장한 단어가 변경 파일 경로의 basename / 디렉토리 segment
//       와 일치 — 휴리스틱이지만 description 이 실제로 파일명을 적시하는 경우가
//       많아 회수율이 좋다.
//   매칭 후보가 여럿이면 (a) 가 (b) 를 항상 이긴다. (b) 가 둘 이상이면 description
//   에서 더 일찍 등장한(=인덱스가 작은) 토큰을 가진 태스크가 우선.

import { execFileSync } from 'node:child_process';

export type ChangeKind = 'staged' | 'unstaged' | 'both' | 'untracked';

export interface ChangedFile {
  /** 워크스페이스 루트 기준 정규화 경로(슬래시 통일). 이름 변경의 경우 새 경로. */
  path: string;
  /** 이름 변경(R) · 복제(C) 의 원본 경로. 일반 변경은 undefined. */
  oldPath?: string;
  /** 인덱스(스테이지) 영역의 한 글자 상태 코드. 공백은 변경 없음. */
  indexStatus: string;
  /** 작업 트리 영역의 한 글자 상태 코드. 공백은 변경 없음. */
  workTreeStatus: string;
  /** 사람이 읽기 쉬운 분류. 두 영역 모두 변경되면 'both'. */
  kind: ChangeKind;
}

export type GitRunner = (args: readonly string[], cwd: string) => string;

const defaultRunner: GitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

export interface CollectChangedFilesOptions {
  cwd?: string;
  /** 테스트가 가짜 porcelain 출력을 주입할 수 있게 한다. */
  runner?: GitRunner;
}

/**
 * `git status --porcelain` 한 줄을 파싱한다. 형식 요약(v1):
 *   `XY <path>` 또는 `XY <old> -> <new>` (R/C)
 * X = 인덱스 상태, Y = 작업 트리 상태. `??` 는 untracked.
 * 공백·따옴표 인용은 본 헬퍼에서 따로 풀지 않는다(Windows 워크스페이스 경로에는 쓰지
 * 않는 가정). 공백을 포함한 경로가 필요해지면 `-z` 옵션으로 옮겨 가야 한다.
 */
function parsePorcelainLine(line: string): ChangedFile | null {
  if (line.length < 4) return null;
  const indexStatus = line[0];
  const workTreeStatus = line[1];
  const rest = line.slice(3); // 두 코드 + 공백 한 칸 다음
  let path = rest;
  let oldPath: string | undefined;
  const renameSep = ' -> ';
  const arrow = rest.indexOf(renameSep);
  if (arrow >= 0 && (indexStatus === 'R' || indexStatus === 'C')) {
    oldPath = normalize(rest.slice(0, arrow));
    path = rest.slice(arrow + renameSep.length);
  }
  let kind: ChangeKind;
  if (indexStatus === '?' && workTreeStatus === '?') kind = 'untracked';
  else if (indexStatus !== ' ' && workTreeStatus !== ' ') kind = 'both';
  else if (indexStatus !== ' ') kind = 'staged';
  else kind = 'unstaged';
  return { path: normalize(path), oldPath, indexStatus, workTreeStatus, kind };
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').trim();
}

export function collectChangedFiles(options: CollectChangedFilesOptions = {}): ChangedFile[] {
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? defaultRunner;
  const raw = runner(['status', '--porcelain'], cwd);
  return raw.split(/\r?\n/).map(parsePorcelainLine).filter((x): x is ChangedFile => x !== null);
}

// ────────────────────────────────────────────────────────────────────────────
// 파일 → 에이전트 매핑
// ────────────────────────────────────────────────────────────────────────────

export interface AgentTaskInput {
  agentId: string;
  agentName?: string;
  description: string;
  /** 에이전트가 직접 보고한 작업 파일들(있으면 매핑의 1순위 근거). */
  files?: readonly string[];
}

export interface AgentFileGroup {
  agentId: string;
  agentName?: string;
  files: ChangedFile[];
}

export interface MapFilesToAgentsResult {
  /** 1개 이상의 파일이 매핑된 에이전트 그룹들. tasks 입력 순서를 보존. */
  groups: AgentFileGroup[];
  /** 어떤 에이전트에도 매핑되지 못한 변경 파일들. */
  unassigned: ChangedFile[];
}

interface RankedToken {
  token: string;
  /** 원본 description 에서의 단어 인덱스(공백 분리 기준). 작을수록 앞쪽. */
  originalIndex: number;
}

/**
 * description 을 단어 토큰으로 분리한다. 한국어·영문·숫자·일부 기호(`/.-_`) 만 살리고
 * 그 외는 공백으로 치환해 split. 너무 짧은 토큰(<3글자) 과 흔한 한국어 어미는 제외.
 *
 * 필터링 후에도 "원본 description 에서 몇 번째 단어였는가" 를 보존해, 매핑 우선순위
 * 결정 시 description 본문 등장 순서를 기준으로 비교할 수 있게 한다.
 */
function tokenize(description: string): RankedToken[] {
  const cleaned = description
    .toLowerCase()
    .replace(/[^a-z0-9가-힣/._-]+/g, ' ');
  const stop = new Set(['the', 'and', 'for', 'with', 'from', '하다', '추가', '수정', '구현']);
  const result: RankedToken[] = [];
  cleaned.split(/\s+/).forEach((raw, idx) => {
    const t = raw.trim();
    if (t.length >= 3 && !stop.has(t)) result.push({ token: t, originalIndex: idx });
  });
  return result;
}

/**
 * ChangedFile 경로를 매칭 후보 토큰들로 펼친다. 예: `src/server/llm/oneshot.ts` →
 * [`src/server/llm/oneshot.ts`, `oneshot.ts`, `oneshot`, `llm`, `server`, `src`].
 */
function pathMatchTokens(path: string): string[] {
  const lower = path.toLowerCase();
  const segments = lower.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const lastNoExt = last.replace(/\.[^.]+$/, '');
  const tokens = new Set<string>([lower, last, lastNoExt, ...segments]);
  return Array.from(tokens).filter(t => t.length > 0);
}

export function mapFilesToAgents(
  tasks: readonly AgentTaskInput[],
  changedFiles: readonly ChangedFile[],
): MapFilesToAgentsResult {
  const groups: AgentFileGroup[] = tasks.map(t => ({
    agentId: t.agentId,
    agentName: t.agentName,
    files: [],
  }));
  const taskTokens: RankedToken[][] = tasks.map(t => tokenize(t.description));
  const explicitFiles: Set<string>[] = tasks.map(
    t => new Set((t.files ?? []).map(normalize)),
  );

  const unassigned: ChangedFile[] = [];

  for (const file of changedFiles) {
    // (a) 명시적 파일 일치 — 1순위.
    let matched = -1;
    for (let i = 0; i < tasks.length; i += 1) {
      if (explicitFiles[i].has(file.path) || (file.oldPath && explicitFiles[i].has(file.oldPath))) {
        matched = i;
        break;
      }
    }

    // (b) 설명 토큰과 파일 경로 토큰의 교집합. 동률이면 description 원본에서 더
    //     앞쪽 단어를 가진 태스크가 이긴다 — RankedToken.originalIndex 로 비교.
    if (matched < 0) {
      const candidateTokens = pathMatchTokens(file.path);
      let bestIdx = -1;
      let bestRank = Infinity;
      for (let i = 0; i < tasks.length; i += 1) {
        const tt = taskTokens[i];
        for (let j = 0; j < tt.length; j += 1) {
          if (candidateTokens.includes(tt[j].token)) {
            if (tt[j].originalIndex < bestRank) {
              bestRank = tt[j].originalIndex;
              bestIdx = i;
            }
            break;
          }
        }
      }
      matched = bestIdx;
    }

    if (matched >= 0) groups[matched].files.push(file);
    else unassigned.push(file);
  }

  return {
    groups: groups.filter(g => g.files.length > 0),
    unassigned,
  };
}
