// MCP 도구 ↔ OpenAI function-calling 어댑터 (#llm-provider-abstraction)
//
// Claude CLI 는 MCP stdio 서버를 직접 기동하므로 이 파일이 필요하지 않다. 하지만
// Ollama / vLLM 같은 로컬 모델은 MCP 를 알지 못하므로, 같은 도구 셋을 OpenAI
// function-calling 스키마로 노출하고, 도구 실행은 이 모듈이 서버의 REST
// 엔드포인트로 직접 프록시한다. mcp-agent-server.ts 가 하던 일과 동일한 REST
// 호출을 수행하되, 자식 프로세스 없이 인-프로세스에서 실행한다.

import type { ToolDefinition } from './provider';
import { inferFileType, isExcludedFromCodeGraph } from '../../utils/codeGraphFilter';

export interface LocalToolContext {
  agentId: string;
  projectId: string;
  /** 서버가 바인드한 로컬 포트 (기본 3000). REST 도구 호출은 이 주소로 나간다. */
  port: number;
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
      const body = JSON.stringify({ from: args.from_file_id, to: args.to_file_id });
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
    return `error: unknown tool ${name}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}
