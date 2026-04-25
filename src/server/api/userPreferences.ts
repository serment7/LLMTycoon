// 지시 #9c227466 · POST /api/user/preferences — 사용자 언어 선택을 서버에 upsert.
//
// 본 모듈은 서버 라우트 핸들러 팩토리만 제공한다. 실제 MongoDB 연결/라우트 등록은
// `server.ts` 에서 `attachUserPreferencesRoutes(app, { store })` 로 호출한다. 본 파일
// 자체에는 DB 직접 의존이 없어 노드 단위 테스트가 in-memory store 를 주입해 계약을
// 잠근다.
//
// 보안·세션 정책
//   · 로그인 세션이 없는 상태(익명) — 쓰기는 200 이지만 isAnonymous:true 로 응답하고,
//     서버 저장은 건너뛴다. 클라이언트는 로컬 스토리지('user_preferences.language') 에만
//     유지한다. 즉 "서버 동기화는 선택적 업그레이드, 기본 동작은 로컬 폴백".
//   · 세션 인식은 주입된 `resolveUser(req)` 훅이 담당. 미주입 시 항상 익명으로 취급.
//
// 입력 스키마
//   { "language": "en" | "ko" }
//
// 응답 스키마
//   { "ok": true, "language": "en" | "ko", "isAnonymous": boolean, "storedAt"?: string(ISO) }

import type { RecommendationLocale } from '../../project/recommendAgentTeam';

export type PreferenceLocale = RecommendationLocale;

export interface UserPreferenceRecord {
  readonly userId: string;
  readonly language: PreferenceLocale;
  readonly updatedAt: string; // ISO
}

/** 최소 저장소 인터페이스 — MongoDB · 테스트 in-memory 모두 충족 가능한 2 메서드. */
export interface UserPreferencesStore {
  readonly upsert: (record: UserPreferenceRecord) => Promise<void>;
  readonly get: (userId: string) => Promise<UserPreferenceRecord | null>;
}

/** 라우트 팩토리에 주입되는 설정. 세션 해결자 미주입 시 익명 경로 only. */
export interface UserPreferencesRouteDeps {
  readonly store: UserPreferencesStore;
  /** req 에서 사용자 id 를 추출. 미주입·null 반환 시 익명 처리. */
  readonly resolveUser?: (req: PreferencesRequest) => string | null;
  /** 현재 시각. 테스트 주입용. 기본 `new Date().toISOString()`. */
  readonly now?: () => string;
}

// ────────────────────────────────────────────────────────────────────────────
// 경량 Express-호환 타입 — express 의존을 피하려 본 모듈이 원하는 최소 표면만 선언.
// 실 라우트 등록부(server.ts) 가 Express Request/Response 를 그대로 넘겨도 호환된다.
// ────────────────────────────────────────────────────────────────────────────

export interface PreferencesRequest {
  readonly body?: unknown;
  readonly headers?: Record<string, string | string[] | undefined>;
}

export interface PreferencesResponse {
  status(code: number): PreferencesResponse;
  json(body: unknown): void;
}

export type PreferencesHandler = (req: PreferencesRequest, res: PreferencesResponse) => Promise<void>;

// ────────────────────────────────────────────────────────────────────────────
// 순수 검증기 — 라우트 밖에서도 재사용(클라이언트 fetch 래퍼가 동일 규칙 적용 가능).
// ────────────────────────────────────────────────────────────────────────────

export const SUPPORTED_PREFERENCE_LOCALES: readonly PreferenceLocale[] = ['en', 'ko'];

export function parsePreferencePayload(
  raw: unknown,
): { ok: true; language: PreferenceLocale } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'body-required' };
  }
  const language = (raw as { language?: unknown }).language;
  if (typeof language !== 'string') {
    return { ok: false, reason: 'language-required' };
  }
  if (!(SUPPORTED_PREFERENCE_LOCALES as readonly string[]).includes(language)) {
    return { ok: false, reason: 'unsupported-locale' };
  }
  return { ok: true, language: language as PreferenceLocale };
}

// ────────────────────────────────────────────────────────────────────────────
// 핸들러 팩토리
// ────────────────────────────────────────────────────────────────────────────

/** POST /api/user/preferences 핸들러 생성. */
export function createUpsertPreferenceHandler(
  deps: UserPreferencesRouteDeps,
): PreferencesHandler {
  const { store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  return async (req, res) => {
    const parsed = parsePreferencePayload(req.body);
    if (parsed.ok === false) {
      res.status(400).json({ ok: false, error: parsed.reason });
      return;
    }

    const userId = deps.resolveUser?.(req) ?? null;
    if (!userId) {
      // 익명 — 서버 저장은 건너뛰고 클라이언트 폴백 경로 안내만.
      res.status(200).json({
        ok: true,
        language: parsed.language,
        isAnonymous: true,
      });
      return;
    }

    const storedAt = now();
    await store.upsert({ userId, language: parsed.language, updatedAt: storedAt });
    res.status(200).json({
      ok: true,
      language: parsed.language,
      isAnonymous: false,
      storedAt,
    });
  };
}

/** GET /api/user/preferences 핸들러 — 로그인 세션에서만 서버 값 반환. */
export function createFetchPreferenceHandler(
  deps: UserPreferencesRouteDeps,
): PreferencesHandler {
  return async (req, res) => {
    const userId = deps.resolveUser?.(req) ?? null;
    if (!userId) {
      res.status(200).json({ ok: true, language: null, isAnonymous: true });
      return;
    }
    const record = await deps.store.get(userId);
    res.status(200).json({
      ok: true,
      language: record?.language ?? null,
      isAnonymous: false,
      storedAt: record?.updatedAt,
    });
  };
}

// 지시 #ba58ad2d · PATCH /api/users/me/language — 로그인 사용자 전용.
//
// 기존 POST /api/user/preferences 는 익명 fallback(isAnonymous:true) 까지 끌어안는
// "선택적 동기화" 시맨틱이지만, PATCH /me/language 는 RFC 7231 PATCH 의미상 인증된
// 사용자 자신의 리소스를 수정하는 경로다. 따라서 익명 호출은 401 로 단호하게 끊고,
// 200 응답은 갱신 결과를 그대로 돌려준다.
export function createUpdateLanguageHandler(
  deps: UserPreferencesRouteDeps,
): PreferencesHandler {
  const { store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  return async (req, res) => {
    const userId = deps.resolveUser?.(req) ?? null;
    if (!userId) {
      res.status(401).json({ ok: false, error: 'unauthenticated' });
      return;
    }
    const parsed = parsePreferencePayload(req.body);
    if (parsed.ok === false) {
      res.status(400).json({ ok: false, error: parsed.reason });
      return;
    }
    const storedAt = now();
    await store.upsert({ userId, language: parsed.language, updatedAt: storedAt });
    res.status(200).json({
      ok: true,
      language: parsed.language,
      storedAt,
    });
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 클라이언트 래퍼 — UI 가 설정 변경 시 호출. 실패 시 로컬 스토리지 폴백만 유지.
// ────────────────────────────────────────────────────────────────────────────

export interface SyncLanguagePreferenceOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

export async function syncLanguagePreference(
  language: PreferenceLocale,
  options: SyncLanguagePreferenceOptions = {},
): Promise<{ ok: boolean; isAnonymous?: boolean; error?: string }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, error: 'fetch-missing' };
  }
  try {
    const res = await fetchImpl(`${options.baseUrl ?? ''}/api/user/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language }),
    });
    if (!res.ok) {
      return { ok: false, error: `http-${res.status}` };
    }
    const body = (await res.json()) as { ok?: boolean; isAnonymous?: boolean };
    return { ok: Boolean(body?.ok), isAnonymous: body?.isAnonymous };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}

/**
 * 지시 #ba58ad2d · PATCH /api/users/me/language 클라이언트 헬퍼.
 *
 * LanguageToggle.onPersist 가 호출하는 진입점. 401(미인증) 은 "조용한 폴백" — 토글은
 * 이미 localStorage 에 저장됐으므로 로컬 동작은 유지하고, 호출자는 ok:false 만 받아
 * 토스트를 띄우거나 무시한다.
 */
export async function updateMyLanguagePreference(
  language: PreferenceLocale,
  options: SyncLanguagePreferenceOptions = {},
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, error: 'fetch-missing' };
  }
  try {
    const res = await fetchImpl(`${options.baseUrl ?? ''}/api/users/me/language`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ language }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `http-${res.status}` };
    }
    const body = (await res.json()) as { ok?: boolean };
    return { ok: Boolean(body?.ok), status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}
