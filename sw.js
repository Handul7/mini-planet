// Service worker — caches the local app shell for offline / fast repeat loads.
// Same-origin code is network-first so releases do not stick. Three.js CDN
// modules are runtime-cached after a successful load for repeat/offline use.
const CACHE_PREFIX = 'handul-planet-';
const CACHE = CACHE_PREFIX + 'v65';
const SHELL = [
  './',
  './index.html',
  './src/main.js?v=65',
  './src/status-source.js?v=65',
  './src/sky.js?v=63',
  './src/ambient-audio.js?v=62',
  './src/performance.js?v=63',
  './src/agent-activity.js?v=60',
  './src/agent-results.js?v=60',
  './src/style.css?v=65',
  './manifest.json',
  './config/agents.json',
  './config/services.json',
  './config/site.json',
  './config/runtime.json',
  './agent-results.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // only touch OUR caches — Cache Storage is origin-wide, and on shared
      // hosts (e.g. username.github.io) other apps' caches live beside ours
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  // ?dev=... assets intentionally bypass every cache, including an older
  // service worker that still controls the current tab.
  if (url.searchParams.has('dev')) return;

  // Runtime-cache version-pinned Three.js modules. The request uses CORS and
  // unpkg returns CORS-enabled responses, so cached modules remain executable.
  if (url.origin === 'https://unpkg.com' && url.pathname.startsWith('/three@0.160.0/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone())).catch(() => {});
        return res;
      }))
    );
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Public dashboard snapshots are live data — never serve them from cache.
  if (url.pathname.endsWith('agent-status.json') || url.pathname.endsWith('agent-results.json')) return;

  // Navigations, source, and config are network-first so deployments and
  // user edits appear immediately, with the cache only as offline fallback.
  const networkFirst = request.mode === 'navigate'
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('.js')
    || url.pathname.endsWith('.css')
    || url.pathname.includes('/config/');
  if (networkFirst) {
    event.respondWith(
      fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for immutable local models/images and the remaining shell.
  event.respondWith(
    caches.match(request).then((cached) =>
      cached ||
      fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached)
    )
  );
});
