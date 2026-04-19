// 공용 포커스 트랩 유틸. SharedGoalModal 같은 모달 컴포넌트가 Tab 순환을 구현할 때
// 중복되기 쉬운 **순수 로직**(선택기 화이트리스트 · 순환 인덱스 계산) 을 한 곳에
// 모은다. DOM 질의는 호출자가 수행해 브라우저·JSDOM·Node 모두에서 본 유틸을
// 공유할 수 있고, 순수 함수만 export 하므로 node:test 로 바로 검증 가능하다.
//
// 기존 `SharedGoalModal.tsx::handleDialogKeyDown` 는 본 유틸로 옮기지 않는다 —
// 회귀 테스트(`tests/focusRingAndTrap.regression.test.ts`) 가 모달 내부의 3요소
// (dialogRef + handleDialogKeyDown + lastFocusRef) 존재를 잠그고 있어 구조 변경이
// 필요한 큰 리팩터가 된다. 본 PR 은 **후속 도입자를 위한 공용 기반** 만 제공한다.

/**
 * W3C ARIA 포커스 관리 가이드에서 제시하는 기본 "tabbable" 선택기 화이트리스트.
 * 호출자는 컨테이너에 `container.querySelectorAll(TABBABLE_SELECTORS.join(','))`
 * 를 돌려 포커스 후보를 얻는다. `[tabindex="-1"]` 는 의도적으로 제외(프로그램적
 * 포커스만 허용하는 원소) 한다.
 */
export const TABBABLE_SELECTORS: readonly string[] = Object.freeze([
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[role="button"]:not([aria-disabled="true"])',
  '[role="tab"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[tabindex]:not([tabindex="-1"])',
  'details > summary:first-of-type',
]) as readonly string[];

/**
 * 공용 퍼블릭 API · Tab(forward) / Shift+Tab(backward) 순환용 다음 포커스 인덱스.
 * `total` 이 0 이면 -1 을 돌려 "포커스 가능 요소 없음" 을 신호로 쓴다.
 * `currentIndex` 가 -1(초기 상태) 이면 forward 는 0, backward 는 total-1 로 진입한다.
 */
export function computeNextFocusIndex(
  currentIndex: number,
  total: number,
  direction: 'forward' | 'backward',
): number {
  if (!Number.isFinite(total) || total <= 0) return -1;
  const n = Math.floor(total);
  if (!Number.isFinite(currentIndex)) {
    return direction === 'forward' ? 0 : n - 1;
  }
  const c = Math.floor(currentIndex);
  if (c < 0) return direction === 'forward' ? 0 : n - 1;
  if (direction === 'forward') return (c + 1) % n;
  return (c - 1 + n) % n;
}

/**
 * 선택기 배열을 `container.querySelectorAll` 용 단일 문자열로 직렬화.
 * TABBABLE_SELECTORS 외에 호출자가 추가 선택기를 섞고 싶을 때 실수로 쉼표를
 * 빠뜨리지 않도록 도와주는 얇은 헬퍼.
 */
export function toQuerySelector(selectors: readonly string[]): string {
  return selectors.filter(s => typeof s === 'string' && s.trim().length > 0).join(', ');
}
