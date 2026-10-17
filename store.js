// Estado em memória: carrega tudo (volume pessoal é pequeno) e recarrega após mudanças.
import * as db from './db.js';
import { today, addDays, diffDays, localDate, hhmm, ABERTAS } from './util.js';
import { CONFIG } from './config.js';
import { acompanhada, pendentes, prazo } from './hospedagem.js';

export const TABLES = ['contacts', 'deals', 'quotes', 'tasks', 'properties', 'bookings', 'events', 'calendar_sources', 'habits', 'habit_logs',
  'crypto_watch', 'crypto_tx', 'crypto_snap'];
export const S = Object.fromEntries(TABLES.map(t => [t, []]));
const listeners = new Set();
export const onChange = fn => listeners.add(fn);

const DEFAULT_PROPS = [
  { id: 'QS39', nome: 'Casa Frida', cor: '#c2410c' },
  { id: 'QS40', nome: 'Casa Azul', cor: '#1d4ed8' },
  { id: 'QS50', nome: 'Casa Terracota', cor: '#a16207' },
];

// Situação da última carga: quando foi, o que falhou e se estamos usando a cópia guardada
export const meta = { at: null, erro: null, offline: false, falhas: [] };
const SNAP = 'hub:snap';
let primeira = true;

export async function load() {
  const res = await Promise.allSettled(TABLES.map(t => db.all(t)));
  const falhas = TABLES.filter((t, i) => res[i].status === 'rejected');
  falhas.forEach(t => console.warn(t, res[TABLES.indexOf(t)].reason));
  if (falhas.length === TABLES.length) {
    // Nada veio (sem rede ou servidor fora): na primeira carga, usa o último estado bom; depois, mantém o que já está na tela
    if (primeira) {
      try {
        const snap = JSON.parse(localStorage.getItem(SNAP) || 'null');
        if (snap) { TABLES.forEach(t => (S[t] = snap.S[t] || [])); meta.at = snap.at; }
      } catch {}
    }
    meta.offline = true;
    meta.erro = res[0].reason?.message || 'Sem conexão';
  } else {
    // Tabela que falhou mantém o valor anterior em vez de virar lista vazia
    TABLES.forEach((t, i) => { if (res[i].status === 'fulfilled') S[t] = res[i].value; });
    meta.offline = false;
    meta.erro = falhas.length ? `Não carregou: ${falhas.join(', ')}` : null;
    meta.at = new Date().toISOString();
    if (!falhas.length && db.mode === 'supabase') {
      try { localStorage.setItem(SNAP, JSON.stringify({ at: meta.at, S: Object.fromEntries(TABLES.filter(t => t !== 'crypto_snap').map(t => [t, S[t]])) })); } catch {}
    }
  }
  meta.falhas = falhas;
  primeira = false;
  if (!S.properties.length && db.mode === 'local') {
    for (const p of DEFAULT_PROPS) await db.insert('properties', p);
    S.properties = await db.all('properties');
  }
  listeners.forEach(fn => fn());
}

export async function save(table, row, id) {
  const r = id ? await db.update(table, id, row) : await db.insert(table, row);
  await load();
  gcal(table, row, id || r?.id);
  return r;
}
export async function del(table, id) { await db.remove(table, id); await load(); gcal(table); }

// Gigs e eventos de DJ vão para o Google Agenda (função gcal-sync). Várias mudanças seguidas viram uma chamada só.
let gcalT = null;
function gcal(table, row = {}, id) {
  if (db.mode !== 'supabase' || !['deals', 'events'].includes(table)) return;
  const chamar = body => db.client().functions.invoke('gcal-sync', { body }).then(({ data, error }) => {
    const erro = data?.erro || error?.message;
    if (erro && !/GCAL_SA_JSON/.test(erro)) window.dispatchEvent(new CustomEvent('hub:aviso', { detail: 'Google Agenda: ' + erro }));
  }).catch(e => console.warn('gcal-sync', e));
  if (table === 'events' && row.origem === 'google' && id) return chamar({ evento: id });
  clearTimeout(gcalT);
  gcalT = setTimeout(() => chamar({}), 1500);
}

export const byId = (t, id) => S[t].find(r => r.id === id);
export const contactName = id => byId('contacts', id)?.nome || '';
export const contatoPorNome = nome => S.contacts.find(c => c.nome.toLowerCase() === (nome || '').trim().toLowerCase());
export const prop = id => S.properties.find(p => p.id === id) || { nome: id, cor: '#888' };

// Garante um contato pelo nome (cria se não existir)
export async function ensureContact(nome, tipo = 'cliente', telefone = '') {
  nome = (nome || '').trim();
  telefone = (telefone || '').trim();
  if (!nome) return null;
  const c = contatoPorNome(nome);
  if (c) {
    if (telefone && telefone !== c.telefone) Object.assign(c, await db.update('contacts', c.id, { telefone }));
    return c.id;
  }
  const n = await db.insert('contacts', { nome, tipo, telefone: telefone || null, ultima_interacao: today() });
  S.contacts.push(n);
  return n.id;
}

// ---------------------------------------------------------------
// Itens unificados: tudo que tem data vira {date, time, kind, area, title, ref}
// ---------------------------------------------------------------
export function items({ from, to, cals = ['dj', 'alugueis', 'pessoal'] } = {}) {
  const out = [];
  const inR = d => d && (!from || d >= from) && (!to || d <= to);
  for (const d of S.deals) {
    if (ABERTAS.includes(d.etapa) && inR(d.data_proxima_acao))
      out.push({ kind: 'acao', date: d.data_proxima_acao, area: d.negocio, title: d.proxima_acao, sub: contactName(d.contato_id) || d.titulo, ref: d });
    if (d.data_evento && d.negocio === 'dj' && cals.includes('dj') && d.etapa !== 'perdido' && inR(d.data_evento))
      out.push({ kind: 'gig', date: d.data_evento, time: d.hora_inicio?.slice(0, 5), end: d.hora_fim?.slice(0, 5), area: 'dj',
        title: contactName(d.contato_id) || d.titulo, sub: d.local, tentative: !['fechado', 'realizado', 'pago'].includes(d.etapa), ref: d });
  }
  for (const t of S.tasks) if (!t.feito && inR(t.prazo))
    out.push({ kind: 'tarefa', date: t.prazo, area: t.area, title: t.titulo, ref: t, prio: t.prioridade });
  if (cals.includes('alugueis')) for (const b of S.bookings) {
    if (b.status === 'cancelada') continue;
    const p = prop(b.property_id);
    const bloq = b.status === 'bloqueio';
    if (!bloq && inR(b.checkin)) out.push({ kind: 'checkin', date: b.checkin, area: 'alugueis', title: `Check-in ${p.nome}`, sub: [b.hospede, b.origem].filter(Boolean).join(', '), ref: b });
    if (!bloq && inR(b.checkout)) out.push({ kind: 'checkout', date: b.checkout, area: 'alugueis', title: `Check-out ${p.nome}`, sub: b.hospede, ref: b });
  }
  // Etapas pendentes das hospedagens (o que já venceu aparece em "Escapando")
  const hoje = today();
  for (const b of S.bookings) {
    if (!acompanhada(b)) continue;
    const p = prop(b.property_id);
    for (const e of pendentes(b)) {
      const d = prazo(b, e);
      if (d >= hoje && inR(d)) out.push(etapaItem(b, e, d, p));
    }
  }
  for (const e of S.events) {
    if (!cals.includes(e.calendario)) continue;
    const d = e.dia_inteiro ? e.inicio.slice(0, 10) : localDate(e.inicio);
    if (inR(d)) out.push({ kind: 'evento', date: d, time: e.dia_inteiro ? null : hhmm(e.inicio), end: e.fim && !e.dia_inteiro ? hhmm(e.fim) : null,
      area: e.calendario, title: e.titulo, sub: e.local, ref: e });
  }
  return out.sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
}

// O que está escapando: ações vencidas, tarefas vencidas, orçamentos parados
export function atencao() {
  const hoje = today();
  const out = [];
  for (const d of S.deals) {
    if (!ABERTAS.includes(d.etapa)) continue;
    // Aberta sem próximo passo (importação, edição direta no banco): some de todas as listas, então aparece aqui
    if (!d.proxima_acao?.trim() || !d.data_proxima_acao)
      out.push({ kind: 'acao', motivo: 'sem próxima ação', date: localDate(d.updated_at || d.created_at || new Date().toISOString()), area: d.negocio,
        title: `${d.titulo}: sem próxima ação`, sub: 'Defina o próximo passo e a data', ref: d });
    else if (d.data_proxima_acao < hoje)
      out.push({ kind: 'acao', motivo: 'atrasada', date: d.data_proxima_acao, area: d.negocio, title: d.proxima_acao, sub: contactName(d.contato_id) || d.titulo, ref: d });
    else if (['orcamento', 'negociacao'].includes(d.etapa) && d.updated_at && diffDays(localDate(d.updated_at), hoje) >= CONFIG.DIAS_ESQUECIDO && d.data_proxima_acao > hoje)
      out.push({ kind: 'acao', motivo: 'parado', date: localDate(d.updated_at), area: d.negocio, title: `${d.titulo}: sem movimento há ${diffDays(localDate(d.updated_at), hoje)} dias`, sub: 'Próxima ação: ' + d.proxima_acao, ref: d });
    if (d.etapa === 'fechado' && d.data_evento && d.data_evento < hoje)
      out.push({ kind: 'acao', motivo: 'evento passou', date: d.data_evento, area: d.negocio, title: `${d.titulo}: o evento já passou`, sub: 'Mover para Realizado e cobrar', ref: d });
  }
  for (const t of S.tasks) if (!t.feito && t.prazo && t.prazo < hoje)
    out.push({ kind: 'tarefa', motivo: 'atrasada', date: t.prazo, area: t.area, title: t.titulo, ref: t });
  out.push(...conflitos(), ...reservasDuplas());
  // Hospedagem: só a etapa atrasada mais antiga de cada reserva, para não poluir
  for (const b of S.bookings) {
    if (!acompanhada(b)) continue;
    const e = pendentes(b).find(e => prazo(b, e) < hoje);
    if (e) out.push({ ...etapaItem(b, e, prazo(b, e), prop(b.property_id)), motivo: 'atrasada' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------
// Conflitos de agenda: gig no mesmo dia de um check-in/check-out, ou na véspera de um check-out
// (tocou de noite, tem casa para entregar de manhã). Marcar como "ciente" vale só neste aparelho.
// ---------------------------------------------------------------
const CIENTE = 'hub:conflitos-ok';
const lerCiente = () => { try { return new Set(JSON.parse(localStorage.getItem(CIENTE) || '[]')); } catch { return new Set(); } };
export function marcarCiente(chave) {
  const s = lerCiente(); s.add(chave);
  try { localStorage.setItem(CIENTE, JSON.stringify([...s].slice(-200))); } catch {}
  listeners.forEach(fn => fn());
}
export function conflitos(dias = 30) {
  const hoje = today(), fim = addDays(hoje, dias), ok = lerCiente(), out = [];
  const gigs = S.deals.filter(d => d.negocio === 'dj' && d.data_evento && !['perdido', 'pago'].includes(d.etapa) && d.data_evento >= hoje && d.data_evento <= fim);
  const movs = [];
  for (const b of S.bookings) {
    if (b.status !== 'confirmada') continue;
    movs.push({ dia: b.checkin, tipo: 'Check-in', b }, { dia: b.checkout, tipo: 'Check-out', b });
  }
  for (const g of gigs) {
    for (const m of movs) {
      const mesmoDia = m.dia === g.data_evento;
      const manhaSeguinte = m.tipo === 'Check-out' && m.dia === addDays(g.data_evento, 1);
      if (!mesmoDia && !manhaSeguinte) continue;
      const chave = `${g.id}|${m.b.id}|${m.tipo}`;
      if (ok.has(chave)) continue;
      const casa = prop(m.b.property_id).nome;
      out.push({ kind: 'conflito', motivo: 'conflito', chave, date: g.data_evento, area: 'dj', ref: g,
        title: `Gig ${contactName(g.contato_id) || g.titulo} × ${m.tipo} ${casa}`,
        sub: `${mesmoDia ? 'No mesmo dia' : 'Check-out na manhã seguinte'} (${fmtCheckin(m.dia)}). Combine quem recebe ou entrega a casa.` });
    }
  }
  return out;
}

// Duas reservas confirmadas na mesma casa com noites em comum (ex.: Airbnb × direta).
// Bloqueio sobre reserva não conta: é o que se faz no Airbnb para segurar uma reserva direta.
export function reservasDuplas() {
  const hoje = today(), ok = lerCiente(), out = [];
  const ativas = S.bookings.filter(b => b.status === 'confirmada' && b.checkout > hoje).sort((a, b) => a.checkin.localeCompare(b.checkin));
  for (let i = 0; i < ativas.length; i++) for (let j = i + 1; j < ativas.length; j++) {
    const a = ativas[i], b = ativas[j];
    if (a.property_id !== b.property_id || !(a.checkin < b.checkout && b.checkin < a.checkout)) continue;
    const chave = `dupla|${a.id}|${b.id}`;
    if (ok.has(chave)) continue;
    const quem = x => `${x.hospede || 'sem nome'} (${x.origem}, ${fmtCheckin(x.checkin)} a ${fmtCheckin(x.checkout)})`;
    out.push({ kind: 'conflito', motivo: 'reserva dupla', chave, date: b.checkin, area: 'alugueis', ref: b,
      title: `Reserva dupla · ${prop(a.property_id).nome}`, sub: `${quem(a)} × ${quem(b)}` });
  }
  return out;
}

function etapaItem(b, e, d, p) {
  return { kind: 'etapa', etapa: e.id, date: d, area: 'alugueis', title: `${e.nome} · ${p.nome}`,
    sub: `${b.hospede || b.origem}, check-in ${fmtCheckin(b.checkin)}`, ref: b };
}
const fmtCheckin = d => d.split('-').reverse().slice(0, 2).join('/');

export function ocupacao(propertyId, dia) {
  return S.bookings.find(b => b.property_id === propertyId && b.status !== 'cancelada' && b.checkin <= dia && b.checkout > dia);
}
export { addDays };
