// 지시 #4f8fee6e · 한국어/영어 언어 모드 인프라.
//
// 범위
//   (1) 지원 locale 고정(en/ko) 및 리소스 캐시.
//   (2) 감지 순서: localStorage('user_preferences.language') → navigator.language → 기본 'en'.
//   (3) 퍼시스턴스: localStorage 에 'user_preferences.language' 키로 저장. 서버/테스트
//       환경에서 storage 가 없으면 조용히 스킵 — 예외를 삼키지 않고 콘솔에도 찍지 않아
//       단위 테스트가 깔끔하다.
//   (4) 구독 모델: 모듈 레벨 리스너 Set + React `useSyncExternalStore` 로 반응형 훅 제공.
//       Provider 를 App 트리에 끼워 넣지 않아도 되므로 기존 화면/테스트에 사이드이펙트가 없다.
//   (5) `t(key)` 는 점 경로(dot-path) 탐색. 없는 키는 대체로 영어 → 그래도 없으면 key 원문.
//
// 설계 근거
//   · 리소스 파일은 리포 루트 `locales/{en,ko}.json` 로 분리(번역 외주가 JSON 만 수정할
//     수 있도록). 런타임은 ESM `import … assert { type: 'json' }` 대신 `import` 를 쓴다.
//     Vite/TypeScript 에서 resolveJsonModule=true 이므로 정적 import 로 충분.
//   · 언어 모드는 "UI 문자열 사전 + 설정값" 에 한정한다. 날짜/숫자 포맷은 본 PR 범위 외.

import en from '../../locales/en.json';
import ko from '../../locales/ko.json';
import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';

export type Locale = 'en' | 'ko';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'ko'];
export const DEFAULT_LOCALE: Locale = 'en';

/** localStorage 키. user_preferences 네임스페이스의 일부로 평탄화한 형태. */
export const LOCALE_STORAGE_KEY = 'user_preferences.language';

type LocaleResource = typeof en;

const RESOURCES: Record<Locale, LocaleResource> = {
  en: en as LocaleResource,
  ko: ko as LocaleResource,
};

/** 런타임 storage 접근자 — 테스트가 주입할 수 있도록 분리. */
export interface LocaleStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

function defaultStorage(): LocaleStorage | null {
  const g = globalThis as { localStorage?: LocaleStorage };
  return g.localStorage ?? null;
}

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * 감지 순서: 저장소(user_preferences.language) → navigator.language 접두 → 기본(en).
 * 테스트에서 외부 입력을 주입할 수 있도록 storage/navigator 를 옵션으로 받는다.
 */
export function detectLocale(options?: {
  readonly storage?: LocaleStorage | null;
  readonly navigatorLanguage?: string | null;
}): Locale {
  const storage = options?.storage === undefined ? defaultStorage() : options.storage;
  if (storage) {
    try {
      const raw = storage.getItem(LOCALE_STORAGE_KEY);
      if (isLocale(raw)) return raw;
    } catch {
      // Safari private / storage full / 비동기 예외 — 조용히 다음 단계로.
    }
  }
  const navLang =
    options?.navigatorLanguage !== undefined
      ? options.navigatorLanguage
      : ((globalThis as { navigator?: { language?: string } }).navigator?.language ?? null);
  if (typeof navLang === 'string') {
    const prefix = navLang.slice(0, 2).toLowerCase();
    if (isLocale(prefix)) return prefix;
  }
  return DEFAULT_LOCALE;
}

/** storage 에 저장. storage 없으면 no-op. */
export function persistLocale(locale: Locale, storage: LocaleStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // QuotaExceeded · SecurityError 등 — 실패 시 다음 재접속은 기본값으로 fallback.
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 런타임 상태 · 구독
// ────────────────────────────────────────────────────────────────────────────

let currentLocale: Locale = detectLocale();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(next: Locale, storage?: LocaleStorage | null): void {
  if (!isLocale(next)) {
    throw new Error(`Unsupported locale: ${String(next)}`);
  }
  if (next === currentLocale) return;
  currentLocale = next;
  persistLocale(next, storage === undefined ? defaultStorage() : storage);
  notify();
}

/** 테스트 전용 — 모듈 상태를 강제 재초기화. 실사용 코드에서는 쓰지 말 것. */
export function __resetLocaleForTests(next: Locale = DEFAULT_LOCALE): void {
  currentLocale = next;
  listeners.clear();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 번역 조회 · 훅
// ────────────────────────────────────────────────────────────────────────────

function lookup(resource: LocaleResource, path: readonly string[]): unknown {
  let cursor: unknown = resource;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * 점 경로로 문자열을 꺼낸다.
 *   · 현재 locale → 기본 locale → key 원문 순.
 *   · 최종 결과가 문자열이 아니면(중간 노드) key 원문 반환.
 */
export function translate(key: string, locale: Locale = currentLocale): string {
  const path = key.split('.');
  const primary = lookup(RESOURCES[locale], path);
  if (typeof primary === 'string') return primary;
  if (locale !== DEFAULT_LOCALE) {
    const fallback = lookup(RESOURCES[DEFAULT_LOCALE], path);
    if (typeof fallback === 'string') return fallback;
  }
  return key;
}

/** React 훅 — 현재 locale, 전환 함수, t() 조회기를 반환. */
export function useLocale(): {
  readonly locale: Locale;
  readonly setLocale: (next: Locale) => void;
  readonly t: (key: string) => string;
} {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return {
    locale,
    setLocale: (next: Locale) => setLocale(next),
    t: (key: string) => translate(key, locale),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// React Context — 지시 #8de1a1c8 "토글 시 즉시 전체 UI 재렌더링되도록 Context 로 전파"
//
// 내부는 여전히 전역 모듈 상태를 단일 진실원(source of truth) 로 쓰되, Context 는
// 그 위에 "Provider 범위 안의 모든 자식 컴포넌트가 같은 참조를 재사용" 하도록 돕는
// 얇은 래퍼다. 기존 `useLocale` 을 직접 쓰는 코드는 Provider 여부와 무관하게 동작.
// ────────────────────────────────────────────────────────────────────────────

export interface I18nContextValue {
  readonly locale: Locale;
  readonly setLocale: (next: Locale) => void;
  readonly t: (key: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  readonly children?: React.ReactNode;
  /** 부트스트랩 시 특정 로케일로 강제 고정(세션 복원 경로). */
  readonly initialLocale?: Locale;
  readonly storage?: LocaleStorage | null;
}

export function I18nProvider(props: I18nProviderProps): React.ReactElement {
  // initialLocale 이 주어지면 마운트 시 한 번 동기. 이후에는 useSyncExternalStore 가
  // 전역 상태 변화를 Context 값에 반영한다.
  const bootstrapped = React.useRef(false);
  if (!bootstrapped.current && props.initialLocale && props.initialLocale !== currentLocale) {
    setLocale(props.initialLocale, props.storage ?? undefined);
    bootstrapped.current = true;
  }
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  const setLocaleCb = useCallback((next: Locale) => setLocale(next, props.storage ?? undefined), [props.storage]);
  const tCb = useCallback((key: string) => translate(key, locale), [locale]);
  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale: setLocaleCb, t: tCb }),
    [locale, setLocaleCb, tCb],
  );
  return React.createElement(I18nContext.Provider, { value }, props.children);
}

/**
 * Context 우선. Provider 가 없으면 `useLocale` 로 폴백 — 기존 App.tsx 경로가 영향을
 * 받지 않도록 설계.
 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  const fallback = useLocale();
  return ctx ?? fallback;
}
