import { CONFIG } from './config.js';
import * as db from './db.js';

export async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'Este navegador não aceita notificações push.';
  if (db.mode !== 'supabase') return 'Disponível depois de conectar o Supabase.';
  if (!CONFIG.VAPID_PUBLIC_KEY) return 'Falta a chave VAPID em js/config.js (README, passo 5).';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'Ativas neste aparelho.' : Notification.permission === 'denied' ? 'Bloqueadas no navegador. Libere nas configurações do site.' : 'Desativadas neste aparelho.';
}

export async function enablePush() {
  if (db.mode !== 'supabase') throw new Error('Conecte o Supabase primeiro.');
  if (!CONFIG.VAPID_PUBLIC_KEY) throw new Error('Falta a chave VAPID em js/config.js.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permissão de notificação negada.');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(CONFIG.VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  const { error } = await db.client().from('push_subscriptions').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' });
  if (error) throw error;
}

function b64(s) {
  const p = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
