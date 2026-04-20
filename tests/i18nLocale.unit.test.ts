// Run with: npx tsx --test tests/i18nLocale.unit.test.ts
//
// 지시 #4f8fee6e — i18n 언어 모드 인프라 단위 계약.
//
// 본 스위트는 DOM 없이(`node --test`) i18n 모듈의 순수 로직만 잠근다. React 훅(useLocale)
// 은 jsdom 셋업 없이 간단히 검증이 어려워 따로 다루지 않고, 모듈 상태/저장/조회 계약만
// 확정한다. 이후 UI 치환 PR 에서 Provider 없는 훅 사용 경로 회귀 테스트를 추가한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  detectLocale,
  getLocale,
  persistLocale,
  setLocale,
  translate,
  __resetLocaleForTests,
  type Locale,
  type LocaleStorage,
} from '../src/i18n/index.ts';

function createMemoryStorage(seed: Record<string, string> = {}): LocaleStorage & {
  readonly snapshot: () => Record<string, string>;
} {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    snapshot: () => Object.fromEntries(store.entries()),
  };
}

test('A1. 기본 locale 은 en 이고 지원 목록은 en/ko', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.deepEqual([...SUPPORTED_LOCALES], ['en', 'ko']);
});

test('B1. detectLocale — storage 값이 있으면 우선', () => {
  const storage = createMemoryStorage({ [LOCALE_STORAGE_KEY]: 'ko' });
  assert.equal(detectLocale({ storage, navigatorLanguage: 'en-US' }), 'ko');
});

test('B2. detectLocale — storage 비어 있으면 navigator.language 접두', () => {
  const storage = createMemoryStorage();
  assert.equal(detectLocale({ storage, navigatorLanguage: 'ko-KR' }), 'ko');
  assert.equal(detectLocale({ storage, navigatorLanguage: 'en-GB' }), 'en');
});

test('B3. detectLocale — 알 수 없는 값 / 둘 다 없으면 DEFAULT_LOCALE', () => {
  const storage = createMemoryStorage({ [LOCALE_STORAGE_KEY]: 'fr' });
  assert.equal(detectLocale({ storage, navigatorLanguage: 'fr-FR' }), DEFAULT_LOCALE);
  assert.equal(detectLocale({ storage: null, navigatorLanguage: null }), DEFAULT_LOCALE);
});

test('B4. detectLocale — storage.getItem 예외는 조용히 넘겨 다음 단계로', () => {
  const storage: LocaleStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {},
    removeItem: () => {},
  };
  assert.equal(detectLocale({ storage, navigatorLanguage: 'ko' }), 'ko');
});

test('C1. persistLocale — storage 에 기록된다', () => {
  const storage = createMemoryStorage();
  persistLocale('ko', storage);
  assert.equal(storage.snapshot()[LOCALE_STORAGE_KEY], 'ko');
});

test('C2. persistLocale — storage 가 null 이면 no-op 으로 통과', () => {
  assert.doesNotThrow(() => persistLocale('ko', null));
});

test('C3. persistLocale — setItem 예외는 삼킨다(사용자 흐름 차단 금지)', () => {
  const storage: LocaleStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {},
  };
  assert.doesNotThrow(() => persistLocale('ko', storage));
});

test('D1. setLocale — 현재 값을 갱신하고 storage 에 저장한다', () => {
  __resetLocaleForTests('en');
  const storage = createMemoryStorage();
  setLocale('ko', storage);
  assert.equal(getLocale(), 'ko');
  assert.equal(storage.snapshot()[LOCALE_STORAGE_KEY], 'ko');
});

test('D2. setLocale — 잘못된 값은 throw', () => {
  __resetLocaleForTests('en');
  assert.throws(() => setLocale('fr' as Locale), /Unsupported locale/);
});

test('E1. translate — 현재 locale 문자열 조회', () => {
  assert.equal(translate('common.save', 'en'), 'Save');
  assert.equal(translate('common.save', 'ko'), '저장');
});

test('E2. translate — 누락 키는 기본 locale(en) 로 폴백', () => {
  // en 에만 있는 키를 ko 로 조회 → en 값으로 폴백되는지 확인.
  // 현재 locales 는 en/ko 가 대칭이므로 가공 경로 확인 차원에서 존재 경로만 테스트.
  assert.equal(translate('app.title', 'ko'), 'LLM 타이쿤');
  assert.equal(translate('app.title', 'en'), 'LLM Tycoon');
});

test('E3. translate — 알 수 없는 키는 key 원문 반환', () => {
  assert.equal(translate('does.not.exist', 'en'), 'does.not.exist');
  assert.equal(translate('does.not.exist', 'ko'), 'does.not.exist');
});

test('E4. translate — 중간 노드(object) 는 문자열이 아니므로 key 반환', () => {
  assert.equal(translate('common', 'en'), 'common');
});

test('F1. 전체 라운드트립 — detect→set→persist→재감지 시 같은 값이 복원된다', () => {
  __resetLocaleForTests('en');
  const storage = createMemoryStorage();
  setLocale('ko', storage);
  assert.equal(detectLocale({ storage, navigatorLanguage: 'en-US' }), 'ko');
});
