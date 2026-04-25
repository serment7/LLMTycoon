// Run with: npx tsx --test tests/headerMetricsBadge.regression.test.tsx
//
// 지시 #735aa49e — Joker 가 구현할 "통합 지표 아이콘"(커버리지·활성률·협업 3종을
// 단일 트리거 + Tooltip 으로 합치는 헤더 컴포넌트) 의 회귀 시나리오 잠금.
//
// 배경
//   docs/designs/top-bar-density-spec-2026-04-25.md §2.1 의 480px 모바일 한 줄 6슬롯
//   레이아웃에 따라, 기존 `header-metric-coverage`/`-activity`/`-collaboration` 3개
//   칩을 하나의 통합 트리거 + 호버/포커스 Tooltip 으로 흡수하는 변경이 예정돼 있다.
//   본 spec 은 Joker 의 구현이 다음 5가지 시나리오를 모두 만족함을 잠근다 — 구현이
//   끝나기 전에는 본 파일 내 fixture 컴포넌트(=명세적 최소 구현) 를 검증해 spec 자체가
//   초록불을 유지하고, 구현이 끝나면 fixture import 자리를 실제 모듈로 갈아끼우기만
//   하면 같은 단언이 그대로 회귀 잠금으로 동작한다(specification by example 패턴).
//
//   Joker 구현 위치 권장(미정 시): `src/ui/topbar/HeaderMetricsBadge.tsx`
//   props 계약: { coverage?: number; activity?: number; collaboration?: string;
//                 fallbackLabel?: string }
//
// 검증 계약
//   (1) 헤더에 단일 트리거만 렌더, 기존 3종 칩 텍스트(커버리지/활성률/협업) 는 표면 0
//   (2) 마우스 hover 시 role="dialog"(또는 tooltip) Tooltip 이 열리고 세 수치가 모두 노출
//   (3) Tab → 트리거 포커스 → 자동 펼침 → Esc → 닫힘 + 트리거에 포커스 복귀
//   (4) 1024/768/480px 폭에서 트리거가 한 줄을 유지(white-space:nowrap) 하고 잘리지 않음
//   (5) 데이터가 비어 있을 때 fallback 라벨이 명시적으로 노출되고 Tooltip 은 빈 수치를
//       감추지 않고 "데이터 없음" 한 줄로 안내

import 'global-jsdom/register';

import test from 'node:test';
import assert from 'node:assert/strict';

import React, { useEffect, useId, useRef, useState } from 'react';
import { act, cleanup, render, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ────────────────────────────────────────────────────────────────────────────
// Joker 구현 명세 fixture — 본 spec 의 단언 5가지를 모두 통과하는 최소 구현.
// 실제 구현이 들어오면 다음 import 한 줄을 바꾸면 된다:
//   import { HeaderMetricsBadge } from '../src/ui/topbar/HeaderMetricsBadge.tsx';
// ────────────────────────────────────────────────────────────────────────────

interface HeaderMetricsBadgeProps {
  /** 커버리지 % (0~100). undefined 이면 데이터 없음으로 처리. */
  readonly coverage?: number;
  /** 활성률 % (0~100). undefined 이면 데이터 없음으로 처리. */
  readonly activity?: number;
  /** 협업 글리프(`●●○` 등). 빈 문자열은 데이터 없음으로 처리. */
  readonly collaboration?: string;
  /** 빈 데이터일 때 표면 라벨(미지정 시 `—`). */
  readonly fallbackLabel?: string;
}

function HeaderMetricsBadge(props: HeaderMetricsBadgeProps): React.ReactElement {
  const { coverage, activity, collaboration, fallbackLabel } = props;
  const hasData =
    typeof coverage === 'number'
    || typeof activity === 'number'
    || (typeof collaboration === 'string' && collaboration.length > 0);

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltipId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const ariaSummary = hasData
    ? `통합 지표 (커버리지 ${coverage ?? '—'}%, 활성률 ${activity ?? '—'}%, 협업 ${collaboration ?? '—'})`
    : '통합 지표 (데이터 없음)';

  return (
    <span
      className="header-metrics-badge"
      data-testid="header-metrics-badge"
      style={{ whiteSpace: 'nowrap', display: 'inline-flex', maxWidth: '100%' }}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="header-metrics-icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? tooltipId : undefined}
        aria-label={ariaSummary}
        title={ariaSummary}
        style={{ whiteSpace: 'nowrap' }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {hasData ? '◧' : (fallbackLabel ?? '—')}
      </button>
      {open && (
        <div
          id={tooltipId}
          role="dialog"
          data-testid="header-metrics-tooltip"
          aria-label="통합 지표 상세"
        >
          {hasData ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              <li data-testid="header-metrics-coverage">
                커버리지 {typeof coverage === 'number' ? `${coverage}%` : '—'}
              </li>
              <li data-testid="header-metrics-activity">
                활성률 {typeof activity === 'number' ? `${activity}%` : '—'}
              </li>
              <li data-testid="header-metrics-collaboration">
                협업 {collaboration && collaboration.length > 0 ? collaboration : '—'}
              </li>
            </ul>
          ) : (
            // 표면은 fallbackLabel(예: "—") 한 글자로 슬롯을 보존하지만, Tooltip 본문은
            // 사용자에게 명확한 안내가 필요하므로 "데이터 없음" 고정 문구로 분리한다.
            <span data-testid="header-metrics-fallback">데이터 없음</span>
          )}
        </div>
      )}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 헤더 컨테이너 fixture — 폭별 한 줄 유지 검증용. AppShell 의 .app-shell-header
// 와 동일한 flex 정책(min-width:0, flex-wrap:nowrap)을 인라인 스타일로 모사.
// ────────────────────────────────────────────────────────────────────────────

interface HeaderHostProps {
  readonly widthPx: number;
  readonly children: React.ReactNode;
}

function HeaderHost(props: HeaderHostProps): React.ReactElement {
  return (
    <div
      data-testid="header-host"
      style={{
        width: `${props.widthPx}px`,
        display: 'flex',
        flexWrap: 'nowrap',
        minWidth: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {props.children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// (1) 헤더에 단일 아이콘만 — 기존 3종 칩 텍스트는 표면 0
// ────────────────────────────────────────────────────────────────────────────

test('1. 단일 트리거만 렌더 — 기존 커버리지/활성률/협업 3종 칩 텍스트가 표면에 없다', () => {
  try {
    render(
      <HeaderHost widthPx={1280}>
        <HeaderMetricsBadge coverage={74} activity={62} collaboration="●●○" />
      </HeaderHost>,
    );

    const triggers = document.querySelectorAll('[data-testid="header-metrics-icon"]');
    assert.equal(triggers.length, 1, '통합 트리거는 정확히 1개여야 한다');

    // Tooltip 이 닫힌 상태에서는 세 수치가 표면에 노출되지 않아야 한다.
    const tooltip = document.querySelector('[data-testid="header-metrics-tooltip"]');
    assert.equal(tooltip, null, '닫힌 상태에서 Tooltip 은 DOM 에 마운트되지 않는다');

    // 헤더 host 텍스트에서 기존 3종 라벨이 모두 사라졌는지 확인.
    const surfaceText = document.querySelector('[data-testid="header-host"]')?.textContent ?? '';
    for (const label of ['커버리지', '활성률', '협업']) {
      assert.ok(
        !surfaceText.includes(label),
        `표면에 "${label}" 텍스트가 남아 있으면 안 된다(통합으로 흡수돼야 함) — got: ${surfaceText}`,
      );
    }
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// (2) 마우스오버 → Tooltip 열림 + 세 수치 모두 노출
// ────────────────────────────────────────────────────────────────────────────

test('2. mouseEnter → role="dialog" Tooltip 노출 + 커버리지/활성률/협업 세 수치 모두 등장', () => {
  try {
    render(
      <HeaderMetricsBadge coverage={74} activity={62} collaboration="●●○" />,
    );

    const trigger = document.querySelector(
      '[data-testid="header-metrics-icon"]',
    ) as HTMLButtonElement;
    assert.ok(trigger, '트리거 버튼이 마운트돼 있어야 한다');
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', '초기엔 닫혀 있어야 한다');

    act(() => {
      fireEvent.mouseEnter(trigger);
    });

    assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'hover 시 펼침 상태가 된다');
    const tooltip = document.querySelector(
      '[data-testid="header-metrics-tooltip"]',
    ) as HTMLElement;
    assert.ok(tooltip, 'Tooltip 컨테이너가 노출돼야 한다');
    assert.equal(tooltip.getAttribute('role'), 'dialog');

    const coverage = document.querySelector('[data-testid="header-metrics-coverage"]')?.textContent ?? '';
    const activity = document.querySelector('[data-testid="header-metrics-activity"]')?.textContent ?? '';
    const collab   = document.querySelector('[data-testid="header-metrics-collaboration"]')?.textContent ?? '';
    assert.match(coverage, /커버리지\s+74%/, '커버리지 수치 노출');
    assert.match(activity, /활성률\s+62%/, '활성률 수치 노출');
    assert.match(collab,   /협업\s+●●○/,   '협업 수치 노출');

    // mouseLeave 로 다시 닫혀야 한다.
    act(() => {
      fireEvent.mouseLeave(trigger);
    });
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('[data-testid="header-metrics-tooltip"]'), null);
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// (3) Tab 포커스 진입 → 자동 펼침 → ESC 닫힘 + 트리거에 포커스 복귀
// ────────────────────────────────────────────────────────────────────────────

test('3. Tab 으로 트리거 포커스 → 펼침 → Esc → 닫힘 + 트리거에 포커스 복귀', async () => {
  try {
    render(
      <>
        <button data-testid="prev-focus" type="button">prev</button>
        <HeaderMetricsBadge coverage={74} activity={62} collaboration="●●○" />
      </>,
    );

    const prev = document.querySelector('[data-testid="prev-focus"]') as HTMLButtonElement;
    const trigger = document.querySelector(
      '[data-testid="header-metrics-icon"]',
    ) as HTMLButtonElement;

    // 우선 prev 버튼에 포커스를 둔 뒤 Tab 한 번으로 트리거에 들어오는 흐름을 확인.
    prev.focus();
    assert.equal(document.activeElement, prev);

    const user = userEvent.setup();
    await user.tab();
    assert.equal(document.activeElement, trigger, 'Tab 한 번에 통합 트리거로 포커스 진입');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true', '포커스 진입 시 자동 펼침');
    assert.ok(
      document.querySelector('[data-testid="header-metrics-tooltip"]'),
      'Tooltip 컨테이너가 열려 있어야 한다',
    );

    // ESC 로 닫고 트리거로 포커스 복귀를 확인.
    await user.keyboard('{Escape}');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Esc 로 닫힘');
    assert.equal(
      document.querySelector('[data-testid="header-metrics-tooltip"]'),
      null,
      'Tooltip 이 DOM 에서 사라져야 한다',
    );
    assert.equal(document.activeElement, trigger, 'Esc 후 트리거에 포커스 복귀');
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// (4) 1024/768/480px 폭 — 트리거가 한 줄 유지 + 잘리지 않음
// ────────────────────────────────────────────────────────────────────────────

test('4. 1024/768/480px — 트리거가 한 줄에 유지되고 inline-flex/nowrap 으로 잘리지 않음', () => {
  // jsdom 은 layout 을 계산하지 않으므로 픽셀 기반 잘림 검증은 불가능. 대신
  //   - 컨테이너 폭이 어떻게 변하더라도 트리거가 항상 1개만 마운트되는가
  //   - 트리거에 white-space:nowrap 인라인 스타일이 부여돼 있는가
  //   - 컨테이너의 flex-wrap 이 nowrap 인가
  //   세 가지로 한 줄 유지의 정적 계약을 잠근다(픽셀 단위 시각 회귀는 Playwright
  //   /docs/qa/top-bar-responsive-checklist.md 의 수동 점검표가 보완).
  for (const widthPx of [1024, 768, 480] as const) {
    try {
      render(
        <HeaderHost widthPx={widthPx}>
          <HeaderMetricsBadge coverage={99.99} activity={62} collaboration="●●○" />
        </HeaderHost>,
      );

      const host = document.querySelector('[data-testid="header-host"]') as HTMLElement;
      assert.equal(host.style.flexWrap, 'nowrap', `[${widthPx}px] 컨테이너 flex-wrap=nowrap`);
      assert.equal(host.style.whiteSpace, 'nowrap', `[${widthPx}px] 컨테이너 white-space=nowrap`);

      const triggers = document.querySelectorAll('[data-testid="header-metrics-icon"]');
      assert.equal(triggers.length, 1, `[${widthPx}px] 트리거는 단 1개`);

      const trigger = triggers[0] as HTMLButtonElement;
      assert.equal(trigger.style.whiteSpace, 'nowrap', `[${widthPx}px] 트리거 white-space=nowrap`);

      // 트리거 내부 텍스트가 줄바꿈 문자(\n) 또는 두 글자 이상의 라벨이 아니어야 한다 — 단일
      // 글리프(또는 fallback 한 글자) 만 노출돼 잘림 자체가 발생하지 않는다.
      const surface = trigger.textContent ?? '';
      assert.equal(surface.includes('\n'), false, `[${widthPx}px] 트리거 본문에 개행 금지`);
      assert.ok(surface.length <= 4, `[${widthPx}px] 트리거 표면 글자 수(${surface.length}) ≤ 4 — 단일 글리프 계약`);
    } finally {
      cleanup();
    }
  }
});

test('4-2. 99.99% / 1,234,567 처럼 긴 수치는 트리거 표면이 아니라 Tooltip 안에서만 펼쳐진다', () => {
  try {
    render(
      <HeaderMetricsBadge coverage={99.99} activity={62} collaboration="●●●●●●●●●●" />,
    );
    const trigger = document.querySelector(
      '[data-testid="header-metrics-icon"]',
    ) as HTMLButtonElement;
    // 트리거 표면은 단일 글리프이므로 긴 수치가 표면에 새지 않는다.
    assert.equal((trigger.textContent ?? '').includes('99.99'), false, '긴 수치가 표면에 새면 안 된다');

    act(() => {
      fireEvent.mouseEnter(trigger);
    });
    const coverage = document.querySelector('[data-testid="header-metrics-coverage"]')?.textContent ?? '';
    assert.match(coverage, /99\.99%/, '긴 수치는 Tooltip 안에서만 노출');
    const collab = document.querySelector('[data-testid="header-metrics-collaboration"]')?.textContent ?? '';
    assert.match(collab, /●●●●●●●●●●/, '긴 글리프 시퀀스도 Tooltip 안에서 보존');
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// (5) 데이터가 비어 있을 때 fallback 표시
// ────────────────────────────────────────────────────────────────────────────

test('5. 빈 데이터 — 표면 fallback 라벨 노출 + Tooltip 은 "데이터 없음" 한 줄로 안내', () => {
  try {
    render(<HeaderMetricsBadge fallbackLabel="—" />);
    const trigger = document.querySelector(
      '[data-testid="header-metrics-icon"]',
    ) as HTMLButtonElement;
    assert.ok(trigger, '빈 데이터에서도 트리거 자체는 마운트된다(레이아웃 슬롯 보존)');
    assert.equal((trigger.textContent ?? '').trim(), '—', '표면 fallback 라벨이 노출');
    assert.match(trigger.getAttribute('aria-label') ?? '', /데이터 없음/, 'aria-label 에 데이터 없음 명시');

    act(() => {
      fireEvent.mouseEnter(trigger);
    });
    const fallback = document.querySelector('[data-testid="header-metrics-fallback"]')?.textContent ?? '';
    assert.equal(fallback, '데이터 없음', '빈 데이터의 Tooltip 은 한 줄 안내문');
    // 빈 데이터에서는 세 수치 행이 노출되면 안 된다(빈 칸을 보여 사용자 혼란 회귀 차단).
    assert.equal(document.querySelector('[data-testid="header-metrics-coverage"]'), null);
    assert.equal(document.querySelector('[data-testid="header-metrics-activity"]'), null);
    assert.equal(document.querySelector('[data-testid="header-metrics-collaboration"]'), null);
  } finally {
    cleanup();
  }
});

test('5-2. 일부 수치만 있을 때는 hasData 가 true 로 잡혀 Tooltip 에 결측은 — 로 표기', () => {
  try {
    render(<HeaderMetricsBadge coverage={74} />);
    const trigger = document.querySelector(
      '[data-testid="header-metrics-icon"]',
    ) as HTMLButtonElement;
    assert.notEqual((trigger.textContent ?? '').trim(), '—', '수치가 하나라도 있으면 글리프로 표면 노출');

    act(() => {
      fireEvent.mouseEnter(trigger);
    });
    const coverage = document.querySelector('[data-testid="header-metrics-coverage"]')?.textContent ?? '';
    const activity = document.querySelector('[data-testid="header-metrics-activity"]')?.textContent ?? '';
    const collab   = document.querySelector('[data-testid="header-metrics-collaboration"]')?.textContent ?? '';
    assert.match(coverage, /커버리지\s+74%/);
    assert.match(activity, /활성률\s+—/, '결측 수치는 — 로 표기');
    assert.match(collab,   /협업\s+—/);
  } finally {
    cleanup();
  }
});
