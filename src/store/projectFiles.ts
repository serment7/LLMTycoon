// 지시 #1fd1b3c6 — 프로젝트별 파일 업로드 저장소.
//
// 목적
//   DirectivePrompt / UploadDropzone 에서 올라온 파일을 "프로젝트" 단위로 묶어
//   오프라인에서도 재조회할 수 있도록 메타데이터 + 원본 Blob 을 IndexedDB 에 보관한다.
//   기존 draftStore(#222ece09)와 달리 초안(대화 단위)이 아니라 프로젝트 자원이므로
//   cascade(프로젝트 삭제 시 일괄 정리) 계약을 최상위로 승격한다.
//
// 설계
//   · 두 개의 논리 저장소를 하나의 DB 에 둔다 — `files-v1`(메타데이터), `blobs-v1`(원본
//     Blob). Blob 은 메타데이터와 같은 fileId 를 키로 쓰며 cascade 에서 같이 지워진다.
//   · 스토리지 추상화는 `ProjectFileStorageAdapter` 인터페이스로 분리해 Node 테스트는
//     메모리 폴백으로, 브라우저는 IDB 로 자동 수렴한다(draftStore 와 동일 패턴).
//   · 본 모듈은 순수 함수 집합 + 팩토리(createProjectFileStore) 두 축만 노출한다.
//     React 의존 0. `subscribe(projectId, listener)` 로 메타데이터 변화만 브로드캐스트.

export type ProjectFileCategory = 'image' | 'video' | 'pdf' | 'ppt' | 'etc';

/** 영속되는 메타데이터 레코드. Blob 본체는 별도 키스페이스에 저장된다. */
export interface ProjectFileRecord {
  projectId: string;
  fileId: string;
  name: string;
  mimeType: string;
  /** 바이트 단위. Blob 의 size 와 동일하다. */
  size: number;
  /** epoch ms. */
  uploadedAt: number;
  /** Blob 이 저장된 키. 현재 구현에서는 fileId 와 동일하지만 용도를 구분해 둔다. */
  blobRef: string;
  category: ProjectFileCategory;
  /** 스키마 버전. 구조가 깨지면 올린다. */
  schemaVersion: 1;
}

export interface ProjectFileStorageAdapter {
  putMeta(key: string, value: ProjectFileRecord): Promise<void>;
  getMeta(key: string): Promise<ProjectFileRecord | null>;
  deleteMeta(key: string): Promise<void>;
  listMeta(): Promise<ProjectFileRecord[]>;
  putBlob(key: string, blob: Blob): Promise<void>;
  getBlob(key: string): Promise<Blob | null>;
  deleteBlob(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ProjectFileStore {
  /** 파일을 프로젝트에 귀속시키고 원본 Blob 을 저장한다. 레코드를 돌려준다. */
  upload(projectId: string, file: File): Promise<ProjectFileRecord>;
  /** 프로젝트 소속 파일 메타데이터만 반환. uploadedAt 내림차순. */
  list(projectId: string): Promise<ProjectFileRecord[]>;
  /** 단일 파일을 제거한다. 존재하지 않아도 오류가 아니다. */
  remove(projectId: string, fileId: string): Promise<void>;
  /** 프로젝트 삭제 cascade — 해당 프로젝트의 모든 파일/Blob 을 일괄 정리한다. */
  removeAll(projectId: string): Promise<number>;
  /** 원본 Blob 을 돌려준다. 다운로드 · 미리보기에서 쓴다. */
  getBlob(projectId: string, fileId: string): Promise<Blob | null>;
  /** 프로젝트 변경 구독. 반환값은 unsubscribe 함수. */
  subscribe(projectId: string, listener: () => void): () => void;
  /** 전역 초기화 — 로그아웃/테스트 격리 용. */
  clearAll(): Promise<void>;
}

export interface CreateProjectFileStoreOptions {
  adapter?: ProjectFileStorageAdapter;
  now?: () => number;
  /** 테스트/서버 환경에서 id 생성을 결정적으로 만들기 위한 주입. */
  newId?: () => string;
}

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 — 테스트에서 직접 호출
// ────────────────────────────────────────────────────────────────────────────

/**
 * MIME · 확장자 → 카테고리. DirectivePrompt 의 AttachmentKind('pdf'/'image'/'text'/'other')
 * 와 범주가 약간 다르다(영상·PPT 를 독립 축으로 승격). 라벨/아이콘은 호출자가 매핑한다.
 */
export function categorizeFile(mimeType: string, name: string): ProjectFileCategory {
  const mime = (mimeType || '').toLowerCase();
  const ext = (name.toLowerCase().split('.').pop() ?? '').trim();
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) {
    return 'image';
  }
  if (mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) {
    return 'video';
  }
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (
    mime === 'application/vnd.ms-powerpoint' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    ext === 'ppt' || ext === 'pptx'
  ) {
    return 'ppt';
  }
  return 'etc';
}

function generateDefaultId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Node < 19 또는 구형 브라우저 폴백. 충돌 확률이 실무상 무시 가능.
  return `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isProjectFileRecord(raw: unknown): raw is ProjectFileRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<ProjectFileRecord>;
  return (
    r.schemaVersion === 1 &&
    typeof r.projectId === 'string' &&
    typeof r.fileId === 'string' &&
    typeof r.name === 'string' &&
    typeof r.mimeType === 'string' &&
    typeof r.size === 'number' &&
    typeof r.uploadedAt === 'number' &&
    typeof r.blobRef === 'string' &&
    typeof r.category === 'string'
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 팩토리
// ────────────────────────────────────────────────────────────────────────────

export function createProjectFileStore(options: CreateProjectFileStoreOptions = {}): ProjectFileStore {
  const adapter = options.adapter ?? createIndexedDbProjectFileStorage();
  const now = options.now ?? Date.now;
  const newId = options.newId ?? generateDefaultId;

  const listeners = new Map<string, Set<() => void>>();
  function notify(projectId: string) {
    const set = listeners.get(projectId);
    if (!set) return;
    set.forEach((l) => {
      try { l(); } catch { /* 단일 구독자 예외가 전체 브로드캐스트를 막지 않게. */ }
    });
  }

  return {
    async upload(projectId, file) {
      if (!projectId) throw new Error('projectId 가 비어 있습니다.');
      if (!file) throw new Error('file 이 비어 있습니다.');
      const fileId = newId();
      const record: ProjectFileRecord = {
        schemaVersion: 1,
        projectId,
        fileId,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        uploadedAt: now(),
        blobRef: fileId,
        category: categorizeFile(file.type, file.name),
      };
      await adapter.putBlob(fileId, file);
      await adapter.putMeta(fileId, record);
      notify(projectId);
      return record;
    },

    async list(projectId) {
      const all = await adapter.listMeta();
      return all
        .filter(isProjectFileRecord)
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => b.uploadedAt - a.uploadedAt);
    },

    async remove(projectId, fileId) {
      const meta = await adapter.getMeta(fileId);
      if (!meta || meta.projectId !== projectId) {
        // 타 프로젝트 파일을 삭제 요청으로 침범하지 않는다 — no-op 으로 수렴.
        return;
      }
      await adapter.deleteBlob(meta.blobRef);
      await adapter.deleteMeta(fileId);
      notify(projectId);
    },

    async removeAll(projectId) {
      const all = await adapter.listMeta();
      const targets = all.filter(isProjectFileRecord).filter((r) => r.projectId === projectId);
      for (const r of targets) {
        await adapter.deleteBlob(r.blobRef);
        await adapter.deleteMeta(r.fileId);
      }
      if (targets.length > 0) notify(projectId);
      return targets.length;
    },

    async getBlob(projectId, fileId) {
      const meta = await adapter.getMeta(fileId);
      if (!meta || meta.projectId !== projectId) return null;
      return adapter.getBlob(meta.blobRef);
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
      listeners.clear();
      keys.forEach((k) => {
        // clear 후에도 기존 구독자가 UI 를 새로고침하도록 한 번씩 통지.
        const tmp = listeners.get(k);
        tmp?.forEach((l) => { try { l(); } catch { /* ignore */ } });
      });
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 메모리 어댑터 — 테스트 · SSR 폴백
// ────────────────────────────────────────────────────────────────────────────

export function createMemoryProjectFileStorage(): ProjectFileStorageAdapter {
  const meta = new Map<string, ProjectFileRecord>();
  const blobs = new Map<string, Blob>();
  return {
    async putMeta(key, value) { meta.set(key, value); },
    async getMeta(key) { return meta.get(key) ?? null; },
    async deleteMeta(key) { meta.delete(key); },
    async listMeta() { return Array.from(meta.values()); },
    async putBlob(key, blob) { blobs.set(key, blob); },
    async getBlob(key) { return blobs.get(key) ?? null; },
    async deleteBlob(key) { blobs.delete(key); },
    async clear() { meta.clear(); blobs.clear(); },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// IndexedDB 어댑터
// ────────────────────────────────────────────────────────────────────────────

export interface IndexedDbProjectFileStorageOptions {
  databaseName?: string;
  metaStoreName?: string;
  blobStoreName?: string;
  indexedDb?: IDBFactory;
}

const DEFAULT_DB = 'llmtycoon-project-files';
const DEFAULT_META_STORE = 'files-v1';
const DEFAULT_BLOB_STORE = 'blobs-v1';

export function createIndexedDbProjectFileStorage(
  options: IndexedDbProjectFileStorageOptions = {},
): ProjectFileStorageAdapter {
  const idb = options.indexedDb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return createMemoryProjectFileStorage();

  const dbName = options.databaseName ?? DEFAULT_DB;
  const metaStore = options.metaStoreName ?? DEFAULT_META_STORE;
  const blobStore = options.blobStoreName ?? DEFAULT_BLOB_STORE;

  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = idb!.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(metaStore)) db.createObjectStore(metaStore);
        if (!db.objectStoreNames.contains(blobStore)) db.createObjectStore(blobStore);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IDB open 실패'));
    });
  }

  async function tx<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const req = run(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IDB tx 실패'));
      });
    } finally {
      db.close();
    }
  }

  return {
    async putMeta(key, value) {
      await tx(metaStore, 'readwrite', (s) => s.put(value, key) as IDBRequest<IDBValidKey>);
    },
    async getMeta(key) {
      const raw = await tx(metaStore, 'readonly', (s) => s.get(key) as IDBRequest<ProjectFileRecord | undefined>);
      return raw ?? null;
    },
    async deleteMeta(key) {
      await tx(metaStore, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
    },
    async listMeta() {
      return tx(metaStore, 'readonly', (s) => s.getAll() as IDBRequest<ProjectFileRecord[]>);
    },
    async putBlob(key, blob) {
      await tx(blobStore, 'readwrite', (s) => s.put(blob, key) as IDBRequest<IDBValidKey>);
    },
    async getBlob(key) {
      const raw = await tx(blobStore, 'readonly', (s) => s.get(key) as IDBRequest<Blob | undefined>);
      return raw ?? null;
    },
    async deleteBlob(key) {
      await tx(blobStore, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
    },
    async clear() {
      await tx(metaStore, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
      await tx(blobStore, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 모듈 싱글턴 + 편의 API
//
// 기존 DirectivePrompt · UploadDropzone 의 업로드 경로는 콜백 체인으로 이어져 있어,
// App.tsx 가 이 싱글턴을 단일 진입점으로 호출하면 드롭/선택/채팅 첨부 모두 같은
// 저장소로 수렴된다. 테스트는 createProjectFileStore 로 직접 인스턴스를 만들어
// 싱글턴을 우회한다.
// ────────────────────────────────────────────────────────────────────────────

let defaultStore: ProjectFileStore | null = null;
function getDefaultStore(): ProjectFileStore {
  if (!defaultStore) defaultStore = createProjectFileStore();
  return defaultStore;
}

/** 테스트/세션 리셋에서만 호출. 프로덕션 코드에서는 쓰지 않는다. */
export function __setDefaultProjectFileStoreForTests(store: ProjectFileStore | null): void {
  defaultStore = store;
}

export function uploadFileToProject(projectId: string, file: File): Promise<ProjectFileRecord> {
  return getDefaultStore().upload(projectId, file);
}

export function listProjectFiles(projectId: string): Promise<ProjectFileRecord[]> {
  return getDefaultStore().list(projectId);
}

export function deleteProjectFile(projectId: string, fileId: string): Promise<void> {
  return getDefaultStore().remove(projectId, fileId);
}

/** 프로젝트 삭제 시 cascade 로 호출. 삭제된 파일 개수를 돌려준다. */
export function deleteAllProjectFiles(projectId: string): Promise<number> {
  return getDefaultStore().removeAll(projectId);
}

export function getProjectFileBlob(projectId: string, fileId: string): Promise<Blob | null> {
  return getDefaultStore().getBlob(projectId, fileId);
}

export function subscribeProjectFiles(projectId: string, listener: () => void): () => void {
  return getDefaultStore().subscribe(projectId, listener);
}
