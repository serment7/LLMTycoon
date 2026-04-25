// Run with: npx tsx --test tests/components/statsIndicator.interaction.test.tsx
//
// 지시 #3121c775 — Thanos 의 호버 표시 버그 수정 후 StatsIndicator 회귀 보강.
//
// 배경
//   tests/components/statsIndicator.unit.test.ts 는 순수 함수 3종(classifyTier·
//   buildStatsLines·buildAriaSummary) 만 잠그며, React 컴포넌트의 hover/focus
//   상호작용은 "후속 spec 영역" 으로 명시 보류돼 있다(지시 #4a9402f3 §11).
//   Thanos 가 호버 표시 버그(popover 가 열리지 않거나 세 수치 중 일부가 누락되는
//   회귀)를 수정한 직후이므로, 본 spec 이 그 빈 영역을 채워 다음 4가지를 잠근다.
//
// 검증 계약
//   (1) mouseEnter → popover(`role="tooltip"`) 가 열려 data-open="true" 가 된다
//   (2) 열린 popover 안에 커버리지·활성률·협업 세 줄(line-coverage/activity/
//       collaboration) 이 모두 렌더되고 각 라벨·퍼센트·티어가 데이터와 정합
//   (3) Tab 으로 트리거에 포커스가 들어와도 동일 정보가 노출(키보드 사용자 동등성)
//   (4) 데이터가 비어 있을 때(고립 파일 0 / 에이전트 0 / 협업 메시지 0) fallback
//       문구가 popover 안에 적절히 표시되고 퍼센트는 "—" 로 표기된다

import 'global-jsdom/register';

import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StatsIndicator } from '../../src/components/StatsIndicator.tsx';

// ────────────────────────────────────────────────────────────────────────────
// 표준 fixture — 정상 데이터/빈 데이터 두 시나리오를 짧게 만든다.
// ────────────────────────────────────────────────────────────────────────────
const HEALTHY_PROPS = {
  coverage: { percent: 82, isolatedFiles: [] },
  activity: { percent: 75, active: 6, total: 8, breakdown: 'Dev 3/4, QA 3/4' },
  collaboration: { percent: 60, messageCount: 24, detail: '메시지 24 · 채널 5' },
} as const;

const EMPTY_PROPS = {
  coverage: { percent: 0, isolatedFiles: [] },
  activity: { percent: 0, active: 0, total: 0 },
  collaboration: { percent: null, messageCount: 0, detail: '' },
} as const;

function getPopover(): HTMLElement {
  const el = document.querySelector('[data-testid="stats-indicator-popover"]') as HTMLElement | null;
  assert.ok(el, 'popover 컨테이너가 DOM 에 마운트돼 있어야 한다');
  return el!;
}

function getTrigger(): HTMLElement {
  const el = document.querySelector('[data-testid="stats-indicator-trigger"]') as HTMLElement | null;
  assert.ok(el, 'trigger 가 DOM 에 마운트돼 있어야 한다');
  return el!;
}

function popoverIsOpen(): boolean {
  // 가시성은 data-open + aria-expanded + 인라인 opacity 세 신호를 모두 본다 — 어느 한
  // 신호만 true 인 절름발이 회귀(예: aria 만 true 인데 시각적으로 안 뜸) 도 잡는다.
  const popover = getPopover();
  const trigger = getTrigger();
  const dataOpen = popover.getAttribute('data-open') === 'true';
  const ariaExpanded = trigger.getAttribute('aria-expanded') === 'true';
  const opacityVisible = popover.style.opacity !== '0';
  return dataOpen && ariaExpanded && opacityVisible;
}

// ────────────────────────────────────────────────────────────────────────────
// (1) mouseEnter → popover 열림
// ────────────────────────────────────────────────────────────────────────────

test('1. mouseEnter — popover 가 data-open="true" + aria-expanded="true" + opacity 1 로 열린다', () => {
  try {
    render(<StatsIndicator {...HEALTHY_PROPS} />);
    assert.equal(popoverIsOpen(), false, '초기 상태는 닫혀 있어야 한다');

    act(() => {
      fireEvent.mouseEnter(getTrigger());
    });
    assert.equal(popoverIsOpen(), true, 'mouseEnter 후에는 popover 가 열려야 한다');

    const popover = getPopover();
    assert.equal(popover.getAttribute('role'), 'tooltip', 'popover role=tooltip 보존');
    assert.equal(popover.style.pointerEvents, 'auto', '열린 popover 는 포인터 이벤트를 받아야 한다');

    act(() => {
      fireEvent.mouseLeave(getTrigger());
    });
    assert.equal(popoverIsOpen(), false, 'mouseLeave 후 닫혀야 한다(호버 토글 정상)');
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// (2) 열린 popover 안에 세 수치 모두 렌더 + 라벨/퍼센트/티어 정합
// ────────────────────────────────────────────────────────────────────────────

test('2. 열린 popover — 커버리지·활성률·협업 세 줄 모두 렌더 + 라벨/퍼센트/티어 정합', () => {
  try {
    render(<StatsIndicator {...HEALTHY_PROPS} />);
    act(() => {
      fireEvent.mouseEnter(getTrigger());
    });

    const coverage = document.querySelector('[data-testid="stats-indicator-line-coverage"]') as HTMLElement;
    const activity = document.querySelector('[data-testid="stats-indicator-line-activity"]') as HTMLElement;
    const collab = document.querySelector('[data-testid="stats-indicator-line-collaboration"]') as HTMLElement;
    assert.ok(coverage, '커버리지 줄이 누락되면 안 된다');
    assert.ok(activity, '활성률 줄이 누락되면 안 된다');
    assert.ok(collab, '협업 줄이 누락되면 안 된다');

    // 라벨 텍스트 + 퍼센트 표기 정합.
    assert.match(coverage.textContent ?? '', /커버리지/);
    assert.match(coverage.textContent ?? '', /82%/);
    assert.match(activity.textContent ?? '', /활성률/);
    assert.match(activity.textContent ?? '', /75%/);
    assert.match(collab.textContent ?? '', /협업/);
    assert.match(collab.textContent ?? '', /60%/);

    // 티어 — 82=good / 75=good / 60=warn (StatsIndicator.classifyTier 임계 70/40 기준).
    assert.equal(coverage.getAttribute('data-tier'), 'good');
    assert.equal(activity.getAttribute('data-tier'), 'good');
    assert.equal(collab.getAttribute('data-tier'), 'warn');

    // 트리거의 aria-label 도 세 수치를 한 줄로 묶어 안내해야 한다(스크린리더 동등성).
    const aria = getTrigger().getAttribute('aria-label') ?? '';
    assert.match(aria, /커버리지 82%/);
    assert.match(aria, /활성률 75%/);
    assert.match(aria, /협업 60%/);
  } finally {
    cleanup();
  }
});

test('2-2. 활성률 detail — breakdown 이 주어지면 popover 보조 텍스트로 노출', () => {
  try {
    render(<StatsIndicator {...HEALTHY_PROPS} />);
    act(() => {
      fireEvent.mouseEnter(getTrigger());
    });
    const activity = document.querySelector('[data-testid="stats-indicator-line-activity"]') as HTMLElement;
    assert.match(activity.textContent ?? '', /Dev 3\/4, QA 3\/4/, 'breakdown 이 detail 로 노출');
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// (3) 키보드 포커스(Tab) 동등성 + Esc 닫힘
// ────────────────────────────────────────────────────────────────────────────

test('3. Tab → trigger 포커스 → popover 펼침 → 세 수치 노출(키보드 사용자 동등성)', async () => {
  try {
    render(
      <>
        <button data-testid="prev-focus" type="button">prev</button>
        <StatsIndicator {...HEALTHY_PROPS} />
      </>,
    );
    const prev = document.querySelector('[data-testid="prev-focus"]') as HTMLButtonElement;
    prev.focus();
    assert.equal(document.activeElement, prev);

    const user = userEvent.setup();
    await user.tab();
    const trigger = getTrigger();
    assert.equal(document.activeElement, trigger, 'Tab 한 번에 trigger(role=button, tabIndex=0) 로 진입');
    assert.equal(popoverIsOpen(), true, '포커스 진입만으로 popover 가 펼쳐져야 한다(키보드 동등성)');

    // 호버와 동일하게 세 수치가 모두 노출.
    for (const key of ['coverage', 'activity', 'collaboration'] as const) {
      const line = document.querySelector(`[data-testid="stats-indicator-line-${key}"]`) as HTMLElement;
      assert.ok(line, `[키보드 경로] ${key} 줄 누락 금지`);
    }

    // Esc → 닫힘. blur 까지 가야 닫히는 회귀를 막기 위해 onKeyDown 분기가 두 상태를
    // 모두 false 로 내리는지를 검증.
    await user.keyboard('{Escape}');
    assert.equal(popoverIsOpen(), false, 'Esc 한 번에 popover 가 닫혀야 한다');
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// (4) 빈 데이터 — fallback 문구가 popover 에 적절히 표시
// ────────────────────────────────────────────────────────────────────────────

test('4. 빈 데이터 — popover 안에 fallback 문구 + 결측 퍼센트는 "—"', () => {
  try {
    render(<StatsIndicator {...EMPTY_PROPS} />);
    act(() => {
      fireEvent.mouseEnter(getTrigger());
    });

    const coverage = document.querySelector('[data-testid="stats-indicator-line-coverage"]') as HTMLElement;
    const activity = document.querySelector('[data-testid="stats-indicator-line-activity"]') as HTMLElement;
    const collab = document.querySelector('[data-testid="stats-indicator-line-collaboration"]') as HTMLElement;

    // coverage — isolatedFiles 가 비면 "의존성에 연결되지 않은 파일 없음" 안내.
    assert.match(
      coverage.textContent ?? '',
      /의존성에 연결되지 않은 파일 없음/,
      'coverage 빈 fallback 안내가 노출돼야 한다',
    );
    // coverage.percent 자체는 0 이라 "0%" 노출(데이터가 0% 인 케이스). 결측이 아니므로 — 가 아닌 0%.
    assert.match(coverage.textContent ?? '', /0%/);

    // activity — total === 0 이면 percent 결측(unknown) → "—" 표기, detail 은 "활성 0 / 전체 0".
    assert.match(activity.textContent ?? '', /활성 0 \/ 전체 0/);
    // 줄 안에 "—" 한 글자가 퍼센트 자리에 노출됐는지 확인.
    assert.ok(/—/.test(activity.textContent ?? ''), 'activity 결측 퍼센트는 — 로 표기');
    assert.equal(activity.getAttribute('data-tier'), 'unknown');

    // collaboration — messageCount === 0 이면 "협업 로그 없음" + 결측 퍼센트 —.
    assert.match(collab.textContent ?? '', /협업 로그 없음/);
    assert.ok(/—/.test(collab.textContent ?? ''), 'collaboration 결측 퍼센트는 — 로 표기');
    assert.equal(collab.getAttribute('data-tier'), 'unknown');

    // aria-label 도 결측을 "데이터 없음" 으로 안내해야 스크린리더가 빈 상태를 인지.
    const aria = getTrigger().getAttribute('aria-label') ?? '';
    assert.match(aria, /활성률 데이터 없음/);
    assert.match(aria, /협업 데이터 없음/);
  } finally {
    cleanup();
  }
});

test('4-2. 빈 데이터에서도 mouseEnter 시 popover 자체는 정상 펼쳐진다(호버 버그 회귀 방지)', () => {
  try {
    render(<StatsIndicator {...EMPTY_PROPS} />);
    assert.equal(popoverIsOpen(), false, '초기엔 닫혀 있어야 한다');
    act(() => {
      fireEvent.mouseEnter(getTrigger());
    });
    assert.equal(
      popoverIsOpen(),
      true,
      '빈 데이터라도 mouseEnter 시 popover 는 열려야 한다 — Thanos 가 수정한 호버 표시 버그의 회귀 방지',
    );
    // 세 줄 자체는 빈 데이터에서도 모두 마운트(라벨·fallback 문구를 보여주기 위함).
    assert.ok(document.querySelector('[data-testid="stats-indicator-line-coverage"]'));
    assert.ok(document.querySelector('[data-testid="stats-indicator-line-activity"]'));
    assert.ok(document.querySelector('[data-testid="stats-indicator-line-collaboration"]'));
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 보강 — forceOpen prop 으로 강제 펼침이 가능해야 시각 회귀(스크린샷) 가 안정적.
// ────────────────────────────────────────────────────────────────────────────

test('5. forceOpen={true} — hover/focus 가 없어도 popover 가 즉시 펼쳐진다(시각 회귀 훅)', () => {
  try {
    render(<StatsIndicator {...HEALTHY_PROPS} forceOpen />);
    assert.equal(popoverIsOpen(), true, 'forceOpen 시 초기부터 열려 있어야 한다');
    // hover 없이도 세 줄이 모두 보인다.
    for (const key of ['coverage', 'activity', 'collaboration'] as const) {
      assert.ok(
        document.querySelector(`[data-testid="stats-indicator-line-${key}"]`),
        `forceOpen 경로에서도 ${key} 줄 누락 금지`,
      );
    }
  } finally {
    cleanup();
  }
});
