import { S, save, del, load } from './store.js';
import * as db from './db.js';
import { h, today, fmtDate, mesNome } from './util.js';
import * as moedaV from './moeda.js';
import { CONFIG } from './config.js';
import { modal, toast, confirmInline, closeModal } from './ui.js';
import {
  M, VELHO_MS, PADRAO, TIPOS, CORRETORAS, LIMITE_ISENCAO, LIMITE_DECLARACAO, FNG_PT,
  atualizar, atualizando, buscar, preco, precoV, reais, brl, compacto, qtd, pct, sparkline, posicoes, calcular,
  paraCsv, interpretarCsv, resolverSimbolos, CSV_COLS, lerNumero, coinLabel,
  H, STABLES, PERIODOS, historicoPreco, atualizarSinais, sinaisAtualizando, sinaisVencidos, anotarDominancia, indicadores, progresso,
} from './cripto.js';

let aba = 'mercado';
let sort = { k: null, dir: -1 }; // k null = minha ordem
let alocPor = 'moeda';
let filtro = '';
let erro = '';
let snapAt = 0;
let viewEl = null;
let sel = null; // coin_id escolhido no quadro: os boxes do topo mostram os detalhes dele
let periodo = '30'; // período do gráfico de preço (dias da CoinGecko)

const dlg = () => document.getElementById('modal');
const naTela = () => location.hash.startsWith('#/cripto');

// Lista do quadro: favoritas no topo, depois a ordem escolhida (ou a coluna clicada)
function quadro() {
  const l = [...S.crypto_watch];
  const val = w => {
    const c = M.coins[w.coin_id] || {};
    return { rank: c.rank ?? 1e9, nome: w.nome.toLowerCase(), brl: c.brl, usd: c.usd, ch24: c.ch24, ch7: c.ch7, mcap: c.mcap, vol: c.vol, qtd: (carteiraQtd()[w.coin_id] || 0) * (c.brl || 0) }[sort.k];
  };
  return l.sort((a, b) => (b.favorita - a.favorita) || (sort.k
    ? cmp(val(a), val(b), sort.dir)
    : (a.ordem - b.ordem) || a.nome.localeCompare(b.nome)));
}
// dir 1 = crescente, -1 = decrescente; vazio sempre no fim
const cmp = (a, b, dir) => a == null || b == null ? (a == null) - (b == null) : (a < b ? -dir : a > b ? dir : 0);
let _qtdCache = null, _qtdTx = null;
function carteiraQtd() {
  if (_qtdTx !== S.crypto_tx) { _qtdTx = S.crypto_tx; _qtdCache = Object.fromEntries(Object.values(calcular(S.crypto_tx).moedas).map(m => [m.coin_id, m.qtd])); }
  return _qtdCache;
}
// Carteiras de autocustódia (OneKey, Rabby…) lidas na blockchain pela função cripto-carteiras.
// Só leitura aqui; o cadastro fica em Finanças → Contas e a soma com os lançamentos, no Painel.
let OC = { saldos: [], carteiras: [], at: 0 };
async function carregarOC() {
  if (Date.now() - OC.at < 5 * 60e3) return;
  OC.at = Date.now();
  try {
    if (db.mode === 'supabase') {
      const [s, c] = await Promise.all([db.client().from('cripto_saldos').select('*'), db.client().from('cripto_carteiras').select('*')]);
      OC = { saldos: s.data || [], carteiras: c.data || [], at: OC.at };
    } else {
      const [saldos, carteiras] = await Promise.all([db.all('cripto_saldos'), db.all('cripto_carteiras')]);
      OC = { saldos, carteiras, at: OC.at };
    }
  } catch { return; }
  if (OC.saldos.some(s => s.coin_id && !M.coins[s.coin_id])) refresh(false);
  if (viewEl && naTela()) render(viewEl);
}

// Moedas conhecidas: quadro + carteira + carteiras da blockchain
function conhecidas() {
  const m = new Map();
  for (const s of OC.saldos) if (s.coin_id && !m.has(s.coin_id)) m.set(s.coin_id, { coin_id: s.coin_id, simbolo: s.simbolo, nome: s.nome || s.simbolo });
  for (const w of S.crypto_watch) m.set(w.coin_id, { coin_id: w.coin_id, simbolo: w.simbolo, nome: w.nome });
  for (const t of S.crypto_tx) if (!m.has(t.coin_id)) m.set(t.coin_id, { coin_id: t.coin_id, simbolo: t.simbolo, nome: t.nome || t.simbolo });
  return [...m.values()];
}
const idsTodos = () => conhecidas().map(c => c.coin_id);

function atualizadoHa() {
  if (atualizando()) return 'atualizando…';
  if (!M.at) return 'sem cotações ainda';
  const min = Math.floor((Date.now() - M.at) / 60000);
  return min < 1 ? 'atualizado agora' : min < 60 ? `atualizado há ${min} min` : `atualizado há ${Math.floor(min / 60)} h`;
}
setInterval(() => { const s = document.getElementById('crAt'); if (s) s.textContent = atualizadoHa(); }, 30000);

const tentadas = new Set(); // moedas novas sem cotação: busca uma vez sem esperar os 5 min
function refresh(force) {
  const ids = idsTodos();
  const novas = ids.filter(id => !M.coins[id] && !tentadas.has(id));
  if (atualizando() || (!force && !novas.length && Date.now() - M.at < VELHO_MS)) return;
  novas.forEach(id => tentadas.add(id));
  const p = atualizar(ids);
  if (viewEl && naTela()) { const s = viewEl.querySelector('#crAt'); if (s) s.textContent = atualizadoHa(); }
  p.then(() => { erro = ''; snapshot(); })
    .catch(e => { erro = e.message; if (force) toast(e.message, 4000); })
    .finally(() => { if (viewEl && naTela()) render(viewEl); });
}

// Um snapshot por dia do valor da carteira (atualizado no máximo de hora em hora)
async function snapshot() {
  const { ativos, tot } = posicoes(S.crypto_tx);
  if (!ativos.length || ativos.some(p => !p.cot) || Date.now() - M.at > VELHO_MS) return;
  const dia = today();
  if (S.crypto_snap.some(s => s.dia === dia) && Date.now() - snapAt < 3600e3) return;
  snapAt = Date.now();
  try {
    const r = await db.upsert('crypto_snap', { dia, valor_brl: +tot.valor.toFixed(2), custo_brl: +tot.custo.toFixed(2) }, 'dia');
    S.crypto_snap = S.crypto_snap.filter(s => s.dia !== dia).concat(r);
  } catch (e) { console.warn('snapshot', e); }
}

let semeando = false;
async function semear() {
  if (semeando) return;
  semeando = true;
  try { localStorage.setItem('hub:cripto-semeado', '1'); } catch { /* sem armazenamento */ }
  await db.insertMany('crypto_watch', PADRAO.map(([coin_id, simbolo, nome], i) => ({ coin_id, simbolo, nome, ordem: i, favorita: false })));
  await load();
}

export function render(el) {
  viewEl = el;
  const q = location.hash.split('?')[1];
  if (q === 'mercado' || q === 'carteira' || q === 'sinais') aba = q;
  let semeado = false; try { semeado = !!localStorage.getItem('hub:cripto-semeado'); } catch { /* idem */ }
  if (db.mode === 'local' && !S.crypto_watch.length && !semeado) semear();
  refresh(false);
  carregarOC();

  el.innerHTML = `
  <div class="view-head">
    <h1>Cripto</h1>
    <div class="seg" role="tablist">${[['mercado', 'Mercado'], ['carteira', 'Carteira'], ['sinais', 'Sinais']].map(([k, l]) => `<button role="tab" aria-selected="${aba === k}" class="${aba === k ? 'on' : ''}" data-aba="${k}">${l}</button>`).join('')}</div>
    ${moedaV.botao()}
    <span class="cr-at muted small" id="crAt">${atualizadoHa()}</span>
    <button class="btn" id="crRef" ${atualizando() ? 'disabled' : ''}>Atualizar</button>
    ${aba === 'mercado' ? '<button class="btn primary" id="crAdd">Adicionar moeda</button>' : aba === 'carteira' ? '<button class="btn primary" id="crTx">Novo lançamento</button>' : ''}
  </div>
  ${erro ? `<p class="banner cr-banner">${h(erro)}${M.at ? ' Mostrando as últimas cotações salvas.' : ''}</p>` : ''}
  ${aba === 'mercado' ? mercado() : aba === 'carteira' ? carteira() : sinais()}`;

  el.querySelectorAll('[data-aba]').forEach(b => b.onclick = () => { history.replaceState(null, '', '#/cripto?' + b.dataset.aba); aba = b.dataset.aba; render(el); });
  el.querySelector('#crRef').onclick = () => refresh(true);
  moedaV.ligarBotao(el, () => render(el));
  el.querySelector('#crAdd')?.addEventListener('click', addMoeda);
  el.querySelector('#crTx')?.addEventListener('click', () => txForm());
  ({ mercado: bindMercado, carteira: bindCarteira, sinais: bindSinais })[aba](el);
}

// ===============================================================
// MERCADO
// ===============================================================
function mercado() {
  const g = M.global, f = M.fng;
  const lista = quadro();
  const qt = carteiraQtd();
  const cot = lista.map(w => M.coins[w.coin_id]).filter(Boolean);
  const com = k => cot.filter(c => c[k] != null);
  const alta = com('ch24').sort((a, b) => b.ch24 - a.ch24)[0];
  const queda = com('ch24').sort((a, b) => a.ch24 - b.ch24)[0];
  const ath = com('ath').filter(c => !['tether', 'usd-coin'].includes(c.id)).sort((a, b) => b.ath - a.ath)[0];
  const { ativos, tot } = posicoes(S.crypto_tx);
  const setas = (k, l, cls = 'num') => `<th class="${cls}"><button class="th-sort ${sort.k === k ? 'on' : ''}" data-sort="${k}">${l}${sort.k === k ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`;
  if (sel && !lista.some(w => w.coin_id === sel)) sel = null;

  return `
  ${sel ? detalhe(sel, lista.find(w => w.coin_id === sel)) : `<div class="kpis">
    <div class="kpi"><span>Dólar</span><b>${M.dolar ? preco(M.dolar) : '—'}</b></div>
    <div class="kpi"><span>Dominância do BTC</span><b>${g?.dom != null ? g.dom.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—'}</b></div>
    <div class="kpi"><span>Valor de mercado total</span><b>${g ? compacto(g.mcap) : '—'}</b><small>${g ? compacto(g.mcapUsd, 'USD') + ' · ' + pct(g.ch24) + ' 24h' : ''}</small></div>
    <div class="kpi"><span>Medo e Ganância</span><b>${f ? f.v : '—'}</b><small>${f ? h(FNG_PT[f.c] || f.c) : ''}</small>
      ${f ? `<i class="fng" style="--v:${f.v}" aria-hidden="true"></i>` : ''}</div>
  </div>`}
  ${cot.length ? `<div class="insights">
    ${alta ? `<span class="chip-static">Maior alta 24h: <b>${h(alta.simbolo)}</b> ${pct(alta.ch24)}</span>` : ''}
    ${queda && queda !== alta ? `<span class="chip-static">Maior queda 24h: <b>${h(queda.simbolo)}</b> ${pct(queda.ch24)}</span>` : ''}
    ${ath ? `<span class="chip-static">Mais perto da máxima histórica: <b>${h(ath.simbolo)}</b> ${pct(ath.ath, false)}</span>` : ''}
    ${ativos.length && tot.ch24 != null ? `<span class="chip-static">Sua carteira em 24h: ${pct(tot.ch24)}</span>` : ''}
  </div>` : ''}
  ${lista.length ? `<div class="table-wrap"><table class="table cr-table">
    <thead><tr><th class="cr-h" aria-label="Arrastar"></th><th class="cr-fav" aria-label="Favorita"></th>${setas('rank', '#', 'num')}${setas('nome', 'Moeda', '')}
      ${setas('brl', 'Preço R$')}${setas('usd', 'Preço US$')}${setas('ch24', '24h')}${setas('ch7', '7d')}${setas('mcap', 'Valor de mercado')}${setas('vol', 'Volume 24h')}
      <th>7 dias</th>${setas('qtd', 'Na carteira')}<th></th></tr></thead>
    <tbody>${lista.map(w => {
      const c = M.coins[w.coin_id] || {};
      const q = qt[w.coin_id];
      return `<tr data-w="${w.id}" data-coin="${h(w.coin_id)}" class="${sel === w.coin_id ? 'sel' : ''}" tabindex="0" aria-selected="${sel === w.coin_id}">
        <td class="cr-h">${sort.k ? '' : `<button class="drag" data-drag aria-label="Arrastar para reordenar" title="Arrastar para reordenar">⋮⋮</button>`}</td>
        <td class="cr-fav"><button class="star ${w.favorita ? 'on' : ''}" data-fav="${w.id}" aria-pressed="${w.favorita}" aria-label="Favorita">${w.favorita ? '★' : '☆'}</button></td>
        <td class="num muted">${c.rank ?? ''}</td>
        <td><span class="coin">${c.img ? `<img src="${h(c.img)}" alt="" width="20" height="20" loading="lazy">` : '<i class="coin-ph"></i>'}<b>${h(w.nome)}</b><span class="muted">${h(w.simbolo)}</span></span></td>
        <td class="num"><b>${preco(c.brl)}</b></td>
        <td class="num">${preco(c.usd, 'USD')}</td>
        <td class="num">${pct(c.ch24)}</td>
        <td class="num">${pct(c.ch7)}</td>
        <td class="num">${compacto(c.mcap)}</td>
        <td class="num">${compacto(c.vol)}</td>
        <td>${sparkline(c.spark, (c.ch7 ?? 0) >= 0)}</td>
        <td class="num">${q ? `${qtd(q)}<small class="muted">${c.brl ? reais(q * c.brl) : ''}</small>` : ''}</td>
        <td class="cr-acts"><button class="mini" data-buy="${w.coin_id}" title="Adicionar à carteira">+ Carteira</button><button class="mini trash" data-rm="${w.id}" aria-label="Remover do quadro" title="Remover do quadro">🗑</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>
    <p class="muted small">Variações em reais. ${sort.k ? '<button class="link-btn" id="crMine">Voltar para a minha ordem</button> (para arrastar)' : 'Arraste pelo ⋮⋮ para reordenar; clique no título da coluna para ordenar.'} Clique numa moeda para ver os detalhes dela nos quadros do topo. Dados: CoinGecko, alternative.me e AwesomeAPI.</p>`
    : `<p class="empty">Seu quadro está vazio. Use “Adicionar moeda”.</p>`}`;
}

function bindMercado(el) {
  el.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => {
    const k = b.dataset.sort;
    const ini = k === 'nome' || k === 'rank' ? 1 : -1; // texto/posição começam crescentes, números decrescentes
    if (sort.k !== k) sort = { k, dir: ini };
    else if (sort.dir === ini) sort.dir = -ini;
    else sort = { k: null, dir: -1 };
    render(el);
  });
  el.querySelector('#crMine')?.addEventListener('click', () => { sort = { k: null, dir: -1 }; render(el); });
  el.querySelectorAll('[data-fav]').forEach(b => b.onclick = async () => {
    const w = S.crypto_watch.find(x => x.id === b.dataset.fav);
    await save('crypto_watch', { favorita: !w.favorita }, w.id);
  });
  el.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    if (!confirmInline(b)) return;
    const w = S.crypto_watch.find(x => x.id === b.dataset.rm);
    await del('crypto_watch', w.id); toast(`${w.simbolo} removida do quadro`);
  });
  el.querySelectorAll('[data-buy]').forEach(b => b.onclick = () => txForm({}, { coin_id: b.dataset.buy }));
  el.querySelectorAll('[data-drag]').forEach(handle => handle.onpointerdown = ev => arrastar(ev, handle));
  el.querySelectorAll('tr[data-coin]').forEach(tr => {
    const go = e => {
      if (e.target.closest('button, a, input')) return;
      sel = sel === tr.dataset.coin ? null : tr.dataset.coin;
      render(el);
      const topo = el.querySelector('.cr-sel') || el.querySelector('.kpis');
      if (topo && topo.getBoundingClientRect().top < 0) topo.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    tr.onclick = go;
    tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } };
  });
  el.querySelector('#crSelX')?.addEventListener('click', () => { sel = null; render(el); });
  el.querySelectorAll('[data-per]').forEach(b => b.onclick = () => {
    periodo = b.dataset.per;
    el.querySelectorAll('[data-per]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
    montarGraf(el);
  });
  montarGraf(el);
}

// Detalhes da moeda escolhida (no lugar dos boxes do mercado)
function detalhe(id, w) {
  const c = M.coins[id] || {};
  const i = indicadores(id);
  if (!STABLES.has(id)) refreshSinais([id]);
  const num = (v, d = 1) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: d });
  const curto = v => v == null ? '—' : Number(v).toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 2 });
  const longe = (a, b) => a && b ? `${pctAbs((a / b - 1) * 100)} ${a < b ? 'abaixo' : 'acima'}` : '';
  const pos = posicoes(S.crypto_tx).ativos.find(p => p.coin_id === id);
  const carregando = !i && sinaisAtualizando() ? 'calculando…' : '';
  const kpi = (t, b, sm = '') => `<div class="kpi"><span>${t}</span><b>${b}</b>${sm ? `<small>${sm}</small>` : ''}</div>`;
  const faixa = c.altaUsd && c.baixaUsd && c.usd ? Math.min(100, Math.max(0, (c.usd - c.baixaUsd) / (c.altaUsd - c.baixaUsd || 1) * 100)) : null;
  const r = i?.rsi != null ? Math.round(i.rsi) : null;
  return `<div class="cr-sel">
    <span class="coin">${c.img ? `<img src="${h(c.img)}" alt="" width="24" height="24">` : '<i class="coin-ph"></i>'}<b>${h(w?.nome || c.nome || id)}</b><span class="muted">${h(w?.simbolo || c.simbolo || '')}${c.rank ? ` · #${c.rank} em valor de mercado` : ''}</span></span>
    <button class="btn" id="crSelX">Voltar ao mercado ✕</button>
  </div>
  <div class="kpis cr-det">
    ${kpi('Preço', usd(c.usd), `${preco(c.brl)} · ${pct(c.ch24)} 24h · ${pct(c.ch7)} 7d`)}
    ${kpi('Valor de mercado', compacto(c.mcap && M.dolar ? c.mcap / M.dolar : null, 'USD'), compacto(c.mcap))}
    ${kpi('Volume 24h', compacto(c.vol && M.dolar ? c.vol / M.dolar : null, 'USD'), c.vol && c.mcap ? `${num(c.vol / c.mcap * 100)}% do valor de mercado` : '')}
    <div class="kpi"><span>Faixa de 24h</span><b>${c.baixaUsd ? `${usd(c.baixaUsd)} – ${usd(c.altaUsd)}` : '—'}</b>${faixa != null ? `<small>preço atual em ${num(faixa, 0)}% da faixa (0% = mínima)</small><i class="cr-faixa" style="--v:${faixa.toFixed(1)}" aria-hidden="true"></i>` : ''}</div>
    ${kpi('Máxima histórica', c.athUsd ? usd(c.athUsd) : '—', c.ath != null ? `${pct(c.ath)} desde ${c.athData ? fmtDate(c.athData, { year: true }) : 'a máxima'}` : '')}
    ${kpi(i && !i.mm200 && i.mm50 ? 'Média de 50 dias' : 'Média de 200 dias', i?.mm200 ? usd(i.mm200) : i?.mm50 ? usd(i.mm50) : '—', i ? (i.mm200 ? [`preço ${longe(i.atual, i.mm200)}`, i.mm50 ? `de 50 dias: ${usd(i.mm50)} (${longe(i.atual, i.mm50)})` : ''] : [i.mm50 ? `preço ${longe(i.atual, i.mm50)}` : '', 'histórico curto para a de 200']).filter(Boolean).join(' · ') : carregando)}
    ${kpi('RSI de 14 dias', r ?? '—', r != null ? `${r < 30 ? 'sobrevendido (abaixo de 30)' : r > 70 ? 'sobrecomprado (acima de 70)' : 'zona neutra (30 a 70)'}${i.ch30 != null ? ` · 30 dias: ${pct(i.ch30)}` : ''}` : carregando)}
    ${pos ? kpi('Na sua carteira', reais(pos.valor), `${qtd(pos.qtd)} ${h(pos.simbolo)} · médio ${preco(pos.medio)} · ${pct(pos.resPct)}`)
      : kpi('Oferta circulante', curto(c.oferta), c.ofertaMax ? `${num(c.oferta / c.ofertaMax * 100)}% do máximo de ${curto(c.ofertaMax)}` : c.oferta ? 'sem limite máximo definido' : '')}
  </div>
  <section class="cr-graf" aria-label="Histórico de preço">
    <div class="cr-graf-head">
      <div class="seg seg-sm" role="group" aria-label="Período">${PERIODOS.map(([k, l]) => `<button class="${periodo === k ? 'on' : ''}" data-per="${k}" aria-pressed="${periodo === k}">${l}</button>`).join('')}</div>
      <span class="cr-graf-res small" id="crGrafRes"></span>
    </div>
    <div class="cr-graf-area" id="crGrafArea"></div>
  </section>`;
}

// ---------- Gráfico de preço da moeda escolhida ----------
// Desenhado já na largura real do contêiner; passar o mouse (ou o dedo, ou as setas) mostra preço e data de cada ponto.
const grafDados = new Map(); // `${id}|${dias}|${cur}` -> {pts, aprox} ou {erro, at}
const grafPedidos = new Set();
const fmtTempo = (t, dias) => new Intl.DateTimeFormat('pt-BR', { timeZone: CONFIG.TZ,
  ...(dias === '1' ? { hour: '2-digit', minute: '2-digit' } : dias === '7' ? { weekday: 'short', day: 'numeric' }
    : ['365', 'max'].includes(dias) ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' }) }).format(t).replace(/\./g, '').replace(/ de /g, ' ').replace(',', '');
const fmtDica = (t, dias) => new Intl.DateTimeFormat('pt-BR', { timeZone: CONFIG.TZ, day: 'numeric', month: 'short', year: 'numeric',
  ...(['1', '7', '30', '90'].includes(dias) ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(t).replace('.', '');

function ticksY(lo, hi, n = 4) {
  const bruto = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(bruto || 1));
  const passo = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= bruto) || mag;
  const out = []; for (let v = Math.ceil(lo / passo) * passo; v <= hi; v += passo) out.push(+v.toPrecision(12));
  return out;
}

function montarGraf(el) {
  const box = el.querySelector('#crGrafArea'), res = el.querySelector('#crGrafRes');
  if (!box || !sel) return;
  const cur = moedaV.cod().toLowerCase(), id = sel, dias = periodo, key = `${id}|${dias}|${cur}`;
  let d = grafDados.get(key);
  // erro ou reserva aproximada: tenta a CoinGecko de novo depois de 1 min; dado bom vale 10 min
  if (d && Date.now() - d.at > (d.erro || d.aprox ? 60e3 : 10 * 60e3)) { grafDados.delete(key); d = null; }
  if (!d) {
    box.innerHTML = '<p class="cr-graf-msg muted">Carregando o histórico…</p>';
    res.textContent = '';
    if (!grafPedidos.has(key)) {
      grafPedidos.add(key);
      historicoPreco(id, dias, cur).then(v => grafDados.set(key, v)).catch(e => {
        grafDados.set(key, { erro: e.message, limite: e.limite, at: Date.now() });
        // limite da CoinGecko: tenta sozinho de novo em 20 s, se a moeda e o período ainda estiverem na tela
        if (e.limite) setTimeout(() => { if (grafDados.get(key)?.erro) grafDados.delete(key); if (viewEl && naTela() && sel === id && periodo === dias) montarGraf(viewEl); }, 20000);
      })
        .finally(() => { grafPedidos.delete(key); if (viewEl && naTela() && sel === id && periodo === dias) montarGraf(viewEl); });
    }
    return;
  }
  if (d.erro || d.pts.length < 2) {
    box.innerHTML = `<p class="cr-graf-msg muted">${h(d.erro || 'Sem histórico de preço para esta moeda.')}${d.limite ? ' Tentando de novo em instantes…' : ''}${d.erro ? ' <button class="link-btn" id="crGrafDe">Tentar agora</button>' : ''}</p>`;
    res.textContent = '';
    box.querySelector('#crGrafDe')?.addEventListener('click', () => { grafDados.delete(key); montarGraf(el); });
    return;
  }
  desenharGraf(box, res, d, dias, cur.toUpperCase());
}

function desenharGraf(box, res, d, dias, CUR) {
  const pts = d.pts, n = pts.length;
  const vals = pts.map(p => p[1]), ini = vals[0], fim = vals[n - 1];
  let iMin = 0, iMax = 0; vals.forEach((v, i) => { if (v < vals[iMin]) iMin = i; if (v > vals[iMax]) iMax = i; });
  // Preço médio da carteira como linha de referência (convertido pelo dólar de hoje quando em US$)
  const pos = posicoes(S.crypto_tx).ativos.find(p => p.coin_id === sel);
  const medio = pos?.medio ? (CUR === 'USD' ? (M.dolar ? pos.medio / M.dolar : null) : pos.medio) : null;
  let lo = vals[iMin], hi = vals[iMax];
  const pad = (hi - lo) * .08 || hi * .02 || 1;
  lo -= pad; hi += pad;
  const medioDentro = medio != null && medio >= lo && medio <= hi;
  const fmt = v => preco(v, CUR);
  const ticks = ticksY(lo, hi);
  const W = Math.max(280, Math.floor(box.clientWidth || 640)), H = W < 500 ? 220 : 270;
  const m = { t: 12, r: 10, b: 26, l: Math.max(...ticks.map(t => fmt(t).length)) * 6.6 + 14 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, t0 = pts[0][0], t1 = pts[n - 1][0];
  const X = t => m.l + (t - t0) / (t1 - t0 || 1) * iw;
  const Y = v => m.t + (1 - (v - lo) / (hi - lo)) * ih;
  const sobe = fim >= ini, cor = sobe ? 'var(--up)' : 'var(--down)';
  const linha = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const nx = Math.max(2, Math.min(6, Math.floor(iw / 95)));
  const marcasX = Array.from({ length: nx }, (_, k) => t0 + (t1 - t0) * k / (nx - 1));
  const varPct = (fim / ini - 1) * 100;

  res.innerHTML = `${pct(varPct)} ${dias === 'max' ? 'desde o início' : `em ${PERIODOS.find(p => p[0] === dias)[1].replace('d', ' dias').replace('24h', '24 horas')}`}
    <span class="muted">· mín. ${fmt(vals[iMin])} · máx. ${fmt(vals[iMax])}${medio != null ? ` · seu preço médio ${CUR === 'USD' ? '≈ ' : ''}${fmt(medio)}${medioDentro ? '' : medio > hi ? ' (acima do gráfico)' : ' (abaixo do gráfico)'}` : ''}${d.aprox ? ' · aproximado: CoinGecko indisponível, usando o histórico diário' : ''}</span>`;
  box.innerHTML = `<svg class="cr-graf-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Preço de ${h(sel)} de ${fmtDica(t0, dias)} a ${fmtDica(t1, dias)}: de ${fmt(ini)} para ${fmt(fim)} (${pct(varPct, false)})">
    ${ticks.map(t => `<line class="fg-grade" x1="${m.l}" x2="${W - m.r}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="fg-eixo" x="${m.l - 8}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end">${h(fmt(t))}</text>`).join('')}
    ${marcasX.map((t, k) => `<text class="fg-eixo" x="${X(t).toFixed(1)}" y="${H - 6}" text-anchor="${k === 0 ? 'start' : k === nx - 1 ? 'end' : 'middle'}">${h(fmtTempo(t, dias))}</text>`).join('')}
    <path d="${linha}L${X(t1).toFixed(1)},${m.t + ih}L${m.l},${m.t + ih}Z" fill="${cor}" opacity=".1"/>
    <path d="${linha}" fill="none" stroke="${cor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${medioDentro ? `<line class="cr-graf-medio" x1="${m.l}" x2="${W - m.r}" y1="${Y(medio).toFixed(1)}" y2="${Y(medio).toFixed(1)}"/>
      <text class="cr-graf-medio-t" x="${W - m.r - 4}" y="${(Y(medio) - 5).toFixed(1)}" text-anchor="end">seu preço médio</text>` : ''}
    <g class="cr-graf-mira" hidden><line x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}"/><circle r="5" fill="${cor}"/></g>
    <rect class="cr-graf-hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" tabindex="0"
      aria-label="Percorrer o histórico: use as setas"/>
  </svg><div class="cr-graf-tip" hidden></div>`;

  const svg = box.querySelector('svg'), mira = svg.querySelector('.cr-graf-mira'), tip = box.querySelector('.cr-graf-tip'), hit = svg.querySelector('.cr-graf-hit');
  let atual = -1;
  const mostrar = i => {
    atual = i = Math.max(0, Math.min(n - 1, i));
    const [t, v] = pts[i], x = X(t), y = Y(v);
    mira.removeAttribute('hidden'); // em SVG, .hidden não existe: mexe no atributo
    mira.querySelector('line').setAttribute('x1', x); mira.querySelector('line').setAttribute('x2', x);
    mira.querySelector('circle').setAttribute('cx', x); mira.querySelector('circle').setAttribute('cy', y);
    const dif = medio ? (v / medio - 1) * 100 : null;
    tip.innerHTML = `<b>${fmt(v)}</b><span>${h(fmtDica(t, dias))}</span><span>${pct((v / ini - 1) * 100)} desde o início do período</span>${dif != null ? `<span>${pct(dif)} sobre o seu preço médio</span>` : ''}`;
    tip.hidden = false;
    const esc = box.clientWidth / W; // o SVG ocupa a largura do contêiner
    const tw = tip.offsetWidth;
    // ao lado da linha vertical (esquerda na metade direita), na altura do ponto, sem cobrir o ponto
    const px = x * esc, lado = px > box.clientWidth / 2 ? px - tw - 14 : px + 14;
    tip.style.left = Math.min(Math.max(lado, 0), box.clientWidth - tw) + 'px';
    tip.style.top = Math.min(Math.max(0, y * esc - tip.offsetHeight / 2), (m.t + ih) * esc - tip.offsetHeight) + 'px';
  };
  const esconder = () => { mira.setAttribute('hidden', ''); tip.hidden = true; atual = -1; };
  // ponto mais perto do mouse (busca binária no tempo)
  const perto = clientX => {
    const r = svg.getBoundingClientRect(), t = t0 + ((clientX - r.left) * W / r.width - m.l) / iw * (t1 - t0);
    let a = 0, b = n - 1;
    while (b - a > 1) { const c = (a + b) >> 1; if (pts[c][0] < t) a = c; else b = c; }
    return t - pts[a][0] < pts[b][0] - t ? a : b;
  };
  hit.onpointermove = e => mostrar(perto(e.clientX));
  hit.onpointerdown = e => mostrar(perto(e.clientX));
  hit.onpointerleave = e => { if (e.pointerType === 'mouse') esconder(); };
  hit.onblur = esconder;
  hit.onkeydown = e => {
    const passo = e.shiftKey ? Math.ceil(n / 20) : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); mostrar((atual < 0 ? n - 1 : atual) + (e.key === 'ArrowLeft' ? -passo : passo)); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); mostrar(e.key === 'Home' ? 0 : n - 1); }
    else if (e.key === 'Escape') esconder();
  };
}
let grafTm = null;
window.addEventListener('resize', () => { clearTimeout(grafTm); grafTm = setTimeout(() => viewEl?.isConnected && naTela() && montarGraf(viewEl), 150); });

// Arrastar pela alça (mouse e toque); salva a nova ordem ao soltar
function arrastar(ev, handle) {
  ev.preventDefault();
  const tr = handle.closest('tr'), tbody = tr.parentNode;
  handle.setPointerCapture(ev.pointerId);
  tr.classList.add('dragging');
  handle.onpointermove = e => {
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('tr[data-w]');
    if (!over || over === tr || over.parentNode !== tbody) return;
    const r = over.getBoundingClientRect();
    tbody.insertBefore(tr, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  };
  handle.onpointerup = handle.onpointercancel = async () => {
    handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
    tr.classList.remove('dragging');
    const ids = [...tbody.querySelectorAll('tr[data-w]')].map(r => r.dataset.w);
    const mud = ids.map((id, i) => [id, i]).filter(([id, i]) => S.crypto_watch.find(w => w.id === id)?.ordem !== i);
    if (!mud.length) return;
    try { await Promise.all(mud.map(([id, i]) => db.update('crypto_watch', id, { ordem: i }))); }
    catch (e) { toast('Não foi possível salvar a ordem: ' + e.message); }
    await load();
  };
}

function addMoeda() {
  modal('Adicionar moeda', `
    <label>Buscar por nome ou símbolo<input id="crQ" type="search" placeholder="ex.: Polygon, PEPE, LINK" autocomplete="off" autofocus></label>
    <ul class="cr-results" id="crRes" aria-live="polite"><li class="muted">Digite pelo menos 2 letras.</li></ul>`);
  const m = dlg();
  const inp = m.querySelector('#crQ'), res = m.querySelector('#crRes');
  let t, ultimo = [];
  const mostrar = () => {
    const tem = new Set(S.crypto_watch.map(w => w.coin_id));
    res.innerHTML = ultimo.length ? ultimo.map(c => `<li><img src="${h(c.img)}" alt="" width="22" height="22" loading="lazy">
      <span><b>${h(c.nome)}</b> <span class="muted">${h(c.simbolo)}${c.rank ? ` · #${c.rank}` : ''}</span></span>
      ${tem.has(c.id) ? '<span class="muted small">no quadro</span>' : `<button type="button" class="btn" data-add="${h(c.id)}">Adicionar</button>`}</li>`).join('')
      : '<li class="muted">Nada encontrado.</li>';
    res.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => {
      const c = ultimo.find(x => x.id === b.dataset.add);
      b.disabled = true;
      try {
        await save('crypto_watch', { coin_id: c.id, simbolo: c.simbolo, nome: c.nome, ordem: Math.max(-1, ...S.crypto_watch.map(w => w.ordem)) + 1, favorita: false });
        toast(`${c.simbolo} adicionada ao quadro`);
        refresh(true);
      } catch (e) { toast('Falha: ' + e.message); }
      mostrar();
    });
  };
  const ir = async () => {
    const v = inp.value.trim();
    if (v.length < 2) return;
    res.innerHTML = '<li class="muted">Buscando…</li>';
    try { ultimo = await buscar(v); mostrar(); } catch (e) { res.innerHTML = `<li class="late-lbl">${h(e.message)}</li>`; }
  };
  inp.oninput = () => { clearTimeout(t); t = setTimeout(ir, 400); };
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); ir(); } };
}

// ===============================================================
// SINAIS
// ===============================================================
let erroSinais = '', erroSinaisAt = 0;
let ajudaAberta = false;

// Quadro + carteira + bitcoin (para o clima do mercado)
const idsSinais = () => [...new Set(['bitcoin', ...posicoes(S.crypto_tx).ativos.map(p => p.coin_id), ...quadro().map(w => w.coin_id)])];
const redesenhar = () => { if (viewEl && naTela() && (aba === 'sinais' || (aba === 'mercado' && sel))) render(viewEl); };

// Na aba Mercado, com uma moeda escolhida, busca só o histórico dela
function refreshSinais(ids = idsSinais()) {
  if (sinaisAtualizando() || !sinaisVencidos(ids) || Date.now() - erroSinaisAt < 90e3) return;
  atualizarSinais(ids, redesenhar)
    .then(() => { erroSinais = ''; })
    .catch(e => { erroSinais = e.message; erroSinaisAt = Date.now(); })
    .finally(redesenhar);
}

const pctAbs = v => Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
const usd = v => preco(v, 'USD');

// Cada sinal: k = 'desc' (preço descontado), 'alta' (preço esticado) ou 'info'; t = o quê; d = os números
function sinaisMoeda(id, pos) {
  const c = M.coins[id] || {};
  const i = indicadores(id);
  const s = [];
  if (i) {
    if (i.mm200 != null) {
      const d = (i.atual / i.mm200 - 1) * 100;
      if (d < 0) s.push({ k: 'desc', t: 'Abaixo da média de 200 dias', d: `${pctAbs(d)} abaixo de ${usd(i.mm200)}, a média do último ano` });
      else if (d > 40) s.push({ k: 'alta', t: 'Muito acima da média de 200 dias', d: `${pctAbs(d)} acima de ${usd(i.mm200)}` });
      else s.push({ k: 'info', t: 'Acima da média de 200 dias', d: `${pctAbs(d)} acima de ${usd(i.mm200)}` });
    } else s.push({ k: 'info', t: 'Histórico curto', d: `só ${i.dias} dias de cotação; a média de 200 dias ainda não existe` });
    if (i.mm50 != null && i.atual < i.mm50) s.push({ k: 'desc', t: 'Abaixo da média de 50 dias', d: `${pctAbs((i.atual / i.mm50 - 1) * 100)} abaixo de ${usd(i.mm50)}` });
    if (i.rsi != null) {
      const r = Math.round(i.rsi);
      if (r < 30) s.push({ k: 'desc', t: `RSI em ${r}: sobrevendido`, d: 'abaixo de 30: nos últimos 14 dias as quedas pesaram bem mais que as altas' });
      else if (r > 70) s.push({ k: 'alta', t: `RSI em ${r}: sobrecomprado`, d: 'acima de 70: nos últimos 14 dias as altas pesaram bem mais que as quedas' });
      else s.push({ k: 'info', t: `RSI em ${r}`, d: r < 40 ? 'perto da zona de sobrevenda (abaixo de 30)' : r > 60 ? 'perto da zona de sobrecompra (acima de 70)' : 'zona neutra (entre 30 e 70)' });
    }
    const dd = (i.atual / i.max - 1) * 100;
    const ath = c.ath != null && c.ath < -1 ? `; ${pctAbs(c.ath)} abaixo da máxima histórica` : '';
    if (dd <= -30) s.push({ k: 'desc', t: 'Queda grande desde a máxima de 12 meses', d: `${pctAbs(dd)} abaixo de ${usd(i.max)}${ath}` });
    else if (dd > -5) s.push({ k: 'alta', t: 'Perto da máxima de 12 meses', d: `${dd < -.05 ? `${pctAbs(dd)} abaixo de` : 'na'} máxima de ${usd(i.max)}` });
    else s.push({ k: 'info', t: 'Distância da máxima de 12 meses', d: `${pctAbs(dd)} abaixo de ${usd(i.max)}${ath}` });
    if (i.mm50 != null && i.mm200 != null) {
      const sobe = i.mm50 > i.mm200;
      s.push(i.cruzou
        ? { k: 'info', t: sobe ? 'Cruz dourada recente' : 'Cruz da morte recente', d: `a média de 50 dias passou ${sobe ? 'para cima' : 'para baixo'} da de 200 há ${i.cruzou === 1 ? '1 dia' : `cerca de ${i.cruzou} dias`}` }
        : { k: 'info', t: sobe ? 'Médias apontando alta' : 'Médias apontando baixa', d: `média de 50 dias (${usd(i.mm50)}) ${sobe ? 'acima' : 'abaixo'} da de 200` });
    }
  }
  if (pos?.medio && c.brl) {
    const d = (c.brl / pos.medio - 1) * 100;
    s.push({ k: d < 0 ? 'desc' : 'info', t: d < 0 ? 'Abaixo do seu preço médio' : 'Acima do seu preço médio',
      d: `${preco(c.brl)} está ${pctAbs(d)} ${d < 0 ? 'abaixo' : 'acima'} do seu preço médio de ${preco(pos.medio)}` });
  }
  const ordem = { desc: 0, alta: 1, info: 2 };
  s.sort((a, b) => ordem[a.k] - ordem[b.k]);
  return { i, s, n: s.filter(x => x.k === 'desc').length, dd: i?.mm200 ? i.atual / i.mm200 : 9 };
}

function clima(moedas) {
  const out = [];
  const f = M.fng, fh = H.fng?.v || [];
  if (f) {
    const m7 = fh.length >= 7 ? Math.round(fh.slice(0, 7).reduce((a, b) => a + b, 0) / 7) : null;
    out.push({ k: f.v <= 25 ? 'desc' : f.v >= 75 ? 'alta' : 'info', t: `Medo e Ganância em ${f.v}: ${h(FNG_PT[f.c] || f.c)}`,
      d: [m7 != null ? `média de 7 dias ${m7}` : '', fh.length > 7 ? `nos últimos 30 dias, de ${Math.min(...fh)} a ${Math.max(...fh)}` : '',
        f.v <= 25 ? 'medo extremo é quando o índice fica em 25 ou menos' : f.v >= 75 ? 'ganância extrema é quando o índice fica em 75 ou mais' : ''].filter(Boolean).join('; ') });
  }
  const b = indicadores('bitcoin');
  if (b?.mm200) {
    const d = (b.atual / b.mm200 - 1) * 100;
    out.push({ k: d < 0 ? 'desc' : 'info', t: `Bitcoin ${d < 0 ? 'abaixo' : 'acima'} da média de 200 dias`, d: `${usd(b.atual)}, ${pctAbs(d)} ${d < 0 ? 'abaixo' : 'acima'} da média de ${usd(b.mm200)}` });
  }
  const comMedia = moedas.filter(x => x.i?.mm200 && !x.i.stable);
  if (comMedia.length > 1) {
    const abaixo = comMedia.filter(x => x.i.atual < x.i.mm200).length;
    out.push({ k: abaixo / comMedia.length >= .6 ? 'desc' : 'info', t: `${abaixo} de ${comMedia.length} moedas abaixo da média de 200 dias`, d: 'entre as do seu quadro e da sua carteira (sem as stablecoins)' });
  }
  const dom = M.global?.dom;
  if (dom != null) {
    const dias = Object.keys(H.dom).sort();
    const ref = dias.filter(d => Date.parse(today()) - Date.parse(d) >= 6 * 864e5).at(-1);
    const delta = ref ? dom - H.dom[ref] : null;
    out.push({ k: 'info', t: `Dominância do BTC em ${dom.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`,
      d: [delta != null && Math.abs(delta) >= .1 ? `${delta > 0 ? 'subiu' : 'caiu'} ${delta.toLocaleString('pt-BR', { maximumFractionDigits: 1, signDisplay: 'never' })} ponto${Math.abs(delta) >= 1.95 ? 's' : ''} desde ${fmtDate(ref)}` : '',
        dom >= 58 ? 'alta: o dinheiro está concentrado no bitcoin; nessas fases as outras moedas costumam render menos que ele'
          : dom <= 45 ? 'baixa: as outras moedas ganharam espaço em relação ao bitcoin' : 'faixa intermediária'].filter(Boolean).join('; ') });
  }
  const dv = H.dolar?.v || [];
  if (dv.length > 20) {
    const hoje = M.dolar || dv[0], antes = dv.at(-1), d = (hoje / antes - 1) * 100;
    out.push({ k: 'info', t: `Dólar ${Math.abs(d) < .5 ? 'estável' : d > 0 ? `subiu ${pctAbs(d)}` : `caiu ${pctAbs(d)}`} em 30 dias`,
      d: `${preco(hoje)} hoje, ${preco(antes)} um mês atrás${Math.abs(d) >= .5 ? `; em reais, as criptos ficaram ${d > 0 ? 'mais caras' : 'mais baratas'} mesmo sem mudar de preço em dólar` : ''}` });
  }
  return out;
}

const lista = itens => `<ul class="sg-list">${itens.map(x => `<li class="sg-${x.k}"><b>${x.t}</b><span>${x.d}</span></li>`).join('')}</ul>`;

function sinais() {
  refreshSinais();
  if (M.global?.dom != null) anotarDominancia(today(), M.global.dom);
  const pos = Object.fromEntries(posicoes(S.crypto_tx).ativos.map(p => [p.coin_id, p]));
  const nomes = new Map(conhecidas().map(c => [c.coin_id, c]));
  const moedas = idsSinais().filter(id => id !== 'bitcoin' || nomes.has('bitcoin'))
    .map(id => ({ id, w: nomes.get(id), c: M.coins[id], ...sinaisMoeda(id, pos[id]) }))
    .filter(x => !(x.i ? x.i.stable : pareceStable(x.id)));
  moedas.sort((a, b) => b.n - a.n || a.dd - b.dd);
  const cl = clima(moedas);
  const carregando = sinaisAtualizando();
  const comSinal = moedas.filter(x => x.n >= 3);

  return `
  <p class="sg-aviso">Indicadores calculados automaticamente com dados públicos. Mostram o que os números dizem hoje; <b>não são recomendação de investimento nem aconselhamento financeiro.</b></p>
  ${erroSinais ? `<p class="banner cr-banner">${h(erroSinais)} O histórico que faltou será buscado de novo daqui a pouco.</p>` : ''}
  <section class="block">
    <h2>Clima do mercado</h2>
    ${cl.length ? `<div class="sg-card sg-clima">${lista(cl)}</div>` : `<p class="empty">${carregando || atualizando() ? 'Carregando…' : 'Sem dados ainda: clique em Atualizar.'}</p>`}
    ${moedas.length ? `<p class="muted small sg-resumo">${comSinal.length ? `${comSinal.length === 1 ? 'Uma moeda tem' : `${comSinal.length} moedas têm`} 3 ou mais sinais de preço descontado: ${comSinal.map(x => `<b>${h(x.w?.simbolo || x.c?.simbolo || x.id)}</b>`).join(', ')}.` : 'Nenhuma moeda tem 3 ou mais sinais de preço descontado agora.'}</p>` : ''}
  </section>
  <section class="block">
    <h2>Suas moedas <span class="count">${moedas.length}</span></h2>
    ${moedas.length ? `<div class="sg-coins">${moedas.map(x => {
      const c = x.c || {}, nome = x.w?.nome || c.nome || x.id, simb = x.w?.simbolo || c.simbolo || '';
      return `<article class="sg-card">
        <header><span class="coin">${c.img ? `<img src="${h(c.img)}" alt="" width="20" height="20" loading="lazy">` : '<i class="coin-ph"></i>'}<b>${h(nome)}</b><span class="muted">${h(simb)}</span>${pos[x.id] ? '<span class="tag sg-tag">na carteira</span>' : ''}</span>
          <span class="sg-px">${usd(c.usd)}<small>${preco(c.brl)} · ${pct(c.ch24)} 24h</small></span></header>
        <div class="sg-n ${x.n ? 'on' : ''}">${x.n ? `${x.n} ${x.n === 1 ? 'sinal' : 'sinais'} de preço descontado` : !x.i && carregando ? 'Calculando…' : 'Nenhum sinal de preço descontado'}</div>
        ${x.s.length ? lista(x.s) : `<p class="muted small">${carregando ? 'Carregando o histórico…' : 'Sem histórico de preços para esta moeda.'}</p>`}
      </article>`;
    }).join('')}</div>` : '<p class="empty">Adicione moedas no quadro da aba Mercado ou lançamentos na Carteira.</p>'}
  </section>
  <details class="sg-help" id="sgHelp" ${ajudaAberta ? 'open' : ''}><summary>Como ler os sinais</summary>
    <dl>
      <dt><i class="sg-dot sg-desc"></i>Preço descontado</dt><dd>Conta quantos destes aparecem: abaixo da média de 200 dias, abaixo da média de 50 dias, RSI abaixo de 30, queda de 30% ou mais desde a máxima de 12 meses e cotação abaixo do seu preço médio.</dd>
      <dt><i class="sg-dot sg-alta"></i>Preço esticado</dt><dd>O contrário: RSI acima de 70, preço mais de 40% acima da média de 200 dias ou a menos de 5% da máxima de 12 meses.</dd>
      <dt>Médias de 50 e 200 dias</dt><dd>Média do preço de fechamento dos últimos 50 e 200 dias. Muita gente usa a de 200 para separar tendência de alta (preço acima) de tendência de baixa (preço abaixo). Quando a de 50 cruza a de 200 para cima, chama-se cruz dourada; para baixo, cruz da morte.</dd>
      <dt>RSI (índice de força relativa)</dt><dd>De 0 a 100, compara o tamanho das altas e das quedas dos últimos 14 dias. Abaixo de 30 indica sobrevenda; acima de 70, sobrecompra.</dd>
      <dt>Medo e Ganância</dt><dd>Índice do alternative.me, de 0 a 100, que junta volatilidade, volume, redes sociais e dominância do bitcoin. Mede o humor do mercado, não o preço futuro.</dd>
      <dt>Dominância do BTC</dt><dd>Fatia do bitcoin no valor de mercado de todas as criptomoedas.</dd>
    </dl>
    <p class="small">Nenhum desses números prevê o preço: uma moeda pode continuar abaixo das médias ou cair mais por muito tempo.</p>
  </details>
  <p class="muted small">Médias, RSI e máxima de 12 meses usam o fechamento diário em dólar (CoinGecko), guardado por 12 horas neste navegador; o preço médio é em reais. Dados: CoinGecko, alternative.me e AwesomeAPI.${carregando && progresso.total ? ` Carregando histórico: ${progresso.feitas} de ${progresso.total}${progresso.esperando ? ' (esperando o limite de consultas da CoinGecko, cerca de 1 minuto)' : ''}…` : ''}</p>`;
}
// Sem histórico ainda: reconhece stablecoins pela cotação para não mostrar cartão vazio
function pareceStable(id) {
  const c = M.coins[id];
  return STABLES.has(id) || (c?.usd > .97 && c.usd < 1.03 && Math.abs(c.ch7 ?? 9) < 1.5);
}

function bindSinais(el) {
  el.querySelector('#sgHelp')?.addEventListener('toggle', e => { ajudaAberta = e.target.open; });
}

// ===============================================================
// CARTEIRA
// ===============================================================
// Bloco das carteiras da blockchain (uma linha por moeda, somando as redes)
const REDES = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'OP Mainnet', polygon: 'Polygon', bsc: 'BNB Chain', avalanche: 'Avalanche' };
function blocoOnchain() {
  if (!OC.carteiras.length) return '';
  const nomeCart = id => OC.carteiras.find(c => c.id === id)?.nome || 'Carteira';
  const g = new Map();
  for (const s of OC.saldos) {
    const k = s.coin_id || `${s.chain}:${s.token}`;
    const x = g.get(k) || g.set(k, { coin_id: s.coin_id, simbolo: s.simbolo, nome: s.nome, qtd: 0, onde: [], usd: s.preco_usd }).get(k);
    x.qtd += Number(s.quantidade); x.onde.push(`${nomeCart(s.carteira_id)} · ${REDES[s.chain] || s.chain}`);
  }
  const linhas = [...g.values()].map(x => {
    const c = x.coin_id ? M.coins[x.coin_id] : null;
    const p = c?.brl ?? (x.usd && M.dolar ? x.usd * M.dolar : null);
    return { ...x, c, p, valor: p != null ? x.qtd * p : null };
  }).sort((a, b) => (b.valor || 0) - (a.valor || 0));
  const total = linhas.reduce((t, x) => t + (x.valor || 0), 0);
  const lido = OC.carteiras.map(c => c.lido_em).filter(Boolean).sort().at(-1);
  return `<section class="block">
    <h2>Carteiras na blockchain <span class="count">${linhas.length}</span></h2>
    <p class="muted small">${OC.carteiras.map(c => h(c.nome || 'Carteira')).join(', ')} · lidas pelo endereço público${lido ? `, última leitura ${fmtDate(lido.slice(0, 10))}` : ' (ainda não lidas)'}.
      Somadas aos lançamentos no <a href="#/financas?painel">Painel de Finanças</a>; para preço médio e resultado, lance as compras aqui com a corretora da carteira.</p>
    ${linhas.length ? `<div class="kpis cr-oc-kpis"><div class="kpi big"><span>Valor nas carteiras</span><b>${reais(total)}</b><small>${moedaV.emDolar() ? brl(total) : M.dolar ? 'US$ ' + (total / M.dolar).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : ''}</small></div></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Moeda</th><th class="num">Quantidade</th><th class="num">Preço atual</th><th class="num">Valor</th><th class="num">24h</th><th>Onde</th></tr></thead>
      <tbody>${linhas.map(x => `<tr>
        <td><span class="coin">${x.c?.img ? `<img src="${h(x.c.img)}" alt="" width="20" height="20" loading="lazy">` : '<i class="coin-ph"></i>'}<b>${h(x.c?.nome || x.nome || x.simbolo)}</b><span class="muted">${h(x.c?.simbolo || x.simbolo)}</span></span></td>
        <td class="num">${qtd(x.qtd)}</td><td class="num">${precoV(x.p)}</td><td class="num"><b>${reais(x.valor)}</b></td><td class="num">${pct(x.c?.ch24)}</td>
        <td class="muted small">${h([...new Set(x.onde)].join(', '))}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="empty">Nenhum saldo encontrado ainda. Em Finanças, clique em Atualizar.</p>'}
    <p class="small"><a href="#/financas?contas">Gerenciar carteiras</a></p>
  </section>`;
}

function carteira() {
  const { lista, ativos, tot, vendas } = posicoes(S.crypto_tx);
  if (!S.crypto_tx.length) return `${blocoOnchain()}
    <section class="block"><p class="empty">Nenhum lançamento ainda. Registre compras, vendas, transferências e recebimentos em “Novo lançamento”, ou traga o histórico das corretoras por CSV.</p>
    ${csvBtns()}</section>`;
  const fechadas = lista.filter(p => p.qtd === 0 && p.realizado);
  const txs = [...S.crypto_tx].filter(t => !filtro || t.coin_id === filtro)
    .sort((a, b) => b.data.localeCompare(a.data) || (b.created_at || '').localeCompare(a.created_at || ''));
  const semCot = ativos.filter(p => !p.cot);

  return `${blocoOnchain()}
  ${OC.carteiras.length ? '<h2 class="cr-sub">Lançamentos (corretoras e compras)</h2>' : ''}
  <div class="kpis">
    <div class="kpi big"><span>Valor atual</span><b>${reais(tot.valor)}</b><small>${moedaV.emDolar() ? brl(tot.valor) : M.dolar ? 'US$ ' + (tot.valor / M.dolar).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : ''}</small></div>
    <div class="kpi"><span>Custo total</span><b>${reais(tot.custo)}</b></div>
    <div class="kpi"><span>Resultado</span><b class="${tot.resultado >= 0 ? 'up' : 'down'}">${reais(tot.resultado)}</b><small>${pct(tot.resPct)}</small></div>
    <div class="kpi"><span>Variação 24h</span><b class="${tot.valor - tot.ontem >= 0 ? 'up' : 'down'}">${reais(tot.valor - tot.ontem)}</b><small>${pct(tot.ch24)}</small></div>
  </div>
  ${semCot.length ? `<p class="banner cr-banner">Sem cotação para ${semCot.map(p => h(p.simbolo)).join(', ')}: ${M.at ? 'clique em Atualizar' : 'aguardando as cotações'}. Esses valores ficam de fora dos totais.</p>` : ''}

  <section class="block">
    <h2>Posições <span class="count">${ativos.length}</span></h2>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Moeda</th><th class="num">Quantidade</th><th class="num">Preço médio</th><th class="num">Custo total</th><th class="num">Preço atual</th><th class="num">Valor atual</th><th class="num">Resultado</th><th class="num">%</th><th class="num">24h</th></tr></thead>
      <tbody>${ativos.sort((a, b) => (b.valor || 0) - (a.valor || 0)).map(p => `<tr>
        <td><span class="coin">${p.cot?.img ? `<img src="${h(p.cot.img)}" alt="" width="20" height="20" loading="lazy">` : '<i class="coin-ph"></i>'}<b>${h(p.nome || p.simbolo)}</b><span class="muted">${h(p.simbolo)}</span>${p.aviso ? ' <span class="late-lbl small" title="Há vendas/transferências maiores que o saldo: falta histórico de compras">⚠</span>' : ''}</span></td>
        <td class="num">${qtd(p.qtd)}</td><td class="num">${precoV(p.medio)}</td><td class="num">${reais(p.custo)}</td>
        <td class="num">${precoV(p.cot?.brl)}</td><td class="num"><b>${reais(p.valor)}</b></td>
        <td class="num ${p.resultado >= 0 ? 'up' : 'down'}">${reais(p.resultado)}</td><td class="num">${pct(p.resPct)}</td><td class="num">${pct(p.cot?.ch24)}</td></tr>`).join('')}
      </tbody>
      ${fechadas.length ? `<tfoot><tr><td colspan="9" class="muted small">Posições zeradas: ${fechadas.map(p => `${h(p.simbolo)} (resultado ${reais(p.realizado)})`).join(', ')}</td></tr></tfoot>` : ''}
    </table></div>
    ${tot.realizado ? `<p class="muted small">Lucro/prejuízo já realizado em vendas: <b class="${tot.realizado >= 0 ? 'up' : 'down'}">${reais(tot.realizado)}</b> (fora do resultado acima, que é sobre o que você ainda tem).</p>` : ''}
  </section>

  <div class="cr-cols">
    <section class="block">
      <h2>Evolução do patrimônio</h2>
      ${grafico()}
    </section>
    <section class="block">
      <h2>Alocação <span class="seg seg-sm">${[['moeda', 'Por moeda'], ['corretora', 'Por corretora']].map(([k, l]) => `<button class="${alocPor === k ? 'on' : ''}" data-aloc="${k}">${l}</button>`).join('')}</span></h2>
      ${alocacao(ativos)}
    </section>
  </div>

  ${programadas()}

  <section class="block">
    <h2>Lançamentos <span class="count">${S.crypto_tx.length}</span>
      <select class="cr-filter" id="crFiltro" aria-label="Filtrar por moeda"><option value="">Todas as moedas</option>${conhecidas().filter(c => S.crypto_tx.some(t => t.coin_id === c.coin_id)).map(c => `<option value="${h(c.coin_id)}" ${filtro === c.coin_id ? 'selected' : ''}>${h(c.simbolo)}</option>`).join('')}</select></h2>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Data</th><th>Tipo</th><th>Moeda</th><th class="num">Quantidade</th><th class="num">Preço unit.</th><th class="num">Taxa</th><th class="num">Total</th><th>Corretora / carteira</th><th>Obs.</th></tr></thead>
      <tbody>${txs.map(t => `<tr data-tx="${t.id}" tabindex="0">
        <td>${fmtDate(t.data, { year: true })}</td><td><span class="tipo t-${t.tipo}">${TIPOS[t.tipo]}</span></td><td><b>${h(t.simbolo)}</b>${t.fin_tx_id ? ' <span class="chip-static" title="Compra programada lida do extrato do banco; quantidade estimada pela cotação do dia">programada</span>' : ''}</td>
        <td class="num">${t.fin_tx_id ? '≈ ' : ''}${qtd(t.quantidade)}</td><td class="num">${t.tipo === 'transferencia' ? '' : preco(+t.preco_brl)}</td><td class="num">${+t.taxa_brl ? reais(t.taxa_brl) : ''}</td>
        <td class="num">${t.tipo === 'transferencia' ? '' : reais(t.quantidade * t.preco_brl)}</td>
        <td>${h(t.corretora || '')}${t.tipo === 'transferencia' ? ` → ${h(t.destino || '?')}` : ''}</td><td class="muted cr-obs">${h(t.obs || '')}</td></tr>`).join('')}
      </tbody></table></div>
    ${csvBtns()}
  </section>

  ${vendasMes(vendas)}`;
}

// Compras programadas (crypto_plano): o extrato do banco só diz "Compra de criptomoedas" e o valor; o plano diz a moeda.
// A leitura do banco (fin-sync) lança cada débito como compra, com a quantidade pela cotação do dia.
function programadas() {
  const pl = S.crypto_plano || [];
  const lidas = S.crypto_tx.filter(t => t.fin_tx_id);
  const porSemana = pl.filter(p => p.ativo).reduce((s, p) => s + +p.valor, 0);
  return `<section class="block">
    <h2>Compras programadas${porSemana ? ` <span class="count">${reais(porSemana)} por compra</span>` : ''}</h2>
    <p class="muted small">O banco só informa "Compra de criptomoedas" e o valor. Aqui você diz qual moeda corresponde a cada valor; duas vezes por dia o Hub lê o extrato e lança cada compra na carteira, com a quantidade estimada pela cotação do dia (a real é um pouco menor por causa da diferença de preço cobrada pela corretora; lance o saldo do app de vez em quando para acertar).</p>
    ${pl.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Moeda</th><th class="num">Valor</th><th>Corretora</th><th>Desde</th><th class="num">Lançadas</th><th></th></tr></thead><tbody>
      ${pl.map(p => `<tr class="${p.ativo ? '' : 'fn-fora'}"><td><b>${h(p.simbolo)}</b> <span class="muted">${h(p.nome || '')}</span></td><td class="num">${reais(+p.valor)}</td><td>${h(p.corretora || '')}</td>
        <td>${fmtDate(p.inicio, { year: true })}</td><td class="num">${lidas.filter(t => t.coin_id === p.coin_id && t.data >= p.inicio).length}</td>
        <td class="num"><button class="mini" data-plano="${h(p.id)}">Editar</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="empty">Nenhuma compra programada cadastrada.</p>'}
    <div class="row-btns"><button class="btn" id="crPlanoNovo">Adicionar moeda ao plano</button></div>
  </section>`;
}
function planoForm(p = {}) {
  const moedas = conhecidas();
  p = { corretora: 'Nubank', inicio: today(), ativo: true, ...p };
  modal(p.id ? 'Compra programada' : 'Nova compra programada', `
    <div class="grid2">
      <label>Moeda<select name="coin_id" required>${moedas.map(c => `<option value="${h(c.coin_id)}" ${c.coin_id === p.coin_id ? 'selected' : ''}>${h(c.simbolo)} · ${h(c.nome)}</option>`).join('')}</select></label>
      <label>Valor de cada compra (R$)<input name="valor" inputmode="decimal" value="${h(p.valor != null ? String(p.valor).replace('.', ',') : '')}" required></label>
      <label>Corretora<input name="corretora" value="${h(p.corretora)}" required></label>
      <label>Valer a partir de<input name="inicio" type="date" value="${h(p.inicio)}" required></label>
      <label class="span2 chk"><input type="checkbox" name="ativo" ${p.ativo ? 'checked' : ''}> Ativa</label>
    </div>
    <p class="muted small">Compras do extrato antes dessa data não entram (use quando o saldo dessa moeda já foi lançado à mão até ali). Para pausar sem perder o histórico, desmarque "Ativa".</p>`, {
    extra: p.id ? '<button type="button" class="btn danger" id="crPlanoDel">Excluir</button>' : '',
    onSubmit: async f => {
      const c = moedas.find(x => x.coin_id === f.coin_id), valor = lerNumero(f.valor);
      if (!c) throw new Error('Escolha a moeda.');
      if (!(valor > 0)) throw new Error('Informe o valor de cada compra.');
      await save('crypto_plano', { coin_id: c.coin_id, simbolo: c.simbolo, nome: c.nome, valor, corretora: f.corretora.trim(), inicio: f.inicio, ativo: !!f.ativo }, p.id);
      toast('Compra programada salva');
    },
  });
  dlg().querySelector('#crPlanoDel')?.addEventListener('click', async ev => {
    if (!confirmInline(ev.target)) return;
    await del('crypto_plano', p.id); closeModal(); toast('Compra programada excluída');
  });
}

const csvBtns = () => `<div class="row-btns">
  <button class="btn" id="crExp" ${S.crypto_tx.length ? '' : 'hidden'}>Exportar CSV</button>
  <label class="btn">Importar CSV<input type="file" id="crImp" accept=".csv,text/csv" hidden></label>
  <button class="btn" id="crModelo">Baixar modelo</button></div>
  <p class="muted small">Formato: ${CSV_COLS.join('; ')}. Aceita “;” ou “,” como separador, data em AAAA-MM-DD ou DD/MM/AAAA e tipo compra/venda/transferencia/recebimento (ou buy/sell). Se faltar <code>coin_id</code>, a moeda é achada pelo símbolo.</p>`;

function alocacao(ativos) {
  const tot = ativos.reduce((s, p) => s + (p.valor || 0), 0);
  if (!tot) return '<p class="empty">Aparece quando houver cotações das suas moedas.</p>';
  let itens;
  if (alocPor === 'moeda') itens = ativos.map(p => ({ nome: p.simbolo, v: p.valor || 0 }));
  else {
    const g = {};
    for (const p of ativos) for (const [c, q] of Object.entries(p.corretoras)) if (q > 1e-10 && p.cot) g[c] = (g[c] || 0) + q * p.cot.brl;
    itens = Object.entries(g).map(([nome, v]) => ({ nome, v }));
  }
  itens.sort((a, b) => b.v - a.v);
  if (itens.length > 8) { const r = itens.splice(7); itens.push({ nome: `Outras (${r.length})`, v: r.reduce((s, x) => s + x.v, 0) }); }
  const max = itens[0].v;
  return `<div class="alloc">${itens.map(x => `<div class="al-row" title="${h(x.nome)}: ${reais(x.v)}">
    <span class="al-name">${h(x.nome)}</span><span class="al-track"><i style="width:${(x.v / max * 100).toFixed(1)}%"></i></span>
    <span class="al-val"><b>${(x.v / tot * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</b> ${compacto(x.v)}</span></div>`).join('')}</div>`;
}

// Linha do valor da carteira (e do custo, tracejado) a partir dos snapshots diários
function grafico() {
  const pts = [...S.crypto_snap].sort((a, b) => a.dia.localeCompare(b.dia));
  if (pts.length < 2) return `<p class="empty">O Hub guarda o valor da carteira uma vez por dia, sempre que esta tela é aberta. O gráfico aparece a partir do segundo dia${pts.length ? ` (primeiro registro: ${fmtDate(pts[0].dia, { year: true })}, ${reais(pts[0].valor_brl)})` : ''}.</p>`;
  const W = 640, H = 220, L = 8, R = 8, T = 14, B = 26;
  const t0 = Date.parse(pts[0].dia), t1 = Date.parse(pts.at(-1).dia);
  const vs = pts.flatMap(p => [+p.valor_brl, +p.custo_brl]);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = (hi - lo) * .1 || hi * .05 || 1; lo -= pad; hi += pad;
  const x = d => L + (Date.parse(d) - t0) / (t1 - t0 || 1) * (W - L - R);
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const linha = k => pts.map(p => `${x(p.dia).toFixed(1)},${y(+p[k]).toFixed(1)}`).join(' ');
  const ticks = [lo + (hi - lo) * .2, lo + (hi - lo) * .5, lo + (hi - lo) * .8];
  const meio = pts[Math.floor(pts.length / 2)];
  return `<div class="lc">
    <div class="lc-legend"><span><i class="lc-k v"></i>Valor da carteira</span><span><i class="lc-k c"></i>Custo</span></div>
    <div class="lc-box">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="lc-svg" role="img" aria-label="Evolução do valor da carteira de ${fmtDate(pts[0].dia, { year: true })} a ${fmtDate(pts.at(-1).dia, { year: true })}">
        ${ticks.map(v => `<line class="lc-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}
        <polyline class="lc-c" points="${linha('custo_brl')}" vector-effect="non-scaling-stroke"/>
        <polyline class="lc-v" points="${linha('valor_brl')}" vector-effect="non-scaling-stroke"/>
        <line class="lc-x" id="lcX" y1="${T}" y2="${H - B}" x1="-10" x2="-10" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="lc-ticks">${ticks.map(v => `<span style="top:${(y(v) / H * 100).toFixed(1)}%">${compacto(v)}</span>`).join('')}</div>
      <div class="lc-dates"><span>${fmtDate(pts[0].dia, { year: true })}</span>${pts.length > 4 ? `<span>${fmtDate(meio.dia, { year: true })}</span>` : ''}<span>${fmtDate(pts.at(-1).dia, { year: true })}</span></div>
      <div class="lc-tip" id="lcTip" hidden></div>
      <div class="lc-hit" id="lcHit" data-w="${W}" data-l="${L}" data-r="${R}"></div>
    </div></div>`;
}

function bindGrafico(el) {
  const hit = el.querySelector('#lcHit');
  if (!hit) return;
  const pts = [...S.crypto_snap].sort((a, b) => a.dia.localeCompare(b.dia));
  const tip = el.querySelector('#lcTip'), xl = el.querySelector('#lcX');
  const W = +hit.dataset.w, L = +hit.dataset.l, R = +hit.dataset.r;
  const t0 = Date.parse(pts[0].dia), t1 = Date.parse(pts.at(-1).dia);
  hit.onpointermove = e => {
    const r = hit.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width * W;
    const t = t0 + (fx - L) / (W - L - R) * (t1 - t0);
    const p = pts.reduce((a, b) => Math.abs(Date.parse(b.dia) - t) < Math.abs(Date.parse(a.dia) - t) ? b : a);
    const px = L + (Date.parse(p.dia) - t0) / (t1 - t0 || 1) * (W - L - R);
    xl.setAttribute('x1', px); xl.setAttribute('x2', px);
    const res = p.valor_brl - p.custo_brl;
    tip.innerHTML = `<b>${fmtDate(p.dia, { year: true })}</b><span>Valor ${reais(p.valor_brl)}</span><span>Custo ${reais(p.custo_brl)}</span><span class="${res >= 0 ? 'up' : 'down'}">Resultado ${reais(res)}</span>`;
    tip.hidden = false;
    const left = px / W * r.width;
    tip.style.left = Math.min(Math.max(left, 70), r.width - 70) + 'px';
  };
  hit.onpointerleave = () => { tip.hidden = true; xl.setAttribute('x1', -10); xl.setAttribute('x2', -10); };
}

function vendasMes(vendas) {
  if (!vendas.length) return '';
  return `<section class="block">
    <h2>Vendas por mês</h2>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Mês</th><th class="num">Vendas</th><th class="num">Total vendido</th><th class="num">Resultado</th><th>Corretoras</th><th>Situação</th></tr></thead>
      <tbody>${vendas.map(v => {
        const [y, m] = v.mes.split('-');
        const acima = v.total > LIMITE_ISENCAO;
        return `<tr><td>${mesNome(+m - 1)} ${y}</td><td class="num">${v.n}</td><td class="num"><b>${brl(v.total)}</b></td>
          <td class="num ${v.resultado >= 0 ? 'up' : 'down'}">${brl(v.resultado)}</td>
          <td class="small">${Object.entries(v.porCorretora).map(([c, x]) => `${h(c)}: ${compacto(x)}`).join(' · ')}</td>
          <td>${acima ? `<span class="tag" style="--c:var(--late)">Acima de ${compacto(LIMITE_ISENCAO)}</span>${v.resultado > 0 ? ' <span class="small">ganho tributável, DARF até o fim do mês seguinte</span>' : ''}`
            : v.total > LIMITE_DECLARACAO ? `<span class="tag" style="--c:var(--argila)">Acima de ${compacto(LIMITE_DECLARACAO)}</span> <span class="small">verifique a declaração mensal</span>`
            : '<span class="tag" style="--c:var(--alug)">Dentro da isenção</span>'}</td></tr>`;
      }).join('')}</tbody></table></div>
    <p class="muted small">Referência (sempre em reais): vendas de até ${brl(LIMITE_ISENCAO)} no mês têm o ganho isento de IR; acima disso, o ganho é tributado e o DARF vence no último dia útil do mês seguinte. Operações em corretoras estrangeiras ou entre carteiras próprias acima de ${brl(LIMITE_DECLARACAO)} no mês podem exigir declaração mensal à Receita. As regras mudam: confirme com seu contador.</p>
  </section>`;
}

function bindCarteira(el) {
  el.querySelector('#crPlanoNovo')?.addEventListener('click', () => planoForm());
  el.querySelectorAll('[data-plano]').forEach(b => b.onclick = () => planoForm((S.crypto_plano || []).find(p => p.id === b.dataset.plano)));
  el.querySelectorAll('[data-aloc]').forEach(b => b.onclick = () => { alocPor = b.dataset.aloc; render(el); });
  el.querySelector('#crFiltro')?.addEventListener('change', e => { filtro = e.target.value; render(el); });
  el.querySelectorAll('[data-tx]').forEach(r => {
    const go = () => txForm(S.crypto_tx.find(t => t.id === r.dataset.tx));
    r.onclick = go; r.onkeydown = e => e.key === 'Enter' && go();
  });
  bindGrafico(el);
  el.querySelector('#crExp')?.addEventListener('click', () => baixar(`hub-cripto-${today()}.csv`, paraCsv(S.crypto_tx)));
  el.querySelector('#crModelo').onclick = () => baixar('modelo-cripto.csv', paraCsv([
    { data: '2025-03-10', tipo: 'compra', simbolo: 'BTC', coin_id: 'bitcoin', quantidade: 0.0125, preco_brl: 480000, taxa_brl: 6, corretora: 'Mercado Bitcoin', obs: 'exemplo' },
    { data: '2025-04-02', tipo: 'transferencia', simbolo: 'BTC', coin_id: 'bitcoin', quantidade: 0.01, preco_brl: 0, taxa_brl: 3.5, corretora: 'Mercado Bitcoin', destino: 'Ledger', obs: '' },
  ]));
  el.querySelector('#crImp').onchange = async ev => {
    const f = ev.target.files[0]; ev.target.value = '';
    if (f) importar(await f.text());
  };
}

function baixar(nome, txt) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([txt], { type: 'text/csv;charset=utf-8' })), download: nome });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importar(txt) {
  const { linhas, erros, simbolos } = interpretarCsv(txt);
  toast('Lendo o arquivo…');
  const map = simbolos.size ? await resolverSimbolos([...simbolos], conhecidas()) : {};
  const naoAchou = [...simbolos].filter(s => !map[s]);
  const nomes = Object.fromEntries(conhecidas().map(c => [c.coin_id, c.nome]));
  const prontas = linhas.filter(l => l.coin_id || map[l.simbolo]).map(l => {
    const coin_id = l.coin_id || map[l.simbolo].coin_id;
    const c = M.coins[coin_id];
    return { ...l, coin_id, simbolo: l.simbolo || c?.simbolo || coin_id.toUpperCase(), nome: map[l.simbolo]?.nome || nomes[coin_id] || c?.nome || l.simbolo };
  });
  const chave = t => [t.data, t.tipo, t.coin_id, (+t.quantidade).toPrecision(10), (+t.preco_brl || 0).toPrecision(8)].join('|');
  const existentes = new Set(S.crypto_tx.map(chave));
  const novas = prontas.filter(t => !existentes.has(chave(t)));
  const dup = prontas.length - novas.length;
  modal('Importar lançamentos', `
    <p><b>${novas.length}</b> lançamento${novas.length === 1 ? '' : 's'} pronto${novas.length === 1 ? '' : 's'} para importar${dup ? `; ${dup} já existia${dup === 1 ? '' : 'm'} e ser${dup === 1 ? 'á' : 'ão'} ignorado${dup === 1 ? '' : 's'}` : ''}.</p>
    ${novas.length ? `<div class="quotes">${novas.slice(0, 6).map(t => `<div>${fmtDate(t.data, { year: true })} · ${TIPOS[t.tipo]} · ${qtd(t.quantidade)} ${h(t.simbolo)} <span class="muted">(${h(t.coin_id)})</span>${t.tipo !== 'transferencia' ? ` a ${preco(t.preco_brl)}` : ''}</div>`).join('')}${novas.length > 6 ? `<div class="muted">e mais ${novas.length - 6}…</div>` : ''}</div>` : ''}
    ${naoAchou.length ? `<p class="late-lbl">Moeda não encontrada: ${naoAchou.map(h).join(', ')}. Essas linhas ficam de fora; preencha a coluna coin_id.</p>` : ''}
    ${erros.length ? `<div><b class="late-lbl">${erros.length} linha${erros.length === 1 ? '' : 's'} com problema</b><ul class="small">${erros.slice(0, 8).map(e => `<li>${h(e)}</li>`).join('')}${erros.length > 8 ? '<li>…</li>' : ''}</ul></div>` : ''}
    <p class="muted small">Confira se os preços estão em reais por unidade. Exportações das corretoras em dólar ou por par (ex.: BTC/USDT) precisam ser convertidas antes.</p>`, {
    submit: `Importar ${novas.length}`,
    onSubmit: novas.length ? async () => {
      await db.insertMany('crypto_tx', novas);
      await load();
      toast(`${novas.length} lançamentos importados`);
      refresh(true);
    } : null,
  });
}

// ---------- Lançamento ----------
function txForm(t = {}, preset = {}) {
  t = { tipo: 'compra', data: today(), taxa_brl: 0, ...preset, ...t };
  const moedas = conhecidas();
  if (t.coin_id && !moedas.some(c => c.coin_id === t.coin_id)) moedas.push({ coin_id: t.coin_id, simbolo: t.simbolo, nome: t.nome });
  const usadas = [...new Set([...CORRETORAS, ...S.crypto_tx.flatMap(x => [x.corretora, x.destino]).filter(Boolean)])];
  const p0 = t.preco_brl ?? M.coins[t.coin_id]?.brl ?? '';
  modal(t.id ? 'Lançamento' : 'Novo lançamento', `
    <datalist id="dlCorr">${usadas.map(c => `<option value="${h(c)}">`).join('')}</datalist>
    <div class="grid2">
      <label>Moeda<select name="coin_id" id="txMoeda" required>${moedas.length ? '' : '<option value="">Adicione moedas no quadro</option>'}${moedas.map(c => `<option value="${h(c.coin_id)}" ${c.coin_id === t.coin_id ? 'selected' : ''}>${h(c.simbolo)} · ${h(c.nome)}</option>`).join('')}</select></label>
      <label>Tipo<select name="tipo" id="txTipo">${Object.entries(TIPOS).map(([k, l]) => `<option value="${k}" ${k === t.tipo ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Quantidade<input name="quantidade" id="txQ" inputmode="decimal" value="${h(t.quantidade != null ? String(t.quantidade).replace('.', ',') : '')}" required autofocus></label>
      <label id="txPL">Preço unitário pago (R$)<input name="preco_brl" id="txP" inputmode="decimal" value="${h(p0 !== '' ? String(p0).replace('.', ',') : '')}"></label>
      <label>Taxa (R$)<input name="taxa_brl" id="txT" inputmode="decimal" value="${h(String(t.taxa_brl ?? 0).replace('.', ','))}"></label>
      <label>Data<input name="data" type="date" value="${h(t.data)}" required></label>
      <label id="txCL">Corretora / carteira<input name="corretora" list="dlCorr" value="${h(t.corretora)}" placeholder="ex.: Binance"></label>
      <label id="txDL">Para (destino)<input name="destino" list="dlCorr" value="${h(t.destino)}" placeholder="ex.: Ledger"></label>
    </div>
    <p class="cr-total" id="txTot"></p>
    <label>Observação<textarea name="obs" rows="2">${h(t.obs)}</textarea></label>
    <p class="muted small">Moeda que não está na lista? Adicione-a no quadro da aba Mercado. Em recebimento/staking, use o preço do dia em que recebeu (ou 0).</p>`, {
    extra: t.id ? `<button type="button" class="btn danger" id="delTx">Excluir</button>` : '',
    onSubmit: async f => {
      const c = moedas.find(x => x.coin_id === f.coin_id);
      if (!c) throw new Error('Escolha a moeda.');
      const q = lerNumero(f.quantidade), p = lerNumero(f.preco_brl) ?? 0, taxa = lerNumero(f.taxa_brl) ?? 0;
      if (!(q > 0)) throw new Error('Informe a quantidade.');
      if (p < 0 || taxa < 0) throw new Error('Preço e taxa não podem ser negativos.');
      if (f.tipo === 'compra' && !(p > 0)) throw new Error('Informe o preço unitário pago.');
      if (f.tipo === 'transferencia' && !f.destino.trim()) throw new Error('Informe para onde foi a transferência.');
      if (['venda', 'transferencia'].includes(f.tipo)) {
        const saldo = calcular(S.crypto_tx.filter(x => x.id !== t.id)).moedas[c.coin_id]?.qtd || 0;
        if (q > saldo + 1e-9) throw new Error(`Você tem ${qtd(saldo)} ${c.simbolo} registrados. Lance antes as compras que faltam (ou importe o histórico).`);
      }
      const row = { coin_id: c.coin_id, simbolo: c.simbolo, nome: c.nome, tipo: f.tipo, quantidade: q, preco_brl: f.tipo === 'transferencia' ? 0 : p, taxa_brl: taxa,
        data: f.data, corretora: f.corretora.trim(), destino: f.tipo === 'transferencia' ? f.destino.trim() : null, obs: f.obs.trim() };
      await save('crypto_tx', row, t.id);
      toast(t.id ? 'Lançamento salvo' : `${TIPOS[f.tipo]} de ${c.simbolo} registrada`);
      if (!M.coins[c.coin_id]) refresh(true);
    },
  });
  const m = dlg();
  const $ = s => m.querySelector(s);
  const sync = () => {
    const tipo = $('#txTipo').value;
    $('#txDL').hidden = tipo !== 'transferencia';
    $('#txPL').hidden = tipo === 'transferencia';
    $('#txCL').firstChild.textContent = tipo === 'transferencia' ? 'De (origem)' : 'Corretora / carteira';
    const q = lerNumero($('#txQ').value) || 0, p = lerNumero($('#txP').value) || 0, tx = lerNumero($('#txT').value) || 0;
    const cot = M.coins[$('#txMoeda').value]?.brl;
    $('#txTot').innerHTML = tipo === 'transferencia' ? (tx ? `Taxa de ${reais(tx)} entra no custo da moeda.` : '')
      : q ? `Total: <b>${reais(q * p + (tipo === 'venda' ? -tx : tx))}</b>${tipo === 'venda' ? ' líquido' : ''}${cot ? ` <span class="muted">· a cotação agora daria ${reais(q * cot)}</span>` : ''}` : '';
  };
  $('#txMoeda').onchange = () => { const c = M.coins[$('#txMoeda').value]; if (c && !t.id) $('#txP').value = String(c.brl).replace('.', ','); sync(); };
  ['#txTipo', '#txQ', '#txP', '#txT'].forEach(s => $(s).addEventListener('input', sync));
  $('#delTx')?.addEventListener('click', async ev => {
    if (!confirmInline(ev.target)) return;
    await del('crypto_tx', t.id); closeModal(); toast('Lançamento excluído');
  });
  sync();
}
