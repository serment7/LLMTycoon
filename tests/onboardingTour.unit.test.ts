// Run with: npx tsx --test tests/onboardingTour.unit.test.ts
//
// 지시 #b3582cfa — 첫 실행 온보딩 투어의 지속화 + 단계 순서 계약.
//
// DOM 없이 잠글 수 있는 표면만 다룬다:
//   O. onboardingPrefs 로컬 스토리지 라운드트립·예외 삼킴·clear.
//   S. ONBOARDING_STEPS 4 단계 순서·식별자 고정.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ONBOARDING_STORAGE_KEY,
  clearOnboardingCompleted,
  readOnboardingCompleted,
  writeOnboardingCompleted,
  type OnboardingStorage,
} from '../src/ui/onboarding/onboardingPrefs.ts';
import { ONBOARDING_STEPS } from '../src/ui/onboarding/OnboardingTour.tsx';

function memStorage(seed: Record<string, string> = {}): OnboardingStorage & {
  readonly dump: () => Record<string, string>;
} {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map),
  };
}

// ─── O: onboardingPrefs ────────────────────────────────────────────────────

test('O1. ONBOARDING_STORAGE_KEY 는 user_preferences 네임스페이스', () => {
  assert.equal(ONBOARDING_STORAGE_KEY, 'user_preferences.onboardingCompleted');
});

test('O2. write 후 read 는 동일 ISO 문자열을 돌려준다', () => {
  const storage = memStorage();
  writeOnboardingCompleted('2026-04-21T10:00:00Z', storage);
  assert.equal(readOnboardingCompleted(storage), '2026-04-21T10:00:00Z');
});

test('O3. 비어 있거나 없는 값은 null 반환', () => {
  assert.equal(readOnboardingCompleted(memStorage()), null);
  assert.equal(readOnboardingCompleted(memStorage({ [ONBOARDING_STORAGE_KEY]: '' })), null);
});

test('O4. getItem 예외는 삼키고 null 반환(사용자 흐름 차단 금지)', () => {
  const storage: OnboardingStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {},
    removeItem: () => {},
  };
  assert.equal(readOnboardingCompleted(storage), null);
});

test('O5. setItem 예외는 삼키고 다음 실행에서 온보딩 재노출 경로 유지', () => {
  const storage: OnboardingStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {},
  };
  assert.doesNotThrow(() => writeOnboardingCompleted('t', storage));
});

test('O6. clearOnboardingCompleted — 기록 제거 후 read 는 null', () => {
  const storage = memStorage({ [ONBOARDING_STORAGE_KEY]: 't' });
  clearOnboardingCompleted(storage);
  assert.equal(readOnboardingCompleted(storage), null);
});

test('O7. storage 가 null 이면 모든 경로가 no-op', () => {
  assert.equal(readOnboardingCompleted(null), null);
  assert.doesNotThrow(() => writeOnboardingCompleted('t', null));
  assert.doesNotThrow(() => clearOnboardingCompleted(null));
});

// ─── S: 단계 순서 ───────────────────────────────────────────────────────────

test('S1. ONBOARDING_STEPS 는 4단계 순서 고정: locale→mcp→recommend→tokens', () => {
  assert.deepEqual([...ONBOARDING_STEPS], ['locale', 'mcp', 'recommend', 'tokens']);
});
