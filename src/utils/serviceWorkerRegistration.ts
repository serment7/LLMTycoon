// 서비스 워커 등록 유틸(#0dceedcd) — PWA 오프라인 셸을 `/service-worker.js` 로 부팅한다.
//
// 범위 제한
//   · 본 유틸은 "정적 자산 + 오프라인 폴백" 셸만 캐싱하도록 설계된 서비스 워커를 등록한다.
//   · Claude API(`/api/claude/*`) · IndexedDB · pendingRequestQueue 경로는 서비스 워커가
//     가로채지 않도록 `service-worker.js` 측 fetch 핸들러에서 명시 제외한다(문서: docs/pwa-scope.md).
//
// 업데이트 감지
//   · 새 워커가 발견되면 `onUpdate` 콜백을 호출 — 상위가 토스트로 "새 버전이 있어요" 를
//     고지하고, 사용자가 수락하면 `skipWaiting` 메시지를 보내 즉시 갱신한다.

export interface RegisterServiceWorkerOptions {
  /** 실제 서비스 워커 파일 경로. 개발 모드에서는 등록 자체를 건너뛴다. */
  scriptUrl?: string;
  /** 새 버전이 설치되었을 때 호출. 상위가 토스트 등을 띄운다. */
  onUpdate?: (registration: ServiceWorkerRegistration) => void;
  /** 최초 설치(오프라인 대응 완료) 시 호출. */
  onReady?: (registration: ServiceWorkerRegistration) => void;
  /** 등록 실패 시 호출. 네트워크/권한 오류 등. */
  onError?: (error: unknown) => void;
}

/** 현재 환경이 서비스 워커 등록에 적합한지 판정(브라우저·https·지원 여부). */
export function canRegisterServiceWorker(env?: {
  hasNavigator?: boolean;
  hasServiceWorker?: boolean;
  isSecureContext?: boolean;
  hostname?: string;
}): boolean {
  const nav = typeof navigator !== 'undefined';
  const hasSW = env?.hasServiceWorker ?? (nav && 'serviceWorker' in navigator);
  const navPresent = env?.hasNavigator ?? nav;
  if (!navPresent || !hasSW) return false;
  // 개발 서버(localhost/127.0.0.1) 는 보안 컨텍스트로 간주.
  const host = env?.hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  const secure = env?.isSecureContext
    ?? (typeof window !== 'undefined'
      ? (window.isSecureContext || host === 'localhost' || host === '127.0.0.1')
      : false);
  return Boolean(secure);
}

/**
 * 서비스 워커를 등록하고 수명주기 이벤트를 콜백으로 전달한다. 실제 fetch/캐시 규칙은
 * 서비스 워커 스크립트가 소유한다. 본 함수는 "등록" 만 책임지며 env 감지가 실패하면
 * no-op 로 즉시 반환한다.
 */
export function registerServiceWorker(options: RegisterServiceWorkerOptions = {}): Promise<ServiceWorkerRegistration | null> {
  if (!canRegisterServiceWorker()) return Promise.resolve(null);
  const scriptUrl = options.scriptUrl ?? '/service-worker.js';
  return navigator.serviceWorker.register(scriptUrl).then(registration => {
    // 새 워커 발견 → installing 을 추적해 installed 상태가 되면 onUpdate 발화.
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          options.onUpdate?.(registration);
        }
        if (worker.state === 'activated' && !navigator.serviceWorker.controller) {
          options.onReady?.(registration);
        }
      });
    });
    if (registration.active && !navigator.serviceWorker.controller) {
      options.onReady?.(registration);
    }
    return registration;
  }).catch(err => {
    options.onError?.(err);
    return null;
  });
}

/** 대기 중인 워커에게 skipWaiting 메시지를 보내고, 컨트롤러 변경 시 새로고침한다. */
export function applyWaitingUpdate(registration: ServiceWorkerRegistration | null | undefined): void {
  if (!registration) return;
  const waiting = registration.waiting;
  if (!waiting) return;
  waiting.postMessage({ type: 'SKIP_WAITING' });
  const reload = () => { if (typeof window !== 'undefined') window.location.reload(); };
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
  }
}
