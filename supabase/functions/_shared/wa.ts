import webpush from 'npm:web-push@3.6.7';

// Peças comuns do WhatsApp das casas (wa-webhook e wa-responder): envio pela Z-API e a base de informações
// das casas (app_config 'wa_base', preenchida na aba WhatsApp > Informações das casas).

// Envia texto pela Z-API. Devolve o id da mensagem no WhatsApp ou null (o motivo vai para o log).
export async function enviarZapi(to: string, body: string, { digitando = 3 } = {}) {
  const r = await fetch(`https://api.z-api.io/instances/${Deno.env.get('ZAPI_INSTANCE')}/token/${Deno.env.get('ZAPI_TOKEN')}/send-text`, {
    method: 'POST', headers: { 'Client-Token': Deno.env.get('ZAPI_CLIENT_TOKEN') || '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: to, message: body, ...(digitando ? { delayTyping: digitando } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !(j.messageId || j.id)) { console.error('envio Z-API', r.status, JSON.stringify(j)); return null; }
  return { wamid: (j.messageId || j.id) as string };
}

// Canal das conversas com hóspedes: 'meta' (API oficial, coexistência) ou 'zapi'. WA_CANAL decide; sem ele, Z-API
// se estiver configurada. O canal que não está valendo é ignorado na entrada (senão cada mensagem viria duas vezes).
export const canalWa = (): 'meta' | 'zapi' => {
  const c = Deno.env.get('WA_CANAL');
  return c === 'meta' || c === 'zapi' ? c : Deno.env.get('ZAPI_INSTANCE') ? 'zapi' : 'meta';
};
const GRAPH = () => `https://graph.facebook.com/${Deno.env.get('WA_GRAPH_VERSION') || 'v25.0'}`;

// Envia texto pela API oficial (WA_TOKEN + WA_PHONE_ID, ou o número que veio no webhook). Fora da janela de 24 h
// depois da última mensagem da pessoa a Meta recusa texto livre: devolve null e o motivo vai para o log.
export async function enviarMeta(to: string, body: string, phoneIdWebhook?: string) {
  const phoneId = Deno.env.get('WA_PHONE_ID') || phoneIdWebhook;
  const token = Deno.env.get('WA_TOKEN');
  if (!phoneId || !token) { console.error('WA_TOKEN/WA_PHONE_ID ausentes'); return null; }
  const r = await fetch(`${GRAPH()}/${phoneId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('envio WhatsApp', r.status, JSON.stringify(j)); return null; }
  return { wamid: j.messages?.[0]?.id as string };
}

// Envia pelo canal que está valendo
export const enviarWa = (to: string, body: string, { digitando = 3, phoneId }: { digitando?: number; phoneId?: string } = {}) =>
  canalWa() === 'meta' ? enviarMeta(to, body, phoneId) : enviarZapi(to, body, { digitando });

// Foto, PDF ou áudio que chegou pela API oficial: a Meta manda só o id; o link sai da Graph API e o download
// precisa do token
export async function baixarMetaMidia(id: string, maxMb = 20): Promise<{ mime: string; bytes: Uint8Array }> {
  const token = Deno.env.get('WA_TOKEN');
  if (!token) throw new Error('WA_TOKEN ausente');
  const info = await fetch(`${GRAPH()}/${id}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }).then(r => r.json());
  if (!info?.url) throw new Error(`mídia ${id} sem link (${info?.error?.message || 'resposta inválida'})`);
  if (+info.file_size > maxMb * 1024 * 1024) throw new Error('arquivo grande demais');
  const r = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`download ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > maxMb * 1024 * 1024) throw new Error('arquivo grande demais');
  return { mime: String(info.mime_type || r.headers.get('content-type') || '').split(';')[0].trim(), bytes };
}

// Campo a preencher esquecido no texto ([nome], {data}, XX, ___, <valor>, (nome do cliente)): devolve o trecho
// achado, ou null. Nada com isso é enviado ao cliente — nem pelo robô, nem pelo botão Enviar do Hub.
export function campoAPreencher(texto: string): string | null {
  const m = String(texto || '').match(/\[[^\]\n]{1,60}\]|\{\{?[^}\n]{0,60}\}?\}|\bX{2,}\b|_{3,}|<[^>\n]{1,40}>|\(\s*(?:nome|data|valor|n[uú]mero)\b[^)\n]{0,40}\)/i);
  return m ? m[0] : null;
}

export type Base = {
  geral?: Record<string, string>;
  casas?: Record<string, Record<string, string>>;
};
const CAMPOS_GERAL: [string, string][] = [
  ['endereco', 'Endereço'], ['checkin', 'Horário de check-in'], ['checkout', 'Horário de check-out'],
  ['pets', 'Pets'], ['regras', 'Regras da casa'], ['pagamento', 'Como funciona o pagamento'], ['outros', 'Outras informações'],
];
const CAMPOS_CASA: [string, string][] = [
  ['localizacao', 'Link da localização'], ['capacidade', 'Capacidade'], ['quartos', 'Quartos e camas'], ['comodidades', 'Comodidades'], ['wifi_rede', 'Wi-Fi (rede)'],
  ['wifi_senha', 'Wi-Fi (senha)'], ['observacoes', 'Observações'],
];

export async function lerBase(sb: any): Promise<Base> {
  const { data } = await sb.from('app_config').select('value').eq('key', 'wa_base').maybeSingle();
  try { return JSON.parse(data?.value || '{}') || {}; } catch { return {}; }
}

// Texto da base para o prompt. paraRobo: sem senha do Wi-Fi, sem link da localização exata e sem dados de Pix
// (o robô nunca envia isso; vão só no rascunho da IA, que o Claudio revisa).
export function baseTexto(base: Base, casas: { id: string; nome: string }[], { paraRobo = false } = {}) {
  const linhas: string[] = [];
  const g = base.geral || {};
  for (const [k, rot] of CAMPOS_GERAL) if (g[k]?.trim()) linhas.push(`${rot}: ${g[k].trim()}`);
  if (!paraRobo && g.pix_chave?.trim()) linhas.push(`Chave Pix: ${g.pix_chave.trim()}${g.pix_nome ? ` (${g.pix_nome.trim()})` : ''}`);
  if (!paraRobo && g.sinal_pct) linhas.push(`Sinal para reservar: ${g.sinal_pct}% do total`);
  for (const c of casas) {
    const x = base.casas?.[c.id] || {};
    const cs = CAMPOS_CASA.filter(([k]) => x[k]?.trim() && !(paraRobo && (k === 'wifi_senha' || k === 'localizacao'))).map(([k, rot]) => `  ${rot}: ${x[k].trim()}`);
    if (cs.length) linhas.push(`${c.nome} (${c.id}):`, ...cs);
  }
  return linhas.join('\n');
}

// Push para os aparelhos com notificação ativa (mesmas chaves e inscrições da daily-digest e da wa-vigia)
export async function avisarPush(sb: any, aviso: { title: string; body: string; tag: string; url: string }) {
  const { data } = await sb.from('app_secrets').select('key,value').in('key', ['vapid_public', 'vapid_private']);
  const k = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]));
  if (!k.vapid_public || !k.vapid_private) { console.error('push: chaves ausentes (ative as notificações em Ajustes)'); return 0; }
  webpush.setVapidDetails('mailto:hub@clau219.github.io', k.vapid_public, k.vapid_private);
  const { data: subs } = await sb.from('push_subscriptions').select('*');
  let enviados = 0;
  for (const s of subs || []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(aviso)); enviados++; }
    catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from('push_subscriptions').delete().eq('id', s.id);
      else console.error('push', code, (e as Error).message);
    }
  }
  await sb.from('notifications_log').insert({ tipo: aviso.tag, titulo: aviso.title, corpo: aviso.body });
  return enviados;
}
