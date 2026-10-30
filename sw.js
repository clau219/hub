// Service worker: cache do app (abre rápido e offline) + notificações push
const CACHE = 'hub-v57';
const CDN = 'hub-cdn-v1'; // bibliotecas com versão fixa e fontes: não mudam, ficam em cache
const ASSETS = ['./', 'index.html', 'app.css', 'glass.css', 'app.js', 'config.js', 'db.js', 'store.js', 'util.js', 'ui.js', 'push.js', 'habitos.js', 'hospedagem.js',
  'v-hoje.js', 'v-pipeline.js', 'v-agenda.js', 'v-alugueis.js', 'v-tarefas.js', 'v-contatos.js', 'v-ajustes.js', 'v-whatsapp.js', 'boasvindas.js', 'cripto.js', 'v-cripto.js', 'v-saude.js', 'saude-insights.js', 'frases.js', 'v-financas.js', 'v-fin-carteira.js', 'fin-calc.js', 'fin-graficos.js', 'moeda.js', 'palette.js',
  'manifest.webmanifest', 'icon.svg'];

// Um arquivo que falhe não impede a instalação (addAll falharia inteiro)
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(ASSETS.map(a => c.add(a)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== CDN).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Rede primeiro (sempre a versão nova), cache como reserva
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Supabase JS (versão fixa no jsDelivr) e Google Fonts: cache primeiro, para o app abrir sem rede
  if (u.hostname === 'cdn.jsdelivr.net' || u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(CDN).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }))));
    return;
  }
  if (u.origin !== location.origin) return;
  // no-cache: confere com o servidor (resposta 304 é leve) em vez de usar a cópia de até 10 min do navegador
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
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
