// Run with: npx tsx --test tests/thresholdsLoad.regression.test.ts
//
// QA: 지시 #f2ea3279 — claudeTokenUsageThresholds.ts 의 미커버 경로(load·부분 shape·
// 기본 nowIso·0 값 배제) 를 잠그는 회귀 테스트. 기존 테스트 파일은 그대로 두고
// 새 파일에서 보강.
//
// 잠그는 계약:
//   1. loadThresholdsFromStorage — SSR/스토리지 미존재/손상 데이터/정상 데이터
//   2. deserializeThresholds — caution 또는 warning 한쪽만 있는 부분 페이로드
//   3. serializeThresholds — nowIso 인자 생략 시 현재 시각 ISO 가 기록된다
//   4. normalizeEntry(간접) — 0 은 "미설정" 으로 간주하여 필드에서 제외된다

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadThresholdsFromStorage,
  deserializeThresholds,
  serializeThresholds,
  TOKEN_USAGE_THRESHOLDS_STORAGE_KEY,
} from '../src/utils/claudeTokenUsageThresholds.ts';
import { EMPTY_THRESHOLDS } from '../src/utils/claudeTokenUsageStore.ts';
import type { ClaudeTokenUsageThresholds } from '../src/types.ts';

function withFakeWindow<T>(storage: Partial<Storage> | undefined | null, fn: () => T): T {
  const g = globalThis as unknown as { window?: unknown };
  const prev = g.window;
  if (storage === undefined) {
    g.window = undefined;
  } else if (storage === null) {
    g.window = {};
  } else {
    g.window = { localStorage: storage as Storage };
  }
  try {
    return fn();
  } finally {
    g.window = prev;
  }
}

// ─── loadThresholdsFromStorage ───────────────────────────────────────────────

test('loadThresholdsFromStorage — SSR(window 미존재) 이면 EMPTY_THRESHOLDS 반환', () => {
  const result = withFakeWindow(undefined, () => loadThresholdsFromStorage());
  assert.deepEqual(result, EMPTY_THRESHOLDS);
});

test('loadThresholdsFromStorage — window 에 localStorage 가 없으면 EMPTY_THRESHOLDS', () => {
  const result = withFakeWindow(null, () => loadThresholdsFromStorage());
  assert.deepEqual(result, EMPTY_THRESHOLDS);
});

test('loadThresholdsFromStorage — 저장값 없음(getItem null) 이면 EMPTY_THRESHOLDS', () => {
  const fakeStorage: Partial<Storage> = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  const result = withFakeWindow(fakeStorage, () => loadThresholdsFromStorage());
  assert.deepEqual(result, EMPTY_THRESHOLDS);
});

test('loadThresholdsFromStorage — getItem 이 예외를 던져도 EMPTY_THRESHOLDS(크래시 금지)', () => {
  // 사생활 보호 모드/iframe 제한 등 일부 환경에서 getItem 자체가 SecurityError 를 던진다.
  // UI 가 mount 시 크래시하면 안 되므로 catch 하여 빈 임계값을 반환해야 한다.
  const fakeStorage: Partial<Storage> = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  const result = withFakeWindow(fakeStorage, () => loadThresholdsFromStorage());
  assert.deepEqual(result, EMPTY_THRESHOLDS);
});

test('loadThresholdsFromStorage — 정상 저장된 v1 페이로드는 그대로 복원된다', () => {
  const original: ClaudeTokenUsageThresholds = {
    caution: { tokens: 1234, usd: 0.5 },
    warning: { tokens: 99_999, usd: 12.34 },
  };
  const stored = serializeThresholds(original, '2026-04-19T10:00:00.000Z');
  let observedKey: string | null = null;
  const fakeStorage: Partial<Storage> = {
    getItem: (k) => { observedKey = k; return stored; },
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  const result = withFakeWindow(fakeStorage, () => loadThresholdsFromStorage());
  assert.deepEqual(result, original);
  assert.equal(observedKey, TOKEN_USAGE_THRESHOLDS_STORAGE_KEY,
    '항상 고정된 키를 조회해야 한다(스키마 마이그레이션 시 이 계약 변경)');
});

// ─── deserializeThresholds — 부분 shape ─────────────────────────────────────

test('deserializeThresholds — caution 만 있는 부분 페이로드도 안전하게 복원된다', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    thresholds: { caution: { tokens: 100 } }, // warning 누락
    savedAt: '2026-04-19T10:00:00.000Z',
  });
  const back = deserializeThresholds(raw);
  assert.deepEqual(back.caution, { tokens: 100 });
  assert.deepEqual(back.warning, {}, 'warning 누락 시 빈 entry 로 채워야 한다');
});

test('deserializeThresholds — warning 만 있는 부분 페이로드도 안전하게 복원된다', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    thresholds: { warning: { usd: 50 } }, // caution 누락
    savedAt: '2026-04-19T10:00:00.000Z',
  });
  const back = deserializeThresholds(raw);
  assert.deepEqual(back.caution, {});
  assert.deepEqual(back.warning, { usd: 50 });
});

test('deserializeThresholds — thresholds 가 null 이면 EMPTY_THRESHOLDS', () => {
  const raw = JSON.stringify({ schemaVersion: 1, thresholds: null, savedAt: 'x' });
  assert.deepEqual(deserializeThresholds(raw), EMPTY_THRESHOLDS);
});

test('deserializeThresholds — thresholds.caution/warning 이 객체가 아니면 빈 entry 로 처리', () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    thresholds: { caution: 'oops', warning: 42 },
    savedAt: 'x',
  });
  const back = deserializeThresholds(raw);
  assert.deepEqual(back.caution, {});
  assert.deepEqual(back.warning, {});
});

// ─── serializeThresholds — 기본 nowIso ───────────────────────────────────────

test('serializeThresholds — nowIso 인자 생략 시 현재 시각 ISO 가 savedAt 에 기록된다', () => {
  const before = Date.now();
  const s = serializeThresholds({ caution: { tokens: 10 }, warning: { tokens: 100 } });
  const after = Date.now();
  const parsed = JSON.parse(s) as { savedAt: string };
  assert.equal(typeof parsed.savedAt, 'string');
  // ISO 8601 형식이며 호출 직전·직후 타임스탬프 사이에 들어와야 한다.
  const ts = Date.parse(parsed.savedAt);
  assert.ok(Number.isFinite(ts), 'savedAt 은 파싱 가능한 ISO 문자열이어야 한다');
  assert.ok(ts >= before && ts <= after,
    `savedAt(${parsed.savedAt}) 가 호출 시점 [${before}, ${after}] 안에 있어야 한다`);
});

// ─── normalizeEntry(간접) — 0 값 배제 ───────────────────────────────────────

test('deserializeThresholds — tokens=0 / usd=0 은 미설정으로 처리되어 필드에서 제외', () => {
  // "임계값 0" 은 "모든 사용량이 임계 초과" 를 의미하므로 의도가 모호하다.
  // 정책상 0 은 미설정으로 정규화한다(EMPTY 와 동일 의미).
  const raw = JSON.stringify({
    schemaVersion: 1,
    thresholds: {
      caution: { tokens: 0, usd: 0 },
      warning: { tokens: 0, usd: 0 },
    },
    savedAt: 'x',
  });
  const back = deserializeThresholds(raw);
  assert.deepEqual(back.caution, {}, '0 은 caution 에서 제외');
  assert.deepEqual(back.warning, {}, '0 은 warning 에서 제외');
});

test('deserializeThresholds — tokens 가 정수가 아닌 실수여도 그대로 보존(파서는 floor 안 함)', () => {
  // parseThresholdInput 은 tokens 를 floor 하지만, 이미 저장된 페이로드의 신뢰는
  // serializer 의 책임이므로 deserializer 는 양수면 그대로 복원한다.
  const raw = JSON.stringify({
    schemaVersion: 1,
    thresholds: {
      caution: { tokens: 100.7 },
      warning: { tokens: 5000 },
    },
    savedAt: 'x',
  });
  const back = deserializeThresholds(raw);
  assert.equal(back.caution.tokens, 100.7,
    'deserializer 는 양수 tokens 를 그대로 보존(정규화는 입력 단계에서)');
});
