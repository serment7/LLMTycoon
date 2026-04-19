// Run with: npx tsx --test tests/tokenExhaustedFallback.regression.test.tsx
//
// QA 회귀(#8888a819) — 토큰 만료 폴백의 UI 3축 검증.
//   ① ClaudeTokenUsage 가 sessionStatus='exhausted' 에서 영구 배너를 노출한다.
//   ② DirectivePrompt readOnlyMode=true 에서 전송 버튼과 파일 선택이 잠긴다.
//   ③ SharedGoalForm readOnlyMode=true 에서 저장 버튼이 잠기고 한국어 안내가 붙는다.
//   ④ ToastProvider 의 4 variant 팔레트가 디자이너 시안 §3.2 (info/warning/error/success)
//      와 1:1 매핑되어 각 variant 별 `--toast-*` 토큰을 소비한다.
//
// 지시 본문이 언급한 "디자이너 4단계 시안" 은 `tests/token-fallback-states-mockup.md`
// §3.2 의 토스트 승격 규약(F1→F2 info / F2→F3 warning / F3→F4 error / 강등 success)
// 을 가리킨다. 실 구현의 `ClaudeSessionStatus` 는 3단계(active/warning/exhausted) 이므로,
// "exhausted = F4" 시점의 UI 축만 본 파일이 잠그고, 전이별 토스트 발사 계약은
// 추후 `tokenFallbackTransitions.regression.test.ts` 에서 별도 잠근다(시안 §8.6).

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { ClaudeTokenUsage } from '../src/components/ClaudeTokenUsage.tsx';
import { DirectivePrompt } from '../src/components/DirectivePrompt.tsx';
import { SharedGoalForm } from '../src/components/SharedGoalForm.tsx';
import {
  claudeTokenUsageStore,
  EMPTY_TOTALS,
  emptyErrorCounters,
  toLocalDateKey,
} from '../src/utils/claudeTokenUsageStore.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOAST_SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'ToastProvider.tsx'),
  'utf8',
);

// ────────────────────────────────────────────────────────────────────────────
// 공용 헬퍼
// ────────────────────────────────────────────────────────────────────────────

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function installFetchStub(body: object = { ...EMPTY_TOTALS, byModel: {} }) {
  const orig = globalThis.fetch;
  const stub: FetchStub = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  (globalThis as unknown as { fetch: FetchStub }).fetch = stub;
  return () => {
    (globalThis as unknown as { fetch: typeof orig }).fetch = orig;
  };
}

function resetStore(overrides: Record<string, unknown> = {}) {
  try {
    window.localStorage.clear();
  } catch {
    /* SSR */
  }
  claudeTokenUsageStore.__setForTest({
    all: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: toLocalDateKey(new Date()),
    history: [],
    loadError: null,
    sessionStatus: 'active',
    sessionStatusReason: undefined,
    ...overrides,
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise(r => setTimeout(r, 0));
  });
}

// ────────────────────────────────────────────────────────────────────────────
// ① ClaudeTokenUsage — exhausted 배너
// ────────────────────────────────────────────────────────────────────────────

test('ClaudeTokenUsage — sessionStatus="exhausted" 이면 영구 경고 배너가 role="alert"+aria-live="assertive" 로 노출된다', async () => {
  resetStore();
  const restore = installFetchStub();
  const handle = render(React.createElement(ClaudeTokenUsage));
  await flushMicrotasks();

  assert.equal(
    document.querySelector('[data-testid="claude-token-exhausted-banner"]'),
    null,
    '초기 active 상태에서는 배너가 없다',
  );

  act(() => {
    claudeTokenUsageStore.setSessionStatus('exhausted', '월 할당량이 소진되었습니다.');
  });
  await flushMicrotasks();

  const banner = document.querySelector('[data-testid="claude-token-exhausted-banner"]');
  assert.ok(banner, 'exhausted 로 전이되면 배너가 DOM 에 등장해야 한다');
  assert.equal(banner!.getAttribute('role'), 'alert');
  assert.equal(banner!.getAttribute('aria-live'), 'assertive');
  assert.match(banner!.textContent ?? '', /토큰 소진|읽기 전용/);
  assert.match(banner!.textContent ?? '', /월 할당량이 소진되었습니다/);

  // data-session-status 속성이 루트에 박혀 QA 가 색 비교 없이 상태 감지 가능.
  const root = document.querySelector('[data-testid="claude-token-usage"]');
  assert.equal(root?.getAttribute('data-session-status'), 'exhausted');

  handle.unmount();
  cleanup();
  restore();
});

test('ClaudeTokenUsage — active 로 복귀하면 배너가 즉시 제거된다(강등 복원)', async () => {
  resetStore({ sessionStatus: 'exhausted', sessionStatusReason: '만료' });
  const restore = installFetchStub();
  const handle = render(React.createElement(ClaudeTokenUsage));
  await flushMicrotasks();

  assert.ok(
    document.querySelector('[data-testid="claude-token-exhausted-banner"]'),
    '초기에 exhausted → 배너 존재',
  );

  act(() => {
    claudeTokenUsageStore.setSessionStatus('active', undefined);
  });
  await flushMicrotasks();

  assert.equal(
    document.querySelector('[data-testid="claude-token-exhausted-banner"]'),
    null,
    '복귀 후 배너 제거',
  );
  handle.unmount();
  cleanup();
  restore();
});

// ────────────────────────────────────────────────────────────────────────────
// ② DirectivePrompt — readOnlyMode 가드
// ────────────────────────────────────────────────────────────────────────────

test('DirectivePrompt — readOnlyMode=true 이면 전송 버튼 disabled + aria-label 에 "읽기 전용" 안내', () => {
  const handle = render(
    React.createElement(DirectivePrompt, {
      value: '지시 본문',
      onChange: () => {},
      attachments: [],
      onFilesAdded: () => {},
      onRemove: () => {},
      onSubmit: () => {},
      submitLabel: '전송',
      readOnlyMode: true,
    }),
  );

  const root = document.querySelector('[data-read-only="true"]');
  assert.ok(root, '루트에 data-read-only=true 속성이 박혀야 한다');
  assert.equal(root!.getAttribute('aria-disabled'), 'true', 'aria-disabled 로 전파');

  // 전송 버튼 탐색 — 내부 구조상 type="button" 중 aria-label 이 "읽기 전용" 안내를 갖는 것.
  const buttons = Array.from(document.querySelectorAll('button[aria-label]')) as HTMLButtonElement[];
  const submitBtn = buttons.find(b => /읽기 전용/.test(b.getAttribute('aria-label') ?? ''));
  assert.ok(submitBtn, '읽기 전용 안내가 포함된 전송 버튼이 있어야 한다');
  assert.equal(submitBtn!.disabled, true, 'disabled 로 잠겨 있어야 한다');
  assert.match(
    submitBtn!.getAttribute('aria-label') ?? '',
    /전송.*읽기 전용 모드에서는 전송 불가/,
  );

  handle.unmount();
  cleanup();
});

test('DirectivePrompt — readOnlyMode=false 이면 전송 버튼은 활성이고 읽기 전용 aria-label 이 없다', () => {
  const handle = render(
    React.createElement(DirectivePrompt, {
      value: '유효한 지시 본문',
      onChange: () => {},
      attachments: [],
      onFilesAdded: () => {},
      onRemove: () => {},
      onSubmit: () => {},
      submitLabel: '전송',
      readOnlyMode: false,
    }),
  );
  const root = document.querySelector('[data-read-only="false"]');
  assert.ok(root, '루트 data-read-only=false');
  const buttons = Array.from(document.querySelectorAll('button[aria-label]')) as HTMLButtonElement[];
  const lockedBtn = buttons.find(b => /읽기 전용/.test(b.getAttribute('aria-label') ?? ''));
  assert.equal(lockedBtn, undefined, '활성 모드에서는 "읽기 전용" 라벨이 없어야 한다');
  handle.unmount();
  cleanup();
});

// ────────────────────────────────────────────────────────────────────────────
// ③ SharedGoalForm — readOnlyMode 가드
// ────────────────────────────────────────────────────────────────────────────

test('SharedGoalForm — readOnlyMode=true 이면 저장 버튼이 disabled 되고 한국어 title/aria-label 이 붙는다', async () => {
  const restore = installFetchStub(null); // GET 응답 null → empty 모드
  const handle = render(
    React.createElement(SharedGoalForm, {
      projectId: 'p1',
      onLog: () => {},
      readOnlyMode: true,
    }),
  );
  await flushMicrotasks();

  const root = document.querySelector('[data-testid="shared-goal-form"]');
  assert.equal(root?.getAttribute('data-read-only'), 'true');
  assert.equal(root?.getAttribute('aria-readonly'), 'true');

  const saveBtn = document.querySelector('[data-testid="shared-goal-save"]') as HTMLButtonElement;
  assert.ok(saveBtn, '저장 버튼 존재');
  assert.equal(saveBtn.disabled, true, 'readOnlyMode 에서 항상 disabled');
  assert.match(
    saveBtn.getAttribute('aria-label') ?? '',
    /목표 저장.*읽기 전용 모드에서는 저장 불가/,
  );
  assert.match(
    saveBtn.getAttribute('title') ?? '',
    /토큰이 소진되어 저장이 잠시 중단/,
  );

  handle.unmount();
  cleanup();
  restore();
});

// ────────────────────────────────────────────────────────────────────────────
// ④ ToastProvider — 4 variant 팔레트 × 디자이너 시안 §3.2 매핑
// ────────────────────────────────────────────────────────────────────────────

test('ToastProvider — 4 variant(success/info/warning/error) 의 팔레트가 모두 --toast-{variant}-* 토큰을 소비한다', () => {
  // 시안 §3.2 가 정의한 단계별 매핑(F1→F2 info, F2→F3 warning, F3→F4 error, 강등 success)
  // 이 한 쪽만 누락되어도 UI 톤이 뒤섞인다. 4 variant 모두 최소 5종 토큰을 참조해야 한다.
  for (const variant of ['success', 'info', 'warning', 'error']) {
    for (const axis of ['bg', 'border', 'strip', 'icon-fg', 'title-fg']) {
      const token = `--toast-${variant}-${axis}`;
      assert.ok(
        TOAST_SRC.includes(token),
        `ToastProvider 가 토큰 ${token} 를 소비해야 한다(시안 §3.2 매핑)`,
      );
    }
  }
});

test('ToastProvider — warning/error 는 assertive, success/info 는 polite 로 role·aria-live 분기된다(T-10)', () => {
  assert.match(
    TOAST_SRC,
    /variant\s*===\s*['"]warning['"]\s*\|\|\s*variant\s*===\s*['"]error['"]/,
    'isAssertive 분기 판정이 warning · error 두 케이스 모두를 잡아야 한다',
  );
  assert.match(
    TOAST_SRC,
    /role=\{isAssertive\s*\?\s*['"]alert['"]\s*:\s*['"]status['"]\}/,
  );
  assert.match(
    TOAST_SRC,
    /aria-live=\{isAssertive\s*\?\s*['"]assertive['"]\s*:\s*['"]polite['"]\}/,
  );
});

test('ToastProvider — error 의 기본 duration 은 0(무기한)이다(시안 F3→F4 무기한 규약)', () => {
  assert.match(
    TOAST_SRC,
    /DEFAULT_DURATION:\s*Record<ToastVariant,\s*number>\s*=\s*\{[\s\S]{0,200}error:\s*0/,
    '시안 §3.1: F3→F4 전이 토스트는 duration=0 으로 사용자가 닫을 때까지 유지',
  );
});
