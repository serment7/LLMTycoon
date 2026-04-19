// Run with: npx tsx --test tests/settingsCheatsheetServiceWorker.unit.test.ts
//
// 설정 드로어·치트시트·서비스 워커 등록 단위 테스트(#0dceedcd).
//   1) 단축키 치트시트 레지스트리 — 필수 항목 누락 없이 나열되고, 각 바인딩이 유효.
//   2) SettingsDrawer 순수 함수 — 리듀스드 모션 파싱, 토큰 임계 정규화.
//   3) 서비스 워커 등록 가능성 — canRegisterServiceWorker 의 환경 판정.
//
// Node 환경 순수 함수만 검증한다. DOM/브라우저 API 가 필요한 수명주기는 모킹하지 않고
// 환경 판정 경로만 잠근다.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GLOBAL_SHORTCUTS,
  GLOBAL_SHORTCUT_CATEGORIES,
  createShortcutRegistry,
  eventToCombo,
  normalizeCombo,
  type GlobalShortcutId,
} from '../src/utils/keyboardShortcuts.ts';
import {
  splitCombo,
  validateCheatsheetBindings,
} from '../src/components/KeyboardShortcutCheatsheet.tsx';
import {
  REDUCED_MOTION_STORAGE_KEY,
  TOKEN_THRESHOLD_STORAGE_KEY,
  normalizeTokenThresholds,
  parseReducedMotionPreference,
} from '../src/components/SettingsDrawer.tsx';
import {
  canRegisterServiceWorker,
} from '../src/utils/serviceWorkerRegistration.ts';

// ---------------------------------------------------------------------------
// 1) 치트시트 레지스트리 — 필수 항목 누락 없이 검색·업로드·내보내기·테마·온보딩
// ---------------------------------------------------------------------------

test('DEFAULT_GLOBAL_SHORTCUTS · 필수 단축키가 누락 없이 나열되고 유효하다', () => {
  const ids = DEFAULT_GLOBAL_SHORTCUTS.map(s => s.id);
  // 필수 카테고리 6종을 체크한다 — 검색·PDF·PPT·영상·테마·온보딩·업로드.
  const required: GlobalShortcutId[] = [
    'search', 'exportPdf', 'exportPptx', 'exportVideo', 'themeNext', 'onboardingReplay', 'uploadOpen',
  ];
  for (const id of required) {
    assert.ok(ids.includes(id), `${id} 단축키가 치트시트 카탈로그에 없다 — 사용자가 발견할 방법이 사라짐`);
  }

  // 모든 바인딩이 유효(키·설명 채워짐).
  const audit = validateCheatsheetBindings(DEFAULT_GLOBAL_SHORTCUTS);
  assert.equal(audit.ok, true, audit.ok ? '' : `무효 바인딩: ${audit.invalid.join(', ')}`);

  // 카테고리로 묶어도 동일 집합을 커버해야 한다.
  const categorized = GLOBAL_SHORTCUT_CATEGORIES.flatMap(c => c.shortcuts).map(s => s.id);
  for (const id of required) assert.ok(categorized.includes(id), `${id} 가 카테고리 묶음에서 빠짐`);

  // splitCombo — "Control+F" 같은 조합을 <kbd> 분할로 풀어 준다.
  assert.deepEqual(splitCombo('Control+F'), ['Control', 'F']);
  assert.deepEqual(splitCombo('Alt + P'), ['Alt', 'P']);
  assert.deepEqual(splitCombo(''), []);

  // normalizeCombo/eventToCombo 계약도 함께 잠근다 — App.tsx 이벤트 핸들러에 직접 쓰인다.
  assert.equal(normalizeCombo('cmd+f'), 'Meta+F');
  assert.equal(eventToCombo({ key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }), 'Meta+F');

  // 레지스트리 동작 스모크 — 등록/해제/중복 경합.
  const reg = createShortcutRegistry<GlobalShortcutId>();
  const off1 = reg.register({ id: 'search', keys: 'Control+F', description: '검색', priority: 50 });
  assert.equal(reg.resolveByCombo('Control+F')?.id, 'search');
  off1();
  assert.equal(reg.resolveByCombo('Control+F'), null);
});

// ---------------------------------------------------------------------------
// 2) SettingsDrawer 순수 함수 — 리듀스드 모션 파싱 + 토큰 임계 정규화
// ---------------------------------------------------------------------------

test('SettingsDrawer · parseReducedMotionPreference + normalizeTokenThresholds', () => {
  // 저장 키 상수 잠금.
  assert.equal(REDUCED_MOTION_STORAGE_KEY, 'llmtycoon.reducedMotion');
  assert.equal(TOKEN_THRESHOLD_STORAGE_KEY, 'llmtycoon.tokenThresholds');

  // 리듀스드 모션 파싱 — 3개 값 외는 'system' 폴백.
  assert.equal(parseReducedMotionPreference('force-on'), 'force-on');
  assert.equal(parseReducedMotionPreference('force-off'), 'force-off');
  assert.equal(parseReducedMotionPreference('system'), 'system');
  assert.equal(parseReducedMotionPreference(null), 'system');
  assert.equal(parseReducedMotionPreference('reduce'), 'system', '미지 값은 system 으로 수렴');
  assert.equal(parseReducedMotionPreference(42), 'system');

  // 토큰 임계 정규화 — 공백/음수/NaN 은 undefined, 두 필드 모두 비면 객체 자체 생략.
  const normalized = normalizeTokenThresholds({
    cautionTokens: ' 5000 ',
    cautionUsd: '',
    warningTokens: '10000',
    warningUsd: '-1',
  });
  assert.deepEqual(normalized, {
    caution: { tokens: 5000, usd: undefined },
    warning: { tokens: 10000, usd: undefined },
  });

  const empty = normalizeTokenThresholds({ cautionTokens: '', cautionUsd: '', warningTokens: '', warningUsd: '' });
  assert.deepEqual(empty, {}, '모든 입력이 비면 임계 객체 자체가 생략 — "임계 없음" 을 명확히 표현');

  const mixed = normalizeTokenThresholds({ cautionTokens: 'abc', cautionUsd: '0.5', warningTokens: 'NaN', warningUsd: '' });
  assert.deepEqual(mixed, { caution: { tokens: undefined, usd: 0.5 } });
});

// ---------------------------------------------------------------------------
// 3) 서비스 워커 등록 가능성 — 환경 판정
// ---------------------------------------------------------------------------

test('canRegisterServiceWorker · 보안 컨텍스트/지원 여부를 모킹해 판정한다', () => {
  // 지원 없음 → false.
  assert.equal(
    canRegisterServiceWorker({ hasNavigator: true, hasServiceWorker: false, isSecureContext: true }),
    false,
    '브라우저가 ServiceWorker 를 지원하지 않으면 등록하지 말아야 한다',
  );

  // navigator 자체 없음 → false.
  assert.equal(
    canRegisterServiceWorker({ hasNavigator: false, hasServiceWorker: true, isSecureContext: true }),
    false,
    'Node/SSR 환경에서는 no-op',
  );

  // 비보안 컨텍스트(http + 원격 호스트) → false.
  assert.equal(
    canRegisterServiceWorker({
      hasNavigator: true, hasServiceWorker: true, isSecureContext: false, hostname: 'example.com',
    }),
    false,
  );

  // localhost 는 보안 컨텍스트로 간주.
  assert.equal(
    canRegisterServiceWorker({
      hasNavigator: true, hasServiceWorker: true, isSecureContext: true, hostname: 'localhost',
    }),
    true,
    '개발 서버(localhost)에서도 서비스 워커를 등록해 QA 가능해야 한다',
  );

  // 기본 보안 컨텍스트.
  assert.equal(
    canRegisterServiceWorker({
      hasNavigator: true, hasServiceWorker: true, isSecureContext: true, hostname: 'llmtycoon.app',
    }),
    true,
  );
});
