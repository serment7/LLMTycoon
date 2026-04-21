// Run with: npx tsx --test tests/i18n/languageToggleFlow.spec.ts
//
// 지시 #3c77f2ed (QA) · 언어 토글 사용자 여정 회귀.
//
// 기존 `languageToggle.regression.test.tsx` 가 React + jsdom 렌더링 경로를 잠갔다면,
// 본 스펙은 사용자 시나리오(EN↔KO 전환 · 새로고침 후 복원 · 세션 전환 시 유지) 를
// 순수 로직 레이어에서 한 파일에 엮는다. 실제 화면 요소는 translate() 결과 문자열로
// 대체해 "모든 화면 텍스트가 함께 갈린다" 는 계약을 표 형태로 고정한다.
//
// 시나리오
//   F1. EN → KO 전환 — 헤더·공통 버튼·멀티미디어 허브·오류 메시지 등 주요 화면
//       텍스트가 일제히 한국어로 갈린다.
//   F2. KO → EN 복귀 — 같은 키들이 전부 영어로 되돌아온다.
//   F3. 새로고침 시뮬레이션 — setLocale 후 모듈 상태를 초기화하고 storage 만 남긴
//       상태에서 detectLocale 이 저장값을 복원한다.
//   F4. 세션 전환 시 유지 — 한도 초과로 handoff 되어도 새 세션 스냅샷에 언어가 승계.
//   F5. 엣지 — 지원하지 않는 locale 은 setLocale 에서 예외, storage 없을 때 크래시 X.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  __resetLocaleForTests,
  detectLocale,
  getLocale,
  setLocale,
  translate,
  type Locale,
  type LocaleStorage,
} from '../../src/i18n/index.ts';
import {
  createInMemorySessionStore,
  createSessionPersistor,
  handoffToNewSession,
} from '../../src/session/sessionStore.ts';
import { createBudgetSession } from '../../src/llm/tokenBudget.ts';

// ────────────────────────────────────────────────────────────────────────────
// 유틸 — 메모리 스토리지 · 화면 텍스트 표
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

/** 화면 4축 — 헤더 타이틀 · 공통 저장/취소 · 멀티미디어 허브 · 권한 오류 문구. */
const SCREEN_KEYS = [
  'app.title',
  'common.save',
  'common.cancel',
  'multimedia.hub.title',
  'multimedia.errors.PERMISSION_DENIED',
] as const;

function snapshotScreen(locale: Locale): Record<string, string> {
  return Object.fromEntries(SCREEN_KEYS.map((k) => [k, translate(k, locale)]));
}

test.beforeEach(() => {
  __resetLocaleForTests(DEFAULT_LOCALE);
});

// ────────────────────────────────────────────────────────────────────────────
// F1. EN → KO 전환 — 주요 화면 텍스트가 일제히 전환
// ────────────────────────────────────────────────────────────────────────────

test('F1-1. 토글 전/후 화면 텍스트 표가 전부 달라진다(모든 키에서 변화)', () => {
  const storage = makeMemoryStorage();
  setLocale('en', storage);
  const en = snapshotScreen('en');
  setLocale('ko', storage);
  const ko = snapshotScreen('ko');
  for (const key of SCREEN_KEYS) {
    assert.notEqual(ko[key], en[key], `${key} 는 EN↔KO 에서 달라야 한다`);
  }
  assert.equal(getLocale(), 'ko');
  assert.equal(storage.snapshot()[LOCALE_STORAGE_KEY], 'ko');
});

test('F1-2. translate(key) 무인자 경로 — 토글 후 자동으로 현재 locale 반영', () => {
  const storage = makeMemoryStorage();
  setLocale('en', storage);
  const enTitle = translate('app.title');
  assert.equal(enTitle, 'LLM Tycoon');
  setLocale('ko', storage);
  const koTitle = translate('app.title');
  assert.equal(koTitle, 'LLM 타이쿤');
  assert.notEqual(enTitle, koTitle);
});

// ────────────────────────────────────────────────────────────────────────────
// F2. KO → EN 복귀 — 전환은 양방향에서 무손실
// ────────────────────────────────────────────────────────────────────────────

test('F2-1. EN → KO → EN 3-hop — 첫 스냅샷과 마지막 스냅샷이 동일', () => {
  const storage = makeMemoryStorage();
  setLocale('en', storage);
  const firstEn = snapshotScreen('en');
  setLocale('ko', storage);
  setLocale('en', storage);
  const lastEn = snapshotScreen('en');
  assert.deepEqual(firstEn, lastEn, '라운드트립 후에도 화면 텍스트 동일');
  assert.equal(storage.snapshot()[LOCALE_STORAGE_KEY], 'en');
});

// ────────────────────────────────────────────────────────────────────────────
// F3. 새로고침 후 설정 유지 — storage 만 남겼을 때 복원
// ────────────────────────────────────────────────────────────────────────────

test('F3-1. KO 저장 후 앱 재부팅(모듈 리셋) → detectLocale 은 KO 복원', () => {
  const storage = makeMemoryStorage();
  setLocale('ko', storage);
  // "새로고침" — 모듈 레벨 상태는 초기화되지만 storage 는 그대로.
  __resetLocaleForTests(DEFAULT_LOCALE);
  const restored = detectLocale({ storage, navigatorLanguage: 'en-US' });
  assert.equal(restored, 'ko');
});

test('F3-2. storage 에 ko 가 있어도 navigator 만으로는 건드려지지 않는다(재부팅 우선순위)', () => {
  const storage = makeMemoryStorage({ [LOCALE_STORAGE_KEY]: 'ko' });
  __resetLocaleForTests(DEFAULT_LOCALE);
  assert.equal(detectLocale({ storage, navigatorLanguage: 'en-GB' }), 'ko');
  assert.equal(detectLocale({ storage, navigatorLanguage: null }), 'ko');
});

test('F3-3. storage 가 비어 있을 때만 navigator 폴백이 적용된다', () => {
  const emptyStorage = makeMemoryStorage();
  assert.equal(detectLocale({ storage: emptyStorage, navigatorLanguage: 'ko-KR' }), 'ko');
  assert.equal(detectLocale({ storage: emptyStorage, navigatorLanguage: 'en' }), 'en');
});

// ────────────────────────────────────────────────────────────────────────────
// F4. 세션 전환(handoff) 시 언어 유지
// ────────────────────────────────────────────────────────────────────────────

test('F4-1. 사용자 여정 — 토글(KO) → 세션 저장 → 한도 초과 → handoff → 새 세션도 KO', async () => {
  // (a) 토글.
  const storage = makeMemoryStorage();
  setLocale('ko', storage);
  assert.equal(getLocale(), 'ko');

  // (b) 세션 A 에 선택 언어 저장.
  const adapter = createInMemorySessionStore();
  const persistor = createSessionPersistor({ adapter, sessionId: 'sess-A', userId: 'U' });
  await persistor.onLanguagePreferenceChanged(createBudgetSession('sess-A'), 'ko');

  // (c) 한도 초과로 새 세션 핸드오프.
  const out = await handoffToNewSession({
    previousSessionId: 'sess-A',
    userId: 'U',
    budget: createBudgetSession('sess-A'),
    adapter,
  });

  // (d) 새 세션 스냅샷에서도 KO 가 유지되어야.
  const saved = await adapter.get('U', out.newSessionId);
  assert.ok(saved);
  assert.equal(saved!.languagePreference, 'ko', '세션 전환 시 언어가 리셋되면 안 된다');
  // localStorage 쪽도 여전히 KO — UI 는 계속 한국어로 렌더된다.
  assert.equal(storage.snapshot()[LOCALE_STORAGE_KEY], 'ko');
});

test('F4-2. 세션 A(KO) + 세션 B(EN) — 서로 독립 저장, 핸드오프는 각자 계보만 이어받는다', async () => {
  const adapter = createInMemorySessionStore();
  const pA = createSessionPersistor({ adapter, sessionId: 'A', userId: 'U' });
  const pB = createSessionPersistor({ adapter, sessionId: 'B', userId: 'U' });
  await pA.onLanguagePreferenceChanged(createBudgetSession('A'), 'ko');
  await pB.onLanguagePreferenceChanged(createBudgetSession('B'), 'en');

  const outA = await handoffToNewSession({
    previousSessionId: 'A', userId: 'U', budget: createBudgetSession('A'), adapter,
  });
  const outB = await handoffToNewSession({
    previousSessionId: 'B', userId: 'U', budget: createBudgetSession('B'), adapter,
  });
  assert.equal((await adapter.get('U', outA.newSessionId))!.languagePreference, 'ko');
  assert.equal((await adapter.get('U', outB.newSessionId))!.languagePreference, 'en');
});

// ────────────────────────────────────────────────────────────────────────────
// F5. 엣지 케이스
// ────────────────────────────────────────────────────────────────────────────

test('F5-1. 지원하지 않는 locale — setLocale 이 예외를 던진다(조용한 오염 방지)', () => {
  assert.throws(
    () => setLocale('fr' as Locale, makeMemoryStorage()),
    /Unsupported locale/,
  );
});

test('F5-2. SUPPORTED_LOCALES 는 ["en","ko"] 로 고정 — 새 locale 추가 시 본 스펙이 먼저 깨진다', () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ['en', 'ko']);
});

test('F5-3. storage 없음(null) — setLocale 이 예외 없이 메모리만 갱신', () => {
  assert.doesNotThrow(() => setLocale('ko', null));
  assert.equal(getLocale(), 'ko');
});

test('F5-4. setItem 이 QuotaExceeded 를 던져도 호출자는 예외 없이 진행', () => {
  const throwing: LocaleStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { /* noop */ },
  };
  assert.doesNotThrow(() => setLocale('ko', throwing));
  assert.equal(getLocale(), 'ko', '메모리 상태는 바뀌었지만 storage 는 비어있음');
});
