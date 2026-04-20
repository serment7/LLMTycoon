// 지시 #49b5de65 — MCP 전송별 클라이언트 핸드셰이크 엔진.
//
// 목적
//   projectMcpServersStore 가 보관하는 `McpServerRecord` 를 받아 실제로 MCP 서버와
//   핸드셰이크(JSON-RPC `initialize`) 를 왕복 수행하는 얇은 클라이언트. 전송 방식별
//   경로(stdio / http / streamable-http) 를 분기한다.
//
// 설계 원칙
//   · 외부 의존 최소 — `@modelcontextprotocol/sdk` 는 패키지에 있지만 본 구현은
//     Node 표준(`child_process` · `node:http` · `fetch`) 만 사용해 테스트·디버깅이
//     쉽도록 만든다. 나중에 공식 SDK 로 교체할 때도 본 모듈의 공개 계약(MCPClient
//     · performHandshake) 만 유지하면 무방.
//   · 취소는 표준 AbortSignal. 모든 경로가 signal.aborted 를 즉시 반영.
//   · 오류는 `MCP_CLIENT_*` 코드로 분류 — 호출자(UI) 가 한 번 분기로 메시지를
//     번역할 수 있도록.
//   · streamable-http 는 첫 프레임(핸드셰이크 응답) 까지만 왕복 검증하고 이후
//     스트림은 `onMessage` 콜백으로 풀어 상위 계층이 원하는 만큼 소비하게 둔다.

import type { McpServerRecord, McpTransport } from '../stores/projectMcpServersStore';

export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const MCP_CLIENT_NAME = 'llm-tycoon-mcp-client';
export const MCP_CLIENT_VERSION = '0.1.0';

export type McpClientErrorCode =
  | 'MCP_CLIENT_TRANSPORT_UNSUPPORTED'
  | 'MCP_CLIENT_CONFIG_INVALID'
  | 'MCP_CLIENT_NETWORK'
  | 'MCP_CLIENT_PROTOCOL'
  | 'MCP_CLIENT_TIMEOUT'
  | 'MCP_CLIENT_ABORTED';

export interface McpClientErrorDetails {
  readonly transport: McpTransport;
  readonly cause?: unknown;
  readonly status?: number;
}

export class McpClientError extends Error {
  readonly code: McpClientErrorCode;
  readonly details: McpClientErrorDetails;
  constructor(code: McpClientErrorCode, message: string, details: McpClientErrorDetails) {
    super(message);
    this.name = 'McpClientError';
    this.code = code;
    this.details = details;
  }
}

/** 서버가 initialize 응답으로 돌려주는 최소 모양. */
export interface McpServerInfo {
  readonly name?: string;
  readonly version?: string;
  readonly protocolVersion?: string;
  /** 서버가 추가로 선언하는 기능 플래그 — 공개 계약상 투명하게 전달. */
  readonly capabilities?: Record<string, unknown>;
}

export interface McpHandshakeResult {
  readonly transport: McpTransport;
  readonly serverInfo: McpServerInfo;
  /** 왕복 소요(ms). UI 의 "연결 테스트" 결과 표시에 사용. */
  readonly durationMs: number;
  /** 서버 응답 원문 객체(JSON-RPC result). 디버깅/고급 UI 가 소비. */
  readonly raw: unknown;
}

export interface McpClient {
  readonly transport: McpTransport;
  handshake(options?: McpHandshakeOptions): Promise<McpHandshakeResult>;
  close(): Promise<void>;
}

export interface McpHandshakeOptions {
  readonly signal?: AbortSignal;
  /** 전체 핸드셰이크 상한(ms). 기본 10_000. */
  readonly timeoutMs?: number;
  /**
   * streamable-http 전용 — 핸드셰이크 이후 서버가 푸시하는 후속 JSON 프레임을
   * 받아 넘길 콜백. 지정하지 않으면 첫 프레임만 읽고 스트림을 닫는다.
   */
  readonly onMessage?: (message: unknown) => void;
}

// ────────────────────────────────────────────────────────────────────────────
// 공용 — 핸드셰이크 요청 모양
// ────────────────────────────────────────────────────────────────────────────

/** JSON-RPC `initialize` 요청 페이로드. id 는 호출마다 고유. */
export function buildInitializeRequest(id: number | string = 1) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      capabilities: {},
    },
  };
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function parseJsonLine(line: string): JsonRpcResponse {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON-RPC 응답이 객체가 아닙니다.');
  }
  const r = parsed as JsonRpcResponse;
  if (r.jsonrpc !== '2.0') throw new Error('jsonrpc 필드가 "2.0" 이 아닙니다.');
  return r;
}

function extractServerInfo(raw: unknown): McpServerInfo {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const info = (obj.serverInfo && typeof obj.serverInfo === 'object')
    ? obj.serverInfo as Record<string, unknown>
    : {};
  return {
    name: typeof info.name === 'string' ? info.name : undefined,
    version: typeof info.version === 'string' ? info.version : undefined,
    protocolVersion: typeof obj.protocolVersion === 'string' ? obj.protocolVersion : undefined,
    capabilities: (obj.capabilities && typeof obj.capabilities === 'object')
      ? obj.capabilities as Record<string, unknown>
      : undefined,
  };
}

function ensureNotAborted(signal: AbortSignal | undefined, transport: McpTransport): void {
  if (signal?.aborted) {
    throw new McpClientError('MCP_CLIENT_ABORTED', 'MCP 핸드셰이크가 취소되었습니다.', { transport });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// stdio 클라이언트
// ────────────────────────────────────────────────────────────────────────────

/** child_process.spawn 시그니처의 최소 부분집합 — 테스트에서 가짜 주입 가능. */
export interface SpawnLike {
  (command: string, args: readonly string[], options: {
    env?: Record<string, string>;
    stdio: ['pipe', 'pipe', 'pipe'];
  }): StdioChildProcess;
}

export interface StdioChildProcess {
  readonly stdin: { write(data: string): boolean | void; end?(): void };
  readonly stdout: NodeJS.EventEmitter;
  readonly stderr: NodeJS.EventEmitter;
  readonly pid?: number;
  on(event: 'exit' | 'error', listener: (arg: unknown) => void): this;
  kill(signal?: string): boolean | void;
}

export interface StdioClientOptions {
  readonly spawn?: SpawnLike;
}

export function createStdioClient(
  record: Pick<McpServerRecord, 'command' | 'args' | 'env' | 'transport'>,
  options: StdioClientOptions = {},
): McpClient {
  if (record.transport !== 'stdio') {
    throw new McpClientError(
      'MCP_CLIENT_TRANSPORT_UNSUPPORTED',
      `stdio 클라이언트에 transport=${record.transport} 레코드가 전달됐습니다.`,
      { transport: record.transport },
    );
  }
  if (!record.command) {
    throw new McpClientError(
      'MCP_CLIENT_CONFIG_INVALID',
      'stdio 전송은 command 가 비어 있을 수 없습니다.',
      { transport: 'stdio' },
    );
  }

  let child: StdioChildProcess | null = null;

  return {
    transport: 'stdio',
    async handshake(hopts: McpHandshakeOptions = {}) {
      ensureNotAborted(hopts.signal, 'stdio');
      const spawnFn = options.spawn ?? (await loadDefaultSpawn());
      const started = Date.now();
      const timeoutMs = hopts.timeoutMs ?? 10_000;
      // Windows 에서 자식 Node 프로세스는 SystemRoot·TEMP 등이 누락되면 시작에
      // 실패하므로, 레코드 env 가 비어 있지 않을 때만 부모 env 를 병합해 넘긴다.
      // 빈 경우에는 undefined 로 두어 플랫폼 기본 상속 동작을 따른다.
      const recordEnv = record.env ?? {};
      const envArg = Object.keys(recordEnv).length > 0
        ? { ...(process.env as Record<string, string>), ...recordEnv }
        : undefined;
      try {
        child = spawnFn(record.command, record.args ?? [], {
          env: envArg,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        throw new McpClientError('MCP_CLIENT_NETWORK', `프로세스 기동 실패: ${describeError(err)}`,
          { transport: 'stdio', cause: err });
      }

      // Promise 생성만 먼저 해서 stdout 리스너를 등록한 뒤, 요청을 쓴 다음 await.
      // await 를 Promise 생성과 동시에 묶으면 write 가 영원히 실행되지 않아 데드락.
      const linePromise = readFirstJsonLine(child, { signal: hopts.signal, timeoutMs });
      const request = buildInitializeRequest(1);
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const response = await linePromise;
      let parsed: JsonRpcResponse;
      try { parsed = parseJsonLine(response); } catch (err) {
        throw new McpClientError('MCP_CLIENT_PROTOCOL', `응답 파싱 실패: ${describeError(err)}`,
          { transport: 'stdio', cause: err });
      }
      if (parsed.error) {
        throw new McpClientError('MCP_CLIENT_PROTOCOL',
          `서버가 오류로 응답: ${parsed.error.message}`,
          { transport: 'stdio', cause: parsed.error });
      }
      return {
        transport: 'stdio' as const,
        serverInfo: extractServerInfo(parsed.result),
        durationMs: Date.now() - started,
        raw: parsed.result,
      };
    },
    async close() {
      if (!child) return;
      try { child.kill(); } catch { /* ignore */ }
      child = null;
    },
  };
}

async function loadDefaultSpawn(): Promise<SpawnLike> {
  // 런타임에만 Node 의 child_process 를 끌어온다 — 브라우저 번들에서는 import 되지 않도록.
  const cp = await import('node:child_process');
  return ((command, args, opts) =>
    cp.spawn(command, [...args], { env: opts.env, stdio: opts.stdio }) as unknown as StdioChildProcess);
}

function readFirstJsonLine(
  child: StdioChildProcess,
  opts: { signal?: AbortSignal; timeoutMs: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const onData = (chunk: unknown) => {
      buffer += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        done(() => resolve(line));
      }
    };
    const onError = (err: unknown) => done(() => reject(
      new McpClientError('MCP_CLIENT_NETWORK', `stdio 스트림 오류: ${describeError(err)}`,
        { transport: 'stdio', cause: err }),
    ));
    const onExit = (code: unknown) => done(() => reject(
      new McpClientError('MCP_CLIENT_NETWORK',
        `프로세스가 핸드셰이크 전에 종료됨(code=${String(code)})`,
        { transport: 'stdio' }),
    ));
    const onAbort = () => done(() => reject(
      new McpClientError('MCP_CLIENT_ABORTED', 'MCP 핸드셰이크가 취소되었습니다.', { transport: 'stdio' }),
    ));
    const timer = setTimeout(() => done(() => reject(
      new McpClientError('MCP_CLIENT_TIMEOUT',
        `stdio 핸드셰이크가 ${opts.timeoutMs}ms 안에 완료되지 않았습니다.`,
        { transport: 'stdio' }),
    )), opts.timeoutMs);

    child.stdout.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // 내부 cleanup — promise 가 settle 되면 타이머만 정리한다. 이벤트 리스너는
    // child 수명이 close() 에서 마감되면 GC 로 회수된다.
    const origResolve = resolve;
    const origReject = reject;
    resolve = (v) => { clearTimeout(timer); origResolve(v); };
    reject = (e) => { clearTimeout(timer); origReject(e); };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// http 클라이언트 — 단발 요청/응답
// ────────────────────────────────────────────────────────────────────────────

export interface HttpClientOptions {
  readonly fetch?: typeof fetch;
}

function ensureHttpRecord(record: Pick<McpServerRecord, 'transport' | 'url'>): string {
  if (record.transport !== 'http' && record.transport !== 'streamable-http') {
    throw new McpClientError(
      'MCP_CLIENT_TRANSPORT_UNSUPPORTED',
      `HTTP 클라이언트에 transport=${record.transport} 레코드가 전달됐습니다.`,
      { transport: record.transport },
    );
  }
  const url = (record.url ?? '').trim();
  if (!url) {
    throw new McpClientError(
      'MCP_CLIENT_CONFIG_INVALID',
      'HTTP 전송은 url 이 비어 있을 수 없습니다.',
      { transport: record.transport },
    );
  }
  return url;
}

function buildHeaders(record: Pick<McpServerRecord, 'headers' | 'authToken'>): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'accept': 'application/json',
    ...(record.headers ?? {}),
  };
  if (record.authToken) headers['authorization'] = `Bearer ${record.authToken}`;
  return headers;
}

export function createHttpClient(
  record: Pick<McpServerRecord, 'transport' | 'url' | 'headers' | 'authToken'>,
  options: HttpClientOptions = {},
): McpClient {
  const url = ensureHttpRecord(record);
  const fetchImpl = options.fetch ?? fetch;

  return {
    transport: 'http',
    async handshake(hopts: McpHandshakeOptions = {}) {
      ensureNotAborted(hopts.signal, 'http');
      const started = Date.now();
      const timeoutMs = hopts.timeoutMs ?? 10_000;
      const ac = new AbortController();
      // undici fetch 는 abort reason 을 그대로 re-throw 하므로, 타임아웃 여부를 별도
      // 플래그로 추적한다(에러 name/type 기반 분기는 플랫폼별로 불안정).
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
      const onAbort = () => ac.abort();
      hopts.signal?.addEventListener('abort', onAbort, { once: true });

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: buildHeaders(record),
          body: JSON.stringify(buildInitializeRequest(1)),
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (hopts.signal?.aborted) {
          throw new McpClientError('MCP_CLIENT_ABORTED', 'MCP 핸드셰이크가 취소되었습니다.',
            { transport: 'http', cause: err });
        }
        if (timedOut) {
          throw new McpClientError('MCP_CLIENT_TIMEOUT',
            `HTTP 핸드셰이크가 ${timeoutMs}ms 안에 완료되지 않았습니다.`,
            { transport: 'http', cause: err });
        }
        throw new McpClientError('MCP_CLIENT_NETWORK',
          `HTTP 요청 실패: ${describeError(err)}`, { transport: 'http', cause: err });
      }
      clearTimeout(timer);
      hopts.signal?.removeEventListener('abort', onAbort);

      if (!res.ok) {
        throw new McpClientError('MCP_CLIENT_NETWORK',
          `HTTP ${res.status} ${res.statusText || ''}`.trim(),
          { transport: 'http', status: res.status });
      }
      const body = await res.text();
      let parsed: JsonRpcResponse;
      try { parsed = parseJsonLine(body.trim() || '{}'); } catch (err) {
        throw new McpClientError('MCP_CLIENT_PROTOCOL',
          `응답 파싱 실패: ${describeError(err)}`,
          { transport: 'http', cause: err });
      }
      if (parsed.error) {
        throw new McpClientError('MCP_CLIENT_PROTOCOL',
          `서버가 오류로 응답: ${parsed.error.message}`,
          { transport: 'http', cause: parsed.error });
      }
      return {
        transport: 'http' as const,
        serverInfo: extractServerInfo(parsed.result),
        durationMs: Date.now() - started,
        raw: parsed.result,
      };
    },
    async close() { /* http 는 idempotent — close 는 no-op. */ },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// streamable-http 클라이언트 — 첫 프레임 핸드셰이크 + 이후 프레임 스트리밍
// ────────────────────────────────────────────────────────────────────────────

export function createStreamableHttpClient(
  record: Pick<McpServerRecord, 'transport' | 'url' | 'headers' | 'authToken'>,
  options: HttpClientOptions = {},
): McpClient {
  const url = ensureHttpRecord(record);
  const fetchImpl = options.fetch ?? fetch;
  let cleanup: null | (() => Promise<void>) = null;

  return {
    transport: 'streamable-http',
    async handshake(hopts: McpHandshakeOptions = {}) {
      ensureNotAborted(hopts.signal, 'streamable-http');
      const started = Date.now();
      const timeoutMs = hopts.timeoutMs ?? 10_000;
      const ac = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
      const onAbort = () => ac.abort();
      hopts.signal?.addEventListener('abort', onAbort, { once: true });

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            ...buildHeaders(record),
            'accept': 'application/x-ndjson, application/json',
          },
          body: JSON.stringify(buildInitializeRequest(1)),
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (hopts.signal?.aborted) {
          throw new McpClientError('MCP_CLIENT_ABORTED', 'MCP 핸드셰이크가 취소되었습니다.',
            { transport: 'streamable-http', cause: err });
        }
        if (timedOut) {
          throw new McpClientError('MCP_CLIENT_TIMEOUT',
            `streamable-http 핸드셰이크가 ${timeoutMs}ms 안에 완료되지 않았습니다.`,
            { transport: 'streamable-http', cause: err });
        }
        throw new McpClientError('MCP_CLIENT_NETWORK',
          `streamable-http 요청 실패: ${describeError(err)}`,
          { transport: 'streamable-http', cause: err });
      }
      if (!res.ok || !res.body) {
        clearTimeout(timer);
        throw new McpClientError('MCP_CLIENT_NETWORK',
          `streamable-http ${res.status} ${res.statusText || ''}`.trim(),
          { transport: 'streamable-http', status: res.status });
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let firstFrame: JsonRpcResponse | null = null;

      const readOne = async (): Promise<string | null> => {
        while (true) {
          const nl = buffer.indexOf('\n');
          if (nl !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) return line;
            continue;
          }
          const { value, done } = await reader.read();
          if (done) {
            const tail = buffer.trim();
            buffer = '';
            return tail || null;
          }
          buffer += decoder.decode(value, { stream: true });
        }
      };

      try {
        const line = await readOne();
        clearTimeout(timer);
        hopts.signal?.removeEventListener('abort', onAbort);
        if (!line) {
          throw new McpClientError('MCP_CLIENT_PROTOCOL',
            'streamable-http 응답이 빈 스트림입니다.',
            { transport: 'streamable-http' });
        }
        try { firstFrame = parseJsonLine(line); } catch (err) {
          throw new McpClientError('MCP_CLIENT_PROTOCOL',
            `응답 파싱 실패: ${describeError(err)}`,
            { transport: 'streamable-http', cause: err });
        }
        if (firstFrame.error) {
          throw new McpClientError('MCP_CLIENT_PROTOCOL',
            `서버가 오류로 응답: ${firstFrame.error.message}`,
            { transport: 'streamable-http', cause: firstFrame.error });
        }

        // onMessage 가 있으면 이후 프레임을 비동기로 읽어 넘긴다. 호출자는 close() 로
        // 중단하거나 signal 을 abort 해 드레인을 종료할 수 있다.
        if (hopts.onMessage) {
          const drain = (async () => {
            try {
              while (true) {
                const next = await readOne();
                if (next === null) break;
                try { hopts.onMessage!(JSON.parse(next)); } catch { /* 라인 손상 무시 */ }
              }
            } catch { /* reader 종료 — 무시 */ }
          })();
          cleanup = async () => { try { await reader.cancel(); } catch { /* ignore */ } await drain; };
        } else {
          // 첫 프레임만 읽고 스트림 종료.
          try { await reader.cancel(); } catch { /* ignore */ }
        }

        return {
          transport: 'streamable-http' as const,
          serverInfo: extractServerInfo(firstFrame.result),
          durationMs: Date.now() - started,
          raw: firstFrame.result,
        };
      } catch (err) {
        clearTimeout(timer);
        try { await reader.cancel(); } catch { /* ignore */ }
        throw err;
      }
    },
    async close() {
      if (cleanup) {
        const c = cleanup;
        cleanup = null;
        await c();
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 공용 진입점 — 레코드 → 클라이언트
// ────────────────────────────────────────────────────────────────────────────

export interface ClientFactoryOptions {
  readonly spawn?: SpawnLike;
  readonly fetch?: typeof fetch;
}

export function createMcpClient(
  record: Pick<McpServerRecord, 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'authToken'>,
  options: ClientFactoryOptions = {},
): McpClient {
  const t: McpTransport = record.transport ?? 'stdio';
  if (t === 'stdio') return createStdioClient({ ...record, transport: 'stdio' }, { spawn: options.spawn });
  if (t === 'http') return createHttpClient({ ...record, transport: 'http' }, { fetch: options.fetch });
  if (t === 'streamable-http') return createStreamableHttpClient({ ...record, transport: 'streamable-http' }, { fetch: options.fetch });
  throw new McpClientError(
    'MCP_CLIENT_TRANSPORT_UNSUPPORTED',
    `지원하지 않는 transport: ${String(t)}`,
    { transport: t },
  );
}

/**
 * UI 의 "연결 테스트" 버튼이 호출하는 간편 경로. 실패해도 throw 하지 않고 결과
 * 객체에 실어 반환해 상위가 토스트/배너로 쉽게 표시할 수 있다.
 */
export type PerformHandshakeOutcome =
  | { ok: true; result: McpHandshakeResult }
  | { ok: false; error: { code: McpClientErrorCode; message: string; transport: McpTransport } };

export async function performHandshake(
  record: Pick<McpServerRecord, 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'authToken'>,
  options: ClientFactoryOptions & McpHandshakeOptions = {},
): Promise<PerformHandshakeOutcome> {
  let client: McpClient | null = null;
  try {
    client = createMcpClient(record, { spawn: options.spawn, fetch: options.fetch });
    const result = await client.handshake({
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onMessage: options.onMessage,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof McpClientError) {
      return { ok: false, error: { code: err.code, message: err.message, transport: err.details.transport } };
    }
    return {
      ok: false,
      error: {
        code: 'MCP_CLIENT_NETWORK',
        message: describeError(err),
        transport: record.transport ?? 'stdio',
      },
    };
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}
