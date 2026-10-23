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
  argila: { nome: 'Argila Lab', cor: 'var(--argila)' },
  casa: { nome: 'Casa', cor: 'var(--casa)' },
  pessoal: { nome: 'Pessoal', cor: 'var(--casa)' },
  inbox: { nome: 'Caixa de entrada', cor: 'var(--muted)' },
};
export const areaTag = a => `<span class="tag" style="--c:${(AREAS[a] || AREAS.inbox).cor}">${h((AREAS[a] || { nome: a }).nome)}</span>`;

// Etapas abertas de cada negócio. Os ids são os mesmos para todos (o banco não muda):
// o que muda é o nome, a próxima ação sugerida e quais etapas existem.
const ENCERRADAS = [{ id: 'pago', nome: 'Pago' }, { id: 'perdido', nome: 'Perdido' }];
const SERVICO = [
  { id: 'lead', nome: 'Contato', sug: 'Enviar proposta', dias: 1 },
  { id: 'orcamento', nome: 'Proposta enviada', sug: 'Follow-up da proposta', dias: 3 },
  { id: 'fechado', nome: 'Em andamento', sug: 'Atualizar o cliente', dias: 7 },
  { id: 'realizado', nome: 'Entregue', sug: 'Cobrar pagamento', dias: 1 },
];
export const FLUXOS = {
  dj: [
    { id: 'lead', nome: 'Contato', sug: 'Enviar orçamento', dias: 1 },
    { id: 'orcamento', nome: 'Orçamento enviado', sug: 'Follow-up do orçamento', dias: 3 },
    { id: 'negociacao', nome: 'Negociando', sug: 'Fechar e pedir sinal', dias: 2 },
    { id: 'fechado', nome: 'Fechado', sug: 'Confirmar detalhes do evento', dias: 7 },
    { id: 'realizado', nome: 'Realizado', sug: 'Cobrar pagamento', dias: 1 },
  ],
  consultoria: SERVICO,
  aluguel: [
    { id: 'lead', nome: 'Contato', sug: 'Enviar valor e disponibilidade', dias: 1 },
    { id: 'orcamento', nome: 'Orçamento enviado', sug: 'Follow-up do orçamento', dias: 1 },
    { id: 'fechado', nome: 'Reservado', sug: 'Receber o saldo', dias: 7 },
  ],
  argila: SERVICO,
};
// Ordem das faixas no Pipeline
export const NEGOCIOS_PIPE = ['dj', 'consultoria', 'aluguel', 'argila'];
const fluxoAberto = negocio => FLUXOS[negocio === 'alugueis' ? 'aluguel' : negocio] || FLUXOS.dj;
export const fluxo = negocio => [...fluxoAberto(negocio), ...ENCERRADAS];
export const abertasDe = negocio => fluxoAberto(negocio).map(e => e.id);
// Etapa em que a oportunidade aparece no quadro do negócio: "Negociando" antigo de quem não tem essa etapa conta como orçamento
export const etapaNoFluxo = d => (d.etapa === 'negociacao' && !abertasDe(d.negocio).includes('negociacao') ? 'orcamento' : d.etapa);
export const ETAPAS = fluxo('dj');
// Sem negócio, usa os nomes do DJ (que tem todas as etapas)
export const etapa = (id, negocio) => fluxo(negocio).find(e => e.id === id) || ETAPAS.find(e => e.id === id) || { nome: id };
// Todas as etapas que contam como aberta em algum negócio
export const ABERTAS = ['lead', 'orcamento', 'negociacao', 'fechado', 'realizado'];

// Pagamentos de uma oportunidade (deals.pagamentos: [{data, valor, forma}]): sinal, parcelas e saldo
export const FORMAS_PGTO = ['Pix', 'Dinheiro', 'Transferência', 'Cartão'];
const centavos = v => Math.round(v * 100) / 100;
export const recebido = d => centavos((d.pagamentos || []).reduce((s, p) => s + (+p.valor || 0), 0));
export const saldoDeal = d => Math.max(0, centavos((+d.valor || 0) - recebido(d)));

// ---------- WhatsApp ----------
// Link wa.me com mensagem pronta. Aceita "(84) 99999-0000", "+55 84 9...", "084 9...".
export function waLink(tel, txt = '') {
  let n = String(tel || '').replace(/\D/g, '').replace(/^0+/, '');
  if (n.length < 10) return null;
  if (!(n.length >= 12 && n.startsWith('55'))) n = '55' + n;
  return `https://wa.me/${n}${txt ? '?text=' + encodeURIComponent(txt) : ''}`;
}
// Mensagem sugerida conforme a etapa da oportunidade
export function msgDeal(d, nome) {
  const n = (nome || '').trim().split(/\s+/)[0] || '';
  const oi = n ? `Oi, ${n}!` : 'Oi!';
  if (d.negocio === 'aluguel' || d.negocio === 'alugueis') return {
    lead: `${oi} Aqui é o Claudio. Me passa as datas e quantas pessoas que eu já te mando o valor e a disponibilidade?`,
    orcamento: `${oi} Tudo bem? Conseguiu ver o valor? As datas ainda estão livres, mas podem fechar a qualquer momento.`,
    fechado: `${oi} Sua reserva está garantida${d.data_evento ? ` para ${fmtDate(d.data_evento)}` : ''}! Segue a chave PIX para o saldo:`,
  }[d.etapa] || oi;
  if (d.negocio !== 'dj') return {
    lead: `${oi} Aqui é o Claudio. Me conta um pouco mais do que você precisa para eu te mandar uma proposta?`,
    orcamento: `${oi} Tudo bem? Conseguiu ver a proposta? Se quiser, ajusto o que precisar.`,
    fechado: `${oi} Passando para te atualizar sobre o andamento do serviço.`,
    realizado: `${oi} Serviço entregue! Obrigado pela confiança. Segue a chave PIX para o pagamento:`,
  }[d.etapa] || oi;
  return {
    lead: `${oi} Aqui é o Claudio (DJ CLAU). Me passa a data, o local e o horário do evento que eu já te mando o orçamento?`,
    orcamento: `${oi} Tudo bem? Conseguiu ver o orçamento? Se quiser, ajusto o que precisar.`,
    negociacao: `${oi} Para garantir a data, fechamos com um sinal. Posso te mandar o contrato?`,
    fechado: `${oi} Passando para alinhar os detalhes${d.data_evento ? ` do dia ${fmtDate(d.data_evento)}` : ''}. Algum horário bom para conversarmos?`,
    realizado: `${oi} Obrigado pela confiança! Segue a chave PIX para o pagamento do saldo:`,
  }[d.etapa] || oi;
}

// ---------- Captura rápida: "ligar p/ Guilherme amanhã #dj !" ----------
// Começando com "+" vira oportunidade: "+dj Ana Souza casamento 12/12" (a data é a do evento)
// "2026-11-31" não existe: o Date do JS viraria 1º de dezembro
const dataValida = iso => { const d = new Date(iso + 'T12:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === iso; };

export function parseCapture(txt) {
  const deal = /^\s*\+/.test(txt);
  if (deal) txt = txt.replace(/^\s*\+\s*/, '').replace(/^(dj|eng|obra|consultoria|argila|aluguel|alugueis)(?=\s|$)/i, '#$1');
  let t = ' ' + txt.trim() + ' ';
  let area = deal ? 'dj' : 'inbox', prazo = null, prioridade = 2;
  const tags = { dj: 'dj', aluguel: 'alugueis', alugueis: 'alugueis', casa: 'casa', eng: 'consultoria', obra: 'consultoria', consultoria: 'consultoria', argila: 'argila', pessoal: 'pessoal' };
  t = t.replace(/\s#(\w+)/g, (m, k) => { if (tags[k.toLowerCase()]) area = tags[k.toLowerCase()]; return ' '; });
  t = t.replace(/\s!(?=\s)/g, () => { prioridade = 1; return ' '; });
  const hoje = today();
  t = t.replace(/\s(hoje)\s/i, () => { prazo = hoje; return ' '; });
  t = t.replace(/\s(depois de amanh[ãa])\s/i, () => { prazo = addDays(hoje, 2); return ' '; });
  t = t.replace(/\s(amanh[ãa])\s/i, () => { prazo = addDays(hoje, 1); return ' '; });
  t = t.replace(/\sem (\d{1,3}) dias?\s/i, (m, n) => { prazo = addDays(hoje, +n); return ' '; });
  t = t.replace(/\s(?:(?:na )?pr[óo]xima semana|semana que vem)\s/i, () => { prazo = addDays(hoje, ((8 - dow(hoje)) % 7) || 7); return ' '; });
  // "dia 20": este mês, ou o próximo se já passou. Dia que não existe no mês (31/11) fica no texto, sem prazo.
  t = t.replace(/\sdia (\d{1,2})\s/i, (m, d) => {
    const [y, mo] = hoje.split('-').map(Number);
    let iso = `${hoje.slice(0, 7)}-${d.padStart(2, '0')}`;
    if (iso < hoje) iso = mo === 12 ? `${y + 1}-01-${d.padStart(2, '0')}` : `${y}-${String(mo + 1).padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (!dataValida(iso)) return m;
    prazo = iso; return ' ';
  });
  t = t.replace(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s/, (m, d, mo, y) => {
    let yy = y ? (y.length === 2 ? '20' + y : y) : hoje.slice(0, 4);
    let iso = `${yy}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (!y && iso < hoje) iso = `${+yy + 1}${iso.slice(4)}`;
    if (!dataValida(iso)) return m;
    prazo = iso; return ' ';
  });
  // Dia da semana por extenso ("sexta", "na quinta", "sexta-feira") ou abreviado ("sex", "qui").
  // "ter" sozinho é o verbo ("ter o orçamento pronto"): terça só por extenso ou "ter."
  const DIA = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
  t = t.replace(/\s(?:(?:na|no|até|ate|pr[óo]xim[ao])\s+)?(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|dom|seg|ter\.|qua|qui|sex|s[áa]b)(?:-feira)?(?=\s)/i, (m, k) => {
    const target = DIA[k.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').slice(0, 3)];
    const n = (target - dow(hoje) + 7) % 7 || 7;
    prazo = addDays(hoje, n); return ' ';
  });
  const titulo = t.replace(/\s+/g, ' ').trim();
  if (deal) return { tipo: 'deal', texto: titulo, negocio: area === 'alugueis' ? 'aluguel' : ['dj', 'consultoria', 'argila'].includes(area) ? area : 'dj', data_evento: prazo };
  return { titulo, area, prazo, prioridade };
}
