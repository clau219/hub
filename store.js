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

export async function load() {
  const res = await Promise.all(TABLES.map(t => db.all(t).catch(e => { console.warn(t, e); return []; })));
  TABLES.forEach((t, i) => (S[t] = res[i]));
  if (!S.properties.length && db.mode === 'local') {
    for (const p of DEFAULT_PROPS) await db.insert('properties', p);
    S.properties = await db.all('properties');
  }
  listeners.forEach(fn => fn());
}

export async function save(table, row, id) {
  const r = id ? await db.update(table, id, row) : await db.insert(table, row);
  await load();
  return r;
}
export async function del(table, id) { await db.remove(table, id); await load(); }

export const byId = (t, id) => S[t].find(r => r.id === id);
export const contactName = id => byId('contacts', id)?.nome || '';
export const prop = id => S.properties.find(p => p.id === id) || { nome: id, cor: '#888' };

// Garante um contato pelo nome (cria se não existir)
export async function ensureContact(nome, tipo = 'cliente') {
  nome = (nome || '').trim();
  if (!nome) return null;
  const c = S.contacts.find(c => c.nome.toLowerCase() === nome.toLowerCase());
  if (c) return c.id;
  const n = await db.insert('contacts', { nome, tipo, ultima_interacao: today() });
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
    if (d.data_proxima_acao && d.data_proxima_acao < hoje)
      out.push({ kind: 'acao', motivo: 'atrasada', date: d.data_proxima_acao, area: d.negocio, title: d.proxima_acao, sub: contactName(d.contato_id) || d.titulo, ref: d });
    else if (['orcamento', 'negociacao'].includes(d.etapa) && d.updated_at && diffDays(localDate(d.updated_at), hoje) >= CONFIG.DIAS_ESQUECIDO && d.data_proxima_acao > hoje)
      out.push({ kind: 'acao', motivo: 'parado', date: localDate(d.updated_at), area: d.negocio, title: `${d.titulo}: sem movimento há ${diffDays(localDate(d.updated_at), hoje)} dias`, sub: 'Próxima ação: ' + d.proxima_acao, ref: d });
    if (d.etapa === 'fechado' && d.data_evento && d.data_evento < hoje)
      out.push({ kind: 'acao', motivo: 'evento passou', date: d.data_evento, area: d.negocio, title: `${d.titulo}: o evento já passou`, sub: 'Mover para Realizado e cobrar', ref: d });
  }
  for (const t of S.tasks) if (!t.feito && t.prazo && t.prazo < hoje)
    out.push({ kind: 'tarefa', motivo: 'atrasada', date: t.prazo, area: t.area, title: t.titulo, ref: t });
  // Hospedagem: só a etapa atrasada mais antiga de cada reserva, para não poluir
  for (const b of S.bookings) {
    if (!acompanhada(b)) continue;
    const e = pendentes(b).find(e => prazo(b, e) < hoje);
    if (e) out.push({ ...etapaItem(b, e, prazo(b, e), prop(b.property_id)), motivo: 'atrasada' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
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
