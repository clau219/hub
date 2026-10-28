// Painel da carteira (aba Finanças → Painel): indicadores, gráficos, filtros e as listas de
// Renda Variável (por classe) e Renda Fixa (por tipo). Os números vêm todos de fin-calc.js.
// Fontes: investimentos do banco (Pluggy, fin_invest), ativos cadastrados à mão (fin_invest fonte 'manual')
// e criptomoedas: compras da tela Cripto (crypto_tx) + saldos das carteiras lidos da blockchain (cripto_saldos).
// Movimentos: fin_inv_mov.
import { S } from './store.js';
import * as db from './db.js';
import { h } from './util.js';
import { modal, toast, closeModal } from './ui.js';
import * as fc from './fin-calc.js';
import * as fg from './fin-graficos.js';
import { posicoes, M, atualizar as atualizarCripto, VELHO_MS, atualizando as criptoAtualizando } from './cripto.js';

// ---------- Estado da tela (preferências guardadas neste navegador) ----------
const LS = 'hub:fin-painel';
const salvo = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
export const est = { periodo: salvo.periodo || '1A', classe: '', renda: '', q: '', vis: salvo.vis || 'tabela', ordem: salvo.ordem || {}, fechados: new Set(salvo.fechados || []),
  abertos: new Set() }; // abertos: grupos de títulos expandidos na lista (só nesta visita)
const guardar = () => { try { localStorage.setItem(LS, JSON.stringify({ periodo: est.periodo, vis: est.vis, ordem: est.ordem, fechados: [...est.fechados] })); } catch {} };

// ---------- Dados derivados (uma vez por render) ----------
let C = null; // contexto do último render: ativos, totais, séries
function montarDados(D, catDe) {
  const hoje = fc.hojeIso();
  const cripto = fc.mesclarCripto((S.crypto_tx || []).length ? posicoes(S.crypto_tx).lista : [], D.saldosCripto, M.coins, { dolar: M.dolar, carteiras: D.carteiras });
  const todos = [...D.inv.map(i => fc.deInvest(i, hoje)), ...cripto];
  const tot = fc.totais(todos);
  const vis = D.contas.filter(c => !c.oculta);
  const contas = vis.filter(c => c.tipo !== 'CREDIT').reduce((t, c) => t + Number(c.saldo || 0), 0);
  const faturas = vis.filter(c => c.tipo === 'CREDIT').reduce((t, c) => t + Number(c.saldo || 0), 0);
  const patrimonio = contas - faturas + tot.valor;
  // Série completa + ponto de hoje com os valores atuais (a foto do servidor pode ser de horas atrás)
  const { histInv, criptoSerie } = series(D);
  const serie = comHoje(fc.evolucao({ hist: histInv, snaps: D.snap, cripto: criptoSerie }), { dia: hoje, investido: tot.valor, contas: contas - faturas, valor: patrimonio });
  const extras = D.tx.filter(t => t.valor > 0 && catDe(t) === 'Rendimentos');
  return { hoje, todos, tot, contas, faturas, patrimonio, serie, extras, histInv, criptoSerie, cripto };
}
// Histórico de cripto: a foto diária do painel ('cripto-total', já com as carteiras da blockchain);
// antes da primeira foto, a da tela Cripto (só compras lançadas)
const CRIPTO_TOTAL = 'cripto-total';
function series(D) {
  const histInv = D.hist.filter(r => r.invest_id !== CRIPTO_TOTAL);
  const fotos = D.hist.filter(r => r.invest_id === CRIPTO_TOTAL).map(r => ({ dia: r.dia, valor_brl: r.saldo }));
  const ini = fotos.reduce((m, f) => f.dia < m ? f.dia : m, '9999');
  return { histInv, criptoSerie: [...(S.crypto_snap || []).filter(s => s.dia < ini), ...fotos] };
}
// Grava a foto de hoje do valor em cripto (uma vez por dia, com cotação fresca e tudo com preço)
let fotoCripto = '';
function gravarFotoCripto() {
  if (db.mode !== 'supabase' || fotoCripto === C.hoje || !C.cripto.length || C.cripto.some(a => a.semPreco) || Date.now() - (M.at || 0) > VELHO_MS) return;
  fotoCripto = C.hoje;
  const saldo = +C.cripto.reduce((t, a) => t + a.valor, 0).toFixed(2);
  db.client().from('fin_invest_hist').upsert({ invest_id: CRIPTO_TOTAL, dia: C.hoje, saldo }, { onConflict: 'invest_id,dia' }).then(({ error }) => { if (error) fotoCripto = ''; });
}
const comHoje = (serie, p) => [...serie.filter(x => x.dia !== p.dia), p];
const filtroAtivo = () => !!(est.classe || est.renda || est.q.trim());

// ---------- Render ----------
export function painel(D, ctx) {
  fg.limpar();
  C = { ...montarDados(D, ctx.catDe), D, ctx, grupos: new Map() };
  precosCripto();
  gravarFotoCripto();
  const { todos } = C;
  if (!todos.length && !D.contas.length) return vazio();
  const vis = fc.filtrar(todos, est);
  C.vis = vis;
  return `${acoes()}
  ${kpis()}
  ${filtros()}
  <div class="fn-graf-grid">
    ${cartaoRosca()}
    ${cartaoEvolucao()}
    ${cartaoProventos()}
    ${cartaoBench()}
    ${cartaoRanking()}
    ${cartaoVencimentos()}
  </div>
  ${listas()}
  <p class="muted small fn-rodape">Bancos via Open Finance (atualizados 1 vez por dia), ativos cadastrados no Hub e criptomoedas da tela Cripto.
    Resultado bruto, antes de IR. Patrimônio = contas − faturas em aberto + investimentos.</p>`;
}

export function skeleton() {
  const b = n => Array.from({ length: n }, () => '<div class="fn-sk"></div>').join('');
  return `<div class="fn-kpis6">${b(6)}</div><div class="fn-graf-grid">${b(4).replace(/fn-sk/g, 'fn-sk fn-sk-g')}</div>`;
}

function vazio() {
  return `<section class="block fn-vazio">
    <h2>Sua carteira ainda está vazia</h2>
    <p>Os investimentos chegam sozinhos dos bancos conectados (aba <b>Contas</b>). Ativos de outras corretoras você cadastra aqui,
      e as criptomoedas vêm da tela <a href="#/cripto">Cripto</a>.</p>
    <div class="fn-acoes"><button class="btn primary" data-novo="ativo">+ Cadastrar ativo</button><button class="btn" data-ir="contas">Conectar banco</button></div>
  </section>`;
}

function acoes() {
  return `<div class="fn-acoes" role="toolbar" aria-label="Adicionar">
    <button class="btn" data-novo="aporte">+ Aporte</button><button class="btn" data-novo="resgate">+ Resgate</button>
    <button class="btn" data-novo="provento">+ Provento</button><button class="btn primary" data-novo="ativo">+ Ativo</button>
  </div>`;
}

// ---------- Indicadores ----------
function seta(v, { campo = '', bomAlto = true, vs = '' } = {}) {
  if (!v || v.delta == null || Math.abs(v.delta) < 0.005) return `<small class="muted">${campo || 'sem histórico do mês anterior ainda'}</small>`;
  const sobe = v.delta > 0, bom = sobe === bomAlto;
  return `<small class="${bom ? 'fn-pos' : 'fn-neg'}"><span aria-hidden="true">${sobe ? '▲' : '▼'}</span> ${fc.money(Math.abs(v.delta), 0)}${v.pct != null ? ` (${fc.pct(v.pct)})` : ''}
    <span class="muted">vs. ${vs || fc.dataBr(v.desde).slice(0, 5)}</span></small>`;
}
function kpis() {
  const { tot, serie, patrimonio, contas, faturas } = C;
  const prov = fc.proventosPorMes(C.D.mov, C.extras, 2, C.hoje);
  const pAgora = prov[1].valor, pAntes = prov[0].valor;
  const rfP = tot.valor ? tot.rf / tot.valor * 100 : 0;
  return `<div class="fn-kpis6">
    <div class="kpi big"><span>Patrimônio total</span><b>${fc.money(patrimonio, 0)}</b>${seta(fc.variacao(serie, 'valor', 30, C.hoje))}</div>
    <div class="kpi"><span>Total investido</span><b>${fc.money(tot.valor, 0)}</b>${seta(fc.variacao(serie, 'investido', 30, C.hoje))}</div>
    <div class="kpi"><span>Resultado acumulado</span><b class="${tot.resultado >= 0 ? 'fn-pos' : 'fn-neg'}">${fc.money(tot.resultado, 0)}</b>
      <small>${fc.pct(tot.resPct)} sobre ${fc.money(tot.custo, 0)} aplicados</small></div>
    <div class="kpi"><span>Renda fixa × variável</span><b class="fn-split-b">${fc.pct(rfP, 0, false)} <span class="muted">×</span> ${fc.pct(100 - rfP, 0, false)}</b>
      <div class="fn-split" aria-hidden="true"><i style="width:${rfP}%;background:var(--cl-rf)"></i><i style="width:${100 - rfP}%;background:var(--cl-acoes)"></i></div>
      <small>RF ${fc.money(tot.rf, 0)} · RV ${fc.money(tot.rv, 0)}</small></div>
    <div class="kpi"><span>Proventos e rendimentos do mês</span><b>${fc.money(pAgora, 0)}</b>
      ${pAntes || pAgora ? seta({ delta: pAgora - pAntes, pct: pAntes ? (pAgora - pAntes) / pAntes * 100 : null }, { vs: 'mês anterior' }) : '<small class="muted">nenhum lançado ainda</small>'}</div>
    <div class="kpi"><span>Saldo disponível</span><b>${fc.money(contas, 0)}</b>${seta(fc.variacao(serie, 'contas', 30, C.hoje), { campo: faturas ? `faturas abertas ${fc.money(faturas, 0)}` : '' })}</div>
  </div>`;
}

// ---------- Filtros globais ----------
function filtros() {
  const classes = [...new Set(C.todos.map(a => a.classe))].sort((a, b) => fc.ORDEM_CLASSES.indexOf(a) - fc.ORDEM_CLASSES.indexOf(b));
  const fatia = est.classe.startsWith('f:') ? fc.FATIAS.find(f => f.id === est.classe.slice(2)) : null;
  return `<div class="fn-filtros fn-filtros-g" role="search">
    <div class="seg" role="tablist" aria-label="Período">${fc.PERIODOS.map(([p]) => `<button data-per="${p}" class="${p === est.periodo ? 'on' : ''}" aria-selected="${p === est.periodo}">${p}</button>`).join('')}</div>
    <div class="seg" role="tablist" aria-label="Tipo de renda">${[['', 'Tudo'], ['rv', 'Variável'], ['rf', 'Fixa']].map(([k, l]) => `<button data-renda="${k}" class="${k === est.renda ? 'on' : ''}" aria-selected="${k === est.renda}">${l}</button>`).join('')}</div>
    <select id="fnCl" aria-label="Classe de ativo"><option value="">Todas as classes</option>
      ${fatia ? `<option value="${h(est.classe)}" selected>${h(fatia.nome)}</option>` : ''}
      ${classes.map(c => `<option value="${c}" ${c === est.classe ? 'selected' : ''}>${h(fc.CLASSES[c].nome)}</option>`).join('')}</select>
    <input id="fnBusca" type="search" placeholder="Buscar nome ou ticker" value="${h(est.q)}" aria-label="Buscar ativo">
    ${filtroAtivo() ? '<button class="link-btn" id="fnLimparF">Limpar filtros</button>' : ''}
  </div>`;
}

// ---------- Gráficos ----------
const cartao = (titulo, corpo, extra = '', cls = '') => `<section class="fn-card ${cls}"><div class="fn-card-h"><h2>${titulo}</h2>${extra}</div>${corpo}</section>`;

function cartaoRosca() {
  const base = fc.filtrar(C.todos, { renda: est.renda, q: est.q });
  const fat = fc.alocacao(base).map(f => ({ ...f, cor: fc.corFatia(f.id),
    tip: fg.tipTxt(f.nome, [['Valor', fc.money(f.valor)], ['Peso', fc.pct(f.peso, 2, false)], ['Ativos', String(f.n)]]) }));
  if (!fat.length) return cartao('Alocação por classe', '<p class="empty">Nenhum ativo com esse filtro.</p>');
  const selF = est.classe.startsWith('f:') ? est.classe.slice(2) : est.classe ? fc.CLASSES[est.classe]?.fatia : '';
  const total = fat.reduce((t, f) => t + f.valor, 0);
  return cartao('Alocação por classe', `<div class="fn-rosca">
    ${fg.slot(fg.rosca(fat, { sel: selF, centro: fc.moneyC(total), sub: est.renda ? fc.GRUPOS[est.renda] : 'carteira' }), 'fn-rosca-g')}
    <ul class="fn-leg">${fat.map(f => `<li><button data-fatia="${f.id}" class="${selF === f.id ? 'on' : ''}" aria-pressed="${selF === f.id}">
      <i style="background:${f.cor}"></i><span>${h(f.nome)}</span><b>${fc.pct(f.peso, 1, false)}</b><small>${fc.money(f.valor, 0)}</small></button></li>`).join('')}</ul>
  </div><p class="muted small">Toque numa fatia para filtrar a lista.</p>`);
}

// Investimentos que entram na série quando há filtro (cripto entra pela foto da tela Cripto)
function idsFiltro() {
  if (!filtroAtivo()) return { ids: null, comCripto: true, comContas: true };
  return { ids: new Set(C.vis.filter(a => a.fonte !== 'cripto').map(a => a.id)), comCripto: C.vis.some(a => a.fonte === 'cripto'), comContas: false };
}
function serieFiltrada() {
  const f = idsFiltro();
  if (!f.ids) return C.serie;
  const t = fc.totais(C.vis);
  return comHoje(fc.evolucao({ hist: C.histInv, snaps: C.D.snap, cripto: C.criptoSerie, ...f }), { dia: C.hoje, investido: t.valor, contas: 0, valor: t.valor });
}

function cartaoEvolucao() {
  const desde = fc.inicioPeriodo(est.periodo, C.hoje);
  const pts = serieFiltrada().filter(p => p.dia >= desde);
  const titulo = filtroAtivo() ? 'Evolução (filtro)' : 'Evolução do patrimônio';
  const corpo = pts.length < 2
    ? `<p class="empty">O Hub guarda uma foto do patrimônio a cada sincronização (2x por dia). O gráfico aparece a partir do segundo dia de histórico.</p>`
    : fg.slot(fg.area(pts, { fmt: v => fc.money(v), fmtEixo: fc.moneyC, cor: 'var(--ink-2)', rotulo: filtroAtivo() ? 'Valor' : 'Patrimônio' }));
  const v = pts.length > 1 ? pts[pts.length - 1].valor - pts[0].valor : null;
  return cartao(titulo, corpo, v != null ? `<span class="${v >= 0 ? 'fn-pos' : 'fn-neg'} small">${v >= 0 ? '▲' : '▼'} ${fc.money(Math.abs(v), 0)} no período</span>` : '', 'fn-card-larga');
}

function cartaoProventos() {
  const dias = fc.PERIODOS.find(p => p[0] === est.periodo)[1];
  const meses = dias ? Math.min(24, Math.max(3, Math.round(dias / 30.4))) : 24;
  const f = idsFiltro();
  const movs = C.D.mov.filter(m => m.tipo === 'provento' && (!f.ids || (m.invest_id && f.ids.has(m.invest_id))));
  const lst = fc.proventosPorMes(movs, f.ids ? [] : C.extras, meses, C.hoje);
  const total = lst.reduce((t, x) => t + x.valor, 0);
  const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const itens = lst.map(x => ({ rot: MES[+x.mes.slice(5) - 1], valor: x.valor,
    tip: fg.tipTxt(`${MES[+x.mes.slice(5) - 1]}/${x.mes.slice(0, 4)}`, [['Total', fc.money(x.valor)], ...Object.entries(x.tipos).map(([k, v]) => [fc.PROVENTO_TXT[k] || k, fc.money(v)])]) }));
  return cartao('Proventos por mês', total ? fg.slot(fg.colunas(itens, { fmtEixo: fc.moneyC, cor: 'var(--brand)', rotulo: 'Proventos por mês' }))
    : `<p class="empty">Nenhum provento no período. Lance dividendos, JCP e rendimentos em <b>+ Provento</b>; entradas classificadas como "Rendimentos" no extrato também entram.</p>`,
    total ? `<span class="small muted">${fc.money(total, 0)} em ${meses} meses</span>` : '');
}

// Benchmarks do Banco Central: CDI diário (série 12) e IPCA mensal (série 433), guardados por 12 h
const BKEY = 'hub:fin-bench';
let bench = (() => { try { return JSON.parse(localStorage.getItem(BKEY)) || null; } catch { return null; } })();
let benchCarregando = false;
function carregarBench() {
  if (benchCarregando || (bench && Date.now() - bench.at < 12 * 3600e3)) return;
  benchCarregando = true;
  const br = d => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const iso = s => `${s.slice(6, 10)}-${s.slice(3, 5)}-${s.slice(0, 2)}`;
  const api = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.';
  const hoje = fc.hojeIso();
  // "ultimos/N" aceita no máximo 20 valores: usa intervalo de datas (5 anos)
  const intervalo = `formato=json&dataInicial=${br(fc.somaDias(hoje, -5 * 365))}&dataFinal=${br(hoje)}`;
  Promise.all([fetch(`${api}12/dados?${intervalo}`).then(r => r.json()), fetch(`${api}433/dados?${intervalo}`).then(r => r.json())])
    .then(([cdi, ipca]) => {
      if (!Array.isArray(cdi) || !Array.isArray(ipca)) throw new Error('Banco Central fora do ar');
      bench = { at: Date.now(), cdi: cdi.map(x => [iso(x.data), +x.valor]), ipca: ipca.map(x => [iso(x.data), +x.valor]) };
      try { localStorage.setItem(BKEY, JSON.stringify(bench)); } catch {}
      C?.ctx.rerender();
    })
    .catch(() => {})
    .finally(() => { benchCarregando = false; });
}
function fluxos() {
  const f = idsFiltro();
  const sinal = { aporte: 1, resgate: -1 };
  const l = C.D.mov.filter(m => sinal[m.tipo] && (!f.ids || f.ids.has(m.invest_id))).map(m => ({ data: m.data, valor: sinal[m.tipo] * Number(m.valor || 0) }));
  if (f.comCripto) for (const t of S.crypto_tx || []) {
    const v = (+t.quantidade || 0) * (+t.preco_brl || 0);
    if (t.tipo === 'compra') l.push({ data: t.data, valor: v }); else if (t.tipo === 'venda') l.push({ data: t.data, valor: -v });
  }
  return l;
}
function cartaoBench() {
  carregarBench();
  const desde = fc.inicioPeriodo(est.periodo, C.hoje);
  const titulo = 'Rentabilidade × CDI e IPCA';
  // Opção A: CDI e IPCA só no trecho em que a carteira tem histórico (as três linhas partem do mesmo dia)
  const cmp = fc.comparacao(serieFiltrada(), fluxos(), bench, desde);
  if (!cmp) return cartao(titulo, `<p class="empty">A comparação aparece quando houver pelo menos 2 dias de histórico dos investimentos no período.
    ${bench ? `Para referência: CDI de 12 meses ${fc.pct(fc.acumular(bench.cdi, fc.somaDias(C.hoje, -365), C.hoje))}, IPCA de 12 meses ${fc.pct(fc.acumular(bench.ipca, fc.somaDias(C.hoje, -365), C.hoje))}.` : ''}</p>`);
  const nome = filtroAtivo() ? 'Filtro' : 'Carteira';
  const series = [
    { nome, cor: 'var(--brand)', estilo: 'cheia', grossa: true, vals: cmp.pts.map(p => p.carteira) },
    cmp.pts[0].cdi != null && { nome: 'CDI', cor: 'var(--muted)', estilo: 'tracejada', vals: cmp.pts.map(p => p.cdi) },
    cmp.pts[0].ipca != null && { nome: 'IPCA', cor: 'var(--muted)', estilo: 'pontilhada', vals: cmp.pts.map(p => p.ipca) },
  ].filter(Boolean);
  const pct2 = v => fc.pct(v, 2);
  const dif = (a, b) => `${a >= b ? '+' : '−'}${Math.abs(a - b).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ponto${Math.abs(a - b) >= 1.995 ? 's' : ''}`;
  const dica = i => { const p = cmp.pts[i];
    return fg.tipTxt(fc.dataBr(p.dia), [[nome, pct2(p.carteira)], ...(p.cdi != null ? [['CDI', pct2(p.cdi)], [`${nome} − CDI`, dif(p.carteira, p.cdi)]] : []), ...(p.ipca != null ? [['IPCA', pct2(p.ipca)]] : [])]); };
  const fim = cmp.pts[cmp.pts.length - 1];
  const leg = `<div class="fn-leg-linhas">${series.map(s => `<span>${fg.amostra(s)}${h(s.nome)}</span>`).join('')}</div>`;
  return cartao(titulo, `${leg}${fg.slot(fg.linhas(series, cmp.pts.map(p => p.dia), { fmtEixo: v => Math.abs(v) < 1e-9 ? '0%' : fc.pct(v, Number.isInteger(+v.toFixed(6)) ? 0 : 1), fmtFim: pct2, dica, rotulo: 'Rentabilidade acumulada da carteira, do CDI e do IPCA' }))}
    <p class="muted small">Rendimento acumulado de ${fc.dataBr(cmp.desde)} a ${fc.dataBr(cmp.ate)}, descontando aportes e resgates.
    ${fim.cdi != null ? `${fim.carteira >= fim.cdi ? 'Acima' : 'Abaixo'} do CDI em ${dif(fim.carteira, fim.cdi).slice(1)}.` : ''}
    ${cmp.desde > desde ? `O histórico da carteira começa em ${fc.dataBr(cmp.desde)}, por isso as linhas partem desse dia.` : ''} Ibovespa: sem fonte gratuita disponível.</p>`);
}

function cartaoRanking() {
  const rk = fc.ranking(C.vis);
  const tot = C.tot.valor;
  const item = (a, valor, txt, cor) => ({ id: a.id, nome: a.ticker || a.nome, valor, txt, cor,
    tip: fg.tipTxt(a.nome, [['Valor', fc.money(a.valor)], ['Resultado', a.resultado != null ? `${fc.money(a.resultado)} (${fc.pct(a.resPct)})` : '–'], ['Peso', fc.pct(fc.peso(a, tot), 2, false)]]) });
  const aba = est.rank || 'maiores';
  const lst = aba === 'maiores' ? rk.maiores.map(a => item(a, a.valor, fc.money(a.valor, 0), fc.corClasse(a.classe)))
    : (aba === 'altas' ? rk.altas : rk.baixas).map(a => item(a, a.resPct, fc.pct(a.resPct), a.resPct >= 0 ? 'var(--up)' : 'var(--down)'));
  return cartao('Ranking', `${lst.length ? fg.barrasH(lst, { attr: 'data-ativo', diverge: aba !== 'maiores' }) : `<p class="empty">${aba === 'maiores' ? 'Nenhum ativo.' : aba === 'altas' ? 'Nenhum ativo no positivo.' : 'Nenhum ativo no negativo.'}</p>`}`,
    `<div class="seg seg-sm" role="tablist">${[['maiores', 'Maiores'], ['altas', 'Altas'], ['baixas', 'Baixas']].map(([k, l]) => `<button data-rank="${k}" class="${k === aba ? 'on' : ''}" aria-selected="${k === aba}">${l}</button>`).join('')}</div>`);
}

function cartaoVencimentos() {
  const lst = fc.vencimentos(C.vis, 12, C.hoje);
  if (!lst.length) return cartao('Vencimentos (12 meses)', '<p class="empty">Nenhum título de renda fixa vence nos próximos 12 meses.</p>');
  const itens = lst.map(a => ({ id: a.id, dia: a.vence, valor: a.valor || 0, cor: fc.corClasse(a.classe),
    tip: fg.tipTxt(a.nome, [['Vence', `${fc.dataBr(a.vence)} (${a.dias} dias)`], ['Valor', fc.money(a.valor)], ['Rende', a.taxa || '–']]) }));
  return cartao('Vencimentos (12 meses)', `${fg.slot(fg.linhaTempo(itens, C.hoje))}
    <ul class="fn-venc">${lst.slice(0, 4).map(a => `<li data-ativo="${h(a.id)}" tabindex="0" role="button" class="${a.dias <= 30 ? 'fn-logo' : ''}">
      <span>${h(a.nome)}</span><b>${fc.dataBr(a.vence)}</b><small>${a.dias === 0 ? 'hoje' : `em ${a.dias} dia${a.dias > 1 ? 's' : ''}`} · ${fc.money(a.valor, 0)}</small></li>`).join('')}</ul>`);
}

// ---------- Listas ----------
const VIS = [['tabela', 'Tabela'], ['cards', 'Cards'], ['grafico', 'Gráfico']];
function listas() {
  const tot = C.tot.valor;
  const rv = C.vis.filter(a => a.grupo === 'rv'), rf = C.vis.filter(a => a.grupo === 'rf');
  const tRv = fc.totais(rv), tRf = fc.totais(rf);
  const seg = `<div class="seg seg-sm" role="tablist" aria-label="Visualização">${VIS.map(([k, l]) => `<button data-vis="${k}" class="${k === est.vis ? 'on' : ''}" aria-selected="${k === est.vis}">${l}</button>`).join('')}</div>`;
  if (!rv.length && !rf.length) return `<p class="empty">Nenhum ativo com esse filtro.</p>`;
  return `${rv.length ? `<section class="fn-grupo">
      <div class="fn-grupo-h"><h2>Renda variável</h2><b>${fc.money(tRv.valor, 0)}</b><span class="muted">${fc.pct(tot ? tRv.valor / tot * 100 : 0, 2, false)} da carteira</span>${seg}</div>
      ${fc.porClasse(rv, tot).map(blocoClasse).join('')}</section>` : ''}
    ${rf.length ? `<section class="fn-grupo">
      <div class="fn-grupo-h"><h2>Renda fixa</h2><b>${fc.money(tRf.valor, 0)}</b><span class="muted">${fc.pct(C.patrimonio ? tRf.valor / C.patrimonio * 100 : 0, 2, false)} do patrimônio</span>${rv.length ? '' : seg}</div>
      ${fc.porClasse(rf, tot).map(blocoClasse).join('')}</section>` : ''}`;
}

const COLS_RV = [['nome', 'Ativo'], ['qtd', 'Qtd.', 1], ['pm', 'Preço médio', 1], ['preco', 'Preço atual', 1], ['valor', 'Valor', 1], ['resultado', 'Resultado', 1], ['peso', 'Peso', 1]];
const COLS_RF = [['nome', 'Título'], ['taxa', 'Rentabilidade'], ['custo', 'Aplicado', 1], ['valor', 'Atual', 1], ['vence', 'Vencimento'], ['liq', 'Liquidez']];
function blocoClasse(g) {
  const o = est.ordem[g.classe] || { col: 'valor', dir: -1 };
  // Títulos da mesma classe, nome e rentabilidade viram uma linha (fc.agrupar)
  const ativos = fc.ordenar(fc.agrupar(g.ativos), o.col, o.dir);
  ativos.filter(a => a.itens).forEach(a => C.grupos.set(a.id, a));
  const aberto = !est.fechados.has(g.classe);
  const cor = fc.corClasse(g.classe);
  const ord = `<div class="fn-ord" role="group" aria-label="Ordenar">Ordenar: ${[['valor', 'Valor'], ['resultado', 'Resultado'], ['peso', 'Peso'], ...(g.grupo === 'rf' ? [['vence', 'Vencimento']] : [])]
    .map(([k, l]) => `<button data-ord="${g.classe}:${k}" class="${o.col === k ? 'on' : ''}">${l}${o.col === k ? (o.dir < 0 ? ' ↓' : ' ↑') : ''}</button>`).join('')}</div>`;
  const corpo = est.vis === 'cards' ? `<div class="fn-ativos-cards">${ativos.map(a => cardAtivo(a, cor)).join('')}</div>`
    : est.vis === 'grafico' ? fg.barrasH(ativos.filter(a => a.valor != null).map(a => ({ id: a.id, nome: a.ticker || a.nome, valor: a.valor, txt: fc.money(a.valor, 0), cor,
      tip: fg.tipTxt(a.nome, [['Valor', fc.money(a.valor)], ['Peso', fc.pct(fc.peso(a, C.tot.valor), 2, false)]]) })), { attr: 'data-ativo' })
      : tabela(g, ativos, o);
  return `<details class="fn-cl" data-cl="${g.classe}" ${aberto ? 'open' : ''}>
    <summary><i class="fn-dot-cl" style="background:${cor}"></i><span class="fn-cl-n">${h(g.nome)}</span><small class="muted">${g.n} ativo${g.n === 1 ? '' : 's'}${ativos.length < g.ativos.length ? ` em ${ativos.length} grupo${ativos.length === 1 ? '' : 's'}` : ''}</small>
      <b>${fc.money(g.valor, 0)}</b><span class="fn-cl-p">${fc.pct(g.peso, 2, false)}</span>
      ${g.resPct != null ? `<span class="${g.resultado >= 0 ? 'fn-pos' : 'fn-neg'} fn-cl-r">${fc.pct(g.resPct)}</span>` : ''}</summary>
    <div class="fn-cl-b">${ord}${corpo}</div>
  </details>`;
}

function tabela(g, ativos, o) {
  const cols = g.grupo === 'rv' ? COLS_RV : COLS_RF;
  const th = cols.map(([k, l, num]) => {
    const ordena = ['nome', 'valor', 'resultado', 'peso', 'vence'].includes(k);
    const on = o.col === k;
    return `<th class="${num ? 'num' : ''}" ${on ? `aria-sort="${o.dir < 0 ? 'descending' : 'ascending'}"` : ''}>${ordena ? `<button data-ord="${g.classe}:${k}">${l}${on ? (o.dir < 0 ? ' ↓' : ' ↑') : ''}</button>` : l}</th>`;
  }).join('');
  const linha = (a, sub) => g.grupo === 'rv' ? linhaRv(a, sub) : linhaRf(a, sub);
  return `<div class="table-wrap"><table class="table fn-tx fn-at"><thead><tr>${th}</tr></thead><tbody>${ativos.map(a => a.itens
    ? linhaGrupo(g, a) + (est.abertos.has(a.id) ? fc.ordenar(a.itens, 'vence', 1).map(x => linha(x, true)).join('') : '')
    : linha(a)).join('')}</tbody></table></div>`;
}
// Linha-resumo de um grupo de títulos; clique abre/fecha os títulos logo abaixo
function linhaGrupo(g, a) {
  const aberto = est.abertos.has(a.id);
  const nome = `<td><div class="fn-desc"><span class="fn-caret" aria-hidden="true">${aberto ? '▾' : '▸'}</span>${a.ticker ? `<b>${h(a.ticker)}</b> ` : ''}${h(a.ticker && a.ticker !== a.nome ? '' : a.nome)}${a.tesouro ? ` <span class="chip-static">${a.tesouro}</span>` : ''}</div>
    <small class="muted"><span class="fn-badge fn-badge-n">${a.nItens} títulos</span> ${h(subtitulo(a))}</small></td>`;
  const venc = a.vence ? `${fc.dataBr(a.vence)}${a.venceAte ? ` a ${fc.dataBr(a.venceAte)}` : ''}<br><small class="${a.dias != null && a.dias <= 30 ? 'fn-badge fn-badge-alerta' : 'muted'}">${a.dias != null ? `próximo em ${a.dias} dias` : ''}</small>` : '<span class="muted">sem vencimento</span>';
  const cls = `fn-grp ${a.oculta ? 'fn-fora' : ''} ${a.dias != null && a.dias <= 30 ? 'fn-vence-logo' : ''}`;
  const attrs = `data-grp="${h(a.id)}" tabindex="0" role="button" aria-expanded="${aberto}"`;
  return g.grupo === 'rv'
    ? `<tr class="${cls}" ${attrs}>${nome}<td class="num">${fc.qtdTxt(a.qtd)}</td><td class="num">${a.pm != null ? fc.money(a.pm) : '–'}</td><td class="num">${a.preco != null ? fc.money(a.preco) : '–'}</td>
      <td class="num"><b>${fc.money(a.valor)}</b></td><td class="num">${res(a)}</td><td class="num">${fc.pct(fc.peso(a, C.tot.valor), 2, false)}</td></tr>`
    : `<tr class="${cls}" ${attrs}>${nome}<td>${h(a.taxa) || '<span class="muted">–</span>'}</td><td class="num">${fc.money(a.custo)}</td>
      <td class="num"><b>${fc.money(a.valor)}</b>${a.resultado != null ? `<br><small class="${a.resultado >= 0 ? 'fn-pos' : 'fn-neg'}">${fc.money(a.resultado)}</small>` : ''}</td>
      <td>${venc}</td><td>${a.liquidez.txt ? `<span class="${a.liquidez.diaria ? 'fn-badge fn-badge-liq' : ''}">${h(a.liquidez.txt)}</span>` : '–'}</td></tr>`;
}
// Emissor e origem, sem repetir o que já está no nome
const subtitulo = a => [a.emissor && !a.nome.toLowerCase().includes(a.emissor.toLowerCase()) ? a.emissor : '', origem(a)].filter(Boolean).join(' · ');
function detalheGrupo(a) {
  if (!a) return;
  const itens = fc.ordenar(a.itens, 'vence', 1);
  const d = modal(`${a.ticker || a.nome} · ${a.nItens} títulos`, `
    <div class="fn-det-kpis">
      <div><span>Valor atual</span><b>${fc.money(a.valor)}</b></div>
      <div><span>Aplicado</span><b>${fc.money(a.custo)}</b></div>
      <div><span>Resultado</span><b class="${(a.resultado ?? 0) >= 0 ? 'fn-pos' : 'fn-neg'}">${fc.money(a.resultado)}</b><small>${fc.pct(a.resPct)}</small></div>
      <div><span>Peso</span><b>${fc.pct(fc.peso(a, C.tot.valor), 2, false)}</b></div>
    </div>
    <p class="muted small">${h([a.taxa, subtitulo(a)].filter(Boolean).join(' · '))}. Toque num título para ver os detalhes dele.</p>
    <div class="table-wrap"><table class="table fn-tx fn-at"><thead><tr><th>Vencimento</th><th class="num">Aplicado</th><th class="num">Atual</th><th class="num">Resultado</th></tr></thead><tbody>
      ${itens.map(x => `<tr data-item="${h(x.id)}" tabindex="0" class="${x.oculta ? 'fn-fora' : ''}"><td>${x.vence ? `${fc.dataBr(x.vence)}<br><small class="muted">em ${x.dias} dias</small>` : (x.ticker || x.nome)}</td>
        <td class="num">${fc.money(x.custo)}</td><td class="num"><b>${fc.money(x.valor)}</b></td><td class="num">${res(x)}</td></tr>`).join('')}
    </tbody></table></div>`);
  d.querySelector('#modalBody').classList.add('fn-det');
  d.querySelectorAll('tr[data-item]').forEach(r => r.onclick = () => detalhe(r.dataset.item));
}
const res = a => a.resultado == null ? '<span class="muted">–</span>'
  : `<span class="${a.resultado >= 0 ? 'fn-pos' : 'fn-neg'}">${fc.money(a.resultado)}<br><small>${fc.pct(a.resPct)}</small></span>`;
const origem = a => a.fonte === 'manual' ? 'cadastrado no Hub' : a.fonte === 'cripto' ? 'tela Cripto' : nomeBanco(a.item_id);
const nomeBanco = id => C.D.items.find(x => x.id === id)?.nome || 'banco';
function linhaRv(a, sub = false) {
  return `<tr data-ativo="${h(a.id)}" class="${a.oculta ? 'fn-fora' : ''} ${sub ? 'fn-sub' : ''}" tabindex="0">
    <td><div class="fn-desc">${a.ticker ? `<b>${h(a.ticker)}</b> ` : ''}${a.ticker && a.ticker !== a.nome ? `<span class="muted">${h(a.nome)}</span>` : a.ticker ? '' : h(a.nome)}</div>
      <small class="muted">${h(a.fonte === 'cripto' ? a.emissor || 'tela Cripto' : origem(a))}${a.semPreco ? ' · sem cotação' : ''}${a.oculta ? ' · fora dos totais' : ''}</small>
      ${a.divergente ? '<br><small class="fn-badge fn-badge-alerta">carteira ≠ lançado</small>' : ''}</td>
    <td class="num">${fc.qtdTxt(a.qtd)}</td><td class="num">${a.pm != null ? fc.money(a.pm) : '<span class="muted" title="Lance as compras na tela Cripto">–</span>'}</td><td class="num">${a.preco != null ? fc.money(a.preco) : '<span class="muted">–</span>'}</td>
    <td class="num"><b>${fc.money(a.valor)}</b></td><td class="num">${res(a)}</td><td class="num">${fc.pct(fc.peso(a, C.tot.valor), 2, false)}</td>
  </tr>`;
}
function vencTxt(a) {
  if (!a.vence) return '<span class="muted">sem vencimento</span>';
  const logo = a.dias != null && a.dias <= 30;
  return `${fc.dataBr(a.vence)}<br><small class="${logo ? 'fn-badge fn-badge-alerta' : 'muted'}">${a.dias < 0 ? 'vencido' : a.dias === 0 ? 'vence hoje' : `em ${a.dias} dias`}</small>`;
}
function linhaRf(a, sub = false) {
  return `<tr data-ativo="${h(a.id)}" class="${a.oculta ? 'fn-fora' : ''} ${sub ? 'fn-sub' : ''} ${a.dias != null && a.dias <= 30 && a.dias >= 0 ? 'fn-vence-logo' : ''}" tabindex="0">
    <td><div class="fn-desc">${sub ? '↳ Título' : h(a.nome)}${a.tesouro && !sub ? ` <span class="chip-static">${a.tesouro}</span>` : ''}</div>
      <small class="muted">${h(sub ? origem(a) : subtitulo(a))}${a.oculta ? ' · fora dos totais' : ''}</small></td>
    <td>${h(a.taxa) || '<span class="muted">–</span>'}${a.rend12m != null ? `<br><small class="muted">${fc.pct(a.rend12m, 2, false)} em 12 meses</small>` : ''}</td>
    <td class="num">${fc.money(a.custo)}</td>
    <td class="num"><b>${fc.money(a.valor)}</b>${a.resultado != null ? `<br><small class="${a.resultado >= 0 ? 'fn-pos' : 'fn-neg'}">${fc.money(a.resultado)}</small>` : ''}</td>
    <td>${vencTxt(a)}</td>
    <td>${a.liquidez.txt ? `<span class="${a.liquidez.diaria ? 'fn-badge fn-badge-liq' : ''}">${h(a.liquidez.txt)}</span>` : '<span class="muted">–</span>'}</td>
  </tr>`;
}
function cardAtivo(a, cor) {
  if (a.itens) return `<button class="fn-acard fn-acard-grp ${a.oculta ? 'fn-fora' : ''}" data-ativo="${h(a.id)}" style="--c:${cor}">
    <span class="fn-acard-n">${h(a.ticker || a.nome)}</span><small><span class="fn-badge fn-badge-n">${a.nItens} títulos</span> ${h(a.taxa)}</small>
    <b>${fc.money(a.valor)}</b>
    ${a.resultado != null ? `<small class="${a.resultado >= 0 ? 'fn-pos' : 'fn-neg'}">${fc.money(a.resultado)} (${fc.pct(a.resPct)})</small>` : ''}
    <small class="muted">${a.vence ? `vencimentos de ${fc.dataBr(a.vence)}${a.venceAte ? ` a ${fc.dataBr(a.venceAte)}` : ''}` : ''}</small>
  </button>`;
  return `<button class="fn-acard ${a.oculta ? 'fn-fora' : ''} ${a.grupo === 'rf' && a.dias != null && a.dias <= 30 && a.dias >= 0 ? 'fn-vence-logo' : ''}" data-ativo="${h(a.id)}" style="--c:${cor}">
    <span class="fn-acard-n">${h(a.ticker || a.nome)}</span>${a.ticker && a.ticker !== a.nome ? `<small class="muted">${h(a.nome)}</small>` : ''}
    <b>${fc.money(a.valor)}</b>
    ${a.resultado != null ? `<small class="${a.resultado >= 0 ? 'fn-pos' : 'fn-neg'}">${fc.money(a.resultado)} (${fc.pct(a.resPct)})</small>` : ''}
    <small class="muted">${a.grupo === 'rf' ? [a.taxa, a.vence ? `vence ${fc.dataBr(a.vence)}` : '', a.liquidez.diaria ? 'liquidez diária' : ''].filter(Boolean).join(' · ')
      : `${fc.qtdTxt(a.qtd)} × ${fc.money(a.preco ?? a.pm)} · peso ${fc.pct(fc.peso(a, C.tot.valor), 1, false)}`}</small>
  </button>`;
}

// ---------- Eventos ----------
export function ligar(el, ctx) {
  const re = () => ctx.rerender();
  el.querySelectorAll('[data-per]').forEach(b => b.onclick = () => { est.periodo = b.dataset.per; guardar(); re(); });
  el.querySelectorAll('[data-renda]').forEach(b => b.onclick = () => { est.renda = b.dataset.renda; if (est.classe && !est.classe.startsWith('f:') && fc.CLASSES[est.classe]?.grupo !== est.renda && est.renda) est.classe = ''; re(); });
  el.querySelector('#fnCl')?.addEventListener('change', e => { est.classe = e.target.value; re(); });
  const bq = el.querySelector('#fnBusca');
  if (bq) bq.oninput = () => { est.q = bq.value; const p = bq.selectionStart; re(); const n = el.querySelector('#fnBusca'); n?.focus(); n?.setSelectionRange(p, p); };
  el.querySelector('#fnLimparF')?.addEventListener('click', () => { est.classe = ''; est.renda = ''; est.q = ''; re(); });
  el.querySelectorAll('[data-fatia]').forEach(b => {
    const ir = () => { const v = 'f:' + b.dataset.fatia; est.classe = est.classe === v ? '' : v; re(); };
    b.onclick = ir; b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ir(); } };
  });
  el.querySelectorAll('[data-rank]').forEach(b => b.onclick = () => { est.rank = b.dataset.rank; re(); });
  el.querySelectorAll('[data-vis]').forEach(b => b.onclick = () => { est.vis = b.dataset.vis; guardar(); re(); });
  el.querySelectorAll('[data-ord]').forEach(b => b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const [cl, col] = b.dataset.ord.split(':'); const o = est.ordem[cl] || { col: 'valor', dir: -1 };
    est.ordem[cl] = { col, dir: o.col === col ? -o.dir : (col === 'nome' || col === 'vence' ? 1 : -1) }; guardar(); re();
  });
  el.querySelectorAll('details.fn-cl').forEach(d => d.addEventListener('toggle', () => { if (d.open) est.fechados.delete(d.dataset.cl); else est.fechados.add(d.dataset.cl); guardar(); }));
  el.querySelectorAll('[data-ativo]').forEach(r => {
    const abrir = () => detalhe(r.dataset.ativo);
    r.addEventListener('click', abrir);
    if (r.tagName !== 'BUTTON') r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
  });
  el.querySelectorAll('tr[data-grp]').forEach(r => {
    const alternar = () => { const id = r.dataset.grp; if (est.abertos.has(id)) est.abertos.delete(id); else est.abertos.add(id); re(); };
    r.addEventListener('click', alternar);
    r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alternar(); } });
  });
  el.querySelectorAll('[data-novo]').forEach(b => b.onclick = () => b.dataset.novo === 'ativo' ? formAtivo() : formMov(b.dataset.novo));
  el.querySelectorAll('[data-ir]').forEach(b => b.onclick = () => ctx.irAba(b.dataset.ir));
  fg.montar(el);
}

// Cotações de cripto: usa o cache da tela Cripto e atualiza se estiver velho ou faltar moeda.
// Pede junto as moedas do quadro da tela Cripto (a consulta substitui o cache inteiro).
let tentou = '';
function precosCripto() {
  const ids = C.cripto.map(a => a.coin_id).filter(Boolean);
  if (!ids.length || criptoAtualizando()) return;
  const falta = ids.some(id => !M.coins[id]);
  if (Date.now() - (M.at || 0) < VELHO_MS && (!falta || tentou === ids.join())) return;
  tentou = ids.join();
  atualizarCripto([...ids, ...(S.crypto_watch || []).map(w => w.coin_id)]).then(() => C?.ctx.rerender()).catch(() => {});
}

// ---------- Detalhe do ativo ----------
const TIPO_MOV = { aporte: 'Aporte', resgate: 'Resgate', provento: 'Provento', imposto: 'Imposto', transferencia: 'Transferência' };
function detalhe(id) {
  if (id.startsWith('grp:')) return detalheGrupo(C.grupos.get(id));
  const a = C.todos.find(x => x.id === id);
  if (!a) return;
  const movs = C.D.mov.filter(m => m.invest_id === id).sort((x, y) => y.data.localeCompare(x.data));
  const prov = movs.filter(m => m.tipo === 'provento').reduce((t, m) => t + Number(m.valor || 0), 0);
  const hist = C.D.hist.filter(r => r.invest_id === id).sort((x, y) => x.dia.localeCompare(y.dia)).map(r => ({ dia: r.dia, valor: Number(r.saldo || 0) }));
  const pts = a.valor != null ? [...hist.filter(p => p.dia !== C.hoje), { dia: C.hoje, valor: a.valor }] : hist;
  const info = [
    ['Classe', fc.CLASSES[a.classe].nome + (a.tesouro ? ` (${a.tesouro})` : '')], ['Origem', origem(a)],
    a.qtd != null && ['Quantidade', fc.qtdTxt(a.qtd)], a.pm != null && ['Preço médio', fc.money(a.pm)], a.preco != null && ['Preço atual', fc.money(a.preco)],
    a.taxa && ['Rentabilidade', a.taxa], a.emissor && ['Emissor / onde está', a.emissor],
    a.vence && ['Vencimento', `${fc.dataBr(a.vence)} (${a.dias < 0 ? 'vencido' : `em ${a.dias} dias`})`], a.liquidez.txt && ['Liquidez', a.liquidez.txt],
    a.liquido != null && ['Valor líquido de resgate', fc.money(a.liquido)], prov && ['Proventos recebidos', fc.money(prov)],
  ].filter(Boolean);
  fg.limpar();
  const graf = pts.length > 1 ? fg.slot(fg.area(pts, { fmt: v => fc.money(v), fmtEixo: fc.moneyC, cor: fc.corClasse(a.classe), alt: 180, rotulo: 'Valor' })) : '';
  const d = modal(a.ticker ? `${a.ticker} · ${a.nome}` : a.nome, `
    <div class="fn-det-kpis">
      <div><span>Valor atual</span><b>${fc.money(a.valor)}</b></div>
      <div><span>Custo</span><b>${fc.money(a.custo)}</b></div>
      <div><span>Resultado</span><b class="${(a.resultado ?? 0) >= 0 ? 'fn-pos' : 'fn-neg'}">${fc.money(a.resultado)}</b><small>${fc.pct(a.resPct)}</small></div>
      <div><span>Peso</span><b>${fc.pct(fc.peso(a, C.tot.valor), 2, false)}</b></div>
    </div>
    ${graf || '<p class="muted small">O gráfico deste ativo aparece depois de 2 dias de histórico.</p>'}
    <dl class="fn-det-info">${info.map(([k, v]) => `<dt>${h(k)}</dt><dd>${h(v)}</dd>`).join('')}</dl>
    ${a.porLocal?.length ? `<h3 class="fn-det-h">Onde está</h3><div class="table-wrap"><table class="table fn-tx"><thead><tr><th>Local</th><th class="num">Quantidade</th><th class="num">Valor</th></tr></thead><tbody>
      ${a.porLocal.map(l => `<tr><td>${h(l.onde)}<br><small class="muted">${l.blockchain ? 'lido da blockchain' : 'compras lançadas na tela Cripto'}</small></td><td class="num">${fc.qtdTxt(l.qtd)}</td><td class="num">${a.preco != null ? fc.money(l.qtd * a.preco) : '–'}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${a.divergente ? `<p class="banner warn">Na tela Cripto estão lançados ${fc.qtdTxt(a.divergente.lancado)} ${h(a.ticker)} na carteira, mas a blockchain mostra ${fc.qtdTxt(a.divergente.carteira)}. O Painel usa o valor da blockchain; o preço médio vem das compras lançadas.</p>` : ''}
    ${a.fonte === 'cripto' && a.semCusto ? '<p class="muted small">Sem compras lançadas na tela Cripto, não dá para calcular preço médio e resultado desta moeda.</p>' : ''}
    <h3 class="fn-det-h">Histórico de movimentos</h3>
    ${movs.length ? `<div class="table-wrap"><table class="table fn-tx"><thead><tr><th>Data</th><th>Tipo</th><th class="num">Valor</th><th class="num">Qtd.</th><th></th></tr></thead><tbody>
      ${movs.map(m => `<tr><td class="fn-data">${fc.dataBr(m.data)}</td><td>${TIPO_MOV[m.tipo] || h(m.tipo)}${m.tipo === 'provento' && m.subtipo ? ` <small class="muted">${h(fc.PROVENTO_TXT[m.subtipo] || m.subtipo)}</small>` : ''}
        ${m.descricao ? `<br><small class="muted">${h(m.descricao)}</small>` : ''}</td><td class="num">${fc.money(m.valor)}</td><td class="num">${m.quantidade != null ? fc.qtdTxt(m.quantidade) : ''}</td>
        <td>${m.fonte === 'manual' ? `<button type="button" class="link-btn fn-del-mov" data-mov="${h(m.id)}" aria-label="Excluir movimento">Excluir</button>` : '<small class="muted">banco</small>'}</td></tr>`).join('')}
    </tbody></table></div>` : `<p class="muted small">${a.fonte === 'cripto' ? 'As compras e vendas de cripto ficam na tela Cripto.' : 'Nenhum movimento registrado.'}</p>`}
    <div class="fn-det-acoes">
      ${a.fonte === 'cripto' ? '<a class="btn primary" href="#/cripto">Abrir na tela Cripto</a>' : `
        <button type="button" class="btn" data-dm="aporte">+ Aporte</button><button type="button" class="btn" data-dm="resgate">+ Resgate</button>
        <button type="button" class="btn" data-dm="provento">+ Provento</button>
        <button type="button" class="btn" data-dm="editar">${a.fonte === 'manual' ? 'Editar' : 'Ajustar'}</button>
        ${a.fonte === 'manual' ? '<button type="button" class="btn danger" data-dm="excluir">Excluir</button>' : ''}`}
    </div>`);
  d.querySelector('#modalBody').classList.add('fn-det');
  fg.montar(d.querySelector('#modalBody'));
  d.querySelector('a[href="#/cripto"]')?.addEventListener('click', () => closeModal());
  d.querySelectorAll('[data-dm]').forEach(b => b.onclick = async () => {
    const acao = b.dataset.dm;
    if (acao === 'editar') return a.fonte === 'manual' ? formAtivo(a) : formAjuste(a);
    if (acao === 'excluir') {
      if (!confirm(`Excluir "${a.nome}" e os movimentos dele? Isso não pode ser desfeito.`)) return;
      try { await db.remove('fin_invest', a.id); closeModal(); toast('Ativo excluído'); await C.ctx.recarregar(); } catch (e) { toast(e.message, 5000); }
      return;
    }
    formMov(acao, a.id);
  });
  d.querySelectorAll('.fn-del-mov').forEach(b => b.onclick = async () => {
    if (!confirm('Excluir este movimento?')) return;
    try { await db.remove('fin_inv_mov', b.dataset.mov); toast('Movimento excluído'); await C.ctx.recarregar(); detalhe(id); } catch (e) { toast(e.message, 5000); }
  });
}

// ---------- Formulários ----------
const opt = (v, l, sel) => `<option value="${h(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${h(l)}</option>`;
const optClasses = sel => Object.entries(fc.GRUPOS).map(([g, gl]) => `<optgroup label="${gl}">${fc.ORDEM_CLASSES.filter(c => fc.CLASSES[c].grupo === g && c !== 'cripto')
  .map(c => opt(c, fc.CLASSES[c].nome, sel)).join('')}</optgroup>`).join('');
const LIQ = [['', 'Automática'], ['diaria', 'Diária'], ['D+1', 'D+1'], ['D+2', 'D+2'], ['D+30', 'D+30'], ['vencimento', 'No vencimento']];
// Aceita "1.234,56" (pt-BR) e "1234.56"
const num = v => {
  if (v === '' || v == null) return null;
  const s = String(v).trim().replace(/\s|R\$/g, '');
  return Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
};
const numOk = (v, nome, { obrig = false, pos = false } = {}) => {
  if (v == null) { if (obrig) throw new Error(`Informe ${nome}.`); return; }
  if (isNaN(v)) throw new Error(`Confira ${nome}: não é um número (use 1.234,56).`);
  if (v < 0 || (pos && v === 0)) throw new Error(`${nome[0].toUpperCase() + nome.slice(1)} deve ser maior que zero.`);
};
const campoNum = (name, label, v, extra = '') => `<label>${label}<input name="${name}" inputmode="decimal" value="${v ?? ''}" ${extra}></label>`;

// Novo ativo / editar ativo manual
function formAtivo(a) {
  const r = a?.raw || {};
  const ind = /CDI/i.test(r.taxa_tipo || '') ? 'CDI' : /SELIC/i.test(r.taxa_tipo || '') ? 'SELIC' : /IPCA/i.test(r.taxa_tipo || '') ? 'IPCA' : r.taxa_fixa ? 'PRE' : '';
  modal(a ? 'Editar ativo' : 'Novo ativo', `<div class="grid2">
    <label class="span2">Nome<input name="nome" required value="${h(r.nome || '')}" placeholder="Ex.: Petrobras PN, CDB Banco Inter 2028"></label>
    <label>Classe<select name="classe" id="faClasse" required>${optClasses(a?.classe || 'acoes')}</select></label>
    <label>Ticker / código<input name="ticker" value="${h(r.ticker || '')}" placeholder="PETR4" autocapitalize="characters"></label>
    <div class="span2 grid2 fa-rv">
      ${campoNum('quantidade', 'Quantidade', r.quantidade)}${campoNum('preco_medio', 'Preço médio (R$)', r.preco_medio)}
      ${campoNum('preco_atual', 'Preço atual (R$, opcional)', r.preco_atual)}
    </div>
    <div class="span2 grid2 fa-rf">
      ${campoNum('aplicado', 'Valor aplicado (R$)', r.aplicado)}${campoNum('saldo', 'Valor atual (R$)', r.saldo)}
      <label>Indexador<select name="indexador">${[['', '—'], ['CDI', '% do CDI'], ['SELIC', 'Selic +'], ['IPCA', 'IPCA +'], ['PRE', 'Prefixado (% a.a.)']].map(([k, l]) => opt(k, l, ind)).join('')}</select></label>
      ${campoNum('taxa', 'Taxa (%)', ind === 'CDI' ? r.taxa : r.taxa_fixa ?? r.taxa)}
      <label>Vencimento<input name="vence" type="date" value="${h(r.vence || '')}"></label>
      <label>Liquidez<select name="liquidez">${LIQ.map(([k, l]) => opt(k, l, r.liquidez || '')).join('')}</select></label>
    </div>
    <label class="span2">Emissor / corretora<input name="emissor" value="${h(r.emissor || '')}" placeholder="Ex.: XP, Banco Inter"></label>
  </div>`, {
    submit: a ? 'Salvar' : 'Cadastrar',
    onSubmit: async f => {
      const classe = f.classe, rf = fc.CLASSES[classe].grupo === 'rf';
      if (!f.nome.trim()) throw new Error('Informe o nome.');
      const q = num(f.quantidade), pm = num(f.preco_medio), pa = num(f.preco_atual), ap = num(f.aplicado), sd = num(f.saldo), tx = num(f.taxa);
      const row = { nome: f.nome.trim(), ticker: f.ticker.trim().toUpperCase() || null, classe, emissor: f.emissor.trim() || null, fonte: 'manual',
        tipo: rf ? 'FIXED_INCOME' : 'EQUITY', status: 'ACTIVE', atualizado_em: new Date().toISOString() };
      if (rf) {
        numOk(ap, 'o valor aplicado', { obrig: sd == null, pos: true }); numOk(sd, 'o valor atual'); numOk(tx, 'a taxa');
        Object.assign(row, { aplicado: ap ?? sd, saldo: sd ?? ap, rendimento: null, vence: f.vence || null, liquidez: f.liquidez || null,
          taxa_tipo: f.indexador === 'PRE' ? 'PRE' : f.indexador || null, taxa: f.indexador === 'CDI' ? tx : null, taxa_fixa: ['IPCA', 'SELIC', 'PRE'].includes(f.indexador) ? tx : null,
          quantidade: null, preco_medio: null, preco_atual: null });
      } else {
        numOk(q, 'a quantidade', { obrig: true, pos: true }); numOk(pm, 'o preço médio', { obrig: true, pos: true }); numOk(pa, 'o preço atual');
        Object.assign(row, { quantidade: q, preco_medio: pm, preco_atual: pa, aplicado: q * pm, saldo: q * (pa ?? pm), rendimento: null, vence: null, liquidez: null });
      }
      if (a) await db.update('fin_invest', a.id, row);
      else await db.insert('fin_invest', { id: 'man-' + crypto.randomUUID(), ...row });
      toast(a ? 'Ativo atualizado' : 'Ativo cadastrado');
      await C.ctx.recarregar();
    },
  });
  const sel = document.getElementById('faClasse');
  const troca = () => { const rf = fc.CLASSES[sel.value].grupo === 'rf'; document.querySelector('.fa-rv').hidden = rf; document.querySelector('.fa-rf').hidden = !rf; };
  sel.onchange = troca; troca();
}

// Ajustes num investimento que vem do banco: o saldo continua vindo do banco
function formAjuste(a) {
  const r = a.raw;
  modal('Ajustar ' + (a.ticker || a.nome), `<p class="muted small">Os valores vêm do banco e são atualizados todo dia. Aqui você só ajusta como o Hub classifica este ativo.</p>
    <div class="grid2">
      <label>Classe<select name="classe"><option value="">Automática (${h(fc.CLASSES[fc.classeDe({ ...r, classe: null })].nome)})</option>${optClasses(r.classe)}</select></label>
      <label>Ticker / código<input name="ticker" value="${h(r.ticker || '')}"></label>
      <label>Liquidez<select name="liquidez">${LIQ.map(([k, l]) => opt(k, l, r.liquidez || '')).join('')}</select></label>
      <label class="span2 chk"><input type="checkbox" name="oculta" ${r.oculta ? 'checked' : ''}> Deixar fora dos totais (ex.: reserva da empresa ou de outra pessoa)</label>
    </div>`, {
    onSubmit: async f => {
      await db.update('fin_invest', a.id, { classe: f.classe || null, ticker: f.ticker.trim().toUpperCase() || null, liquidez: f.liquidez || null, oculta: !!f.oculta });
      toast('Ajuste salvo'); await C.ctx.recarregar();
    },
  });
}

// Aporte, resgate ou provento (ativo opcional no provento)
function formMov(tipo, ativoId = '') {
  const lista = C.todos.filter(x => x.fonte !== 'cripto');
  if (tipo !== 'provento' && !lista.length) return toast('Cadastre um ativo primeiro (+ Ativo).', 4000);
  const titulo = { aporte: 'Novo aporte', resgate: 'Novo resgate', provento: 'Novo provento' }[tipo];
  modal(titulo, `<div class="grid2">
    <label class="span2">Ativo<select name="ativo" id="fmAtivo" ${tipo === 'provento' ? '' : 'required'}>${tipo === 'provento' ? opt('', 'Sem ativo específico', ativoId) : opt('', 'Escolha…', ativoId)}
      ${lista.map(x => opt(x.id, `${x.ticker ? x.ticker + ' · ' : ''}${x.nome}`, ativoId)).join('')}</select></label>
    <label>Data<input name="data" type="date" required value="${fc.hojeIso()}" max="${fc.hojeIso()}"></label>
    ${campoNum('valor', 'Valor (R$)', '', 'required')}
    ${tipo === 'provento' ? `<label>Tipo<select name="subtipo">${Object.entries(fc.PROVENTO_TXT).map(([k, l]) => opt(k, l, 'dividendo')).join('')}</select></label>`
      : campoNum('quantidade', 'Quantidade (opcional)', '')}
    <label class="span2">Descrição (opcional)<input name="descricao"></label>
  </div><p class="muted small" id="fmNota"></p>`, {
    submit: 'Lançar',
    onSubmit: async f => {
      const v = num(f.valor), q = num(f.quantidade);
      numOk(v, 'o valor', { obrig: true, pos: true }); numOk(q, 'a quantidade');
      if (tipo !== 'provento' && !f.ativo) throw new Error('Escolha o ativo.');
      if (f.data > fc.hojeIso()) throw new Error('A data não pode ser no futuro.');
      const a = C.todos.find(x => x.id === f.ativo);
      if (tipo === 'resgate' && a?.fonte === 'manual' && a.valor != null && v > a.valor + 0.005) throw new Error(`O resgate passa do valor atual (${fc.money(a.valor)}).`);
      await db.insert('fin_inv_mov', { invest_id: f.ativo || null, data: f.data, tipo, subtipo: tipo === 'provento' ? f.subtipo : null, valor: v, quantidade: q, descricao: f.descricao.trim() || null, fonte: 'manual' });
      if (a?.fonte === 'manual' && tipo !== 'provento') await aplicarMov(a, tipo, v, q);
      toast(`${titulo.replace('Novo ', '').replace(/^./, c => c.toUpperCase())} lançado`);
      await C.ctx.recarregar();
    },
  });
  const sel = document.getElementById('fmAtivo'), nota = document.getElementById('fmNota');
  const atualizaNota = () => {
    const a = C.todos.find(x => x.id === sel.value);
    nota.textContent = tipo !== 'provento' && a && a.fonte !== 'manual' ? 'Este ativo vem do banco: o saldo é atualizado por ele. O lançamento fica no histórico e entra no cálculo de rentabilidade.' : '';
  };
  sel.onchange = atualizaNota; atualizaNota();
}

// Ativo manual: aporte soma ao custo (e à quantidade, com novo preço médio); resgate baixa custo proporcional
async function aplicarMov(a, tipo, v, q) {
  const r = a.raw, rf = a.grupo === 'rf';
  const qtd = Number(r.quantidade || 0), aplic = Number(r.aplicado || 0), saldo = Number(r.saldo || 0);
  let patch;
  if (tipo === 'aporte') {
    if (!rf && q) { const nq = qtd + q, npm = (aplic + v) / nq; patch = { quantidade: nq, preco_medio: npm, aplicado: aplic + v, saldo: nq * (r.preco_atual ?? npm) }; }
    else patch = { aplicado: aplic + v, saldo: saldo + v };
  } else {
    const frac = saldo > 0 ? Math.min(1, v / saldo) : 1;
    if (!rf && q) { const nq = Math.max(0, qtd - q), f2 = qtd ? q / qtd : 1; patch = { quantidade: nq, aplicado: aplic * (1 - f2), saldo: nq * (r.preco_atual ?? r.preco_medio ?? 0) }; }
    else patch = { aplicado: aplic * (1 - frac), saldo: Math.max(0, saldo - v), ...(!rf && qtd ? { quantidade: qtd * (1 - frac) } : {}) };
  }
  await db.update('fin_invest', a.id, { ...patch, atualizado_em: new Date().toISOString() });
}
