// Service Worker do painel FlashCred.
// Objetivo: apenas permitir que o navegador ofereça "Instalar app".
// Não guarda em cache os dados do painel (propostas, comissões, etc.)
// para sempre mostrar informação atualizada — só o "casco" do app.

const CACHE_NAME = 'flashcred-painel-v1';
const ARQUIVOS_ESTATICOS = [
  './painel.html',
  './manifest.json',
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

// Network-first: sempre tenta buscar da internet primeiro (dados atualizados).
// Só usa o cache se estiver sem internet.
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

// Ao tocar na notificação, abre (ou foca) o painel.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const cliente of lista) {
        if (cliente.url.includes('painel.html') && 'focus' in cliente) {
          return cliente.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./painel.html');
      }
    })
  );
});
