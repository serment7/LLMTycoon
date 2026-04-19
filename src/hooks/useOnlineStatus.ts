// 지시 #3f1b7597 §2 — `navigator.onLine` + 'online'/'offline' 이벤트 기반 훅.
//
// App.tsx 상단바 오프라인 배너, 전송 버튼 라벨 전환, `pendingRequestQueue` 재시도
// 트리거 세 축이 같은 신호를 구독해야 하므로 단일 진원을 React 훅으로 노출한다.
// 테스트 용이성을 위해 `resolveInitialOnline` 순수 함수를 함께 공개한다 — Node
// 환경에서 `navigator` 가 없을 때도 계약을 잠글 수 있다.

import { useEffect, useSyncExternalStore } from 'react';

/** SSR/Node 폴백 포함. `navigator.onLine` 은 명시적으로 false 일 때만 offline 으로 본다. */
export function resolveInitialOnline(nav?: { onLine?: boolean }): boolean {
  const navigator = nav ?? (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  if (!navigator || typeof navigator.onLine !== 'boolean') return true;
  return navigator.onLine;
}

function subscribe(callback: () => void): () => void {
  const win = (globalThis as { window?: Window }).window;
  if (!win || typeof win.addEventListener !== 'function') return () => { /* SSR */ };
  win.addEventListener('online', callback);
  win.addEventListener('offline', callback);
  return () => {
    win.removeEventListener('online', callback);
    win.removeEventListener('offline', callback);
  };
}

function getSnapshot(): boolean {
  return resolveInitialOnline();
}

function getServerSnapshot(): boolean {
  // SSR 에서는 항상 online 으로 낙관적 가정 — 첫 하이드레이션 직후 실제 값과
  // 동기화된다. false 를 기본으로 두면 마운트 플래시로 오프라인 배너가 번쩍거림.
  return true;
}

export function useOnlineStatus(): boolean {
  const online = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // 마운트 시점의 navigator.onLine 과 이벤트 사이의 경합을 방지하기 위해 한 번 더
  // 이벤트 바인딩 이후에 snapshot 을 강제 재평가할 필요는 없다 — useSyncExternalStore
  // 가 subscribe 성립 시 자동으로 getSnapshot 을 재호출한다.
  useEffect(() => { /* 설치는 subscribe 안에서 끝남 */ }, []);
  return online;
}
