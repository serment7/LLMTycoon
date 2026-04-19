/*
 * 정적 자산 셸 서비스 워커(#0dceedcd) — LLMTycoon.
 *
 * 범위 제한(docs/pwa-scope.md 와 동기화)
 *   · 캐시 대상: 자체 호스트의 정적 자산(`/`, `/index.html`, `/assets/*`, `/icons/*`,
 *     `/offline.html`, `/manifest.webmanifest`).
 *   · 제외 대상: `/api/*` (Claude·세션·미디어 API), `/socket.io/*` (실시간), `IndexedDB`,
 *     `pendingRequestQueue` 와 `claudeSubscriptionSession` 경로. fetch 이벤트에서 이들
 *     URL 을 만나면 respondWith 를 호출하지 않고 네트워크가 직접 처리하도록 패스스루.
 *   · 업데이트 감지: 클라이언트가 `{type:'SKIP_WAITING'}` 메시지를 보내면 skipWaiting 을
 *     호출해 즉시 활성화. 이후 `controllerchange` 가 상위에서 새로고침을 촉발한다.
 */

const CACHE_NAME = 'llmtycoon-shell-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS)).catch(() => {
      // 아이콘이 아직 없어도 설치 자체는 성공해야 한다 — addAll 실패를 조용히 흡수.
    }),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )),
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  // 교차 출처는 패스스루.
  if (url.origin !== self.location.origin) return;
  // API · 소켓 · 미디어 업로드는 절대 가로채지 않는다.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  // HTML 네비게이션: 네트워크 우선, 실패 시 오프라인 폴백.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html')),
    );
    return;
  }
  // 기타 정적 자산: 캐시 우선, 미스 시 네트워크 → 캐시 저장.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(() => cached);
    }),
  );
});
