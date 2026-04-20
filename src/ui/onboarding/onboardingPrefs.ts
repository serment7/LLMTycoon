// 지시 #b3582cfa · 온보딩 완료 여부의 단순 지속화 계층.
//
// 서버 측 user_preferences 는 언어(#9c227466) 만 다루고 있어, 본 키는 우선 로컬 스토리지
// 에 저장한다. 추후 서버 사이드 확장 시 동일 키 네임(`user_preferences.onboardingCompleted`)
// 을 재사용해 이관 충돌을 줄인다.
//
// 설계
//   · storage 주입 가능 — 기본은 globalThis.localStorage, 테스트는 MemStore 주입.
//   · read/write 예외는 조용히 삼켜 "저장 실패 시 다음 실행에서 다시 온보딩" 로 수렴.
//   · 값은 ISO 문자열(완료 시각). 미완료는 null.

export const ONBOARDING_STORAGE_KEY = 'user_preferences.onboardingCompleted';

export interface OnboardingStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

function defaultStorage(): OnboardingStorage | null {
  const g = globalThis as { localStorage?: OnboardingStorage };
  return g.localStorage ?? null;
}

export function readOnboardingCompleted(storage: OnboardingStorage | null = defaultStorage()): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(ONBOARDING_STORAGE_KEY);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeOnboardingCompleted(
  at: string,
  storage: OnboardingStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(ONBOARDING_STORAGE_KEY, at);
  } catch {
    // 저장 실패 시 다음 실행에서 온보딩을 다시 띄운다 — 사용자 흐름을 끊지 않는다.
  }
}

export function clearOnboardingCompleted(storage: OnboardingStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // 무시.
  }
}
