// MCP 도구 ↔ OpenAI function-calling 어댑터 (#llm-provider-abstraction)
//
// Claude CLI 는 MCP stdio 서버를 직접 기동하므로 이 파일이 필요하지 않다. 하지만
// Ollama / vLLM 같은 로컬 모델은 MCP 를 알지 못하므로, 같은 도구 셋을 OpenAI
// function-calling 스키마로 노출하고, 도구 실행은 이 모듈이 서버의 REST
// 엔드포인트로 직접 프록시한다. mcp-agent-server.ts 가 하던 일과 동일한 REST
// 호출을 수행하되, 자식 프로세스 없이 인-프로세스에서 실행한다.

import type { ToolDefinition } from './provider';
import { inferFileType, isExcludedFromCodeGraph } from '../../utils/codeGraphFilter';
import {
  editFileContent,
  grepFiles as grepFilesFs,
  listFiles as listFilesFs,
  readFileChunk,
  writeFileContent,
  type ListEntry,
  type ReadFileResult,
} from './workspace-fs';

export interface LocalToolContext {
  agentId: string;
  projectId: string;
  /** 서버가 바인드한 로컬 포트 (기본 3000). REST 도구 호출은 이 주소로 나간다. */
  port: number;
  /**
   * 워크스페이스 루트 절대경로. read_file/write_file/edit_file/list_files_fs/grep_files
   * 같은 파일 직통 도구는 이 경로 안에서만 동작한다. 값이 비어 있으면 파일 도구는
   * 전부 비활성 상태로 간주된다(진단 ping 등 컨텍스트 없는 호출).
   */
  workspacePath?: string;
}

// MCP mcp-agent-server.ts 에 정의된 7개 도구를 OpenAI function-calling 스키마로
// 그대로 재노출. 새 도구를 MCP 에 추가하면 이 배열도 확장해야 한다 — 두 곳을
// 동기화하는 테스트가 mcp-agent-server 회귀 테스트에 포함돼 있다(추후 추가).
export const LOCAL_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'update_status',
    description: '자신(에이전트)의 상태와 현재 작업 중인 파일을 보고합니다. 작업 시작/종료 시점에 반드시 호출하세요.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['idle', 'working', 'meeting', 'thinking'] },
        working_on_file_id: { type: 'string', description: '현재 작업 중인 파일 ID. 해제하려면 빈 문자열.' },
      },
    },
  },
  {
    name: 'list_files',
    description: '현재 프로젝트의 코드 파일 목록과 ID/이름/타입을 조회합니다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'add_file',
    description: '코드 그래프에 새 파일 노드를 추가합니다. 신규 기능 구현 시 사용.',
    parameters: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: '파일명 (예: LoginForm.tsx)' },
        type: { type: 'string', enum: ['component', 'service', 'util', 'style'] },
      },
    },
  },
  {
    name: 'add_dependency',
    description: '두 파일 사이에 의존성 엣지를 추가합니다.',
    parameters: {
      type: 'object',
      required: ['from_file_id', 'to_file_id'],
      properties: {
        from_file_id: { type: 'string' },
        to_file_id: { type: 'string' },
      },
    },
  },
  {
    name: 'whoami',
    description: '현재 MCP 컨텍스트(에이전트 ID, 프로젝트 ID)를 확인합니다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_git_automation_settings',
    description: '현재 프로젝트의 Git 자동화 설정(활성 여부/flow/템플릿 등)을 조회합니다.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'trigger_git_automation',
    description: '저장된 Git 자동화 설정에 따라 commit/push/createPR 단계를 서버에서 실행합니다. 설정이 비활성이면 skipped 응답.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        summary: { type: 'string' },
        agent: { type: 'string' },
        prBase: { type: 'string' },
        branchStrategy: { type: 'string', enum: ['new', 'current'] },
        branchName: { type: 'string' },
      },
    },
  },
];

// ─── 파일 직통 도구 (workspace 가 있을 때만 노출) ─────────────────────────────
// Claude CLI 는 자체 내장 Read/Write/Edit 도구가 있어 이 정의가 필요 없다. 로컬 LLM
// (Ollama/vLLM) 은 이 5개 도구로 실제 워크스페이스 파일을 읽고·검색하고·편집한다.
// 구현은 workspace-fs.ts 의 스트리밍 기반 함수들에 위임되어 대용량 파일(수십만 줄)
// 대응과 파일 단위 동시 편집 락이 자동 적용된다.

export const WORKSPACE_FILE_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      '워크스페이스 파일의 줄 범위를 읽습니다. 대용량 파일(수십만 줄)도 전체를 한 번에 가져오지 말고 offset/limit 으로 필요한 창만 요청하세요. 응답은 한 줄 메타 헤더(start/end/total/next_offset) + 빈 줄 + 원문(JSON 비포장) 입니다. 다음 청크를 이어 읽으려면 응답의 next_offset 값을 그대로 다음 호출의 offset 으로 넘기세요(has_more=false 면 next_offset=null).',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: '워크스페이스 기준 상대경로' },
        offset: { type: 'integer', minimum: 0, description: '시작 줄 번호(0-based). 기본 0.' },
        limit: { type: 'integer', minimum: 1, maximum: 10000, description: '가져올 줄 수. 기본 200(로컬 LLM 컨텍스트 보호), 최대 10000.' },
      },
    },
  },
  {
    name: 'write_file',
    description:
      '워크스페이스 파일을 덮어쓰거나 새로 생성합니다. 부모 디렉터리는 자동 생성. 수십만 줄 파일을 전체 재작성하려 하지 말고, 편집은 edit_file 을 사용하세요. .git/node_modules/dist 등은 쓰기 금지.',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
    },
  },
  {
    name: 'edit_file',
    description:
      'old_string 을 new_string 으로 정확 일치 교체합니다. 대상 줄 범위(offset/limit) 를 주면 그 청크만 메모리에 올리고 나머지는 스트림으로 그대로 보존합니다(수십만 줄 파일도 메모리 피크 제한). 범위 내에 old_string 이 1회만 나오지 않으면 에러 — 고유한 맥락을 포함하거나 replace_all=true 로 명시하세요.',
    parameters: {
      type: 'object',
      required: ['path', 'old_string', 'new_string'],
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        offset: { type: 'integer', minimum: 0, description: '청크 시작 줄(0-based). 생략하면 전체 파일 대상.' },
        limit: { type: 'integer', minimum: 1, description: '청크 줄 수. offset 과 함께 지정.' },
        replace_all: { type: 'boolean', description: '범위 내 모든 매칭을 교체. 기본 false.' },
      },
    },
  },
  {
    name: 'list_files_fs',
    description:
      '워크스페이스 파일 트리를 조회합니다. `.git` / `node_modules` / `dist` / `build` 등 노이즈 디렉터리는 자동 제외됩니다. 코드 그래프가 아니라 실제 파일 시스템입니다 — 코드 그래프 노드 조회는 list_files 를 쓰세요. 응답은 들여쓰기 텍스트 트리(JSON 아님)이며, 처음 호출은 max_depth=1 또는 2 로 좁혀 시작하고 필요한 디렉터리를 식별한 뒤 dir 인자로 좁혀 들어가세요.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '탐색 시작 디렉터리. 기본 워크스페이스 루트.' },
        glob: { type: 'string', description: '파일 매칭 패턴 (예: `src/**/*.ts`, `*.md`).' },
        max_depth: { type: 'integer', minimum: 0, description: '탐색 깊이 상한. 0=dir 직속만, 1=한 단계 더, ... 기본 1(로컬 LLM 토큰 절약). 전체를 보고 싶으면 큰 값(예: 100) 명시.' },
      },
    },
  },
  {
    name: 'grep_files',
    description:
      '정규식으로 파일 내용을 검색합니다. 수십만 줄 파일도 스트림으로 한 줄씩 검사해 매칭 limit 개가 모이면 조기 종료합니다. 응답의 next_cursor 를 다음 호출에 그대로 넘기면 중단 지점부터 재개됩니다.',
    parameters: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'JavaScript 정규식 문법' },
        glob: { type: 'string', description: '검색 대상 파일 필터 (기본 `**/*`)' },
        cursor: { type: 'string', description: '이전 호출 응답의 next_cursor 값. 새로 시작하면 비워 둡니다.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '이번 호출에서 수집할 최대 매칭 수. 기본 20, 최대 100.' },
      },
    },
  },
];

/**
 * 주어진 컨텍스트에서 노출해도 되는 도구 정의 전체를 돌려준다. workspacePath 가 없으면
 * 파일 직통 도구는 숨긴다. 로컬 LLM 이 혼란스러운 "있어 보이지만 실패하는" 도구를 물지
 * 않도록 스키마 단계에서 제외.
 */
export function getToolDefinitions(ctx: Pick<LocalToolContext, 'workspacePath'>): ToolDefinition[] {
  if (ctx.workspacePath) {
    return [...LOCAL_TOOL_DEFINITIONS, ...WORKSPACE_FILE_TOOL_DEFINITIONS];
  }
  return [...LOCAL_TOOL_DEFINITIONS];
}

async function api(ctx: LocalToolContext, route: string, init?: RequestInit): Promise<unknown> {
  const url = `http://localhost:${ctx.port}${route}`;
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * 로컬 모델이 tool-call 로 지목한 도구를 서버 REST 로 프록시 실행한다.
 * 반환값은 모델에 주입할 tool role 메시지의 content 문자열.
 * mcp-agent-server.ts 와 1:1 로 대응되므로, MCP 경로와 결과가 동일해야 한다.
 */
export async function executeLocalTool(
  name: string,
  args: Record<string, unknown>,
  ctx: LocalToolContext,
): Promise<string> {
  try {
    if (name === 'whoami') {
      return JSON.stringify({
        agentId: ctx.agentId,
        projectId: ctx.projectId,
        apiUrl: `http://localhost:${ctx.port}`,
      });
    }
    if (name === 'update_status') {
      if (!ctx.agentId) throw new Error('AGENT_ID not set');
      const body = JSON.stringify({
        status: args.status,
        workingOnFileId: args.working_on_file_id === '' ? null : args.working_on_file_id,
      });
      await api(ctx, `/api/agents/${ctx.agentId}/status`, { method: 'PATCH', body });
      return 'status updated';
    }
    if (name === 'list_files') {
      const files = await api(
        ctx,
        `/api/files${ctx.projectId ? `?projectId=${encodeURIComponent(ctx.projectId)}` : ''}`,
      );
      return JSON.stringify(files, null, 2);
    }
    if (name === 'add_file') {
      if (!ctx.projectId) throw new Error('PROJECT_ID not set');
      const fileName = String(args.name ?? '');
      if (isExcludedFromCodeGraph(fileName)) {
        return `skipped: ${fileName} is under an excluded path`;
      }
      const body = JSON.stringify({
        name: fileName,
        projectId: ctx.projectId,
        type: args.type || inferFileType(fileName),
      });
      const file = await api(ctx, '/api/files', { method: 'POST', body });
      return `created: ${JSON.stringify(file)}`;
    }
    if (name === 'add_dependency') {
      // #local-llm-empty-args — 로컬 LLM(llama3.1:8b 실사례) 이 from/to 중 한쪽을 빈
      // 문자열로 호출해 무의미한 엣지 POST 가 나가는 경우가 있다. 여기서 빠르게
      // 거절해 서버 엔드포인트·DB 에 쓰레기 데이터가 도달하지 않도록 막는다.
      const fromId = typeof args.from_file_id === 'string' ? args.from_file_id.trim() : '';
      const toId = typeof args.to_file_id === 'string' ? args.to_file_id.trim() : '';
      if (!fromId || !toId) {
        return 'error: add_dependency 의 from_file_id / to_file_id 는 둘 다 실제 파일 ID 여야 합니다. 먼저 list_files 로 ID 를 확인하세요.';
      }
      if (fromId === toId) {
        return 'error: add_dependency 의 from_file_id 와 to_file_id 가 동일합니다';
      }
      const body = JSON.stringify({ from: fromId, to: toId });
      await api(ctx, '/api/dependencies', { method: 'POST', body });
      return 'dependency added';
    }
    if (name === 'get_git_automation_settings') {
      if (!ctx.projectId) throw new Error('PROJECT_ID not set');
      const settings = await api(ctx, `/api/projects/${encodeURIComponent(ctx.projectId)}/git-automation`);
      return JSON.stringify(settings, null, 2);
    }
    if (name === 'trigger_git_automation') {
      if (!ctx.projectId) throw new Error('PROJECT_ID not set');
      const body = JSON.stringify({
        type: args.type,
        summary: args.summary,
        agent: args.agent,
        prBase: args.prBase,
        branchStrategy: args.branchStrategy,
        branchName: args.branchName,
      });
      const out = await api(
        ctx,
        `/api/projects/${encodeURIComponent(ctx.projectId)}/git-automation/run`,
        { method: 'POST', body },
      );
      return JSON.stringify(out, null, 2);
    }

    // ─ 파일 직통 도구: workspace-fs 로 in-process 위임 ────────────────────────
    if (name === 'read_file' || name === 'write_file' || name === 'edit_file'
        || name === 'list_files_fs' || name === 'grep_files') {
      if (!ctx.workspacePath) {
        throw new Error('workspacePath 가 설정되지 않아 파일 도구를 사용할 수 없습니다');
      }
      if (name === 'read_file') {
        const p = requireString(args.path, 'path');
        const offset = toNonNegInt(args.offset);
        // 로컬 LLM 컨텍스트 보호 — 모델이 limit 을 생략하면 1000줄(JSON wrap 시 수천
        // 토큰) 이 한꺼번에 떨어져 8B 급 모델이 처리·요약을 못 하고 영문 풀어쓰기로
        // 빠지는 회귀가 있다. 첫 호출 디폴트를 보수적으로 200줄로 낮추고, 모델이
        // 의도적으로 더 보고 싶으면 limit 을 명시하도록 한다.
        const LOCAL_DEFAULT_READ_LIMIT = 200;
        const limit = args.limit === undefined ? LOCAL_DEFAULT_READ_LIMIT : toPosInt(args.limit);
        const r = await readFileChunk(ctx.workspacePath, p, offset, limit);
        return formatReadFileResult(p, r);
      }
      if (name === 'write_file') {
        const p = requireString(args.path, 'path');
        const content = requireString(args.content, 'content');
        const r = await writeFileContent(ctx.workspacePath, p, content);
        return JSON.stringify(r);
      }
      if (name === 'edit_file') {
        const p = requireString(args.path, 'path');
        const oldStr = requireString(args.old_string, 'old_string');
        const newStr = requireString(args.new_string, 'new_string');
        const offset = args.offset === undefined ? undefined : toNonNegInt(args.offset);
        const limit = args.limit === undefined ? undefined : toPosInt(args.limit);
        const replaceAll = args.replace_all === true;
        const r = await editFileContent(ctx.workspacePath, p, oldStr, newStr, { offset, limit, replaceAll });
        return JSON.stringify(r);
      }
      if (name === 'list_files_fs') {
        const dir = typeof args.dir === 'string' && args.dir ? args.dir : '.';
        const glob = typeof args.glob === 'string' && args.glob ? args.glob : undefined;
        // 로컬 LLM 토큰 보호 — 디폴트 max_depth=1 로 좁혀 첫 호출에서 평탄
        // 200+ 엔트리 JSON 이 떨어지지 않게 한다. 모델이 의도적으로 더 깊이 보려면
        // max_depth 를 명시해 호출.
        const LOCAL_DEFAULT_MAX_DEPTH = 1;
        const maxDepth = args.max_depth === undefined
          ? LOCAL_DEFAULT_MAX_DEPTH
          : toNonNegInt(args.max_depth);
        const entries = await listFilesFs(ctx.workspacePath, dir, glob, maxDepth);
        return formatListFilesAsTree(dir, entries);
      }
      if (name === 'grep_files') {
        const pattern = requireString(args.pattern, 'pattern');
        const glob = typeof args.glob === 'string' && args.glob ? args.glob : undefined;
        const cursor = typeof args.cursor === 'string' && args.cursor ? args.cursor : undefined;
        const limit = args.limit === undefined ? undefined : toPosInt(args.limit);
        const r = await grepFilesFs(ctx.workspacePath, pattern, glob, cursor, limit);
        return JSON.stringify(r);
      }
    }

    return `error: unknown tool ${name}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${field} 가 문자열이 아니거나 비어 있습니다`);
  }
  return v;
}
function toNonNegInt(v: unknown): number {
  if (v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new Error('offset 은 0 이상 정수');
  return n;
}
function toPosInt(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) throw new Error('limit 은 양의 정수');
  return n;
}

// ─── 모델 응답 포맷터 ────────────────────────────────────────────────────────
// 두 헬퍼 모두 "JSON.stringify 비포장 + 헤더 한 줄 + 본문 raw" 원칙. 8B 급 로컬
// 모델에서 JSON wrap 응답이 유발하던 회귀(content 의 \n→\\n 부풀림 + 영문
// 풀어쓰기 환각) 를 동시에 차단하기 위함.

/**
 * read_file 결과를 모델용 텍스트로 직렬화. 메타 두 줄 + `---` 구분선 + 원문(raw) .
 * has_more=false 면 (complete), true 면 (has_more=true, next_offset=N) 를 표기해
 * 모델이 산술 계산 없이 다음 호출의 offset 을 그대로 베껴 쓸 수 있게 한다.
 */
export function formatReadFileResult(filePath: string, r: ReadFileResult): string {
  const status = r.has_more
    ? `has_more=true, next_offset=${r.next_offset}`
    : 'complete';
  return [
    `read_file: ${filePath}`,
    `range: lines ${r.start_line}-${r.end_line} of ${r.total_lines} (${status})`,
    '---',
    r.content,
  ].join('\n');
}

// listFiles 가 반환하는 최대 entry 수. workspace-fs.ts 의 LIST_MAX_ENTRIES 와 동기화.
// (값을 export 해 import 하기보다, 절단 감지 휴리스틱으로 hardcode — 500 보다 작은
// 결과는 절단이 아님이 보장되고, 500 일 때만 안내가 붙는다.)
const LIST_MAX_ENTRIES_HEURISTIC = 500;

/**
 * list_files_fs 결과를 모델용 텍스트 트리로 직렬화. 정렬 규칙: 디렉터리 먼저(알파벳),
 * 그 다음 파일(알파벳). 디렉터리는 trailing `/`, 파일은 `path\tsize` 형식. 평탄
 * 경로(들여쓰기 없음) 라 어떤 깊이에서도 path 자체로 위치를 식별할 수 있다.
 *
 * entries.length 가 500(= LIST_MAX_ENTRIES) 에 도달하면 "절단됐을 수 있음 — dir/glob/
 * max_depth 로 좁혀라" 안내를 헤더에 첨부.
 */
export function formatListFilesAsTree(dir: string, entries: ListEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  const truncationNote = entries.length >= LIST_MAX_ENTRIES_HEURISTIC
    ? ' (절단됐을 수 있음 — dir/glob/max_depth 로 좁혀 재호출 권장)'
    : '';
  const lines: string[] = [
    `list_files_fs: ${dir} (${sorted.length} entries)${truncationNote}`,
  ];
  for (const e of sorted) {
    if (e.type === 'dir') {
      lines.push(`${e.path}/`);
    } else {
      lines.push(e.size !== undefined ? `${e.path}\t${e.size}b` : e.path);
    }
  }
  return lines.join('\n');
}
