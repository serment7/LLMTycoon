// Run with: npx tsx --test tests/sharedGoalFormAccess.e2e.test.tsx
//
// E2E 스모크(#1) · 지시 #3b082a16 — 공동 목표 폼 접근.
//
// Playwright 는 본 저장소 devDeps 에 없으므로(docs/qa-uat-2026-04-19.md §5.3 CR-3),
// 프로젝트 표준 러너(node:test + tsx + global-jsdom + @testing-library/react) 로
// "프로젝트 관리 메뉴 진입" 경로의 핵심 계약을 검증한다. 실제 ProjectManagement
// 전체 트리는 많은 외부 fetch 를 요구해 스모크 범위를 넘기므로, 마운트 대상은
// ProjectManagement 내부에서 실제로 쓰이는 `SharedGoalForm` 자식 컴포넌트로 한정.
// 두 컴포넌트의 연결 계약은 별도 정적 회귀(projectManagementSharedGoalMount) 가
// 이미 잠그고 있으므로, 본 E2E 는 **UI 레벨 사용자 경로** 만 커버한다.
//
// 외부 I/O: globalThis.fetch 를 test-local stub 으로 교체. 네트워크 호출 없음.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { SharedGoalForm } from '../src/components/SharedGoalForm.tsx';
import type { SharedGoal } from '../src/types.ts';

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface FetchEvent {
  url: string;
  method: string;
  body?: unknown;
}

function installFetchStub(handler: (e: FetchEvent) => Response | Promise<Response>): {
  restore: () => void;
  events: FetchEvent[];
} {
  const events: FetchEvent[] = [];
  const orig = globalThis.fetch;
  const stub: FetchStub = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? safeParse(String(init.body)) : undefined;
    const e: FetchEvent = { url, method, body };
    events.push(e);
    return await handler(e);
  };
  (globalThis as unknown as { fetch: FetchStub }).fetch = stub;
  return {
    restore: () => { (globalThis as unknown as { fetch: typeof orig }).fetch = orig; },
    events,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise(r => setTimeout(r, 0));
  });
}

test('E2E-1a · 프로젝트 관리 진입 + GET 빈 응답 → SharedGoalForm 이 empty 상태로 보인다', async () => {
  const { restore, events } = installFetchStub(async ({ url, method }) => {
    if (url.endsWith('/shared-goal') && method === 'GET') return jsonResponse(null);
    return new Response('not stubbed', { status: 404 });
  });

  const logs: string[] = [];
  const handle = render(React.createElement(SharedGoalForm, {
    projectId: 'p-empty', onLog: (t: string) => logs.push(t),
  }));
  await flushMicrotasks();

  const form = document.querySelector('[data-testid="shared-goal-form"]')!;
  assert.ok(form, '폼 컨테이너가 렌더되어야 한다');
  assert.equal(form.getAttribute('data-goal-state'), 'empty', '빈 응답 → empty 상태');
  assert.ok(document.querySelector('[data-testid="shared-goal-badge-empty"]'), '"목표 미입력" 배지');
  assert.equal(events.filter(e => e.method === 'GET').length, 1, 'GET 1회');

  handle.unmount();
  cleanup();
  restore();
});

test('E2E-1b · 사용자가 입력하면 배지가 editing 으로, 유효할 때 저장 버튼이 활성화된다', async () => {
  const { restore } = installFetchStub(async ({ url, method }) => {
    if (url.endsWith('/shared-goal') && method === 'GET') return jsonResponse(null);
    return new Response('not stubbed', { status: 404 });
  });

  render(React.createElement(SharedGoalForm, {
    projectId: 'p-edit', onLog: () => {},
  }));
  await flushMicrotasks();

  const title = document.querySelector('[data-testid="shared-goal-title"]') as HTMLInputElement;
  const desc = document.querySelector('[data-testid="shared-goal-description"]') as HTMLTextAreaElement;
  const saveBtn = () => document.querySelector('[data-testid="shared-goal-save"]') as HTMLButtonElement;

  // 초기: 저장 비활성
  assert.equal(saveBtn().disabled, true, '입력 전 저장 버튼은 비활성');

  // 짧은 입력 → editing 배지만, 저장은 여전히 비활성(길이 미달)
  act(() => { fireEvent.change(title, { target: { value: '짧음' } }); });
  assert.equal(document.querySelector('[data-testid="shared-goal-form"]')!.getAttribute('data-goal-state'), 'editing');
  assert.ok(document.querySelector('[data-testid="shared-goal-badge-editing"]'));
  assert.equal(saveBtn().disabled, true, '길이 미달 → 여전히 비활성');

  // 규격 만족 입력 → 활성화
  act(() => {
    fireEvent.change(title, { target: { value: '결제 모듈 보안 강화' } });
    fireEvent.change(desc,  { target: { value: '토큰 검증·AES 암호화·PCI 감사로그 추가 및 정책 점검' } });
  });
  assert.equal(saveBtn().disabled, false, '규격 만족 → 저장 활성화');

  cleanup();
  restore();
});

test('E2E-1c · 저장 POST 성공 후에도 컴포넌트는 유지되고 saved 상태로 전환된다', async () => {
  let capturedPostBody: any = null;
  const saved: SharedGoal = {
    id: 'goal-1', projectId: 'p-save', title: '결제 모듈 보안 강화',
    description: '토큰 검증·AES 암호화·PCI 감사로그 추가 및 정책 점검',
    priority: 'high', status: 'active',
    createdAt: '2026-04-19T10:00:00.000Z',
  };
  const { restore, events } = installFetchStub(async ({ url, method, body }) => {
    if (url.endsWith('/shared-goal') && method === 'GET') return jsonResponse(null);
    if (url.endsWith('/shared-goal') && method === 'POST') {
      capturedPostBody = body;
      return jsonResponse(saved);
    }
    return new Response('not stubbed', { status: 404 });
  });

  const logs: string[] = [];
  render(React.createElement(SharedGoalForm, {
    projectId: 'p-save', onLog: (t: string) => logs.push(t),
  }));
  await flushMicrotasks();

  act(() => {
    fireEvent.change(document.querySelector('[data-testid="shared-goal-title"]') as HTMLInputElement,
      { target: { value: saved.title } });
    fireEvent.change(document.querySelector('[data-testid="shared-goal-description"]') as HTMLTextAreaElement,
      { target: { value: saved.description } });
    fireEvent.click(document.querySelector('[data-testid="shared-goal-priority-high"]') as HTMLInputElement);
  });

  const form = document.querySelector('[data-testid="shared-goal-form"]') as HTMLFormElement;
  await act(async () => {
    fireEvent.submit(form.querySelector('form')!);
    await new Promise(r => setTimeout(r, 0));
  });

  // 컴포넌트는 여전히 마운트
  assert.ok(document.querySelector('[data-testid="shared-goal-form"]'), '폼이 DOM 에 유지된다');
  // saved 배지 전환
  assert.equal(
    document.querySelector('[data-testid="shared-goal-form"]')!.getAttribute('data-goal-state'),
    'saved',
  );
  assert.ok(document.querySelector('[data-testid="shared-goal-badge-saved"]'));
  // 서버로 보낸 바디가 기대대로
  assert.equal(capturedPostBody.title, saved.title);
  assert.equal(capturedPostBody.priority, 'high');
  assert.equal(capturedPostBody.status, 'active');
  // 로그 기록
  assert.ok(logs.some(l => l.includes('저장했습니다')), '저장 성공 로그 1회');
  // GET 1회 + POST 1회
  assert.equal(events.filter(e => e.method === 'GET').length, 1);
  assert.equal(events.filter(e => e.method === 'POST').length, 1);

  cleanup();
  restore();
});
