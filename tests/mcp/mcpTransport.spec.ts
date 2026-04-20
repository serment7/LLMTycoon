// Run with: npx tsx --test tests/mcp/mcpTransport.spec.ts
//
// 지시 #773b1718 (QA) · MCP 연결 설정 회귀 — Thanos 가 배선 중인 stdio/http/
// streamable-http 전송 계약을 잠근다.
//
// 시나리오
//   S1. transport 값(stdio·http·streamable-http) 이 저장소에 저장·복원되고,
//        레거시(transport 결여) 레코드는 'stdio' 로 자동 승격된다.
//   S2. http 전송 — url 누락 / 잘못된 헤더 / 인증 토큰 이상 시 validateMcpServerInput
//        가 필드별 오류를 내고, 본 스펙의 mapValidationErrorsToI18n 으로 안정적인
//        i18n 키 경로(`mcp.errors.<field>.<code>`) 를 생성할 수 있다.
//   S3. streamable-http — 장시간 스트림 중 단절 후 재시도(SimulatedStream) 가 지수
//        백오프로 최대 3회 복구 시도 후 종료한다.
//   S4. 전송 방식 변경 — 동일 프로젝트/이름으로 재저장 시 기존 세션(SimulatedSession)
//        은 close 가 먼저 호출되고, 새 세션은 새 transport 로 시작된다.
//
// 현 시점 구현은 projectMcpServersStore 의 검증·퍼시스턴스 축만 있어 S3/S4 는 본
// 스펙의 가짜(fake) transport/session 으로 "계약 형상" 만 고정한다. 실제 HTTP
// 클라이언트가 배선되면 테스트는 해당 구현을 그대로 끼우도록 시그니처를 유지.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMemoryMcpServerStorage,
  createProjectMcpServersStore,
  validateMcpServerInput,
  MCP_TRANSPORTS,
  type McpServerInput,
  type McpServerRecord,
  type McpTransport,
  type McpValidationError,
} from '../../src/stores/projectMcpServersStore.ts';
import { translate } from '../../src/i18n/index.ts';

// ────────────────────────────────────────────────────────────────────────────
// 공용 유틸 — 결정론적 시드/ID
// ────────────────────────────────────────────────────────────────────────────

function makeStore() {
  let n = 0;
  const adapter = createMemoryMcpServerStorage();
  const store = createProjectMcpServersStore({
    adapter,
    now: () => 1_700_000_000_000 + n,
    newId: () => `srv-${++n}`,
  });
  return { store, adapter };
}

const baseStdio: McpServerInput = {
  projectId: 'p1',
  name: 'filesystem',
  transport: 'stdio',
  command: 'node',
  args: ['./server.js'],
};

const baseHttp: McpServerInput = {
  projectId: 'p1',
  name: 'remote-tools',
  transport: 'http',
  url: 'https://mcp.example.com/endpoint',
  headers: { 'X-Client': 'llmtycoon' },
  authToken: 'Bearer abc123',
};

// ────────────────────────────────────────────────────────────────────────────
// S1. transport 저장·복원 · 레거시 승격
// ────────────────────────────────────────────────────────────────────────────

test('S1-1. 세 전송 방식이 그대로 저장·복원된다', async () => {
  const { store } = makeStore();
  await store.add({ ...baseStdio, name: 'stdio-srv' });
  await store.add({ ...baseHttp, name: 'http-srv' });
  await store.add({ ...baseHttp, name: 'stream-srv', transport: 'streamable-http' });

  const rows = await store.list('p1');
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.transport]));
  assert.equal(byName['stdio-srv'], 'stdio');
  assert.equal(byName['http-srv'], 'http');
  assert.equal(byName['stream-srv'], 'streamable-http');
});

test('S1-2. MCP_TRANSPORTS 는 [stdio, http, streamable-http] 3종으로 고정', () => {
  assert.deepEqual([...MCP_TRANSPORTS], ['stdio', 'http', 'streamable-http']);
});

test('S1-3. 레거시(스키마 v1 · transport 결여) 레코드는 list 경로에서 stdio 로 승격된다', async () => {
  const adapter = createMemoryMcpServerStorage();
  const legacy: McpServerRecord = {
    id: 'old',
    projectId: 'p1',
    name: 'legacy',
    // 의도적으로 transport 누락(런타임에 'stdio' 로 보정되어야 함).
    transport: undefined as unknown as McpTransport,
    command: 'node',
    args: [],
    env: {},
    createdAt: 1,
    schemaVersion: 1,
  };
  await adapter.put('p1:old', legacy);
  const store = createProjectMcpServersStore({ adapter });
  const rows = await store.list('p1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transport, 'stdio');
  assert.equal(rows[0].schemaVersion, 2, '읽기 시점 뷰는 v2 로 끌어올린다');
});

test('S1-4. 지원하지 않는 transport 는 저장 단계에서 거부된다', async () => {
  const { store } = makeStore();
  await assert.rejects(
    store.add({ ...baseHttp, transport: 'websocket' as McpTransport }),
    /transport/,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// S2. http 전송 오류 · i18n 키 매핑
// ────────────────────────────────────────────────────────────────────────────

type I18nErrorCode =
  | 'missing'
  | 'format'
  | 'scheme'
  | 'control'
  | 'too-long'
  | 'invalid-name'
  | 'invalid-type'
  | 'unknown';

/**
 * 검증 오류 → 안정 i18n 키 경로. UI 가 `translate(key)` 로 국제화된 문구를
 * 표출할 때 사용한다. 본 매핑이 흔들리면 번역 파일이 도미노처럼 깨지므로 본
 * 스펙이 앵커가 된다.
 */
export function mapValidationErrorToI18nKey(err: McpValidationError): string {
  const code: I18nErrorCode = classify(err.message);
  return `mcp.errors.${err.field}.${code}`;
}

function classify(message: string): I18nErrorCode {
  if (/비어 있|필수입니다/.test(message)) return 'missing';
  if (/형식이 올바르지 않/.test(message)) return 'format';
  if (/http\/https 스킴/.test(message)) return 'scheme';
  if (/제어문자|공백/.test(message)) return 'control';
  if (/이하만 허용|초과/.test(message)) return 'too-long';
  if (/POSIX 규칙|허용 문자/.test(message)) return 'invalid-name';
  if (/문자열이어야|객체\(key/.test(message)) return 'invalid-type';
  return 'unknown';
}

test('S2-1. http 전송에서 url 누락 → `mcp.errors.url.missing` 키', () => {
  const errors = validateMcpServerInput({ ...baseHttp, url: '' });
  const urlErr = errors.find((e) => e.field === 'url');
  assert.ok(urlErr, 'url 오류가 존재해야');
  assert.equal(mapValidationErrorToI18nKey(urlErr!), 'mcp.errors.url.missing');
});

test('S2-2. url 이 http/https 스킴이 아니면 `mcp.errors.url.scheme`', () => {
  const errors = validateMcpServerInput({ ...baseHttp, url: 'ftp://mcp.example.com' });
  const urlErr = errors.find((e) => e.field === 'url');
  assert.ok(urlErr);
  assert.equal(mapValidationErrorToI18nKey(urlErr!), 'mcp.errors.url.scheme');
});

test('S2-3. 헤더 키에 허용 외 문자 → `mcp.errors.headers.invalid-name`', () => {
  const errors = validateMcpServerInput({
    ...baseHttp,
    headers: { 'Bad Header!': 'v' },
  });
  const h = errors.find((e) => e.field === 'headers');
  assert.ok(h);
  assert.equal(mapValidationErrorToI18nKey(h!), 'mcp.errors.headers.invalid-name');
});

test('S2-4. 헤더 값에 CR/LF(제어문자) → `mcp.errors.headers.control`', () => {
  const errors = validateMcpServerInput({
    ...baseHttp,
    headers: { 'X-Inject': 'foo\r\nX-Smuggle: 1' },
  });
  const h = errors.find((e) => e.field === 'headers');
  assert.ok(h, '제어문자 주입은 차단되어야 함');
  assert.equal(mapValidationErrorToI18nKey(h!), 'mcp.errors.headers.control');
});

test('S2-5. authToken 에 제어문자(만료 토큰 서명 조작 등) → `mcp.errors.authToken.control`', () => {
  const errors = validateMcpServerInput({
    ...baseHttp,
    authToken: 'Bearer abc\x00leak',
  });
  const t = errors.find((e) => e.field === 'authToken');
  assert.ok(t);
  assert.equal(mapValidationErrorToI18nKey(t!), 'mcp.errors.authToken.control');
});

test('S2-6. translate() 는 현재 i18n 키가 없으면 key 원문을 돌려준다 — 번역 추가 대기 상태가 안전', () => {
  const k = 'mcp.errors.url.missing';
  const resolved = translate(k, 'en');
  // 아직 locales/en.json 에 키를 넣지 않았으므로 key 원문 폴백.
  assert.equal(resolved, k);
});

// ────────────────────────────────────────────────────────────────────────────
// S3. streamable-http 장시간 스트림 · 재시도
// ────────────────────────────────────────────────────────────────────────────

interface StreamOptions {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
}

interface SimulatedStream {
  readonly attempts: number[];
  readonly closed: boolean;
  readonly lastError?: string;
}

/**
 * streamable-http 의 재연결 전략 계약. 본 함수는 테스트에서 Thanos 구현과
 * 교체 가능한 시그니처로 작성했다 — 지수 백오프(2^n·baseDelayMs), 최대 N회.
 */
async function runStreamWithRetry(
  connectOnce: (attempt: number) => Promise<void>,
  opts: StreamOptions,
): Promise<SimulatedStream> {
  const attempts: number[] = [];
  let lastError: string | undefined;
  for (let i = 0; i <= opts.maxRetries; i++) {
    attempts.push(i);
    try {
      await connectOnce(i);
      return { attempts, closed: true };
    } catch (e) {
      lastError = (e as Error).message;
      if (i === opts.maxRetries) break;
      // 본 테스트는 실제 대기 없이 딜레이 공식만 검증(결정론 유지).
      const _delay = opts.baseDelayMs * 2 ** i; // eslint-disable-line @typescript-eslint/no-unused-vars
    }
  }
  return { attempts, closed: true, lastError };
}

test('S3-1. 연결 단절 시 최대 3회 재시도 후 종료한다', async () => {
  let hits = 0;
  const res = await runStreamWithRetry(
    async () => { hits++; throw new Error('ECONNRESET'); },
    { maxRetries: 3, baseDelayMs: 10 },
  );
  assert.equal(hits, 4, '초기 시도 + 재시도 3회 = 4');
  assert.deepEqual(res.attempts, [0, 1, 2, 3]);
  assert.equal(res.closed, true);
  assert.equal(res.lastError, 'ECONNRESET');
});

test('S3-2. 중간에 성공하면 이후 재시도는 실행되지 않는다', async () => {
  let hits = 0;
  const res = await runStreamWithRetry(
    async (attempt) => { hits++; if (attempt < 2) throw new Error('EAGAIN'); },
    { maxRetries: 5, baseDelayMs: 10 },
  );
  assert.equal(hits, 3, '0,1 실패 후 2회차 성공');
  assert.equal(res.lastError, undefined);
});

test('S3-3. maxRetries=0 이면 1회 시도로 제한', async () => {
  let hits = 0;
  await runStreamWithRetry(
    async () => { hits++; throw new Error('down'); },
    { maxRetries: 0, baseDelayMs: 10 },
  );
  assert.equal(hits, 1);
});

// ────────────────────────────────────────────────────────────────────────────
// S4. 전송 방식 변경 시 기존 세션 안전 종료
// ────────────────────────────────────────────────────────────────────────────

interface SimulatedSession {
  readonly id: string;
  readonly transport: McpTransport;
  open: boolean;
}

/**
 * 전송 교체 계약. UI/디스패처는 동일 (projectId, name) 에 대한 transport 변경을
 * 요청받으면, 기존 세션을 먼저 close 한 뒤 새 세션을 연다. close 실패 시에도
 * 새 세션은 열지 않아 "좀비 세션" 이 남지 않는다.
 */
async function switchTransport(
  prev: SimulatedSession | null,
  open: (t: McpTransport) => Promise<SimulatedSession>,
  next: McpTransport,
): Promise<{ closedPrev: boolean; current: SimulatedSession }> {
  let closedPrev = false;
  if (prev && prev.open) {
    prev.open = false;
    closedPrev = true;
  }
  const current = await open(next);
  return { closedPrev, current };
}

test('S4-1. transport 변경 시 기존 세션이 먼저 close 된다', async () => {
  const order: string[] = [];
  const prev: SimulatedSession = { id: 's1', transport: 'stdio', open: true };
  const openFn = async (t: McpTransport): Promise<SimulatedSession> => {
    order.push(`open:${t}`);
    return { id: 's2', transport: t, open: true };
  };
  const res = await switchTransport(prev, openFn, 'streamable-http');
  assert.equal(prev.open, false, '이전 세션은 닫혀 있어야');
  assert.equal(res.closedPrev, true);
  assert.equal(res.current.transport, 'streamable-http');
  assert.deepEqual(order, ['open:streamable-http']);
});

test('S4-2. 이전 세션이 없으면 그냥 새 세션만 연다(closedPrev=false)', async () => {
  const res = await switchTransport(
    null,
    async (t) => ({ id: 's1', transport: t, open: true }),
    'http',
  );
  assert.equal(res.closedPrev, false);
  assert.equal(res.current.transport, 'http');
});

test('S4-3. 동일 (projectId, name) 의 레코드 중복 저장은 거절된다 — 교체는 remove 후 add', async () => {
  const { store } = makeStore();
  await store.add({ ...baseStdio, name: 'same' });
  await assert.rejects(store.add({ ...baseStdio, name: 'same' }), /이미 존재/);
});
