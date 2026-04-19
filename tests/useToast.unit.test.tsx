// Run with: npx tsx --test tests/useToast.unit.test.tsx
//
// 단위 테스트: src/components/ToastProvider.tsx — useToast 훅의 네 가지 유형
// 등록·닫기·동시 표시 상한·중복 id 병합. 지시 #b17802a6.
//
// 외부 I/O(DOM) 는 global-jsdom 으로 주입한다. React 19 + @testing-library/react
// 는 devDeps 에 이미 존재.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup } from '@testing-library/react';

import { ToastProvider, useToast, type UseToast } from '../src/components/ToastProvider.tsx';

// 훅 값을 상위 테스트 코드로 빼내기 위한 소비자 컴포넌트.
function Capture({ onReady }: { onReady: (api: UseToast) => void }) {
  const api = useToast();
  React.useEffect(() => { onReady(api); }, [api, onReady]);
  return null;
}

function mount(): { api: UseToast; unmount: () => void; doc: Document } {
  let captured: UseToast | null = null;
  const handle = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(Capture, { onReady: (a) => { captured = a; } }),
    ),
  );
  if (!captured) throw new Error('useToast() 가 Capture 에서 수령되지 않았다');
  return { api: captured, unmount: handle.unmount, doc: document };
}

test('useToast — Provider 없이 호출해도 no-op 을 돌려준다(점진적 도입 안전망)', () => {
  // Provider 를 감싸지 않고 호출 — Context 가 null 이면 NO_OP_TOAST 반환 경로.
  let api: UseToast | null = null;
  const handle = render(React.createElement(Capture, { onReady: (a) => { api = a; } }));
  assert.ok(api, 'Capture 에서 훅을 받아야 한다');
  // push 가 빈 문자열을 반환하고, dismiss/dismissAll 이 예외 없이 종료.
  assert.equal(api!.push({ title: '안녕' }), '');
  assert.doesNotThrow(() => api!.dismiss('nope'));
  assert.doesNotThrow(() => api!.dismissAll());
  handle.unmount();
  cleanup();
});

test('useToast — 4 variant 등록 시 올바른 role/aria-live/data-toast-variant 가 붙는다', () => {
  const { api, unmount, doc } = mount();
  act(() => {
    api.push({ id: 's', variant: 'success', title: '성공' });
    api.push({ id: 'i', variant: 'info',    title: '참고' });
    api.push({ id: 'w', variant: 'warning', title: '경고' });
  });
  const success = doc.querySelector('[data-toast-variant="success"]')!;
  const info = doc.querySelector('[data-toast-variant="info"]')!;
  const warning = doc.querySelector('[data-toast-variant="warning"]')!;
  assert.ok(success && info && warning, '세 토스트가 DOM 에 존재');
  assert.equal(success.getAttribute('role'), 'status');
  assert.equal(success.getAttribute('aria-live'), 'polite');
  assert.equal(info.getAttribute('role'), 'status');
  assert.equal(warning.getAttribute('role'), 'alert');
  assert.equal(warning.getAttribute('aria-live'), 'assertive');
  unmount();
  cleanup();
});

test('useToast — error variant 는 role="alert" + aria-live="assertive"', () => {
  const { api, unmount, doc } = mount();
  act(() => { api.push({ id: 'e', variant: 'error', title: '실패' }); });
  const el = doc.querySelector('[data-toast-variant="error"]')!;
  assert.equal(el.getAttribute('role'), 'alert');
  assert.equal(el.getAttribute('aria-live'), 'assertive');
  unmount();
  cleanup();
});

test('useToast — dismiss(id) 로 특정 토스트 닫기', () => {
  const { api, unmount, doc } = mount();
  act(() => {
    api.push({ id: 'a', title: 'A' });
    api.push({ id: 'b', title: 'B' });
  });
  assert.equal(doc.querySelectorAll('[data-toast-id]').length, 2);
  act(() => { api.dismiss('a'); });
  assert.equal(doc.querySelectorAll('[data-toast-id]').length, 1);
  assert.ok(doc.querySelector('[data-toast-id="b"]'));
  unmount();
  cleanup();
});

test('useToast — dismissAll 로 모두 닫기', () => {
  const { api, unmount, doc } = mount();
  act(() => {
    api.push({ id: 'a', title: 'A' });
    api.push({ id: 'b', title: 'B' });
    api.push({ id: 'c', title: 'C' });
  });
  assert.equal(doc.querySelectorAll('[data-toast-id]').length, 3);
  act(() => { api.dismissAll(); });
  assert.equal(doc.querySelectorAll('[data-toast-id]').length, 0);
  unmount();
  cleanup();
});

test('useToast — 동시 표시 상한은 3(MAX_VISIBLE), 초과분은 큐잉된다', () => {
  const { api, unmount, doc } = mount();
  act(() => {
    api.push({ id: 't1', title: '1' });
    api.push({ id: 't2', title: '2' });
    api.push({ id: 't3', title: '3' });
    api.push({ id: 't4', title: '4' });
    api.push({ id: 't5', title: '5' });
  });
  const visible = doc.querySelectorAll('[data-toast-id]');
  assert.equal(visible.length, 3, '한 번에 최대 3개만 렌더');
  // FIFO — 가장 오래된 t1/t2/t3 이 먼저 보여야 한다(시안 §4 T-08).
  const ids = Array.from(visible).map(el => el.getAttribute('data-toast-id'));
  assert.deepEqual(ids, ['t1', 't2', 't3']);
  unmount();
  cleanup();
});

test('useToast — 같은 id 로 재등록하면 DOM 이 증가하지 않고 내용만 갱신된다(T-09)', () => {
  const { api, unmount, doc } = mount();
  act(() => { api.push({ id: 'dedupe', title: '원본' }); });
  assert.equal(doc.querySelectorAll('[data-toast-id="dedupe"]').length, 1);
  act(() => { api.push({ id: 'dedupe', title: '갱신됨', variant: 'warning' }); });
  const only = doc.querySelectorAll('[data-toast-id="dedupe"]');
  assert.equal(only.length, 1, '중복 id 는 DOM 에 추가되지 않음');
  // variant 가 교체됐는지 확인
  assert.equal(only[0].getAttribute('data-toast-variant'), 'warning');
  unmount();
  cleanup();
});

test('useToast — 닫기 버튼(×) 클릭 시 해당 토스트가 사라진다', () => {
  const { api, unmount, doc } = mount();
  act(() => { api.push({ id: 'click-close', variant: 'info', title: '정보' }); });
  const closeBtn = doc.querySelector('[data-testid="toast-info-close"]') as HTMLButtonElement;
  assert.ok(closeBtn, '닫기 버튼이 있어야 한다');
  act(() => { closeBtn.click(); });
  assert.equal(doc.querySelectorAll('[data-toast-id="click-close"]').length, 0);
  unmount();
  cleanup();
});
