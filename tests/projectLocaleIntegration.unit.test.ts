// Run with: npx tsx --test tests/projectLocaleIntegration.unit.test.ts
//
// 지시 #9c227466 — i18n × 추천 × 사용자 설정 교차 통합 계약.
//
// 축:
//   P. 프롬프트/휴리스틱 locale 반영 — en/ko 각각 다른 시스템 프롬프트 + rationale 카피.
//   T. translateRecommendations — invoker 없이 휴리스틱 번역, invoker 유효/깨짐/동일 locale 경로.
//   S. userPreferences 서버 핸들러 — 익명/로그인 세션, upsert 저장소 호출, 스키마 오류 400.
//   W. syncLanguagePreference — fetch 래퍼 성공/실패/익명 플래그 반영.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RECOMMENDATION_LOCALE,
  SYSTEM_PROMPTS,
  buildRecommendationMessages,
  buildTranslationMessages,
  heuristicTeam,
  recommendAgentTeam,
  translateRecommendations,
  type AgentTeamRecommendation,
} from '../src/project/recommendAgentTeam.ts';
import {
  createFetchPreferenceHandler,
  createUpsertPreferenceHandler,
  parsePreferencePayload,
  syncLanguagePreference,
  type UserPreferencesStore,
  type UserPreferenceRecord,
  type PreferencesRequest,
  type PreferencesResponse,
} from '../src/server/api/userPreferences.ts';

// ─── P: locale 프롬프트 / 휴리스틱 ─────────────────────────────────────────

test('P1. 기본 locale 은 en 이며 시스템 프롬프트가 영어', () => {
  assert.equal(DEFAULT_RECOMMENDATION_LOCALE, 'en');
  const msg = buildRecommendationMessages('scope');
  assert.ok(msg.system[0].text.includes('HR/staffing lead'));
});

test('P2. locale=ko 는 한국어 프롬프트 + userPrefix', () => {
  const msg = buildRecommendationMessages('범위', 'ko');
  assert.equal(msg.system[0].text, SYSTEM_PROMPTS.ko.policy);
  assert.ok(msg.messages[0].content[0].text.startsWith('프로젝트 설명:'));
});

test('P3. heuristicTeam — en 카피와 ko 카피가 서로 다르다', () => {
  const en = heuristicTeam('간단한 유틸', 'en');
  const ko = heuristicTeam('간단한 유틸', 'ko');
  assert.notEqual(en[0].rationale, ko[0].rationale);
  assert.ok(ko[0].rationale.includes('범위'));
  assert.ok(en[0].rationale.toLowerCase().includes('scope') || en[0].rationale.toLowerCase().includes('break'));
});

test('P4. recommendAgentTeam — 결과에 locale 필드가 함께 실린다', async () => {
  const en = await recommendAgentTeam('scope', { locale: 'en' });
  const ko = await recommendAgentTeam('scope', { locale: 'ko' });
  assert.equal(en.locale, 'en');
  assert.equal(ko.locale, 'ko');
  assert.equal(en.source, 'heuristic');
});

// ─── T: translateRecommendations ──────────────────────────────────────────

function sampleTeam(locale: 'en' | 'ko'): AgentTeamRecommendation {
  return {
    items: heuristicTeam('scope', locale),
    source: 'heuristic',
    locale,
  };
}

test('T1. 동일 locale 로 번역 요청 — 그대로 반환(네트워크 호출 없음)', async () => {
  const src = sampleTeam('en');
  let called = 0;
  const out = await translateRecommendations(src, 'en', {
    invoker: async () => {
      called += 1;
      return '{}';
    },
  });
  assert.equal(called, 0);
  assert.equal(out, src);
});

test('T2. invoker 미주입 — 휴리스틱 번역표 폴백', async () => {
  const src = sampleTeam('en');
  const out = await translateRecommendations(src, 'ko');
  assert.equal(out.locale, 'ko');
  assert.equal(out.source, 'heuristic');
  assert.equal(out.items.length, src.items.length);
  assert.ok(out.items[0].rationale.includes('범위'));
});

test('T3. invoker 정상 + 동수 유지 — source=translated, role 은 원본 보존', async () => {
  const src: AgentTeamRecommendation = {
    items: [
      { role: 'Leader', name: 'Kai', rationale: 'old' },
      { role: 'Developer', name: 'Dev', rationale: 'old2' },
    ],
    source: 'claude',
    locale: 'en',
  };
  const out = await translateRecommendations(src, 'ko', {
    invoker: async () =>
      JSON.stringify({
        items: [
          { role: 'Leader', name: '카이', rationale: '분배' },
          { role: 'Developer', name: '개발', rationale: '구현' },
        ],
      }),
  });
  assert.equal(out.source, 'translated');
  assert.equal(out.locale, 'ko');
  assert.deepEqual(out.items.map((r) => r.role), ['Leader', 'Developer']);
  assert.deepEqual(out.items.map((r) => r.name), ['카이', '개발']);
});

test('T4. invoker 결과 개수가 원본과 다르면 휴리스틱 폴백', async () => {
  const src = sampleTeam('en');
  const out = await translateRecommendations(src, 'ko', {
    invoker: async () =>
      JSON.stringify({ items: [{ role: 'Leader', name: 'K', rationale: '부족' }] }),
  });
  assert.equal(out.source, 'heuristic');
  assert.equal(out.items.length, src.items.length);
});

test('T5. translateOnly 시스템 프롬프트는 description 을 포함하지 않아 경량', () => {
  const src = sampleTeam('en');
  const msg = buildTranslationMessages(src, 'ko');
  assert.ok(msg.system[0].text.includes('translate short role'));
  assert.ok(!msg.system[0].text.includes('HR/staffing lead'), '메인 정책 프리픽스와 별도 캐시 프리픽스');
  assert.ok(msg.messages[0].content[0].text.includes('Target locale: ko'));
});

// ─── S: userPreferences 서버 핸들러 ───────────────────────────────────────

test('S1. parsePreferencePayload — 빈 바디·잘못된 값은 거절', () => {
  assert.equal(parsePreferencePayload(null).ok, false);
  assert.equal(parsePreferencePayload({}).ok, false);
  assert.equal(parsePreferencePayload({ language: 123 }).ok, false);
  assert.equal(parsePreferencePayload({ language: 'fr' }).ok, false);
  const valid = parsePreferencePayload({ language: 'ko' });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.language, 'ko');
});

function createMemStore(): UserPreferencesStore & {
  readonly dump: () => Record<string, UserPreferenceRecord>;
} {
  const map = new Map<string, UserPreferenceRecord>();
  return {
    upsert: async (record) => {
      map.set(record.userId, record);
    },
    get: async (userId) => map.get(userId) ?? null,
    dump: () => Object.fromEntries(map),
  };
}

function recordingResponse(): { res: PreferencesResponse; status: number; body: unknown } {
  const result: { res: PreferencesResponse; status: number; body: unknown } = {
    res: null as unknown as PreferencesResponse,
    status: 0,
    body: undefined,
  };
  const res: PreferencesResponse = {
    status(code) {
      result.status = code;
      return res;
    },
    json(body) {
      result.body = body;
    },
  };
  result.res = res;
  return result;
}

test('S2. upsert 핸들러 — 익명 세션은 서버 저장 없이 200 + isAnonymous=true', async () => {
  const store = createMemStore();
  const handler = createUpsertPreferenceHandler({ store });
  const r = recordingResponse();
  await handler({ body: { language: 'ko' } } as PreferencesRequest, r.res);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, language: 'ko', isAnonymous: true });
  assert.equal(Object.keys(store.dump()).length, 0, '저장소는 비어 있어야 한다');
});

test('S3. upsert 핸들러 — 로그인 세션은 store.upsert 호출 + storedAt 반영', async () => {
  const store = createMemStore();
  const handler = createUpsertPreferenceHandler({
    store,
    resolveUser: () => 'user-42',
    now: () => '2026-04-21T00:00:00.000Z',
  });
  const r = recordingResponse();
  await handler({ body: { language: 'en' } } as PreferencesRequest, r.res);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    ok: true,
    language: 'en',
    isAnonymous: false,
    storedAt: '2026-04-21T00:00:00.000Z',
  });
  const stored = store.dump()['user-42'];
  assert.ok(stored);
  assert.equal(stored.language, 'en');
});

test('S4. upsert 핸들러 — 스키마 실패는 400', async () => {
  const handler = createUpsertPreferenceHandler({ store: createMemStore() });
  const r = recordingResponse();
  await handler({ body: { language: 'fr' } } as PreferencesRequest, r.res);
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { ok: false, error: 'unsupported-locale' });
});

test('S5. fetch 핸들러 — 로그인 세션은 저장된 language 반환, 익명은 null', async () => {
  const store = createMemStore();
  await store.upsert({ userId: 'u1', language: 'ko', updatedAt: 't0' });

  const anonHandler = createFetchPreferenceHandler({ store });
  const r1 = recordingResponse();
  await anonHandler({} as PreferencesRequest, r1.res);
  assert.deepEqual(r1.body, { ok: true, language: null, isAnonymous: true });

  const authHandler = createFetchPreferenceHandler({ store, resolveUser: () => 'u1' });
  const r2 = recordingResponse();
  await authHandler({} as PreferencesRequest, r2.res);
  assert.deepEqual(r2.body, { ok: true, language: 'ko', isAnonymous: false, storedAt: 't0' });
});

// ─── W: syncLanguagePreference 클라이언트 래퍼 ───────────────────────────

test('W1. syncLanguagePreference — 200 응답은 ok:true + isAnonymous 전달', async () => {
  const fetchStub: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, isAnonymous: true }), { status: 200 });
  const res = await syncLanguagePreference('ko', { fetch: fetchStub });
  assert.deepEqual(res, { ok: true, isAnonymous: true });
});

test('W2. syncLanguagePreference — 네트워크 에러 시 ok:false + 로컬 폴백 유지', async () => {
  const fetchStub: typeof globalThis.fetch = async () => {
    throw new Error('network');
  };
  const res = await syncLanguagePreference('en', { fetch: fetchStub });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /network/);
});

test('W3. syncLanguagePreference — 비 200 응답은 ok:false + http-{status}', async () => {
  const fetchStub: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false }), { status: 500 });
  const res = await syncLanguagePreference('en', { fetch: fetchStub });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'http-500');
});
