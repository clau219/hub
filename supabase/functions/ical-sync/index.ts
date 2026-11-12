// Lê os links iCal cadastrados (Google Agenda e Airbnb) e grava na agenda/reservas.
// Agendada a cada hora (cron.sql) e também chamada pelo botão "Ler agora" em Ajustes.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { RRule } from 'https://esm.sh/rrule@2.8.1';
import { avisarPush } from '../_shared/wa.ts';

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
  const erros: string[] = [], avisos: string[] = [];
  // Casa com link da Stays: a Stays é a fonte (Airbnb, Decolar, Booking e bloqueios). O iCal do Airbnb dessa casa
  // fica cadastrado só para a airbnb-quote achar o número do anúncio, e deixa de ser lido aqui.
  const casasStays = new Set((fontes || []).filter(ehStays).map(f => f.property_id).filter(Boolean));
  const ehAirbnbF = (f: any) => f.tipo === 'airbnb' || /airbnb\./i.test(f.url);

  for (const f of fontes || []) {
    if (ehAirbnbF(f) && casasStays.has(f.property_id)) continue;
    try {
      const texto = await baixar(f.url);
      // Página de erro ou de login com HTTP 200 não é calendário: sem esta checagem, viraria "0 eventos" e cancelaria tudo
      if (!/BEGIN:VCALENDAR/.test(texto)) throw new Error('a resposta não é um calendário iCal');
      const todos = parseIcs(texto);
      // Calendário sem nenhum evento (nem passados nem bloqueios) é suspeito: não cancela nem apaga nada desta vez
      const vazio = todos.length === 0;
      const evs = todos.filter(e => e.status !== 'CANCELLED');
      const vistos: string[] = [];

      const ehAirbnb = ehAirbnbF(f);
      if (ehStays(f) && f.property_id) {
        const r = await sincStays(sb, f, evs, hoje, vazio, (fontes || []).filter(x => ehAirbnbF(x) && x.property_id === f.property_id).map(x => x.id));
        reservas += r.reservas;
        avisos.push(...r.avisos);
      } else if (ehAirbnb || (f.calendario === 'alugueis' && f.property_id)) {
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
  await sb.from('app_config').upsert({ key: 'ical_status', value: JSON.stringify({ em: new Date().toISOString(), eventos, reservas, erros, avisos }) }, { onConflict: 'key' });
  // em seguida, manda as gigs e eventos do Hub para o Google Agenda
  let google: unknown = null;
  try {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    for (const k of ['authorization', 'x-hub-cron', 'apikey']) { const v = req.headers.get(k); if (v) h[k] = v; }
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/gcal-sync`, { method: 'POST', headers: h, body: '{}' });
    google = await r.json();
  } catch (e) { google = { erro: (e as Error).message }; }
  return json({ eventos, reservas, erros, avisos, google });
});

// ---------- Stays ----------
// Link de exportação de cada anúncio: https://<conta>.stays.net/apartment/CO01J/ical
// Cada VEVENT vem com horário (entrada 14h, saída 10h, em UTC) e a descrição traz "ID: RG01J" (código da Stays) e
// "IURL: <link>" quando o bloqueio veio de um iCal importado na Stays. Reserva vem com SUMMARY vazio (sem nome nem canal);
// bloqueio manual vem com a anotação no SUMMARY; "fake_blocked" é tempo de preparação ou o fim da janela de venda.
function ehStays(f: any) { return f.tipo === 'stays' || /\.stays\.net\/apartment\/[^/]+\/ical/i.test(String(f.url || '')); }
const alemDaJanela = (hoje: string) => new Date(Date.parse(hoje + 'T12:00:00Z') + 380 * 864e5).toISOString().slice(0, 10);
const diaLocal = (iso: string) => iso.length === 10 ? iso : new Date(Date.parse(iso) - BR).toISOString().slice(0, 10);

async function sincStays(sb: any, f: any, evs: IcsEvent[], hoje: string, vazio: boolean, fontesAirbnb: string[]) {
  const vistos: string[] = [], avisos: string[] = [];
  const rows = [];
  const codigos: Record<string, string> = {}; // uid → código da Stays (WU01J), para os avisos
  const datasNaStays = new Set<string>(); // "checkin|checkout" de tudo que a Stays tem nesta casa (para a conferência)
  for (const e of evs) {
    const nota = (e.summary || '').trim();
    if (/^fake_blocked$/i.test(nota)) continue;
    if (e.end) datasNaStays.add(`${diaLocal(e.start)}|${diaLocal(e.end)}`);
    // Eco: bloqueio que a Stays criou a partir de um iCal importado (o feed "diretas" do próprio Hub). Já existe no Hub.
    if ((e.description || '').match(/^IURL:[ \t]*(\S+)/m) || /\(Hub\)\s*$/.test(nota)) continue;
    if (!e.end) continue;
    const checkin = diaLocal(e.start), checkout = diaLocal(e.end);
    if (checkout < hoje || checkout <= checkin) continue;
    // Muito além da janela de venda (365 dias): é o sentinela do feed "diretas" voltando da Stays (ical-feed, 400 dias)
    if (checkin >= alemDaJanela(hoje)) continue;
    const codigo = (e.description || '').match(/^ID:[ \t]*(\S+)/m)?.[1];
    const uid = `${f.id}:${e.uid}`; vistos.push(uid);
    if (codigo) codigos[uid] = codigo;
    rows.push({
      property_id: f.property_id, checkin, checkout, uid_externo: uid, origem: 'outro',
      status: nota ? 'bloqueio' : 'confirmada', hospede: nota ? null : 'Hóspede (Stays)',
      notas: [codigo ? `Stays ${codigo}` : null, nota || null].filter(Boolean).join('\n') || null,
    });
  }
  // Ecos: a Stays importa o feed "diretas" do Hub e devolve cada reserva direta como reserva sem nome e sem IURL,
  // igual a uma de verdade. Quando o eco bate com a reserva direta (casa + datas), o código dele fica guardado aqui;
  // assim, se a reserva direta for apagada ou mudar de data, o eco que a Stays ainda não tirou não vira "Hóspede (Stays)".
  const { data: cfgEcos } = await sb.from('app_config').select('value').eq('key', 'stays_ecos').maybeSingle();
  let ecos: Record<string, any> = {};
  try { ecos = JSON.parse(cfgEcos?.value || '{}') || {}; } catch { ecos = {}; }
  let ecosMudou = false;
  let casadas = 0;
  for (const row of rows) {
    const { data: iguais } = await sb.from('bookings').select('id,uid_externo').eq('property_id', row.property_id)
      .eq('checkin', row.checkin).eq('checkout', row.checkout).neq('status', 'cancelada');
    const { data: ex } = await sb.from('bookings').select('id,status').eq('uid_externo', row.uid_externo).maybeSingle();
    // Reserva feita no próprio Hub (direta) que você também bloqueou na Stays: já existe aqui, não duplica
    // (e o espelho dela que veio do Airbnb sai junto com as outras sobras, abaixo)
    const direta = (iguais || []).find((b: any) => !b.uid_externo);
    if (direta || ecos[row.uid_externo]) {
      if (direta && (!ecos[row.uid_externo] || ecos[row.uid_externo].bk !== direta.id || ecos[row.uid_externo].checkin !== row.checkin)) {
        ecos[row.uid_externo] = { casa: row.property_id, checkin: row.checkin, checkout: row.checkout, bk: direta.id, codigo: codigos[row.uid_externo] || null, em: hoje };
        ecosMudou = true;
      }
      if (ex && ex.status !== 'cancelada') await sb.from('bookings').update({ status: 'cancelada' }).eq('id', ex.id);
      continue;
    }
    if (ex) { await sb.from('bookings').update({ checkin: row.checkin, checkout: row.checkout, status: row.status }).eq('id', ex.id); continue; }
    // A mesma estadia que já veio pelo iCal do Airbnb (com nome, valor e etapas digitados no Hub): passa a ser desta fonte
    const doAirbnb = (iguais || []).find((b: any) => fontesAirbnb.some(id => String(b.uid_externo || '').startsWith(`${id}:`)));
    if (doAirbnb) { await sb.from('bookings').update({ uid_externo: row.uid_externo, status: row.status }).eq('id', doAirbnb.id); casadas++; continue; }
    await sb.from('bookings').insert(row);
  }
  // reservas e bloqueios futuros desta fonte que sumiram do feed = cancelados
  const { data: antigas } = await sb.from('bookings').select('id,uid_externo').like('uid_externo', `${f.id}:%`).gte('checkout', hoje);
  const sumiram = (antigas || []).filter((a: any) => !vistos.includes(a.uid_externo)).map((a: any) => a.id);
  if (sumiram.length && vazio) throw new Error(`calendário veio vazio; ${sumiram.length} reserva(s) futura(s) mantida(s) sem cancelar`);
  if (sumiram.length) await sb.from('bookings').update({ status: 'cancelada' }).in('id', sumiram);
  // Eco que a Stays já tirou do feed não precisa mais ser lembrado
  for (const k of Object.keys(ecos)) if (k.startsWith(`${f.id}:`) && !vistos.includes(k)) { delete ecos[k]; ecosMudou = true; }
  if (ecosMudou) await sb.from('app_config').upsert({ key: 'stays_ecos', value: JSON.stringify(ecos) }, { onConflict: 'key' });
  avisos.push(...await conferirStays(sb, f, hoje, datasNaStays, ecos, codigos, vistos));
  // O que ficou do iCal antigo do Airbnb e não apareceu na Stays: bloqueio sai; reserva fica e vira aviso para conferir
  for (const id of fontesAirbnb) {
    const { data: sobras } = await sb.from('bookings').select('id,status,checkin').like('uid_externo', `${id}:%`).gte('checkout', hoje).neq('status', 'cancelada');
    const bloq = (sobras || []).filter((b: any) => b.status === 'bloqueio').map((b: any) => b.id);
    if (bloq.length) await sb.from('bookings').update({ status: 'cancelada' }).in('id', bloq);
    const res = (sobras || []).filter((b: any) => b.status !== 'bloqueio');
    if (res.length) avisos.push(`${f.property_id}: ${res.length} reserva(s) do Airbnb sem par na Stays (entrada ${res.map((b: any) => b.checkin).join(', ')}): confira`);
  }
  if (casadas) avisos.push(`${f.property_id}: ${casadas} reserva(s) do Airbnb passaram a vir da Stays`);
  return { reservas: rows.length, avisos };
}

// ---------- conferência Hub × Stays ----------
// Dois problemas que o iCal não avisa sozinho:
//  falta: reserva direta do Hub que não aparece na Stays → a importação quebrou e os canais NÃO estão bloqueados
//  preso: bloqueio que a Stays criou para uma reserva direta que foi apagada ou mudou de data → a Stays não libera
//         sozinha quando o feed da casa fica sem nenhuma reserva futura (medido em 11/11/2026)
// O problema precisa durar PRAZO_CONFERENCIA (a Stays leva 10–25 min para ler o feed) antes de virar push + tarefa.
// Resolvido, a tarefa é concluída sozinha. Estado em app_config 'stays_conferencia'.
export const PRAZO_CONFERENCIA = 40 * 60e3;
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
async function conferirStays(sb: any, f: any, hoje: string, naStays: Set<string>, ecos: Record<string, any>, codigos: Record<string, string>, vistos: string[]) {
  const casa = f.property_id;
  const { data: prop } = await sb.from('properties').select('nome').eq('id', casa).maybeSingle();
  const nomeCasa = prop?.nome || casa;
  const { data: diretas } = await sb.from('bookings').select('id,checkin,checkout,hospede,status,origem')
    .eq('property_id', casa).is('uid_externo', null).neq('status', 'cancelada').gte('checkin', hoje);
  const ativas = (diretas || []).filter((b: any) => b.origem !== 'airbnb');
  const problemas: Record<string, { titulo: string; corpo: string }> = {};
  for (const b of ativas) {
    if (naStays.has(`${b.checkin}|${b.checkout}`)) continue;
    const quem = b.status === 'bloqueio' ? 'Bloqueio do Hub' : `Reserva direta${b.hospede ? ' de ' + String(b.hospede).trim().split(/\s+/)[0] : ''}`;
    problemas[`falta:${b.id}`] = {
      titulo: `Conferir na Stays: ${quem} (${nomeCasa}, ${ddmm(b.checkin)}–${ddmm(b.checkout)}) não chegou`,
      corpo: `${quem} na ${nomeCasa} (${ddmm(b.checkin)}–${ddmm(b.checkout)}) não aparece na Stays: Airbnb e Decolar podem estar abertos nessas datas. Confira na Stays › anúncio › Distribuição › iCal se "HUB - reservas diretas" está ativo.`,
    };
  }
  for (const [uid, eco] of Object.entries(ecos)) {
    if (!uid.startsWith(`${f.id}:`) || !vistos.includes(uid)) continue;
    if (ativas.some((b: any) => b.id === eco.bk && b.checkin === eco.checkin && b.checkout === eco.checkout)) continue;
    const cod = eco.codigo || codigos[uid] || '';
    problemas[`preso:${uid}`] = {
      titulo: `Apagar na Stays o bloqueio ${cod} (${nomeCasa}, ${ddmm(eco.checkin)}–${ddmm(eco.checkout)})`.replace('  ', ' '),
      corpo: `A reserva direta da ${nomeCasa} de ${ddmm(eco.checkin)}–${ddmm(eco.checkout)} foi cancelada ou mudou, mas a Stays continua bloqueando essas datas${cod ? ` (${cod})` : ''}. Apague na Stays › Calendário para voltar a vender.`,
    };
  }

  const { data: cfg } = await sb.from('app_config').select('value').eq('key', 'stays_conferencia').maybeSingle();
  let est: Record<string, any> = {};
  try { est = JSON.parse(cfg?.value || '{}') || {}; } catch { est = {}; }
  const agora = Date.now(), avisos: string[] = [];
  let mudou = false;
  for (const [k, p] of Object.entries(problemas)) {
    if (!est[k]) { est[k] = { casa, desde: new Date(agora).toISOString() }; mudou = true; }
    const s = est[k];
    if (!s.tarefa && agora - Date.parse(s.desde) >= PRAZO_CONFERENCIA) {
      const { data: t } = await sb.from('tasks').insert({ titulo: p.titulo, area: 'alugueis', prazo: hoje, prioridade: 1, feito: false, notas: p.corpo }).select('id').single();
      s.tarefa = t?.id || 'sem-id'; mudou = true;
      try { await avisarPush(sb, { title: '⚠️ Stays × Hub', body: p.corpo, tag: `stays-${k}`, url: '#/tarefas' }); }
      catch (e) { console.error('push conferência', (e as Error).message); }
    }
    if (s.tarefa) avisos.push(`${casa}: ${p.titulo}`); // antes do prazo é só o atraso normal da Stays
  }
  // Resolvido (ou a reserva saiu de vez): esquece e conclui a tarefa que tinha sido criada
  for (const k of Object.keys(est)) {
    if (est[k].casa !== casa || problemas[k]) continue;
    if (est[k].tarefa && est[k].tarefa !== 'sem-id') await sb.from('tasks').update({ feito: true }).eq('id', est[k].tarefa);
    delete est[k]; mudou = true;
  }
  if (mudou) await sb.from('app_config').upsert({ key: 'stays_conferencia', value: JSON.stringify(est) }, { onConflict: 'key' });
  return avisos;
}

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
