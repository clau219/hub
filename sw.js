// Service worker: cache do app (abre rápido e offline) + notificações push
const CACHE = 'hub-v6';
const ASSETS = ['./', 'index.html', 'app.css', 'app.js', 'config.js', 'db.js', 'store.js', 'util.js', 'ui.js', 'push.js', 'habitos.js', 'hospedagem.js',
  'v-hoje.js', 'v-pipeline.js', 'v-agenda.js', 'v-alugueis.js', 'v-tarefas.js', 'v-contatos.js', 'v-ajustes.js', 'cripto.js', 'v-cripto.js',
  'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Rede primeiro (sempre a versão nova), cache como reserva
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request)));
});

self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Hub', body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Hub', { body: d.body, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './#/hoje' }, tag: d.tag }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(ws => {
    const w = ws.find(w => w.url.includes(self.registration.scope));
    return w ? (w.navigate(e.notification.data.url), w.focus()) : clients.openWindow(e.notification.data.url);
  }));
});
