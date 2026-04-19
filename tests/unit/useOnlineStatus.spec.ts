// Run with: npx tsx --test tests/unit/useOnlineStatus.spec.ts
//
// 지시 #3f1b7597 §2 — 오프라인 인식 훅의 순수 계약.
// 실제 이벤트 구독(useSyncExternalStore) 은 React 렌더 환경이 필요하므로 본 스펙은
// `resolveInitialOnline` 순수 함수의 계약만 잠근다. 컴포넌트 통합 동작은 Playwright
// e2e 또는 jsdom 통합 테스트에서 별도 소유한다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveInitialOnline } from '../../src/hooks/useOnlineStatus.ts';

test('navigator 가 undefined 면 낙관적으로 online=true 로 수렴한다(SSR/Node)', () => {
  assert.equal(resolveInitialOnline(undefined), true);
});

test('navigator.onLine=false 를 그대로 반영한다', () => {
  assert.equal(resolveInitialOnline({ onLine: false }), false);
});

test('navigator.onLine=true 는 true 로 반영한다', () => {
  assert.equal(resolveInitialOnline({ onLine: true }), true);
});

test('navigator.onLine 이 boolean 이 아니면 online=true 로 폴백', () => {
  // 일부 구형 브라우저는 onLine 이 undefined — 서비스 차단을 피하려 true 로 수렴.
  assert.equal(resolveInitialOnline({} as { onLine?: boolean }), true);
});

test('동적 import 로 useOnlineStatus 훅 함수가 노출되는지만 잠근다', async () => {
  const mod = await import('../../src/hooks/useOnlineStatus.ts');
  assert.equal(typeof mod.useOnlineStatus, 'function');
});
