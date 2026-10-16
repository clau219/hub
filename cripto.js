// Cripto: cotações (CoinGecko, alternative.me, AwesomeAPI), cálculo da carteira e CSV.
// As APIs são públicas e sem chave; as cotações ficam em cache neste navegador.
import { h } from './util.js';

const CG = 'https://api.coingecko.com/api/v3';
const KEY = 'hub:cripto-mercado';
export const VELHO_MS = 5 * 60 * 1000; // mais velho que isso, atualiza sozinho ao abrir

// Quadro inicial (ids da CoinGecko)
export const PADRAO = [
  ['bitcoin', 'BTC', 'Bitcoin'], ['ethereum', 'ETH', 'Ethereum'], ['binancecoin', 'BNB', 'BNB'], ['solana', 'SOL', 'Solana'],
  ['ripple', 'XRP', 'XRP'], ['tether', 'USDT', 'Tether'], ['usd-coin', 'USDC', 'USDC'], ['cardano', 'ADA', 'Cardano'],
  ['dogecoin', 'DOGE', 'Dogecoin'], ['tron', 'TRX', 'TRON'],
];

export const TIPOS = {
  compra: 'Compra', venda: 'Venda', transferencia: 'Transferência', recebimento: 'Recebimento / staking',
};
export const CORRETORAS = ['Binance', 'Mercado Bitcoin', 'Foxbit', 'Coinbase', 'Bybit', 'OKX', 'Nubank', 'Ledger', 'Trezor', 'MetaMask'];

// Referências da Receita (confira com o contador; mudam por lei/IN)
export const LIMITE_ISENCAO = 35000; // vendas no mês até isso: ganho isento de IR
export const LIMITE_DECLARACAO = 30000; // operações no mês sem corretora brasileira: declaração mensal

// ---------------------------------------------------------------
// Mercado
// ---------------------------------------------------------------
export const M = (() => {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
})() || { coins: {}, global: null, fng: null, dolar: null, at: 0 };
let emCurso = null;

async function getJson(url) {
  const r = await fetch(url);
  if (r.status === 429) throw new Error('A CoinGecko limitou as consultas. Tente de novo em 1 minuto.');
  if (!r.ok) throw new Error(`Falha ao consultar cotações (${r.status})`);
  return r.json();
}

// Busca tudo de uma vez; chamadas simultâneas reaproveitam a mesma consulta
export function atualizar(ids) {
  if (emCurso) return emCurso;
  emCurso = (async () => {
    const lista = [...new Set(ids)].filter(Boolean).join(',');
    const q = `per_page=250&ids=${encodeURIComponent(lista)}&price_change_percentage=24h,7d`;
    const [brl, usd, glob, fng, dol] = await Promise.allSettled([
      lista ? getJson(`${CG}/coins/markets?vs_currency=brl&sparkline=true&${q}`) : [],
      lista ? getJson(`${CG}/coins/markets?vs_currency=usd&${q}`) : [],
      getJson(`${CG}/global`),
      getJson('https://api.alternative.me/fng/?limit=1'),
      getJson('https://economia.awesomeapi.com.br/json/last/USD-BRL'),
    ]);
    if (brl.status === 'rejected') throw brl.reason;
    const u = Object.fromEntries((usd.value || []).map(c => [c.id, c]));
    let dolar = dol.status === 'fulfilled' ? +dol.value.USDBRL?.bid : null;
    if (!dolar && u.bitcoin) dolar = brl.value.find(c => c.id === 'bitcoin')?.current_price / u.bitcoin.current_price;
    dolar ||= M.dolar;
    const coins = {};
    for (const c of brl.value) {
      coins[c.id] = {
        id: c.id, simbolo: (c.symbol || '').toUpperCase(), nome: c.name, img: c.image, rank: c.market_cap_rank,
        brl: c.current_price, usd: u[c.id]?.current_price ?? (dolar ? c.current_price / dolar : null), // sem a consulta em dólar, converte
        ch24: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
        ch7: c.price_change_percentage_7d_in_currency,
        mcap: c.market_cap, vol: c.total_volume, ath: c.ath_change_percentage,
        athUsd: u[c.id]?.ath, athData: c.ath_date?.slice(0, 10), altaUsd: u[c.id]?.high_24h, baixaUsd: u[c.id]?.low_24h,
        oferta: c.circulating_supply, ofertaMax: c.max_supply,
        spark: afinar(c.sparkline_in_7d?.price || [], 56),
      };
    }
    const g = glob.value?.data;
    Object.assign(M, {
      coins: { ...M.coins, ...coins },
      global: g ? { dom: g.market_cap_percentage?.btc, mcap: g.total_market_cap?.brl, mcapUsd: g.total_market_cap?.usd, ch24: g.market_cap_change_percentage_24h_usd } : M.global,
      fng: fng.status === 'fulfilled' ? { v: +fng.value.data[0].value, c: fng.value.data[0].value_classification } : M.fng,
      dolar,
      at: Date.now(),
    });
    try { localStorage.setItem(KEY, JSON.stringify(M)); } catch { /* cheio ou bloqueado */ }
    return M;
  })().finally(() => { emCurso = null; });
  return emCurso;
}
export const atualizando = () => !!emCurso;

function afinar(a, n) {
  if (a.length <= n) return a;
  const passo = (a.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => a[Math.round(i * passo)]);
}

export async function buscar(txt) {
  const d = await getJson(`${CG}/search?query=${encodeURIComponent(txt)}`);
  return (d.coins || []).slice(0, 12).map(c => ({ id: c.id, simbolo: (c.symbol || '').toUpperCase(), nome: c.name, img: c.thumb, rank: c.market_cap_rank }));
}

// ---------------------------------------------------------------
// Sinais: histórico diário em dólar (médias, RSI, máxima de 12 meses), medo e ganância e dólar em 30 dias.
// Uma consulta por moeda, em fila e espaçada, guardada por 12 h: a CoinGecko gratuita aceita poucas por minuto.
// ---------------------------------------------------------------
const KEY_H = 'hub:cripto-hist';
const HIST_MS = 12 * 3600e3;
const EXTRA_MS = 3 * 3600e3;
const PAUSA_MS = 6000;
export const STABLES = new Set(['tether', 'usd-coin', 'dai', 'first-digital-usd', 'ethena-usde', 'true-usd', 'paypal-usd', 'usds', 'binance-usd', 'brz', 'usdd']);
export const H = (() => {
  try { return JSON.parse(localStorage.getItem(KEY_H)) || null; } catch { return null; }
})() || { coins: {}, fng: null, dolar: null, dom: {} };
H.dom ||= {};
let filaH = null;
export const progresso = { feitas: 0, total: 0, esperando: false };
const salvarH = () => { try { localStorage.setItem(KEY_H, JSON.stringify(H)); } catch { /* cheio ou bloqueado */ } };
const espera = ms => new Promise(r => setTimeout(r, ms));
export const sinaisAtualizando = () => !!filaH;
// Há algo vencido para buscar? (evita disparar a fila a cada redesenho)
export function sinaisVencidos(ids) {
  const agora = Date.now();
  return !H.fng || agora - H.fng.at > EXTRA_MS || !H.dolar || agora - H.dolar.at > EXTRA_MS
    || ids.some(id => id && !STABLES.has(id) && !(H.coins[id] && agora - H.coins[id].at < HIST_MS));
}

// aoAvancar é chamado a cada dado novo, para a tela ir se completando
export function atualizarSinais(ids, aoAvancar) {
  if (filaH) return filaH;
  filaH = (async () => {
    const agora = Date.now();
    const extras = [];
    if (!H.fng || agora - H.fng.at > EXTRA_MS) extras.push(getJson('https://api.alternative.me/fng/?limit=31').then(d => {
      H.fng = { at: agora, v: d.data.map(x => +x.value) }; // mais recente primeiro
    }));
    if (!H.dolar || agora - H.dolar.at > EXTRA_MS) extras.push(getJson('https://economia.awesomeapi.com.br/json/daily/USD-BRL/31').then(d => {
      H.dolar = { at: agora, v: d.map(x => +x.bid) }; // mais recente primeiro
    }));
    if (extras.length) { await Promise.allSettled(extras); salvarH(); aoAvancar?.(); }
    const faltam = [...new Set(ids)].filter(id => id && !STABLES.has(id) && !(H.coins[id] && agora - H.coins[id].at < HIST_MS))
      .sort((a, b) => (H.coins[a]?.at || 0) - (H.coins[b]?.at || 0));
    Object.assign(progresso, { feitas: 0, total: faltam.length });
    const historico = async id => {
      let r;
      try { r = await fetch(`${CG}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=365&interval=daily`); }
      catch { r = { status: 429 }; } // o 429 da CoinGecko vem sem cabeçalho CORS e chega como falha de rede
      if (r.status === 404) return { prices: [] }; // moeda sem histórico: não insiste por 12 h
      if (r.status === 429) throw Object.assign(new Error('A CoinGecko limitou as consultas.'), { limite: true });
      if (!r.ok) throw new Error(`Falha ao consultar o histórico (${r.status})`);
      return r.json();
    };
    for (const [i, id] of faltam.entries()) {
      if (i) await espera(PAUSA_MS);
      let d;
      try { d = await historico(id); }
      catch (e) {
        if (!e.limite) throw e;
        progresso.esperando = true; aoAvancar?.();
        await espera(65000); // limite da CoinGecko: espera e tenta mais uma vez
        progresso.esperando = false;
        d = await historico(id);
      }
      H.coins[id] = { at: Date.now(), p: (d.prices || []).map(x => +(+x[1]).toPrecision(6)) };
      salvarH(); progresso.feitas++; aoAvancar?.();
    }
  })().finally(() => { filaH = null; progresso.esperando = false; });
  return filaH;
}

// Dominância do BTC: guarda um valor por dia para mostrar a tendência
export function anotarDominancia(dia, v) {
  if (v == null || H.dom[dia] === +v.toFixed(2)) return;
  H.dom[dia] = +v.toFixed(2);
  const dias = Object.keys(H.dom).sort();
  for (const d of dias.slice(0, Math.max(0, dias.length - 60))) delete H.dom[d];
  salvarH();
}

const media = (a, n) => a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null;
// RSI de 14 dias pelo método de Wilder
function rsi(a, n = 14) {
  if (a.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

// Indicadores de uma moeda (em dólar); null enquanto não há histórico
export function indicadores(id) {
  const p = [...(H.coins[id]?.p || [])];
  if (p.length < 15) return null;
  const c = M.coins[id];
  if (c?.usd && M.at > (H.coins[id].at || 0)) p[p.length - 1] = c.usd; // último ponto = cotação mais nova do quadro
  const atual = p.at(-1);
  const i = { atual, dias: p.length, mm50: media(p, 50), mm200: media(p, 200), rsi: rsi(p), max: Math.max(...p), min: Math.min(...p),
    ch30: p.length > 30 ? (atual / p[p.length - 31] - 1) * 100 : null };
  // Cruzamento das médias nos últimos 30 dias
  if (i.mm50 != null && i.mm200 != null) {
    for (let k = 1; k <= 30 && p.length - k >= 200; k++) {
      const a = p.slice(0, p.length - k), m50 = media(a, 50), m200 = media(a, 200);
      if ((m50 > m200) !== (i.mm50 > i.mm200)) { i.cruzou = k; break; }
    }
  }
  i.stable = STABLES.has(id) || (atual > .97 && atual < 1.03 && i.max / i.min < 1.06);
  return i;
}

export const FNG_PT = { 'Extreme Fear': 'Medo extremo', Fear: 'Medo', Neutral: 'Neutro', Greed: 'Ganância', 'Extreme Greed': 'Ganância extrema' };

// ---------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------
export function preco(v, cur = 'BRL') {
  if (v == null || isNaN(v)) return '—';
  const a = Math.abs(v);
  const o = a >= 1000 ? { maximumFractionDigits: 0 } : a >= 1 || a === 0 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 };
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: cur, ...o });
}
export const reais = v => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const compacto = (v, cur = 'BRL') => v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 2 });
export const qtd = v => v == null ? '' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 8 });
export function pct(v, cls = true) {
  if (v == null || isNaN(v)) return '<span class="muted">—</span>';
  const t = `${v > 0 ? '+' : ''}${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  return cls ? `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${t}</span>` : t;
}

export function sparkline(pts, up) {
  if (!pts || pts.length < 2) return '';
  const min = Math.min(...pts), max = Math.max(...pts), W = 110, H = 30;
  const d = pts.map((p, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${(H - 2 - (max === min ? .5 : (p - min) / (max - min)) * (H - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark ${up ? 'up' : 'down'}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${d}"/></svg>`;
}

// ---------------------------------------------------------------
// Carteira: preço médio (custo médio ponderado, como pede a Receita)
// ---------------------------------------------------------------
const EPS = 1e-10;
export const ordenarTx = txs => [...txs].sort((a, b) => a.data.localeCompare(b.data) || (a.created_at || '').localeCompare(b.created_at || ''));

export function calcular(txs) {
  const moedas = {};
  const vendas = {}; // 'YYYY-MM' -> { total, resultado, n, porCorretora }
  for (const t of ordenarTx(txs)) {
    const m = moedas[t.coin_id] ||= { coin_id: t.coin_id, simbolo: t.simbolo, nome: t.nome, qtd: 0, custo: 0, realizado: 0, corretoras: {}, aviso: false };
    const q = +t.quantidade || 0, p = +t.preco_brl || 0, taxa = +t.taxa_brl || 0;
    const onde = t.corretora || 'Sem corretora';
    const mov = (c, n) => { m.corretoras[c] = (m.corretoras[c] || 0) + n; };
    if (t.tipo === 'compra' || t.tipo === 'recebimento') {
      m.qtd += q; m.custo += q * p + taxa; mov(onde, q);
    } else if (t.tipo === 'venda') {
      const vendida = Math.min(q, m.qtd);
      const baixa = m.qtd > EPS ? m.custo * vendida / m.qtd : 0;
      if (q > m.qtd + EPS) m.aviso = true; // vendeu mais do que tinha: histórico incompleto
      m.custo -= baixa; m.qtd = Math.max(0, m.qtd - q);
      const res = q * p - taxa - baixa;
      m.realizado += res; mov(onde, -q);
      const mes = t.data.slice(0, 7);
      const v = vendas[mes] ||= { mes, total: 0, resultado: 0, n: 0, porCorretora: {} };
      v.total += q * p; v.resultado += res; v.n++;
      v.porCorretora[onde] = (v.porCorretora[onde] || 0) + q * p;
    } else if (t.tipo === 'transferencia') {
      m.custo += taxa; mov(onde, -q); mov(t.destino || 'Sem corretora', q);
    }
    if (m.qtd < EPS) { m.qtd = 0; m.custo = 0; }
  }
  return { moedas, vendas: Object.values(vendas).sort((a, b) => b.mes.localeCompare(a.mes)) };
}

// Junta posição e cotação
export function posicoes(txs) {
  const { moedas, vendas } = calcular(txs);
  const lista = Object.values(moedas).map(m => {
    const c = M.coins[m.coin_id];
    const valor = c ? m.qtd * c.brl : null;
    const ontem = c && c.ch24 != null ? valor / (1 + c.ch24 / 100) : valor;
    return { ...m, cot: c, valor, ontem, medio: m.qtd > EPS ? m.custo / m.qtd : null,
      resultado: valor != null ? valor - m.custo : null, resPct: valor != null && m.custo > 0 ? (valor - m.custo) / m.custo * 100 : null };
  });
  const ativos = lista.filter(p => p.qtd > EPS);
  const soma = k => ativos.reduce((s, p) => s + (p[k] || 0), 0);
  const tot = { valor: soma('valor'), custo: soma('custo'), ontem: soma('ontem'), realizado: lista.reduce((s, p) => s + p.realizado, 0) };
  tot.resultado = tot.valor - tot.custo;
  tot.resPct = tot.custo > 0 ? tot.resultado / tot.custo * 100 : null;
  tot.ch24 = tot.ontem > 0 ? (tot.valor - tot.ontem) / tot.ontem * 100 : null;
  return { lista, ativos, tot, vendas };
}

// ---------------------------------------------------------------
// CSV (separador ;  e  vírgula decimal, como o Excel em português abre)
// ---------------------------------------------------------------
export const CSV_COLS = ['data', 'tipo', 'simbolo', 'coin_id', 'quantidade', 'preco_brl', 'taxa_brl', 'corretora', 'destino', 'obs'];
const num = v => v == null || v === '' ? '' : String(v).replace('.', ',');
const cel = v => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function paraCsv(txs) {
  const linhas = ordenarTx(txs).map(t => [t.data, t.tipo, t.simbolo, t.coin_id, num(t.quantidade), num(t.preco_brl), num(t.taxa_brl), t.corretora, t.destino, t.obs].map(cel).join(';'));
  return '﻿' + [CSV_COLS.join(';'), ...linhas].join('\r\n');
}

export function lerCsv(txt) {
  txt = txt.replace(/^﻿/, '');
  const sep = (txt.split(/\r?\n/)[0].match(/;/g) || []).length >= (txt.split(/\r?\n/)[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) { if (ch === '"' && txt[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && txt[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

// Aceita o modelo do Hub e nomes comuns de colunas das corretoras (pt/en)
const ALIAS = {
  data: ['data', 'date', 'date(utc)', 'data/hora', 'time', 'datetime'],
  tipo: ['tipo', 'type', 'side', 'operação', 'operacao', 'operation'],
  simbolo: ['simbolo', 'símbolo', 'moeda', 'coin', 'asset', 'ativo', 'symbol', 'criptoativo'],
  coin_id: ['coin_id', 'id'],
  quantidade: ['quantidade', 'qtd', 'amount', 'quantity', 'executed', 'qty'],
  preco_brl: ['preco_brl', 'preço', 'preco', 'price', 'preço unitário', 'preco unitario', 'preço (r$)', 'preco (r$)'],
  taxa_brl: ['taxa_brl', 'taxa', 'fee', 'taxa (r$)', 'fees'],
  corretora: ['corretora', 'exchange', 'carteira', 'wallet', 'plataforma'],
  destino: ['destino', 'to', 'para'],
  obs: ['obs', 'observação', 'observacao', 'notas', 'notes', 'note'],
};
const TIPO_ALIAS = { compra: 'compra', buy: 'compra', c: 'compra', venda: 'venda', sell: 'venda', v: 'venda',
  transferencia: 'transferencia', 'transferência': 'transferencia', transfer: 'transferencia', withdraw: 'transferencia', saque: 'transferencia',
  recebimento: 'recebimento', staking: 'recebimento', deposito: 'recebimento', 'depósito': 'recebimento', deposit: 'recebimento', reward: 'recebimento', rendimento: 'recebimento', airdrop: 'recebimento' };

export function lerNumero(s) {
  s = String(s ?? '').trim().replace(/[^\d.,\-eE]/g, '');
  if (!s) return null;
  const v = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (v > -1 && p > -1) s = v > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (v > -1) s = s.replace(',', '.');
  const n = Number(s);
  return isNaN(n) ? null : n;
}
function lerData(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// Devolve { linhas: [{...tx}], erros: ['linha 3: ...'], simbolos: Set de símbolos sem coin_id }
export function interpretarCsv(txt) {
  const rows = lerCsv(txt);
  if (rows.length < 2) return { linhas: [], erros: ['O arquivo não tem linhas de dados.'], simbolos: new Set() };
  const cab = rows[0].map(c => c.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(ALIAS).map(([k, al]) => [k, cab.findIndex(c => al.includes(c))]));
  const faltam = ['data', 'tipo', 'quantidade'].filter(k => col[k] < 0).concat(col.simbolo < 0 && col.coin_id < 0 ? ['moeda'] : []);
  if (faltam.length) return { linhas: [], erros: [`Colunas não encontradas: ${faltam.join(', ')}. Use o modelo do Hub.`], simbolos: new Set() };
  const linhas = [], erros = [], simbolos = new Set();
  rows.slice(1).forEach((r, i) => {
    const g = k => col[k] >= 0 ? (r[col[k]] ?? '').trim() : '';
    const n = i + 2;
    const tipo = TIPO_ALIAS[g('tipo').toLowerCase()];
    const data = lerData(g('data'));
    const quantidade = Math.abs(lerNumero(g('quantidade')) ?? NaN);
    if (!tipo) return erros.push(`linha ${n}: tipo “${g('tipo')}” não reconhecido`);
    if (!data) return erros.push(`linha ${n}: data “${g('data')}” inválida`);
    if (!(quantidade > 0)) return erros.push(`linha ${n}: quantidade inválida`);
    const simbolo = g('simbolo').toUpperCase(), coin_id = g('coin_id').toLowerCase();
    if (!coin_id && !simbolo) return erros.push(`linha ${n}: sem moeda`);
    if (!coin_id) simbolos.add(simbolo);
    linhas.push({ data, tipo, simbolo, coin_id, quantidade, preco_brl: lerNumero(g('preco_brl')) ?? 0, taxa_brl: Math.abs(lerNumero(g('taxa_brl')) ?? 0),
      corretora: g('corretora') || null, destino: g('destino') || null, obs: g('obs') || null });
  });
  return { linhas, erros, simbolos };
}

// Símbolo -> id da CoinGecko: primeiro o que já conheço, depois a busca (maior valor de mercado)
export async function resolverSimbolos(simbolos, conhecidas) {
  const map = {};
  for (const s of simbolos) {
    const k = conhecidas.find(c => c.simbolo === s);
    if (k) { map[s] = { coin_id: k.coin_id, nome: k.nome }; continue; }
    const p = PADRAO.find(x => x[1] === s);
    if (p) { map[s] = { coin_id: p[0], nome: p[2] }; continue; }
    try {
      const r = (await buscar(s)).filter(c => c.simbolo === s).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))[0];
      if (r) map[s] = { coin_id: r.id, nome: r.nome };
    } catch { /* fica sem resolver */ }
  }
  return map;
}

export const coinLabel = c => `${h(c.nome)} <span class="muted">${h(c.simbolo)}</span>`;
