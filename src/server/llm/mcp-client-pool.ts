// 로컬 LLM(ollama / vllm) 측 MCP 통합 — 외부 MCP 서버를 OpenAI function-calling
// 도구로 노출하는 풀.
//
// Claude CLI 는 자체 `--mcp-config` 인자로 MCP 서버를 직접 들고 있지만, LocalAgentWorker
// 가 사용하는 ollama / vllm 은 OpenAI function-calling 호환 인터페이스만 알아본다.
// 본 모듈은 그 사이를 잇는 어댑터 역할이다:
//
//   1) 등록된 McpServerRecord 를 stdio 또는 streamable-http 클라이언트로 connect.
//   2) 각 서버의 listTools 결과를 namespaced ToolDefinition 으로 변환
//      (`<serverName>__<toolName>`).
//   3) executeLocalTool 이 namespace 를 인지해 호출을 callTool 로 위임.
//
// 설계 원칙
//   · 한 서버의 실패가 다른 서버를 막지 않는다 — Promise.allSettled 로 connect 한다.
//   · 도구 이름은 OpenAI function-calling 의 ^[a-zA-Z0-9_-]+$ 규칙을 위반하지 않도록
//     일관되게 sanitize 한다(`.` `:` 등은 `_` 로 치환).
//   · close 는 idempotent — LocalAgentWorker 의 dispose 에서 한 번만 부르면 충분하다.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { McpServerRecord } from '../../stores/projectMcpServersStore';
import type { ToolDefinition } from './provider';

// 도구 이름 prefix 분리자. `<serverName>__<toolName>` 으로 합친다 — 더블 언더스코어
// 는 OpenAI function-calling 이름 규칙(^[a-zA-Z0-9_-]+$)에 합법이고, 외부 MCP 서버가
// 단일 언더스코어를 도구 이름에 자주 쓰기 때문에 충돌을 피한다.
const NAMESPACE_SEP = '__';

export interface McpToolEntry {
  /** OpenAI function-calling 에 노출되는 namespaced 이름. */
  qualifiedName: string;
  /** 사용자 등록 서버 이름(McpServerRecord.name). */
  serverName: string;
  /** 원본 MCP 도구 이름. */
  toolName: string;
  description: string;
  /** OpenAI function-calling parameters JSON Schema. MCP 측 inputSchema 를 그대로 사용. */
  parameters: Record<string, unknown>;
}

export interface McpClientPool {
  /** Connect 결과(성공·실패) 를 디버깅용으로 노출. */
  status: ReadonlyArray<{ name: string; ok: boolean; error?: string; toolCount: number }>;
  /** namespaced ToolDefinition 배열 — getToolDefinitions 결과에 합치면 그대로 LLM 에 노출된다. */
  toolDefinitions(): ToolDefinition[];
  /** 도구 이름이 본 풀에 속하는지 빠르게 확인(executeLocalTool 분기용). */
  hasTool(qualifiedName: string): boolean;
  /**
   * 본 풀로 들어온 도구 호출을 MCP callTool 로 위임. 결과는 텍스트 콘텐츠를 join 해
   * 단일 문자열로 돌려준다 — tools-adapter 의 다른 도구와 동일한 반환 컨벤션.
   * 도구 이름을 못 찾으면 throw 해서 LLM 에 명확한 에러로 전달되게 한다.
   */
  callTool(qualifiedName: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

interface ConnectedClient {
  serverName: string;
  client: Client;
  /** McpToolEntry 로 변환된 목록. */
  tools: McpToolEntry[];
}

interface CreatePoolOptions {
  /** 호출자(LocalAgentWorker) 식별자 — Client 메타에 들어가 디버깅에 도움. */
  agentId?: string;
  /** 테스트 주입 — Client 와 Transport 생성을 가짜로 교체할 수 있게 한다. */
  factory?: McpClientFactory;
}

/**
 * 테스트 시 SDK 의존을 끊기 위한 팩토리 인터페이스. `connect` 는 connect 까지 책임지고,
 * 결과 객체로 listTools / callTool / close 를 노출하면 된다.
 */
export interface McpClientFactory {
  open(record: McpServerRecord, agentId: string | undefined): Promise<{
    listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
    callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>;
    close(): Promise<void>;
  }>;
}

const DEFAULT_FACTORY: McpClientFactory = {
  async open(record, agentId) {
    const client = new Client(
      { name: `llm-tycoon-agent${agentId ? `-${agentId}` : ''}`, version: '0.1.0' },
      { capabilities: {} },
    );
    if (record.transport === 'stdio') {
      const transport = new StdioClientTransport({
        command: record.command,
        args: record.args,
        env: { ...record.env },
      });
      await client.connect(transport);
    } else {
      // http / streamable-http — SDK 의 StreamableHTTPClientTransport 가 일반 HTTP
      // 응답과 SSE 스트림 둘 다 처리해 준다. Authorization 토큰은 header 에 미리
      // 합쳐 두면 매 요청에 그대로 따라간다.
      const headers: Record<string, string> = { ...(record.headers ?? {}) };
      if (record.authToken && !headers.Authorization && !headers.authorization) {
        headers.Authorization = `Bearer ${record.authToken}`;
      }
      const transport = new StreamableHTTPClientTransport(new URL(record.url ?? ''), {
        requestInit: { headers },
      });
      await client.connect(transport);
    }
    return {
      listTools: () => client.listTools(),
      callTool: (params) => client.callTool(params),
      close: () => client.close(),
    };
  },
};

/**
 * 도구 이름 sanitize — OpenAI function-calling 은 ^[a-zA-Z0-9_-]+$ 만 허용한다.
 * 점/콜론/슬래시 등이 들어오면 언더스코어로 정규화한다. 과도하게 긴 이름은 64자로 잘라
 * 모델별 길이 제한도 동시에 만족시킨다.
 */
export function sanitizeToolNamePart(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (cleaned.length <= 64) return cleaned;
  return cleaned.slice(0, 64);
}

export function makeQualifiedToolName(serverName: string, toolName: string): string {
  return `${sanitizeToolNamePart(serverName)}${NAMESPACE_SEP}${sanitizeToolNamePart(toolName)}`;
}

export function parseQualifiedToolName(qualified: string): { serverName: string; toolName: string } | null {
  const idx = qualified.indexOf(NAMESPACE_SEP);
  if (idx <= 0) return null;
  return {
    serverName: qualified.slice(0, idx),
    toolName: qualified.slice(idx + NAMESPACE_SEP.length),
  };
}

export async function createMcpClientPool(
  records: ReadonlyArray<McpServerRecord>,
  options: CreatePoolOptions = {},
): Promise<McpClientPool> {
  const factory = options.factory ?? DEFAULT_FACTORY;
  const status: { name: string; ok: boolean; error?: string; toolCount: number }[] = [];
  const connected: ConnectedClient[] = [];

  // 한 서버의 실패가 다른 서버 부팅을 막지 않는다. allSettled 로 받아 결과를 분류.
  const settled = await Promise.allSettled(
    records.map(async (record) => {
      const client = await factory.open(record, options.agentId);
      const list = await client.listTools();
      const tools: McpToolEntry[] = (list.tools ?? []).map((t) => ({
        qualifiedName: makeQualifiedToolName(record.name, t.name),
        serverName: record.name,
        toolName: t.name,
        description: t.description ?? `${record.name}/${t.name}`,
        parameters: (t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema))
          ? (t.inputSchema as Record<string, unknown>)
          : { type: 'object', properties: {} },
      }));
      return { record, client, tools };
    }),
  );
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const record = records[i];
    if (s.status === 'fulfilled') {
      connected.push({ serverName: record.name, client: s.value.client as unknown as Client, tools: s.value.tools });
      status.push({ name: record.name, ok: true, toolCount: s.value.tools.length });
    } else {
      status.push({
        name: record.name,
        ok: false,
        error: (s.reason as Error)?.message ?? String(s.reason),
        toolCount: 0,
      });
    }
  }

  const toolByQualified = new Map<string, ConnectedClient>();
  for (const c of connected) {
    for (const t of c.tools) toolByQualified.set(t.qualifiedName, c);
  }

  return {
    status,
    toolDefinitions(): ToolDefinition[] {
      const out: ToolDefinition[] = [];
      for (const c of connected) {
        for (const t of c.tools) {
          out.push({
            name: t.qualifiedName,
            description: `[${t.serverName}] ${t.description}`,
            parameters: t.parameters,
          });
        }
      }
      return out;
    },
    hasTool(qualifiedName) {
      return toolByQualified.has(qualifiedName);
    },
    async callTool(qualifiedName, args) {
      const owner = toolByQualified.get(qualifiedName);
      if (!owner) {
        throw new Error(`MCP 도구를 찾을 수 없습니다: ${qualifiedName}`);
      }
      const parsed = parseQualifiedToolName(qualifiedName);
      // 풀의 도구는 항상 namespaced 이지만 방어적으로 분기.
      const realName = parsed
        ? owner.tools.find((t) => t.qualifiedName === qualifiedName)?.toolName ?? parsed.toolName
        : qualifiedName;
      const result = await (owner.client as unknown as {
        callTool: (p: { name: string; arguments?: Record<string, unknown> }) => Promise<{
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        }>;
      }).callTool({ name: realName, arguments: args });
      // MCP 응답은 content 배열 — text 만 모아 문자열로. 이미지/리소스는 후속 처리.
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
      if (result.isError) {
        throw new Error(text || `MCP 도구 호출 실패: ${qualifiedName}`);
      }
      return text;
    },
    async close() {
      await Promise.allSettled(connected.map((c) => (c.client as unknown as { close: () => Promise<void> }).close()));
    },
  };
}
