// Run with: npx tsx --test tests/tokenUsageIndicator.e2e.test.tsx
//
// E2E 스모크 — 상단바 <TokenUsageIndicator/> (구독 세션 남은 토큰 배지) UI 계약.
//
// 목적:
//  1) 스토어 `loadError` 가 있으면 "토큰 정보 없음" 폴백 배지가 렌더되고 크래시가 없다.
//  2) 누적 토큰이 주입되면 data-severity 가 ok → caution → critical 로 승격된다.
//  3) 호버 시 툴팁이 열리고 "리셋 예정" 라벨이 노출된다.
//
// 계산 계약(5시간 리셋, 비율→severity) 은 claudeSubscriptionSession.regression.test
// 가 순수 함수 단위로 잠갔으므로 본 파일은 "스토어 값 → 컴포넌트 출력" 경로만 확인.

import 'global-jsdom/register';
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { TokenUsageIndicator } from '../src/components/TokenUsageIndicator.tsx';
import {
  claudeTokenUsageStore,
  EMPTY_TOTALS,
  emptyErrorCounters,
  toLocalDateKey,
} from '../src/utils/claudeTokenUsageStore.ts';

function resetStore(overrides: Partial<{ inputTokens: number; outputTokens: number; loadError: string | null }> = {}): void {
  try { window.localStorage.clear(); } catch { /* jsdom 외 환경 */ }
  const now = new Date();
  claudeTokenUsageStore.__setForTest({
    all: {
      ...EMPTY_TOTALS,
      byModel: {},
      errors: emptyErrorCounters(),
      inputTokens: overrides.inputTokens ?? 0,
      outputTokens: overrides.outputTokens ?? 0,
    },
    today: { ...EMPTY_TOTALS, byModel: {}, errors: emptyErrorCounters() },
    todayDate: toLocalDateKey(now),
    history: [],
    loadError: overrides.loadError ?? null,
    sessionStatus: 'active',
  });
}

test('E2E · loadError 가 있으면 폴백 배지가 렌더되고 크래시 없음', () => {
  resetStore({ loadError: '네트워크 오류' });
  const view = render(<TokenUsageIndicator />);
  const badge = view.getByTestId('token-usage-indicator');
  assert.equal(badge.getAttribute('data-fallback'), 'true', '폴백 모드 표식이 켜져야 한다');
  assert.match(badge.textContent ?? '', /세션 토큰: --/,
    '폴백 배지는 "세션 토큰: --" 형태의 한 줄로 렌더되어 UI 깨짐을 막는다');
  cleanup();
});

test('E2E · 누적 0 상태에서 severity=ok 로 렌더된다(최초 마운트)', () => {
  resetStore({ inputTokens: 0, outputTokens: 0 });
  const view = render(<TokenUsageIndicator tokenLimit={1_000_000} />);
  const badge = view.getByTestId('token-usage-indicator');
  assert.equal(badge.getAttribute('data-severity'), 'ok', '최초 마운트 + 0 토큰은 ok 색상');
  assert.equal(badge.getAttribute('data-fallback'), null,
    '정상 상태는 폴백 플래그가 붙지 않는다');
  assert.match(view.getByTestId('token-usage-indicator-summary').textContent ?? '', /남음/);
  cleanup();
});

test('E2E · 비율이 80% 이상이면 data-severity="critical" 로 승격된다', async () => {
  // 한도 1,000 으로 잡고 누적 850 주입. prev=null 로 시작하면 "지금을 시작점" 이라
  // used=0 이 된다. 이를 피하려면 컴포넌트가 마운트된 뒤 누적만 사전 세팅돼 있어야
  // windows 는 지금으로 열리지만 cumulativeTokens=850 이 tokensAtWindowStart 로
  // 저장돼 버린다. 그래서 본 테스트에서는 컴포넌트 마운트 후 스토어에 delta 를
  // 주입해 used 가 누적값을 가리키게 한다.
  resetStore({ inputTokens: 0, outputTokens: 0 });
  const view = render(<TokenUsageIndicator tokenLimit={1_000} />);

  await act(async () => {
    claudeTokenUsageStore.applyDelta({
      input_tokens: 500,
      output_tokens: 350, // 합계 850 → 85% → critical
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: 'claude-sonnet-4-6',
    });
  });

  const badge = view.getByTestId('token-usage-indicator');
  assert.equal(badge.getAttribute('data-severity'), 'critical',
    '누적 85% 주입 후 배지 severity 가 critical 로 승격되지 않으면 색상 표시가 깨진 것');
  cleanup();
});

test('E2E · 호버 시 툴팁이 열리고 "리셋 예정" 라벨을 노출한다', () => {
  resetStore();
  const view = render(<TokenUsageIndicator tokenLimit={1_000_000} />);
  const wrapper = view.getByTestId('token-usage-indicator');

  // 호버 전에는 툴팁 없음.
  assert.equal(view.queryByTestId('token-usage-indicator-tooltip'), null);

  fireEvent.mouseEnter(wrapper);
  const tooltip = view.getByTestId('token-usage-indicator-tooltip');
  assert.ok(tooltip, '호버 시 툴팁이 열려야 한다');
  assert.match(
    view.getByTestId('token-usage-indicator-reset').textContent ?? '',
    /\d{2}:\d{2}/,
    '툴팁에 HH:MM 형태의 리셋 예정 시각이 표시돼야 한다',
  );

  fireEvent.mouseLeave(wrapper);
  assert.equal(view.queryByTestId('token-usage-indicator-tooltip'), null,
    '호버 해제 시 툴팁이 닫혀야 한다');
  cleanup();
});
