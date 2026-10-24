// Frases que interpretam os números dos cards ("o que isso quer dizer?"), com o link para a lista certa.
// Só regras sobre os dados que já estão no Hub: sem IA, na hora e funcionando offline.
// Cada função devolve { texto } (às vezes com cat/rotulo para o link) ou null quando não há nada que valha dizer.
// Os cards que já têm link no rodapé não repetem o link na frase.
import { today, addDays, diffDays, dow, fmtDate, brl, mesNome } from './util.js';

const ABERTAS_ANTES = ['lead', 'orcamento', 'negociacao'];
const A_RECEBER = ['negociacao', 'fechado', 'realizado'];
const pct = (a, b) => Math.round((a / b - 1) * 100);
const nomeDe = d => String(d.titulo || '').split(' — ').slice(1).join(' — ') || d.titulo || 'sem nome';
const recebido = d => (d.pagamentos || []).reduce((s, p) => s + (+p.valor || 0), 0);
const saldo = d => Math.max(0, Math.round(((+d.valor || 0) - recebido(d)) * 100) / 100);
// Valor que não quebra de linha no meio ("-R$ 800", "+R$ 940")
const junto = t => String(t).replace(/ /g, '\u00a0').replace(/^([+-])/, '$1\u2060');
const lista = xs => xs.length > 1 ? `${xs.slice(0, -1).join(', ')} e ${xs.at(-1)}` : xs[0] || '';

// ---------- Hoje ----------

// O dia numa frase: gigs, entradas e saídas das casas, compromissos
export function fraseDia(doDia) {
  const gigs = doDia.filter(i => i.kind === 'gig');
  const ent = doDia.filter(i => i.kind === 'checkin'), sai = doDia.filter(i => i.kind === 'checkout');
  const evs = doDia.filter(i => i.kind === 'evento');
  const partes = [];
  for (const g of gigs.slice(0, 2)) partes.push(`gig${g.time ? ` às ${g.time}` : ''} (${g.title.replace(/^DJ\s*—\s*/, '')})`);
  if (ent.length) partes.push(`${ent.length > 1 ? `${ent.length} check-ins` : 'check-in'} na ${lista(ent.map(i => i.title.replace(/^Check-in\s+(Casa\s+)?/, '')))}`);
  if (sai.length) partes.push(`${sai.length > 1 ? `${sai.length} check-outs` : 'check-out'} na ${lista(sai.map(i => i.title.replace(/^Check-out\s+(Casa\s+)?/, '')))}`);
  if (evs.length) partes.push(evs.length === 1 ? `${evs[0].time ? `${evs[0].time} ` : ''}${evs[0].title}` : `${evs.length} compromissos`);
  if (!partes.length) return null;
  const t = lista(partes);
  return { texto: t[0].toUpperCase() + t.slice(1) + '.' };
}

// Ocupação das próximas 14 noites por casa e, para a mais vazia, o próximo fim de semana livre (sexta e sábado)
export function fraseOcupacao(casas, ocupada, hoje = today()) {
  if (!casas.length) return null;
  const noites = Array.from({ length: 14 }, (_, i) => addDays(hoje, i));
  const taxa = casas.map(p => ({ p, n: noites.filter(d => ocupada(p.id, d)).length })).map(x => ({ ...x, pct: Math.round(x.n / 14 * 100) }));
  const curto = p => p.nome.replace(/^Casa\s+/, '');
  const ordem = [...taxa].sort((a, b) => b.pct - a.pct);
  const vazia = ordem.at(-1);
  let fds = null;
  for (let i = 0; i < 35 && !fds; i++) {
    const d = addDays(hoje, i);
    if (dow(d) === 5 && !ocupada(vazia.p.id, d) && !ocupada(vazia.p.id, addDays(d, 1))) fds = d;
  }
  const todas = ordem.map(x => `${curto(x.p)} ${x.pct}%`).join(', ');
  const quando = !fds ? '' : diffDays(hoje, fds) < 7 ? 'neste fim de semana' : diffDays(hoje, fds) < 14 ? `no próximo fim de semana (${fmtDate(fds)})` : `no fim de semana de ${fmtDate(fds)}`;
  const livre = fds ? ` A ${curto(vazia.p)} está livre ${quando}.` : '';
  return { texto: `Próximas 2 semanas: ${todas}.${livre}` };
}

// Pipeline: o que está parado (próxima ação vencida antes de fechar) e o que falta receber
export function frasePipeline(deals, hoje = today()) {
  const parados = deals.filter(d => ABERTAS_ANTES.includes(d.etapa) && d.data_proxima_acao && d.data_proxima_acao < hoje)
    .sort((a, b) => a.data_proxima_acao.localeCompare(b.data_proxima_acao));
  const receber = deals.filter(d => A_RECEBER.includes(d.etapa) && +d.valor > 0 && saldo(d) > 0).sort((a, b) => saldo(b) - saldo(a));
  const partes = [];
  if (parados.length) {
    const n = diffDays(parados[0].data_proxima_acao, hoje);
    partes.push(`${parados.length === 1 ? '1 negociação parada' : `${parados.length} negociações paradas`}: a mais antiga é ${nomeDe(parados[0])} (${n} ${n === 1 ? 'dia' : 'dias'} sem o próximo passo).`);
  }
  if (receber.length) {
    const total = receber.reduce((s, d) => s + saldo(d), 0);
    partes.push(`A receber: ${brl(total)}${receber.length > 1 ? `, o maior saldo é ${nomeDe(receber[0])} (${brl(saldo(receber[0]))})` : ` de ${nomeDe(receber[0])}`}.`);
  }
  return partes.length ? { texto: partes.join(' ') } : null;
}

// ---------- Finanças (fluxo de caixa) ----------

// Mês em andamento compara com o mês anterior até o mesmo dia; mês fechado compara com o anterior inteiro
export function periodoComparavel(mes, hoje = today()) {
  const [y, m] = mes.split('-').map(Number);
  const ant = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const corrente = mes === hoje.slice(0, 7);
  const dia = corrente ? +hoje.slice(8) : 31;
  return { ant, ateDia: dia, corrente, nomeAnt: mesNome(+ant.slice(5) - 1) };
}

// Saídas do mês contra o mês anterior e a categoria que mais subiu
// fmt: o formatador de dinheiro da tela (respeita o modo privado e o R$/US$)
export function fraseSaidas(tx, mes, catDe, { hoje = today(), fmt = brl } = {}) {
  const { ant, ateDia, corrente, nomeAnt } = periodoComparavel(mes, hoje);
  const ate = t => +t.data.slice(8) <= ateDia;
  const sai = m => tx.filter(t => t.valor < 0 && t.data.startsWith(m) && ate(t));
  const cur = sai(mes), velho = sai(ant);
  const tot = l => -l.reduce((s, t) => s + +t.valor, 0);
  const a = tot(cur), b = tot(velho);
  if (!a || !b) return null;
  const porCat = l => l.reduce((m, t) => ((m[catDe(t)] = (m[catDe(t)] || 0) - t.valor), m), {});
  const ca = porCat(cur), cb = porCat(velho);
  const delta = Object.keys(ca).map(c => [c, ca[c] - (cb[c] || 0)]).sort((x, y) => y[1] - x[1]);
  const p = pct(a, b);
  const quando = corrente ? `até o dia ${ateDia}` : 'no mês';
  const comp = Math.abs(p) < 5 ? `Saídas ${quando} parecidas com ${nomeAnt}` : `Saídas ${quando} ${Math.abs(p)}% ${p > 0 ? 'acima' : 'abaixo'} de ${nomeAnt}`;
  if (p >= 5 && delta[0] && delta[0][1] > 0) {
    return { texto: `${comp}. Quem mais subiu foi ${delta[0][0]} (${junto('+' + fmt(Math.round(delta[0][1])))}).`, cat: delta[0][0], rotulo: `Ver lançamentos de ${delta[0][0]}` };
  }
  return { texto: `${comp}.` };
}

// Por negócio: o que mais rendeu e quem ficou no vermelho
export function fraseNegocios(grupos, nomeNeg, nomeCasa, fmt = brl) {
  const lst = Object.entries(grupos).filter(([n]) => n).map(([n, g]) => ({ n, r: g.ent + g.sai, g }));
  if (!lst.length) return null;
  const partes = [];
  const melhor = [...lst].sort((a, b) => b.r - a.r)[0];
  if (melhor.r > 0) {
    const casas = Object.entries(melhor.g.casas || {}).map(([c, v]) => [c, v.ent + v.sai]).sort((a, b) => b[1] - a[1]);
    partes.push(`${nomeNeg(melhor.n)} foi o que mais rendeu (${junto(fmt(Math.round(melhor.r)))})${casas.length > 1 ? `, com a ${nomeCasa(casas[0][0])} na frente` : ''}.`);
  }
  // Casa e pessoal só têm gasto: "no vermelho" vale para os negócios
  const negativos = lst.filter(x => x.r < 0 && x !== melhor && !['casa', 'pessoal'].includes(x.n)).sort((a, b) => a.r - b.r);
  if (negativos.length) partes.push(`${lista(negativos.map(x => `${nomeNeg(x.n)} (${junto(fmt(Math.round(x.r)))})`))} ${negativos.length > 1 ? 'ficaram' : 'ficou'} no vermelho.`);
  return partes.length ? { texto: partes.join(' ') } : null;
}
