// Hub → Google Agenda (calendário de DJ), escrevendo direto pela API com uma conta de serviço.
//   - Gigs do Pipeline (fechado, realizado, pago) e eventos manuais da agenda DJ viram eventos com id fixo
//     "hubd<uuid>" / "hube<uuid>": o Hub manda neles (cria, altera e apaga). O ical-sync ignora esses ids.
//   - {evento: <id>} altera no Google um evento que veio de lá e foi editado no Hub.
// Chamada pelo Hub ao salvar, pelo ical-sync a cada hora e pelo botão em Ajustes.
// Segredo: GCAL_SA_JSON (chave JSON da conta de serviço). Opcional: GCAL_DJ_ID (senão sai do link iCal "dj").
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hub-cron' };
const API = 'https://www.googleapis.com/calendar/v3';
const TZ = 'America/Sao_Paulo';
const HUB_ID = /^hub[de][0-9a-f]{32}$/;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if (!(await autorizado(req, sb))) return json({ error: 'não autorizado' }, 401);
  const body = await req.json().catch(() => ({}));
  let res: Record<string, unknown>;
  try {
    const tk = await token();
    const cal = await calendarioDj(sb);
    res = body.evento ? await alterarDoGoogle(sb, tk, cal, body.evento) : await reconciliar(sb, tk, cal);
  } catch (e) {
    res = { erro: (e as Error).message };
  }
  if (!body.evento || res.erro) {
    await sb.from('app_config').upsert({ key: 'gcal_status', value: JSON.stringify({ em: new Date().toISOString(), ...res }) }, { onConflict: 'key' });
  }
  return json(res); // erro vai no corpo (com 500 o Hub não consegue ler a mensagem)
});

// ---------- Hub → Google ----------
async function reconciliar(sb: any, tk: string, cal: string) {
  const desde = addDays(hojeSp(), -1);
  const [{ data: deals, error: e1 }, { data: evs, error: e2 }] = await Promise.all([
    sb.from('deals').select('*, contacts(nome)').eq('negocio', 'dj').in('etapa', ['fechado', 'realizado', 'pago']).gte('data_evento', desde),
    sb.from('events').select('*').eq('calendario', 'dj').eq('origem', 'manual').gte('inicio', `${desde}T00:00:00-03:00`),
  ]);
  if (e1 || e2) throw new Error((e1 || e2).message);

  const desejados = new Map<string, any>();
  for (const d of deals || []) desejados.set('hubd' + d.id.replace(/-/g, ''), deDeal(d));
  for (const e of evs || []) desejados.set('hube' + e.id.replace(/-/g, ''), deEvento(e));

  const existentes = new Map<string, any>();
  let page = '';
  do {
    const q = new URLSearchParams({ privateExtendedProperty: 'hub=1', timeMin: `${desde}T00:00:00-03:00`, maxResults: '2500' });
    if (page) q.set('pageToken', page);
    const r = await g(tk, 'GET', `/calendars/${encodeURIComponent(cal)}/events?${q}`);
    for (const it of r.items || []) existentes.set(it.id, it);
    page = r.nextPageToken || '';
  } while (page);

  let criados = 0, alterados = 0, apagados = 0;
  for (const [id, ev] of desejados) {
    const h = await hash(ev);
    const corpo = { ...ev, id, status: 'confirmed', extendedProperties: { private: { hub: '1', h } } };
    const ex = existentes.get(id);
    if (ex?.extendedProperties?.private?.h === h) continue;
    if (ex) { await g(tk, 'PUT', `/calendars/${encodeURIComponent(cal)}/events/${id}`, corpo); alterados++; continue; }
    try {
      await g(tk, 'POST', `/calendars/${encodeURIComponent(cal)}/events`, corpo); criados++;
    } catch (e) {
      // 409: o id já existe (apagado no Google ou fora da janela) → reescreve e reativa
      if (!/^409/.test((e as Error).message)) throw e;
      await g(tk, 'PUT', `/calendars/${encodeURIComponent(cal)}/events/${id}`, corpo); alterados++;
    }
  }
  for (const id of existentes.keys()) {
    if (desejados.has(id) || !HUB_ID.test(id)) continue;
    await g(tk, 'DELETE', `/calendars/${encodeURIComponent(cal)}/events/${id}`); apagados++;
  }
  return { ok: true, total: desejados.size, criados, alterados, apagados };
}

function deDeal(d: any) {
  const nota = [d.notas, 'Gig do Hub: altere pelo Hub (mudanças feitas aqui são desfeitas).'].filter(Boolean).join('\n\n');
  const base = { summary: `DJ CLAU: ${d.contacts?.nome || d.titulo}`, location: d.local || undefined, description: nota };
  if (!d.hora_inicio) return { ...base, start: { date: d.data_evento }, end: { date: addDays(d.data_evento, 1) } };
  const ini = new Date(`${d.data_evento}T${d.hora_inicio.slice(0, 5)}:00-03:00`);
  let fim = d.hora_fim ? new Date(`${d.data_evento}T${d.hora_fim.slice(0, 5)}:00-03:00`) : new Date(ini.getTime() + 4 * 3600e3);
  if (fim <= ini) fim = new Date(fim.getTime() + 864e5); // termina depois da meia-noite
  return { ...base, start: { dateTime: ini.toISOString(), timeZone: TZ }, end: { dateTime: fim.toISOString(), timeZone: TZ } };
}

function deEvento(e: any) {
  const base = { summary: e.titulo, location: e.local || undefined, description: 'Evento do Hub: altere pelo Hub (mudanças feitas aqui são desfeitas).' };
  if (e.dia_inteiro) { const dia = e.inicio.slice(0, 10); return { ...base, start: { date: dia }, end: { date: addDays(dia, 1) } }; }
  const ini = new Date(e.inicio);
  const fim = e.fim && new Date(e.fim) > ini ? new Date(e.fim) : new Date(ini.getTime() + 3600e3);
  return { ...base, start: { dateTime: ini.toISOString(), timeZone: TZ }, end: { dateTime: fim.toISOString(), timeZone: TZ } };
}

// Evento que veio do Google e foi editado no Hub: altera o original
async function alterarDoGoogle(sb: any, tk: string, cal: string, id: string) {
  const { data: e } = await sb.from('events').select('*').eq('id', id).maybeSingle();
  if (!e) return { erro: 'evento não encontrado' };
  if (e.origem !== 'google') return await reconciliar(sb, tk, cal);
  const gid = String(e.uid_externo || '').split(':').slice(1).join(':').replace(/@google\.com$/, '');
  if (!gid) return { erro: 'evento sem identificador do Google' };
  const atual = await g(tk, 'GET', `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(gid)}`);
  if (atual.recurrence || atual.recurringEventId) return { erro: 'evento que se repete: altere no Google Agenda' };
  const { summary, location, start, end } = deEvento(e);
  await g(tk, 'PATCH', `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(gid)}`, { summary, location: location || '', start, end });
  return { ok: true, alterados: 1 };
}

// ---------- Google ----------
async function g(tk: string, method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (method === 'DELETE' && (r.status === 410 || r.status === 404)) return {};
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${method} ${path.split('?')[0]}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

async function calendarioDj(sb: any) {
  const env = Deno.env.get('GCAL_DJ_ID');
  if (env) return env;
  const { data } = await sb.from('calendar_sources').select('url').eq('calendario', 'dj');
  for (const f of data || []) {
    const m = String(f.url).match(/calendar\.google\.com\/calendar\/ical\/([^/]+)\//);
    if (m) return decodeURIComponent(m[1]);
  }
  throw new Error('nenhum link iCal do Google cadastrado para a agenda DJ');
}

// Token de acesso da conta de serviço (JWT assinado com a chave privada)
async function token() {
  const raw = Deno.env.get('GCAL_SA_JSON');
  if (!raw) throw new Error('falta a chave do Google (segredo GCAL_SA_JSON)');
  const sa = JSON.parse(raw);
  const agora = Math.floor(Date.now() / 1000);
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const txt = (o: unknown) => b64(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${txt({ alg: 'RS256', typ: 'JWT' })}.${txt({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar.events', aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 })}`;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64(sig)}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login no Google falhou: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token as string;
}

// ---------- utilidades ----------
async function hash(o: unknown) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(o))));
  return [...d.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const hojeSp = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
function addDays(dia: string, n: number) { return new Date(new Date(dia + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10); }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Quem pode chamar: o agendamento (x-hub-cron) ou você logado no Hub
async function autorizado(req: Request, sb: any) {
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
