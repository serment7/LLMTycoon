// 지시 #222ece09 §2 — 초안(Draft) 지속 계층.
//
// App.tsx 의 리더 지시 입력(`commandInput`)과 멀티미디어 첨부(`pendingAttachments` +
// `mediaChatAttachments`) 는 탭 새로고침·토큰 만료 복구·실수 이탈 직후 사라지면 안
// 된다. 본 모듈은 IndexedDB 기반 경량 저장소를 제공해, 대화별(conversationId) 키로
// 초안을 격리·영속한다. 전송 성공 시 App 쪽이 명시적으로 `remove(conversationId)` 를
// 불러 정리하고, 사용자가 드롭존의 "초안 지우기" 를 누르면 같은 API 를 통해 즉시
// 날릴 수 있다.
//
// 설계 포인트
//   · 저장 엔진은 `DraftStorageAdapter` 인터페이스로 추상화한다. 기본은 IDB, 테스트
//     환경(Node)은 메모리 어댑터로 동일 계약을 검증한다.
//   · `save()` 는 디바운스 책임을 호출자가 진다 — 타이머 로직은 본 모듈이 소유하지
//     않아 순수함수 집합으로 남는다(React 의존 0).
//   · 직렬화는 JSON 호환만 전제한다 — File/Blob 바이트는 보관하지 않는다.

import type { MediaChatAttachment } from './mediaLoaders';

export interface DraftEnvelope {
  conversationId: string;
  bodyText: string;
  attachments: MediaChatAttachment[];
  savedAtMs: number;
  /** 스키마 버전 — 구조 변경 시 올린다. */
  schemaVersion: 1;
}

export type DraftInput = Omit<DraftEnvelope, 'savedAtMs' | 'schemaVersion'>;

export interface DraftStorageAdapter {
  get(key: string): Promise<DraftEnvelope | null>;
  put(key: string, value: DraftEnvelope): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<Array<{ key: string; value: DraftEnvelope }>>;
  clear(): Promise<void>;
}

export interface DraftStore {
  /** 대화 id 를 키로 초안을 저장한다. 기존 값이 있으면 덮어쓴다. */
  save(conversationId: string, input: DraftInput): Promise<void>;
  /** 초안을 불러온다. 없으면 null. 스키마 불일치도 null 로 수렴한다. */
  load(conversationId: string): Promise<DraftEnvelope | null>;
  /** 단일 대화 초안 제거. 없어도 오류가 아니다. */
  remove(conversationId: string): Promise<void>;
  /** 모든 초안 배열. 새로고침 복원 직후 대시보드 표시 용. */
  listAll(): Promise<DraftEnvelope[]>;
  /** 전역 초기화 — 로그아웃 시 호출 가능. */
  clearAll(): Promise<void>;
}

export interface CreateDraftStoreOptions {
  adapter?: DraftStorageAdapter;
  now?: () => number;
}

function isDraftEnvelope(raw: unknown): raw is DraftEnvelope {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<DraftEnvelope>;
  return r.schemaVersion === 1
    && typeof r.conversationId === 'string'
    && typeof r.bodyText === 'string'
    && Array.isArray(r.attachments)
    && typeof r.savedAtMs === 'number';
}

export function createDraftStore(options: CreateDraftStoreOptions = {}): DraftStore {
  const adapter = options.adapter ?? createIndexedDbDraftStorage();
  const now = options.now ?? Date.now;

  return {
    async save(conversationId, input) {
      if (!conversationId) throw new Error('conversationId 가 비어 있습니다.');
      const envelope: DraftEnvelope = {
        schemaVersion: 1,
        conversationId,
        bodyText: input.bodyText,
        attachments: input.attachments,
        savedAtMs: now(),
      };
      await adapter.put(conversationId, envelope);
    },
    async load(conversationId) {
      const raw = await adapter.get(conversationId);
      if (!raw) return null;
      if (!isDraftEnvelope(raw)) return null;
      if (raw.conversationId !== conversationId) return null;
      return raw;
    },
    async remove(conversationId) {
      await adapter.delete(conversationId);
    },
    async listAll() {
      const entries = await adapter.list();
      return entries
        .map(e => e.value)
        .filter(isDraftEnvelope)
        .sort((a, b) => b.savedAtMs - a.savedAtMs);
    },
    async clearAll() {
      await adapter.clear();
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 메모리 어댑터 — 테스트·SSR 폴백
// ────────────────────────────────────────────────────────────────────────────

export function createMemoryDraftStorage(): DraftStorageAdapter {
  const map = new Map<string, DraftEnvelope>();
  return {
    async get(key) { return map.get(key) ?? null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async list() { return Array.from(map.entries()).map(([key, value]) => ({ key, value })); },
    async clear() { map.clear(); },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// IndexedDB 어댑터
// ────────────────────────────────────────────────────────────────────────────

export interface IndexedDbDraftStorageOptions {
  databaseName?: string;
  storeName?: string;
  /** 테스트 전용 — indexedDB 전역을 직접 주입한다. 기본 globalThis.indexedDB. */
  indexedDb?: IDBFactory;
}

const DEFAULT_DB = 'llmtycoon-drafts';
const DEFAULT_STORE = 'drafts-v1';

/**
 * 기본 IndexedDB 어댑터. 브라우저에서는 `window.indexedDB` 를 그대로 쓴다. 해당 전역이
 * 없으면 (Node 테스트 환경) 메모리 어댑터로 조용히 폴백해 호출자는 계약을 그대로
 * 사용할 수 있다.
 */
export function createIndexedDbDraftStorage(options: IndexedDbDraftStorageOptions = {}): DraftStorageAdapter {
  const idb = options.indexedDb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    // IDB 미지원 환경 — 메모리 폴백. 사용자는 새로고침 복원을 기대할 수 없으나,
    // 세션 내 저장·복원·삭제 계약은 동일.
    return createMemoryDraftStorage();
  }
  const dbName = options.databaseName ?? DEFAULT_DB;
  const storeName = options.storeName ?? DEFAULT_STORE;

  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = idb!.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IDB open 실패'));
    });
  }

  async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const maybeReq = run(store);
        if (maybeReq instanceof Promise) {
          maybeReq.then(resolve, reject);
        } else {
          maybeReq.onsuccess = () => resolve(maybeReq.result);
          maybeReq.onerror = () => reject(maybeReq.error ?? new Error('IDB tx 실패'));
        }
      });
    } finally {
      db.close();
    }
  }

  return {
    async get(key) {
      const raw = await tx('readonly', s => s.get(key) as IDBRequest<DraftEnvelope | undefined>);
      return raw ?? null;
    },
    async put(key, value) {
      await tx('readwrite', s => s.put(value, key) as IDBRequest<IDBValidKey>);
    },
    async delete(key) {
      await tx('readwrite', s => s.delete(key) as IDBRequest<undefined>);
    },
    async list() {
      const keys = await tx('readonly', s => s.getAllKeys() as IDBRequest<IDBValidKey[]>);
      const values = await tx('readonly', s => s.getAll() as IDBRequest<DraftEnvelope[]>);
      const out: Array<{ key: string; value: DraftEnvelope }> = [];
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        const v = values[i];
        if (typeof k === 'string' && v) out.push({ key: k, value: v });
      }
      return out;
    },
    async clear() {
      await tx('readwrite', s => s.clear() as IDBRequest<undefined>);
    },
  };
}
