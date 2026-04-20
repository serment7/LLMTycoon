// Run with: npx tsx --test tests/i18n/localeMode.spec.ts
//
// 지시 #6aa2b637 (QA) · i18n 언어 모드 회귀.
//
// Joker 가 구현한 src/i18n/index.ts (useLocale 훅 · detectLocale · persistLocale ·
// translate) 와 locales/en.json · locales/ko.json 에 대한 회귀 시나리오 4종.
//
// 시나리오
//   S1. 최초 접속 — storage 비어있고 navigator.language 도 ko 가 아니면 기본 'en'.
//   S2. 전환 + 재접속 — setLocale('ko') 후 동일 storage 를 전달한 detectLocale 이
//        'ko' 를 돌려준다(퍼시스턴스 유지).
//   S3. 번역 키 누락 폴백 — ko 에만 없는 키는 en 으로 폴백, 양쪽 다 없으면 key 원문.
//   S4. 주요 화면 문자열 — app.title · common.save · multimedia.hub.title 이
//        로캘별로 올바르게 렌더된다.
//
// React 훅(useLocale) 은 브라우저/jsdom 환경 의존이 있어 본 스펙 범위 밖. 대신
// 훅이 얇게 감싸는 translate/getLocale/setLocale 순수 함수 경로를 직접 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  __resetLocaleForTests,
  detectLocale,
  getLocale,
  persistLocale,
  setLocale,
  translate,
  type LocaleStorage,
} from '../../src/i18n/index.ts';

// 메모리 기반 LocaleStorage — 재접속 시나리오를 한 프로세스에서 재현한다.
function makeMemoryStorage(initial: Record<string, string> = {}): LocaleStorage & {
  readonly snapshot: () => Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    snapshot: () => Object.fromEntries(map.entries()),
  };
}

test.beforeEach(() => {
  __resetLocaleForTests(DEFAULT_LOCALE);
});

// ────────────────────────────────────────────────────────────────────────────
// S1. 최초 접속 — 기본 언어는 영어
// ────────────────────────────────────────────────────────────────────────────

test('S1-1. storage 비어있고 navigator 도 ko 가 아니면 기본 en 을 감지', () => {
  const storage = makeMemoryStorage();
  const detected = detectLocale({ storage, navigatorLanguage: 'en-US' });
  assert.equal(detected, 'en');
  assert.equal(DEFAULT_LOCALE, 'en', 'DEFAULT_LOCALE 상수 자체가 en 이어야 한다');
});

test('S1-2. storage 도 navigator 도 없으면 최종 폴백이 en', () => {
  assert.equal(detectLocale({ storage: null, navigatorLanguage: null }), 'en');
});

test('S1-3. SUPPORTED_LOCALES 는 ["en","ko"] 고정', () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ['en', 'ko']);
});

// ────────────────────────────────────────────────────────────────────────────
// S2. 전환 후 재접속해도 설정 유지
// ────────────────────────────────────────────────────────────────────────────

test('S2-1. setLocale("ko") 호출 시 storage 에 user_preferences.language=ko 가 쓰인다', () => {
  const storage = makeMemoryStorage();
  setLocale('ko', storage);
  assert.equal(storage.getItem(LOCALE_STORAGE_KEY), 'ko');
  assert.equal(getLocale(), 'ko');
});

test('S2-2. 동일 storage 로 detectLocale 재호출 — "재접속" 시에도 ko 유지', () => {
  const storage = makeMemoryStorage();
  setLocale('ko', storage);
  // 모듈 레벨 상태를 초기화해 "새로운 앱 인스턴스" 를 시뮬레이션.
  __resetLocaleForTests(DEFAULT_LOCALE);
  const reloaded = detectLocale({ storage, navigatorLanguage: 'en-US' });
  assert.equal(reloaded, 'ko', '재접속 후에도 ko 가 복원되어야 함');
});

test('S2-3. persistLocale 직접 호출로 저장 키 형식이 user_preferences.language 인지 고정', () => {
  const storage = makeMemoryStorage();
  persistLocale('ko', storage);
  assert.equal(LOCALE_STORAGE_KEY, 'user_preferences.language');
  assert.deepEqual(storage.snapshot(), { 'user_preferences.language': 'ko' });
});

test('S2-4. setLocale 은 동일 값이면 storage 에 재기록하지 않는다(무변경 noop)', () => {
  const storage = makeMemoryStorage({ 'user_preferences.language': 'ko' });
  __resetLocaleForTests('ko');
  let writes = 0;
  const wrapped: LocaleStorage = {
    getItem: storage.getItem,
    setItem: (k, v) => {
      writes++;
      storage.setItem(k, v);
    },
    removeItem: storage.removeItem,
  };
  setLocale('ko', wrapped);
  assert.equal(writes, 0, '이미 ko 인 상태에서 setLocale("ko") 는 쓰지 않아야 한다');
});

// ────────────────────────────────────────────────────────────────────────────
// S3. 번역 키 누락 폴백
// ────────────────────────────────────────────────────────────────────────────

test('S3-1. 존재하지 않는 키는 현재 locale → en → key 원문 순으로 폴백', () => {
  // 양쪽 리소스에 모두 없는 키: key 원문 그대로 반환.
  assert.equal(translate('nope.missing.key', 'ko'), 'nope.missing.key');
  assert.equal(translate('nope.missing.key', 'en'), 'nope.missing.key');
});

test('S3-2. 중간 노드(객체) 를 가리키는 키는 문자열이 아니므로 key 원문 폴백', () => {
  // app 은 객체 — 문자열이 아니므로 key 원문 반환.
  assert.equal(translate('app', 'ko'), 'app');
  assert.equal(translate('common', 'en'), 'common');
});

test('S3-3. 빈 키/점만 있는 키도 안전하게 처리(예외 없음)', () => {
  assert.equal(translate('', 'en'), '');
  assert.equal(translate('.', 'ko'), '.');
});

// ────────────────────────────────────────────────────────────────────────────
// S4. 주요 화면 문자열 로캘별 렌더
// ────────────────────────────────────────────────────────────────────────────

test('S4-1. app.title — en "LLM Tycoon" · ko "LLM 타이쿤"', () => {
  assert.equal(translate('app.title', 'en'), 'LLM Tycoon');
  assert.equal(translate('app.title', 'ko'), 'LLM 타이쿤');
});

test('S4-2. common.save / common.cancel — 로캘별 정확 매핑', () => {
  assert.equal(translate('common.save', 'en'), 'Save');
  assert.equal(translate('common.save', 'ko'), '저장');
  assert.equal(translate('common.cancel', 'en'), 'Cancel');
  assert.equal(translate('common.cancel', 'ko'), '취소');
});

test('S4-3. multimedia.hub.title — 멀티미디어 허브 제목 로캘별', () => {
  assert.equal(translate('multimedia.hub.title', 'en'), 'Multimedia Hub');
  assert.equal(translate('multimedia.hub.title', 'ko'), '멀티미디어 허브');
});

test('S4-4. multimedia.errors.PERMISSION_DENIED — 에러 메시지 로캘별', () => {
  assert.equal(translate('multimedia.errors.PERMISSION_DENIED', 'en'), 'Permission denied.');
  assert.equal(translate('multimedia.errors.PERMISSION_DENIED', 'ko'), '권한이 거절되었습니다.');
});

test('S4-5. 현재 locale 기반 translate(단일 인자) — getLocale 결과를 따라 전환', () => {
  const storage = makeMemoryStorage();
  setLocale('ko', storage);
  assert.equal(translate('common.confirm'), '확인');
  setLocale('en', storage);
  assert.equal(translate('common.confirm'), 'Confirm');
});
