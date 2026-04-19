// Run with: npx tsx --test tests/sharedGoalFormPostPayload.e2e.test.tsx
//
// QA 자율 회귀(#9c546bb4) — SharedGoalForm 의 저장 경로·실패 복원·레이스 방어를
// 실제 DOM 에서 잠근다. `shared-goal-form-flow-audit-20260419.md` 가 "데이터 계층
// 정상" 으로 잠근 후에도, UI 에서 서버로 나가는 페이로드·에러 복원·projectId 전환
// 시의 응답 레이스 같은 클라이언트 엣지 케이스는 P1~P4 표시 회귀와 E2E-1a~1c
// 가시성 회귀가 아직 다루지 않는 영역이다.
//
// 잠그는 4가지 계약:
//   A. POST body — title/description 은 trim, priority/status:'active' 는 고정,
//      deadline 비어 있으면 키 자체를 undefined 로 송신(서버 기본값 사용).
//   B. POST 400 실패 — saveError 배너가 노출되고 편집된 입력은 유지돼 사용자가
//      즉시 재시도할 수 있다. 재시도 성공 시 saved 배지로 승격.
//   C. fetch 예외(네트워크 끊김) — catch 경로가 onLog 로 실패를 기록하고
//      저장 버튼이 다시 활성화돼(saving=false) 사용자 입력이 보존된다.
//   D. projectId 전환 레이스 — 이전 projectId 의 GET 응답이 늦게 도착해도
//      loadSeqRef 가드가 현재 projectId 의 상태를 덮지 않는다(플리커 방지).

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { SharedGoalForm } from '../src/components/SharedGoalForm.tsx';
import type { SharedGoal } from '../src/types.ts';

// ────────────────────────────────────────────────────────────────────────────
// 공용 헬퍼
// ────────────────────────────────────────────────────────────────────────────

type Handler = (url: string, method: string, body: string | null) => Response | Promise<Response>;

function installFetchStub(handler: Handler) {
  const orig = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method || 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, method, body });
    return await handler(url, method, body);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = orig;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flushMicrotasks(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });
  }
}

/** deferred(연기된) 응답: 외부에서 resolve 를 제어할 수 있는 Response 핸들. */
function deferred<T = Response>() {
  let resolveFn!: (v: T) => void;
  const promise = new Promise<T>(res => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    fireEvent.change(el, { target: { value } });
  });
}

const VALID_TITLE = '결제 모듈 보안 강화';
const VALID_DESC = '토큰 검증과 AES 암호화, PCI 감사로그 추가 작업을 포함합니다.';

// ────────────────────────────────────────────────────────────────────────────
// A. POST body 계약
// ────────────────────────────────────────────────────────────────────────────

test('A · 저장 시 POST body 는 trim + status:"active" + priority + deadline(선택) 형식으로 고정된다', async () => {
  const savedResponse: SharedGoal = {
    projectId: 'p1',
    title: VALID_TITLE,
    description: VALID_DESC,
    priority: 'high',
    status: 'active',
    createdAt: '2026-04-19T10:00:00.000Z',
  };
  const stub = installFetchStub(async (url, method) => {
    if (method === 'GET') return jsonResponse(null);
    if (method === 'POST') return jsonResponse(savedResponse);
    return new Response('not stubbed', { status: 404 });
  });

  const logs: string[] = [];
  const handle = render(
    React.createElement(SharedGoalForm, {
      projectId: 'p1',
      onLog: (t: string) => {
        logs.push(t);
      },
    }),
  );
  await flushMicrotasks();

  // 앞뒤 공백을 섞어 입력 → POST 시 trim 되어야 한다.
  const titleEl = document.querySelector('[data-testid="shared-goal-title"]') as HTMLInputElement;
  const descEl = document.querySelector('[data-testid="shared-goal-description"]') as HTMLTextAreaElement;
  const priorityHigh = document.querySelector(
    '[data-testid="shared-goal-priority-high"]',
  ) as HTMLInputElement;
  typeInto(titleEl, `   ${VALID_TITLE}   `);
  typeInto(descEl, `\t${VALID_DESC}\n`);
  act(() => {
    fireEvent.click(priorityHigh);
  });

  const saveBtn = document.querySelector('[data-testid="shared-goal-save"]') as HTMLButtonElement;
  assert.equal(saveBtn.disabled, false, '유효 입력이면 저장 버튼 활성');

  const form = document.querySelector('form')!;
  await act(async () => {
    fireEvent.submit(form);
    await new Promise(r => setTimeout(r, 0));
  });
  await flushMicrotasks();

  const postCall = stub.calls.find(c => c.method === 'POST');
  assert.ok(postCall, 'POST 호출이 있어야 한다');
  assert.equal(postCall!.url, '/api/projects/p1/shared-goal', 'URL 경로 고정');
  const body = JSON.parse(postCall!.body ?? '{}') as Record<string, unknown>;
  assert.equal(body.title, VALID_TITLE, 'title 은 trim 된 값');
  assert.equal(body.description, VALID_DESC, 'description 은 trim 된 값');
  assert.equal(body.priority, 'high');
  assert.equal(body.status, 'active');
  assert.ok(
    !('deadline' in body) || body.deadline === undefined,
    'deadline 입력이 없으면 undefined 로 송신(키 부재 또는 undefined)',
  );

  // 성공 후 상태 배지가 saved 로 전환되어야 한다.
  const form2 = document.querySelector('[data-testid="shared-goal-form"]')!;
  assert.equal(form2.getAttribute('data-goal-state'), 'saved', '저장 성공 후 saved 상태');
  assert.ok(logs.some(m => m.includes('공동 목표를 저장했습니다')), '성공 로그 onLog 에 전달');

  handle.unmount();
  cleanup();
  stub.restore();
});

// ────────────────────────────────────────────────────────────────────────────
// B. POST 400 실패 — 편집 유지 + 재시도 승격
// ────────────────────────────────────────────────────────────────────────────

test('B · POST 400 실패 시 배너 노출 + 입력 유지 + 재시도 성공 시 saved 로 승격', async () => {
  let postAttempt = 0;
  const stub = installFetchStub(async (url, method) => {
    if (method === 'GET') return jsonResponse(null);
    if (method === 'POST') {
      postAttempt += 1;
      if (postAttempt === 1) {
        return jsonResponse({ error: '검증 실패: 제목이 너무 짧습니다' }, 400);
      }
      return jsonResponse({
        projectId: 'p1',
        title: VALID_TITLE,
        description: VALID_DESC,
        priority: 'normal',
        status: 'active',
        createdAt: '2026-04-19T10:00:00.000Z',
      } as SharedGoal);
    }
    return new Response('not stubbed', { status: 404 });
  });

  const logs: string[] = [];
  const handle = render(
    React.createElement(SharedGoalForm, {
      projectId: 'p1',
      onLog: (t: string) => logs.push(t),
    }),
  );
  await flushMicrotasks();

  const titleEl = document.querySelector('[data-testid="shared-goal-title"]') as HTMLInputElement;
  const descEl = document.querySelector(
    '[data-testid="shared-goal-description"]',
  ) as HTMLTextAreaElement;
  typeInto(titleEl, VALID_TITLE);
  typeInto(descEl, VALID_DESC);

  const form = document.querySelector('form')!;
  await act(async () => {
    fireEvent.submit(form);
    await new Promise(r => setTimeout(r, 0));
  });
  await flushMicrotasks();

  const banner = document.querySelector('[data-testid="shared-goal-save-error"]');
  assert.ok(banner, '실패 배너가 노출되어야 한다');
  assert.match(banner!.textContent ?? '', /검증 실패/);
  assert.equal(banner!.getAttribute('role'), 'alert', 'role="alert" 로 즉시 낭독');
  // 입력은 그대로 유지 — 사용자가 재시도할 수 있어야 한다.
  assert.equal(
    (document.querySelector('[data-testid="shared-goal-title"]') as HTMLInputElement).value,
    VALID_TITLE,
    '실패 후에도 title 값 유지',
  );
  assert.equal(
    (document.querySelector('[data-testid="shared-goal-description"]') as HTMLTextAreaElement).value,
    VALID_DESC,
    '실패 후에도 description 값 유지',
  );
  assert.equal(
    document.querySelector('[data-testid="shared-goal-form"]')!.getAttribute('data-goal-state'),
    'editing',
    'dirty=true 유지 → editing 상태',
  );
  assert.ok(logs.some(m => m.includes('저장 실패')), '실패 로그가 onLog 에 전달');

  // 재시도 — 이번엔 성공
  await act(async () => {
    fireEvent.submit(form);
    await new Promise(r => setTimeout(r, 0));
  });
  await flushMicrotasks();
  assert.equal(
    document.querySelector('[data-testid="shared-goal-form"]')!.getAttribute('data-goal-state'),
    'saved',
    '재시도 성공 후 saved 로 승격',
  );
  assert.equal(postAttempt, 2, 'POST 는 총 2회 시도됨');

  handle.unmount();
  cleanup();
  stub.restore();
});

// ────────────────────────────────────────────────────────────────────────────
// C. fetch 예외 — 네트워크 끊김 catch 경로
// ────────────────────────────────────────────────────────────────────────────

test('C · fetch 자체 예외 시 saveError 배너 + 저장 버튼 재활성화 + onLog 로 실패 기록', async () => {
  const stub = installFetchStub(async (_url, method) => {
    if (method === 'GET') return jsonResponse(null);
    // POST 는 Promise 가 reject 되도록 throw.
    throw new TypeError('Failed to fetch');
  });

  const logs: string[] = [];
  const handle = render(
    React.createElement(SharedGoalForm, {
      projectId: 'p1',
      onLog: (t: string) => logs.push(t),
    }),
  );
  await flushMicrotasks();

  typeInto(document.querySelector('[data-testid="shared-goal-title"]') as HTMLInputElement, VALID_TITLE);
  typeInto(
    document.querySelector('[data-testid="shared-goal-description"]') as HTMLTextAreaElement,
    VALID_DESC,
  );
  const form = document.querySelector('form')!;
  await act(async () => {
    fireEvent.submit(form);
    await new Promise(r => setTimeout(r, 0));
  });
  await flushMicrotasks();

  const banner = document.querySelector('[data-testid="shared-goal-save-error"]');
  assert.ok(banner, '네트워크 예외 시에도 배너 노출');
  assert.match(banner!.textContent ?? '', /Failed to fetch|알 수 없는 오류/);
  // 저장 버튼이 saving=false 로 되돌아와야 사용자가 재시도할 수 있다.
  const saveBtn = document.querySelector('[data-testid="shared-goal-save"]') as HTMLButtonElement;
  assert.equal(saveBtn.disabled, false, 'saving=false 로 재활성화되어 버튼 클릭 가능');
  assert.match(saveBtn.textContent ?? '', /목표 저장/, '라벨이 "저장 중…" 에서 원복');
  assert.ok(logs.some(m => m.includes('저장 실패')), '네트워크 예외도 onLog 로 흘러감');

  handle.unmount();
  cleanup();
  stub.restore();
});

// ────────────────────────────────────────────────────────────────────────────
// D. projectId 전환 레이스 — loadSeqRef 가드
// ────────────────────────────────────────────────────────────────────────────

test('D · projectId 가 p1→p2 로 전환되면 p1 의 지연된 GET 응답은 무시된다(레이스 방어)', async () => {
  const slowP1 = deferred<Response>();
  const goalP2: SharedGoal = {
    projectId: 'p2',
    title: 'P2 목표 제목',
    description: 'P2 의 상세 설명으로 20자 이상 보장합니다.',
    priority: 'normal',
    status: 'active',
    createdAt: '2026-04-19T10:00:00.000Z',
  };
  const stub = installFetchStub(async (url, method) => {
    if (method !== 'GET') return new Response('not stubbed', { status: 404 });
    if (url.includes('/p1/')) return slowP1.promise; // p1 은 일부러 느리게
    if (url.includes('/p2/')) return jsonResponse(goalP2);
    return new Response('not stubbed', { status: 404 });
  });

  const handle = render(
    React.createElement(SharedGoalForm, {
      projectId: 'p1',
      onLog: () => {},
    }),
  );
  await flushMicrotasks();
  // p1 의 GET 은 아직 pending → 폼은 loading 상태(= empty 배지).
  assert.equal(
    document.querySelector('[data-testid="shared-goal-form"]')!.getAttribute('data-goal-state'),
    'empty',
    'loading 중에는 state=empty 로 폴백',
  );

  // projectId 를 p2 로 전환. 내부적으로 loadSeqRef 가 증가한다.
  handle.rerender(
    React.createElement(SharedGoalForm, {
      projectId: 'p2',
      onLog: () => {},
    }),
  );
  await flushMicrotasks();

  // 이제 p1 의 GET 응답을 resolve — 이 응답은 stale 이므로 p2 상태를 덮으면 안 된다.
  await act(async () => {
    slowP1.resolve(
      jsonResponse({
        projectId: 'p1',
        title: 'P1 스테일 제목',
        description: 'p1 은 이미 떠났으므로 이 값은 UI 에 반영되면 안 된다.',
        priority: 'normal',
        status: 'active',
        createdAt: '2026-04-19T09:00:00.000Z',
      } as SharedGoal),
    );
    await new Promise(r => setTimeout(r, 0));
  });
  await flushMicrotasks();

  // 현재 화면의 title input 은 반드시 p2 의 제목이어야 한다.
  const titleEl = document.querySelector('[data-testid="shared-goal-title"]') as HTMLInputElement;
  assert.equal(titleEl.value, 'P2 목표 제목', 'p2 프리필이 유지되어야 한다(p1 응답 무시)');
  assert.equal(
    document.querySelector('[data-testid="shared-goal-form"]')!.getAttribute('data-goal-state'),
    'saved',
    'p2 활성 목표 → saved 배지',
  );

  handle.unmount();
  cleanup();
  stub.restore();
});
