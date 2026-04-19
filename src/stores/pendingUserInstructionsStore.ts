// 지시 #367441f0 — 자동 개발 ON 상태에서 대기 중인 사용자 지시 큐 슬라이스.
//
// 목적
//   자동 개발 모드가 켜져 있고 팀에 working 에이전트가 있는 동안 사용자가 보낸
//   지시를 바로 리더에게 디스패치하지 않고 FIFO 로 쌓아둔다. 모든 에이전트가
//   idle 로 내려가는 순간(= 현재 task 가 모두 끝나는 순간) 큐에서 맨 앞 지시를
//   꺼내 Kai(리더) 에게 주입한다.
//
// 경쟁 상태 정책
//   큐 상태 변이는 모두 본 모듈의 `transition()` 한 곳을 거친다 — enqueue / cancel /
//   remove / markProcessing / markDone / markCancelled 가 단일 reducer 함수 위에서
//   순차 실행돼, "마지막 task 완료 순간에 두 신규 지시가 도착" 같은 경합이 큐의
//   상태 전이로 직렬화된다. 구독자는 동일 스냅샷만 보게 된다.
//
// 설계
//   · FIFO 저장 — Array 뒤쪽에 push, peekNextPending 은 status==='pending' 중 최선.
//   · localStorage 지속성(선택) — 새로고침 이후에도 대기 지시가 유지되도록 adapter 를
//     주입할 수 있게 두되, 기본은 in-memory(React 상태 + storage 이벤트 동기화 없이).
//   · 스냅샷은 `InstructionQueueSnapshot` 으로 고정해 배지 UI 가 최소한의 형태만 소비.

export type InstructionStatus = 'pending' | 'processing' | 'done' | 'cancelled';

export interface InstructionAttachmentRef {
  fileId: string;
  name: string;
  type?: string;
}

export interface PendingInstruction {
  id: string;
  text: string;
  createdAt: number;
  status: InstructionStatus;
  /** 지시를 어느 프로젝트로 보낼지 기록. flush 시점에 프로젝트가 바뀌어 있을 수 있어 보존한다. */
  projectId?: string;
  /** 첨부 파일 레퍼런스(업로드 끝난 fileId 기준). */
  attachments?: InstructionAttachmentRef[];
  /** 처리 실패 시 사용자 참고용 메시지. */
  lastError?: string;
}

export interface InstructionQueueSnapshot {
  items: readonly PendingInstruction[];
  pendingCount: number;
  processingCount: number;
}

export interface EnqueueInput {
  text: string;
  projectId?: string;
  attachments?: InstructionAttachmentRef[];
  /** 적재 직후 이미 알려진 실패 사유가 있으면 함께 기록(예: 네트워크 throw 직후 재시도 대기). */
  lastError?: string;
}

export interface PendingUserInstructionsStore {
  enqueue(input: EnqueueInput): PendingInstruction;
  /** 취소 — pending 항목만 cancelled 로 전이. processing/done/cancelled 는 no-op. */
  cancel(id: string): boolean;
  /** 리스트에서 완전히 제거. */
  remove(id: string): boolean;
  /** 큐 맨 앞 pending 한 건을 processing 으로 승격하고 반환. 없으면 null. */
  beginNextPending(): PendingInstruction | null;
  /** processing 건을 done 으로 확정. */
  markDone(id: string): boolean;
  /** processing 건을 실패로 돌려 다시 pending 으로. (네트워크 오류 재시도용) */
  markFailed(id: string, errorMessage: string): boolean;
  /** 현재 스냅샷. UI 는 이것만 소비. */
  snapshot(): InstructionQueueSnapshot;
  /** 구독. 반환값은 unsubscribe. */
  subscribe(listener: (snap: InstructionQueueSnapshot) => void): () => void;
  /** pending 전부 취소(auto-dev OFF 전환 시 '폐기' 정책). */
  cancelAllPending(): number;
  /** 전체 초기화(테스트 · 로그아웃). */
  clearAll(): void;
}

export interface CreatePendingStoreOptions {
  now?: () => number;
  newId?: () => string;
}

function generateDefaultId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Reducer — 단일 상태 전이 진입점
// ────────────────────────────────────────────────────────────────────────────

type Action =
  | { type: 'enqueue'; item: PendingInstruction }
  | { type: 'cancel'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'beginNext' }
  | { type: 'markDone'; id: string }
  | { type: 'markFailed'; id: string; error: string }
  | { type: 'cancelAllPending' }
  | { type: 'clear' };

interface ReducerResult {
  items: PendingInstruction[];
  /** 해당 액션이 꺼낸/바뀐 대상 항목. 호출자에게 반환값으로 전달. */
  affected: PendingInstruction | null;
  /** 실질 변경이 있었는지. false 면 notify 생략. */
  changed: boolean;
}

function reduce(state: readonly PendingInstruction[], action: Action): ReducerResult {
  switch (action.type) {
    case 'enqueue':
      return { items: [...state, action.item], affected: action.item, changed: true };
    case 'cancel': {
      let affected: PendingInstruction | null = null;
      let didTransition = false;
      const items = state.map((r) => {
        if (r.id !== action.id) return r;
        if (r.status !== 'pending') { affected = r; return r; }
        const next: PendingInstruction = { ...r, status: 'cancelled' };
        affected = next;
        didTransition = true;
        return next;
      });
      return { items, affected, changed: didTransition };
    }
    case 'remove': {
      const target = state.find((r) => r.id === action.id) ?? null;
      if (!target) return { items: [...state], affected: null, changed: false };
      return { items: state.filter((r) => r.id !== action.id), affected: target, changed: true };
    }
    case 'beginNext': {
      const idx = state.findIndex((r) => r.status === 'pending');
      if (idx === -1) return { items: [...state], affected: null, changed: false };
      const next: PendingInstruction = { ...state[idx], status: 'processing' };
      const items = [...state];
      items[idx] = next;
      return { items, affected: next, changed: true };
    }
    case 'markDone': {
      let affected: PendingInstruction | null = null;
      const items = state.map((r) => {
        if (r.id !== action.id || r.status !== 'processing') return r;
        const next: PendingInstruction = { ...r, status: 'done' };
        affected = next;
        return next;
      });
      return { items, affected, changed: affected !== null };
    }
    case 'markFailed': {
      let affected: PendingInstruction | null = null;
      const items = state.map((r) => {
        if (r.id !== action.id || r.status !== 'processing') return r;
        // 실패는 다시 pending 맨 앞으로 돌려 재시도 여지를 남긴다. 다만 순서가 망가지지
        // 않도록 원래 자리를 유지하되 lastError 만 갱신한다. 연속 실패는 호출자가
        // cancel 로 명시 제거해야 한다.
        const next: PendingInstruction = { ...r, status: 'pending', lastError: action.error };
        affected = next;
        return next;
      });
      return { items, affected, changed: affected !== null };
    }
    case 'cancelAllPending': {
      let changed = false;
      const items = state.map((r) => {
        if (r.status !== 'pending') return r;
        changed = true;
        return { ...r, status: 'cancelled' as const };
      });
      return { items, affected: null, changed };
    }
    case 'clear':
      return { items: [], affected: null, changed: state.length > 0 };
  }
}

function summarize(items: readonly PendingInstruction[]): InstructionQueueSnapshot {
  let pending = 0;
  let processing = 0;
  for (const r of items) {
    if (r.status === 'pending') pending += 1;
    else if (r.status === 'processing') processing += 1;
  }
  return { items, pendingCount: pending, processingCount: processing };
}

// ────────────────────────────────────────────────────────────────────────────
// 팩토리
// ────────────────────────────────────────────────────────────────────────────

export function createPendingUserInstructionsStore(
  options: CreatePendingStoreOptions = {},
): PendingUserInstructionsStore {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? generateDefaultId;

  let state: readonly PendingInstruction[] = [];
  const listeners = new Set<(snap: InstructionQueueSnapshot) => void>();

  function apply(action: Action): ReducerResult {
    const result = reduce(state, action);
    if (result.changed) {
      state = Object.freeze(result.items);
      const snap = summarize(state);
      for (const l of listeners) {
        try { l(snap); } catch { /* 한 구독자 예외가 다른 구독자로 번지지 않게 */ }
      }
    }
    return result;
  }

  return {
    enqueue(input) {
      const item: PendingInstruction = {
        id: newId(),
        text: input.text,
        createdAt: now(),
        status: 'pending',
        projectId: input.projectId,
        attachments: input.attachments && input.attachments.length > 0
          ? input.attachments.map((a) => ({ fileId: a.fileId, name: a.name, type: a.type }))
          : undefined,
        lastError: input.lastError,
      };
      apply({ type: 'enqueue', item });
      return item;
    },
    cancel(id) { return apply({ type: 'cancel', id }).changed; },
    remove(id) { return apply({ type: 'remove', id }).changed; },
    beginNextPending() { return apply({ type: 'beginNext' }).affected; },
    markDone(id) { return apply({ type: 'markDone', id }).changed; },
    markFailed(id, errorMessage) { return apply({ type: 'markFailed', id, error: errorMessage }).changed; },
    snapshot() { return summarize(state); },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    cancelAllPending() {
      const before = state.filter((r) => r.status === 'pending').length;
      apply({ type: 'cancelAllPending' });
      return before;
    },
    clearAll() { apply({ type: 'clear' }); },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 모듈 싱글턴 + 편의 API
// ────────────────────────────────────────────────────────────────────────────

let defaultStore: PendingUserInstructionsStore | null = null;

export function getPendingUserInstructionsStore(): PendingUserInstructionsStore {
  if (!defaultStore) defaultStore = createPendingUserInstructionsStore();
  return defaultStore;
}

export function __setDefaultPendingStoreForTests(store: PendingUserInstructionsStore | null): void {
  defaultStore = store;
}
