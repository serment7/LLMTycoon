// Run with: npx tsx --test tests/codeConventionStore.regression.test.ts
//
// 지시 #d7caa7af — 프로젝트 관리 "코드 컨벤션·규칙 설정" 스토어 회귀.
//
// 잠그는 축
//   C1. 전역 저장/로드 — 라운드트립이 정상 동작한다.
//   C2. 로컬 저장/로드 — 프로젝트별 키 분리가 유지된다.
//   C3. 병합 — loadEffective 는 로컬이 있으면 로컬 우선, 없으면 전역 폴백.
//   C4. 부분 저장 필드 폴백 — 로컬 레코드에 누락된 필드가 있어도 전역 값으로
//        자동 병합된다(손상된 저장본 방어).
//   C5. 스토리지 키 포맷 — 'llmtycoon.codeConvention.global' 과
//        'llmtycoon.codeConvention.project.<id>' 를 벗어나면 안 된다.
//   C6. 정규화 — 범위 밖 들여쓰기 크기·알 수 없는 열거값·CRLF 를 보정한다.
//   C7. 초기화 — clearLocal 후 loadEffective 가 전역으로 회귀한다.
//   C8. 손상된 JSON — getItem 이 쓰레기 값을 돌려줘도 null 로 안전 처리.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_CONVENTION_GLOBAL_KEY,
  CODE_CONVENTION_PROJECT_KEY_PREFIX,
  codeConventionProjectKey,
  createCodeConventionStore,
  normalizeCodeConvention,
  type CodeConventionStorage,
} from '../src/services/settings/codeConventionStore.ts';
import { DEFAULT_CODE_CONVENTION } from '../src/types/codeConvention.ts';

function memoryStorage(): CodeConventionStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// C1 · C5. 전역 저장/로드 + 키 포맷
// ────────────────────────────────────────────────────────────────────────────

test('C1+C5. 전역 저장 → 로드 라운드트립 + 고정 키 사용', () => {
  const storage = memoryStorage();
  const store = createCodeConventionStore({ storage, now: () => 1_700_000_000_000 });
  const saved = store.saveGlobal({
    indentation: { style: 'tab', size: 4 },
    quotes: 'double',
    semicolons: 'omit',
    filenameConvention: 'PascalCase',
    customRules: '외부 API 호출은 Result 로 감싼다.',
  });
  assert.equal(saved.scope, 'global');
  assert.equal(saved.updatedAt, 1_700_000_000_000);
  assert.equal(saved.convention.indentation.style, 'tab');
  assert.equal(saved.convention.indentation.size, 4);
  assert.equal(saved.convention.quotes, 'double');
  assert.equal(saved.convention.semicolons, 'omit');
  assert.equal(saved.convention.filenameConvention, 'PascalCase');

  // 정확히 지정한 키로 저장되어야 한다.
  assert.equal(CODE_CONVENTION_GLOBAL_KEY, 'llmtycoon.codeConvention.global');
  assert.ok(storage.map.has(CODE_CONVENTION_GLOBAL_KEY));
  const other = [...storage.map.keys()].filter((k) => k !== CODE_CONVENTION_GLOBAL_KEY);
  assert.equal(other.length, 0, '전역 저장만으로 다른 키가 생기면 안 됨');

  const loaded = store.loadGlobal();
  assert.ok(loaded);
  assert.deepEqual(loaded!.convention, saved.convention);
});

// ────────────────────────────────────────────────────────────────────────────
// C2 · C5. 로컬 저장/로드 + 프로젝트별 키 분리
// ────────────────────────────────────────────────────────────────────────────

test('C2+C5. 로컬은 프로젝트 id 기반 키로 분리 저장된다', () => {
  const storage = memoryStorage();
  const store = createCodeConventionStore({ storage, now: () => 1_700_000_000_001 });

  store.saveLocal('alpha', { quotes: 'single', customRules: 'α 전용' });
  store.saveLocal('beta', { quotes: 'double', customRules: 'β 전용' });

  assert.equal(CODE_CONVENTION_PROJECT_KEY_PREFIX, 'llmtycoon.codeConvention.project.');
  assert.equal(codeConventionProjectKey('alpha'), 'llmtycoon.codeConvention.project.alpha');
  assert.ok(storage.map.has('llmtycoon.codeConvention.project.alpha'));
  assert.ok(storage.map.has('llmtycoon.codeConvention.project.beta'));

  const alpha = store.loadLocal('alpha');
  const beta = store.loadLocal('beta');
  assert.ok(alpha && beta);
  assert.equal(alpha!.convention.customRules, 'α 전용');
  assert.equal(beta!.convention.customRules, 'β 전용');
  assert.equal(alpha!.convention.quotes, 'single');
  assert.equal(beta!.convention.quotes, 'double');
});

// ────────────────────────────────────────────────────────────────────────────
// C3. 병합 — loadEffective 우선순위
// ────────────────────────────────────────────────────────────────────────────

test('C3. loadEffective — 로컬이 있으면 로컬, 없으면 전역 폴백', () => {
  const storage = memoryStorage();
  const store = createCodeConventionStore({ storage, now: () => 1_700_000_000_100 });

  store.saveGlobal({ quotes: 'double', semicolons: 'omit', customRules: '전역 규칙' });

  // 로컬 부재 → 전역이 그대로 올라온다.
  const onlyGlobal = store.loadEffective('P1');
  assert.equal(onlyGlobal.scope, 'global');
  assert.equal(onlyGlobal.convention.quotes, 'double');
  assert.equal(onlyGlobal.convention.semicolons, 'omit');

  // 로컬 저장 후 → 로컬 우선.
  store.saveLocal('P1', { quotes: 'single', customRules: '로컬 규칙' });
  const withLocal = store.loadEffective('P1');
  assert.equal(withLocal.scope, 'local');
  assert.equal(withLocal.projectId, 'P1');
  assert.equal(withLocal.convention.quotes, 'single');
  assert.equal(withLocal.convention.customRules, '로컬 규칙');

  // 둘 다 없으면 기본 — 새 스토어에서 확인.
  const bareStore = createCodeConventionStore({ storage: memoryStorage() });
  const bare = bareStore.loadEffective(undefined);
  assert.deepEqual(bare.convention, DEFAULT_CODE_CONVENTION);
  assert.equal(bare.scope, 'global');
});

// ────────────────────────────────────────────────────────────────────────────
// C4. 부분 저장 필드 폴백 — 로컬 저장본이 누락 필드 가져도 전역 값으로 채워짐
// ────────────────────────────────────────────────────────────────────────────

test('C4. 로컬 레코드가 일부 필드만 갖고 있어도 전역으로 필드 폴백된다', () => {
  const storage = memoryStorage();
  // 전역은 tab/4, PascalCase, omit.
  storage.setItem(CODE_CONVENTION_GLOBAL_KEY, JSON.stringify({
    convention: {
      indentation: { style: 'tab', size: 4 },
      quotes: 'double',
      semicolons: 'omit',
      filenameConvention: 'PascalCase',
      customRules: '전역',
    },
    updatedAt: 1,
  }));
  // 로컬은 quotes 만 기록된 손상/부분 저장본.
  storage.setItem(codeConventionProjectKey('P1'), JSON.stringify({
    convention: { quotes: 'single' },
    updatedAt: 2,
  }));

  const store = createCodeConventionStore({ storage });
  const effective = store.loadEffective('P1');
  assert.equal(effective.scope, 'local');
  assert.equal(effective.convention.quotes, 'single', '로컬 값 우선');
  // 로컬에 없는 필드는 전역 값이 올라와야 한다.
  assert.equal(effective.convention.indentation.style, 'tab');
  assert.equal(effective.convention.indentation.size, 4);
  assert.equal(effective.convention.semicolons, 'omit');
  assert.equal(effective.convention.filenameConvention, 'PascalCase');
});

// ────────────────────────────────────────────────────────────────────────────
// C6. 정규화 — 알 수 없는 값·범위 밖·CRLF 방어
// ────────────────────────────────────────────────────────────────────────────

test('C6. normalizeCodeConvention — 범위 밖 인덴트 크기와 알 수 없는 열거값을 보정', () => {
  const normalized = normalizeCodeConvention({
    indentation: { style: 'ruby' as unknown as 'space', size: 99 },
    quotes: 'typewriter' as unknown as 'single',
    semicolons: 'maybe' as unknown as 'required',
    filenameConvention: 'SNAKE_SHOUT' as unknown as 'camelCase',
    customRules: 'line1\r\nline2\rline3',
  });
  assert.equal(normalized.indentation.style, DEFAULT_CODE_CONVENTION.indentation.style);
  assert.equal(normalized.indentation.size, 8, '크기는 1~8 로 clamp');
  assert.equal(normalized.quotes, DEFAULT_CODE_CONVENTION.quotes);
  assert.equal(normalized.semicolons, DEFAULT_CODE_CONVENTION.semicolons);
  assert.equal(normalized.filenameConvention, DEFAULT_CODE_CONVENTION.filenameConvention);
  // CRLF · CR 만 LF 로 표준화하고 원문은 유지.
  assert.equal(normalized.customRules, 'line1\nline2\nline3');

  const tooSmall = normalizeCodeConvention({ indentation: { style: 'space', size: 0 } });
  assert.equal(tooSmall.indentation.size, 1);
});

// ────────────────────────────────────────────────────────────────────────────
// C7. 초기화 — clearLocal 후 effective 가 전역으로 회귀
// ────────────────────────────────────────────────────────────────────────────

test('C7. clearLocal 후 loadEffective 는 전역으로 되돌아간다', () => {
  const storage = memoryStorage();
  const store = createCodeConventionStore({ storage });

  store.saveGlobal({ quotes: 'double' });
  store.saveLocal('P1', { quotes: 'single' });
  assert.equal(store.loadEffective('P1').convention.quotes, 'single');
  store.clearLocal('P1');
  const effective = store.loadEffective('P1');
  assert.equal(effective.scope, 'global');
  assert.equal(effective.convention.quotes, 'double');

  store.clearGlobal();
  const noneLeft = store.loadEffective('P1');
  assert.deepEqual(noneLeft.convention, DEFAULT_CODE_CONVENTION);
});

// ────────────────────────────────────────────────────────────────────────────
// C8. 손상된 JSON 은 null 로 처리되고 saveLocal 시 새 값으로 정상 갱신
// ────────────────────────────────────────────────────────────────────────────

test('C8. 손상된 저장본은 안전하게 null 처리되고 이후 저장은 정상', () => {
  const storage = memoryStorage();
  storage.setItem(CODE_CONVENTION_GLOBAL_KEY, '{not json');
  storage.setItem(codeConventionProjectKey('P1'), '<<binary>>');
  const store = createCodeConventionStore({ storage });
  assert.equal(store.loadGlobal(), null);
  assert.equal(store.loadLocal('P1'), null);
  // 손상된 상태에서 loadEffective 는 기본값.
  assert.deepEqual(store.loadEffective('P1').convention, DEFAULT_CODE_CONVENTION);
  // 새 저장은 덮어써서 정상화된다.
  const saved = store.saveLocal('P1', { quotes: 'single' });
  assert.equal(saved.convention.quotes, 'single');
  const reloaded = store.loadLocal('P1');
  assert.ok(reloaded);
  assert.equal(reloaded!.convention.quotes, 'single');
});

// ────────────────────────────────────────────────────────────────────────────
// C9. saveLocal 은 projectId 가 없으면 예외(잘못된 호출 방어)
// ────────────────────────────────────────────────────────────────────────────

test('C9. saveLocal 에 빈 projectId 면 즉시 예외', () => {
  const store = createCodeConventionStore({ storage: memoryStorage() });
  assert.throws(() => store.saveLocal('', { quotes: 'single' }));
});
