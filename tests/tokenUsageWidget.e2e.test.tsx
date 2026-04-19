// Run with: npx tsx --test tests/tokenUsageWidget.e2e.test.tsx
//
// E2E 스모크(#2) · 지시 #3b082a16 — 상단바 토큰 사용량 위젯.
//
// 시나리오: 초기 마운트(fetch 모킹) → 스토어에 모의 delta 주입 → 배지 수치 증가 →
// 툴팁 상세 확인 → 오늘 축 리셋 → 설정 패널에서 임계값 저장 → severity 반영.
// Thanos 영역 파일(ClaudeTokenUsage.tsx · TokenUsageSettingsPanel.tsx) 은 *읽기*
// 만 수행하고 수정하지 않는다. 본 파일은 외부 행동(fetch · 사용자 이벤트) 을 모킹.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { ClaudeTokenUsage } from '../src/components/ClaudeTokenUsage.tsx';
import { TokenUsageSettingsPanel } from '../src/components/TokenUsageSettingsPanel.tsx';
import {
  claudeTokenUsageStore,
  EMPTY_TOTALS,
  emptyErrorCounters,
  toLocalDateKey,
} from '../src/utils/claudeTokenUsageStore.ts';

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

function resetStore() {
  // localStorage 도 함께 초기화해 이전 테스트의 restoreFromStorage 가 상태를 오염
  // 시키지 않게 한다. ClaudeTokenUsage 는 mount 시 restoreFromStorage 를 호출한다.
  try { window.localStorage.clear(); } catch { /* jsdom 외 환경 */ }
  claudeTokenUsageStore.__setForTest({
    all: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: toLocalDateKey(new Date()),
    history: [], loadError: null,
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

test('E2E-2a · 초기 렌더 + 모의 delta 주입 시 배지 수치가 증가하고 호출 없음 → 실수치로 전환', async () => {
  resetStore();
  const restore = installFetchStub(async (url) => {
    if (url.endsWith('/api/claude/token-usage')) {
      return new Response(JSON.stringify({ ...EMPTY_TOTALS, byModel: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not stubbed', { status: 404 });
  });

  render(React.createElement(ClaudeTokenUsage));
  await flushMicrotasks();

  const widget = () => document.querySelector('[data-testid="claude-token-usage"]')!;
  assert.ok(widget(), '위젯이 렌더되어야 한다');
  // 초기 "호출 없음"
  assert.match(widget().textContent || '', /호출 없음/, '초기 텍스트는 "호출 없음"');

  // 모의 delta 2건 주입 — 오늘 축에 누적
  act(() => {
    claudeTokenUsageStore.applyDelta({
      input_tokens: 1000, output_tokens: 500,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      model: 'claude-sonnet-4-6', at: new Date().toISOString(),
    } as any);
    claudeTokenUsageStore.applyDelta({
      input_tokens: 2000, output_tokens: 800,
      cache_read_input_tokens: 500, cache_creation_input_tokens: 0,
      model: 'claude-sonnet-4-6', at: new Date().toISOString(),
    } as any);
  });

  // 합계 4,300 토큰 = 4.3K 포맷. "호출 없음" 문구는 사라져야 한다.
  const text = widget().textContent || '';
  assert.doesNotMatch(text, /호출 없음/, '호출 후에는 "호출 없음" 문구 사라짐');
  assert.match(text, /4\.3K|4,300|4\.3/, `배지에 증가한 수치(≈4.3K)가 반영되어야 한다: ${text}`);

  cleanup();
  restore();
});

test('E2E-2b · hover 시 툴팁 상세(입력·출력·캐시·모델별) 가 노출된다', async () => {
  resetStore();
  const restore = installFetchStub(async () =>
    new Response(JSON.stringify({ ...EMPTY_TOTALS, byModel: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

  render(React.createElement(ClaudeTokenUsage));
  await flushMicrotasks();

  act(() => {
    claudeTokenUsageStore.applyDelta({
      input_tokens: 3000, output_tokens: 1000,
      cache_read_input_tokens: 500, cache_creation_input_tokens: 0,
      model: 'claude-opus-4-7', at: new Date().toISOString(),
    } as any);
  });

  // hover 진입
  const widget = document.querySelector('[data-testid="claude-token-usage"]')!;
  act(() => { fireEvent.mouseEnter(widget); });

  // 툴팁에는 모델명이 등장해야 한다(기존 회귀 test 에서도 확인된 패턴).
  const html = document.body.innerHTML;
  assert.match(html, /claude-opus-4-7/, '툴팁에 모델명 노출');
  // 입력·출력 레이블도 함께
  assert.match(html, /입력/);
  assert.match(html, /출력/);

  cleanup();
  restore();
});

test('E2E-2c · 일별 리셋(resetToday) 시 오늘 축이 0 으로, 전체 축은 유지된다', async () => {
  resetStore();
  const restore = installFetchStub(async () =>
    new Response(JSON.stringify({ ...EMPTY_TOTALS, byModel: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

  render(React.createElement(ClaudeTokenUsage));
  await flushMicrotasks();
  act(() => {
    claudeTokenUsageStore.applyDelta({
      input_tokens: 800, output_tokens: 200,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      model: 'claude-sonnet-4-6', at: new Date().toISOString(),
    } as any);
  });
  assert.equal(claudeTokenUsageStore.getSnapshot().today.callCount, 1, '오늘 축 호출 1');
  assert.equal(claudeTokenUsageStore.getSnapshot().all.callCount, 1, '전체 축 호출 1');

  act(() => { claudeTokenUsageStore.resetToday(); });

  const snap = claudeTokenUsageStore.getSnapshot();
  assert.equal(snap.today.callCount, 0, '오늘 축은 0 으로 초기화');
  assert.equal(snap.all.callCount, 1, '전체 축은 유지');

  cleanup();
  restore();
});

test('E2E-2d · 설정 패널 저장 → onApply 콜백으로 임계값이 전달된다', async () => {
  let applied: any = null;
  const handle = render(React.createElement(TokenUsageSettingsPanel, {
    initial: { caution: {}, warning: {} },
    onClose: () => {},
    onApply: (v: any) => { applied = v; },
  }));

  // 패널 내부 폼 필드는 placeholder/텍스트 기반. 정확한 testId 가 없을 수 있으니
  // `input` 셀렉터로 tokens/usd 필드를 순서대로 찾는다(cautionTokens → cautionUsd →
  // warningTokens → warningUsd 순서의 컴포넌트 선언과 일치).
  const inputs = document.querySelectorAll('input');
  assert.ok(inputs.length >= 4, `최소 4개 입력 필드 필요, 실제 ${inputs.length}`);
  const [cTokens, cUsd, wTokens, wUsd] = Array.from(inputs) as HTMLInputElement[];

  act(() => {
    fireEvent.change(cTokens, { target: { value: '50000' } });
    fireEvent.change(cUsd,    { target: { value: '0.5' } });
    fireEvent.change(wTokens, { target: { value: '200000' } });
    fireEvent.change(wUsd,    { target: { value: '2' } });
  });

  // 저장 버튼: form 을 직접 submit 하면 handleSave 경로가 동작.
  const form = document.querySelector('form');
  assert.ok(form, 'form 엘리먼트가 있어야 한다');
  await act(async () => { fireEvent.submit(form!); await new Promise(r => setTimeout(r, 0)); });

  assert.ok(applied, 'onApply 가 호출되어야 한다');
  assert.equal(applied.caution.tokens, 50000);
  assert.equal(applied.caution.usd, 0.5);
  assert.equal(applied.warning.tokens, 200000);
  assert.equal(applied.warning.usd, 2);

  handle.unmount();
  cleanup();
});
