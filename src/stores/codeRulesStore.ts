// 지시 #87cbd107 — 프로젝트 코드 컨벤션/룰 스토어.
//
// 목적
//   프로젝트 관리 메뉴의 "코드 컨벤션/룰 설정" 섹션이 저장/불러오기하는
//   단일 JSON 스키마를 로컬(프로젝트별)·전역(사용자) 두 범위로 분리해 관리한다.
//   에이전트 프롬프트 빌더(src/server/prompts.ts · src/services/agentDispatcher.ts)
//   가 디스패치 시점에 이 값을 꺼내 시스템 프롬프트 꼬리에 주입한다.
//
// 설계
//   · projectSkillsStore(#6fd99c90) 의 패턴을 그대로 따른다 — 어댑터 기반
//     팩토리, IndexedDB 기본/메모리 폴백, 싱글턴 편의 API, subscribe 리렌더.
//   · 스킬과 달리 한 프로젝트·전역 각각 "단일 레코드" 라서 id 는 키에 고정
//     ( `local:<projectId>` · `global` ). upsert 는 같은 key 에 put 이 겹쳐
//     최신 값으로 덮어 쓰는 형태.
//   · 설정 파일 정식 경로는
//       - 로컬: <workspacePath>/.llmtycoon/rules.json
//       - 전역: <userHome>/.llmtycoon/rules.json
//     브라우저 런타임에서는 파일 I/O 가 없어 export/import 보조 함수로 같은
//     스키마의 JSON 문자열을 복제한다. 서버 파일 시스템 경로는 문자열 상수로
//     보존해, 후속 서버 연결점이 같은 스키마를 그대로 재사용할 수 있게 한다.

export type CodeRulesScope = 'local' | 'global';

export const CODE_RULES_FILENAME = '.llmtycoon/rules.json';

export type IndentStyle = 'space' | 'tab';
export type QuoteStyle = 'single' | 'double' | 'backtick';
export type SemicolonPolicy = 'required' | 'omit';
export type FilenameConvention = 'kebab-case' | 'camelCase' | 'PascalCase' | 'snake_case';
export type LinterPreset =
  | 'none'
  | 'eslint-recommended'
  | 'prettier'
  | 'airbnb'
  | 'standard'
  | 'stylistic';

export const LINTER_PRESETS: readonly LinterPreset[] = Object.freeze([
  'none',
  'eslint-recommended',
  'prettier',
  'airbnb',
  'standard',
  'stylistic',
]) as readonly LinterPreset[];

export const FILENAME_CONVENTIONS: readonly FilenameConvention[] = Object.freeze([
  'kebab-case',
  'camelCase',
  'PascalCase',
  'snake_case',
]) as readonly FilenameConvention[];

export interface ForbiddenPattern {
  /** 사람이 읽기 위한 짧은 이름. 예: "console-log 금지". */
  name: string;
  /** JavaScript RegExp 로 해석 가능한 문자열 패턴. 유효성은 validate 단계에서 검사. */
  pattern: string;
  /** 선택. 에이전트에게 전달될 위반 메시지(한국어 권장). */
  message?: string;
}

export interface CodeRulesRecord {
  id: string;                       // `local:<projectId>` 또는 `global`
  scope: CodeRulesScope;
  projectId: string;                // global 은 빈 문자열
  schemaVersion: 1;
  updatedAt: number;
  indentation: {
    style: IndentStyle;
    size: number;                   // 1..8
  };
  quotes: QuoteStyle;
  semicolons: SemicolonPolicy;
  filenameConvention: FilenameConvention;
  forbiddenPatterns: ForbiddenPattern[];
  linterPreset: LinterPreset;
  /** 자유 양식. 위 정규 필드로 표현하기 애매한 지시를 한국어로 적는다. */
  extraInstructions?: string;
}

export interface CodeRulesInput {
  scope: CodeRulesScope;
  projectId?: string;
  indentation?: Partial<CodeRulesRecord['indentation']>;
  quotes?: QuoteStyle;
  semicolons?: SemicolonPolicy;
  filenameConvention?: FilenameConvention;
  forbiddenPatterns?: ForbiddenPattern[];
  linterPreset?: LinterPreset;
  extraInstructions?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 기본값 · 검증
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CODE_RULES: Omit<CodeRulesRecord, 'id' | 'scope' | 'projectId' | 'updatedAt'> = {
  schemaVersion: 1,
  indentation: { style: 'space', size: 2 },
  quotes: 'single',
  semicolons: 'required',
  filenameConvention: 'kebab-case',
  forbiddenPatterns: [],
  linterPreset: 'none',
  extraInstructions: '',
};

export const MAX_FORBIDDEN_PATTERNS = 32;
export const MAX_EXTRA_INSTRUCTIONS = 4_000;

export interface CodeRulesValidationError {
  field: 'indentation' | 'quotes' | 'semicolons' | 'filenameConvention' | 'forbiddenPatterns' | 'linterPreset' | 'scope' | 'projectId' | 'extraInstructions';
  message: string;
}

export function validateCodeRulesInput(input: CodeRulesInput): CodeRulesValidationError[] {
  const errors: CodeRulesValidationError[] = [];
  if (input.scope !== 'local' && input.scope !== 'global') {
    errors.push({ field: 'scope', message: '스코프는 local 또는 global 이어야 합니다.' });
  }
  if (input.scope === 'local' && !input.projectId) {
    errors.push({ field: 'projectId', message: 'local 규칙은 projectId 가 필요합니다.' });
  }
  if (input.indentation) {
    if (input.indentation.style && input.indentation.style !== 'space' && input.indentation.style !== 'tab') {
      errors.push({ field: 'indentation', message: '들여쓰기 스타일은 space 또는 tab 이어야 합니다.' });
    }
    if (input.indentation.size !== undefined) {
      const n = input.indentation.size;
      if (!Number.isInteger(n) || n < 1 || n > 8) {
        errors.push({ field: 'indentation', message: '들여쓰기 크기는 1~8 사이의 정수여야 합니다.' });
      }
    }
  }
  if (input.quotes && input.quotes !== 'single' && input.quotes !== 'double' && input.quotes !== 'backtick') {
    errors.push({ field: 'quotes', message: '따옴표는 single · double · backtick 중 하나여야 합니다.' });
  }
  if (input.semicolons && input.semicolons !== 'required' && input.semicolons !== 'omit') {
    errors.push({ field: 'semicolons', message: '세미콜론 정책은 required 또는 omit 이어야 합니다.' });
  }
  if (input.filenameConvention && !FILENAME_CONVENTIONS.includes(input.filenameConvention)) {
    errors.push({ field: 'filenameConvention', message: '파일명 규칙 값이 허용 목록에 없습니다.' });
  }
  if (input.linterPreset && !LINTER_PRESETS.includes(input.linterPreset)) {
    errors.push({ field: 'linterPreset', message: '린터 프리셋 값이 허용 목록에 없습니다.' });
  }
  if (input.forbiddenPatterns) {
    if (input.forbiddenPatterns.length > MAX_FORBIDDEN_PATTERNS) {
      errors.push({ field: 'forbiddenPatterns', message: `금지 패턴은 최대 ${MAX_FORBIDDEN_PATTERNS}개까지 허용됩니다.` });
    }
    for (const p of input.forbiddenPatterns) {
      if (!p || typeof p !== 'object') {
        errors.push({ field: 'forbiddenPatterns', message: '금지 패턴 항목은 객체여야 합니다.' });
        continue;
      }
      if (!p.name || !p.name.trim()) {
        errors.push({ field: 'forbiddenPatterns', message: '금지 패턴 이름이 비어 있습니다.' });
      }
      if (!p.pattern || !p.pattern.trim()) {
        errors.push({ field: 'forbiddenPatterns', message: '금지 패턴 regex 가 비어 있습니다.' });
        continue;
      }
      try {
        new RegExp(p.pattern);
      } catch (e) {
        errors.push({ field: 'forbiddenPatterns', message: `잘못된 정규식: "${p.name}" — ${(e as Error).message}` });
      }
    }
  }
  if (input.extraInstructions && input.extraInstructions.length > MAX_EXTRA_INSTRUCTIONS) {
    errors.push({ field: 'extraInstructions', message: `추가 지시는 ${MAX_EXTRA_INSTRUCTIONS}자 이하만 허용됩니다.` });
  }
  return errors;
}

// ────────────────────────────────────────────────────────────────────────────
// 어댑터 · 팩토리
// ────────────────────────────────────────────────────────────────────────────

export interface CodeRulesStorageAdapter {
  put(key: string, value: CodeRulesRecord): Promise<void>;
  get(key: string): Promise<CodeRulesRecord | null>;
  delete(key: string): Promise<void>;
  list(): Promise<CodeRulesRecord[]>;
  clear(): Promise<void>;
}

export interface CodeRulesStore {
  /** 같은 scope/projectId 조합은 단일 레코드를 덮어 쓴다. */
  save(input: CodeRulesInput): Promise<CodeRulesRecord>;
  /** 지정 scope 의 현재 레코드. 없으면 null. */
  load(scope: CodeRulesScope, projectId?: string): Promise<CodeRulesRecord | null>;
  /** 에이전트 컨텍스트 조합용. local 이 있으면 local, 없으면 global 로 폴백. */
  loadForAgent(projectId: string): Promise<CodeRulesRecord | null>;
  /** 전체 목록(디버그·내보내기 용). */
  listAll(): Promise<CodeRulesRecord[]>;
  clear(scope: CodeRulesScope, projectId?: string): Promise<void>;
  subscribe(projectId: string, listener: () => void): () => void;
  clearAll(): Promise<void>;
}

export interface CreateCodeRulesStoreOptions {
  adapter?: CodeRulesStorageAdapter;
  now?: () => number;
}

function keyFor(scope: CodeRulesScope, projectId: string): string {
  return scope === 'global' ? 'global' : `local:${projectId}`;
}

function mergeWithDefaults(input: CodeRulesInput, now: number): Omit<CodeRulesRecord, 'id'> {
  const d = DEFAULT_CODE_RULES;
  return {
    scope: input.scope,
    projectId: input.scope === 'global' ? '' : (input.projectId ?? ''),
    schemaVersion: 1,
    updatedAt: now,
    indentation: {
      style: input.indentation?.style ?? d.indentation.style,
      size: input.indentation?.size ?? d.indentation.size,
    },
    quotes: input.quotes ?? d.quotes,
    semicolons: input.semicolons ?? d.semicolons,
    filenameConvention: input.filenameConvention ?? d.filenameConvention,
    forbiddenPatterns: (input.forbiddenPatterns ?? []).map((p) => ({
      name: p.name.trim(),
      pattern: p.pattern,
      message: p.message?.trim() || undefined,
    })),
    linterPreset: input.linterPreset ?? d.linterPreset,
    extraInstructions: (input.extraInstructions ?? '').trim() || undefined,
  };
}

const GLOBAL_LISTENER_KEY = '__global__';

function isCodeRulesRecord(raw: unknown): raw is CodeRulesRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<CodeRulesRecord>;
  return (
    r.schemaVersion === 1 &&
    typeof r.id === 'string' &&
    (r.scope === 'local' || r.scope === 'global') &&
    typeof r.projectId === 'string' &&
    typeof r.updatedAt === 'number'
  );
}

export function createCodeRulesStore(
  options: CreateCodeRulesStoreOptions = {},
): CodeRulesStore {
  const adapter = options.adapter ?? createIndexedDbCodeRulesStorage();
  const now = options.now ?? Date.now;

  const listeners = new Map<string, Set<() => void>>();
  function notify(projectId: string) {
    const keys = projectId === GLOBAL_LISTENER_KEY
      ? Array.from(listeners.keys())
      : [projectId, GLOBAL_LISTENER_KEY];
    for (const k of keys) {
      const set = listeners.get(k);
      if (!set) continue;
      set.forEach((l) => { try { l(); } catch { /* isolate */ } });
    }
  }

  return {
    async save(input) {
      const errors = validateCodeRulesInput(input);
      if (errors.length > 0) throw new Error(errors.map((e) => e.message).join(' '));
      const merged = mergeWithDefaults(input, now());
      const id = keyFor(merged.scope, merged.projectId);
      const record: CodeRulesRecord = { id, ...merged };
      await adapter.put(id, record);
      notify(record.scope === 'global' ? GLOBAL_LISTENER_KEY : record.projectId);
      return record;
    },

    async load(scope, projectId = '') {
      const key = keyFor(scope, projectId);
      const raw = await adapter.get(key);
      return raw && isCodeRulesRecord(raw) ? raw : null;
    },

    async loadForAgent(projectId) {
      const local = await adapter.get(keyFor('local', projectId));
      if (local && isCodeRulesRecord(local)) return local;
      const global = await adapter.get(keyFor('global', ''));
      return global && isCodeRulesRecord(global) ? global : null;
    },

    async listAll() {
      const all = await adapter.list();
      return all.filter(isCodeRulesRecord);
    },

    async clear(scope, projectId = '') {
      const key = keyFor(scope, projectId);
      await adapter.delete(key);
      notify(scope === 'global' ? GLOBAL_LISTENER_KEY : projectId);
    },

    subscribe(projectId, listener) {
      const key = projectId || GLOBAL_LISTENER_KEY;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(listener);
      return () => {
        const set = listeners.get(key);
        if (!set) return;
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
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
// 메모리 어댑터 — 테스트 · SSR 폴백
// ────────────────────────────────────────────────────────────────────────────

export function createMemoryCodeRulesStorage(): CodeRulesStorageAdapter {
  const data = new Map<string, CodeRulesRecord>();
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

export interface IndexedDbCodeRulesStorageOptions {
  databaseName?: string;
  storeName?: string;
  indexedDb?: IDBFactory;
}

const DEFAULT_CODE_RULES_DB = 'llmtycoon-code-rules';
const DEFAULT_CODE_RULES_STORE = 'rules-v1';

export function createIndexedDbCodeRulesStorage(
  options: IndexedDbCodeRulesStorageOptions = {},
): CodeRulesStorageAdapter {
  const idb = options.indexedDb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return createMemoryCodeRulesStorage();

  const dbName = options.databaseName ?? DEFAULT_CODE_RULES_DB;
  const storeName = options.storeName ?? DEFAULT_CODE_RULES_STORE;

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
      const raw = await tx('readonly', (s) => s.get(key) as IDBRequest<CodeRulesRecord | undefined>);
      return raw ?? null;
    },
    async delete(key) {
      await tx('readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
    },
    async list() {
      return tx('readonly', (s) => s.getAll() as IDBRequest<CodeRulesRecord[]>);
    },
    async clear() {
      await tx('readwrite', (s) => s.clear() as IDBRequest<undefined>);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Import · Export 직렬화 — `.llmtycoon/rules.json` 왕복
// ────────────────────────────────────────────────────────────────────────────
//
// 브라우저에서 파일 시스템에 직접 쓰지 못하므로, 사용자가 같은 JSON 본문을
// 로컬의 .llmtycoon/rules.json 또는 사용자 홈의 동일 경로에 붙여 넣을 수 있도록
// 문자열 변환 보조 함수를 둔다. 서버 연결점이 추가되면 이 JSON 을 그대로
// 디스크에 덤프하면 된다.

export function serializeCodeRulesForFile(record: CodeRulesRecord): string {
  const { id: _id, ...rest } = record;
  return JSON.stringify(rest, null, 2);
}

export function parseCodeRulesFromFile(
  text: string,
  fallback: { scope: CodeRulesScope; projectId?: string },
): { record: CodeRulesInput; errors: CodeRulesValidationError[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      record: { scope: fallback.scope, projectId: fallback.projectId },
      errors: [{ field: 'scope', message: `JSON 파싱 실패: ${(e as Error).message}` }],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      record: { scope: fallback.scope, projectId: fallback.projectId },
      errors: [{ field: 'scope', message: '최상위는 객체여야 합니다.' }],
    };
  }
  const o = parsed as Record<string, unknown>;
  const scope = (o.scope === 'local' || o.scope === 'global') ? o.scope : fallback.scope;
  const projectId = typeof o.projectId === 'string' && o.projectId ? o.projectId : fallback.projectId;
  const rawIndent = (o.indentation && typeof o.indentation === 'object') ? o.indentation as Record<string, unknown> : undefined;
  const input: CodeRulesInput = {
    scope,
    projectId,
    indentation: rawIndent ? {
      style: rawIndent.style === 'tab' ? 'tab' : 'space',
      size: typeof rawIndent.size === 'number' ? rawIndent.size : DEFAULT_CODE_RULES.indentation.size,
    } : undefined,
    quotes: (o.quotes === 'single' || o.quotes === 'double' || o.quotes === 'backtick') ? o.quotes : undefined,
    semicolons: (o.semicolons === 'required' || o.semicolons === 'omit') ? o.semicolons : undefined,
    filenameConvention: FILENAME_CONVENTIONS.includes(o.filenameConvention as FilenameConvention)
      ? o.filenameConvention as FilenameConvention : undefined,
    linterPreset: LINTER_PRESETS.includes(o.linterPreset as LinterPreset)
      ? o.linterPreset as LinterPreset : undefined,
    forbiddenPatterns: Array.isArray(o.forbiddenPatterns)
      ? o.forbiddenPatterns
          .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && !Array.isArray(p))
          .map((p) => ({
            name: typeof p.name === 'string' ? p.name : '',
            pattern: typeof p.pattern === 'string' ? p.pattern : '',
            message: typeof p.message === 'string' ? p.message : undefined,
          }))
      : undefined,
    extraInstructions: typeof o.extraInstructions === 'string' ? o.extraInstructions : undefined,
  };
  return { record: input, errors: validateCodeRulesInput(input) };
}

// ────────────────────────────────────────────────────────────────────────────
// 싱글턴 편의 API
// ────────────────────────────────────────────────────────────────────────────

let defaultStore: CodeRulesStore | null = null;
function getDefaultStore(): CodeRulesStore {
  if (!defaultStore) defaultStore = createCodeRulesStore();
  return defaultStore;
}

/** 테스트/세션 리셋 전용. */
export function __setDefaultCodeRulesStoreForTests(store: CodeRulesStore | null): void {
  defaultStore = store;
}

export function saveCodeRules(input: CodeRulesInput): Promise<CodeRulesRecord> {
  return getDefaultStore().save(input);
}

export function loadCodeRules(scope: CodeRulesScope, projectId?: string): Promise<CodeRulesRecord | null> {
  return getDefaultStore().load(scope, projectId);
}

export function loadCodeRulesForAgent(projectId: string): Promise<CodeRulesRecord | null> {
  return getDefaultStore().loadForAgent(projectId);
}

export function subscribeCodeRules(projectId: string, listener: () => void): () => void {
  return getDefaultStore().subscribe(projectId, listener);
}

export function clearCodeRules(scope: CodeRulesScope, projectId?: string): Promise<void> {
  return getDefaultStore().clear(scope, projectId);
}
