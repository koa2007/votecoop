// VoteCoop service worker — relative paths so it works under any base URL
// (root domain, GitHub Pages /votecoop/, or any sub-path).

const CACHE_VERSION = 'spilka-v5';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Compute base scope — what the SW is registered against.
// e.g. '/votecoop/' on GitHub Pages or '/' on root.
const BASE = new URL(self.registration.scope).pathname;

const PRECACHE = [
    '',                          // resolves to BASE — the app shell
    'index.html',
    'offline.html',
    'css/style.css',
    'js/app.js',
    'js/supabase.js',
    'js/config.js',
    'manifest.json',
    'icons/icon-192.png',
    'icons/icon-512.png'
].map(p => new URL(p, self.registration.scope).pathname);

// === INSTALL: precache the app shell ===
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
            .catch(() => { /* tolerate offline-during-install */ })
    );
});

// === ACTIVATE: clean up old caches ===
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(k => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// Helper — true if URL is the Supabase API or any cross-origin call we should not cache
function isApiRequest(url) {
    return /\.supabase\.co$/.test(url.hostname)
        || url.pathname.includes('/rest/v1/')
        || url.pathname.includes('/auth/v1/')
        || url.pathname.includes('/realtime/v1/');
}

// === FETCH: route by request type ===
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // 1) NEVER cache Supabase / API calls — always go to network.
    if (isApiRequest(url)) return;

    // 2) Navigation requests → network-first, fallback to cached index, then offline page
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then(res => {
                    const copy = res.clone();
                    caches.open(RUNTIME_CACHE).then(c => c.put(req, copy));
                    return res;
                })
                .catch(async () => {
                    return (await caches.match(req))
                        || (await caches.match(new URL('index.html', self.registration.scope).pathname))
                        || (await caches.match(new URL('offline.html', self.registration.scope).pathname));
                })
        );
        return;
    }

    // 3) Same-origin static assets → cache-first, refresh in background
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(req).then(cached => {
                const fetchPromise = fetch(req)
                    .then(res => {
                        if (res && res.status === 200 && res.type === 'basic') {
                            const copy = res.clone();
                            caches.open(RUNTIME_CACHE).then(c => c.put(req, copy));
                        }
                        return res;
                    })
                    .catch(() => cached);
                return cached || fetchPromise;
            })
        );
        return;
    }

    // 4) Third-party (CDNs: Phosphor icons, Supabase JS) → stale-while-revalidate
    event.respondWith(
        caches.match(req).then(cached => {
            const fetchPromise = fetch(req)
                .then(res => {
                    if (res && res.status === 200) {
                        const copy = res.clone();
                        caches.open(RUNTIME_CACHE).then(c => c.put(req, copy));
                    }
                    return res;
                })
                .catch(() => cached);
            return cached || fetchPromise;
        })
    );
});

// Allow page to ask SW to skipWaiting (so a fresh deploy activates immediately)
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
