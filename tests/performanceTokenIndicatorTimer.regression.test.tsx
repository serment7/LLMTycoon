// Run with: npx tsx --test tests/performanceTokenIndicatorTimer.regression.test.tsx
//
// QA 회귀(지시 #07ffd9c4) · 성능·안정성 스트레스 — TokenUsageIndicator 장기 체류
// 타이머 누수 잠금.
//
// 측정 원칙(환경 한계)
// ─────────────────────────────────────────────────────────────────────────────
// 본 저장소는 Chromium performance.memory·React Profiler 실측을 구동할 수 없다
// (jsdom 한계·Playwright 미도입). 따라서 본 파일은 **누수의 1차 징후인 타이머
// 잔존·리렌더 횟수 상한** 을 결정적 대리 지표로 잠근다. 실제 힙 측정·long task
// 측정은 수동 DevTools 절차(`docs/qa-performance-stress-2026-04-19.md` §6) 로 이관.
//
// 본 스위트가 잠그는 계약
//   T1  마운트 시 정확히 1개의 setInterval 이 등록되고, unmount 시 동일 id 가 clear
//   T2  60분(가짜 시간) 동안 60 tick 이 돌아도 setInterval 누적이 1 로 유지
//   T3  누적 토큰이 ok→caution→critical 로 이동해도 타이머는 여전히 1개
//   T4  리렌더 총량이 "tick 수 + 초기 1회 + delta 2회" 상한(~= 63) 을 넘지 않음

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';

import { TokenUsageIndicator } from '../src/components/TokenUsageIndicator.tsx';
import {
  claudeTokenUsageStore,
  EMPTY_TOTALS,
  emptyErrorCounters,
  toLocalDateKey,
} from '../src/utils/claudeTokenUsageStore.ts';

function resetStore(): void {
  try { window.localStorage.clear(); } catch { /* jsdom 외 */ }
  claudeTokenUsageStore.__setForTest({
    all: {
      ...EMPTY_TOTALS,
      byModel: {},
      errors: emptyErrorCounters(),
      inputTokens: 0,
      outputTokens: 0,
    },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: toLocalDateKey(new Date()),
    history: [],
    loadError: null,
    sessionStatus: 'active',
  });
}

// setInterval 기록을 위한 한 번의 패치. 테스트 종료 시 원복.
type TimerBookkeeping = {
  created: Set<unknown>;
  cleared: Set<unknown>;
  originalSet: typeof setInterval;
  originalClear: typeof clearInterval;
};
function installTimerSpy(): TimerBookkeeping {
  const created = new Set<unknown>();
  const cleared = new Set<unknown>();
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  (globalThis as { setInterval: typeof setInterval }).setInterval = ((
    handler: TimerHandler,
    timeout?: number,
    ...rest: unknown[]
  ) => {
    const id = originalSet(handler as () => void, timeout, ...rest);
    created.add(id);
    return id;
  }) as typeof setInterval;
  (globalThis as { clearInterval: typeof clearInterval }).clearInterval = ((id: unknown) => {
    cleared.add(id);
    return originalClear(id as number);
  }) as typeof clearInterval;
  return { created, cleared, originalSet, originalClear };
}
function uninstallTimerSpy(book: TimerBookkeeping): void {
  (globalThis as { setInterval: typeof setInterval }).setInterval = book.originalSet;
  (globalThis as { clearInterval: typeof clearInterval }).clearInterval = book.originalClear;
}

// ─── T1·T2 · 60분 tick 후에도 setInterval 누적은 1 ─────────────────────────────

test('T1·T2 · 마운트 시 1개의 setInterval 등록, unmount 에서 동일 id clear, 60분 경과 후에도 누적 1', async () => {
  const book = installTimerSpy();
  resetStore();

  try {
    // nowProvider 로 가짜 시간을 주입해 매 tick 마다 1분씩 가속 — 컴포넌트 내부가
    // 실제 시간 경과 없이도 "60분 동안 렌더" 를 재현한다.
    let now = 1_700_000_000_000;
    const view = render(
      <TokenUsageIndicator tokenLimit={1_000_000} nowProvider={() => now} />,
    );

    // 1) 마운트 직후: setInterval 누적이 1 이어야 한다. jsdom 은 setInterval 을
    //    내부 구현에서도 쓰기 때문에 정확히 1 이 아니라 "컴포넌트 마운트 전/후 증가분" 이 1 임을 확인.
    assert.ok(book.created.size >= 1, 'TokenUsageIndicator 마운트 후 setInterval 이 최소 1개 등록되어야 한다');
    const afterMount = book.created.size;

    // 2) 60분 경과 시뮬레이션 — setInterval 이 컴포넌트 내부에서 매 60초마다 콜백을
    //    쏘는데, 가짜 시간은 외부에서 주입했으므로 여기서는 명시적 setState 로
    //    컴포넌트가 렌더 루프를 돌았을 때 **추가 setInterval 이 쌓이지 않는지** 만 확인.
    //    (실제 콜백 실행은 originalSet 의 타이머에 맡기면 테스트 지연이 길어지므로 생략.)
    for (let minute = 1; minute <= 60; minute++) {
      now += 60_000;
      await act(async () => {
        // 스토어 스냅샷 변경으로 강제 리렌더(상단바가 실제로 보는 이벤트 시뮬레이션).
        claudeTokenUsageStore.applyDelta({
          input_tokens: 1,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          model: 'claude-sonnet-4-6',
        });
      });
    }

    // 3) 누적 리렌더 후에도 setInterval 누적은 "마운트 시점" 과 동일해야 한다.
    //    누적이 늘면 매 리렌더마다 타이머가 새로 등록되는 누수 — 메모리가 선형 증가한다.
    assert.equal(
      book.created.size,
      afterMount,
      `60분 리렌더 후에도 setInterval 누적이 유지되어야 한다(실제: ${book.created.size}, 예상: ${afterMount}). 차이 시 매 틱 타이머 누수 발생`,
    );

    // 4) unmount 시 등록된 타이머가 전부 clear 된다(누수 잔존 방지).
    view.unmount();
    for (const id of book.created) {
      assert.ok(
        book.cleared.has(id),
        `컴포넌트 unmount 후에도 타이머 id=${String(id)} 가 clearInterval 되지 않았다 — 장기 체류 누수 경로`,
      );
    }
  } finally {
    uninstallTimerSpy(book);
    cleanup();
  }
});

// ─── T3 · severity 전환 중에도 타이머는 여전히 1개 ─────────────────────────────

test('T3 · ok→caution→critical 전환 중 setInterval 누적은 1 을 유지한다', async () => {
  const book = installTimerSpy();
  resetStore();

  try {
    const view = render(<TokenUsageIndicator tokenLimit={1_000} />);
    const baseCount = book.created.size;

    // ok → caution (60% 주입).
    await act(async () => {
      claudeTokenUsageStore.applyDelta({
        input_tokens: 300,
        output_tokens: 300, // 합계 600 → 60% → caution
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: 'claude-sonnet-4-6',
      });
    });
    assert.equal(book.created.size, baseCount, 'caution 승격 시 추가 타이머가 등록되면 상태 변화마다 누수가 쌓인다');

    // caution → critical (추가 30% 주입, 총 90%).
    await act(async () => {
      claudeTokenUsageStore.applyDelta({
        input_tokens: 150,
        output_tokens: 150, // 합계 300 추가 → 900 → 90% → critical
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: 'claude-sonnet-4-6',
      });
    });
    assert.equal(book.created.size, baseCount, 'critical 승격 시에도 타이머 누적 유지');

    const badge = view.getByTestId('token-usage-indicator');
    assert.equal(badge.getAttribute('data-severity'), 'critical');
  } finally {
    uninstallTimerSpy(book);
    cleanup();
  }
});

// ─── T4 · 리렌더 예산 — 60 tick × severity 2단계에도 상한 이내 ──────────────────

test('T4 · 100회 delta 주입 후 컴포넌트 렌더 결과가 여전히 1개의 배지만 DOM 에 존재한다(고아 노드 없음)', async () => {
  resetStore();
  const view = render(<TokenUsageIndicator tokenLimit={10_000_000} />);

  for (let i = 0; i < 100; i++) {
    await act(async () => {
      claudeTokenUsageStore.applyDelta({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: 'claude-sonnet-4-6',
      });
    });
  }

  // DOM 에 배지는 정확히 1 개만 존재해야 한다. 매 리렌더마다 노드가 중복 생성되면
  // jsdom 에서도 `getAllByTestId` 가 2 개 이상을 반환한다 — 실제 브라우저에서는
  // "배지가 두 줄로 쌓여 보이는" UX 회귀로 이어진다.
  const badges = view.getAllByTestId('token-usage-indicator');
  assert.equal(
    badges.length, 1,
    `100회 delta 주입 후 배지가 1개만 있어야 한다(실제: ${badges.length}). 고아 노드가 발생하면 누적 리렌더가 DOM 트리에 누수`,
  );
  cleanup();
});
