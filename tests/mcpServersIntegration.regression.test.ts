// MCP 서버 등록 → 에이전트 워커 도달 회귀 테스트.
//
// Phase 1 의 두 핵심 회귀를 잠근다:
//   1) AgentWorker.writeMcpConfig 가 외부 등록 서버(figma-dev 등) 를 임시 .mcp.json
//      에 병합해 Claude CLI 의 --mcp-config 인자에 도달시키는지.
//   2) REST 백엔드 store 가 add/list/remove 시 정확한 HTTP 메서드와 경로로 서버에
//      위임하는지(IndexedDB 시기와 동일한 ProjectMcpServersStore 인터페이스 유지).
//
// AgentWorker 는 child_process spawn 부작용이 있어, 본 spec 은 writeMcpConfig 만
// 단독으로 호출해 결과 임시 파일을 검사한다. spawn/큐 흐름은 별도 테스트가 책임.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync } from 'fs';

import { AgentWorker } from '../src/server/agentWorker';
import {
  createRestProjectMcpServersStore,
  validateMcpServerInput,
  type McpServerRecord,
} from '../src/stores/projectMcpServersStore';

// ────────────────────────────────────────────────────────────────────────────
// AgentWorker.writeMcpConfig — 외부 서버 병합
// ────────────────────────────────────────────────────────────────────────────

function callWriteMcpConfig(worker: AgentWorker): string {
  // private 멤버 호출. 본 spec 은 출력 형식의 회귀를 잠그는 게 목적이라
  // 우회 캐스팅을 허용한다.
  const fn = (worker as unknown as { writeMcpConfig: () => string }).writeMcpConfig;
  return fn.call(worker);
}

test('writeMcpConfig — 외부 서버 미지정 시 llm-tycoon 한 개만 노출(회귀: 기존 동작)', () => {
  const worker = new AgentWorker({ agentId: 'a1', projectId: 'p1', workspacePath: process.cwd() });
  const cfgPath = callWriteMcpConfig(worker);
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(cfg.mcpServers), ['llm-tycoon']);
  } finally {
    if (existsSync(cfgPath)) rmSync(cfgPath, { force: true });
    worker.dispose();
  }
});

test('writeMcpConfig — stdio 외부 서버가 mcpServers 맵에 병합된다', () => {
  const figma: McpServerRecord = {
    id: 'mcp-1',
    projectId: 'p1',
    name: 'figma-dev',
    transport: 'stdio',
    command: 'node',
    args: ['./figma-mcp.js'],
    env: { FIGMA_TOKEN: 'tok-secret' },
    createdAt: 1,
    schemaVersion: 2,
  };
  const worker = new AgentWorker({
    agentId: 'a2',
    projectId: 'p1',
    workspacePath: process.cwd(),
    mcpServers: [figma],
  });
  const cfgPath = callWriteMcpConfig(worker);
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, any> };
    assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['figma-dev', 'llm-tycoon']);
    assert.deepEqual(cfg.mcpServers['figma-dev'], {
      command: 'node',
      args: ['./figma-mcp.js'],
      env: { FIGMA_TOKEN: 'tok-secret' },
    });
  } finally {
    if (existsSync(cfgPath)) rmSync(cfgPath, { force: true });
    worker.dispose();
  }
});

test('writeMcpConfig — http 전송은 type/url/headers 로 변환되고 authToken 은 Authorization 헤더로 보강된다', () => {
  const httpServer: McpServerRecord = {
    id: 'mcp-2',
    projectId: 'p1',
    name: 'remote-mcp',
    transport: 'http',
    command: '',
    args: [],
    env: {},
    url: 'https://example.com/mcp',
    headers: { 'X-Custom': 'value' },
    authToken: 'tok-bearer',
    createdAt: 2,
    schemaVersion: 2,
  };
  const worker = new AgentWorker({
    agentId: 'a3',
    projectId: 'p1',
    workspacePath: process.cwd(),
    mcpServers: [httpServer],
  });
  const cfgPath = callWriteMcpConfig(worker);
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, any> };
    assert.deepEqual(cfg.mcpServers['remote-mcp'], {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: {
        'X-Custom': 'value',
        Authorization: 'Bearer tok-bearer',
      },
    });
  } finally {
    if (existsSync(cfgPath)) rmSync(cfgPath, { force: true });
    worker.dispose();
  }
});

test('writeMcpConfig — 사용자가 Authorization 헤더를 직접 둔 경우 authToken 으로 덮어쓰지 않는다', () => {
  const httpServer: McpServerRecord = {
    id: 'mcp-3',
    projectId: 'p1',
    name: 'remote-mcp',
    transport: 'streamable-http',
    command: '',
    args: [],
    env: {},
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer user-supplied' },
    authToken: 'tok-bearer-should-be-ignored',
    createdAt: 3,
    schemaVersion: 2,
  };
  const worker = new AgentWorker({
    agentId: 'a4',
    projectId: 'p1',
    workspacePath: process.cwd(),
    mcpServers: [httpServer],
  });
  const cfgPath = callWriteMcpConfig(worker);
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, any> };
    assert.equal(cfg.mcpServers['remote-mcp'].type, 'streamable-http');
    assert.equal(cfg.mcpServers['remote-mcp'].headers.Authorization, 'Bearer user-supplied');
  } finally {
    if (existsSync(cfgPath)) rmSync(cfgPath, { force: true });
    worker.dispose();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// REST 백엔드 store
// ────────────────────────────────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  url: string;
  body?: unknown;
}

function makeFetchMock(
  responses: { ok: boolean; status: number; body: unknown }[],
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    const r = responses[i++] ?? { ok: true, status: 200, body: {} };
    return {
      ok: r.ok,
      status: r.status,
      async text() { return JSON.stringify(r.body); },
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

test('REST store — list 는 GET 으로 목록을 받아 createdAt 내림차순으로 정렬한다', async () => {
  const records: McpServerRecord[] = [
    { id: 'a', projectId: 'p1', name: 'old', transport: 'stdio', command: 'a', args: [], env: {}, createdAt: 1, schemaVersion: 2 },
    { id: 'b', projectId: 'p1', name: 'new', transport: 'stdio', command: 'b', args: [], env: {}, createdAt: 5, schemaVersion: 2 },
  ];
  const { fetch: f, calls } = makeFetchMock([{ ok: true, status: 200, body: { servers: records } }]);
  const store = createRestProjectMcpServersStore({ fetchImpl: f });
  const got = await store.list('p1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, '/api/projects/p1/mcp-servers');
  assert.deepEqual(got.map(r => r.name), ['new', 'old']);
});

test('REST store — add 는 POST 로 본문을 보내고 응답 record 를 그대로 돌려준다', async () => {
  const record: McpServerRecord = {
    id: 'srv-1', projectId: 'p1', name: 'figma-dev',
    transport: 'stdio', command: 'node', args: ['./srv.js'], env: { K: 'v' },
    createdAt: 10, schemaVersion: 2,
  };
  const { fetch: f, calls } = makeFetchMock([{ ok: true, status: 200, body: record }]);
  const store = createRestProjectMcpServersStore({ fetchImpl: f });
  const result = await store.add({
    projectId: 'p1', name: 'figma-dev', transport: 'stdio',
    command: 'node', args: ['./srv.js'], env: { K: 'v' },
  });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/projects/p1/mcp-servers');
  assert.deepEqual((calls[0].body as { name: string }).name, 'figma-dev');
  assert.equal(result.id, 'srv-1');
});

test('REST store — add 는 사전 검증 실패 시 즉시 throw 하고 fetch 를 호출하지 않는다', async () => {
  const { fetch: f, calls } = makeFetchMock([]);
  const store = createRestProjectMcpServersStore({ fetchImpl: f });
  await assert.rejects(
    () => store.add({ projectId: 'p1', name: '', transport: 'stdio', command: 'node' }),
    /이름/,
  );
  assert.equal(calls.length, 0);
});

test('REST store — remove 는 DELETE 를 보내고 404 도 silent 처리한다', async () => {
  const { fetch: f, calls } = makeFetchMock([{ ok: false, status: 404, body: { error: 'mcp server not found' } }]);
  const store = createRestProjectMcpServersStore({ fetchImpl: f });
  await store.remove('p1', 'srv-1');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, '/api/projects/p1/mcp-servers/srv-1');
});

test('REST store — list 가 4xx 응답을 받으면 서버 메시지를 throw 한다', async () => {
  const { fetch: f } = makeFetchMock([{ ok: false, status: 500, body: { error: 'db down' } }]);
  const store = createRestProjectMcpServersStore({ fetchImpl: f });
  await assert.rejects(() => store.list('p1'), /db down/);
});

// ────────────────────────────────────────────────────────────────────────────
// validateMcpServerInput — 'llm-tycoon' 예약 이름 거부 검증은 server.ts 가 책임
// 지지만, 본 모듈의 검증 함수가 기본 시나리오에서 정상 동작함을 확인한다.
// ────────────────────────────────────────────────────────────────────────────

test('validateMcpServerInput — stdio 정상 입력은 0 errors', () => {
  const errors = validateMcpServerInput({
    projectId: 'p1', name: 'figma', transport: 'stdio',
    command: 'node', args: ['srv.js'], env: { K: 'v' },
  });
  assert.equal(errors.length, 0);
});
