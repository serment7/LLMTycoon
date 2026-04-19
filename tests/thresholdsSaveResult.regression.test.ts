// Run with: npx tsx --test tests/thresholdsSaveResult.regression.test.ts
//
// QA: 지시 #3c0b0d6f — `saveThresholdsToStorage` 의 boolean 반환 계약 회귀.
// 기존 `tests/claudeTokenUsageThresholds.regression.test.ts` 는 Joker/QA 영역으로
// 간주해 수정하지 않고, 새 파일에서 반환값 계약만 잠근다.
//
// 잠그는 계약:
//   1. SSR(window 미존재) 환경에서는 false 반환(저장할 곳이 없음).
//   2. localStorage.setItem 이 예외를 던지면 false.
//   3. 정상 저장 경로는 true.

import test from 'node:test';
import assert from 'node:assert/strict';

import { saveThresholdsToStorage } from '../src/utils/claudeTokenUsageThresholds.ts';
import type { ClaudeTokenUsageThresholds } from '../src/types.ts';

function sampleThresholds(): ClaudeTokenUsageThresholds {
  return { caution: { tokens: 500, usd: 1 }, warning: { tokens: 5000, usd: 10 } };
}

function withFakeWindow<T>(storage: Partial<Storage> | undefined, fn: () => T): T {
  const g = globalThis as unknown as { window?: unknown };
  const prev = g.window;
  g.window = storage === undefined ? undefined : { localStorage: storage as Storage };
  try {
    return fn();
  } finally {
    g.window = prev;
  }
}

test('SSR(window 미존재) — saveThresholdsToStorage 는 false 를 돌려준다', () => {
  const result = withFakeWindow(undefined, () => saveThresholdsToStorage(sampleThresholds()));
  assert.equal(result, false);
});

test('localStorage.setItem 이 예외를 던지면 false(QuotaExceededError 시뮬레이션)', () => {
  const fakeStorage: Partial<Storage> = {
    setItem: () => { throw new Error('QuotaExceededError'); },
    getItem: () => null,
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  const result = withFakeWindow(fakeStorage, () => saveThresholdsToStorage(sampleThresholds()));
  assert.equal(result, false);
});

test('정상 localStorage — saveThresholdsToStorage 는 true 를 돌려주고 값이 기록된다', () => {
  let stored: string | null = null;
  const fakeStorage: Partial<Storage> = {
    setItem: (_k, v) => { stored = v; },
    getItem: () => stored,
    removeItem: () => { stored = null; },
    clear: () => { stored = null; },
    key: () => null,
    length: 0,
  };
  const result = withFakeWindow(fakeStorage, () => saveThresholdsToStorage(sampleThresholds()));
  assert.equal(result, true);
  assert.ok(stored !== null, 'setItem 이 호출되어 값이 저장되어야 한다');
  const parsed = JSON.parse(stored!);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.thresholds.caution.tokens, 500);
});

test('window 에 localStorage 가 없으면 false (예: iframe 제한 · 브라우저 설정)', () => {
  const result = withFakeWindow({}, () => saveThresholdsToStorage(sampleThresholds()));
  assert.equal(result, false);
});
