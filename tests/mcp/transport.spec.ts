// Run with: npx tsx --test tests/mcp/transport.spec.ts
//
// 지시 #49b5de65 · MCP 전송별 클라이언트(`src/mcp/client.ts`) 의 실제 핸드셰이크
// 왕복 계약을 잠근다.
//   · stdio: `node -e "..."` 로 JSON-RPC `initialize` 에 응답하는 에코 프로세스를
//     기동해 왕복을 검증한다. 실제 spawn/파이프/라인 파서가 묶여 회귀 시 신호가 즉시 뜨도록.
//   · http: `node:http` 로 `127.0.0.1:<0>` 로컬 서버를 띄우고, initialize JSON-RPC 요청에
//     대해 단발 응답을 돌려준다. Bearer 헤더 · 커스텀 헤더 전파까지 잠근다.
//   · streamable-http: 같은 로컬 서버의 별도 경로에서 여러 줄의 JSON 프레임(ndjson) 을
//     순차 푸시한다. 첫 프레임이 핸드셰이크, 이후 프레임은 `onMessage` 콜백으로 소비.
//
// 모든 경로는 실제 네트워크/프로세스 통신을 사용하되, 외부 의존은 없고 Node 표준만 쓴다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import {
  createMcpClient,
  performHandshake,
  McpClientError,
  MCP_PROTOCOL_VERSION,
} from '../../src/mcp/client.ts';

// ────────────────────────────────────────────────────────────────────────────
// 공용 로컬 서버 — http / streamable-http 경로를 한 서버에 올린다.
// ────────────────────────────────────────────────────────────────────────────

interface LocalServer {
  readonly port: number;
  readonly received: Array<{ path: string; headers: Record<string, unknown>; body: string }>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function startLocalServer(
  handle: (req: IncomingMessage, res: ServerResponse, body: string, port: number) => Promise<void> | void,
): Promise<LocalServer> {
  const received: LocalServer['received'] = [];
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    received.push({ path: req.url ?? '', headers: { ...req.headers }, body });
    try {
      await handle(req, res, body, (server.address() as AddressInfo).port);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    received,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// stdio — 실제 `node -e` 에코 프로세스로 왕복 검증
// ────────────────────────────────────────────────────────────────────────────

/**
 * stdin 으로 들어오는 줄 단위 JSON 을 파싱하고, initialize 요청이면 간단한 serverInfo
 * 를 ndjson 한 줄로 돌려주는 에코 스크립트. args 에 실어 주입한다.
 */
const STDIO_ECHO_SCRIPT = [
  'let buf = "";',
  'process.stdin.on("data", (d) => {',
  '  buf += d.toString();',
  '  let i;',
  '  while ((i = buf.indexOf("\\n")) !== -1) {',
  '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
  '    if (!line.trim()) continue;',
  '    try {',
  '      const req = JSON.parse(line);',
  '      if (req.method === "initialize") {',
  '        const res = { jsonrpc: "2.0", id: req.id, result: {',
  '          protocolVersion: "2025-03-26",',
  '          serverInfo: { name: "echo-stdio", version: "0.0.1" },',
  '          capabilities: { tools: {} } } };',
  '        process.stdout.write(JSON.stringify(res) + "\\n");',
  '      }',
  '    } catch (e) { /* 무시 */ }',
  '  }',
  '});',
].join('');

test('T1. stdio 클라이언트는 실제 자식 프로세스와 JSON-RPC 왕복 핸드셰이크에 성공한다', async () => {
  const client = createMcpClient({
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', STDIO_ECHO_SCRIPT],
    env: {},
  });
  try {
    const res = await client.handshake({ timeoutMs: 5_000 });
    assert.equal(res.transport, 'stdio');
    assert.equal(res.serverInfo.name, 'echo-stdio');
    assert.equal(res.serverInfo.version, '0.0.1');
    assert.equal(res.serverInfo.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.ok(res.durationMs >= 0);
  } finally {
    await client.close();
  }
});

test('T2. stdio 전송에서 command 가 비어 있으면 CONFIG_INVALID 로 거부된다', () => {
  assert.throws(
    () => createMcpClient({
      transport: 'stdio', command: '', args: [], env: {},
    }),
    (err: unknown) => {
      assert.ok(err instanceof McpClientError);
      assert.equal((err as McpClientError).code, 'MCP_CLIENT_CONFIG_INVALID');
      return true;
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// http — 로컬 서버 왕복
// ────────────────────────────────────────────────────────────────────────────

test('T3. http 클라이언트는 로컬 서버와 단발 왕복하고 Bearer/커스텀 헤더를 전파한다', async () => {
  const server = await startLocalServer((req, res, body) => {
    assert.equal(req.method, 'POST');
    const request = JSON.parse(body);
    assert.equal(request.method, 'initialize');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'echo-http', version: '1.2.3' },
        capabilities: { resources: {} },
      },
    }));
  });
  try {
    const client = createMcpClient({
      transport: 'http',
      command: '',
      args: [],
      env: {},
      url: `http://127.0.0.1:${server.port}/mcp`,
      headers: { 'X-Tenant': 'acme' },
      authToken: 'secret-token',
    });
    const res = await client.handshake({ timeoutMs: 5_000 });
    assert.equal(res.transport, 'http');
    assert.equal(res.serverInfo.name, 'echo-http');
    assert.equal(res.serverInfo.version, '1.2.3');

    // 서버가 실제로 받은 헤더를 검증 — Bearer 토큰과 커스텀 헤더가 살아 있어야 한다.
    const hit = server.received[0];
    assert.equal(hit.headers['authorization'], 'Bearer secret-token');
    assert.equal(hit.headers['x-tenant'], 'acme');
  } finally {
    await server.close();
  }
});

test('T4. http 서버가 5xx 로 응답하면 MCP_CLIENT_NETWORK 오류', async () => {
  const server = await startLocalServer((_req, res) => {
    res.writeHead(502);
    res.end('upstream');
  });
  try {
    const client = createMcpClient({
      transport: 'http', command: '', args: [], env: {},
      url: `http://127.0.0.1:${server.port}/mcp`,
    });
    await assert.rejects(
      () => client.handshake({ timeoutMs: 2_000 }),
      (err: unknown) => {
        assert.ok(err instanceof McpClientError);
        const e = err as McpClientError;
        assert.equal(e.code, 'MCP_CLIENT_NETWORK');
        assert.equal(e.details.status, 502);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('T5. http 핸드셰이크 — 서버가 응답을 지연시키면 timeoutMs 로 TIMEOUT 코드 반환', async () => {
  // 서버가 일부러 응답을 안 함 — 응답 객체를 붙잡아 두고 나중에 close 할 때만 해제.
  const pending: ServerResponse[] = [];
  const server = await startLocalServer((_req, res) => {
    pending.push(res);
    // res.end() 호출 안 함 → 클라이언트가 timeout.
  });
  try {
    const client = createMcpClient({
      transport: 'http', command: '', args: [], env: {},
      url: `http://127.0.0.1:${server.port}/mcp`,
    });
    await assert.rejects(
      () => client.handshake({ timeoutMs: 80 }),
      (err: unknown) => {
        assert.ok(err instanceof McpClientError);
        assert.equal((err as McpClientError).code, 'MCP_CLIENT_TIMEOUT');
        return true;
      },
    );
  } finally {
    for (const r of pending) { try { r.end(); } catch { /* ignore */ } }
    await server.close();
  }
});

test('T6. http 핸드셰이크 — 외부 AbortSignal 이 abort 되면 ABORTED 코드로 종료', async () => {
  const pending: ServerResponse[] = [];
  const server = await startLocalServer((_req, res) => { pending.push(res); });
  try {
    const client = createMcpClient({
      transport: 'http', command: '', args: [], env: {},
      url: `http://127.0.0.1:${server.port}/mcp`,
    });
    const ac = new AbortController();
    queueMicrotask(() => ac.abort());
    await assert.rejects(
      () => client.handshake({ signal: ac.signal, timeoutMs: 2_000 }),
      (err: unknown) => {
        assert.ok(err instanceof McpClientError);
        assert.equal((err as McpClientError).code, 'MCP_CLIENT_ABORTED');
        return true;
      },
    );
  } finally {
    for (const r of pending) { try { r.end(); } catch { /* ignore */ } }
    await server.close();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// streamable-http — ndjson 프레임 순차 푸시
// ────────────────────────────────────────────────────────────────────────────

test('T7. streamable-http — 첫 프레임이 핸드셰이크, 이후 프레임은 onMessage 로 흘러든다', async () => {
  const server = await startLocalServer((req, res, body) => {
    const request = JSON.parse(body);
    assert.equal(request.method, 'initialize');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // 첫 프레임 — 핸드셰이크 응답.
    res.write(JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'echo-stream', version: '0.1' },
        capabilities: { streaming: true },
      },
    }) + '\n');
    // 이후 프레임 — 서버 push 알림(JSON-RPC notification). onMessage 로 전달되어야 한다.
    res.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/log', params: { text: 'hello' } }) + '\n');
    res.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/log', params: { text: 'world' } }) + '\n');
    res.end();
  });
  try {
    const client = createMcpClient({
      transport: 'streamable-http', command: '', args: [], env: {},
      url: `http://127.0.0.1:${server.port}/mcp/stream`,
    });
    const pushed: unknown[] = [];
    const res = await client.handshake({
      timeoutMs: 5_000,
      onMessage: (m) => { pushed.push(m); },
    });
    // 스트림 드레인이 완료될 때까지 대기.
    await client.close();

    assert.equal(res.transport, 'streamable-http');
    assert.equal(res.serverInfo.name, 'echo-stream');
    assert.equal(pushed.length, 2, 'onMessage 는 핸드셰이크 이후 2개 알림을 받아야 함');
    assert.deepEqual(
      pushed.map((m) => (m as { params: { text: string } }).params.text),
      ['hello', 'world'],
    );
  } finally {
    await server.close();
  }
});

test('T8. performHandshake — 실패 시 예외 대신 ok:false 결과를 돌려준다', async () => {
  const server = await startLocalServer((_req, res) => {
    res.writeHead(401);
    res.end('unauthorized');
  });
  try {
    const out = await performHandshake({
      transport: 'http', command: '', args: [], env: {},
      url: `http://127.0.0.1:${server.port}/mcp`,
    }, { timeoutMs: 2_000 });
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.error.code, 'MCP_CLIENT_NETWORK');
      assert.equal(out.error.transport, 'http');
    }
  } finally {
    await server.close();
  }
});

test('T9. performHandshake — 성공 경로는 ok:true 와 serverInfo 를 돌려준다', async () => {
  const server = await startLocalServer((_req, res, body) => {
    const request = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'ok' } },
    }));
  });
  try {
    const out = await performHandshake({
      transport: 'http', command: '', args: [], env: {},
      url: `http://127.0.0.1:${server.port}/mcp`,
    }, { timeoutMs: 2_000 });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.result.serverInfo.name, 'ok');
      assert.equal(out.result.transport, 'http');
    }
  } finally {
    await server.close();
  }
});
