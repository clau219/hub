// Cálculos da carteira (funções puras): classes de ativo, totais, pesos, resultado, evolução, proventos,
// vencimentos e rentabilidade. Indicadores, gráficos e listas da aba Finanças usam só estas funções,
// para os números nunca divergirem entre si.

// ---------- Classes de ativo ----------
// fatia: grupo de cor do gráfico de alocação (6 cores validadas para daltonismo, claro e escuro);
// subclasses sem fatia própria usam a cor de "Outros". Verde/vermelho ficam só para ganho/perda.
export const CLASSES = {
  acoes: { nome: 'Ações', grupo: 'rv', fatia: 'acoes' },
  fiis: { nome: 'FIIs', grupo: 'rv', fatia: 'fiis' },
  etfs: { nome: 'ETFs', grupo: 'rv', fatia: 'etfs' },
  bdrs: { nome: 'BDRs', grupo: 'rv', fatia: 'outros' },
  cripto: { nome: 'Criptomoedas', grupo: 'rv', fatia: 'cripto' },
  fundos_rv: { nome: 'Fundos de ações e multimercado', grupo: 'rv', fatia: 'outros' },
  outros_rv: { nome: 'Internacional / outros', grupo: 'rv', fatia: 'outros' },
  tesouro: { nome: 'Tesouro Direto', grupo: 'rf', fatia: 'rf' },
  bancario: { nome: 'CDB / LCI / LCA / LC', grupo: 'rf', fatia: 'rf' },
  credito: { nome: 'Debêntures / CRI / CRA', grupo: 'rf', fatia: 'rf' },
  fundos_rf: { nome: 'Fundos de renda fixa', grupo: 'rf', fatia: 'rf' },
  reserva: { nome: 'Poupança, conta remunerada e reserva', grupo: 'rf', fatia: 'rf' },
  previdencia: { nome: 'Previdência', grupo: 'rf', fatia: 'rf' },
  outros_rf: { nome: 'Outros de renda fixa', grupo: 'rf', fatia: 'rf' },
};
export const ORDEM_CLASSES = Object.keys(CLASSES);
// Ordem fixa das fatias = ordem validada das cores (nunca reordenar por tamanho)
export const FATIAS = [
  { id: 'rf', nome: 'Renda fixa' }, { id: 'acoes', nome: 'Ações' }, { id: 'fiis', nome: 'FIIs' },
  { id: 'etfs', nome: 'ETFs' }, { id: 'cripto', nome: 'Cripto' }, { id: 'outros', nome: 'Outros RV' },
];
export const corFatia = f => `var(--cl-${f})`;
export const corClasse = c => corFatia(CLASSES[c]?.fatia || 'outros');
export const GRUPOS = { rv: 'Renda variável', rf: 'Renda fixa' };

const RESERVA = /caixinha|cofrinho|porquinho|reserva|poupan|conta remunerada|rende\s*\+|turbo/i;
// Classe de um investimento: a escolhida pelo usuário, senão a dedução pelo tipo/subtipo da Pluggy
export function classeDe(i) {
  if (i.classe && CLASSES[i.classe]) return i.classe;
  if (i.fonte === 'cripto') return 'cripto';
  const sub = i.subtipo || '', nome = `${i.nome || ''} ${i.ticker || ''}`;
  switch (i.tipo) {
    case 'EQUITY':
      if (sub === 'STOCK') return 'acoes';
      if (sub === 'REAL_ESTATE_FUND') return 'fiis';
      if (sub === 'BDR') return 'bdrs';
      if (sub === 'ETF') return 'etfs';
      if (/\b[A-Z]{4}3[45]\b/.test(i.ticker || '')) return 'bdrs';
      if (/\b[A-Z]{4}11\b/.test(i.ticker || '')) return 'fiis';
      if (/\b[A-Z]{4}[3-8]\b/.test(i.ticker || '')) return 'acoes';
      return 'outros_rv';
    case 'ETF': return 'etfs';
    case 'COE': return 'outros_rv';
    case 'MUTUAL_FUND': return sub === 'FIXED_INCOME_FUND' ? 'fundos_rf' : 'fundos_rv';
    case 'SECURITY': return 'previdencia';
    case 'FIXED_INCOME':
      if (RESERVA.test(nome)) return 'reserva';
      if (sub === 'TREASURY' || /tesouro/i.test(nome)) return 'tesouro';
      if (['DEBENTURES', 'CRI', 'CRA', 'CORPORATE_DEBT'].includes(sub)) return 'credito';
      return 'bancario';
    default:
      return i.vence || i.taxa || i.taxa_fixa ? 'outros_rf' : 'outros_rv';
  }
}

// Tesouro: Selic, IPCA+ ou Prefixado (pelo nome ou indexador)
export function tesouroTipo(i) {
  const t = `${i.nome || ''} ${i.taxa_tipo || ''}`;
  if (/selic|LFT/i.test(t)) return 'Selic';
  if (/ipca|NTN-?B|renda\+|educa\+/i.test(t)) return 'IPCA+';
  if (/prefix|LTN|NTN-?F|\bPRE/i.test(t)) return 'Prefixado';
  return '';
}

// Liquidez: escolhida pelo usuário ou deduzida. diaria = pode resgatar em 1 dia útil.
const LIQ_TXT = { diaria: 'Diária', vencimento: 'No vencimento' };
export function liquidezDe(i, classe = classeDe(i)) {
  const cod = i.liquidez || (
    classe === 'reserva' ? 'diaria'
      : ['bancario', 'credito', 'outros_rf'].includes(classe) ? (i.vence ? 'vencimento' : 'diaria')
        : classe === 'tesouro' ? 'D+1'
          : classe === 'previdencia' ? 'D+30'
            : classe === 'cripto' ? 'imediata'
              : CLASSES[classe]?.grupo === 'rv' && classe !== 'fundos_rv' ? 'D+2' : '');
  return { cod, txt: LIQ_TXT[cod] || (cod === 'imediata' ? 'Imediata' : cod), diaria: cod === 'diaria' || cod === 'D+0' || cod === 'D+1' };
}

// "110% do CDI", "IPCA + 6,2%", "12,5% a.a."
export function taxaTxt(i) {
  const tt = i.taxa_tipo && !/PRE/i.test(i.taxa_tipo) ? i.taxa_tipo.replace(/_/g, ' ') : '';
  if (tt && i.taxa_fixa) return `${tt} + ${pct(i.taxa_fixa, 2, false)}`;
  if (tt && i.taxa) return `${pct(i.taxa, 2, false)} do ${tt}`;
  if (i.taxa_fixa || i.taxa) return `${pct(i.taxa_fixa || i.taxa, 2, false)} a.a. (prefixado)`;
  return '';
}

// ---------- Datas ----------
export const hojeIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
export function somaDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
export const PERIODOS = [['1M', 30], ['3M', 91], ['6M', 182], ['1A', 365], ['Tudo', 0]];
export const inicioPeriodo = (p, hoje = hojeIso()) => { const d = PERIODOS.find(x => x[0] === p)?.[1]; return d ? somaDias(hoje, -d) : '0000-01-01'; };

// ---------- Formatação pt-BR (com modo privacidade e moeda R$/US$) ----------
// Os valores chegam sempre em reais; conv() passa para dólar quando o usuário escolhe US$.
import { conv, cod, simbolo } from './moeda.js';
export const priv = { on: false };
const oculto = () => `${simbolo()} ••••`;
export function money(v, casas = 2) {
  if (v == null || isNaN(v)) return '–';
  if (priv.on) return oculto();
  return Number(conv(v)).toLocaleString('pt-BR', { style: 'currency', currency: cod(), minimumFractionDigits: casas, maximumFractionDigits: casas });
}
export const moneyC = v => v == null || isNaN(v) ? '–' : priv.on ? oculto() : Math.abs(conv(v)) >= 1e6
  ? Number(conv(v)).toLocaleString('pt-BR', { style: 'currency', currency: cod(), notation: 'compact', maximumFractionDigits: 1 }) : money(v, 0);
export function pct(v, casas = 2, sinal = true) {
  if (v == null || !isFinite(v)) return '–';
  return (sinal && v > 0 ? '+' : '') + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }) + '%';
}
export const qtdTxt = v => v == null ? '–' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 8 });
export const dataBr = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '–';

// ---------- Ativos (formato único para Pluggy, manual e cripto) ----------
const n = v => v == null || v === '' || isNaN(v) ? null : Number(v);
export function deInvest(i, hoje = hojeIso()) {
  const classe = classeDe(i);
  const qtd = n(i.quantidade), pm = n(i.preco_medio), preco = n(i.preco_atual);
  const valor = n(i.saldo) ?? (qtd != null && (preco ?? pm) != null ? qtd * (preco ?? pm) : null);
  const custo = n(i.aplicado) ?? (qtd != null && pm != null ? qtd * pm : n(i.rendimento) != null && valor != null ? valor - n(i.rendimento) : null);
  const resultado = n(i.rendimento) ?? (custo != null && valor != null ? valor - custo : null);
  return {
    id: i.id, fonte: i.fonte || 'pluggy', nome: i.nome || i.ticker || 'Aplicação', ticker: i.ticker || '', classe, grupo: CLASSES[classe].grupo,
    emissor: i.emissor || '', qtd, pm: pm ?? (custo != null && qtd ? custo / qtd : null), preco, valor, custo, resultado,
    resPct: resultado != null && custo > 0 ? resultado / custo * 100 : null,
    vence: i.vence || null, dias: i.vence ? diasEntre(hoje, i.vence) : null, liquidez: liquidezDe(i, classe),
    taxa: taxaTxt(i), tesouro: classe === 'tesouro' ? tesouroTipo(i) : '', rend12m: n(i.rend_12m), liquido: n(i.liquido),
    oculta: !!i.oculta, item_id: i.item_id || null, raw: i,
  };
}
// Cripto = compras da tela Cripto (custo e preço médio) + saldos lidos da blockchain (carteiras de autocustódia).
// lista: posicoes(crypto_tx).lista (com .corretoras); saldos: cripto_saldos; coins: cotações (M.coins); carteiras: cripto_carteiras.
// Quantidade = blockchain (quando a moeda está numa carteira lida) + o que está lançado em outras corretoras (ex.: Nubank).
// Custo = preço médio das compras lançadas × quantidade total (suposição: as moedas da carteira custaram o mesmo).
const REDE_NOME = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'OP Mainnet', polygon: 'Polygon', bsc: 'BNB Chain', avalanche: 'Avalanche' };
export const redeNome = r => REDE_NOME[r] || r;
export function mesclarCripto(lista = [], saldos = [], coins = {}, { dolar = null, carteiras = [] } = {}) {
  const nomes = carteiras.map(c => (c.nome || '').trim()).filter(Boolean).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const autocust = new RegExp(['onekey', 'rabby', ...nomes].join('|'), 'i');
  const nomeCart = id => carteiras.find(c => c.id === id)?.nome || 'Carteira';
  const grupos = new Map();
  const g = k => grupos.get(k) || grupos.set(k, { L: null, S: [] }).get(k);
  for (const m of lista) if (m.qtd > 1e-10 || m.custo > 0) g(m.coin_id).L = m;
  for (const s of saldos) if (+s.quantidade > 0) g(s.coin_id || `tk:${s.chain}:${s.token}`).S.push(s);
  const out = [];
  for (const [chave, { L, S }] of grupos) {
    const corr = L?.corretoras || {};
    const fora = Object.entries(corr).filter(([c, q]) => q > 1e-10 && !autocust.test(c));
    const qFora = fora.reduce((t, [, q]) => t + q, 0);
    const qAutoLanc = Object.entries(corr).filter(([c, q]) => q > 1e-10 && autocust.test(c)).reduce((t, [, q]) => t + q, 0);
    const qOn = S.reduce((t, s) => t + Number(s.quantidade), 0);
    const qtd = S.length ? qOn + qFora : (L?.qtd || 0);
    if (qtd < 1e-12) continue;
    const coin = L?.coin_id || S[0]?.coin_id || null;
    const c = coin ? coins[coin] : null;
    const preco = c?.brl ?? (S[0]?.preco_usd && dolar ? S[0].preco_usd * dolar : null);
    const pm = L && L.qtd > 1e-10 ? L.custo / L.qtd : null;
    const custo = pm != null ? pm * qtd : null;
    const valor = preco != null ? qtd * preco : null;
    const resultado = valor != null && custo != null ? valor - custo : null;
    const onde = [...S.map(s => `${nomeCart(s.carteira_id)} · ${redeNome(s.chain)}`), ...fora.map(([n]) => n)];
    out.push({
      id: coin ? 'cg-' + coin : chave, fonte: 'cripto', nome: c?.nome || L?.nome || S[0]?.nome || coin, ticker: (c?.simbolo || L?.simbolo || S[0]?.simbolo || '').toUpperCase(),
      classe: 'cripto', grupo: 'rv', emissor: [...new Set(onde)].join(', '), qtd, pm, preco, valor, custo, resultado, resPct: resultado != null && custo > 0 ? resultado / custo * 100 : null,
      vence: null, dias: null, liquidez: liquidezDe({}, 'cripto'), taxa: '', tesouro: '', rend12m: null, liquido: null, oculta: false, item_id: null,
      coin_id: coin, semPreco: valor == null, semCusto: custo == null,
      divergente: S.length > 0 && qAutoLanc > 0 && Math.abs(qAutoLanc - qOn) > Math.max(qOn, qAutoLanc) * 0.01 ? { lancado: qAutoLanc, carteira: qOn } : null,
      porLocal: [...S.map(s => ({ onde: `${nomeCart(s.carteira_id)} · ${redeNome(s.chain)}`, qtd: Number(s.quantidade), blockchain: true })), ...fora.map(([n, q]) => ({ onde: n, qtd: q }))],
      raw: { L, S },
    });
  }
  return out;
}

const soma = (l, k) => l.reduce((t, a) => t + (a[k] ?? 0), 0);
// Totais de uma lista de ativos (os ocultos não contam)
export function totais(ativos) {
  const l = ativos.filter(a => !a.oculta);
  const valor = soma(l, 'valor');
  const comCusto = l.filter(a => a.custo != null && a.valor != null);
  const custo = soma(comCusto, 'custo'), resultado = soma(comCusto, 'valor') - custo;
  const rf = soma(l.filter(a => a.grupo === 'rf'), 'valor'), rv = soma(l.filter(a => a.grupo === 'rv'), 'valor');
  return { valor, custo, resultado, resPct: custo > 0 ? resultado / custo * 100 : null, rf, rv, n: l.length, semPreco: l.filter(a => a.valor == null).length };
}
export const peso = (a, total) => a.oculta || a.valor == null || !total ? null : a.valor / total * 100;

// Agrupa por classe na ordem fixa; cada grupo com subtotal e % do total informado
export function porClasse(ativos, total) {
  const g = {};
  for (const a of ativos) (g[a.classe] ||= []).push(a);
  return ORDEM_CLASSES.filter(c => g[c]).map(c => {
    const t = totais(g[c]);
    return { classe: c, nome: CLASSES[c].nome, grupo: CLASSES[c].grupo, ativos: g[c], ...t, peso: total ? t.valor / total * 100 : null };
  });
}
export function alocacao(ativos) {
  const tot = totais(ativos).valor;
  return FATIAS.map(f => {
    const l = ativos.filter(a => !a.oculta && CLASSES[a.classe].fatia === f.id);
    const valor = soma(l, 'valor');
    return { ...f, valor, peso: tot ? valor / tot * 100 : 0, n: l.length, classes: [...new Set(l.map(a => a.classe))] };
  }).filter(f => f.valor > 0);
}

// Filtros globais: classe (ou fatia "f:<id>"), renda (rf|rv) e busca por nome/ticker/emissor
export function filtrar(ativos, { classe = '', renda = '', q = '' } = {}) {
  const busca = q.trim().toLowerCase();
  return ativos.filter(a => (!classe || (classe.startsWith('f:') ? CLASSES[a.classe].fatia === classe.slice(2) : a.classe === classe))
    && (!renda || a.grupo === renda)
    && (!busca || `${a.nome} ${a.ticker} ${a.emissor}`.toLowerCase().includes(busca)));
}

const ORDENS = { valor: a => a.valor ?? -Infinity, resultado: a => a.resPct ?? -Infinity, peso: a => a.valor ?? -Infinity, nome: a => a.nome.toLowerCase(), vence: a => a.vence || '9999' };
export function ordenar(ativos, col = 'valor', dir = -1) {
  const f = ORDENS[col] || ORDENS.valor;
  return [...ativos].sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
}

// ---------- Ranking ----------
export function ranking(ativos, n = 6) {
  const l = ativos.filter(a => !a.oculta && a.valor != null);
  const comRes = l.filter(a => a.resPct != null);
  return {
    maiores: ordenar(l, 'valor').slice(0, n),
    altas: ordenar(comRes.filter(a => a.resPct > 0), 'resultado').slice(0, n),
    baixas: ordenar(comRes.filter(a => a.resPct < 0), 'resultado', 1).slice(0, n),
  };
}

// ---------- Vencimentos (renda fixa, próximos N meses) ----------
export function vencimentos(ativos, meses = 12, hoje = hojeIso()) {
  const fim = somaDias(hoje, Math.round(meses * 30.44));
  return ativos.filter(a => !a.oculta && a.grupo === 'rf' && a.vence && a.vence >= hoje && a.vence <= fim)
    .sort((a, b) => a.vence.localeCompare(b.vence));
}

// ---------- Evolução do patrimônio ----------
// Último valor de uma série [{dia, ...}] ordenada em ou antes do dia
function ultimoAte(serie, dia) {
  let lo = 0, hi = serie.length - 1, r = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (serie[m].dia <= dia) { r = serie[m]; lo = m + 1; } else hi = m - 1; }
  return r;
}
// hist: fotos diárias de cada investimento; snaps: contas/faturas; cripto: crypto_snap (valor_brl).
// ids: investimentos que entram (filtro); comCripto/comContas dizem se as outras partes entram.
export function evolucao({ hist = [], snaps = [], cripto = [], ids = null, comCripto = true, comContas = true, desde = '0000-01-01' } = {}) {
  const porDia = new Map();
  for (const r of hist) {
    if (ids && !ids.has(r.invest_id)) continue;
    porDia.set(r.dia, (porDia.get(r.dia) || 0) + Number(r.saldo || 0));
  }
  const sn = [...snaps].sort((a, b) => a.dia.localeCompare(b.dia));
  const cr = [...cripto].sort((a, b) => a.dia.localeCompare(b.dia));
  const dias = new Set([...porDia.keys()]);
  if (comContas) sn.forEach(s => dias.add(s.dia));
  if (comCripto) cr.forEach(s => dias.add(s.dia));
  return [...dias].filter(d => d >= desde).sort().map(dia => {
    const inv = porDia.get(dia) ?? 0;
    const c = comCripto ? Number(ultimoAte(cr, dia)?.valor_brl || 0) : 0;
    const s = comContas ? ultimoAte(sn, dia) : null;
    const contas = s ? Number(s.contas || 0) - Number(s.faturas || 0) : 0;
    return { dia, investido: inv + c, contas, valor: inv + c + contas };
  });
}
// Variação contra o ponto mais próximo de N dias atrás
export function variacao(serie, campo = 'valor', dias = 30, hoje = hojeIso()) {
  if (serie.length < 2) return null;
  const agora = serie[serie.length - 1];
  const antes = ultimoAte(serie, somaDias(hoje, -dias));
  if (!antes || antes.dia === agora.dia) return null;
  const a = antes[campo], b = agora[campo];
  return { antes: a, agora: b, delta: b - a, pct: a ? (b - a) / Math.abs(a) * 100 : null, desde: antes.dia };
}

// ---------- Proventos ----------
// movs: fin_inv_mov tipo 'provento'; extras: entradas da conta classificadas como rendimento
export function proventosPorMes(movs, extras = [], meses = 12, hoje = hojeIso()) {
  const ini = hoje.slice(0, 7);
  const lista = Array.from({ length: meses }, (_, k) => { const d = new Date(Date.UTC(+ini.slice(0, 4), +ini.slice(5) - 1 - (meses - 1 - k), 1)); return d.toISOString().slice(0, 7); });
  const m = Object.fromEntries(lista.map(x => [x, { mes: x, valor: 0, tipos: {} }]));
  const add = (data, v, tipo) => { const x = m[data.slice(0, 7)]; if (!x) return; x.valor += v; x.tipos[tipo] = (x.tipos[tipo] || 0) + v; };
  for (const p of movs) if (p.tipo === 'provento') add(p.data, Number(p.valor || 0), p.subtipo || 'rendimento');
  for (const t of extras) add(t.data, Number(t.valor || 0), 'juros');
  return lista.map(x => m[x]);
}
export const PROVENTO_TXT = { dividendo: 'Dividendos', jcp: 'JCP', rendimento: 'Rendimentos de FIIs', juros: 'Juros' };

// ---------- Rentabilidade no período (método de Dietz modificado) ----------
// serie: evolução só dos investimentos; fluxos: [{data, valor}] (+ aporte, − resgate)
export function rentabilidade(serie, fluxos, desde) {
  const pts = serie.filter(p => p.dia >= desde);
  if (pts.length < 2) return null;
  const v0 = pts[0].investido, v1 = pts[pts.length - 1].investido;
  if (!(v0 > 0)) return null;
  const d0 = pts[0].dia, d1 = pts[pts.length - 1].dia, T = Math.max(1, diasEntre(d0, d1));
  let F = 0, Fp = 0;
  for (const f of fluxos) {
    if (f.data <= d0 || f.data > d1) continue;
    F += f.valor; Fp += f.valor * (diasEntre(f.data, d1) / T);
  }
  const base = v0 + Fp;
  return base > 0 ? { pct: (v1 - v0 - F) / base * 100, desde: d0, ate: d1 } : null;
}
// CDI diário (% ao dia, série 12 do BC) e IPCA mensal (% ao mês, série 433) acumulados no intervalo
export function acumular(pontos, desde, ate) {
  let f = 1, usados = 0;
  for (const [dia, v] of pontos) if (dia > desde && dia <= ate) { f *= 1 + v / 100; usados++; }
  return usados ? (f - 1) * 100 : null;
}
