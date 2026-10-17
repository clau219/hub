// Lê os links iCal cadastrados (Google Agenda e Airbnb) e grava na agenda/reservas.
// Agendada a cada hora (cron.sql) e também chamada pelo botão "Ler agora" em Ajustes.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { RRule } from 'npm:rrule@2.8.1';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if (!(await autorizado(req, sb))) return json({ error: 'não autorizado' }, 401);
  const { data: fontes, error } = await sb.from('calendar_sources').select('*');
  if (error) return json({ error: error.message }, 500);

  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const limiteIni = new Date(Date.now() - 60 * 864e5).toISOString();
  let eventos = 0, reservas = 0;
  const erros: string[] = [];

  for (const f of fontes || []) {
    try {
      const texto = await baixar(f.url);
      // Página de erro ou de login com HTTP 200 não é calendário: sem esta checagem, viraria "0 eventos" e cancelaria tudo
      if (!/BEGIN:VCALENDAR/.test(texto)) throw new Error('a resposta não é um calendário iCal');
      const todos = parseIcs(texto);
      // Calendário sem nenhum evento (nem passados nem bloqueios) é suspeito: não cancela nem apaga nada desta vez
      const vazio = todos.length === 0;
      const evs = todos.filter(e => e.status !== 'CANCELLED');
      const vistos: string[] = [];

      const ehAirbnb = f.tipo === 'airbnb' || /airbnb\./i.test(f.url);
      if (ehAirbnb || (f.calendario === 'alugueis' && f.property_id)) {
        // Cada VEVENT é uma reserva ou um bloqueio
        const rows = evs.filter(e => e.allDay && e.end && e.end >= hoje).map(e => {
          const bloqueio = /not available|indispon|blocked|bloque/i.test(e.summary);
          const uid = `${f.id}:${e.uid}`; vistos.push(uid);
          const tel = e.description?.match(/Phone Number \(Last 4 Digits\):\s*(\d{4})/i)?.[1];
          const url = e.description?.match(/https:\/\/www\.airbnb\.[^\s]+/)?.[0];
          return {
            property_id: f.property_id, checkin: e.start, checkout: e.end!, uid_externo: uid,
            origem: ehAirbnb ? 'airbnb' : 'outro', status: bloqueio ? 'bloqueio' : 'confirmada',
            hospede: bloqueio ? null : (ehAirbnb ? 'Hóspede Airbnb' : e.summary || null),
            notas: [tel ? `Tel. final ${tel}` : null, url].filter(Boolean).join('\n') || null,
          };
        });
        // upsert sem sobrescrever nome/valor que você digitou depois
        for (const row of rows) {
          const { data: ex } = await sb.from('bookings').select('id,hospede,valor,notas').eq('uid_externo', row.uid_externo).maybeSingle();
          if (ex) await sb.from('bookings').update({ checkin: row.checkin, checkout: row.checkout, status: row.status, origem: row.origem }).eq('id', ex.id);
          else await sb.from('bookings').insert(row);
        }
        reservas += rows.length;
        // reservas futuras que sumiram do feed = canceladas
        const { data: antigas } = await sb.from('bookings').select('id,uid_externo').like('uid_externo', `${f.id}:%`).gte('checkout', hoje);
        const sumiram = (antigas || []).filter(a => !vistos.includes(a.uid_externo)).map(a => a.id);
        if (sumiram.length && vazio) throw new Error(`calendário veio vazio; ${sumiram.length} reserva(s) futura(s) mantida(s) sem cancelar`);
        if (sumiram.length) await sb.from('bookings').update({ status: 'cancelada' }).in('id', sumiram);
      } else {
        // Google Agenda → eventos do calendário escolhido. Séries repetidas viram uma linha por ocorrência na janela
        // (60 dias para trás, 180 para frente), com o mesmo id que o Google dá à ocorrência ("serie#20261020T110000Z").
        // Eventos que o próprio Hub escreveu no Google (gcal-sync) não voltam como cópia.
        const ate = new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10);
        const rows = expandir(todos, limiteIni.slice(0, 10), ate).filter(e => (e.end || e.start) >= limiteIni.slice(0, 10) && !HUB_UID.test(e.uid)).map(e => {
          const uid = `${f.id}:${e.uid}${e.chave ? '#' + e.chave : ''}`; vistos.push(uid);
          return {
            calendario: f.calendario, titulo: e.summary || '(sem título)', local: e.location || null, origem: 'google', uid_externo: uid,
            dia_inteiro: e.allDay, inicio: e.allDay ? `${e.start}T12:00:00Z` : e.start, fim: e.allDay ? null : (e.end || null),
          };
        });
        for (let i = 0; i < rows.length; i += 200) {
          const { error: er } = await sb.from('events').upsert(rows.slice(i, i + 200), { onConflict: 'uid_externo' });
          if (er) throw er;
        }
        eventos += rows.length;
        // Até 16/10 a série era uma linha só (sem "#data"): apaga essas, agora substituídas pelas ocorrências
        const series = [...new Set(todos.filter(e => e.rrule).map(e => `${f.id}:${e.uid}`))];
        for (let i = 0; i < series.length; i += 100) await sb.from('events').delete().in('uid_externo', series.slice(i, i + 100));
        const { data: antigos } = await sb.from('events').select('id,uid_externo').like('uid_externo', `${f.id}:%`).gte('inicio', new Date().toISOString());
        const sumiram = (antigos || []).filter(a => !vistos.includes(a.uid_externo)).map(a => a.id);
        if (sumiram.length && vazio) throw new Error(`calendário veio vazio; ${sumiram.length} evento(s) futuro(s) mantido(s)`);
        if (sumiram.length) await sb.from('events').delete().in('id', sumiram);
      }
      await sb.from('calendar_sources').update({ ultimo_sync: new Date().toISOString() }).eq('id', f.id);
    } catch (e) {
      erros.push(`${f.nome || f.url}: ${(e as Error).message}`);
    }
  }
  // Resultado da leitura fica guardado para aparecer em Ajustes (a leitura de hora em hora não tem quem veja o erro)
  await sb.from('app_config').upsert({ key: 'ical_status', value: JSON.stringify({ em: new Date().toISOString(), eventos, reservas, erros }) }, { onConflict: 'key' });
  // em seguida, manda as gigs e eventos do Hub para o Google Agenda
  let google: unknown = null;
  try {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    for (const k of ['authorization', 'x-hub-cron', 'apikey']) { const v = req.headers.get(k); if (v) h[k] = v; }
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/gcal-sync`, { method: 'POST', headers: h, body: '{}' });
    google = await r.json();
  } catch (e) { google = { erro: (e as Error).message }; }
  return json({ eventos, reservas, erros, google });
});

// ---------- séries repetidas ----------
// Chave da ocorrência no formato do Google: 20261020T110000Z (com horário, em UTC) ou 20261020 (dia inteiro).
// O id da ocorrência no Google é "<id da série>_<chave>", e é assim que o gcal-sync altera só ela.
const chave = (iso: string) => iso.length === 10 ? iso.replace(/-/g, '') : new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const BR = 3 * 3600e3; // o Brasil não tem horário de verão desde 2019: a regra roda no relógio local (UTC-3)

// Devolve os eventos simples e uma cópia de cada série por ocorrência entre "de" e "ate".
// EXDATE e ocorrências canceladas somem; exceções (ocorrência movida ou editada no Google) substituem a original.
type Ocorrencia = IcsEvent & { chave?: string };
function expandir(todos: IcsEvent[], de: string, ate: string): Ocorrencia[] {
  const out: Ocorrencia[] = [];
  const excecoes = new Map<string, IcsEvent>();
  for (const e of todos) if (e.recurrenceId) excecoes.set(`${e.uid}#${chave(e.recurrenceId)}`, e);
  const usadas = new Set<string>();
  for (const e of todos) {
    if (e.recurrenceId) continue;
    if (!e.rrule) { if (e.status !== 'CANCELLED') out.push(e); continue; }
    if (e.status === 'CANCELLED') continue;
    const dur = e.end ? Date.parse(e.end.length === 10 ? e.end + 'T00:00:00Z' : e.end) - Date.parse(e.start.length === 10 ? e.start + 'T00:00:00Z' : e.start) : 0;
    // A regra é calculada no "relógio de parede" (dia da semana local), não em UTC: 22h de terça é 01h de quarta em UTC
    const inicioLocal = e.allDay ? new Date(e.start + 'T00:00:00Z') : new Date(Date.parse(e.start) - BR);
    let regra: RRule;
    try { regra = new RRule({ ...RRule.parseString(e.rrule), dtstart: inicioLocal }); }
    catch { out.push(e); continue; } // regra que não entendemos: fica só a 1ª data, como antes
    const fora = new Set((e.exdates || []).map(chave));
    const datas = regra.between(new Date(de + 'T00:00:00Z'), new Date(ate + 'T23:59:59Z'), true).slice(0, 400);
    for (const d of datas) {
      const iso = e.allDay ? d.toISOString().slice(0, 10) : new Date(d.getTime() + BR).toISOString();
      const k = chave(iso);
      if (fora.has(k)) continue;
      const ex = excecoes.get(`${e.uid}#${k}`);
      if (ex) { usadas.add(`${e.uid}#${k}`); if (ex.status !== 'CANCELLED') out.push({ ...ex, chave: k }); continue; }
      const fim = dur ? (e.allDay ? new Date(Date.parse(iso + 'T00:00:00Z') + dur).toISOString().slice(0, 10) : new Date(Date.parse(iso) + dur).toISOString()) : undefined;
      out.push({ ...e, start: iso, end: fim, chave: k });
    }
  }
  // Exceção cuja data original ficou fora da janela, mas que foi movida para dentro dela
  for (const [k, ex] of excecoes) {
    if (usadas.has(k) || ex.status === 'CANCELLED') continue;
    const dia = ex.start.slice(0, 10);
    if (dia >= de && dia <= ate) out.push({ ...ex, chave: k.split('#').pop() });
  }
  return out;
}

const HUB_UID = /^hub[de][0-9a-f]{32}@google\.com$/;

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Baixa o iCal com cabeçalhos de navegador e novas tentativas (o Google às vezes responde 429)
async function baixar(url: string) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', 'Accept': 'text/calendar,*/*' };
  let ultimo = 0;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers });
    if (r.ok) return await r.text();
    ultimo = r.status;
    if (r.status !== 429 && r.status < 500) break;
    await new Promise(res => setTimeout(res, 1500 * (i + 1)));
  }
  throw new Error(`HTTP ${ultimo}`);
}

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

// ---------- leitor de iCal ----------
// Leitor mínimo de iCal (VEVENT) — suficiente para Google Agenda e Airbnb.
type IcsEvent = {
  uid: string; summary: string; description?: string; location?: string;
  start: string; end?: string; allDay: boolean; status?: string; rrule?: string; recurrenceId?: string; exdates?: string[];
};

function parseIcs(text: string): IcsEvent[] {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const out: IcsEvent[] = [];
  let cur: Record<string, { params: string; value: string }> | null = null;
  let exdates: { params: string; value: string }[] = [];
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; exdates = []; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.DTSTART) {
        const s = toIso(cur.DTSTART), e = cur.DTEND ? toIso(cur.DTEND) : null;
        out.push({
          uid: cur.UID?.value || crypto.randomUUID(), summary: unesc(cur.SUMMARY?.value || ''),
          description: cur.DESCRIPTION ? unesc(cur.DESCRIPTION.value) : undefined,
          location: cur.LOCATION ? unesc(cur.LOCATION.value) : undefined,
          start: s.iso, end: e?.iso, allDay: s.allDay, status: cur.STATUS?.value, rrule: cur.RRULE?.value,
          recurrenceId: cur['RECURRENCE-ID'] ? toIso(cur['RECURRENCE-ID']).iso : undefined,
          exdates: exdates.flatMap(x => x.value.split(',').map(v => toIso({ params: x.params, value: v }).iso)),
        });
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
    if (m?.[1] === 'EXDATE') exdates.push({ params: m[2], value: m[3] }); // pode vir em várias linhas
    else if (m && !cur[m[1]]) cur[m[1]] = { params: m[2], value: m[3] };
  }
  return out;
}

function unesc(s: string) { return s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1'); }

// Converte DTSTART/DTEND em ISO. Datas sem fuso explícito são tratadas como horário de Pipa (UTC-3).
function toIso(p: { params: string; value: string }): { iso: string; allDay: boolean } {
  const v = p.value.trim();
  if (/VALUE=DATE(?!-)/.test(p.params) || /^\d{8}$/.test(v)) {
    return { iso: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return { iso: v, allDay: false };
  const [, y, mo, d, hh, mi, ss, z] = m;
  const off = z ? 'Z' : tzOffset(p.params);
  return { iso: new Date(`${y}-${mo}-${d}T${hh}:${mi}:${ss}${off}`).toISOString(), allDay: false };
}

function tzOffset(params: string) {
  const tz = params.match(/TZID=([^;:]+)/)?.[1];
  if (!tz || /Sao_Paulo|Fortaleza|Recife|Bahia|Belem|Maceio|Araguaina/.test(tz)) return '-03:00';
  if (/Manaus|Cuiaba|Campo_Grande|Porto_Velho|Boa_Vista/.test(tz)) return '-04:00';
  if (/UTC|GMT/.test(tz)) return 'Z';
  return '-03:00';
}
