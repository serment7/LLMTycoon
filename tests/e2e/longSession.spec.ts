// Run with: npx tsx --test tests/e2e/longSession.spec.ts
//
// 지시 #c9c158aa — 장기 세션 엔드투엔드 회귀.
//
// 목적
//   tokenBudget / usageLog / cacheable client / MCP 전송 네 축을 동시에 가동시켜
//   다음 4 가지 장기 이용 계약을 잠근다.
//     E1. http MCP 전송에서 수십 회 반복 핸드셰이크 중 `maybeCompact` 가 트리거돼도
//          전송 세션이 끊기지 않고, 서버가 받은 Bearer 헤더는 매 호출 동일하게 전파된다.
//     E2. streamable-http 전송의 장기 스트림 수신 중에 tokenBudget 의 압축 이벤트가
//          발생해도 `onMessage` 콜백이 누락되지 않는다.
//     E3. 도구 정의 변경(invalidateCachePrefix) 이벤트가 발생해도 MCP 세션은 그대로
//          살아 있고, 이후 대화 히스토리 압축 결과가 `compactedSummary` 에 누적된다.
//     E4. 캐시 무효화 결정 — 동일 프리픽스에서 핑거프린트가 고정, 툴 변경 시 재계산.
//
// 외부 의존 없이 `node:http` 로 로컬 서버를 띄우고 내 MCP 클라이언트를 실제로 호출한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createMcpClient,
  MCP_PROTOCOL_VERSION,
} from '../../src/mcp/client.ts';
import {
  createBudgetSession,
  recordUsage,
  appendTurn,
  maybeCompact,
  shouldCompact,
  type ConversationTurn,
} from '../../src/llm/tokenBudget.ts';
import {
  buildCacheableConversation,
  invalidateCachePrefix,
  fingerprintCachePrefix,
  collectCacheBreakpoints,
} from '../../src/llm/client.ts';
import type { ClaudeTokenUsage } from '../../src/types.ts';

// ────────────────────────────────────────────────────────────────────────────
// 공용 로컬 서버 — http 일회성 응답 · streamable-http ndjson 스트림
// ────────────────────────────────────────────────────────────────────────────

interface LocalServer {
  readonly port: number;
  readonly received: Array<{ path: string; headers: Record<string, unknown>; body: string }>;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function startLocalServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void,
): Promise<LocalServer> {
  const received: LocalServer['received'] = [];
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    received.push({ path: req.url ?? '', headers: { ...req.headers }, body });
    try { await handler(req, res, body); } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    received,
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function fakeUsage(input: number, output: number, read: number, creation: number): ClaudeTokenUsage {
  return {
    input_tokens: input, output_tokens: output,
    cache_read_input_tokens: read, cache_creation_input_tokens: creation,
    model: 'claude-opus-4-7',
    at: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// E1. http MCP — 40 회 반복 핸드셰이크 중 maybeCompact 트리거
// ────────────────────────────────────────────────────────────────────────────

test('E1. http MCP — 반복 핸드셰이크 + 중간 압축 트리거에도 세션이 끊기지 않고 헤더가 매 호출 전파', async () => {
  const server = await startLocalServer((_req, res, body) => {
    const req = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'longsession-http', version: '1.0' },
      },
    }));
  });
  try {
    let session = createBudgetSession('e2e-http');
    let compactionTriggered = false;

    for (let i = 0; i < 40; i += 1) {
      // 매 호출마다 새 클라이언트를 만들어 "연결 수명이 짧아도 세션 상태가 유지됨" 을 검증.
      const client = createMcpClient({
        transport: 'http', command: '', args: [], env: {},
        url: `http://127.0.0.1:${server.port}/mcp`,
        headers: { 'X-Probe': `cycle-${i}` },
        authToken: 'probe-bearer',
      });
      const res = await client.handshake({ timeoutMs: 2_000 });
      assert.equal(res.serverInfo.name, 'longsession-http');
      await client.close();

      session = recordUsage(session, fakeUsage(150, 300, i < 2 ? 0 : 4_000, i < 2 ? 3_000 : 0));
      session = appendTurn(session, { role: 'user', content: `u-${i}`, tokens: 2_000 });
      session = appendTurn(session, { role: 'assistant', content: `a-${i}`, tokens: 2_000 });

      if (shouldCompact(session.history, 10_000)) {
        compactionTriggered = true;
        session = maybeCompact(session, { compactThresholdTokens: 10_000, keepLatestTurns: 4 });
      }
    }

    assert.equal(session.totals.callCount, 40);
    assert.ok(compactionTriggered, '히스토리가 40턴이면 임계 10_000 을 넘어 최소 1회 이상 압축되어야');
    assert.ok(session.compactedSummary.includes('이전'), '압축 요약이 세션에 누적');

    // 서버가 받은 Bearer 헤더가 모든 호출에 동일하게 첨부되었는지.
    assert.equal(server.received.length, 40);
    for (const r of server.received) {
      assert.equal(r.headers['authorization'], 'Bearer probe-bearer');
    }
  } finally {
    await server.close();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// E2. streamable-http MCP — 장기 스트림에서 압축 이벤트와 onMessage 누락 방지
// ────────────────────────────────────────────────────────────────────────────

test('E2. streamable-http — 핸드셰이크 후 20 프레임 수신, 중간에 압축 이벤트가 발생해도 콜백이 모두 호출된다', async () => {
  const server = await startLocalServer((_req, res, body) => {
    const req = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    // 핸드셰이크 프레임.
    res.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'longsession-stream', version: '1.0' },
      },
    }) + '\n');
    // 20 개의 알림 프레임.
    for (let i = 0; i < 20; i += 1) {
      res.write(JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/progress',
        params: { tick: i, text: `p-${i}` },
      }) + '\n');
    }
    res.end();
  });
  try {
    const client = createMcpClient({
      transport: 'streamable-http', command: '', args: [], env: {},
      url: `http://127.0.0.1:${server.port}/mcp/stream`,
    });
    const received: Array<{ tick: number }> = [];
    let session = createBudgetSession('e2e-stream');

    const handshake = await client.handshake({
      timeoutMs: 5_000,
      onMessage: (m) => {
        const msg = m as { params?: { tick?: number } };
        if (typeof msg.params?.tick === 'number') {
          received.push({ tick: msg.params.tick });
          // 5번째 프레임 도달 시 압축 이벤트를 억지로 만들어 세션 상태 변경.
          if (msg.params.tick === 5) {
            for (let k = 0; k < 6; k += 1) {
              session = appendTurn(session, { role: 'user', content: `u-${k}`, tokens: 3_000 });
              session = appendTurn(session, { role: 'assistant', content: `a-${k}`, tokens: 3_000 });
            }
            session = maybeCompact(session, { compactThresholdTokens: 10_000, keepLatestTurns: 3 });
          }
        }
      },
    });
    assert.equal(handshake.serverInfo.name, 'longsession-stream');
    await client.close();

    // 모든 알림이 콜백에 도달해야 함 — 압축 이벤트가 콜백 흐름을 끊지 않음.
    assert.equal(received.length, 20);
    assert.equal(received[0].tick, 0);
    assert.equal(received[received.length - 1].tick, 19);
    // 세션은 압축 후에도 살아 있고 요약이 있다.
    assert.ok(session.compactedSummary.length > 0);
  } finally {
    await server.close();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// E3. 도구 정의 변경 시 invalidateCachePrefix — 핑거프린트가 바뀌어도 세션/대화 유지
// ────────────────────────────────────────────────────────────────────────────

test('E3. 도구 스키마 변경 시 invalidateCachePrefix 가 "tools-schema-changed" 를 돌려주고 히스토리 압축은 정상 동작', async () => {
  let fp = null as ReturnType<typeof fingerprintCachePrefix> | null;
  const base = {
    systemPrompt: '시스템 A',
    agentDefinition: '에이전트 A',
    toolsSchema: JSON.stringify({ tools: [{ name: 'a' }] }),
    user: '첫 질문',
  };

  // 1회차 — 초기 빌드.
  const r1 = invalidateCachePrefix({ ...base, previousFingerprint: fp });
  assert.deepEqual(r1.decision.reasons, ['initial-build']);
  fp = r1.decision.nextFingerprint;

  // 2회차 — 동일 프리픽스. 무효화 없음.
  const r2 = invalidateCachePrefix({ ...base, previousFingerprint: fp });
  assert.equal(r2.decision.invalidated, false);
  fp = r2.decision.nextFingerprint;

  // 3회차 — 툴 스키마 변경. 이벤트 기록.
  const r3 = invalidateCachePrefix({
    ...base,
    toolsSchema: JSON.stringify({ tools: [{ name: 'a' }, { name: 'b' }] }),
    previousFingerprint: fp,
  });
  assert.ok(r3.decision.invalidated);
  assert.deepEqual(r3.decision.reasons, ['tools-schema-changed']);

  // 4회차 — 에이전트 정의도 변경 → 복합 원인.
  const r4 = invalidateCachePrefix({
    ...base,
    agentDefinition: '에이전트 A · B',
    toolsSchema: JSON.stringify({ tools: [{ name: 'a' }, { name: 'b' }] }),
    previousFingerprint: r3.decision.nextFingerprint,
  });
  assert.deepEqual(r4.decision.reasons, ['agent-definition-changed']);

  // 히스토리 압축은 invalidation 과 무관하게 동작해야 한다.
  let session = createBudgetSession('e2e-invalidate');
  for (let k = 0; k < 8; k += 1) {
    session = appendTurn(session, { role: k % 2 === 0 ? 'user' : 'assistant', content: `m-${k}`, tokens: 2_000 });
  }
  session = maybeCompact(session, { compactThresholdTokens: 10_000, keepLatestTurns: 2 });
  assert.equal(session.history.length, 2);
  assert.ok(session.compactedSummary.includes('이전'));
});

// ────────────────────────────────────────────────────────────────────────────
// E4. 캐시 마커 위치 — 도구 변경 후에도 마지막 system 블록에 마커가 그대로 부착
// ────────────────────────────────────────────────────────────────────────────

test('E4. 4구간 conversation — 도구 변경 후에도 마지막 system 블록에 cache_control 이 유지되고 히스토리 브레이크포인트는 그대로', () => {
  const history: ConversationTurn[] = [
    { role: 'user', content: 'q1', tokens: 10 },
    { role: 'assistant', content: 'a1', tokens: 10 },
    { role: 'user', content: 'q2', tokens: 10 },
    { role: 'assistant', content: 'a2', tokens: 10 },
    { role: 'user', content: 'q3', tokens: 10 },
  ];
  const convBefore = buildCacheableConversation({
    systemPrompt: 'sys',
    agentDefinition: 'ag',
    toolsSchema: '{"tools":[]}',
    history,
    user: '새 질문',
  });
  const convAfter = buildCacheableConversation({
    systemPrompt: 'sys',
    agentDefinition: 'ag',
    toolsSchema: '{"tools":[{"name":"x"}]}',  // 변경
    history,
    user: '새 질문',
  });

  const markersBefore = collectCacheBreakpoints(convBefore);
  const markersAfter = collectCacheBreakpoints(convAfter);
  // system 마커 위치는 동일(둘 다 마지막 system 블록).
  assert.deepEqual(
    markersBefore.filter((m) => m.startsWith('system')),
    markersAfter.filter((m) => m.startsWith('system')),
  );
  // 히스토리 마커도 동일.
  assert.deepEqual(
    markersBefore.filter((m) => m.startsWith('messages')),
    markersAfter.filter((m) => m.startsWith('messages')),
  );
});
