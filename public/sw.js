const CACHE_NAME = 'dasav-v4';
const STATIC_ASSETS = [
  '/public/styles.css?v=10',
  '/public/theme.js',
  '/public/booking.js?v=10',
  '/public/admin.js',
  '/public/tracker.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Ignorar si algún recurso estático falla en instalación
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // NUNCA cachear llamadas a API ni archivos versionados con query params (?v=...)
  if (url.pathname.startsWith('/api/') || url.searchParams.has('v')) {
    return;
  }

  // Solo aplicar caché a recursos estáticos base de /public/
  if (url.pathname.startsWith('/public/')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          // Fetch fresco en segundo plano (stale-while-revalidate)
          fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
            }
          }).catch(() => {});
          return cachedResponse;
        }
        return fetch(event.request);
      })
    );
  }
});
