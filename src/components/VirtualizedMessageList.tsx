// VirtualizedMessageList(#832360c2) — 긴 대화에서 프레임 드랍을 막기 위한 경량 가상화.
//
// 배경 — 본 저장소는 react-virtuoso 같은 외부 의존성을 추가하지 않기로 정책을 유지한다.
// 따라서 "스크롤 위치 + 고정 행 높이 추정" 만으로 가시 범위를 계산하는 최소 가상화를
// 자체 구현한다. 행 높이가 가변인 경우에도 overscan 을 넉넉히 둬 점프·흔들림을 흡수
// 하고, 500+ 메시지에서도 실제 DOM 노드 수가 일정하게 유지되도록 한다.
//
// 특징
//   · 순수 함수 `computeVisibleRange` 로 가시 인덱스 범위를 계산해 테스트 가능.
//   · 이미지·썸네일 지연 로드 — 메시지 렌더 함수에 `isNearViewport` 힌트를 넘겨
//     상위가 `<img loading="lazy">` 또는 skeleton 을 결정하게 한다.
//   · OnboardingTour 와 충돌하지 않도록 컨테이너는 z-index 를 올리지 않는다.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수 — Node 테스트에서 직접 호출
// ────────────────────────────────────────────────────────────────────────────

export interface VisibleRange {
  startIndex: number;
  /** 마지막 가시 인덱스(포함). total=0 이면 -1. */
  endIndex: number;
}

/**
 * 현재 스크롤 위치 + 뷰포트 높이 + 행 높이 추정으로 가시 인덱스 범위를 계산한다.
 * `overscan` 은 가시 창 양쪽에 추가로 렌더할 행 수 — 빠른 스크롤에서 빈 영역이 보이는
 * 것을 막는다. 경계 바깥 값은 클램프되어 항상 유효한 인덱스를 돌려준다.
 */
export function computeVisibleRange(params: {
  scrollTop: number;
  viewportHeight: number;
  itemHeight: number;
  total: number;
  overscan?: number;
}): VisibleRange {
  if (params.total <= 0 || params.itemHeight <= 0 || params.viewportHeight <= 0) {
    return { startIndex: 0, endIndex: -1 };
  }
  const overscan = Number.isFinite(params.overscan) && params.overscan! >= 0
    ? Math.floor(params.overscan!)
    : 6;
  const last = params.total - 1;
  const firstVisible = Math.floor(Math.max(0, params.scrollTop) / params.itemHeight);
  const visibleCount = Math.ceil(params.viewportHeight / params.itemHeight);
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(last, firstVisible + visibleCount + overscan);
  return { startIndex, endIndex };
}

/**
 * 특정 메시지 id 가 어느 인덱스에 있는지 — 검색 점프용. 못 찾으면 -1.
 * id 가 중복되어도 첫 매치를 돌려준다(메시지 id 는 고유라고 가정).
 */
export function indexOfMessage<T extends { id: string }>(items: ReadonlyArray<T>, id: string): number {
  for (let i = 0; i < items.length; i += 1) if (items[i].id === id) return i;
  return -1;
}

// ────────────────────────────────────────────────────────────────────────────
// React 컴포넌트
// ────────────────────────────────────────────────────────────────────────────

export interface VirtualizedMessageListItem {
  id: string;
}

export interface VirtualizedMessageListProps<T extends VirtualizedMessageListItem> {
  items: ReadonlyArray<T>;
  /** 각 행의 추정 높이(px). 가변 높이도 overscan 으로 흔들림을 흡수. 기본 44. */
  itemHeight?: number;
  /** 뷰포트 스크롤 컨테이너 높이(px). 생략 시 부모 크기에 맞춰 100% 차지. */
  viewportHeight?: number;
  /** 양쪽 여분 행 수. 기본 6. */
  overscan?: number;
  /** 검색 등으로 자동 점프할 대상 메시지 id. 바뀌면 해당 인덱스로 스크롤. */
  scrollToId?: string | null;
  /** 행 렌더러. `isNearViewport` 는 이미지/썸네일 지연 로드 힌트. */
  renderItem: (item: T, params: { index: number; isNearViewport: boolean }) => React.ReactNode;
  className?: string;
  /** 스크롤 컨테이너 ref 외부 노출용 — 검색 오버레이가 강제 점프할 때 사용. */
  scrollRef?: React.RefObject<HTMLDivElement>;
}

export function VirtualizedMessageList<T extends VirtualizedMessageListItem>({
  items,
  itemHeight = 44,
  viewportHeight,
  overscan = 6,
  scrollToId,
  renderItem,
  className,
  scrollRef,
}: VirtualizedMessageListProps<T>): React.ReactElement {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const ref = scrollRef ?? internalRef;
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [measuredHeight, setMeasuredHeight] = useState<number>(viewportHeight ?? 320);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
  }, [ref]);

  useEffect(() => {
    if (viewportHeight !== undefined) {
      setMeasuredHeight(viewportHeight);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setMeasuredHeight(el.clientHeight));
    obs.observe(el);
    setMeasuredHeight(el.clientHeight);
    return () => obs.disconnect();
  }, [viewportHeight, ref]);

  // scrollToId 가 바뀌면 해당 인덱스로 점프. 검색 결과 점프 경로에서 사용.
  useEffect(() => {
    if (!scrollToId) return;
    const idx = indexOfMessage(items, scrollToId);
    if (idx < 0) return;
    const el = ref.current;
    if (!el) return;
    // 중앙 근처로 배치 — 사용자 체감상 "방금 찾은 줄" 이 한눈에 들어온다.
    const target = Math.max(0, idx * itemHeight - measuredHeight / 2 + itemHeight / 2);
    el.scrollTo({ top: target, behavior: 'smooth' });
  }, [scrollToId, items, itemHeight, measuredHeight, ref]);

  const range = useMemo(
    () => computeVisibleRange({
      scrollTop,
      viewportHeight: measuredHeight,
      itemHeight,
      total: items.length,
      overscan,
    }),
    [scrollTop, measuredHeight, itemHeight, items.length, overscan],
  );

  const totalHeight = items.length * itemHeight;
  const visible = items.slice(range.startIndex, range.endIndex + 1);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      data-testid="virtualized-message-list"
      data-total={items.length}
      data-rendered-from={range.startIndex}
      data-rendered-to={range.endIndex}
      className={`virtualized-message-list${className ? ` ${className}` : ''}`}
      style={{
        position: 'relative',
        overflowY: 'auto',
        height: viewportHeight !== undefined ? viewportHeight : '100%',
        background: 'var(--color-surface)',
      }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: range.startIndex * itemHeight,
            left: 0,
            right: 0,
          }}
        >
          {visible.map((item, idx) => {
            const absoluteIndex = range.startIndex + idx;
            // 가시 창 중앙 가까우면 원본 로딩, 바깥 overscan 은 lazy 힌트로 구분.
            const distanceFromVisible = Math.abs(absoluteIndex * itemHeight - scrollTop - measuredHeight / 2);
            const isNearViewport = distanceFromVisible < measuredHeight;
            return (
              <div
                key={item.id}
                data-testid="virtualized-message-row"
                data-index={absoluteIndex}
                style={{ minHeight: itemHeight }}
              >
                {renderItem(item, { index: absoluteIndex, isNearViewport })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
