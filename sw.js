const CACHE_NAME = 'openshelf-v13';
const CDN_CACHE = 'openshelf-cdn-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './base.css',
  './style.css',
  './app.js',
  './epub-parser.js',
  './tts-engine.js',
  './tts-worker.js',
  './db.js',
  './manifest.json',
  './assets/icon-192.svg',
  './assets/icon-512.svg',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

// CDN domains to cache for offline use
const CACHEABLE_CDN = [
  'esm.sh',
  'cdn.jsdelivr.net',
  'huggingface.co'
];

// ===== INSTALL: pre-cache app shell =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(STATIC_ASSETS).catch(() => {
        // If some assets fail (e.g. PNG icons not yet generated), still install
        return cache.addAll(STATIC_ASSETS.filter(a => !a.endsWith('.png')));
      })
    )
  );
  self.skipWaiting();
});

// ===== ACTIVATE: clean old caches =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CDN_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ===== FETCH: layered caching strategies =====
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Strategy 1: Same-origin — stale-while-revalidate
  // Serve from cache immediately for speed, fetch update in background
  if (url.origin === location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          const networkFetch = fetch(event.request).then(response => {
            if (response.ok) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => null);

          // Return cached immediately if available; otherwise wait for network
          if (cached) {
            // Fire-and-forget background update
            networkFetch;
            return cached;
          }
          return networkFetch.then(res => {
            if (res) return res;
            // Final fallback for navigation
            if (event.request.destination === 'document') {
              return cache.match('./index.html');
            }
            return new Response('Offline', { status: 503 });
          });
        })
      )
    );
    return;
  }

  // Strategy 2: CDN resources — stale-while-revalidate with persistent cache
  if (CACHEABLE_CDN.some(domain => url.hostname.includes(domain))) {
    event.respondWith(
      caches.open(CDN_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          const networkFetch = fetch(event.request)
            .then(response => {
              if (response.ok) {
                cache.put(event.request, response.clone());
              }
              return response;
            })
            .catch(() => null);

          if (cached) {
            networkFetch; // Background update
            return cached;
          }
          return networkFetch.then(res => {
            if (res) return res;
            return new Response('Offline — resource not cached', { status: 503 });
          });
        })
      )
    );
    return;
  }

  // Strategy 3: Other cross-origin — network-only
});

// ===== MESSAGE HANDLERS =====
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
