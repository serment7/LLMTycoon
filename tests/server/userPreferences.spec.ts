// Run with: npx tsx --test tests/server/userPreferences.spec.ts
//
// 지시 #bd1eeb7d (QA · S3~S5) · POST /api/user/preferences 계약.
//
// Joker 가 준비 중인 서버 엔드포인트는 아직 server.ts 에 라우트가 없다. 본 스펙은
// 라우트 구현이 따라야 할 핸들러 계약을 **선(先)고정** 한다. 핸들러 인터페이스는
// express Req/Res 의존을 피해 단순한 `PreferencesRequest → PreferencesResponse`
// 순수 함수로 둔다(서버 라우트가 어댑터만 깔면 된다).
//
// 시나리오
//   S3. 로그인 세션 + 동일 키 upsert — 첫 요청은 insert, 이어지는 동일 키는 update.
//   S4. 세션 없음 — 204/로컬 폴백 신호로 응답해 클라이언트 localStorage 와 충돌 없음.
//   S5. 잘못된 language ('jp' 등) — 400 + i18n 키 기반 에러 메시지.

import test from 'node:test';
import assert from 'node:assert/strict';

import { translate, SUPPORTED_LOCALES } from '../../src/i18n/index.ts';

// ────────────────────────────────────────────────────────────────────────────
// 핸들러 계약 — 서버 라우트가 감쌀 순수 함수
// ────────────────────────────────────────────────────────────────────────────

export type PreferenceLanguage = 'en' | 'ko';

export interface PreferencesRequest {
  readonly sessionUserId: string | null; // null = 비로그인
  readonly body: { readonly language?: unknown };
}

export interface PreferencesResponse {
  readonly status: 200 | 201 | 204 | 400 | 401;
  readonly body?: {
    readonly language?: PreferenceLanguage;
    readonly upserted?: 'inserted' | 'updated';
    readonly fallback?: 'localStorage';
    readonly errorKey?: string;
    readonly error?: string;
  };
}

export interface PreferencesStore {
  upsert(userId: string, language: PreferenceLanguage): 'inserted' | 'updated';
  get(userId: string): PreferenceLanguage | null;
  size(): number;
}

export function createInMemoryPreferencesStore(): PreferencesStore {
  const data = new Map<string, PreferenceLanguage>();
  return {
    upsert(userId, language) {
      const existing = data.has(userId);
      data.set(userId, language);
      return existing ? 'updated' : 'inserted';
    },
    get(userId) {
      return data.get(userId) ?? null;
    },
    size() {
      return data.size;
    },
  };
}

/**
 * POST /api/user/preferences 핸들러. 서버 라우트는 이 함수를 감싸 req.session.userId
 * 와 req.body 를 주입하기만 하면 된다.
 */
export function handlePostUserPreferences(
  req: PreferencesRequest,
  store: PreferencesStore,
): PreferencesResponse {
  const raw = req.body?.language;
  if (typeof raw !== 'string' || !(SUPPORTED_LOCALES as readonly string[]).includes(raw)) {
    const errorKey = 'user.preferences.errors.invalidLanguage';
    return {
      status: 400,
      body: {
        errorKey,
        error: translate(errorKey, 'en'),
      },
    };
  }
  const language = raw as PreferenceLanguage;
  if (!req.sessionUserId) {
    // 비로그인 — 서버에 저장하지 않고 클라이언트 localStorage 폴백 신호만 돌려준다.
    return { status: 204, body: { fallback: 'localStorage', language } };
  }
  const upserted = store.upsert(req.sessionUserId, language);
  return {
    status: upserted === 'inserted' ? 201 : 200,
    body: { language, upserted },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// S3. 로그인 세션 + upsert
// ────────────────────────────────────────────────────────────────────────────

test('S3-1. 로그인 사용자 첫 요청 — 201 inserted · 저장소 크기 +1', () => {
  const store = createInMemoryPreferencesStore();
  const res = handlePostUserPreferences(
    { sessionUserId: 'u-1', body: { language: 'ko' } },
    store,
  );
  assert.equal(res.status, 201);
  assert.equal(res.body?.upserted, 'inserted');
  assert.equal(res.body?.language, 'ko');
  assert.equal(store.get('u-1'), 'ko');
  assert.equal(store.size(), 1);
});

test('S3-2. 동일 사용자 재요청 — 200 updated · 저장소 크기 유지 · 값만 갱신', () => {
  const store = createInMemoryPreferencesStore();
  handlePostUserPreferences({ sessionUserId: 'u-1', body: { language: 'ko' } }, store);
  const res = handlePostUserPreferences(
    { sessionUserId: 'u-1', body: { language: 'en' } },
    store,
  );
  assert.equal(res.status, 200);
  assert.equal(res.body?.upserted, 'updated');
  assert.equal(store.get('u-1'), 'en');
  assert.equal(store.size(), 1, '같은 유저 재요청은 새 레코드를 만들지 않는다');
});

test('S3-3. 다른 사용자 — 각각 독립 저장', () => {
  const store = createInMemoryPreferencesStore();
  handlePostUserPreferences({ sessionUserId: 'u-1', body: { language: 'ko' } }, store);
  handlePostUserPreferences({ sessionUserId: 'u-2', body: { language: 'en' } }, store);
  assert.equal(store.get('u-1'), 'ko');
  assert.equal(store.get('u-2'), 'en');
  assert.equal(store.size(), 2);
});

test('S3-4. 세 번째 재요청 — 같은 값이어도 updated 로 유지(idempotent upsert)', () => {
  const store = createInMemoryPreferencesStore();
  handlePostUserPreferences({ sessionUserId: 'u-1', body: { language: 'ko' } }, store);
  handlePostUserPreferences({ sessionUserId: 'u-1', body: { language: 'ko' } }, store);
  const res = handlePostUserPreferences(
    { sessionUserId: 'u-1', body: { language: 'ko' } },
    store,
  );
  assert.equal(res.status, 200);
  assert.equal(res.body?.upserted, 'updated');
});

// ────────────────────────────────────────────────────────────────────────────
// S4. 세션 없음 — 로컬 폴백 신호
// ────────────────────────────────────────────────────────────────────────────

test('S4-1. 비로그인 — 204 · fallback="localStorage" · 저장소 미변경', () => {
  const store = createInMemoryPreferencesStore();
  const res = handlePostUserPreferences(
    { sessionUserId: null, body: { language: 'ko' } },
    store,
  );
  assert.equal(res.status, 204);
  assert.equal(res.body?.fallback, 'localStorage');
  assert.equal(res.body?.language, 'ko');
  assert.equal(store.size(), 0, '서버에 저장되지 않아야 한다');
});

test('S4-2. 비로그인 → 로그인 전환 시 이전 비로그인 요청이 서버 상태에 잔류하지 않는다', () => {
  const store = createInMemoryPreferencesStore();
  handlePostUserPreferences({ sessionUserId: null, body: { language: 'ko' } }, store);
  const res = handlePostUserPreferences(
    { sessionUserId: 'u-1', body: { language: 'en' } },
    store,
  );
  assert.equal(res.status, 201, '로그인 후 첫 upsert 는 insert');
  assert.equal(res.body?.language, 'en');
  assert.equal(store.size(), 1);
});

test('S4-3. 비로그인 응답의 language 필드는 클라이언트가 localStorage 에 저장하기 위한 에코', () => {
  const store = createInMemoryPreferencesStore();
  const res = handlePostUserPreferences(
    { sessionUserId: null, body: { language: 'en' } },
    store,
  );
  assert.equal(res.body?.language, 'en');
  assert.equal(res.body?.fallback, 'localStorage');
});

// ────────────────────────────────────────────────────────────────────────────
// S5. 잘못된 language — 400 + i18n 키
// ────────────────────────────────────────────────────────────────────────────

test('S5-1. language="jp" — 400 · errorKey 경로 반환', () => {
  const store = createInMemoryPreferencesStore();
  const res = handlePostUserPreferences(
    { sessionUserId: 'u-1', body: { language: 'jp' } },
    store,
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.errorKey, 'user.preferences.errors.invalidLanguage');
  assert.equal(store.size(), 0, '잘못된 값은 저장되면 안 된다');
});

test('S5-2. language 결측 — 400', () => {
  const res = handlePostUserPreferences(
    { sessionUserId: 'u-1', body: {} },
    createInMemoryPreferencesStore(),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.errorKey, 'user.preferences.errors.invalidLanguage');
});

test('S5-3. language=숫자/객체 — 400', () => {
  const store = createInMemoryPreferencesStore();
  const a = handlePostUserPreferences(
    { sessionUserId: 'u-1', body: { language: 42 } },
    store,
  );
  const b = handlePostUserPreferences(
    { sessionUserId: 'u-1', body: { language: { ko: true } } },
    store,
  );
  assert.equal(a.status, 400);
  assert.equal(b.status, 400);
});

test('S5-4. errorKey 는 translate 에서 현재 키 원문 폴백(번역 미추가 상태 안전)', () => {
  const key = 'user.preferences.errors.invalidLanguage';
  // 아직 locales 에 본 키가 없으므로 key 자체를 반환(안전 상태).
  assert.equal(translate(key, 'en'), key);
});

test('S5-5. SUPPORTED_LOCALES 범위를 벗어난 모든 값은 400(화이트리스트)', () => {
  const store = createInMemoryPreferencesStore();
  for (const bad of ['jp', 'zh', 'fr', '', 'EN']) {
    const res = handlePostUserPreferences(
      { sessionUserId: 'u-1', body: { language: bad } },
      store,
    );
    assert.equal(res.status, 400, `${JSON.stringify(bad)} 는 거절되어야`);
  }
  assert.equal(store.size(), 0);
});
