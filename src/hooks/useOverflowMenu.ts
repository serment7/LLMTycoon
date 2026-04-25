// 지시 #50e356dd — 상단 툴바 반응형 오버플로우 메뉴 훅·계산기.
//
// 배경
//   App 헤더의 액션 항목(프로젝트 배지, 토큰 사용량, 빠른 액션, 설정 토글 등)은
//   브라우저 폭이 좁아지면 두 줄로 무너지거나 잘려 보인다. Thanos 의 상단 툴바
//   리팩터(#50e356dd)는 ResizeObserver 로 컨테이너 폭을 추적해 들어가지 않는
//   항목을 "더보기" 메뉴로 밀어 넣는다. 이 모듈은 그 동작의 순수 계산 부분만
//   분리해 노출한다 — React 없이도 회귀가 돌도록.
//
// 진원
//   computeOverflowMenu(input) → { visibleItems, overflowItems, consumedWidth }
//   훅(useOverflowMenu)은 ResizeObserver 로 폭을 측정한 뒤 같은 함수를 호출한다.
//
// 알고리즘 — 두 단계로 나뉜다.
//   1) 일단 "더보기" 트리거 없이 모두 들어가는지 본다(전부 들어가면 overflow=0).
//   2) 한 항목이라도 빠져나가면 트리거 너비(overflowTriggerWidth)를 예약한
//      뒤 다시 그리디로 채워, 트리거가 시야에 자리를 차지하더라도 항상 합이
//      containerWidth 이하가 되도록 한다.
//
//   gap 은 "항목과 항목 사이" 간격이다 — 첫 항목 앞에는 gap 을 더하지 않는다.
//   트리거 자체에도 leading gap 을 가산한다(visibleItems 가 1개 이상일 때만).

import type { RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface OverflowMenuItem {
  /** 항목 식별자(React key 와 동일하게 안정해야 함). */
  readonly id: string;
  /** 표시 라벨(접근성 텍스트로도 재사용). */
  readonly label: string;
  /** 측정된 항목 너비(px). 측정 미완료면 호출자가 추정값을 채운다. */
  readonly width: number;
  /**
   * 임계값 기반 강제 분기(#0c066697) — 컨테이너 폭이 이 값 미만이면 측정-너비
   * 그리디와 무관하게 항상 더보기로 보낸다. 1280/960/720 같은 디자이너 가이드
   * 브레이크포인트와 동일 축으로 항목별 우선순위를 부여할 때 사용한다.
   * 미지정/0 이면 임계값 가드를 적용하지 않고 기존 측정 기반 그리디만 동작.
   */
  readonly hideBelowPx?: number;
}

export type OverflowBreakpoint = 1280 | 960 | 720 | 0;

/** 컨테이너 폭을 1280/960/720 임계와 비교해 활성 브레이크포인트를 돌려준다(0 = 가장 좁음). */
export function resolveBreakpoint(width: number): OverflowBreakpoint {
  if (!Number.isFinite(width) || width <= 0) return 0;
  if (width >= 1280) return 1280;
  if (width >= 960) return 960;
  if (width >= 720) return 720;
  return 0;
}

export interface ComputeOverflowInput {
  readonly containerWidth: number;
  readonly items: readonly OverflowMenuItem[];
  /** "더보기" 버튼 너비. 일부라도 오버플로우가 발생하면 빼야 한다(기본 0). */
  readonly overflowTriggerWidth?: number;
  /** 항목 사이 간격(px, 기본 8). */
  readonly gap?: number;
}

export interface OverflowMenuState {
  readonly visibleItems: readonly OverflowMenuItem[];
  readonly overflowItems: readonly OverflowMenuItem[];
  /** 디버그·테스트용 — 가시 영역 픽셀 합계(트리거 미포함). */
  readonly consumedWidth: number;
}

const EMPTY_STATE: OverflowMenuState = {
  visibleItems: [],
  overflowItems: [],
  consumedWidth: 0,
};

function fitItems(
  items: readonly OverflowMenuItem[],
  budget: number,
  gap: number,
): { fits: OverflowMenuItem[]; consumed: number; firstOverflowIndex: number } {
  const fits: OverflowMenuItem[] = [];
  let consumed = 0;
  for (let i = 0; i < items.length; i++) {
    const w = items[i].width + (fits.length > 0 ? gap : 0);
    if (consumed + w <= budget) {
      consumed += w;
      fits.push(items[i]);
    } else {
      return { fits, consumed, firstOverflowIndex: i };
    }
  }
  return { fits, consumed, firstOverflowIndex: items.length };
}

export function computeOverflowMenu(input: ComputeOverflowInput): OverflowMenuState {
  const containerWidth = Math.max(0, input.containerWidth | 0);
  const items = input.items;
  if (containerWidth === 0 || items.length === 0) return EMPTY_STATE;

  const gap = input.gap ?? 8;
  const triggerW = Math.max(0, input.overflowTriggerWidth ?? 0);

  // 0단계 — 임계값 가드(#0c066697). hideBelowPx 가 지정된 항목은 측정 그리디
  // 이전에 강제 더보기 후보로 빼낸다. 입력 순서를 보존해야 visibleItems 와
  // overflowItems 가 호출자의 의도와 같은 순서로 떨어진다.
  const eligible: OverflowMenuItem[] = [];
  const forcedOverflow: OverflowMenuItem[] = [];
  for (const item of items) {
    const min = item.hideBelowPx ?? 0;
    if (min > 0 && containerWidth < min) {
      forcedOverflow.push(item);
    } else {
      eligible.push(item);
    }
  }

  // 1단계 — 임계 통과 항목들을 트리거 없이 모두 채울 수 있나?
  const naive = fitItems(eligible, containerWidth, gap);
  if (naive.firstOverflowIndex === eligible.length && forcedOverflow.length === 0) {
    return {
      visibleItems: naive.fits,
      overflowItems: [],
      consumedWidth: naive.consumed,
    };
  }

  // 2단계 — 트리거 너비를 예약하고 다시 채운다. forcedOverflow 가 있으면 트리거가
  // 반드시 떠야 하므로(접근성·일관성), 그 경우에도 budget 에서 트리거 폭을 뺀다.
  const budget = Math.max(0, containerWidth - triggerW - gap);
  const guarded = fitItems(eligible, budget, gap);
  const overflow = [...eligible.slice(guarded.fits.length), ...forcedOverflow];
  return {
    visibleItems: guarded.fits,
    overflowItems: overflow,
    consumedWidth: guarded.consumed,
  };
}

// ─── React 훅 ────────────────────────────────────────────────────────────────
// ResizeObserver 가 없는 환경(SSR/Node 테스트)에서는 fallback width 를 사용해
// 마운트 직후의 1회 계산만 수행한다. 실제 브라우저에서는 마운트 후 ResizeObserver
// 가 폭 변동을 감시해 setState 를 흘린다.

export interface UseOverflowMenuInput {
  readonly items: readonly OverflowMenuItem[];
  readonly overflowTriggerWidth?: number;
  readonly gap?: number;
  /** SSR/테스트에서 사용할 폴백 폭. 미지정 시 0(=오버플로우만 채움). */
  readonly fallbackContainerWidth?: number;
}

export interface UseOverflowMenuResult extends OverflowMenuState {
  /** 컨테이너 ref — 측정 대상 div 에 부착한다. */
  readonly containerRef: RefObject<HTMLElement | null>;
  /** 현재 측정된 컨테이너 폭(px). 호출자 디버그·툴팁용. */
  readonly containerWidth: number;
  /**
   * 1280/960/720/0 — CSS 미디어 쿼리(`max-width: 1279px` 등) 와 같은 분기축.
   * 호출자가 className 토글이나 a11y 라벨 분기를 단일 출처로 가져갈 수 있게 한다.
   */
  readonly activeBreakpoint: OverflowBreakpoint;
}

export function useOverflowMenu(input: UseOverflowMenuInput): UseOverflowMenuResult {
  const containerRef = useRef<HTMLElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(
    input.fallbackContainerWidth ?? 0,
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof RO !== 'function') {
      // 테스트/SSR — 마운트 시점의 clientWidth 만 한 번 채워 둔다.
      setContainerWidth(el.clientWidth || input.fallbackContainerWidth || 0);
      return;
    }
    const ro = new RO(entries => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        setContainerWidth(prev => (prev === w ? prev : w));
      }
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth || input.fallbackContainerWidth || 0);
    return () => ro.disconnect();
  }, [input.fallbackContainerWidth]);

  const state = useMemo(
    () => computeOverflowMenu({
      containerWidth,
      items: input.items,
      overflowTriggerWidth: input.overflowTriggerWidth,
      gap: input.gap,
    }),
    [containerWidth, input.items, input.overflowTriggerWidth, input.gap],
  );

  const activeBreakpoint = useMemo(() => resolveBreakpoint(containerWidth), [containerWidth]);
  return { ...state, containerRef, containerWidth, activeBreakpoint };
}
