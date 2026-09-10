// Service worker — caches the complete local app shell for offline / fast repeat loads.
// Same-origin code is network-first so releases do not stick.
const CACHE_PREFIX = 'handul-planet-';
const CACHE = CACHE_PREFIX + 'v106';
const SHELL = [
  './',
  './index.html',
  './src/boot.js?v=106',
  './src/main.js?v=106',
  './src/rose-story.js?v=105',
  './src/render-efficiency.js?v=104',
  './src/world/spatial-structure.js?v=103',
  './src/village-board.js?v=102',
  './src/render-stability.js?v=102',
  './config/village-board.json',
  './src/world/public-spaces.js?v=105',
  './src/paper-style.js?v=97',
  './src/world/harbor-kit.js?v=105',
  './src/world/paper-assets.js?v=105',
  './assets/papercut/contours.js?v=97',
  './src/status-source.js?v=70',
  './src/public-dashboard.js?v=70',
  './src/release-quality.js?v=76',
  './src/sky.js?v=97',
  './src/ambient-audio.js?v=104',
  './src/performance.js?v=64',
  './src/agent-activity.js?v=70',
  './src/agent-results.js?v=60',
  './src/agent-signatures.js?v=72',
  './src/input-controls.js?v=71',
  './src/style.css?v=106',
  './favicon.ico',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/fonts/nunito-latin-600-normal.woff2',
  './assets/fonts/nunito-latin-700-normal.woff2',
  './assets/fonts/nunito-latin-800-normal.woff2',
  './vendor/three/build/three.module.min.js',
  './vendor/three/examples/jsm/loaders/GLTFLoader.js',
  './vendor/three/examples/jsm/postprocessing/EffectComposer.js',
  './vendor/three/examples/jsm/postprocessing/MaskPass.js',
  './vendor/three/examples/jsm/postprocessing/OutputPass.js',
  './vendor/three/examples/jsm/postprocessing/Pass.js',
  './vendor/three/examples/jsm/postprocessing/RenderPass.js',
  './vendor/three/examples/jsm/postprocessing/ShaderPass.js',
  './vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js',
  './vendor/three/examples/jsm/shaders/CopyShader.js',
  './vendor/three/examples/jsm/shaders/LuminosityHighPassShader.js',
  './vendor/three/examples/jsm/shaders/OutputShader.js',
  './vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
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
