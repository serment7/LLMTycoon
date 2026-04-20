// 지시 #dcaee6a9 — 세션 복원 REST API.
//
// 엔드포인트
//   GET  /api/session/:id       — 현재 사용자의 세션 스냅샷. 없으면 404.
//   PUT  /api/session/:id       — 클라이언트가 요약 본문을 서버에 밀어 넣을 때(관리·
//                                  마이그레이션 용). 에이전트 런타임은 서버 내부에서
//                                  `SessionPersistor` 를 쓰므로 보통 이 경로는 쓰지 않는다.
//   DELETE /api/session/:id     — 세션 파기(로그아웃·사용자 요청).
//
// 스타일은 `src/server/api/mcpConnections.ts` 와 정렬. zod 검증 · resolveUser 훅 ·
// 얇은 Handler 계약 유지.

import { z } from 'zod';
import type {
  SessionSnapshot,
  SessionStoreAdapter,
} from '../../session/sessionStore';

// ────────────────────────────────────────────────────────────────────────────
// 요청/응답 스키마
// ────────────────────────────────────────────────────────────────────────────

export const SessionIdParamSchema = z.object({
  id: z.string().min(1).max(128),
});

const McpSnapshotSchema = z.object({
  transport: z.enum(['stdio', 'http', 'streamable-http']),
  url: z.string().max(2048).optional(),
  name: z.string().max(128).optional(),
}).nullable();

const BudgetSnapshotSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheCreationTokens: z.number().nonnegative(),
  callCount: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  updatedAt: z.string().min(1),
});

const ConversationTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  tokens: z.number().int().nonnegative(),
});

export const SessionSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  updatedAt: z.string().min(1),
  history: z.array(ConversationTurnSchema),
  compactedSummary: z.string(),
  budget: BudgetSnapshotSchema,
  mcp: McpSnapshotSchema,
  compactions: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
});

export interface SessionApiDeps {
  readonly adapter: SessionStoreAdapter;
  readonly resolveUser: (req: HandlerRequest) => string | null;
}

export interface HandlerRequest {
  readonly body?: unknown;
  readonly params?: Record<string, string>;
  readonly headers?: Record<string, string | string[] | undefined>;
}

export interface HandlerResponse {
  status(code: number): HandlerResponse;
  json(body: unknown): void;
}

export type Handler = (req: HandlerRequest, res: HandlerResponse) => Promise<void>;

function json400(res: HandlerResponse, reason: string, details?: unknown): void {
  res.status(400).json({ ok: false, error: reason, details });
}
function json401(res: HandlerResponse): void {
  res.status(401).json({ ok: false, error: 'unauthenticated' });
}
function json404(res: HandlerResponse): void {
  res.status(404).json({ ok: false, error: 'not-found' });
}
function json403(res: HandlerResponse): void {
  res.status(403).json({ ok: false, error: 'forbidden' });
}

// ────────────────────────────────────────────────────────────────────────────
// 핸들러
// ────────────────────────────────────────────────────────────────────────────

export function createGetSessionHandler(deps: SessionApiDeps): Handler {
  return async (req, res) => {
    const userId = deps.resolveUser(req);
    if (!userId) return json401(res);
    const parsed = SessionIdParamSchema.safeParse(req.params);
    if (!parsed.success) return json400(res, 'invalid-id');
    const snapshot = await deps.adapter.get(userId, parsed.data.id);
    if (!snapshot) return json404(res);
    res.status(200).json({ ok: true, session: snapshot });
  };
}

export function createPutSessionHandler(deps: SessionApiDeps): Handler {
  return async (req, res) => {
    const userId = deps.resolveUser(req);
    if (!userId) return json401(res);
    const idParsed = SessionIdParamSchema.safeParse(req.params);
    if (!idParsed.success) return json400(res, 'invalid-id');
    const bodyParsed = SessionSnapshotSchema.safeParse(req.body);
    if (!bodyParsed.success) return json400(res, 'invalid-body', bodyParsed.error.issues);
    if (bodyParsed.data.sessionId !== idParsed.data.id) return json400(res, 'id-mismatch');
    if (bodyParsed.data.userId !== userId) return json403(res);
    // PUT 은 전체 덮어쓰기 — 얕은 diff 는 상위(에이전트 워커) SessionPersistor 가 담당.
    // zod 검증 결과는 `SessionSnapshot` 과 구조가 같지만 optional 키의 `| undefined` 때문에
    // 구조적 서브타입 단언이 필요하다.
    const full = bodyParsed.data as SessionSnapshot;
    await deps.adapter.upsert(
      { sessionId: full.sessionId, userId: full.userId, patch: {
        history: full.history, compactedSummary: full.compactedSummary, budget: full.budget,
        mcp: full.mcp, compactions: full.compactions, updatedAt: full.updatedAt,
      } },
      full,
    );
    res.status(200).json({ ok: true, session: full });
  };
}

export function createDeleteSessionHandler(deps: SessionApiDeps): Handler {
  return async (req, res) => {
    const userId = deps.resolveUser(req);
    if (!userId) return json401(res);
    const parsed = SessionIdParamSchema.safeParse(req.params);
    if (!parsed.success) return json400(res, 'invalid-id');
    const ok = await deps.adapter.remove(userId, parsed.data.id);
    if (!ok) return json404(res);
    res.status(200).json({ ok: true });
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 클라이언트 래퍼 — UI 가 복원/삭제를 간단히 호출.
// ────────────────────────────────────────────────────────────────────────────

export interface SessionClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

export interface SessionClient {
  get(id: string): Promise<SessionSnapshot | null>;
  put(snapshot: SessionSnapshot): Promise<SessionSnapshot>;
  remove(id: string): Promise<void>;
}

export function createSessionClient(options: SessionClientOptions = {}): SessionClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is missing');
  const base = `${options.baseUrl ?? ''}/api/session`;

  async function req<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (res.status === 404) return null as unknown as T;
    if (!res.ok) throw new Error(`http-${res.status}`);
    return (await res.json()) as T;
  }

  return {
    async get(id) {
      const body = await req<{ ok: true; session: SessionSnapshot } | null>(`${base}/${encodeURIComponent(id)}`);
      return body?.session ?? null;
    },
    async put(snapshot) {
      const body = await req<{ ok: true; session: SessionSnapshot }>(`${base}/${encodeURIComponent(snapshot.sessionId)}`, {
        method: 'PUT',
        body: JSON.stringify(snapshot),
      });
      return body.session;
    },
    async remove(id) {
      await req<{ ok: true }>(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}
