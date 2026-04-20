// 지시 #dcaee6a9 — 세션 지속성 스토어.
//
// 목적
//   "끊김 없는 개발" 메타 목표에 맞춰, 새로 고침·네트워크 단절 후 재접속에도
//   대화 히스토리·토큰 예산 총계·압축 요약·MCP 연결 스냅샷이 유지되도록
//   서버 측 JSON 컬럼(Postgres jsonb 또는 SQLite TEXT) 으로 세션 스냅샷을 저장한다.
//
// 저장 트리거(쓰기 빈도 최소화)
//   1) recordUsage   — 호출 직후 총계가 갱신될 때(상위에서 이 모듈의 `createRecordUsageEvent`).
//   2) compactHistory — `maybeCompact` 이 히스토리를 축약할 때.
//   3) MCP transport 변경 — `invalidateCachePrefix` 의 'tools-schema-changed' 포함 이벤트.
//
//   세 이벤트 이외의 "일반적인 턴" 에서는 디스크 쓰기를 하지 않는다. 또한 각 upsert 는
//   `shallowDiffSnapshot` 로 이전 스냅샷과 비교해 **바뀐 키만** 저장하도록 한다 — 토큰
//   예산 로그(usageLog) 경로와 간섭하지 않고, 실제 저장 페이로드 크기를 줄인다.
//
// 스키마
//   `SessionSnapshot` — 세션당 한 행. `SessionUpsertPayload` 는 부분 업데이트 모양.
//   두 구조 모두 JSON 직렬화 가능하고, 저장소 어댑터는 `fullSnapshot` 을 그대로
//   jsonb 컬럼에 쓰면 된다.

import type { BudgetSession, ConversationTurn } from '../llm/tokenBudget';
import type { McpTransport } from '../stores/projectMcpServersStore';

export interface SessionMcpSnapshot {
  readonly transport: McpTransport;
  readonly url?: string;
  readonly name?: string;
}

export interface SessionBudgetSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly callCount: number;
  readonly estimatedCostUsd: number;
  readonly updatedAt: string;
}

/** 지시 #8de1a1c8 — 사용자별 언어 설정. 미지정 시 서버가 기본('en') 으로 폴백. */
export type SessionLanguagePreference = 'en' | 'ko';

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly userId: string;
  readonly updatedAt: string;
  readonly history: readonly ConversationTurn[];
  readonly compactedSummary: string;
  readonly budget: SessionBudgetSnapshot;
  readonly mcp: SessionMcpSnapshot | null;
  /** 세션이 최근 수행한 압축 횟수 — 복원 후 UI 가 "요약 n회 반영됨" 배지를 띄운다. */
  readonly compactions: number;
  /**
   * UI 언어 설정. localStorage 뿐 아니라 서버 세션에도 저장해 다른 기기/탭에서 재접속
   * 해도 일관된 언어 모드가 복원된다. null 이면 "사용자가 아직 선택하지 않음(브라우저
   * 감지 폴백)".
   */
  readonly languagePreference: SessionLanguagePreference | null;
  /** schemaVersion — 구조가 바뀌면 마이그레이션 가이드를 붙일 수 있게. */
  readonly schemaVersion: 1;
}

// ────────────────────────────────────────────────────────────────────────────
// 얕은 diff — 변경된 최상위 키만 골라낸다
// ────────────────────────────────────────────────────────────────────────────

export type SessionDiffKey =
  | 'history' | 'compactedSummary' | 'budget' | 'mcp' | 'compactions' | 'languagePreference' | 'updatedAt';

/** 얕은 diff 결과 — 내부 가변 객체로 선언해 원본 readonly 제약 없이 조립할 수 있다. */
export interface SessionPatch {
  history?: readonly ConversationTurn[];
  compactedSummary?: string;
  budget?: SessionBudgetSnapshot;
  mcp?: SessionMcpSnapshot | null;
  compactions?: number;
  languagePreference?: SessionLanguagePreference | null;
  updatedAt?: string;
}

export interface SessionUpsertPayload {
  readonly sessionId: string;
  readonly userId: string;
  readonly patch: SessionPatch;
}

/**
 * 두 스냅샷의 JSON 직렬화를 최상위 키 기준으로 비교해 변경된 키만 반환한다.
 * `updatedAt` 은 필드가 변경된 경우에만 포함 — 다른 키가 실제로 바뀌지 않았다면
 * 쓰기를 건너뛸 수 있도록 호출자가 반환 객체의 키 수로 판정할 수 있다.
 */
export function shallowDiffSnapshot(
  previous: SessionSnapshot | null,
  next: SessionSnapshot,
): SessionUpsertPayload {
  const patch: SessionPatch = {};
  if (!previous) {
    return {
      sessionId: next.sessionId,
      userId: next.userId,
      patch: {
        history: next.history,
        compactedSummary: next.compactedSummary,
        budget: next.budget,
        mcp: next.mcp,
        compactions: next.compactions,
        languagePreference: next.languagePreference,
        updatedAt: next.updatedAt,
      },
    };
  }
  const changed = <K extends SessionDiffKey>(k: K): boolean =>
    JSON.stringify(previous[k]) !== JSON.stringify(next[k]);
  if (changed('history')) patch.history = next.history;
  if (changed('compactedSummary')) patch.compactedSummary = next.compactedSummary;
  if (changed('budget')) patch.budget = next.budget;
  if (changed('mcp')) patch.mcp = next.mcp;
  if (changed('compactions')) patch.compactions = next.compactions;
  if (changed('languagePreference')) patch.languagePreference = next.languagePreference;
  if (Object.keys(patch).length > 0) patch.updatedAt = next.updatedAt;
  return { sessionId: next.sessionId, userId: next.userId, patch };
}

export function isNoopPatch(payload: SessionUpsertPayload): boolean {
  const keys = Object.keys(payload.patch);
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'updatedAt');
}

// ────────────────────────────────────────────────────────────────────────────
// BudgetSession → SessionSnapshot 변환
// ────────────────────────────────────────────────────────────────────────────

export interface BuildSnapshotInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly budget: BudgetSession;
  readonly mcp?: SessionMcpSnapshot | null;
  readonly compactions?: number;
  readonly languagePreference?: SessionLanguagePreference | null;
  readonly now?: () => string;
}

export function buildSessionSnapshot(input: BuildSnapshotInput): SessionSnapshot {
  const nowIso = (input.now ?? (() => new Date().toISOString()))();
  const t = input.budget.totals;
  return {
    sessionId: input.sessionId,
    userId: input.userId,
    updatedAt: nowIso,
    history: input.budget.history,
    compactedSummary: input.budget.compactedSummary,
    languagePreference: input.languagePreference ?? null,
    budget: {
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens,
      callCount: t.callCount,
      estimatedCostUsd: t.estimatedCostUsd,
      updatedAt: t.updatedAt,
    },
    mcp: input.mcp ?? null,
    compactions: input.compactions ?? 0,
    schemaVersion: 1,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 저장 어댑터
// ────────────────────────────────────────────────────────────────────────────

export interface SessionStoreAdapter {
  get(userId: string, sessionId: string): Promise<SessionSnapshot | null>;
  upsert(payload: SessionUpsertPayload, fullSnapshot: SessionSnapshot): Promise<void>;
  remove(userId: string, sessionId: string): Promise<boolean>;
}

export function createInMemorySessionStore(): SessionStoreAdapter {
  const store = new Map<string, SessionSnapshot>();
  const key = (u: string, s: string) => `${u}:${s}`;
  return {
    async get(userId, sessionId) {
      return store.get(key(userId, sessionId)) ?? null;
    },
    async upsert(payload, fullSnapshot) {
      const existing = store.get(key(payload.userId, payload.sessionId)) ?? null;
      const merged: SessionSnapshot = existing
        ? {
            ...existing,
            ...payload.patch,
            // history 는 readonly 배열이라 타입 단순화를 위해 full 에서 가져온다.
            history: payload.patch.history ?? existing.history,
            budget: payload.patch.budget ?? existing.budget,
            mcp: 'mcp' in payload.patch ? payload.patch.mcp ?? null : existing.mcp,
            compactedSummary: payload.patch.compactedSummary ?? existing.compactedSummary,
            compactions: payload.patch.compactions ?? existing.compactions,
            languagePreference: 'languagePreference' in payload.patch
              ? payload.patch.languagePreference ?? null
              : existing.languagePreference,
            updatedAt: payload.patch.updatedAt ?? existing.updatedAt,
            schemaVersion: 1,
          }
        : fullSnapshot;
      store.set(key(payload.userId, payload.sessionId), merged);
    },
    async remove(userId, sessionId) {
      return store.delete(key(userId, sessionId));
    },
  };
}

export interface FileSessionStoreOptions {
  /** `fs.promises.readFile`/`writeFile` 의 최소 래퍼 — 테스트에서 가짜 IO 로 교체. */
  readonly readFile?: (path: string) => Promise<string>;
  readonly writeFile?: (path: string, data: string) => Promise<void>;
}

/**
 * 개발용 SQLite 대체 — 단일 JSON 파일에 `{ "userId:sessionId": SessionSnapshot }`
 * 모양으로 저장한다. Postgres 배포 환경에서는 `createInMemorySessionStore` 나
 * 별도 어댑터로 교체하고, 개발 로컬에서는 파일로 영속화한다.
 */
export function createFileSessionStore(
  path: string,
  options: FileSessionStoreOptions = {},
): SessionStoreAdapter {
  const readImpl = options.readFile;
  const writeImpl = options.writeFile;

  async function load(): Promise<Record<string, SessionSnapshot>> {
    const read = readImpl ?? (async (p) => {
      const fs = await import('node:fs/promises');
      try { return await fs.readFile(p, 'utf8'); } catch { return '{}'; }
    });
    const text = await read(path);
    if (!text || !text.trim()) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, SessionSnapshot>;
      }
      return {};
    } catch {
      return {};
    }
  }

  async function save(db: Record<string, SessionSnapshot>): Promise<void> {
    const write = writeImpl ?? (async (p, d) => {
      const fs = await import('node:fs/promises');
      await fs.writeFile(p, d, { encoding: 'utf8' });
    });
    await write(path, JSON.stringify(db, null, 2));
  }

  const key = (u: string, s: string) => `${u}:${s}`;

  return {
    async get(userId, sessionId) {
      const db = await load();
      return db[key(userId, sessionId)] ?? null;
    },
    async upsert(payload, fullSnapshot) {
      const db = await load();
      const k = key(payload.userId, payload.sessionId);
      const existing = db[k] ?? null;
      db[k] = existing
        ? {
            ...existing,
            ...payload.patch,
            history: payload.patch.history ?? existing.history,
            budget: payload.patch.budget ?? existing.budget,
            mcp: 'mcp' in payload.patch ? payload.patch.mcp ?? null : existing.mcp,
            compactedSummary: payload.patch.compactedSummary ?? existing.compactedSummary,
            compactions: payload.patch.compactions ?? existing.compactions,
            languagePreference: 'languagePreference' in payload.patch
              ? payload.patch.languagePreference ?? null
              : existing.languagePreference,
            updatedAt: payload.patch.updatedAt ?? existing.updatedAt,
            schemaVersion: 1,
          }
        : fullSnapshot;
      await save(db);
    },
    async remove(userId, sessionId) {
      const db = await load();
      const k = key(userId, sessionId);
      const had = k in db;
      if (had) { delete db[k]; await save(db); }
      return had;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 저장 트리거 이벤트 — recordUsage / compact / mcp transport 변경 세 지점만.
//
// 상위 호출자(에이전트 워커) 는 본 모듈의 `SessionPersistor` 를 하나 만들고,
// 각 이벤트 지점에서 해당 메서드를 호출한다. 내부에서 `shallowDiffSnapshot` 로
// no-op 을 걸러내고, 실제 어댑터 호출은 변경이 있을 때만 수행한다.
// ────────────────────────────────────────────────────────────────────────────

export interface SessionPersistor {
  onRecordUsage(budget: BudgetSession, mcp?: SessionMcpSnapshot | null): Promise<boolean>;
  onCompact(budget: BudgetSession, mcp?: SessionMcpSnapshot | null): Promise<boolean>;
  onMcpTransportChanged(budget: BudgetSession, mcp: SessionMcpSnapshot | null): Promise<boolean>;
  /** 언어 설정 변경 시 저장(서버 동기화). 지시 #8de1a1c8. */
  onLanguagePreferenceChanged(
    budget: BudgetSession,
    lang: SessionLanguagePreference | null,
    mcp?: SessionMcpSnapshot | null,
  ): Promise<boolean>;
  /** 마지막으로 저장된 스냅샷(복원 경로에서 사용). */
  peek(): SessionSnapshot | null;
}

export interface CreatePersistorInput {
  readonly adapter: SessionStoreAdapter;
  readonly sessionId: string;
  readonly userId: string;
  readonly now?: () => string;
}

export function createSessionPersistor(input: CreatePersistorInput): SessionPersistor {
  let previous: SessionSnapshot | null = null;
  let compactions = 0;
  let languagePreference: SessionLanguagePreference | null = null;

  async function write(
    reason: 'usage' | 'compact' | 'mcp' | 'language',
    budget: BudgetSession,
    mcp: SessionMcpSnapshot | null,
  ): Promise<boolean> {
    if (reason === 'compact') compactions += 1;
    const snapshot = buildSessionSnapshot({
      sessionId: input.sessionId,
      userId: input.userId,
      budget,
      mcp,
      compactions,
      languagePreference,
      now: input.now,
    });
    const payload = shallowDiffSnapshot(previous, snapshot);
    if (isNoopPatch(payload)) return false;
    await input.adapter.upsert(payload, snapshot);
    previous = snapshot;
    return true;
  }

  return {
    async onRecordUsage(budget, mcp) { return write('usage', budget, mcp ?? null); },
    async onCompact(budget, mcp) { return write('compact', budget, mcp ?? null); },
    async onMcpTransportChanged(budget, mcp) { return write('mcp', budget, mcp); },
    async onLanguagePreferenceChanged(budget, lang, mcp) {
      languagePreference = lang;
      return write('language', budget, mcp ?? null);
    },
    peek() { return previous; },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 복원 — GET /api/session/:id 응답을 `BudgetSession` 모양으로 되돌리는 헬퍼.
// 호출자(에이전트 워커) 가 이 결과로 새 세션을 시작하면 끊김 없이 이어서 진행된다.
// ────────────────────────────────────────────────────────────────────────────

import {
  createBudgetSession,
  applySoftDegrade,
  type ConversationTurn as _ConversationTurn,
} from '../llm/tokenBudget';

export function restoreBudgetSessionFromSnapshot(snapshot: SessionSnapshot): BudgetSession {
  const base = createBudgetSession(snapshot.sessionId);
  return {
    ...base,
    history: snapshot.history,
    compactedSummary: snapshot.compactedSummary,
    totals: {
      ...base.totals,
      inputTokens: snapshot.budget.inputTokens,
      outputTokens: snapshot.budget.outputTokens,
      cacheReadTokens: snapshot.budget.cacheReadTokens,
      cacheCreationTokens: snapshot.budget.cacheCreationTokens,
      callCount: snapshot.budget.callCount,
      estimatedCostUsd: snapshot.budget.estimatedCostUsd,
      updatedAt: snapshot.budget.updatedAt,
    },
    lastUsageAt: snapshot.budget.updatedAt,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 지시 #29d56176 — hard 단계 핸드오프
//
// 토큰 한도를 넘은 세션은 더 호출해도 경제적이지 않다. 그렇다고 사용자에게 "세션을
// 끝내세요" 라고 문을 닫아 버리는 것도 "끊김 없는 개발" 메타 목표와 어긋난다.
// 본 함수는 (a) 현재 세션의 요약을 한 덩어리로 만들고, (b) 새 세션 ID 로 스냅샷을
// 저장한 뒤, (c) 새 세션의 initialPrompt 를 돌려준다. 상위 UI 는 이 결과를 그대로
// "세션 이어서 새로 시작" 토스트에 연결하면 된다.
// ────────────────────────────────────────────────────────────────────────────

export interface HandoffInput {
  readonly previousSessionId: string;
  readonly userId: string;
  readonly budget: BudgetSession;
  readonly adapter: SessionStoreAdapter;
  /** 새 세션 ID. 미지정 시 `${prev}-next-<timestamp>`. */
  readonly newSessionId?: string;
  readonly mcp?: SessionMcpSnapshot | null;
  readonly now?: () => string;
  /** 추가 축약을 한 번 더 거칠지 여부. 기본 true. */
  readonly applyDegrade?: boolean;
}

export interface HandoffResult {
  readonly previousSessionId: string;
  readonly newSessionId: string;
  /** 새 세션의 system 영역에 붙일 인계(hand-off) 요약 블록. */
  readonly initialPrompt: string;
  /** 요약에 사용된 원본 기준 추정 토큰 수. */
  readonly sourceTokensEstimated: number;
  /** 새 세션에 적재된 추정 토큰 수(요약). */
  readonly carriedTokensEstimated: number;
  /** 저장된 새 세션 스냅샷. */
  readonly savedSnapshot: SessionSnapshot;
}

function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

function composeHandoffPrompt(
  previousSessionId: string,
  budget: BudgetSession,
): string {
  const lines: string[] = [];
  lines.push(`[이전 세션 인계 — ${previousSessionId}]`);
  lines.push(`· 누적 호출 ${budget.totals.callCount}회 · input ${budget.totals.inputTokens.toLocaleString()} · output ${budget.totals.outputTokens.toLocaleString()} · cacheRead ${budget.totals.cacheReadTokens.toLocaleString()}`);
  if (budget.compactedSummary && budget.compactedSummary.trim()) {
    lines.push('· 과거 요약:');
    lines.push(budget.compactedSummary);
  }
  if (budget.history.length > 0) {
    const lastUser = [...budget.history].reverse().find((t) => t.role === 'user');
    const lastAssistant = [...budget.history].reverse().find((t) => t.role === 'assistant');
    if (lastUser) lines.push(`· 마지막 질문: ${lastUser.content.slice(0, 200)}`);
    if (lastAssistant) lines.push(`· 마지막 답변 요지: ${lastAssistant.content.slice(0, 200)}`);
  }
  lines.push('[인계 끝 — 본 프롬프트 이후부터 새 세션이 시작됩니다.]');
  return lines.join('\n');
}

export async function handoffToNewSession(
  input: HandoffInput,
): Promise<HandoffResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const newSessionId = input.newSessionId ?? `${input.previousSessionId}-next-${Date.now().toString(36)}`;

  // (1) 원본 추정 토큰 — 압축 요약 + 히스토리 전량 문자수 기준.
  const sourceText = [
    input.budget.compactedSummary,
    ...input.budget.history.map((t) => t.content),
  ].filter(Boolean).join('\n');
  const sourceTokens = estimateTokensFromText(sourceText);

  // (2) 인계 프롬프트 조립 — 압축 + applySoftDegrade 로 한 번 더 줄이기.
  let initialPrompt = composeHandoffPrompt(input.previousSessionId, input.budget);
  if (input.applyDegrade !== false) {
    const shrunk = applySoftDegrade({ systemPrompt: initialPrompt });
    if (shrunk.systemPrompt && shrunk.systemPrompt.length < initialPrompt.length) {
      initialPrompt = shrunk.systemPrompt;
    }
  }
  const carriedTokens = estimateTokensFromText(initialPrompt);

  // (3) 새 세션 스냅샷 — 히스토리 비우고, compactedSummary 에 인계 요약만 남긴다.
  //     budget 총계는 0 으로 초기화(새 세션은 깨끗한 상태에서 시작).
  // 이전 세션의 languagePreference 를 adapter 에서 읽어 새 세션으로 승계. 사용자가
  // 세션 전환 시 언어가 리셋되지 않도록 한다(지시 #8de1a1c8 부팅 복원 대칭).
  const prevSnapshot = await input.adapter.get(input.userId, input.previousSessionId);
  const inheritedLang = prevSnapshot?.languagePreference ?? null;

  const snapshot: SessionSnapshot = {
    sessionId: newSessionId,
    userId: input.userId,
    updatedAt: now(),
    history: [],
    compactedSummary: initialPrompt,
    budget: {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      callCount: 0, estimatedCostUsd: 0,
      updatedAt: now(),
    },
    mcp: input.mcp ?? null,
    compactions: 0,
    languagePreference: inheritedLang,
    schemaVersion: 1,
  };

  await input.adapter.upsert(
    { sessionId: snapshot.sessionId, userId: snapshot.userId, patch: {
      history: snapshot.history, compactedSummary: snapshot.compactedSummary,
      budget: snapshot.budget, mcp: snapshot.mcp, compactions: snapshot.compactions,
      languagePreference: snapshot.languagePreference,
      updatedAt: snapshot.updatedAt,
    } },
    snapshot,
  );

  return {
    previousSessionId: input.previousSessionId,
    newSessionId,
    initialPrompt,
    sourceTokensEstimated: sourceTokens,
    carriedTokensEstimated: carriedTokens,
    savedSnapshot: snapshot,
  };
}
