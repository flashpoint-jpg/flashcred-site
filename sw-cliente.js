// Service Worker do app do cliente FlashCred (index.html + consultar.html).
// Mesmo esquema dos outros dois: só permite "Instalar app" e guarda em
// cache o "casco" do app — os dados da proposta sempre vêm direto do
// servidor, nunca do cache, pra nunca mostrar informação desatualizada.

const CACHE_NAME = 'flashcred-cliente-v1';
const ARQUIVOS_ESTATICOS = [
  './index.html',
  './consultar.html',
  './manifest-cliente.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARQUIVOS_ESTATICOS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(
        nomes
          .filter((nome) => nome !== CACHE_NAME)
          .map((nome) => caches.delete(nome))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return resposta;
      })
      .catch(() => caches.match(event.request))
  );
});

// Notificação push de verdade — chega mesmo com o app fechado, vinda do servidor.
self.addEventListener('push', (event) => {
  let dados = { title: 'FlashCred', body: 'Você tem uma novidade.' };
  try { dados = event.data.json(); } catch(e) {}

  event.waitUntil(
    self.registration.showNotification(dados.title, {
      body: dados.body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      vibrate: [200,100,200],
      tag: 'flashcred-push',
      data: dados.data || {}
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const cliente of lista) {
        if (cliente.url.includes('consultar.html') && 'focus' in cliente) {
          return cliente.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./consultar.html');
      }
    })
  );
});
