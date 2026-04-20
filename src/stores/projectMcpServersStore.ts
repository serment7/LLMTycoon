// 지시 #6fd99c90 — 프로젝트별 MCP 서버 슬라이스.
// 지시 #5cda6ae5 — HTTP · Streamable HTTP 전송(transport) 분기 확장.
//
// 목적
//   에이전트가 런타임에 연결할 MCP(Model Context Protocol) 서버 기술(記述)을
//   프로젝트 단위로 보관한다. 에이전트 디스패치 시점에 본 슬라이스를 조회해
//   전송 방식(`stdio` 기본 / `http` / `streamable-http`) 에 따라 자식 프로세스
//   또는 HTTP 엔드포인트 중 하나로 연결하도록 페이로드를 컨텍스트로 주입한다.
//
// 설계
//   · projectFiles(#1fd1b3c6) · projectSkillsStore(#6fd99c90) 와 동일한 어댑터 패턴.
//   · name 은 프로젝트 내에서 유일. 중복 저장은 addServer 가 거부한다.
//   · env 의 key 는 POSIX 환경변수 규칙(영숫자+언더스코어, 숫자로 시작 금지) 을 강제.
//   · 본 모듈은 순수 검증 함수 + 팩토리 두 축만 노출한다.
//   · 하위 호환 — transport 가 누락된 레거시 레코드는 `stdio` 로 해석한다.

/** 전송 방식. 모델 컨텍스트 프로토콜의 공식 분류에 맞춘다. */
export type McpTransport = 'stdio' | 'http' | 'streamable-http';

export const MCP_TRANSPORTS: readonly McpTransport[] = Object.freeze([
  'stdio', 'http', 'streamable-http',
]);

export interface McpServerRecord {
  id: string;
  projectId: string;
  name: string;
  /** 전송 방식. 누락 시 로드 단계에서 'stdio' 로 보강. */
  transport: McpTransport;
  /** stdio 전용 — 자식 프로세스 실행 파일. http 전송에서는 빈 문자열 허용. */
  command: string;
  /** stdio 전용 — 실행 인자. */
  args: string[];
  /** stdio 전용 — 자식 프로세스 환경변수. */
  env: Record<string, string>;
  /** http / streamable-http 전용 — 엔드포인트 URL. stdio 에서는 undefined. */
  url?: string;
  /** http / streamable-http 전용 — 커스텀 헤더(토큰 외). 값은 노출 대상일 수 있어 검증만 강제. */
  headers?: Record<string, string>;
  /** http / streamable-http 전용 — Bearer 인증 토큰. 프롬프트/UI 는 키만 요약, 값 노출 금지. */
  authToken?: string;
  createdAt: number;
  /**
   * 스키마 버전.
   *   · 1 — 최초 stdio 전용 레코드.
   *   · 2 — transport/url/headers/authToken 필드 도입.
   */
  schemaVersion: 1 | 2;
}

export interface McpServerInput {
  projectId: string;
  name: string;
  /** 전송 방식. 미지정 시 'stdio' 기본값. */
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  authToken?: string;
}

export interface McpServerStorageAdapter {
  put(key: string, value: McpServerRecord): Promise<void>;
  get(key: string): Promise<McpServerRecord | null>;
  delete(key: string): Promise<void>;
  list(): Promise<McpServerRecord[]>;
  clear(): Promise<void>;
}

export interface ProjectMcpServersStore {
  add(input: McpServerInput): Promise<McpServerRecord>;
  remove(projectId: string, id: string): Promise<void>;
  list(projectId: string): Promise<McpServerRecord[]>;
  subscribe(projectId: string, listener: () => void): () => void;
  clearAll(): Promise<void>;
}

export interface CreateProjectMcpServersStoreOptions {
  adapter?: McpServerStorageAdapter;
  now?: () => number;
  newId?: () => string;
}

// ────────────────────────────────────────────────────────────────────────────
// 검증 — UI · 팩토리 공용
// ────────────────────────────────────────────────────────────────────────────

export const MCP_NAME_MAX = 48;
export const MCP_COMMAND_MAX = 256;
export const MCP_ARG_MAX = 512;
export const MCP_ENV_VAL_MAX = 4_096;
export const MCP_URL_MAX = 2_048;
export const MCP_HEADER_NAME_MAX = 128;
export const MCP_HEADER_VALUE_MAX = 4_096;
export const MCP_AUTH_TOKEN_MAX = 4_096;
// POSIX.1 준수: 영문자/언더스코어로 시작, 이후 영숫자·언더스코어.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 서버 이름: 영숫자·하이픈·언더스코어·점(.)만 허용. 공백/쉘 메타문자 차단.
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// RFC 7230 token 중 실용 부분집합 — 영숫자·하이픈·언더스코어. 구현 편의를 위해
// 점(.) 과 플러스(+) 도 허용(공급자가 `X-Request.Id` 같은 이름을 쓸 수 있도록).
const HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9._+-]*$/;

export interface McpValidationError {
  field: 'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'authToken';
  message: string;
}

function validateStdioFields(
  input: McpServerInput,
  errors: McpValidationError[],
): void {
  const command = (input.command ?? '').trim();
  if (!command) errors.push({ field: 'command', message: '실행 명령(command) 이 비어 있습니다.' });
  else if (command.length > MCP_COMMAND_MAX) errors.push({ field: 'command', message: `command 는 ${MCP_COMMAND_MAX}자 이하만 허용됩니다.` });
  else if (/[;&|`$<>]/.test(command)) errors.push({ field: 'command', message: 'command 에 쉘 메타문자(; & | ` $ < >) 를 포함할 수 없습니다.' });

  const args = input.args ?? [];
  if (!Array.isArray(args)) {
    errors.push({ field: 'args', message: 'args 는 문자열 배열이어야 합니다.' });
  } else {
    for (const [i, a] of args.entries()) {
      if (typeof a !== 'string') { errors.push({ field: 'args', message: `args[${i}] 는 문자열이어야 합니다.` }); continue; }
      if (a.length > MCP_ARG_MAX) { errors.push({ field: 'args', message: `args[${i}] 길이가 ${MCP_ARG_MAX}자를 초과합니다.` }); continue; }
      // args 는 쉘 파싱 없이 그대로 자식 프로세스에 전달되므로 제어문자만 차단.
      if (/[\u0000-\u001f]/.test(a)) errors.push({ field: 'args', message: `args[${i}] 에 제어문자가 포함되어 있습니다.` });
    }
  }

  const env = input.env ?? {};
  if (typeof env !== 'object' || Array.isArray(env)) {
    errors.push({ field: 'env', message: 'env 는 객체(key→value) 여야 합니다.' });
  } else {
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_KEY_RE.test(k)) { errors.push({ field: 'env', message: `env 키 "${k}" 가 POSIX 규칙을 따르지 않습니다.` }); continue; }
      if (typeof v !== 'string') { errors.push({ field: 'env', message: `env["${k}"] 는 문자열이어야 합니다.` }); continue; }
      if (v.length > MCP_ENV_VAL_MAX) { errors.push({ field: 'env', message: `env["${k}"] 길이가 ${MCP_ENV_VAL_MAX}자를 초과합니다.` }); continue; }
      if (/[\u0000]/.test(v)) errors.push({ field: 'env', message: `env["${k}"] 에 NUL 문자가 포함되어 있습니다.` });
    }
  }
}

function validateHttpFields(
  input: McpServerInput,
  errors: McpValidationError[],
): void {
  const url = (input.url ?? '').trim();
  if (!url) {
    errors.push({ field: 'url', message: 'HTTP 전송에는 url 이 필수입니다.' });
  } else if (url.length > MCP_URL_MAX) {
    errors.push({ field: 'url', message: `url 은 ${MCP_URL_MAX}자 이하만 허용됩니다.` });
  } else if (/[\u0000-\u001f\s]/.test(url)) {
    errors.push({ field: 'url', message: 'url 에 공백·제어문자가 포함되어 있습니다.' });
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push({ field: 'url', message: 'url 은 http/https 스킴이어야 합니다.' });
      }
    } catch {
      errors.push({ field: 'url', message: 'url 형식이 올바르지 않습니다.' });
    }
  }

  const headers = input.headers ?? {};
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    errors.push({ field: 'headers', message: 'headers 는 객체(key→value) 여야 합니다.' });
  } else {
    for (const [k, v] of Object.entries(headers)) {
      if (k.length > MCP_HEADER_NAME_MAX) {
        errors.push({ field: 'headers', message: `headers 키 "${k.slice(0, 16)}…" 이 ${MCP_HEADER_NAME_MAX}자를 초과합니다.` }); continue;
      }
      if (!HEADER_NAME_RE.test(k)) {
        errors.push({ field: 'headers', message: `headers 키 "${k}" 가 허용 문자(영숫자/._+-) 를 벗어났습니다.` }); continue;
      }
      if (typeof v !== 'string') {
        errors.push({ field: 'headers', message: `headers["${k}"] 는 문자열이어야 합니다.` }); continue;
      }
      if (v.length > MCP_HEADER_VALUE_MAX) {
        errors.push({ field: 'headers', message: `headers["${k}"] 길이가 ${MCP_HEADER_VALUE_MAX}자를 초과합니다.` }); continue;
      }
      // HTTP 헤더는 CR/LF 주입(헤더 스머글링) 을 막아야 한다 — 제어문자 일괄 차단.
      if (/[\u0000-\u001f]/.test(v)) {
        errors.push({ field: 'headers', message: `headers["${k}"] 에 제어문자가 포함되어 있습니다.` });
      }
    }
  }

  if (input.authToken !== undefined) {
    if (typeof input.authToken !== 'string') {
      errors.push({ field: 'authToken', message: 'authToken 은 문자열이어야 합니다.' });
    } else if (input.authToken.length > MCP_AUTH_TOKEN_MAX) {
      errors.push({ field: 'authToken', message: `authToken 은 ${MCP_AUTH_TOKEN_MAX}자 이하만 허용됩니다.` });
    } else if (/[\u0000-\u001f]/.test(input.authToken)) {
      errors.push({ field: 'authToken', message: 'authToken 에 제어문자가 포함되어 있습니다.' });
    }
  }
}

export function validateMcpServerInput(input: McpServerInput): McpValidationError[] {
  const errors: McpValidationError[] = [];
  const name = (input.name ?? '').trim();
  if (!name) errors.push({ field: 'name', message: 'MCP 서버 이름이 비어 있습니다.' });
  else if (name.length > MCP_NAME_MAX) errors.push({ field: 'name', message: `이름은 ${MCP_NAME_MAX}자 이하만 허용됩니다.` });
  else if (!SERVER_NAME_RE.test(name)) errors.push({ field: 'name', message: '이름은 영숫자/._- 만 사용할 수 있습니다.' });

  const transport = input.transport ?? 'stdio';
  if (!MCP_TRANSPORTS.includes(transport)) {
    errors.push({ field: 'transport', message: `transport 는 ${MCP_TRANSPORTS.join(' / ')} 중 하나여야 합니다.` });
    return errors;
  }

  if (transport === 'stdio') {
    validateStdioFields(input, errors);
  } else {
    validateHttpFields(input, errors);
  }
  return errors;
}

function keyFor(projectId: string, id: string): string {
  return `${projectId}:${id}`;
}

function generateDefaultId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isMcpServerRecord(raw: unknown): raw is McpServerRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<McpServerRecord>;
  return (
    (r.schemaVersion === 1 || r.schemaVersion === 2) &&
    typeof r.id === 'string' &&
    typeof r.projectId === 'string' &&
    typeof r.name === 'string' &&
    typeof r.command === 'string' &&
    Array.isArray(r.args) &&
    !!r.env && typeof r.env === 'object' &&
    typeof r.createdAt === 'number'
  );
}

/**
 * 스키마 v1(transport 필드 누락) 레거시 레코드를 v2 모양으로 끌어올린다. 저장소에
 * 새로 기록하지는 않고, 읽기 시점에 런타임 뷰만 보정한다 — 사용자가 레코드를
 * 수정 저장할 때 자연스럽게 v2 로 다시 쓰인다.
 */
function normalizeLoadedRecord(record: McpServerRecord): McpServerRecord {
  if (record.transport && MCP_TRANSPORTS.includes(record.transport)) return record;
  return { ...record, transport: 'stdio', schemaVersion: 2 };
}

// ────────────────────────────────────────────────────────────────────────────
// 팩토리
// ────────────────────────────────────────────────────────────────────────────

export function createProjectMcpServersStore(
  options: CreateProjectMcpServersStoreOptions = {},
): ProjectMcpServersStore {
  const adapter = options.adapter ?? createIndexedDbMcpServerStorage();
  const now = options.now ?? Date.now;
  const newId = options.newId ?? generateDefaultId;

  const listeners = new Map<string, Set<() => void>>();
  function notify(projectId: string) {
    const set = listeners.get(projectId);
    if (!set) return;
    set.forEach((l) => {
      try { l(); } catch { /* ignore */ }
    });
  }

  return {
    async add(input) {
      const errors = validateMcpServerInput(input);
      if (errors.length > 0) throw new Error(errors.map((e) => e.message).join(' '));
      const existing = await adapter.list();
      const duplicate = existing
        .filter(isMcpServerRecord)
        .find((r) => r.projectId === input.projectId && r.name === input.name.trim());
      if (duplicate) {
        throw new Error(`동일한 이름("${input.name.trim()}") 의 MCP 서버가 이미 존재합니다.`);
      }
      const id = newId();
      const transport: McpTransport = input.transport ?? 'stdio';
      // HTTP 전송은 command 를 사용하지 않지만, 스토리지 스키마 호환을 위해 필드
      // 자체는 유지하고 빈 문자열로 채운다(레거시 판독기가 깨지지 않도록).
      const record: McpServerRecord = {
        id,
        projectId: input.projectId,
        name: input.name.trim(),
        transport,
        command: (input.command ?? '').trim(),
        args: (input.args ?? []).map((a) => String(a)),
        env: { ...(input.env ?? {}) },
        ...(transport !== 'stdio' ? {
          url: (input.url ?? '').trim(),
          headers: { ...(input.headers ?? {}) },
          ...(input.authToken !== undefined ? { authToken: input.authToken } : {}),
        } : {}),
        createdAt: now(),
        schemaVersion: 2,
      };
      await adapter.put(keyFor(record.projectId, id), record);
      notify(record.projectId);
      return record;
    },

    async remove(projectId, id) {
      const record = await adapter.get(keyFor(projectId, id));
      if (!record) return;
      await adapter.delete(keyFor(projectId, id));
      notify(projectId);
    },

    async list(projectId) {
      const all = await adapter.list();
      return all
        .filter(isMcpServerRecord)
        .map(normalizeLoadedRecord)
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    subscribe(projectId, listener) {
      if (!listeners.has(projectId)) listeners.set(projectId, new Set());
      listeners.get(projectId)!.add(listener);
      return () => {
        const set = listeners.get(projectId);
        if (!set) return;
        set.delete(listener);
        if (set.size === 0) listeners.delete(projectId);
      };
    },

    async clearAll() {
      await adapter.clear();
      const keys = Array.from(listeners.keys());
      keys.forEach((k) => {
        const set = listeners.get(k);
        set?.forEach((l) => { try { l(); } catch { /* ignore */ } });
      });
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 메모리 어댑터
// ────────────────────────────────────────────────────────────────────────────

export function createMemoryMcpServerStorage(): McpServerStorageAdapter {
  const data = new Map<string, McpServerRecord>();
  return {
    async put(key, value) { data.set(key, value); },
    async get(key) { return data.get(key) ?? null; },
    async delete(key) { data.delete(key); },
    async list() { return Array.from(data.values()); },
    async clear() { data.clear(); },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// IndexedDB 어댑터
// ────────────────────────────────────────────────────────────────────────────

export interface IndexedDbMcpServerStorageOptions {
  databaseName?: string;
  storeName?: string;
  indexedDb?: IDBFactory;
}

const DEFAULT_MCP_DB = 'llmtycoon-project-mcp-servers';
const DEFAULT_MCP_STORE = 'mcp-servers-v1';

export function createIndexedDbMcpServerStorage(
  options: IndexedDbMcpServerStorageOptions = {},
): McpServerStorageAdapter {
  const idb = options.indexedDb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return createMemoryMcpServerStorage();

  const dbName = options.databaseName ?? DEFAULT_MCP_DB;
  const storeName = options.storeName ?? DEFAULT_MCP_STORE;

  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = idb!.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IDB open 실패'));
    });
  }

  async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const s = t.objectStore(storeName);
        const req = run(s);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IDB tx 실패'));
      });
    } finally {
      db.close();
    }
  }

  return {
    async put(key, value) {
      await tx('readwrite', (s) => s.put(value, key) as IDBRequest<IDBValidKey>);
    },
    async get(key) {
      const raw = await tx('readonly', (s) => s.get(key) as IDBRequest<McpServerRecord | undefined>);
      return raw ?? null;
    },
    async delete(key) {
      await tx('readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
    },
    async list() {
      return tx('readonly', (s) => s.getAll() as IDBRequest<McpServerRecord[]>);
    },
    async clear() {
      await tx('readwrite', (s) => s.clear() as IDBRequest<undefined>);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 싱글턴 편의 API
// ────────────────────────────────────────────────────────────────────────────

let defaultStore: ProjectMcpServersStore | null = null;
function getDefaultStore(): ProjectMcpServersStore {
  if (!defaultStore) defaultStore = createProjectMcpServersStore();
  return defaultStore;
}

export function __setDefaultProjectMcpServersStoreForTests(store: ProjectMcpServersStore | null): void {
  defaultStore = store;
}

export function addProjectMcpServer(input: McpServerInput): Promise<McpServerRecord> {
  return getDefaultStore().add(input);
}

export function removeProjectMcpServer(projectId: string, id: string): Promise<void> {
  return getDefaultStore().remove(projectId, id);
}

export function listProjectMcpServers(projectId: string): Promise<McpServerRecord[]> {
  return getDefaultStore().list(projectId);
}

export function subscribeProjectMcpServers(projectId: string, listener: () => void): () => void {
  return getDefaultStore().subscribe(projectId, listener);
}
