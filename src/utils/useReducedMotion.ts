/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `prefers-reduced-motion: reduce` 미디어 쿼리를 추적하는 공용 훅.
 * SSR 세이프(window 미존재 시 false 반환)이며 mq 변화도 구독해 즉시 반영한다.
 *
 * 도입 배경: `CollabTimeline`이 자체 훅을 지니고 있었으나, `AgentStatusPanel`·
 * `AgentContextBubble`의 펄스 애니메이션에도 동일 규칙을 공유해야 해서 디자이너가
 * 추출을 예고(2026-04-17 디자이너 블록 §6.2). 추출만 하고 기존 호출부는 순차 마이그레이션.
 *
 * 테스트 가능성: matchMedia 읽기/구독을 순수 헬퍼(`readReducedMotion`,
 * `subscribeReducedMotion`)로 분리해, 노드 단위 테스트가 React 렌더 의존 없이도
 * SSR 분기·mq 변경 구독·해제 계약을 모두 검증할 수 있도록 한다.
 */

import { useEffect, useState } from 'react';

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// matchMedia 인터페이스의 최소 표면. 실제 Window 의 MediaQueryList 와 호환되며
// 테스트에서는 같은 모양의 가짜 객체를 주입할 수 있다.
export interface ReducedMotionWindow {
  matchMedia?: (query: string) => {
    matches: boolean;
    addEventListener?: (type: 'change', cb: () => void) => void;
    removeEventListener?: (type: 'change', cb: () => void) => void;
    addListener?: (cb: () => void) => void; // 레거시 사파리
    removeListener?: (cb: () => void) => void;
  };
}

// SSR · matchMedia 미지원 환경에서는 보수적으로 false 를 반환.
// "모션을 켜둔다" 는 기본값을 의도적으로 선택한 것은 호출부가 펄스/모션을
// 기본 활성으로 가정하고 reducedMotion 을 가드로만 쓰기 때문이다.
export function readReducedMotion(win: ReducedMotionWindow | undefined): boolean {
  if (!win || typeof win.matchMedia !== 'function') return false;
  try {
    return win.matchMedia(REDUCED_MOTION_QUERY).matches === true;
  } catch {
    return false;
  }
}

// mq 변경 구독. 반환값은 구독 해제 함수. matchMedia 미지원 시 no-op.
// 신/구 API(addEventListener / addListener)를 모두 지원해 사파리 14 미만에서도 동작한다.
export function subscribeReducedMotion(
  win: ReducedMotionWindow | undefined,
  onChange: (value: boolean) => void,
): () => void {
  if (!win || typeof win.matchMedia !== 'function') return () => {};
  const mq = win.matchMedia(REDUCED_MOTION_QUERY);
  const handler = () => onChange(mq.matches === true);
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }
  if (typeof mq.addListener === 'function') {
    mq.addListener(handler);
    return () => mq.removeListener?.(handler);
  }
  return () => {};
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    readReducedMotion(typeof window === 'undefined' ? undefined : window),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setReduced(readReducedMotion(window));
    return subscribeReducedMotion(window, setReduced);
  }, []);

  return reduced;
}

export default useReducedMotion;
