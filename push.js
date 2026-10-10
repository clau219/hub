import * as db from './db.js';

export async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'Este navegador não aceita notificações push.';
  if (db.mode !== 'supabase') return 'Disponível depois de conectar o Supabase.';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'Ativas neste aparelho.' : Notification.permission === 'denied' ? 'Bloqueadas no navegador. Libere nas configurações do site.' : 'Desativadas neste aparelho.';
}

export async function enablePush() {
  if (db.mode !== 'supabase') throw new Error('Conecte o Supabase primeiro.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permissão de notificação negada.');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(await chavePublica()) });
  const j = sub.toJSON();
  const { error } = await db.client().from('push_subscriptions').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' });
  if (error) throw error;
}

// A chave pública fica no banco; na primeira vez o servidor gera o par de chaves
async function chavePublica() {
  const { data } = await db.client().from('app_config').select('value').eq('key', 'vapid_public').maybeSingle();
  if (data?.value) return data.value;
  const { data: r, error } = await db.client().functions.invoke('daily-digest', { body: { tipo: 'init' } });
  if (error || !r?.publicKey) throw new Error('Não foi possível preparar as notificações. As funções do servidor já foram publicadas?');
  return r.publicKey;
}

export async function testPush() {
  const { data, error } = await db.client().functions.invoke('daily-digest', { body: { tipo: 'teste' } });
  if (error) throw error;
  return data;
}

function b64(s) {
  const p = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
