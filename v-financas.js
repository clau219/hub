// Finanças: contas, cartões, lançamentos e investimentos do Open Finance (Nubank, Mercado Pago…) pelo Meu Pluggy.
// Os dados chegam pela Edge Function fin-sync (2x por dia e no botão Atualizar). Abas:
//   Painel (v-fin-carteira.js): carteira de investimentos com indicadores, gráficos e listas RV/RF
//   Fluxo de caixa: entradas e saídas do mês por negócio e categoria
//   Lançamentos: extrato, com categoria/negócio/casa e regras "descrição contém X" para os próximos
//   Contas: conexões, contas e cartões
import { S } from './store.js';
import * as db from './db.js';
import { h, today, addDays, fmtDate, localDate, AREAS, mesNome } from './util.js';
import { modal, toast } from './ui.js';
import * as fc from './fin-calc.js';
import * as carteira from './v-fin-carteira.js';

const ABAS = [['painel', 'Painel'], ['fluxo', 'Fluxo de caixa'], ['lancamentos', 'Lançamentos'], ['contas', 'Contas']];
const ABA_ANTIGA = { resumo: 'fluxo', investimentos: 'painel' }; // links antigos continuam funcionando
const NEGOCIOS = ['pessoal', 'dj', 'alugueis', 'consultoria', 'casa'];
const CATS_SAI = ['Moradia', 'Contas da casa', 'Mercado', 'Alimentação fora', 'Transporte', 'Combustível', 'Saúde', 'Educação', 'Lazer',
  'Compras', 'Assinaturas', 'Impostos', 'Tarifas bancárias', 'Faxina e limpeza', 'Condomínio', 'Manutenção', 'Equipamento', 'Outros'];
const CATS_ENT = ['Airbnb', 'Reserva direta', 'Cachê DJ', 'Engenharia', 'Salário / pró-labore', 'Rendimentos', 'Reembolso', 'Outras entradas'];
const INTERNA = 'Transferência entre contas'; // não entra nos totais (fatura paga, PIX entre contas próprias, aplicação)
const INVEST = 'Investimento';
// Categorias da Pluggy (em inglês) → as do Hub, enquanto o lançamento não for classificado
const PLUGGY = {
  'Groceries': 'Mercado', 'Supermarket': 'Mercado', 'Eating out': 'Alimentação fora', 'Restaurants': 'Alimentação fora', 'Food delivery': 'Alimentação fora',
  'Gas stations': 'Combustível', 'Taxi and ride-hailing': 'Transporte', 'Public transportation': 'Transporte', 'Transportation': 'Transporte', 'Parking': 'Transporte', 'Tolls': 'Transporte',
  'Pharmacy': 'Saúde', 'Health': 'Saúde', 'Hospital clinics and labs': 'Saúde', 'Education': 'Educação', 'Leisure': 'Lazer', 'Entertainment': 'Lazer', 'Travel': 'Lazer',
  'Shopping': 'Compras', 'Online shopping': 'Compras', 'Clothing': 'Compras', 'Electronics': 'Compras', 'Digital services': 'Assinaturas', 'Video streaming': 'Assinaturas', 'Music streaming': 'Assinaturas',
  'Taxes': 'Impostos', 'Income taxes': 'Impostos', 'Bank fees': 'Tarifas bancárias', 'Interests charged': 'Tarifas bancárias', 'Housing': 'Moradia', 'Rent': 'Moradia',
  'Electricity': 'Contas da casa', 'Water': 'Contas da casa', 'Telecommunications': 'Contas da casa', 'Internet': 'Contas da casa', 'Mobile': 'Contas da casa', 'Utilities': 'Contas da casa',
  'Salary': 'Salário / pró-labore', 'Income': 'Outras entradas', 'Interests': 'Rendimentos', 'Proceeds interests and dividends': 'Rendimentos',
  'Same person transfer': INTERNA, 'Credit card payment': INTERNA, 'Investments': INVEST, 'Investment': INVEST, 'Fixed income': INVEST, 'Mutual funds': INVEST,
};

let aba = 'painel';
let mes = today().slice(0, 7);
let filtro = { q: '', conta: '', cat: '', semCat: false, negocio: '' };
let D = { items: [], contas: [], tx: [], regras: [], inv: [], mov: [], snap: [], hist: [], carteiras: [], saldosCripto: [], status: null, criptoStatus: null, at: 0, erro: '' };
let carregando = false, sincronizando = false, leuCarteiras = false;
let viewEl = null;

const naTela = () => location.hash.startsWith('#/financas');
// Valores em R$ passam por fc.money: respeitam o modo privacidade (botão de olho)
const brl2 = v => fc.money(v, 2);
const brl0 = v => fc.money(v, 0);
const PRIV = 'hub:fin-privado';
try { fc.priv.on = localStorage.getItem(PRIV) === '1'; } catch {}
export const catDe = t => t.categoria || PLUGGY[t.cat_pluggy] || (t.valor > 0 ? 'Outras entradas' : 'Outros');
const conta = id => D.contas.find(c => c.id === id);
const contaNome = c => c ? (c.apelido || c.nome || 'Conta') : '';
const conta_ = t => conta(t.conta_id);
const fora = t => [INTERNA, INVEST].includes(catDe(t)) || conta_(t)?.oculta;
const area = n => AREAS[n] || { nome: 'Sem negócio', cor: 'var(--muted)' };
const mesTxt = m => `${mesNome(+m.slice(5) - 1).replace(/^./, c => c.toUpperCase())} ${m.slice(0, 4)}`;
const mesMais = (m, n) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const casaNome = id => S.properties.find(p => p.id === id)?.nome || id;

// Carrega tudo de uma vez: o volume pessoal é pequeno (13 meses de lançamentos, em páginas de 1000)
async function carregar(force) {
  if (carregando || (!force && D.at && Date.now() - D.at < 5 * 60e3)) return;
  carregando = true;
  try {
    const desde = addDays(today(), -400);
    if (db.mode === 'supabase') {
      const sb = db.client();
      // Lê em páginas de 1000 (limite do Supabase); tabela que ainda não existe vira lista vazia
      const todas = async (t, ordem, filtro = q => q, opcional = false) => {
        const out = [];
        for (let i = 0; ; i += 1000) {
          const { data, error } = await filtro(sb.from(t).select('*')).order(ordem, { ascending: false }).order('id').range(i, i + 999);
          if (error) { if (opcional) return []; throw error; }
          out.push(...data);
          if (data.length < 1000) return out;
        }
      };
      const [tx, it, ct, rg, st, inv, mov, snap, hist, cart, sal, cst] = await Promise.all([
        todas('fin_tx', 'data', q => q.gte('data', desde)), sb.from('fin_items').select('*'), sb.from('fin_contas').select('*'), sb.from('fin_regras').select('*'),
        sb.from('app_config').select('value').eq('key', 'fin_status').maybeSingle(), todas('fin_invest', 'atualizado_em', q => q, true),
        todas('fin_inv_mov', 'data', q => q, true), sb.from('fin_snap').select('*').order('dia'), todasHist(sb),
        sb.from('cripto_carteiras').select('*').order('criado_em'), sb.from('cripto_saldos').select('*'),
        sb.from('app_config').select('value').eq('key', 'cripto_status').maybeSingle()]);
      const e = it.error || ct.error || rg.error;
      if (e) throw e;
      let status = null; try { status = JSON.parse(st.data?.value || 'null'); } catch {}
      let criptoStatus = null; try { criptoStatus = JSON.parse(cst.data?.value || 'null'); } catch {}
      D = { items: it.data, contas: ct.data, tx, regras: rg.data, inv, mov, snap: snap.error ? [] : snap.data, hist,
        carteiras: cart.error ? [] : cart.data, saldosCripto: sal.error ? [] : sal.data, status, criptoStatus, at: Date.now(), erro: '' };
      // Carteira nunca lida ou lida há mais de 12 h: lê agora (uma vez por visita) e recarrega
      const velha = c => !c.lido_em || Date.now() - Date.parse(c.lido_em) > 12 * 3600e3;
      if (!leuCarteiras && D.carteiras.some(velha)) { leuCarteiras = true; lerCarteiras().then(() => carregar(true)).catch(() => {}); }
    } else {
      const [items, contas, tx, regras, inv, mov, snap, hist, carteiras, saldosCripto] = await Promise.all(['fin_items', 'fin_contas', 'fin_tx', 'fin_regras', 'fin_invest', 'fin_inv_mov', 'fin_snap', 'fin_invest_hist', 'cripto_carteiras', 'cripto_saldos'].map(t => db.all(t)));
      D = { items, contas, tx: tx.filter(t => t.data >= desde).sort((a, b) => b.data.localeCompare(a.data)), regras, inv, mov, snap, hist, carteiras, saldosCripto, status: null, criptoStatus: null, at: Date.now(), erro: '' };
    }
  } catch (e) {
    D.erro = /fin_|relation|does not exist/i.test(e.message || '') ? 'As tabelas de finanças ainda não existem: rode supabase/2026-10-17_financas.sql.'
      : 'Não foi possível carregar as finanças: ' + (e.message || e);
    D.at = Date.now();
  } finally {
    carregando = false;
    if (viewEl && naTela()) render(viewEl);
  }
}

// Histórico diário de cada investimento: pode passar de 1000 linhas
async function todasHist(sb) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from('fin_invest_hist').select('invest_id, dia, saldo').order('dia').order('invest_id').range(i, i + 999);
    if (error) return out;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function sincronizar(body = {}) {
  if (db.mode !== 'supabase') throw new Error('A sincronização só funciona com o Supabase configurado.');
  sincronizando = true; if (viewEl) render(viewEl);
  try {
    // Botão Atualizar: bancos e carteiras de cripto juntos
    const [{ data, error }] = await Promise.all([db.client().functions.invoke('fin-sync', { body }),
      !body.item && !body.connect && D.carteiras.length ? lerCarteiras() : null]);
    if (error) throw error;
    if (data?.erro) throw new Error(data.erro);
    toast(data?.novos ? `${data.novos} lançamento${data.novos > 1 ? 's' : ''} novo${data.novos > 1 ? 's' : ''}` : 'Finanças em dia');
    return data;
  } finally {
    sincronizando = false;
    await carregar(true);
  }
}

export function render(el) {
  viewEl = el;
  const q = location.hash.split('?')[1] || '';
  const qa = ABA_ANTIGA[q] || q;
  if (ABAS.some(a => a[0] === qa)) aba = qa;
  carregar(false);

  const conectado = D.items.length > 0;
  el.innerHTML = `
  <div class="view-head fn-head">
    <h1>Finanças</h1>
    <div class="seg" role="tablist">${ABAS.map(([k, l]) => `<button role="tab" aria-selected="${k === aba}" class="${k === aba ? 'on' : ''}" data-aba="${k}">${l}</button>`).join('')}</div>
    <span class="muted small">${statusTxt()}</span>
    <button class="btn fn-olho" id="fnOlho" aria-pressed="${fc.priv.on}" title="${fc.priv.on ? 'Mostrar valores' : 'Ocultar valores'}" aria-label="${fc.priv.on ? 'Mostrar valores' : 'Ocultar valores'}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>${fc.priv.on ? '<path d="M3 3l18 18"/>' : ''}</svg></button>
    ${conectado || D.carteiras.length ? `<button class="btn" id="fnSync" ${sincronizando ? 'disabled' : ''}>${sincronizando ? 'Atualizando…' : 'Atualizar'}</button>` : ''}
  </div>
  ${D.erro ? `<p class="banner">${h(D.erro)}</p>` : ''}
  ${D.status?.erro ? `<p class="banner">Pluggy: ${h(D.status.erro)}</p>` : ''}
  ${D.criptoStatus?.erro ? `<p class="banner">Carteiras cripto: ${h(D.criptoStatus.erro)}</p>` : ''}
  <div class="fn-corpo">${!D.at ? (aba === 'painel' ? carteira.skeleton() : '<p class="empty">Carregando…</p>')
    : aba === 'painel' ? carteira.painel(D, ctx) : aba === 'fluxo' ? (conectado ? resumo() : conectar()) : aba === 'lancamentos' ? (conectado ? lancamentos() : conectar())
      : (conectado ? contas() : conectar() + carteirasCripto())}</div>`;
  if (D.at && aba === 'painel') carteira.ligar(el, ctx);
  el.querySelector('#fnOlho').onclick = () => { fc.priv.on = !fc.priv.on; try { localStorage.setItem(PRIV, fc.priv.on ? '1' : '0'); } catch {} render(el); };

  el.querySelectorAll('[data-aba]').forEach(b => b.onclick = () => irAba(b.dataset.aba));
  el.querySelector('#fnSync')?.addEventListener('click', () => sincronizar().catch(e => toast(e.message, 5000)));
  el.querySelectorAll('[data-mes]').forEach(b => b.onclick = () => { mes = mesMais(mes, +b.dataset.mes); render(el); });
  el.querySelector('#fnConectar')?.addEventListener('submit', conectarSubmit);
  el.querySelector('#fnConnect')?.addEventListener('click', abrirConnect);
  el.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { filtro = { ...filtro, cat: b.dataset.cat, semCat: false, negocio: '' }; irAba('lancamentos'); });
  el.querySelectorAll('[data-neg]').forEach(b => b.onclick = () => { filtro = { ...filtro, negocio: b.dataset.neg, cat: '', semCat: false }; irAba('lancamentos'); });
  el.querySelector('#fnSemCat')?.addEventListener('click', () => { filtro = { q: '', conta: '', cat: '', negocio: '', semCat: true }; irAba('lancamentos'); });
  el.querySelectorAll('tr[data-tx]').forEach(r => r.onclick = () => editarTx(D.tx.find(t => t.id === r.dataset.tx)));
  el.querySelectorAll('[data-conta]').forEach(b => b.onclick = () => editarConta(conta(b.dataset.conta)));
  el.querySelector('#fnVerInv')?.addEventListener('click', () => irAba('painel'));
  el.querySelector('#fnCart')?.addEventListener('submit', novaCarteira);
  el.querySelectorAll('[data-del-cart]').forEach(b => b.onclick = () => apagarCarteira(b.dataset.delCart));
  el.querySelector('#fnLerCart')?.addEventListener('click', async () => { try { const r = await lerCarteiras(); toast(r?.erro ? r.erro : 'Carteiras lidas', 5000); } catch (e) { toast(e.message, 5000); } await carregar(true); });
  const fq = el.querySelector('#fnQ');
  if (fq) {
    fq.oninput = () => { filtro.q = fq.value; const p = fq.selectionStart; render(el); const n = el.querySelector('#fnQ'); n.focus(); n.setSelectionRange(p, p); };
    el.querySelector('#fnConta').onchange = e => { filtro.conta = e.target.value; render(el); };
    el.querySelector('#fnCatF').onchange = e => { filtro.cat = e.target.value; filtro.semCat = false; render(el); };
    el.querySelector('#fnLimpa')?.addEventListener('click', () => { filtro = { q: '', conta: '', cat: '', semCat: false, negocio: '' }; render(el); });
  }
}

function irAba(a) { aba = a; history.replaceState(null, '', '#/financas?' + a); render(viewEl); window.scrollTo(0, 0); }
// O que o Painel precisa desta tela
const ctx = { catDe: t => catDe(t), rerender: () => viewEl && naTela() && render(viewEl), recarregar: () => carregar(true), irAba: a => irAba(a) };

function statusTxt() {
  const s = D.status;
  if (!s?.em) return '';
  const d = localDate(s.em);
  const quando = d === today() ? 'hoje' : d === addDays(today(), -1) ? 'ontem' : fmtDate(d);
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(s.em));
  return `Bancos lidos ${quando}, ${hora}`;
}

// ---------- Conectar ----------
// O botão abre a janela da Pluggy (Pluggy Connect) aqui mesmo; ao autorizar, o Item ID volta sozinho e é salvo.
// O campo de Item ID fica como alternativa (copiado do "Ir para Demo" do dashboard).
const PLUGGY_JS = 'https://cdn.pluggy.ai/pluggy-connect/v2.11.0/pluggy-connect.js';

function conectar(extra = false) {
  return `<section class="block fn-conectar">
    <h2>${extra ? 'Conectar outro banco' : 'Conectar seus bancos'}</h2>
    ${extra ? '' : `<p>O Hub lê seus bancos pelo <b>Meu Pluggy</b> (Open Finance, grátis para uso pessoal, até 5 conexões). Só leitura: nada sai das suas contas.</p>`}
    <ol>
      <li>No <a href="https://meu.pluggy.ai" target="_blank" rel="noopener">meu.pluggy.ai</a>, o banco precisa estar conectado.</li>
      <li>No <a href="https://dashboard.pluggy.ai" target="_blank" rel="noopener">dashboard.pluggy.ai</a>, o conector <b>MeuPluggy</b> precisa estar ativado na sua aplicação.</li>
      <li>Clique abaixo, entre com sua conta do <b>MeuPluggy</b> (não escolha o banco direto) e autorize <b>um banco</b>. Repita para cada banco.</li>
    </ol>
    <button class="btn primary" id="fnConnect" ${sincronizando ? 'disabled' : ''}>${sincronizando ? 'Conectando…' : 'Conectar banco'}</button>
    <details class="fn-manual"><summary>Já tenho o Item ID</summary>
      <form id="fnConectar" class="fn-form">
        <label>Item ID<input name="item" required placeholder="1a2b3c4d-…" autocomplete="off" pattern="[0-9a-fA-F-]{36}" title="36 caracteres, como 1a2b3c4d-5e6f-…"></label>
        <label>Nome<input name="nome" placeholder="Ex.: Nubank"></label>
        <button class="btn">Conectar</button>
      </form>
    </details>
  </section>`;
}

const carregarJs = src => window.PluggyConnect ? Promise.resolve() : new Promise((ok, falha) => {
  const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = () => falha(new Error('Não foi possível abrir a janela da Pluggy (sem internet?).'));
  document.head.appendChild(sc);
});

async function abrirConnect() {
  if (db.mode !== 'supabase') return toast('A conexão só funciona com o Supabase configurado.');
  const btn = viewEl?.querySelector('#fnConnect'); if (btn) { btn.disabled = true; btn.textContent = 'Abrindo…'; }
  try {
    const [{ data, error }] = await Promise.all([db.client().functions.invoke('fin-sync', { body: { connect: true } }), carregarJs(PLUGGY_JS)]);
    if (error) throw error;
    if (data?.erro) throw new Error(data.erro);
    const pc = new window.PluggyConnect({
      connectToken: data.connectToken,
      ...(data.connectorIds?.length ? { connectorIds: data.connectorIds } : {}),
      ...(data.connectorIds?.length === 1 ? { selectedConnectorId: data.connectorIds[0] } : {}),
      onSuccess: async ({ item }) => {
        try {
          const r = await sincronizar({ item: item.id, nome: item.connector?.name });
          toast(`${item.connector?.name || 'Banco'} conectado: ${r.contas} conta${r.contas === 1 ? '' : 's'}, ${r.novos} lançamentos`, 5000);
        } catch (e) { toast(e.message, 6000); }
      },
      onError: e => toast('Pluggy: ' + (e?.message || 'erro na conexão'), 7000),
    });
    await pc.init();
  } catch (e) { toast(e.message, 6000); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Conectar banco'; } }
}

async function conectarSubmit(ev) {
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.target));
  try {
    const r = await sincronizar({ item: f.item.trim(), nome: f.nome.trim() || undefined });
    toast(`Conectado: ${r.contas} conta${r.contas === 1 ? '' : 's'}, ${r.novos} lançamentos`, 4000);
  } catch (e) { toast(e.message, 6000); }
}

// ---------- Resumo do mês ----------
function doMes(m = mes) { return D.tx.filter(t => t.data.startsWith(m) && !fora(t)); }
const soma = a => a.reduce((s, t) => s + Number(t.valor), 0);

function navMes() {
  return `<div class="fn-mes"><button class="btn" data-mes="-1" aria-label="Mês anterior">‹</button><b>${mesTxt(mes)}</b>
    <button class="btn" data-mes="1" aria-label="Próximo mês" ${mes >= today().slice(0, 7) ? 'disabled' : ''}>›</button></div>`;
}

function resumo() {
  const tx = doMes();
  const ent = soma(tx.filter(t => t.valor > 0)), sai = soma(tx.filter(t => t.valor < 0));
  const vis = D.contas.filter(c => !c.oculta);
  const bancos = vis.filter(c => c.tipo !== 'CREDIT'), cartoes = vis.filter(c => c.tipo === 'CREDIT');
  const vence = cartoes.map(c => c.vence).filter(Boolean).sort()[0];
  const semCat = D.tx.filter(t => t.data.startsWith(mes) && !t.categoria && !conta_(t)?.oculta).length;
  return `${navMes()}
  <div class="kpis fn-kpis">
    <div class="kpi"><span>Em contas</span><b>${brl0(soma(bancos.map(c => ({ valor: c.saldo || 0 }))))}</b><small>${bancos.length} conta${bancos.length === 1 ? '' : 's'}</small></div>
    <div class="kpi"><span>Faturas em aberto</span><b>${brl0(soma(cartoes.map(c => ({ valor: c.saldo || 0 }))))}</b><small>${vence ? `vence ${fmtDate(vence)}` : `${cartoes.length} cartão${cartoes.length === 1 ? '' : 'ões'}`}</small></div>
    ${D.inv.length ? (t => `<button class="kpi fn-kpi-link" id="fnVerInv"><span>Investido</span><b>${brl0(t.valor)}</b><small>${t.n} aplicaç${t.n === 1 ? 'ão' : 'ões'} · ver painel</small></button>`)(fc.totais(D.inv.map(i => fc.deInvest(i)))) : ''}
    <div class="kpi"><span>Resultado de ${mesNome(+mes.slice(5) - 1)}</span><b class="${ent + sai >= 0 ? 'fn-pos' : 'fn-neg'}">${ent + sai >= 0 ? '' : '−'}${brl0(Math.abs(ent + sai))}</b>
      <small>entrou <span class="fn-pos">${brl0(ent)}</span> · saiu <span class="fn-neg">${brl0(-sai)}</span></small></div>
  </div>
  ${semCat ? `<p class="banner warn fn-aviso">${semCat} lançamento${semCat > 1 ? 's' : ''} de ${mesTxt(mes)} sem categoria escolhida. <button class="link-btn" id="fnSemCat">Classificar</button></p>` : ''}
  <div class="fn-grid">
    ${porNegocio(tx)}
    ${porCategoria(tx)}
  </div>
  ${historico()}`;
}

function porNegocio(tx) {
  const grupos = {};
  for (const t of tx) {
    const g = (grupos[t.negocio || ''] ||= { ent: 0, sai: 0, casas: {} });
    if (t.valor > 0) g.ent += +t.valor; else g.sai += +t.valor;
    if (t.negocio === 'alugueis' && t.casa) { const c = (g.casas[t.casa] ||= { ent: 0, sai: 0 }); if (t.valor > 0) c.ent += +t.valor; else c.sai += +t.valor; }
  }
  const ordem = [...NEGOCIOS, ''].filter(n => grupos[n]);
  if (!ordem.length) return `<section class="block"><h2>Por negócio</h2><p class="empty">Nada neste mês.</p></section>`;
  const linha = (nome, g, attr, sub) => `<tr ${attr}><td>${nome}</td><td class="num fn-pos">${g.ent ? brl0(g.ent) : ''}</td><td class="num fn-neg">${g.sai ? brl0(-g.sai) : ''}</td>
    <td class="num ${g.ent + g.sai >= 0 ? 'fn-pos' : 'fn-neg'}"><b>${brl0(g.ent + g.sai)}</b></td></tr>${sub || ''}`;
  return `<section class="block"><h2>Por negócio</h2><div class="table-wrap"><table class="table fn-neg-tbl">
    <thead><tr><th>Negócio</th><th class="num">Entrou</th><th class="num">Saiu</th><th class="num">Resultado</th></tr></thead>
    <tbody>${ordem.map(n => linha(n ? `<span class="tag" style="--c:${area(n).cor}">${h(area(n).nome)}</span>` : '<span class="muted">Sem negócio</span>', grupos[n],
      `data-neg="${n || '-'}"`, Object.entries(grupos[n].casas).map(([c, v]) => linha(`<span class="fn-casa">${h(casaNome(c))}</span>`, v, `data-neg="alugueis"`)).join(''))).join('')}</tbody>
  </table></div></section>`;
}

function porCategoria(tx) {
  const m = {};
  for (const t of tx.filter(t => t.valor < 0)) m[catDe(t)] = (m[catDe(t)] || 0) - t.valor;
  const lst = Object.entries(m).sort((a, b) => b[1] - a[1]);
  const max = lst[0]?.[1] || 1;
  return `<section class="block"><h2>Para onde foi</h2>
    ${lst.length ? `<div class="fn-bars">${lst.slice(0, 12).map(([c, v]) => `<button class="fn-bar" data-cat="${h(c)}">
      <span>${h(c)}</span><b>${brl0(v)}</b><i style="width:${Math.max(2, v / max * 100)}%"></i></button>`).join('')}</div>` : '<p class="empty">Nenhuma saída neste mês.</p>'}
  </section>`;
}

// Últimos 6 meses: entradas e saídas lado a lado
function historico() {
  const meses = Array.from({ length: 6 }, (_, i) => mesMais(mes, i - 5));
  const vals = meses.map(m => { const t = doMes(m); return { m, ent: soma(t.filter(x => x.valor > 0)), sai: -soma(t.filter(x => x.valor < 0)) }; });
  const max = Math.max(1, ...vals.flatMap(v => [v.ent, v.sai]));
  if (!vals.some(v => v.ent || v.sai)) return '';
  return `<section class="block"><h2>Últimos 6 meses</h2><div class="fn-hist">${vals.map(v => `
    <div class="fn-hist-col ${v.m === mes ? 'on' : ''}" title="${mesTxt(v.m)}: entrou ${brl0(v.ent)}, saiu ${brl0(v.sai)}">
      <div class="fn-hist-bars"><i class="e" style="height:${v.ent / max * 100}%"></i><i class="s" style="height:${v.sai / max * 100}%"></i></div>
      <span>${mesNome(+v.m.slice(5) - 1).slice(0, 3)}</span><small class="${v.ent - v.sai >= 0 ? 'fn-pos' : 'fn-neg'}">${brl0(v.ent - v.sai)}</small>
    </div>`).join('')}</div>
    <p class="muted small"><i class="fn-dot e"></i> entradas <i class="fn-dot s"></i> saídas. Transferências entre suas contas, pagamento de fatura e investimentos não contam.</p>
  </section>`;
}

// ---------- Lançamentos ----------
function lancamentos() {
  const q = filtro.q.trim().toLowerCase();
  let tx = D.tx.filter(t => t.data.startsWith(mes));
  if (filtro.conta) tx = tx.filter(t => t.conta_id === filtro.conta);
  if (filtro.cat) tx = tx.filter(t => catDe(t) === filtro.cat && !fora(t));
  if (filtro.negocio) tx = tx.filter(t => (t.negocio || '-') === filtro.negocio && !fora(t));
  if (filtro.semCat) tx = tx.filter(t => !t.categoria);
  if (q) tx = tx.filter(t => `${t.descricao} ${t.contraparte || ''} ${catDe(t)}`.toLowerCase().includes(q));
  const cats = [...new Set(D.tx.map(catDe))].sort();
  const ativo = filtro.q || filtro.conta || filtro.cat || filtro.semCat || filtro.negocio;
  return `${navMes()}
  <div class="fn-filtros">
    <input id="fnQ" type="search" placeholder="Buscar descrição, quem pagou ou recebeu…" value="${h(filtro.q)}">
    <select id="fnConta"><option value="">Todas as contas</option>${D.contas.map(c => `<option value="${h(c.id)}" ${c.id === filtro.conta ? 'selected' : ''}>${h(contaNome(c))}</option>`).join('')}</select>
    <select id="fnCatF"><option value="">Todas as categorias</option>${cats.map(c => `<option ${c === filtro.cat ? 'selected' : ''}>${h(c)}</option>`).join('')}</select>
    ${ativo ? `<button class="link-btn" id="fnLimpa">Limpar filtros${filtro.semCat ? ' (sem categoria)' : filtro.negocio ? ` (${h(filtro.negocio === '-' ? 'sem negócio' : area(filtro.negocio).nome)})` : ''}</button>` : ''}
  </div>
  ${tx.length ? `<p class="muted small">${tx.length} lançamento${tx.length > 1 ? 's' : ''} · entrou ${brl2(soma(tx.filter(t => t.valor > 0)))} · saiu ${brl2(-soma(tx.filter(t => t.valor < 0)))}</p>
  <div class="table-wrap"><table class="table fn-tx">
    <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th class="num">Valor</th></tr></thead>
    <tbody>${tx.map(linhaTx).join('')}</tbody>
  </table></div>` : '<p class="empty">Nenhum lançamento.</p>'}`;
}

function linhaTx(t) {
  const c = conta_(t);
  return `<tr data-tx="${h(t.id)}" class="${fora(t) ? 'fn-fora' : ''}">
    <td class="fn-data">${fmtDate(t.data)}</td>
    <td><div class="fn-desc">${h(t.descricao)}${t.status === 'PENDING' ? ' <span class="chip-static">pendente</span>' : ''}</div>
      <small class="muted">${h([t.contraparte !== t.descricao ? t.contraparte : '', t.parcela ? `parcela ${t.parcela}` : '', contaNome(c)].filter(Boolean).join(' · '))}</small></td>
    <td><span class="${t.categoria ? '' : 'muted'}">${h(catDe(t))}</span>
      ${t.negocio ? `<br><span class="tag" style="--c:${area(t.negocio).cor}">${h(area(t.negocio).nome)}${t.casa ? ' · ' + h(casaNome(t.casa)) : ''}</span>` : ''}</td>
    <td class="num ${t.valor > 0 ? 'fn-pos' : ''}">${brl2(t.valor)}</td>
  </tr>`;
}

// Trecho que identifica o lançamento para a regra: sem números, datas e espaços repetidos
const trecho = t => (t.contraparte || t.descricao || '').replace(/[\d/.,*-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
const opt = (v, l, sel) => `<option value="${h(v)}" ${v === sel ? 'selected' : ''}>${h(l)}</option>`;

function editarTx(t) {
  if (!t) return;
  const cats = t.valor > 0 ? [...CATS_ENT, INTERNA, INVEST] : [...CATS_SAI, INTERNA, INVEST];
  const atual = catDe(t);
  modal(t.valor > 0 ? 'Entrada' : 'Saída', `
    <p class="fn-modal-v ${t.valor > 0 ? 'fn-pos' : ''}"><b>${brl2(t.valor)}</b> · ${fmtDate(t.data, { long: true })}</p>
    <p>${h(t.descricao)}${t.contraparte && t.contraparte !== t.descricao ? `<br><small class="muted">${h(t.contraparte)}</small>` : ''}</p>
    <div class="grid2">
      <label>Categoria<select name="categoria">${[...new Set([...cats, atual])].map(c => opt(c, c, atual)).join('')}</select></label>
      <label>Negócio<select name="negocio" id="fnNeg">${opt('', 'Sem negócio', t.negocio || '')}${NEGOCIOS.map(n => opt(n, area(n).nome, t.negocio || '')).join('')}</select></label>
      <label id="fnCasaL" ${t.negocio === 'alugueis' ? '' : 'hidden'}>Casa<select name="casa">${opt('', 'Todas / nenhuma', t.casa || '')}${S.properties.map(p => opt(p.id, p.nome, t.casa || '')).join('')}</select></label>
      <label class="span2 chk"><input type="checkbox" name="regra"> Usar sempre para lançamentos que contenham:</label>
      <label class="span2">Trecho da descrição ou de quem pagou/recebeu<input name="contem" value="${h(trecho(t))}"></label>
    </div>
    <p class="muted small">"${h(INTERNA)}" e "${INVEST}" ficam fora dos totais.</p>`, {
    onSubmit: async f => {
      const patch = { categoria: f.categoria, negocio: f.negocio || null, casa: f.negocio === 'alugueis' ? f.casa || null : null, manual: true };
      await salvarTx([t.id], patch);
      if (f.regra && f.contem.trim()) {
        const contem = f.contem.trim();
        await db.insert('fin_regras', { contem, categoria: patch.categoria, negocio: patch.negocio, casa: patch.casa });
        const outros = D.tx.filter(x => x.id !== t.id && !x.manual && `${x.descricao} ${x.contraparte || ''}`.toLowerCase().includes(contem.toLowerCase())).map(x => x.id);
        if (outros.length) await salvarTx(outros, { categoria: patch.categoria, negocio: patch.negocio, casa: patch.casa });
        toast(`Regra criada${outros.length ? `; ${outros.length} outro${outros.length > 1 ? 's' : ''} lançamento${outros.length > 1 ? 's' : ''} ajustado${outros.length > 1 ? 's' : ''}` : ''}`);
      }
      await carregar(true);
    },
  });
  const neg = document.getElementById('fnNeg');
  neg.onchange = () => { document.getElementById('fnCasaL').hidden = neg.value !== 'alugueis'; };
}

async function salvarTx(ids, patch) {
  if (db.mode === 'supabase') {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await db.client().from('fin_tx').update(patch).in('id', ids.slice(i, i + 200));
      if (error) throw error;
    }
  } else for (const id of ids) await db.update('fin_tx', id, patch);
}

// ---------- Contas ----------
function contas() {
  const porItem = D.items.map(it => ({ it, cs: D.contas.filter(c => c.item_id === it.id) }));
  return `${porItem.map(({ it, cs }) => `<section class="block">
    <h2>${h(it.nome || 'Conexão')}</h2>
    <p class="muted small">${it.sincronizado_em ? `Banco atualizado pela Pluggy em ${fmtDate(localDate(it.sincronizado_em))}` : 'Ainda não atualizado pela Pluggy'}${it.status && it.status !== 'UPDATED' ? ` · situação: ${h(it.status)}` : ''}</p>
    ${it.erro ? `<p class="banner">${h(it.erro)}</p>` : ''}
    <div class="fn-contas">${cs.map(c => `<button class="fn-conta ${c.oculta ? 'fn-fora' : ''}" data-conta="${h(c.id)}">
      <span>${h(contaNome(c))}${c.numero ? ` <small class="muted">${h(c.numero)}</small>` : ''}</span>
      ${c.tipo === 'CREDIT' ? `<b>${brl2(c.saldo)}</b><small>fatura${c.vence ? `, vence ${fmtDate(c.vence)}` : ''}${c.limite_disp != null ? ` · limite livre ${brl0(c.limite_disp)}` : ''}</small>`
        : `<b>${brl2(c.saldo)}</b><small>${c.subtipo === 'SAVINGS_ACCOUNT' ? 'poupança' : 'saldo'}</small>`}
      ${c.oculta ? '<small>fora dos totais</small>' : ''}
    </button>`).join('') || '<p class="empty">Nenhuma conta ainda.</p>'}</div>
  </section>`).join('')}
  ${carteirasCripto()}
  ${D.items.length < 5 ? conectar(true) : ''}
  ${D.regras.length ? `<section class="block"><h2>Regras de classificação</h2><p class="muted small">Aplicadas aos lançamentos novos. Para mudar uma, crie outra com o mesmo trecho a partir de um lançamento.</p>
    <ul class="fn-regras">${D.regras.map(r => `<li>"${h(r.contem)}" → <b>${h(r.categoria || '')}</b>${r.negocio ? ` · ${h(area(r.negocio).nome)}` : ''}${r.casa ? ` · ${h(casaNome(r.casa))}` : ''}</li>`).join('')}</ul></section>` : ''}`;
}

// ---------- Carteiras cripto (autocustódia, só leitura pelo endereço público) ----------
const redeDe = e => /^0x[0-9a-fA-F]{40}$/.test(e) ? 'evm' : /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(e) ? 'btc' : '';
async function lerCarteiras(carteira) {
  if (db.mode !== 'supabase') return null;
  const { data, error } = await db.client().functions.invoke('cripto-carteiras', { body: carteira ? { carteira } : {} });
  if (error) throw error;
  return data;
}
function carteirasCripto() {
  const sal = id => D.saldosCripto.filter(s => s.carteira_id === id);
  return `<section class="block fn-carts">
    <h2>Carteiras cripto (autocustódia)</h2>
    <p class="muted small">OneKey, Rabby e outras: o Hub lê os saldos na blockchain pelo <b>endereço público</b>, 2 vezes por dia. Só leitura.
      <b>Nunca</b> informe as palavras de recuperação (seed) nem chave privada.</p>
    ${D.carteiras.map(c => `<div class="fn-cart">
      <div class="fn-cart-h"><b>${h(c.nome || 'Carteira')}</b><span class="chip-static">${c.rede === 'btc' ? 'Bitcoin' : 'EVM (todas as redes 0x)'}</span>
        <code title="${h(c.endereco)}">${h(c.endereco.slice(0, 8))}…${h(c.endereco.slice(-6))}</code>
        <button class="link-btn" data-del-cart="${h(c.id)}">Remover</button></div>
      ${c.erro ? `<p class="small fn-neg">${h(c.erro)}</p>` : ''}
      <p class="muted small">${c.lido_em ? `Lida em ${fmtDate(localDate(c.lido_em))}` : 'Ainda não lida'}${sal(c.id).length ? ': ' + sal(c.id).map(s => `${fc.qtdTxt(+(+s.quantidade).toPrecision(6))} ${h(s.simbolo)} (${h(fc.redeNome(s.chain))})`).join(', ') : ''}</p>
    </div>`).join('')}
    <form id="fnCart" class="fn-form">
      <label>Endereço público<input name="endereco" required placeholder="0x… ou bc1…" autocomplete="off" spellcheck="false"></label>
      <label>Nome<input name="nome" placeholder="Ex.: OneKey" value="${D.carteiras.length ? '' : 'OneKey'}"></label>
      <button class="btn primary">Adicionar</button>
      ${D.carteiras.length ? '<button type="button" class="btn" id="fnLerCart">Ler agora</button>' : ''}
    </form>
  </section>`;
}
async function novaCarteira(ev) {
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.target));
  const endereco = f.endereco.trim(), rede = redeDe(endereco);
  if (/^(\w+\s+){11,}\w+$/.test(endereco)) { ev.target.endereco.value = ''; return toast('Isso parece uma frase de recuperação: não foi salva. Informe só o endereço público.', 8000); }
  if (!rede) return toast('Endereço não reconhecido: use um endereço Bitcoin (bc1…, 1…, 3…) ou EVM (0x… com 42 caracteres).', 6000);
  if (D.carteiras.some(c => c.endereco.toLowerCase() === endereco.toLowerCase())) return toast('Esse endereço já está cadastrado.');
  try {
    const c = await db.insert('cripto_carteiras', { nome: f.nome.trim() || 'Carteira', rede, endereco });
    toast('Lendo a carteira na blockchain…', 4000);
    const r = await lerCarteiras(c.id);
    if (r?.erro) toast(r.erro, 6000);
  } catch (e) { toast(e.message, 6000); }
  await carregar(true);
}
async function apagarCarteira(id) {
  if (!confirm('Remover esta carteira do Hub? Os saldos lidos saem do Painel (a carteira em si não é afetada).')) return;
  try { await db.remove('cripto_carteiras', id); } catch (e) { toast(e.message, 5000); }
  await carregar(true);
}

function editarConta(c) {
  if (!c) return;
  modal('Conta', `<div class="grid2">
    <label class="span2">Nome no Hub<input name="apelido" value="${h(c.apelido || '')}" placeholder="${h(c.nome || '')}"></label>
    <label class="span2 chk"><input type="checkbox" name="oculta" ${c.oculta ? 'checked' : ''}> Deixar fora dos totais (ex.: conta da empresa ou de outra pessoa)</label>
  </div>`, {
    onSubmit: async f => { await db.update('fin_contas', c.id, { apelido: f.apelido.trim() || null, oculta: !!f.oculta }); await carregar(true); },
  });
}
