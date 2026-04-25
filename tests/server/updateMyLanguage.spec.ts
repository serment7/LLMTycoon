// Run with: npx tsx --test tests/server/updateMyLanguage.spec.ts
//
// 지시 #ba58ad2d · PATCH /api/users/me/language 핸들러 계약.
//
// 본 스펙은 createUpdateLanguageHandler 의 다음 4가지 시맨틱을 잠근다.
//   M1. 인증된 사용자 + 정상 페이로드 → 200 · upsert 호출.
//   M2. 익명(resolveUser → null) → 401 · 저장 호출 없음.
//   M3. 잘못된 언어 → 400 · 저장 호출 없음.
//   M4. 동일 사용자가 두 번 PATCH 하면 두 번째 값으로 덮어쓰기.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createUpdateLanguageHandler,
  type PreferencesRequest,
  type PreferencesResponse,
  type UserPreferenceRecord,
  type UserPreferencesStore,
} from '../../src/server/api/userPreferences.ts';

function makeStore(): UserPreferencesStore & { readonly peek: (id: string) => UserPreferenceRecord | null; readonly upsertCount: () => number } {
  const db = new Map<string, UserPreferenceRecord>();
  let upserts = 0;
  return {
    async upsert(record) { upserts += 1; db.set(record.userId, record); },
    async get(userId) { return db.get(userId) ?? null; },
    peek(userId) { return db.get(userId) ?? null; },
    upsertCount() { return upserts; },
  };
}

function recording(): { res: PreferencesResponse; status: number; body: unknown } {
  const out = { res: null as unknown as PreferencesResponse, status: 0, body: undefined as unknown };
  const res: PreferencesResponse = {
    status(code) { out.status = code; return res; },
    json(body) { out.body = body; },
  };
  out.res = res;
  return out;
}

test('M1. 인증 사용자 + 정상 ko → 200 + storedAt', async () => {
  const store = makeStore();
  const handler = createUpdateLanguageHandler({ store, resolveUser: () => 'u-1', now: () => '2026-04-25T00:00:00.000Z' });
  const rec = recording();
  await handler({ body: { language: 'ko' } } as PreferencesRequest, rec.res);
  assert.equal(rec.status, 200);
  const body = rec.body as { ok: boolean; language: string; storedAt: string };
  assert.equal(body.ok, true);
  assert.equal(body.language, 'ko');
  assert.equal(body.storedAt, '2026-04-25T00:00:00.000Z');
  assert.equal(store.peek('u-1')!.language, 'ko');
});

test('M2. 익명(resolveUser→null) → 401 + 저장 없음', async () => {
  const store = makeStore();
  const handler = createUpdateLanguageHandler({ store, resolveUser: () => null });
  const rec = recording();
  await handler({ body: { language: 'en' } } as PreferencesRequest, rec.res);
  assert.equal(rec.status, 401);
  assert.equal(store.upsertCount(), 0);
});

test('M3. 잘못된 언어("fr") → 400 + 저장 없음', async () => {
  const store = makeStore();
  const handler = createUpdateLanguageHandler({ store, resolveUser: () => 'u-1' });
  const rec = recording();
  await handler({ body: { language: 'fr' } } as PreferencesRequest, rec.res);
  assert.equal(rec.status, 400);
  assert.equal(store.upsertCount(), 0);
});

test('M4. 동일 사용자 두 번 PATCH → 두 번째 값으로 덮어쓰기', async () => {
  const store = makeStore();
  const handler = createUpdateLanguageHandler({ store, resolveUser: () => 'u-1' });
  await handler({ body: { language: 'ko' } } as PreferencesRequest, recording().res);
  await handler({ body: { language: 'en' } } as PreferencesRequest, recording().res);
  assert.equal(store.peek('u-1')!.language, 'en');
  assert.equal(store.upsertCount(), 2);
});
