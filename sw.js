const CACHE = 'rg2026-v74';
const STATIC = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icon.svg',
  // Avatars — gegarandeerd offline beschikbaar na install
  './images/avatars/Pim.png',
  './images/avatars/Emil.png',
  './images/avatars/Jules.png',
  './images/avatars/Rosan.png',
  './images/avatars/Aaron.png',
  './images/avatars/Damian.png',
  './images/avatars/Lucas.png',
  './images/avatars/Anne-Gert.png',
  './images/avatars/Jarno.png',
  './images/avatars/Peter.png',
  './images/avatars/Remco.png',
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

// Push: toon notificatie ook als app dicht is
self.addEventListener('push', e => {
  let data = { title: 'RG 2026', body: 'Nieuwe overdracht geschreven' };
  try { data = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icon.svg',
      badge: './icon.svg',
      tag: 'rg-overdracht',
      renotify: true,
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) { existing.focus(); existing.postMessage({ type: 'open-overdracht' }); }
      else clients.openWindow('/?page=overdracht');
    })
  );
});

// Fetch: cache-first voor eigen bestanden, network-first voor Supabase
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Supabase API + realtime: altijd via netwerk
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.io')) {
    return;
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
        const fetchPromise = fetch(e.request).then(fresh => {
          if (fresh.ok) c.put(e.request, fresh.clone());
          return fresh;
        }).catch(() => null);
        return cached || fetchPromise;
      })
    );
    return;
  }
});
