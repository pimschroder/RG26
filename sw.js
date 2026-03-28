const CACHE = 'rg2026-v2';
const STATIC = [
  './',
  './index.html',
  './app.js',
  './style.css',
];

// Install: cache de app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

// Activate: verwijder oude caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first voor eigen bestanden, network-first voor Supabase
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Supabase API + realtime: altijd via netwerk
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.io')) {
    return; // browser handelt zelf af
  }

  // Google Fonts: cache na eerste keer
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    e.respondWith(
      caches.open(CACHE).then(async c => {
        const cached = await c.match(e.request);
        if (cached) return cached;
        const fresh = await fetch(e.request);
        c.put(e.request, fresh.clone());
        return fresh;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // CDN scripts (xlsx, supabase-js): cache na eerste keer
  if (url.hostname.includes('cdn.jsdelivr.net')) {
    e.respondWith(
      caches.open(CACHE).then(async c => {
        const cached = await c.match(e.request);
        if (cached) return cached;
        const fresh = await fetch(e.request);
        c.put(e.request, fresh.clone());
        return fresh;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Eigen bestanden (HTML, JS, CSS, images): cache-first, update op achtergrond
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(CACHE).then(async c => {
        const cached = await c.match(e.request);
        // Altijd achtergrond-update voor HTML/JS/CSS zodat nieuwe versies doorkomen
        const fetchPromise = fetch(e.request).then(fresh => {
          if (fresh.ok) c.put(e.request, fresh.clone());
          return fresh;
        }).catch(() => null);
        // Geef gecachede versie direct terug als die er is (stale-while-revalidate)
        return cached || fetchPromise;
      })
    );
    return;
  }
});
