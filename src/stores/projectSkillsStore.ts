// 지시 #6fd99c90 — 프로젝트별 스킬 슬라이스.
//
// 목적
//   에이전트 디스패치 시 컨텍스트로 주입될 "스킬" 정의를 보관한다.
//   scope='local' 은 특정 프로젝트에만 유효하고, scope='global' 은 모든 프로젝트에 공통 적용된다.
//
// 설계
//   · projectFiles(#1fd1b3c6) 와 같은 어댑터 기반 팩토리 패턴. 브라우저는 IndexedDB,
//     Node/테스트는 메모리 폴백으로 자동 수렴한다.
//   · local 스킬은 키 `local:<projectId>:<skillId>`, global 은 `global:<skillId>` 로
//     단일 object store 에 보관해 list 시 한 번의 스캔으로 scope·projectId 필터가 끝난다.
//   · 본 모듈은 순수 함수 + 팩토리 두 축만 노출하며 React 의존은 0 이다.
//     구독은 projectId 단위로 쪼개 리렌더 폭발을 막는다(global 변경은 전체 구독자에 통지).

export type SkillScope = 'local' | 'global';

export interface SkillRecord {
  id: string;
  scope: SkillScope;
  /** local 스킬 전용. global 스킬은 빈 문자열. */
  projectId: string;
  name: string;
  description: string;
  /** 에이전트 컨텍스트에 주입될 본문. 마크다운/plain 둘 다 허용. */
  prompt: string;
  createdAt: number;
  schemaVersion: 1;
}

export interface SkillInput {
  scope: SkillScope;
  projectId?: string;
  name: string;
  description?: string;
  prompt: string;
}

export interface SkillStorageAdapter {
  put(key: string, value: SkillRecord): Promise<void>;
  get(key: string): Promise<SkillRecord | null>;
  delete(key: string): Promise<void>;
  list(): Promise<SkillRecord[]>;
  clear(): Promise<void>;
}

export interface ProjectSkillsStore {
  add(input: SkillInput): Promise<SkillRecord>;
  remove(id: string): Promise<void>;
  list(projectId: string): Promise<SkillRecord[]>;
  listGlobal(): Promise<SkillRecord[]>;
  /** 에이전트 컨텍스트 조합용 — local + global 을 한 번에 반환한다. */
  listForAgent(projectId: string): Promise<SkillRecord[]>;
  subscribe(projectId: string, listener: () => void): () => void;
  clearAll(): Promise<void>;
}

export interface CreateProjectSkillsStoreOptions {
  adapter?: SkillStorageAdapter;
  now?: () => number;
  newId?: () => string;
}

// ────────────────────────────────────────────────────────────────────────────
// 검증 — UI 와 팩토리에서 동일하게 호출되는 단일 출처
// ────────────────────────────────────────────────────────────────────────────

export const SKILL_NAME_MAX = 64;
export const SKILL_PROMPT_MAX = 8_000;

export interface SkillValidationError {
  field: 'name' | 'prompt' | 'scope' | 'projectId';
  message: string;
}

export function validateSkillInput(input: SkillInput): SkillValidationError[] {
  const errors: SkillValidationError[] = [];
  const name = (input.name ?? '').trim();
  if (!name) errors.push({ field: 'name', message: '스킬 이름이 비어 있습니다.' });
  else if (name.length > SKILL_NAME_MAX) errors.push({ field: 'name', message: `이름은 ${SKILL_NAME_MAX}자 이하만 허용됩니다.` });
  const prompt = input.prompt ?? '';
  if (!prompt.trim()) errors.push({ field: 'prompt', message: '스킬 프롬프트가 비어 있습니다.' });
  else if (prompt.length > SKILL_PROMPT_MAX) errors.push({ field: 'prompt', message: `프롬프트는 ${SKILL_PROMPT_MAX}자 이하만 허용됩니다.` });
  if (input.scope !== 'local' && input.scope !== 'global') {
    errors.push({ field: 'scope', message: '스코프는 local 또는 global 이어야 합니다.' });
  }
  if (input.scope === 'local' && !input.projectId) {
    errors.push({ field: 'projectId', message: 'local 스킬은 projectId 가 필요합니다.' });
  }
  return errors;
}

function keyFor(record: Pick<SkillRecord, 'scope' | 'projectId' | 'id'>): string {
  return record.scope === 'global' ? `global:${record.id}` : `local:${record.projectId}:${record.id}`;
}

function generateDefaultId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `sk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSkillRecord(raw: unknown): raw is SkillRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<SkillRecord>;
  return (
    r.schemaVersion === 1 &&
    typeof r.id === 'string' &&
    (r.scope === 'local' || r.scope === 'global') &&
    typeof r.projectId === 'string' &&
    typeof r.name === 'string' &&
    typeof r.prompt === 'string' &&
    typeof r.createdAt === 'number'
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 팩토리
// ────────────────────────────────────────────────────────────────────────────

const GLOBAL_LISTENER_KEY = '__global__';

export function createProjectSkillsStore(
  options: CreateProjectSkillsStoreOptions = {},
): ProjectSkillsStore {
  const adapter = options.adapter ?? createIndexedDbSkillStorage();
  const now = options.now ?? Date.now;
  const newId = options.newId ?? generateDefaultId;

  const listeners = new Map<string, Set<() => void>>();
  function notify(projectId: string) {
    // local 변경은 해당 프로젝트 구독자 + global 구독자(전체 보기)에 통지.
    // global 변경은 모든 구독자에 통지한다.
    const keys = projectId === GLOBAL_LISTENER_KEY
      ? Array.from(listeners.keys())
      : [projectId, GLOBAL_LISTENER_KEY];
    for (const k of keys) {
      const set = listeners.get(k);
      if (!set) continue;
      set.forEach((l) => {
        try { l(); } catch { /* 한 구독자 예외가 다른 구독자에 번지지 않게 */ }
      });
    }
  }

  return {
    async add(input) {
      const errors = validateSkillInput(input);
      if (errors.length > 0) throw new Error(errors.map((e) => e.message).join(' '));
      const id = newId();
      const record: SkillRecord = {
        id,
        scope: input.scope,
        projectId: input.scope === 'global' ? '' : (input.projectId ?? ''),
        name: input.name.trim(),
        description: (input.description ?? '').trim(),
        prompt: input.prompt,
        createdAt: now(),
        schemaVersion: 1,
      };
      await adapter.put(keyFor(record), record);
      notify(record.scope === 'global' ? GLOBAL_LISTENER_KEY : record.projectId);
      return record;
    },

    async remove(id) {
      const all = await adapter.list();
      const target = all.find((r) => isSkillRecord(r) && r.id === id);
      if (!target) return;
      await adapter.delete(keyFor(target));
      notify(target.scope === 'global' ? GLOBAL_LISTENER_KEY : target.projectId);
    },

    async list(projectId) {
      const all = await adapter.list();
      return all
        .filter(isSkillRecord)
        .filter((r) => r.scope === 'local' && r.projectId === projectId)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async listGlobal() {
      const all = await adapter.list();
      return all
        .filter(isSkillRecord)
        .filter((r) => r.scope === 'global')
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async listForAgent(projectId) {
      const all = await adapter.list();
      return all
        .filter(isSkillRecord)
        .filter((r) => r.scope === 'global' || (r.scope === 'local' && r.projectId === projectId))
        .sort((a, b) => b.createdAt - a.createdAt);
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

export function createMemorySkillStorage(): SkillStorageAdapter {
  const data = new Map<string, SkillRecord>();
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

export interface IndexedDbSkillStorageOptions {
  databaseName?: string;
  storeName?: string;
  indexedDb?: IDBFactory;
}

const DEFAULT_SKILL_DB = 'llmtycoon-project-skills';
const DEFAULT_SKILL_STORE = 'skills-v1';

export function createIndexedDbSkillStorage(
  options: IndexedDbSkillStorageOptions = {},
): SkillStorageAdapter {
  const idb = options.indexedDb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return createMemorySkillStorage();

  const dbName = options.databaseName ?? DEFAULT_SKILL_DB;
  const storeName = options.storeName ?? DEFAULT_SKILL_STORE;

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
      const raw = await tx('readonly', (s) => s.get(key) as IDBRequest<SkillRecord | undefined>);
      return raw ?? null;
    },
    async delete(key) {
      await tx('readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
    },
    async list() {
      return tx('readonly', (s) => s.getAll() as IDBRequest<SkillRecord[]>);
    },
    async clear() {
      await tx('readwrite', (s) => s.clear() as IDBRequest<undefined>);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 싱글턴 편의 API — 기본 진입점
// ────────────────────────────────────────────────────────────────────────────

let defaultStore: ProjectSkillsStore | null = null;
function getDefaultStore(): ProjectSkillsStore {
  if (!defaultStore) defaultStore = createProjectSkillsStore();
  return defaultStore;
}

/** 테스트/세션 리셋 전용. */
export function __setDefaultProjectSkillsStoreForTests(store: ProjectSkillsStore | null): void {
  defaultStore = store;
}

export function addProjectSkill(input: SkillInput): Promise<SkillRecord> {
  return getDefaultStore().add(input);
}

export function removeProjectSkill(id: string): Promise<void> {
  return getDefaultStore().remove(id);
}

export function listProjectSkills(projectId: string): Promise<SkillRecord[]> {
  return getDefaultStore().list(projectId);
}

export function listGlobalSkills(): Promise<SkillRecord[]> {
  return getDefaultStore().listGlobal();
}

export function listSkillsForAgent(projectId: string): Promise<SkillRecord[]> {
  return getDefaultStore().listForAgent(projectId);
}

export function subscribeProjectSkills(projectId: string, listener: () => void): () => void {
  return getDefaultStore().subscribe(projectId, listener);
}
