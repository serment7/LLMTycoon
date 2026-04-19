// 지시 #3f1b7597 — 실패한 Claude 요청의 영속 재시도 큐.
//
// 책임 분리(중요)
//  · 본 큐는 **오프라인·네트워크 오류·일시 5xx** 같은 재시도로 회복 가능한 실패를
//    대상으로 한다. 레이트리밋·토큰 만료·구독 만료 같은 "세션 신호" 는
//    `claudeSubscriptionSession` 의 `shouldFlushPendingQueue` / `flushPendingOnReset`
//    이 관장한다. 둘 다 큐를 쓰지만 축이 다르다:
//        - pendingRequestQueue: IDB 영속 + 지수 백오프 + 앱 재기동·네트워크 복구
//        - claudeSubscriptionSession: 메모리 세션 큐 + 5시간 창 리셋
//    본 파일은 업로드·전송이 "실패한 채 사라지는" 회귀를 막는 데 집중한다.
//
// 설계
//  · 저장은 `PendingRequestStorageAdapter` 인터페이스로 추상화. 기본은 IDB, 테스트·SSR
//    폴백은 메모리 어댑터. draftStore 와 동일 패턴으로 Node 테스트에서 100% 계약 검증.
//  · `runRetryPass({ execute, onRecovered })` — 호출자는 실제 fetch 를 `execute` 에 넣어
//    준다. 성공 시 항목 제거 + `onRecovered` 콜백(ToastProvider 연결용). 실패는 원인에
//    따라 attempts 증가 · 영구 실패로 드롭(`giveUp: true`) 분기.
//  · 중복 방지: `enqueue({ id })` 가 같은 id 로 들어오면 기존 항목을 덮어쓰지 않고
//    `attempts`/오류 메시지만 최신으로 갱신한다.

export interface PendingRequestPayload {
  endpoint: string;
  method?: string;
  /** JSON 직렬화 가능한 요청 본문. Blob/ArrayBuffer 등 바이트는 attachmentIds 로만. */
  body: unknown;
  /** 첨부 참조만 담는다(바이트는 다른 저장소에 영속). 후속에 서버가 id 로 조회. */
  attachmentIds?: string[];
  /** 대화 식별자 — UI 복구 토스트 노출·드래프트 연결에 쓴다. */
  conversationId?: string;
}

export interface PendingRequest {
  id: string;
  payload: PendingRequestPayload;
  attempts: number;
  enqueuedAtMs: number;
  nextAttemptAtMs: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  /** 스키마 버전. 구조 변경 시 올린다. */
  schemaVersion: 1;
}

export interface PendingRequestStorageAdapter {
  get(id: string): Promise<PendingRequest | null>;
  put(req: PendingRequest): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<PendingRequest[]>;
  clear(): Promise<void>;
}

export interface PendingRequestQueueOptions {
  adapter?: PendingRequestStorageAdapter;
  now?: () => number;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** 0..1 사이 값을 돌려주는 jitter — 기본 Math.random. 테스트는 상수 주입. */
  jitter?: () => number;
  /** uuid 생성. 기본은 간이 구현. */
  generateId?: () => string;
}

export interface EnqueueInput {
  id?: string;
  payload: PendingRequestPayload;
  errorCode?: string;
  errorMessage?: string;
}

export interface ExecuteResult {
  ok: boolean;
  /** 영구 실패(재시도 포기). 4xx 입력 오류·권한 등. */
  giveUp?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface RetryPassReport {
  succeeded: PendingRequest[];
  failed: PendingRequest[];
  droppedPermanent: PendingRequest[];
  deferred: PendingRequest[];
}

export interface PendingRequestQueue {
  enqueue(input: EnqueueInput): Promise<PendingRequest>;
  dequeue(id: string): Promise<void>;
  list(): Promise<PendingRequest[]>;
  /**
   * 지금 시각 기준 재시도 가능한(= nextAttemptAtMs <= now) 항목을 execute 로 돌린다.
   * 성공 항목은 제거되고, 실패 항목은 attempts 증가 후 지수 백오프로 다음 시각 갱신.
   * maxAttempts 초과 또는 giveUp=true 는 영구 실패로 큐에서 삭제된다.
   */
  runRetryPass(params: {
    execute: (req: PendingRequest) => Promise<ExecuteResult>;
    onRecovered?: (req: PendingRequest) => void;
    signal?: AbortSignal;
  }): Promise<RetryPassReport>;
  clear(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 — 지수 백오프
// ────────────────────────────────────────────────────────────────────────────

export function computeNextAttemptDelayMs(
  attempts: number,
  params: { initialBackoffMs: number; maxBackoffMs: number; jitter: () => number },
): number {
  const expo = params.initialBackoffMs * Math.pow(2, Math.max(0, attempts));
  const capped = Math.min(params.maxBackoffMs, expo);
  // full jitter — 0..capped 사이 균등. 다수 클라이언트가 한꺼번에 재시도해
  // 서버를 스파이크로 치는 "thundering herd" 를 피한다.
  const noise = Math.max(0, Math.min(1, params.jitter()));
  return Math.floor(capped * (0.5 + noise * 0.5));
}

// ────────────────────────────────────────────────────────────────────────────
// 메모리 어댑터 — 테스트·SSR 폴백
// ────────────────────────────────────────────────────────────────────────────

export function createMemoryPendingRequestStorage(): PendingRequestStorageAdapter {
  const map = new Map<string, PendingRequest>();
  return {
    async get(id) { return map.get(id) ?? null; },
    async put(req) { map.set(req.id, req); },
    async delete(id) { map.delete(id); },
    async list() { return Array.from(map.values()); },
    async clear() { map.clear(); },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// IndexedDB 어댑터 — 브라우저 영속 저장소
// ────────────────────────────────────────────────────────────────────────────

export interface IndexedDbPendingRequestStorageOptions {
  databaseName?: string;
  storeName?: string;
  indexedDb?: IDBFactory;
}

const DEFAULT_DB = 'llmtycoon-pending-requests';
const DEFAULT_STORE = 'requests-v1';

export function createIndexedDbPendingRequestStorage(
  options: IndexedDbPendingRequestStorageOptions = {},
): PendingRequestStorageAdapter {
  const idb = options.indexedDb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return createMemoryPendingRequestStorage();

  const dbName = options.databaseName ?? DEFAULT_DB;
  const storeName = options.storeName ?? DEFAULT_STORE;

  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = idb!.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IDB open 실패'));
    });
  }

  async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const r = run(store);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error ?? new Error('IDB tx 실패'));
      });
    } finally {
      db.close();
    }
  }

  return {
    async get(id) {
      const raw = await tx('readonly', s => s.get(id) as IDBRequest<PendingRequest | undefined>);
      return raw ?? null;
    },
    async put(req) {
      await tx('readwrite', s => s.put(req) as IDBRequest<IDBValidKey>);
    },
    async delete(id) {
      await tx('readwrite', s => s.delete(id) as IDBRequest<undefined>);
    },
    async list() {
      const items = await tx('readonly', s => s.getAll() as IDBRequest<PendingRequest[]>);
      return items ?? [];
    },
    async clear() {
      await tx('readwrite', s => s.clear() as IDBRequest<undefined>);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 큐 팩토리
// ────────────────────────────────────────────────────────────────────────────

function defaultGenerateId(): string {
  return `req-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function createPendingRequestQueue(
  options: PendingRequestQueueOptions = {},
): PendingRequestQueue {
  const adapter = options.adapter ?? createIndexedDbPendingRequestStorage();
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? 5;
  const initialBackoffMs = options.initialBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const jitter = options.jitter ?? Math.random;
  const generateId = options.generateId ?? defaultGenerateId;

  function nextDelay(attempts: number): number {
    return computeNextAttemptDelayMs(attempts, { initialBackoffMs, maxBackoffMs, jitter });
  }

  return {
    async enqueue(input) {
      const id = input.id ?? generateId();
      const existing = await adapter.get(id);
      const t = now();
      if (existing) {
        const updated: PendingRequest = {
          ...existing,
          attempts: existing.attempts + 1,
          nextAttemptAtMs: t + nextDelay(existing.attempts + 1),
          lastErrorCode: input.errorCode ?? existing.lastErrorCode,
          lastErrorMessage: input.errorMessage ?? existing.lastErrorMessage,
        };
        await adapter.put(updated);
        return updated;
      }
      const req: PendingRequest = {
        schemaVersion: 1,
        id,
        payload: input.payload,
        attempts: 0,
        enqueuedAtMs: t,
        nextAttemptAtMs: t + nextDelay(0),
        lastErrorCode: input.errorCode,
        lastErrorMessage: input.errorMessage,
      };
      await adapter.put(req);
      return req;
    },

    async dequeue(id) {
      await adapter.delete(id);
    },

    async list() {
      return adapter.list();
    },

    async clear() {
      await adapter.clear();
    },

    async runRetryPass({ execute, onRecovered, signal }) {
      const items = await adapter.list();
      const report: RetryPassReport = {
        succeeded: [],
        failed: [],
        droppedPermanent: [],
        deferred: [],
      };
      for (const req of items) {
        if (signal?.aborted) break;
        const t = now();
        if (req.nextAttemptAtMs > t) {
          report.deferred.push(req);
          continue;
        }
        let result: ExecuteResult;
        try {
          result = await execute(req);
        } catch (err) {
          result = {
            ok: false,
            errorCode: (err as { code?: string }).code,
            errorMessage: (err as Error).message,
          };
        }
        if (result.ok) {
          await adapter.delete(req.id);
          report.succeeded.push(req);
          try { onRecovered?.(req); } catch { /* 통지 실패는 큐 상태에 영향 없음 */ }
          continue;
        }
        if (result.giveUp || req.attempts + 1 >= maxAttempts) {
          await adapter.delete(req.id);
          report.droppedPermanent.push({ ...req, attempts: req.attempts + 1 });
          continue;
        }
        const updated: PendingRequest = {
          ...req,
          attempts: req.attempts + 1,
          nextAttemptAtMs: now() + nextDelay(req.attempts + 1),
          lastErrorCode: result.errorCode,
          lastErrorMessage: result.errorMessage,
        };
        await adapter.put(updated);
        report.failed.push(updated);
      }
      return report;
    },
  };
}
