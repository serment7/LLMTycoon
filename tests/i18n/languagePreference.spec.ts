// Run with: npx tsx --test tests/i18n/languagePreference.spec.ts
//
// 지시 #e72d7d21 (QA) · 언어 설정 회귀 확장.
//
// 기존 localeMode.spec.ts 가 detectLocale · getLocale · translate 순수 경로만 잠갔다면,
// 본 스펙은 "사용자 체감 시나리오" 3 축을 추가로 잠근다.
//   P1. 디폴트 영어 — 최초 접속 · storage/navigator 조합별 기본값 수렴.
//   P2. 세션별 저장 — 서버 세션 스냅샷(SessionSnapshot.languagePreference) 에 언어가
//       내려앉고, 세션 전환(핸드오프) 시 새 세션으로 승계된다.
//   P3. 로그인 간 유지 — UserPreferences(POST /api/user/preferences) 경로로 로그인
//       사용자의 언어가 서버에 upsert 되고, 재접속(다른 브라우저/세션) 시 서버 값이
//       우선 하이드레이션된다. 익명은 로컬 폴백.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  __resetLocaleForTests,
  detectLocale,
  persistLocale,
  setLocale,
  type LocaleStorage,
} from '../../src/i18n/index.ts';
import {
  createInMemorySessionStore,
  createSessionPersistor,
  handoffToNewSession,
  type SessionLanguagePreference,
} from '../../src/session/sessionStore.ts';
import { createBudgetSession } from '../../src/llm/tokenBudget.ts';
import {
  createFetchPreferenceHandler,
  createUpsertPreferenceHandler,
  parsePreferencePayload,
  type PreferencesRequest,
  type PreferencesResponse,
  type UserPreferenceRecord,
  type UserPreferencesStore,
} from '../../src/server/api/userPreferences.ts';

// ────────────────────────────────────────────────────────────────────────────
// 유틸 — 메모리 storage · 기록형 응답
// ────────────────────────────────────────────────────────────────────────────

function makeMemoryStorage(initial: Record<string, string> = {}): LocaleStorage & {
  readonly snapshot: () => Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    snapshot: () => Object.fromEntries(map.entries()),
  };
}

function makeInMemoryPrefsStore(): UserPreferencesStore & {
  readonly peek: (userId: string) => UserPreferenceRecord | null;
  readonly size: () => number;
} {
  const db = new Map<string, UserPreferenceRecord>();
  return {
    async upsert(record) { db.set(record.userId, record); },
    async get(userId) { return db.get(userId) ?? null; },
    peek(userId) { return db.get(userId) ?? null; },
    size() { return db.size; },
  };
}

function recordingResponse(): { res: PreferencesResponse; status: number; body: unknown } {
  const out: { res: PreferencesResponse; status: number; body: unknown } = {
    res: null as unknown as PreferencesResponse,
    status: 0,
    body: undefined,
  };
  const res: PreferencesResponse = {
    status(code) { out.status = code; return res; },
    json(body) { out.body = body; },
  };
  out.res = res;
  return out;
}

test.beforeEach(() => {
  __resetLocaleForTests(DEFAULT_LOCALE);
});

// ────────────────────────────────────────────────────────────────────────────
// P1. 디폴트 영어 — 최초 접속
// ────────────────────────────────────────────────────────────────────────────

test('P1-1. 최초 접속 — storage/navigator 모두 비어 있으면 en 으로 수렴', () => {
  assert.equal(detectLocale({ storage: makeMemoryStorage(), navigatorLanguage: null }), 'en');
  assert.equal(detectLocale({ storage: null, navigatorLanguage: null }), 'en');
});

test('P1-2. navigator.language 가 ko-KR 여도 storage 값(en)이 우선', () => {
  // 사용자가 의도적으로 영어를 골라둔 경우 — 브라우저 감지는 덮어쓰지 않는다.
  const storage = makeMemoryStorage({ [LOCALE_STORAGE_KEY]: 'en' });
  assert.equal(detectLocale({ storage, navigatorLanguage: 'ko-KR' }), 'en');
});

test('P1-3. storage 가 비어 있고 navigator 가 en-GB 면 기본 en', () => {
  assert.equal(detectLocale({ storage: makeMemoryStorage(), navigatorLanguage: 'en-GB' }), 'en');
});

test('P1-4. storage 에 알 수 없는 값("fr") 이 있으면 무시하고 navigator 폴백', () => {
  const storage = makeMemoryStorage({ [LOCALE_STORAGE_KEY]: 'fr' });
  assert.equal(detectLocale({ storage, navigatorLanguage: 'ko' }), 'ko');
  assert.equal(detectLocale({ storage, navigatorLanguage: 'en' }), 'en');
});

test('P1-5. getItem 이 예외를 던져도(Safari private mode) 조용히 다음 단계로 폴백', () => {
  const throwing: LocaleStorage = {
    getItem: () => { throw new Error('SecurityError: storage disabled'); },
    setItem: () => { /* noop */ },
    removeItem: () => { /* noop */ },
  };
  // navigator 가 ko 면 ko, 없으면 en 으로 폴백(검증 포인트: 예외가 밖으로 새지 않음).
  assert.equal(detectLocale({ storage: throwing, navigatorLanguage: 'ko' }), 'ko');
  assert.equal(detectLocale({ storage: throwing, navigatorLanguage: null }), DEFAULT_LOCALE);
});

// ────────────────────────────────────────────────────────────────────────────
// P2. 세션별 저장 — SessionSnapshot.languagePreference 경로
// ────────────────────────────────────────────────────────────────────────────

test('P2-1. Persistor.onLanguagePreferenceChanged — 스냅샷에 languagePreference 가 저장된다', async () => {
  const adapter = createInMemorySessionStore();
  const persistor = createSessionPersistor({
    adapter,
    sessionId: 's-P2-1',
    userId: 'U',
    now: () => '2026-04-21T00:00:00.000Z',
  });
  const budget = createBudgetSession('s-P2-1');
  const changed = await persistor.onLanguagePreferenceChanged(budget, 'ko');
  assert.equal(changed, true);
  const saved = await adapter.get('U', 's-P2-1');
  assert.ok(saved);
  assert.equal(saved!.languagePreference, 'ko');
});

test('P2-2. 동일 언어 재지정은 no-op — 쓰기 없음', async () => {
  const adapter = createInMemorySessionStore();
  const persistor = createSessionPersistor({
    adapter,
    sessionId: 's-P2-2',
    userId: 'U',
    now: () => '2026-04-21T00:00:00.000Z',
  });
  const budget = createBudgetSession('s-P2-2');
  assert.equal(await persistor.onLanguagePreferenceChanged(budget, 'ko'), true);
  assert.equal(await persistor.onLanguagePreferenceChanged(budget, 'ko'), false);
});

test('P2-3. 세션 간 격리 — 서로 다른 sessionId 의 언어는 독립 저장', async () => {
  const adapter = createInMemorySessionStore();
  const pA = createSessionPersistor({ adapter, sessionId: 'sA', userId: 'U' });
  const pB = createSessionPersistor({ adapter, sessionId: 'sB', userId: 'U' });
  await pA.onLanguagePreferenceChanged(createBudgetSession('sA'), 'ko');
  await pB.onLanguagePreferenceChanged(createBudgetSession('sB'), 'en');
  const a = await adapter.get('U', 'sA');
  const b = await adapter.get('U', 'sB');
  assert.equal(a!.languagePreference, 'ko');
  assert.equal(b!.languagePreference, 'en');
});

test('P2-4. handoffToNewSession — 이전 세션의 언어가 새 세션으로 승계된다', async () => {
  const adapter = createInMemorySessionStore();
  // 이전 세션에 ko 를 저장.
  const prev = createSessionPersistor({ adapter, sessionId: 'old', userId: 'U' });
  await prev.onLanguagePreferenceChanged(createBudgetSession('old'), 'ko');

  const handoff = await handoffToNewSession({
    previousSessionId: 'old',
    userId: 'U',
    budget: createBudgetSession('old'),
    adapter,
    now: () => '2026-04-21T12:00:00.000Z',
  });
  const saved = await adapter.get('U', handoff.newSessionId);
  assert.ok(saved);
  assert.equal(saved!.languagePreference, 'ko', '세션 전환 시 언어가 리셋되면 안 된다');
});

test('P2-5. 이전 세션이 언어 미지정(null) 이면 새 세션도 null — 브라우저 감지 경로 유지', async () => {
  const adapter = createInMemorySessionStore();
  const prev = createSessionPersistor({ adapter, sessionId: 'old-null', userId: 'U' });
  // 언어 설정 없이 일반 기록만.
  await prev.onRecordUsage(createBudgetSession('old-null'));
  const handoff = await handoffToNewSession({
    previousSessionId: 'old-null',
    userId: 'U',
    budget: createBudgetSession('old-null'),
    adapter,
  });
  const saved = await adapter.get('U', handoff.newSessionId);
  assert.equal(saved!.languagePreference, null);
});

// ────────────────────────────────────────────────────────────────────────────
// P3. 로그인 간 유지 — UserPreferences POST/GET
// ────────────────────────────────────────────────────────────────────────────

test('P3-1. parsePreferencePayload — 허용값/거절값 경계', () => {
  assert.equal(parsePreferencePayload({ language: 'ko' }).ok, true);
  assert.equal(parsePreferencePayload({ language: 'en' }).ok, true);
  assert.equal(parsePreferencePayload({ language: 'fr' }).ok, false);
  assert.equal(parsePreferencePayload({}).ok, false);
  assert.equal(parsePreferencePayload(null).ok, false);
});

test('P3-2. 로그인 사용자 — POST 는 서버 저장 · GET 은 저장값 반환', async () => {
  const store = makeInMemoryPrefsStore();
  let clock = 0;
  const resolveUser = () => 'user-7';
  const now = () => new Date(1_700_000_000_000 + (clock++) * 1000).toISOString();
  const upsertHandler = createUpsertPreferenceHandler({ store, resolveUser, now });
  const fetchHandler = createFetchPreferenceHandler({ store, resolveUser, now });

  const post = recordingResponse();
  await upsertHandler({ body: { language: 'ko' } } as PreferencesRequest, post.res);
  assert.equal(post.status, 200);
  const postBody = post.body as { ok: true; language: string; isAnonymous: boolean; storedAt?: string };
  assert.equal(postBody.ok, true);
  assert.equal(postBody.language, 'ko');
  assert.equal(postBody.isAnonymous, false);
  assert.ok(typeof postBody.storedAt === 'string');

  const get = recordingResponse();
  await fetchHandler({} as PreferencesRequest, get.res);
  assert.equal(get.status, 200);
  const getBody = get.body as { language: string | null; isAnonymous: boolean };
  assert.equal(getBody.language, 'ko');
  assert.equal(getBody.isAnonymous, false);
  assert.equal(store.peek('user-7')!.language, 'ko');
});

test('P3-3. 익명 사용자 — POST 는 200+isAnonymous:true · 서버 저장 건너뜀(클라 폴백)', async () => {
  const store = makeInMemoryPrefsStore();
  const handler = createUpsertPreferenceHandler({ store, resolveUser: () => null });
  const rec = recordingResponse();
  await handler({ body: { language: 'en' } } as PreferencesRequest, rec.res);
  assert.equal(rec.status, 200);
  const body = rec.body as { ok: true; language: string; isAnonymous: boolean; storedAt?: string };
  assert.equal(body.isAnonymous, true);
  assert.equal(body.language, 'en');
  assert.equal(body.storedAt, undefined, '익명은 서버 저장 안 함 — storedAt 없음');
  assert.equal(store.size(), 0);
});

test('P3-4. 로그인 간 유지 — 다른 세션(=다른 storage)에서 접속해도 서버 값으로 하이드레이션', async () => {
  const store = makeInMemoryPrefsStore();
  const resolveUser = () => 'user-42';
  const post = createUpsertPreferenceHandler({ store, resolveUser });
  const get = createFetchPreferenceHandler({ store, resolveUser });

  // (a) 로그인 #1 브라우저 — 서버에 ko 저장 + 로컬 스토리지에도 ko.
  const localA = makeMemoryStorage();
  setLocale('ko', localA);
  const p1 = recordingResponse();
  await post({ body: { language: 'ko' } } as PreferencesRequest, p1.res);
  assert.equal((p1.body as { language: string }).language, 'ko');

  // (b) 로그인 #2 — 완전히 새 브라우저(빈 localStorage)에서 재접속.
  // storage 는 비어있지만 서버 GET 에서 ko 가 돌아와 UI 는 이 값으로 부팅.
  const localB = makeMemoryStorage();
  __resetLocaleForTests(DEFAULT_LOCALE);
  assert.equal(detectLocale({ storage: localB, navigatorLanguage: 'en-US' }), 'en', '서버 동기화 전에는 브라우저 감지가 en');
  const g1 = recordingResponse();
  await get({} as PreferencesRequest, g1.res);
  const serverLang = (g1.body as { language: SessionLanguagePreference | null }).language;
  assert.equal(serverLang, 'ko');
  // UI 부팅 시 서버 값으로 세팅하면 localStorage 에도 동기화.
  if (serverLang) persistLocale(serverLang, localB);
  assert.equal(localB.snapshot()[LOCALE_STORAGE_KEY], 'ko', '서버 값이 로컬 스토리지에도 기록');
});

test('P3-5. 잘못된 body 는 400 · 빈 body 도 거절', async () => {
  const store = makeInMemoryPrefsStore();
  const handler = createUpsertPreferenceHandler({ store, resolveUser: () => 'user-x' });
  const r1 = recordingResponse();
  await handler({ body: { language: 'fr' } } as PreferencesRequest, r1.res);
  assert.equal(r1.status, 400);
  const r2 = recordingResponse();
  await handler({ body: undefined } as PreferencesRequest, r2.res);
  assert.equal(r2.status, 400);
  assert.equal(store.size(), 0, '잘못된 입력으로 인한 저장은 없어야');
});
