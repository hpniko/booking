/**
 * public/sw.js — offline shell + Web Push for Postre Booking (§8.2).
 *
 * The API is NEVER cached: a stale board or a stale money figure is worse than
 * an honest "you are offline". Only the app shell is cached.
 */
// Shell assets use STALE-WHILE-REVALIDATE (see the fetch handler below), so the
// cache version is no longer something every code change has to remember to
// bump. It is kept only to force a clean slate when the caching STRATEGY
// changes — which is what v6 does.
// v6: shell is stale-while-revalidate instead of cache-first.
const CACHE = 'postre-booking-v6';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return; // live data only

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Shell assets: STALE-WHILE-REVALIDATE.
  //
  // This used to be plain cache-first, which meant the cached copy of app.js
  // was returned FOREVER unless someone remembered to bump the cache name by
  // hand. Anything installed during development kept running old JavaScript
  // against a new document — the classic "works on my desktop, broken on my
  // phone" report. Relying on a manual bump for every commit is a trap that
  // gets sprung exactly as often as it is written down here.
  //
  // Now: serve the cached copy instantly (fast paint, works offline) and
  // refresh it in the background, so the NEXT load is current. A rider on a
  // patchy connection never waits on the network for the shell.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((hit) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
              cache.put(req, res.clone()).catch(() => undefined);
            }
            return res;
          })
          .catch(() => null);
        // A cached copy wins immediately; otherwise we wait on the network.
        return hit || network.then((res) => res || Response.error());
      }),
    ),
  );
});

/** Push payload is `{ title, body, url, tag }` from src/services/push.ts. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Postre Booking', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Postre Booking';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || '#/' },
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '#/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ type: 'navigate', url: target });
          return client.focus();
        }
      }
      const url = target.startsWith('#') ? `/${target}` : target;
      return self.clients.openWindow(url);
    }),
  );
});
