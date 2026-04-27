// MCP 클라이언트 풀(로컬 LLM 측 MCP 통합) 회귀 테스트.
//
// 검증 범위
//   1) 도구 이름 sanitize / namespace 분해 — OpenAI function-calling 의 이름 규칙
//      (^[a-zA-Z0-9_-]+$) 을 위반하는 입력이 들어와도 안전한 이름으로 정규화된다.
//   2) createMcpClientPool — factory 를 주입해 SDK 의존 없이 connect/listTools/
//      callTool 의 분기 동작을 잠근다.
//      - 정상 경로: tools 가 namespaced 정의로 노출, callTool 이 텍스트를 합쳐 반환
//      - 에러 경로: 한 서버 connect 실패가 다른 서버를 막지 않는다
//      - close 가 idempotent 하게 동작한다
//   3) tools-adapter — getToolDefinitions 가 풀의 도구를 합쳐 노출, executeLocalTool
//      이 namespaced 호출을 풀로 dispatch 한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMcpClientPool,
  makeQualifiedToolName,
  parseQualifiedToolName,
  sanitizeToolNamePart,
  type McpClientFactory,
} from '../src/server/llm/mcp-client-pool';
import { executeLocalTool, getToolDefinitions } from '../src/server/llm/tools-adapter';
import type { McpServerRecord } from '../src/stores/projectMcpServersStore';

// ────────────────────────────────────────────────────────────────────────────
// 이름 규칙
// ────────────────────────────────────────────────────────────────────────────

test('sanitizeToolNamePart — 허용 외 문자는 언더스코어로, 64자로 잘린다', () => {
  assert.equal(sanitizeToolNamePart('figma.dev'), 'figma_dev');
  assert.equal(sanitizeToolNamePart('foo:bar/baz'), 'foo_bar_baz');
  assert.equal(sanitizeToolNamePart('plain-name_1'), 'plain-name_1');
  const long = 'a'.repeat(120);
  assert.equal(sanitizeToolNamePart(long).length, 64);
});

test('makeQualifiedToolName / parseQualifiedToolName — 더블 언더스코어 분리자', () => {
  const q = makeQualifiedToolName('figma.dev', 'list_files');
  assert.equal(q, 'figma_dev__list_files');
  assert.deepEqual(parseQualifiedToolName(q), { serverName: 'figma_dev', toolName: 'list_files' });
  assert.equal(parseQualifiedToolName('no_separator'), null);
});

// ────────────────────────────────────────────────────────────────────────────
// createMcpClientPool — factory 주입 단위 테스트
// ────────────────────────────────────────────────────────────────────────────

interface FakeClient {
  listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  close: () => Promise<void>;
  closed: boolean;
  callLog: { name: string; arguments?: Record<string, unknown> }[];
}

function makeFakeClient(tools: Array<{ name: string; description?: string; inputSchema?: unknown }>, override?: {
  callResult?: (name: string, args?: Record<string, unknown>) => { content?: Array<{ type: string; text?: string }>; isError?: boolean };
}): FakeClient {
  const callLog: FakeClient['callLog'] = [];
  return {
    closed: false,
    callLog,
    async listTools() { return { tools }; },
    async callTool(params) {
      callLog.push(params);
      return override?.callResult?.(params.name, params.arguments) ?? {
        content: [{ type: 'text', text: `ok:${params.name}` }],
      };
    },
    async close() { this.closed = true; },
  };
}

const FIGMA_RECORD: McpServerRecord = {
  id: 'srv-1', projectId: 'p1', name: 'figma-dev',
  transport: 'stdio', command: 'node', args: ['./figma.js'], env: {},
  createdAt: 1, schemaVersion: 2,
};

const SECOND_RECORD: McpServerRecord = {
  id: 'srv-2', projectId: 'p1', name: 'broken',
  transport: 'stdio', command: 'node', args: ['./broken.js'], env: {},
  createdAt: 2, schemaVersion: 2,
};

test('createMcpClientPool — 정상 경로: 도구가 namespaced 로 노출되고 호출이 dispatch 된다', async () => {
  const figma = makeFakeClient([
    { name: 'list_files', description: 'List files', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } },
    { name: 'read_file', description: 'Read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ]);
  const factory: McpClientFactory = {
    open: async () => figma as unknown as Awaited<ReturnType<McpClientFactory['open']>>,
  };
  const pool = await createMcpClientPool([FIGMA_RECORD], { factory });
  const defs = pool.toolDefinitions();
  assert.deepEqual(defs.map(d => d.name).sort(), ['figma-dev__list_files', 'figma-dev__read_file']);
  assert.match(defs[0].description, /\[figma-dev\]/);
  assert.equal(pool.hasTool('figma-dev__read_file'), true);
  assert.equal(pool.hasTool('unknown__tool'), false);
  const result = await pool.callTool('figma-dev__read_file', { path: 'a.md' });
  assert.equal(result, 'ok:read_file');
  assert.deepEqual(figma.callLog, [{ name: 'read_file', arguments: { path: 'a.md' } }]);
  await pool.close();
  assert.equal(figma.closed, true);
});

test('createMcpClientPool — 한 서버 connect 실패가 다른 서버를 막지 않는다', async () => {
  const figma = makeFakeClient([{ name: 'ping', description: 'Ping' }]);
  const factory: McpClientFactory = {
    open: async (record) => {
      if (record.name === 'broken') throw new Error('boom');
      return figma as unknown as Awaited<ReturnType<McpClientFactory['open']>>;
    },
  };
  const pool = await createMcpClientPool([FIGMA_RECORD, SECOND_RECORD], { factory });
  const ok = pool.status.find(s => s.name === 'figma-dev');
  const bad = pool.status.find(s => s.name === 'broken');
  assert.equal(ok?.ok, true);
  assert.equal(bad?.ok, false);
  assert.match(bad?.error ?? '', /boom/);
  // 정상 서버의 도구는 그대로 노출된다.
  assert.deepEqual(pool.toolDefinitions().map(d => d.name), ['figma-dev__ping']);
  await pool.close();
});

test('createMcpClientPool — callTool 의 isError=true 응답은 throw 로 변환된다', async () => {
  const fake = makeFakeClient(
    [{ name: 'broken_tool' }],
    { callResult: () => ({ isError: true, content: [{ type: 'text', text: 'detailed reason' }] }) },
  );
  const factory: McpClientFactory = {
    open: async () => fake as unknown as Awaited<ReturnType<McpClientFactory['open']>>,
  };
  const pool = await createMcpClientPool([FIGMA_RECORD], { factory });
  await assert.rejects(() => pool.callTool('figma-dev__broken_tool', {}), /detailed reason/);
});

test('createMcpClientPool — listTools 가 inputSchema 를 안 주면 빈 객체 스키마로 폴백', async () => {
  const fake = makeFakeClient([{ name: 'no_schema' }]);
  const factory: McpClientFactory = {
    open: async () => fake as unknown as Awaited<ReturnType<McpClientFactory['open']>>,
  };
  const pool = await createMcpClientPool([FIGMA_RECORD], { factory });
  const def = pool.toolDefinitions()[0];
  assert.deepEqual(def.parameters, { type: 'object', properties: {} });
});

// ────────────────────────────────────────────────────────────────────────────
// tools-adapter 통합
// ────────────────────────────────────────────────────────────────────────────

test('getToolDefinitions — mcpPool 도구가 함께 노출된다', async () => {
  const figma = makeFakeClient([{ name: 'list_files', inputSchema: { type: 'object', properties: {} } }]);
  const factory: McpClientFactory = {
    open: async () => figma as unknown as Awaited<ReturnType<McpClientFactory['open']>>,
  };
  const pool = await createMcpClientPool([FIGMA_RECORD], { factory });
  const defs = getToolDefinitions({ workspacePath: '/tmp/ws', mcpPool: pool });
  // 내장 + workspace + mcp.
  const names = defs.map(d => d.name);
  assert.ok(names.includes('whoami'));
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('figma-dev__list_files'));
});

test('executeLocalTool — namespaced 도구는 mcpPool.callTool 로 dispatch 된다', async () => {
  const figma = makeFakeClient(
    [{ name: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }],
    { callResult: (_name, args) => ({ content: [{ type: 'text', text: `said:${(args as { msg: string }).msg}` }] }) },
  );
  const factory: McpClientFactory = {
    open: async () => figma as unknown as Awaited<ReturnType<McpClientFactory['open']>>,
  };
  const pool = await createMcpClientPool([FIGMA_RECORD], { factory });
  const result = await executeLocalTool('figma-dev__echo', { msg: 'hi' }, {
    agentId: 'a1',
    projectId: 'p1',
    port: 3000,
    mcpPool: pool,
  });
  assert.equal(result, 'said:hi');
  await pool.close();
});
