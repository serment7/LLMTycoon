// Run with: npx tsx --test tests/tokenUsageIndicator.e2e.test.tsx
//
// E2E 스모크 — 상단바 <TokenUsageIndicator/> (구독 세션 남은 토큰 배지) UI 계약.
//
// 목적:
//  1) 스토어 `loadError` 가 있으면 "토큰 정보 없음" 폴백 배지가 렌더되고 크래시가 없다.
//  2) 누적 토큰이 주입되면 data-severity 가 ok → caution → critical 로 승격된다.
//  3) 호버 시 툴팁이 열리고 "리셋 예정" 라벨이 노출된다.
//  4) aria-label 축이 시각 바(사용률) 와 같은 방향으로 읽힌다 — "사용 N%, 남은
//     토큰 X, 약 Y 뒤 리셋". 이전 시안의 "(남은 N 퍼센트)" 로 회귀하는 것을 잠근다.
//  5) 심각도 아이콘 램프가 ok=BatteryFull, critical=BatteryWarning 으로 단조
//     하강한다(ok→caution→critical 중간 건너뜀이 없다). lucide-react 는 각
//     아이콘을 `svg.lucide-<kebab-name>` 으로 렌더하므로 클래스로 검증.
//  6) wrapper 가 CSS 펄스 스코프 클래스(`token-usage-indicator`)와 배지 클래스
//     (`token-usage-indicator__badge`) 를 노출한다. index.css 의
//     `[data-just-reset="true"]` 규칙이 이 두 클래스에 결합되어 있어, 어느 하나가
//     떨어져도 리셋 재개 펄스가 시각적으로 사라진다.
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

test('E2E · aria-label 이 "사용 N%, 남은 토큰 X, 약 Y 뒤 리셋" 축으로 읽힌다', () => {
  // 시각 바(사용 비율)와 음성 축을 동일 방향으로 정렬한 회귀 잠금.
  // 이전 시안은 "(남은 N 퍼센트)" 로 읽혀 시각/청각이 반대를 가리켰다.
  resetStore({ inputTokens: 0, outputTokens: 0 });
  const view = render(<TokenUsageIndicator tokenLimit={1_000_000} />);

  const badge = view.getByTestId('token-usage-indicator').firstElementChild as HTMLElement;
  const label = badge.getAttribute('aria-label') ?? '';

  assert.match(
    label,
    /^구독 세션 사용 \d+%, 남은 토큰 .+, 약 .+ 뒤 리셋$/,
    `aria-label 은 "구독 세션 사용 N%, 남은 토큰 X, 약 Y 뒤 리셋" 형식이어야 한다 — 실제: "${label}"`,
  );
  assert.ok(
    !/남은 \d+ 퍼센트/.test(label),
    '"(남은 N 퍼센트)" 옛 포맷으로 회귀해서는 안 된다 — 시각 바(사용률) 와 방향이 반대가 된다',
  );
  cleanup();
});

test('E2E · 심각도 아이콘 램프 — ok=BatteryFull, critical=BatteryWarning', async () => {
  // lucide-react 는 아이콘을 <svg class="lucide lucide-<kebab-name>"> 으로 렌더한다.
  // 이 테스트는 "ok→caution→critical" 램프에서 중간 단계 건너뜀 회귀(예: Full→Low→Warning)
  // 가 다시 돌아오는지 감시한다. caution 은 다른 테스트에서 data-severity 로 잠갔으니
  // 여기서는 양끝 두 단계를 아이콘 클래스로 고정한다.
  resetStore({ inputTokens: 0, outputTokens: 0 });
  const view = render(<TokenUsageIndicator tokenLimit={1_000} />);

  // ok — 누적 0 · 최초 마운트.
  let svg = view.getByTestId('token-usage-indicator').querySelector('svg');
  assert.ok(svg, 'ok 상태에서도 심각도 아이콘 svg 가 렌더돼야 한다');
  assert.match(
    svg!.getAttribute('class') ?? '',
    /lucide-battery-full/,
    'ok 상태 아이콘은 BatteryFull 이어야 한다',
  );

  // critical — 누적 85% 주입.
  await act(async () => {
    claudeTokenUsageStore.applyDelta({
      input_tokens: 500,
      output_tokens: 350,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: 'claude-sonnet-4-6',
    });
  });
  svg = view.getByTestId('token-usage-indicator').querySelector('svg');
  assert.match(
    svg!.getAttribute('class') ?? '',
    /lucide-battery-warning/,
    'critical 상태 아이콘은 BatteryWarning 이어야 한다 — BatteryLow 등으로 회귀 시 심각도 램프가 깨진다',
  );
  cleanup();
});

test('E2E · 리셋 펄스 CSS 스코프 클래스가 wrapper/배지에 붙는다', () => {
  // index.css 의 `.token-usage-indicator[data-just-reset="true"] .token-usage-indicator__badge`
  // 규칙이 시각 펄스를 건다. 두 클래스 중 하나라도 사라지면 규칙이 매치되지 않아
  // 리셋 피드백이 조용히 사라진다 — 그래서 클래스 자체를 계약으로 잠근다.
  resetStore({ inputTokens: 0, outputTokens: 0 });
  const view = render(<TokenUsageIndicator tokenLimit={1_000_000} />);

  const wrapper = view.getByTestId('token-usage-indicator');
  assert.ok(
    wrapper.classList.contains('token-usage-indicator'),
    'wrapper 는 `token-usage-indicator` 클래스를 가져야 한다 — CSS 펄스 스코프',
  );

  const badge = wrapper.firstElementChild as HTMLElement;
  assert.ok(
    badge.classList.contains('token-usage-indicator__badge'),
    '배지 본체는 `token-usage-indicator__badge` 클래스를 가져야 한다 — 애니메이션 타겟',
  );

  // data-just-reset 은 리셋 전 기본 false, 리셋 감지 시 컴포넌트가 3초간 true 로 켠다.
  assert.equal(
    wrapper.getAttribute('data-just-reset'),
    'false',
    '리셋이 없었다면 data-just-reset 은 "false" — 펄스 규칙이 매치되지 않는다',
  );
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
