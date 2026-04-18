import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { inferFileType, isExcludedFromCodeGraph } from './src/utils/codeGraphFilter';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const AGENT_ID = process.env.AGENT_ID || '';
const PROJECT_ID = process.env.PROJECT_ID || '';

async function api(route: string, init?: RequestInit) {
  const res = await fetch(`${API_URL}${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

const server = new Server(
  { name: 'llm-tycoon-agent', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'update_status',
      description: '자신(에이전트)의 상태와 현재 작업 중인 파일을 보고합니다. 작업 시작/종료 시점에 반드시 호출하세요.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['idle', 'working', 'meeting', 'thinking'],
            description: '현재 상태',
          },
          working_on_file_id: {
            type: 'string',
            description: '현재 작업 중인 파일 ID. 해제하려면 빈 문자열.',
          },
        },
      },
    },
    {
      name: 'list_files',
      description: '현재 프로젝트의 코드 파일 목록과 ID/이름/타입을 조회합니다.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'add_file',
      description: '코드 그래프에 새 파일 노드를 추가합니다. 신규 기능 구현 시 사용.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: '파일명 (예: LoginForm.tsx)' },
          type: {
            type: 'string',
            enum: ['component', 'service', 'util', 'style'],
            description: '파일 종류',
          },
        },
      },
    },
    {
      name: 'add_dependency',
      description: '두 파일 사이에 의존성 엣지를 추가합니다.',
      inputSchema: {
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
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_git_automation_settings',
      description: '현재 프로젝트의 Git 자동화 설정(활성 여부/flow/템플릿 등)을 조회합니다. 리더가 동료 완료 이벤트 후 자동 실행 여부를 판정할 때 사용.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'trigger_git_automation',
      description: '저장된 Git 자동화 설정에 따라 commit/push/createPR 단계를 서버에서 실행합니다. 설정이 비활성이면 skipped 응답.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '변경 유형(feat/fix/chore 등)' },
          summary: { type: 'string', description: '한 줄 요약 — 브랜치/커밋 메시지/PR 제목에 사용' },
          agent: { type: 'string', description: '완료를 보고한 동료 에이전트 이름(선택)' },
          prBase: { type: 'string', description: 'PR base 브랜치(선택). 지정 안하면 레포 기본 브랜치.' },
          branchStrategy: {
            type: 'string',
            enum: ['new', 'current'],
            description: "'new' 면 branchName 으로 `git checkout -B` 후 커밋, 'current' 면 현재 HEAD 브랜치에 그대로 커밋(선택). 지정 안하면 저장된 설정값을 사용.",
          },
          branchName: {
            type: 'string',
            description: "branchStrategy='new' 일 때 사용할 브랜치명(선택). 빈 값이면 Project.branchStrategy 기반 resolveBranch 폴백.",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, any>;
  try {
    if (name === 'whoami') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ agentId: AGENT_ID, projectId: PROJECT_ID, apiUrl: API_URL }),
        }],
      };
    }
    if (name === 'update_status') {
      if (!AGENT_ID) throw new Error('AGENT_ID not set');
      const body = JSON.stringify({
        status: a.status,
        workingOnFileId: a.working_on_file_id === '' ? null : a.working_on_file_id,
      });
      await api(`/api/agents/${AGENT_ID}/status`, { method: 'PATCH', body });
      return { content: [{ type: 'text', text: 'status updated' }] };
    }
    if (name === 'list_files') {
      const files = await api(`/api/files${PROJECT_ID ? `?projectId=${encodeURIComponent(PROJECT_ID)}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
    }
    if (name === 'add_file') {
      if (!PROJECT_ID) throw new Error('PROJECT_ID not set');
      if (isExcludedFromCodeGraph(String(a.name ?? ''))) {
        return {
          content: [{ type: 'text', text: `skipped: ${a.name} is under an excluded path` }],
        };
      }
      const body = JSON.stringify({
        name: a.name,
        projectId: PROJECT_ID,
        type: a.type || inferFileType(String(a.name ?? '')),
      });
      const file = await api('/api/files', { method: 'POST', body });
      return { content: [{ type: 'text', text: `created: ${JSON.stringify(file)}` }] };
    }
    if (name === 'add_dependency') {
      const body = JSON.stringify({ from: a.from_file_id, to: a.to_file_id });
      await api('/api/dependencies', { method: 'POST', body });
      return { content: [{ type: 'text', text: 'dependency added' }] };
    }
    if (name === 'get_git_automation_settings') {
      if (!PROJECT_ID) throw new Error('PROJECT_ID not set');
      const settings = await api(`/api/projects/${encodeURIComponent(PROJECT_ID)}/git-automation`);
      return { content: [{ type: 'text', text: JSON.stringify(settings, null, 2) }] };
    }
    if (name === 'trigger_git_automation') {
      if (!PROJECT_ID) throw new Error('PROJECT_ID not set');
      const body = JSON.stringify({
        type: a.type,
        summary: a.summary,
        agent: a.agent,
        prBase: a.prBase,
        // 선택 오버라이드. enum/문자열 외 값은 서버 경계에서 걸러진다.
        branchStrategy: a.branchStrategy,
        branchName: a.branchName,
      });
      const out = await api(`/api/projects/${encodeURIComponent(PROJECT_ID)}/git-automation/run`, { method: 'POST', body });
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    }
    return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  } catch (e: any) {
    return { content: [{ type: 'text', text: `error: ${e?.message || e}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(err => {
  console.error('mcp-agent-server fatal:', err);
  process.exit(1);
});
