// Run with: npx tsx --test tests/graphResetAndAutomation.e2e.test.tsx
//
// E2E 스모크(#3) · 지시 #3b082a16 — '그래프 초기화' 버튼 경로 + GitAutomationPanel
// "새로고침 후 설정 유지" 계약.
//
// App.tsx 상단 툴바 전체 렌더는 fetch·socket 등 외부 의존성이 커서 스모크 범위를
// 초과한다. 본 테스트는 동일한 계약을 두 분리된 단위로 검증한다:
//
//   (a) '그래프 초기화' 핸들러 시나리오: POST /api/graph/reset 성공 → useToast 로
//        success 토스트 노출. App.tsx 에서 합류 예정인 호출 흐름을 ToastProvider 의
//        공개 API 만 소비해 재현한다.
//   (b) GitAutomationPanel 의 onSave 페이로드 + 동일 initial 로 "재마운트(= 새로고침
//        흉내)" 시 같은 상태가 복원되는지 확인.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { ToastProvider, useToast } from '../src/components/ToastProvider.tsx';
import {
  DEFAULT_AUTOMATION,
  GitAutomationPanel,
  type GitAutomationSettings,
} from '../src/components/GitAutomationPanel.tsx';

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function installFetchStub(handler: (url: string, method: string) => Response | Promise<Response>) {
  const orig = globalThis.fetch;
  const stub: FetchStub = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    return await handler(url, (init?.method || 'GET').toUpperCase());
  };
  (globalThis as unknown as { fetch: FetchStub }).fetch = stub;
  return () => { (globalThis as unknown as { fetch: typeof orig }).fetch = orig; };
}

async function flushMicrotasks() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

// ─── (a) 그래프 초기화 → 토스트 ────────────────────────────────────────────────

/** App.tsx 상단 툴바의 '그래프 초기화' 버튼을 대체하는 스모크용 소비자 컴포넌트.
 *  실제 App.tsx 로직이 useToast 합류 후 사용할 것과 동일한 API 를 호출한다. */
function GraphResetButtonProbe() {
  const toast = useToast();
  return (
    <button
      type="button"
      data-testid="probe-graph-reset"
      onClick={async () => {
        const res = await fetch('/api/graph/reset', { method: 'POST' });
        if (res.ok) {
          toast.push({ id: 'graph-reset-ok', variant: 'success', title: '그래프 초기화 완료' });
        } else {
          toast.push({ id: 'graph-reset-err', variant: 'error', title: '그래프 초기화 실패' });
        }
      }}
    >그래프 초기화</button>
  );
}

test('E2E-3a · 그래프 초기화 성공 시 success 토스트가 ToastContainer 에 노출된다', async () => {
  const restore = installFetchStub(async (url, method) => {
    if (url.endsWith('/api/graph/reset') && method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('not stubbed', { status: 404 });
  });

  render(React.createElement(ToastProvider, null,
    React.createElement(GraphResetButtonProbe)));
  await flushMicrotasks();

  const btn = document.querySelector('[data-testid="probe-graph-reset"]') as HTMLButtonElement;
  assert.ok(btn);
  await act(async () => { fireEvent.click(btn); await new Promise(r => setTimeout(r, 0)); });

  const toast = document.querySelector('[data-toast-id="graph-reset-ok"]');
  assert.ok(toast, '성공 토스트가 DOM 에 나타나야 한다');
  assert.equal(toast!.getAttribute('data-toast-variant'), 'success');
  assert.equal(toast!.getAttribute('role'), 'status');
  assert.match(toast!.textContent || '', /그래프 초기화 완료/);

  cleanup();
  restore();
});

test('E2E-3b · 그래프 초기화 실패 시 error 토스트가 alert role 로 노출된다', async () => {
  const restore = installFetchStub(async (url, method) => {
    if (url.endsWith('/api/graph/reset') && method === 'POST') {
      return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('not stubbed', { status: 404 });
  });

  render(React.createElement(ToastProvider, null,
    React.createElement(GraphResetButtonProbe)));
  await flushMicrotasks();

  await act(async () => {
    (document.querySelector('[data-testid="probe-graph-reset"]') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
  });

  const toast = document.querySelector('[data-toast-id="graph-reset-err"]');
  assert.ok(toast, '실패 토스트가 DOM 에 있어야 한다');
  assert.equal(toast!.getAttribute('data-toast-variant'), 'error');
  assert.equal(toast!.getAttribute('role'), 'alert');

  cleanup();
  restore();
});

// ─── (b) GitAutomationPanel 새로고침 후 유지 ──────────────────────────────────

test('E2E-3c · GitAutomationPanel — 변경 후 저장 시 onSave 페이로드에 편집 내용이 담긴다', async () => {
  let saved: GitAutomationSettings | null = null;
  render(React.createElement(GitAutomationPanel, {
    initial: DEFAULT_AUTOMATION,
    onSave: (v: GitAutomationSettings) => { saved = v; },
    onLog: () => {},
  } as any));
  await flushMicrotasks();

  // 저장 버튼은 `disabled={!dirty}` 이므로 먼저 변경 사항을 만들어 dirty 로 전환한다.
  // branchPattern 입력 필드 value 를 바꿔 dirty 를 유도한다.
  const inputs = Array.from(document.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
  const branchPatternInput = inputs.find(i => i.value === DEFAULT_AUTOMATION.branchPattern);
  assert.ok(branchPatternInput, 'branchPattern 입력 필드가 있어야 한다');
  act(() => { fireEvent.change(branchPatternInput!, { target: { value: 'hotfix/{ticket}-{branch}' } }); });

  const saveBtn = Array.from(document.querySelectorAll('button'))
    .find(b => /저장\s*·/.test(b.textContent || '')) as HTMLButtonElement | undefined;
  assert.ok(saveBtn, '패널에 저장 버튼이 있어야 한다');
  assert.equal(saveBtn!.disabled, false, '변경 후 저장 버튼이 활성화되어야 한다');
  await act(async () => { saveBtn!.click(); await new Promise(r => setTimeout(r, 0)); });

  assert.ok(saved, 'onSave 가 호출되어야 한다');
  assert.equal(saved!.branchPattern, 'hotfix/{ticket}-{branch}', '사용자 입력이 저장 페이로드에 반영');
  assert.equal(saved!.flow, DEFAULT_AUTOMATION.flow, '편집하지 않은 필드는 initial 유지');
  assert.equal(saved!.commitTemplate, DEFAULT_AUTOMATION.commitTemplate);

  cleanup();
});

test('E2E-3d · "새로고침 흉내" — 동일 initial 로 재마운트하면 input value 가 그대로 복원된다', async () => {
  const custom: GitAutomationSettings = {
    ...DEFAULT_AUTOMATION,
    flow: 'commit-push',
    branchPattern: 'feat/{ticket}-{branch}',
    commitTemplate: 'chore: {branch}',
    prTitleTemplate: '[{ticket}] chore — {branch}',
    enabled: false,
    branchStrategy: 'per-task',
    newBranchName: '',
  };
  // 첫 마운트
  const handle1 = render(React.createElement(GitAutomationPanel, {
    initial: custom, onSave: () => {}, onLog: () => {},
  } as any));
  await flushMicrotasks();
  const firstBranchPattern = (
    Array.from(document.querySelectorAll('input[type="text"]')) as HTMLInputElement[]
  ).find(i => i.value === custom.branchPattern);
  assert.ok(firstBranchPattern, '첫 마운트에서 custom.branchPattern 이 반영');
  handle1.unmount();
  cleanup();

  // 재마운트(= 새로고침 흉내) — 브라우저 탭을 새로 여는 것과 동일한 "빈 로컬 state →
  // initial 로 baseline 설정" 경로. 복원 계약은 "같은 initial 이면 input value 가 같다".
  render(React.createElement(GitAutomationPanel, {
    initial: custom, onSave: () => {}, onLog: () => {},
  } as any));
  await flushMicrotasks();
  const inputsB = Array.from(document.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
  const branchPatternInputB = inputsB.find(i => i.value === custom.branchPattern);
  const commitTemplateInputB = inputsB.find(i => i.value === custom.commitTemplate);
  const prTitleInputB = inputsB.find(i => i.value === custom.prTitleTemplate);
  assert.ok(branchPatternInputB, '재마운트 후에도 custom.branchPattern 이 input value 에 보존');
  assert.ok(commitTemplateInputB, 'commitTemplate 보존');
  assert.ok(prTitleInputB, 'prTitleTemplate 보존');

  cleanup();
});
