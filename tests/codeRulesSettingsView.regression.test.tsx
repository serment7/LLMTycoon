// Run with: npx tsx --test tests/codeRulesSettingsView.regression.test.tsx
//
// 지시 #586ea74c — CodeRulesSettings 뷰 회귀 잠금.
// 축:
//   V1. 초기 로딩이 ready 로 수렴하면 폼·탭 골격이 DOM 에 렌더된다.
//   V2. 범위 탭이 role="tablist" + aria-selected + aria-controls 3축을 만족 (시안 R-QA-01).
//   V3. 저장 성공 시 변경 이력이 기록되고 saveStatus 가 idle 로 수렴.
//   V4. 저장 실패 시 form 상태가 직전 baseline 으로 롤백되고 saveStatus=error.
//   V5. 로컬·전역 레코드가 서로 다르면 충돌 배너가 발화.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { CodeRulesSettings } from '../src/views/settings/CodeRulesSettings.tsx';
import {
  createCodeRulesStore,
  createMemoryCodeRulesStorage,
  type CodeRulesStore,
} from '../src/stores/codeRulesStore.ts';

function mount(store: CodeRulesStore, projectId = 'P1') {
  return render(React.createElement(CodeRulesSettings, { projectId, store }));
}

function clearLocalStorage() {
  try { window.localStorage?.clear(); } catch { /* ignore */ }
}

test('V1. 초기 로딩이 ready 로 수렴하면 폼·탭 골격이 DOM 에 렌더된다', async () => {
  clearLocalStorage();
  const store = createCodeRulesStore({ adapter: createMemoryCodeRulesStorage() });
  const handle = mount(store);
  await waitFor(() => {
    assert.ok(document.querySelector('[data-testid="code-rules-settings"]'), 'ready DOM 발현');
  });
  assert.ok(document.querySelector('[role="tablist"]'));
  assert.ok(document.querySelector('[aria-label="들여쓰기 스타일"]'));
  assert.ok(document.querySelector('[aria-label="따옴표 스타일"]'));
  assert.ok(document.querySelector('[aria-label="세미콜론 정책"]'));
  handle.unmount();
  cleanup();
});

test('V2. 범위 탭이 tablist + aria-selected + aria-controls 3축을 만족한다', async () => {
  clearLocalStorage();
  const store = createCodeRulesStore({ adapter: createMemoryCodeRulesStorage() });
  const handle = mount(store);
  await waitFor(() => {
    assert.ok(document.querySelector('[data-testid="code-rules-settings"]'));
  });
  const tabs = document.querySelectorAll('[role="tab"]');
  assert.equal(tabs.length, 2);
  const local = document.getElementById('rules-scope-tab-local');
  const global = document.getElementById('rules-scope-tab-global');
  assert.ok(local && global);
  assert.equal(local?.getAttribute('aria-controls'), 'rules-scope-panel-local');
  assert.equal(global?.getAttribute('aria-controls'), 'rules-scope-panel-global');
  // 기본 탭은 local.
  assert.equal(local?.getAttribute('aria-selected'), 'true');
  assert.equal(global?.getAttribute('aria-selected'), 'false');
  // 전역 탭 클릭 → aria-selected 반전, 대응 tabpanel id 존재.
  act(() => { fireEvent.click(global!); });
  await waitFor(() => {
    assert.equal(global?.getAttribute('aria-selected'), 'true');
  });
  assert.ok(document.getElementById('rules-scope-panel-global'));
  handle.unmount();
  cleanup();
});

test('V3. 저장 성공 시 이력이 쌓이고 saveStatus 가 idle 로 수렴', async () => {
  clearLocalStorage();
  const store = createCodeRulesStore({ adapter: createMemoryCodeRulesStorage() });
  const handle = mount(store);
  await waitFor(() => {
    assert.ok(document.querySelector('[data-testid="code-rules-settings"]'));
  });
  // 들여쓰기 크기를 2 → 4 로 변경해 dirty 유도.
  const sizeInput = document.querySelector('[aria-label="들여쓰기 크기"]') as HTMLInputElement;
  act(() => { fireEvent.change(sizeInput, { target: { value: '4' } }); });
  await waitFor(() => {
    const badge = document.querySelector('[data-testid="code-rules-save-status"]');
    assert.match(badge?.textContent ?? '', /저장되지 않음/);
  });
  // 저장 버튼 클릭.
  const saveBtn = document.querySelector('[aria-label="코드 규칙 저장"]') as HTMLButtonElement;
  await act(async () => { fireEvent.click(saveBtn); });
  await waitFor(() => {
    const badge = document.querySelector('[data-testid="code-rules-save-status"]');
    assert.match(badge?.textContent ?? '', /저장됨/);
  });
  // 이력 localStorage 에 1건 이상.
  const raw = window.localStorage.getItem('llmtycoon:code-rules-history:local:P1');
  assert.ok(raw);
  const entries = JSON.parse(raw!);
  assert.ok(Array.isArray(entries) && entries.length >= 1);
  assert.match(entries[0].summary, /indentation/);
  handle.unmount();
  cleanup();
});

test('V4. 저장 실패 시 form 이 baseline 으로 롤백되고 saveStatus=error', async () => {
  clearLocalStorage();
  const base = createCodeRulesStore({ adapter: createMemoryCodeRulesStorage() });
  // save 만 rejection 으로 오염한 래퍼.
  const failing: CodeRulesStore = {
    ...base,
    save: async () => { throw new Error('boom'); },
  };
  const handle = mount(failing);
  await waitFor(() => {
    assert.ok(document.querySelector('[data-testid="code-rules-settings"]'));
  });
  const sizeInput = document.querySelector('[aria-label="들여쓰기 크기"]') as HTMLInputElement;
  act(() => { fireEvent.change(sizeInput, { target: { value: '6' } }); });
  const saveBtn = document.querySelector('[aria-label="코드 규칙 저장"]') as HTMLButtonElement;
  await act(async () => { fireEvent.click(saveBtn); });
  await waitFor(() => {
    const badge = document.querySelector('[data-testid="code-rules-save-status"]');
    assert.match(badge?.textContent ?? '', /저장 실패/);
  });
  // 롤백: form 의 indentSize 가 baseline(기본값 2)으로 되돌아온다.
  const sizeAfter = document.querySelector('[aria-label="들여쓰기 크기"]') as HTMLInputElement;
  assert.equal(sizeAfter.value, '2', '롤백 후 크기가 baseline 으로 복원');
  handle.unmount();
  cleanup();
});

test('V5. 로컬·전역 레코드가 달라지면 충돌 배너가 발화', async () => {
  clearLocalStorage();
  const store = createCodeRulesStore({ adapter: createMemoryCodeRulesStorage() });
  await store.save({ scope: 'global', quotes: 'single', semicolons: 'required' });
  await store.save({ scope: 'local', projectId: 'P1', quotes: 'double', semicolons: 'omit' });
  const handle = mount(store);
  await waitFor(() => {
    assert.ok(document.querySelector('[data-testid="code-rules-settings"]'));
  });
  // 충돌 배너 role="status" + 본문 키워드.
  const banner = Array.from(document.querySelectorAll('[role="status"]'))
    .find((el) => /로컬과 전역이 충돌합니다/.test(el.textContent ?? ''));
  assert.ok(banner, '충돌 배너가 렌더되어야 함');
  handle.unmount();
  cleanup();
});
