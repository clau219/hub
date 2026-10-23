// Vigia do WhatsApp das casas, chamada a cada 5 min pelo pg_cron (supabase/2026-10-23_wa_vigia.sql):
// - confere se a instância da Z-API está conectada; avisa por push quando cai (de novo a cada 6 h enquanto
//   continuar fora) e quando volta. Status em app_config 'zapi_status' (a aba WhatsApp mostra);
// - avisa por push quem mandou mensagem e está há 20+ min sem resposta (um aviso por mensagem; entre 23h e 7h
//   fica quieta e avisa às 7h quem ainda estiver esperando). Já avisados em app_config 'wa_avisados'.
// Auth: x-hub-cron (agendador) ou JWT do usuário. POST {"teste": true} só calcula, sem enviar push.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const ESPERA_MIN = 20;
const REPETE_QUEDA_H = 6;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
type SB = ReturnType<typeof createClient>;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if (!(await autorizado(req, sb))) return json({ error: 'não autorizado' }, 401);
  const { teste = false } = await req.json().catch(() => ({}));

  const avisos: { title: string; body: string; tag: string; url: string }[] = [];
  const conexao = await vigiarConexao(sb, avisos);
  const esperando = await vigiarEsperando(sb, avisos);

  let enviados = 0;
  if (avisos.length && !teste) enviados = await enviarPush(sb, avisos);
  return json({ conexao, esperando, avisos, enviados, teste });
});

// ---------- Z-API conectada? ----------
async function vigiarConexao(sb: SB, avisos: any[]) {
  const inst = Deno.env.get('ZAPI_INSTANCE');
  if (!inst) return { ignorado: 'Z-API não configurada' };
  let st: { ok: boolean; motivo: string; celular?: boolean };
  try {
    const r = await fetch(`https://api.z-api.io/instances/${inst}/token/${Deno.env.get('ZAPI_TOKEN')}/status`, {
      headers: { 'Client-Token': Deno.env.get('ZAPI_CLIENT_TOKEN') || '' }, signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    st = r.ok && j.connected ? { ok: true, motivo: '', celular: j.smartphoneConnected !== false }
      : { ok: false, motivo: traduzir(j.error || j.message || `HTTP ${r.status}`) };
  } catch (e) {
    // Falha de rede do nosso lado não é queda do WhatsApp: não muda o estado nem avisa
    return { ignorado: 'Z-API não respondeu: ' + (e as Error).message };
  }

  const antes = await lerConfig(sb, 'zapi_status');
  const agora = new Date().toISOString();
  const novo: Record<string, unknown> = { ok: st.ok, motivo: st.motivo, celular: st.celular ?? null, em: agora, desde: antes?.ok === st.ok ? antes.desde || agora : agora, avisado_em: antes?.avisado_em || null };
  if (!st.ok && (antes?.ok !== false || !antes.avisado_em || Date.now() - Date.parse(antes.avisado_em) > REPETE_QUEDA_H * 3600e3)) {
    avisos.push({ title: 'WhatsApp das casas desconectado', body: `${st.motivo}. As mensagens não estão chegando ao Hub e o robô está parado. Abra a Z-API e leia o QR code de novo, se for o caso.`, tag: 'zapi-status', url: './#/whatsapp' });
    novo.avisado_em = agora;
  } else if (st.ok && antes?.ok === false && antes.avisado_em) {
    avisos.push({ title: 'WhatsApp das casas reconectado', body: 'As mensagens voltaram a chegar ao Hub.', tag: 'zapi-status', url: './#/whatsapp' });
    novo.avisado_em = null;
  }
  await gravarConfig(sb, 'zapi_status', novo);
  return novo;
}

function traduzir(e: string) {
  if (/not connected|disconnected/i.test(e)) return 'O celular das casas não está conectado à Z-API';
  if (/restore the session/i.test(e)) return 'A sessão do WhatsApp caiu e precisa ser restaurada';
  if (/client-token/i.test(e)) return 'Token de segurança da Z-API inválido';
  if (/instance not found|token/i.test(e)) return 'Instância da Z-API não encontrada (plano vencido ou token trocado?)';
  return `Z-API respondeu: ${e}`;
}

// ---------- quem está esperando resposta ----------
async function vigiarEsperando(sb: SB, avisos: any[]) {
  const { data: msgs } = await sb.from('wa_messages').select('id,wa_id,autor,texto,tipo,enviado_em')
    .gte('enviado_em', new Date(Date.now() - 3 * 864e5).toISOString()).order('enviado_em', { ascending: false }).limit(1000);
  const ultima = new Map<string, any>();
  for (const m of msgs || []) if (!ultima.has(m.wa_id)) ultima.set(m.wa_id, m);
  const limite = Date.now() - ESPERA_MIN * 60e3;
  const esperando = [...ultima.values()].filter(m => m.autor === 'cliente' && Date.parse(m.enviado_em) <= limite);

  const avisados: Record<string, string> = (await lerConfig(sb, 'wa_avisados')) || {};
  const novos = esperando.filter(m => avisados[m.wa_id] !== m.id);
  const hora = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23' }).format(new Date());
  const madrugada = hora >= 23 || hora < 7;
  const res = { esperando: esperando.length, novos: novos.length, madrugada };
  if (!novos.length || madrugada) return res;

  const { data: cs } = await sb.from('wa_contacts').select('wa_id,nome').in('wa_id', novos.map(m => m.wa_id));
  const nome = (wa: string) => cs?.find((c: any) => c.wa_id === wa)?.nome || telefone(wa);
  const min = (m: any) => Math.round((Date.now() - Date.parse(m.enviado_em)) / 60e3);
  const espera = (m: any) => min(m) >= 120 ? `${Math.round(min(m) / 60)} h` : `${min(m)} min`;
  const trecho = (m: any) => (m.texto || `[${m.tipo}]`).replace(/\s+/g, ' ').slice(0, 80);
  if (novos.length === 1) {
    const m = novos[0];
    avisos.push({ title: `${nome(m.wa_id)} espera resposta há ${espera(m)}`, body: `“${trecho(m)}”`, tag: 'wa-esperando', url: `./#/whatsapp?c=${encodeURIComponent(m.wa_id)}` });
  } else {
    avisos.push({ title: `${novos.length} pessoas esperando resposta no WhatsApp`, body: novos.slice(0, 4).map(m => `${nome(m.wa_id)} (${espera(m)}): “${trecho(m)}”`).join('\n'), tag: 'wa-esperando', url: './#/whatsapp' });
  }
  // Guarda só quem ainda espera (quem foi respondido sai da lista)
  await gravarConfig(sb, 'wa_avisados', Object.fromEntries(esperando.map(m => [m.wa_id, m.id])));
  return res;
}

// ---------- push (mesmas chaves e inscrições da daily-digest) ----------
async function enviarPush(sb: SB, avisos: any[]) {
  const { data } = await sb.from('app_secrets').select('key,value').in('key', ['vapid_public', 'vapid_private']);
  const k = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]));
  if (!k.vapid_public || !k.vapid_private) { console.error('wa-vigia: chaves de push ausentes (ative as notificações em Ajustes)'); return 0; }
  webpush.setVapidDetails('mailto:hub@clau219.github.io', k.vapid_public, k.vapid_private);
  const { data: subs } = await sb.from('push_subscriptions').select('*');
  let enviados = 0;
  for (const a of avisos) {
    for (const s of subs || []) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(a)); enviados++; }
      catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sb.from('push_subscriptions').delete().eq('id', s.id);
        else console.error('push', code, (e as Error).message);
      }
    }
    await sb.from('notifications_log').insert({ tipo: a.tag, titulo: a.title, corpo: a.body });
  }
  return enviados;
}

async function lerConfig(sb: SB, key: string) {
  const { data } = await sb.from('app_config').select('value').eq('key', key).maybeSingle();
  try { return data?.value ? JSON.parse(data.value) : null; } catch { return null; }
}
const gravarConfig = (sb: SB, key: string, v: unknown) => sb.from('app_config').upsert({ key, value: JSON.stringify(v) }, { onConflict: 'key' });

async function autorizado(req: Request, sb: SB) {
  const cron = req.headers.get('x-hub-cron');
  if (cron) {
    const { data } = await sb.from('app_secrets').select('value').eq('key', 'cron_token').single();
    return !!data && data.value === cron;
  }
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt.startsWith('sb_')) return false;
  const { data } = await sb.auth.getUser(jwt);
  return !!data?.user;
}

function telefone(wa: string) {
  const m = wa.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : wa.includes('@') ? 'Contato do WhatsApp' : '+' + wa;
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
