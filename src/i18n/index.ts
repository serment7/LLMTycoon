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
//   · 리소스 파일은 `src/i18n/{en,ko}.json` 가 정본(지시 #ba58ad2d). 클라이언트 코드와
//     함께 번들링되도록 모듈 디렉터리 안에 둔다. 리포 루트 `locales/{en,ko}.json` 은
//     기존 외부 번역가 워크플로우 호환 사본이며, 두 위치는 동일 내용을 유지해야 한다.
//   · 런타임은 ESM `import … assert { type: 'json' }` 대신 `import` 를 쓴다.
//     Vite/TypeScript 에서 resolveJsonModule=true 이므로 정적 import 로 충분.
//   · 언어 모드는 "UI 문자열 사전 + 설정값" 에 한정한다. 날짜/숫자 포맷은 본 PR 범위 외.

import en from './en.json';
import ko from './ko.json';
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
  // initialLocale prop 동기 — 동일 prop 이 유지되는 동안에는 단 한 번만 발사.
  //
  // 회귀 #75cac73a — 이전 구현은 `if (initialLocale && initialLocale !== currentLocale)`
  // 조건만으로 매 렌더마다 발사를 결정했고, bootstrapped 플래그도 if 본문 안에서만
  // true 로 찍었다. 그래서 첫 렌더에 initialLocale === currentLocale 이면 ref 가
  // false 로 남고, 이후 사용자가 토글을 눌러 currentLocale 가 바뀌면 비로소 if 가
  // true 가 되어 initialLocale 로 강제 원복 → 토글이 안 먹는 것처럼 보인다.
  //
  // 새 규칙: "직전 렌더의 initialLocale 값" 을 ref 에 보관해 prop 자체가 바뀐 경우에만
  // 동기 setLocale 을 발사한다. setLocale 으로 인한 재렌더에서는 prop 이 그대로이므로
  // 다시 끼어들지 않는다(토글 정상 작동). prop 이 'en' → 'ko' 로 바뀐 경우는 새 마운트
  // 의도와 동일하게 한 번 동기한다(L1 회귀 호환).
  const lastInitialLocaleRef = React.useRef<Locale | undefined>(undefined);
  if (lastInitialLocaleRef.current !== props.initialLocale) {
    if (props.initialLocale && props.initialLocale !== currentLocale) {
      setLocale(props.initialLocale, props.storage ?? undefined);
    }
    lastInitialLocaleRef.current = props.initialLocale;
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
