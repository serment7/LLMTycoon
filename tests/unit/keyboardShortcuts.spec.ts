// Run with: npx tsx --test tests/unit/keyboardShortcuts.spec.ts
//
// 지시 #222ece09 §4 — 단축키 registry 순수 계약.
// OnboardingTour 와 동시에 같은 registry 를 구독하는 시나리오를 잠근다:
//   · 정규화 · 중복 등록 우선순위 · 이벤트→조합 해석.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createShortcutRegistry,
  normalizeCombo,
  eventToCombo,
  DEFAULT_MEDIA_SHORTCUTS,
  type MediaShortcutId,
} from '../../src/utils/keyboardShortcuts.ts';

test('normalizeCombo — 별칭(Cmd/Option)·대소문자·공백을 정규 형태로 수렴', () => {
  assert.equal(normalizeCombo('cmd+v'), 'Meta+V');
  assert.equal(normalizeCombo('Option + R '), 'Alt+R');
  assert.equal(normalizeCombo('shift+control+D'), 'Control+Shift+D');
});

test('eventToCombo — 수식어가 섞인 이벤트를 알파벳 순 조합으로 수렴', () => {
  const combo = eventToCombo({ key: 'r', altKey: true, shiftKey: true });
  assert.equal(combo, 'Alt+Shift+R');
});

test('registry — 기본 바인딩 등록·조회·이벤트 해석', () => {
  const reg = createShortcutRegistry<MediaShortcutId>();
  for (const s of DEFAULT_MEDIA_SHORTCUTS) reg.register(s);
  assert.equal(reg.list().length, DEFAULT_MEDIA_SHORTCUTS.length);
  const paste = reg.resolveByCombo('cmd+v');
  assert.equal(paste?.id, 'mediaPaste');
  const rec = reg.resolveByEvent({ key: 'r', altKey: true });
  assert.equal(rec?.id, 'mediaRecordStart');
});

test('registry — 낮거나 같은 우선순위의 중복 combo 등록은 거절', () => {
  const reg = createShortcutRegistry<string>();
  reg.register({ id: 'first', keys: 'Meta+V', description: '첫번째', priority: 10 });
  reg.register({ id: 'second', keys: 'Meta+V', description: '두번째', priority: 5 });
  assert.equal(reg.resolveByCombo('Meta+V')?.id, 'first');
});

test('registry — 동일 id 재등록은 combo 를 교체한다', () => {
  const reg = createShortcutRegistry<string>();
  const unregister = reg.register({ id: 'rec', keys: 'Alt+R', description: '녹음', priority: 10 });
  reg.register({ id: 'rec', keys: 'Alt+Shift+R', description: '녹음(변경)', priority: 10 });
  assert.equal(reg.resolveByCombo('Alt+R'), null);
  assert.equal(reg.resolveByCombo('Alt+Shift+R')?.id, 'rec');
  unregister(); // 이전 combo 는 이미 제거됐으므로 no-op
});
