import { CONFIG } from './config.js';

export const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Datas (sempre como 'YYYY-MM-DD' no fuso de Pipa) ----------
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TZ }).format(new Date());
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function diffDays(a, b) { // b - a
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);
}
export const dow = iso => new Date(iso + 'T12:00:00Z').getUTCDay();
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const DIAS_L = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MESES_L = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const mesNome = m => MESES_L[m];
export function fmtDate(iso, opt = {}) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (opt.long) return `${DIAS_L[dow(iso)]}, ${d} de ${MESES_L[m - 1]}`;
  const base = `${d} ${MESES[m - 1]}`;
  return opt.year || y !== +today().slice(0, 4) ? `${base} ${String(y).slice(2)}` : base;
}
export function relDate(iso) {
  if (!iso) return 'sem data';
  const n = diffDays(today(), iso);
  if (n === 0) return 'hoje';
  if (n === 1) return 'amanhã';
  if (n === -1) return 'ontem';
  if (n < 0) return `há ${-n} dias`;
  if (n < 7) return DIAS[dow(iso)];
  return fmtDate(iso);
}
export const weekdayShort = iso => DIAS[dow(iso)];

// hora local 'HH:MM' de um timestamp ISO
export function hhmm(ts) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: CONFIG.TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}
export function localDate(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TZ }).format(new Date(ts));
}

export const brl = v => v == null || v === '' ? '' :
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

// ---------- Áreas / negócios ----------
export const AREAS = {
  dj: { nome: 'DJ', cor: 'var(--dj)' },
  alugueis: { nome: 'Aluguéis', cor: 'var(--alug)' },
  aluguel: { nome: 'Aluguéis', cor: 'var(--alug)' },
  consultoria: { nome: 'Engenharia', cor: 'var(--eng)' },
  flores: { nome: 'Flores do Sol', cor: 'var(--flores)' },
  casa: { nome: 'Casa', cor: 'var(--casa)' },
  pessoal: { nome: 'Pessoal', cor: 'var(--casa)' },
  inbox: { nome: 'Caixa de entrada', cor: 'var(--muted)' },
};
export const areaTag = a => `<span class="tag" style="--c:${(AREAS[a] || AREAS.inbox).cor}">${h((AREAS[a] || { nome: a }).nome)}</span>`;

export const ETAPAS = [
  { id: 'lead', nome: 'Contato', sug: 'Enviar orçamento', dias: 1 },
  { id: 'orcamento', nome: 'Orçamento enviado', sug: 'Follow-up do orçamento', dias: 3 },
  { id: 'negociacao', nome: 'Negociando', sug: 'Fechar e pedir sinal', dias: 2 },
  { id: 'fechado', nome: 'Fechado', sug: 'Confirmar detalhes do evento', dias: 7 },
  { id: 'realizado', nome: 'Realizado', sug: 'Cobrar pagamento', dias: 1 },
  { id: 'pago', nome: 'Pago' },
  { id: 'perdido', nome: 'Perdido' },
];
export const etapa = id => ETAPAS.find(e => e.id === id) || { nome: id };
export const ABERTAS = ['lead', 'orcamento', 'negociacao', 'fechado', 'realizado'];

// ---------- Captura rápida: "ligar p/ Guilherme amanhã #dj !" ----------
export function parseCapture(txt) {
  let t = ' ' + txt.trim() + ' ';
  let area = 'inbox', prazo = null, prioridade = 2;
  const tags = { dj: 'dj', aluguel: 'alugueis', alugueis: 'alugueis', casa: 'casa', eng: 'consultoria', obra: 'consultoria', consultoria: 'consultoria', flores: 'flores', pessoal: 'pessoal' };
  t = t.replace(/\s#(\w+)/g, (m, k) => { if (tags[k.toLowerCase()]) area = tags[k.toLowerCase()]; return ' '; });
  t = t.replace(/\s!(?=\s)/g, () => { prioridade = 1; return ' '; });
  const hoje = today();
  t = t.replace(/\s(hoje)\s/i, () => { prazo = hoje; return ' '; });
  t = t.replace(/\s(amanh[ãa])\s/i, () => { prazo = addDays(hoje, 1); return ' '; });
  t = t.replace(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s/, (m, d, mo, y) => {
    let yy = y ? (y.length === 2 ? '20' + y : y) : hoje.slice(0, 4);
    let iso = `${yy}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (!y && iso < hoje) iso = `${+yy + 1}${iso.slice(4)}`;
    prazo = iso; return ' ';
  });
  const wd = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6, 'sáb': 6 };
  t = t.replace(/\s(dom|seg|ter|qua|qui|sex|s[áa]b)\s/i, (m, k) => {
    const target = wd[k.toLowerCase().replace('á', 'a')] ?? wd[k.toLowerCase()];
    let n = (target - dow(hoje) + 7) % 7 || 7;
    prazo = addDays(hoje, n); return ' ';
  });
  return { titulo: t.replace(/\s+/g, ' ').trim(), area, prazo, prioridade };
}
