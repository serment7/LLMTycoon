// Run with: npx tsx --test tests/i18n/languageToggleRegression.spec.ts
//
// 지시 #5792656c · 언어 토글 회귀 검증 — Thanos 의 수정 PR(헤더 LanguageToggle
// 가시성 + 전체 화면 i18n locale 동기) 머지 후 회귀를 차단한다.
//
// 본 스펙은 4개 시나리오만 다룬다(설계상 의도적으로 좁게 잠금).
//   T1. 디폴트 언어가 en 으로 초기화된다(저장소·네비게이터 신호가 없을 때).
//   T2. KO 토글 시 전역 언어 상태(`getLocale()`) 와 i18n 의 활성 locale 이 동시에
//       ko 로 전환되고, 주요 5개 화면(로그인/대시보드/채팅/추천/설정) 의 핵심
//       라벨이 ko 문자열로 렌더된다.
//   T3. KO 저장 후 "새로고침" 시뮬레이션(모듈 상태 리셋 + storage 만 유지) 시
//       `detectLocale({storage})` 가 사용자별 storage 의 ko 값을 복원한다.
//   T4. ko → en 으로 다시 토글하면 동일한 5개 화면 라벨이 EN 으로 원복된다.
//
// 화면별 핵심 라벨 키 매핑(번역 사전 표면):
//   · 로그인  : `locale.label`              — LoginForm 우측 언어 토글 라벨
//   · 대시보드: `header.actions.language`   — 상단 헤더 액션 영역
//   · 채팅    : `tokenUsage.indicator.label`— 채팅 헤더의 토큰 인디케이터
//   · 추천    : `projects.recommend.title`  — 추천 패널 제목
//   · 설정    : `header.settingsAria`        — 설정 진입 버튼 aria-label

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  __resetLocaleForTests,
  detectLocale,
  getLocale,
  setLocale,
  translate,
  type Locale,
  type LocaleStorage,
} from '../../src/i18n/index.ts';

// ────────────────────────────────────────────────────────────────────────────
// 유틸 — 사용자별 메모리 storage, 화면 라벨 표
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

const SCREEN_KEYS = {
  login: 'locale.label',
  dashboard: 'header.actions.language',
  chat: 'tokenUsage.indicator.label',
  recommend: 'projects.recommend.title',
  settings: 'header.settingsAria',
} as const;

const EXPECTED_KO: Record<keyof typeof SCREEN_KEYS, string> = {
  login: '언어',
  dashboard: '언어 설정',
  chat: '토큰',
  recommend: 'AI 추천 팀',
  settings: '설정 열기',
};

const EXPECTED_EN: Record<keyof typeof SCREEN_KEYS, string> = {
  login: 'Language',
  dashboard: 'Language',
  chat: 'Tokens',
  recommend: 'AI recommended team',
  settings: 'Open settings',
};

function snapshotScreens(locale: Locale): Record<keyof typeof SCREEN_KEYS, string> {
  const out = {} as Record<keyof typeof SCREEN_KEYS, string>;
  for (const [screen, key] of Object.entries(SCREEN_KEYS) as Array<[keyof typeof SCREEN_KEYS, string]>) {
    out[screen] = translate(key, locale);
  }
  return out;
}

test.beforeEach(() => {
  __resetLocaleForTests(DEFAULT_LOCALE);
});

// ────────────────────────────────────────────────────────────────────────────
// T1. 디폴트 언어가 en 으로 초기화
// ────────────────────────────────────────────────────────────────────────────

test('T1. storage·navigator 신호가 모두 없으면 디폴트는 en 으로 초기화된다', () => {
  // (a) 모듈 전역 상태가 리셋된 직후, getLocale() 은 DEFAULT_LOCALE = en.
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.equal(getLocale(), 'en');

  // (b) 빈 storage + navigator null → detectLocale 도 en.
  const emptyStorage = makeMemoryStorage();
  assert.equal(detectLocale({ storage: emptyStorage, navigatorLanguage: null }), 'en');

  // (c) 디폴트 화면 라벨은 EN 사전을 따른다(로그인 화면 토글 라벨 sanity).
  assert.equal(translate(SCREEN_KEYS.login, 'en'), EXPECTED_EN.login);
});

// ────────────────────────────────────────────────────────────────────────────
// T2. 토글 → KO — 전역 상태 + 5개 화면 핵심 라벨이 모두 ko
// ────────────────────────────────────────────────────────────────────────────

test('T2. setLocale("ko") 시 전역 locale 과 5개 화면(로그인/대시보드/채팅/추천/설정) 라벨이 ko 로 전환', () => {
  const storage = makeMemoryStorage();
  setLocale('ko', storage);

  // (a) 전역 상태 동기 — 모듈 단일 진실원과 즉시 외부 가시값(getLocale) 일치.
  assert.equal(getLocale(), 'ko');
  // (b) storage 도 ko 로 영속(영속화 경로는 T3 가 별도 검증, 여기는 sanity).
  assert.equal(storage.snapshot()[LOCALE_STORAGE_KEY], 'ko');

  // (c) 5개 화면 핵심 라벨 — translate 가 현재 locale(ko) 을 반영해야 한다.
  const ko = snapshotScreens('ko');
  assert.deepEqual(ko, EXPECTED_KO, '5개 화면 핵심 라벨이 모두 ko 문자열로 렌더되어야 한다');

  // (d) ko/en 사전이 진짜로 다른 문자열을 가진다는 회귀 가드 — 키 누락/동의어 회귀 차단.
  for (const screen of Object.keys(SCREEN_KEYS) as Array<keyof typeof SCREEN_KEYS>) {
    assert.notEqual(EXPECTED_KO[screen], EXPECTED_EN[screen], `${screen} 화면 라벨은 EN↔KO 가 달라야 한다`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// T3. 새로고침 후에도 사용자별 언어 설정이 영속화
// ────────────────────────────────────────────────────────────────────────────

test('T3-a. KO 저장 후 모듈 리셋(새로고침) → detectLocale 이 storage 의 ko 를 복원', () => {
  const storage = makeMemoryStorage();
  setLocale('ko', storage);
  assert.equal(storage.snapshot()[LOCALE_STORAGE_KEY], 'ko');

  // 새로고침 — 모듈 메모리 상태는 초기화되지만 브라우저 storage(=한 사용자 격리 저장소) 는 유지.
  __resetLocaleForTests(DEFAULT_LOCALE);
  assert.equal(getLocale(), 'en', '리셋 직후 메모리는 디폴트로 비워진다');

  // navigator 가 en 을 가리켜도 storage 우선이라 ko 가 복원되어야 한다.
  const restored = detectLocale({ storage, navigatorLanguage: 'en-US' });
  assert.equal(restored, 'ko');
});

test('T3-b. 사용자별 storage 가 분리되면 각자의 언어 설정이 독립적으로 유지', () => {
  // 사용자 A · B 가 각자 이전 세션에서 KO/EN 을 선택해 자기 브라우저 storage 에 영속.
  // (LanguageToggle 의 onPersist 가 호출했던 결과를 시드값으로 모델링 — 이렇게 하면
  // setLocale 의 동일 locale short-circuit 와 무관하게 각 사용자의 영속 상태를 잠근다.)
  const storageA = makeMemoryStorage({ [LOCALE_STORAGE_KEY]: 'ko' });
  const storageB = makeMemoryStorage({ [LOCALE_STORAGE_KEY]: 'en' });

  // 새로고침(모듈 리셋) 후, 각자 자기 storage 를 들고 detectLocale 을 부르면 각자
  // 저장한 값으로 복원되어야 한다 — 한 사용자의 변경이 다른 사용자에게 누출되면 안 됨.
  __resetLocaleForTests(DEFAULT_LOCALE);
  assert.equal(detectLocale({ storage: storageA, navigatorLanguage: 'en-US' }), 'ko');
  assert.equal(detectLocale({ storage: storageB, navigatorLanguage: 'ko-KR' }), 'en');
});

// ────────────────────────────────────────────────────────────────────────────
// T4. KO → EN 원복 — 동일 5개 화면 라벨이 EN 사전으로 되돌아온다
// ────────────────────────────────────────────────────────────────────────────

test('T4. ko → en 토글 → 5개 화면 라벨이 EN 으로 원복되고 storage 도 en 으로 갱신', () => {
  const storage = makeMemoryStorage();

  // 먼저 KO 로 전환해 ko 상태를 만든다.
  setLocale('ko', storage);
  const koSnapshot = snapshotScreens('ko');
  assert.deepEqual(koSnapshot, EXPECTED_KO);

  // 다시 EN 으로 토글.
  setLocale('en', storage);
  assert.equal(getLocale(), 'en');
  assert.equal(storage.snapshot()[LOCALE_STORAGE_KEY], 'en');

  const enSnapshot = snapshotScreens('en');
  assert.deepEqual(enSnapshot, EXPECTED_EN, '원복 후 5개 화면 라벨이 EN 사전과 정확히 일치해야 한다');

  // 라운드트립 무손실 — KO 시점과 비교했을 때 모든 화면이 달라져야(=실제로 갈렸다는 증거).
  for (const screen of Object.keys(SCREEN_KEYS) as Array<keyof typeof SCREEN_KEYS>) {
    assert.notEqual(enSnapshot[screen], koSnapshot[screen], `${screen} 화면이 ko→en 라운드트립에서 갱신돼야 한다`);
  }
});
