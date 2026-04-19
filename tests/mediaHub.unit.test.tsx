// Run with: npx tsx --test tests/mediaHub.unit.test.tsx
//
// 단위 테스트: src/components/multimedia/MediaHub.tsx — PDF/PPT 진입 탭 허브의
// ARIA 구조·탭 토글·defaultTab 계약을 잠근다. 내부 패널(PdfImportPanel,
// PptImportPanel)은 projectId=null 로 렌더해도 드롭존만 disabled 로 뜨고 부작용이
// 없으므로 ToastProvider 래핑 없이 테스트 가능하다(useToast 가 NO_OP 폴백).
//
// 본 파일은 QA 역할(지시 #6ea9d390) 의 산출물로 "현재 동작을 잠그는" 회귀 방어용.
// 접근성/스타일 측면의 개선 제안은 docs/mediahub-qa-2026-04-19.md 참조.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup, fireEvent } from '@testing-library/react';

import { MediaHub } from '../src/components/multimedia/MediaHub.tsx';

function mount(props: Partial<React.ComponentProps<typeof MediaHub>> = {}) {
  const handle = render(
    React.createElement(MediaHub, { projectId: null, ...props }),
  );
  return handle;
}

test('MediaHub — 기본 탭은 pdf · tablist/tab/tabpanel ARIA 골격이 붙는다', () => {
  const handle = mount();

  const hub = document.querySelector('[data-testid="media-hub"]');
  assert.ok(hub, '허브 컨테이너가 렌더되어야 한다');

  const tablist = document.querySelector('[role="tablist"]');
  assert.ok(tablist, 'role=tablist 컨테이너가 있어야 한다');
  assert.equal(tablist!.getAttribute('aria-label'), '입력 종류 선택');

  const pdfTab = document.querySelector('[data-testid="media-hub-tab-pdf"]') as HTMLButtonElement;
  const pptxTab = document.querySelector('[data-testid="media-hub-tab-pptx"]') as HTMLButtonElement;
  assert.ok(pdfTab && pptxTab, 'pdf·pptx 탭 버튼이 모두 렌더되어야 한다');

  assert.equal(pdfTab.getAttribute('role'), 'tab');
  assert.equal(pptxTab.getAttribute('role'), 'tab');
  assert.equal(pdfTab.getAttribute('aria-selected'), 'true', '기본 선택 탭은 pdf');
  assert.equal(pptxTab.getAttribute('aria-selected'), 'false');

  const panel = document.querySelector('[data-testid="media-hub-panel-pdf"]');
  assert.ok(panel, '선택된 탭에 대응하는 tabpanel 이 렌더되어야 한다');
  assert.equal(panel!.getAttribute('role'), 'tabpanel');
  assert.equal(panel!.getAttribute('aria-labelledby'), 'media-hub-tab-pdf');

  handle.unmount();
  cleanup();
});

test('MediaHub — defaultTab="pptx" 로 마운트하면 pptx 가 선택 상태로 시작한다', () => {
  const handle = mount({ defaultTab: 'pptx' });

  const pdfTab = document.querySelector('[data-testid="media-hub-tab-pdf"]')!;
  const pptxTab = document.querySelector('[data-testid="media-hub-tab-pptx"]')!;
  assert.equal(pdfTab.getAttribute('aria-selected'), 'false');
  assert.equal(pptxTab.getAttribute('aria-selected'), 'true');

  assert.ok(document.querySelector('[data-testid="media-hub-panel-pptx"]'));
  assert.equal(document.querySelector('[data-testid="media-hub-panel-pdf"]'), null);

  handle.unmount();
  cleanup();
});

test('MediaHub — 탭 버튼 클릭 시 aria-selected 가 토글되고 패널이 교체된다', () => {
  const handle = mount();

  const pdfTab = document.querySelector('[data-testid="media-hub-tab-pdf"]') as HTMLButtonElement;
  const pptxTab = document.querySelector('[data-testid="media-hub-tab-pptx"]') as HTMLButtonElement;

  act(() => { fireEvent.click(pptxTab); });
  assert.equal(pdfTab.getAttribute('aria-selected'), 'false');
  assert.equal(pptxTab.getAttribute('aria-selected'), 'true');
  assert.ok(document.querySelector('[data-testid="media-hub-panel-pptx"]'));
  assert.equal(document.querySelector('[data-testid="media-hub-panel-pdf"]'), null);

  act(() => { fireEvent.click(pdfTab); });
  assert.equal(pdfTab.getAttribute('aria-selected'), 'true');
  assert.equal(pptxTab.getAttribute('aria-selected'), 'false');
  assert.ok(document.querySelector('[data-testid="media-hub-panel-pdf"]'));
  assert.equal(document.querySelector('[data-testid="media-hub-panel-pptx"]'), null);

  handle.unmount();
  cleanup();
});

test('MediaHub — 각 탭 버튼의 aria-controls 는 대응 패널 id 와 일치한다', () => {
  const handle = mount();

  const pdfTab = document.querySelector('[data-testid="media-hub-tab-pdf"]')!;
  const pptxTab = document.querySelector('[data-testid="media-hub-tab-pptx"]')!;
  assert.equal(pdfTab.getAttribute('aria-controls'), 'media-hub-panel-pdf');
  assert.equal(pptxTab.getAttribute('aria-controls'), 'media-hub-panel-pptx');
  assert.equal(pdfTab.id, 'media-hub-tab-pdf');
  assert.equal(pptxTab.id, 'media-hub-tab-pptx');

  handle.unmount();
  cleanup();
});

test('MediaHub — className prop 은 섹션 클래스에 append 된다(레이아웃 보정 훅)', () => {
  const handle = mount({ className: 'q-slot' });
  const section = document.querySelector('[data-testid="media-hub"]')!;
  assert.match(section.className, /media-hub/);
  assert.match(section.className, /q-slot/);
  handle.unmount();
  cleanup();
});
