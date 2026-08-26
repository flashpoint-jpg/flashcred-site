// Service Worker mínimo - necessário para o navegador
// ativar o modo "instalável" (PWA) e o display standalone.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Estratégia simples: tenta buscar da rede, se falhar tenta do cache.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
