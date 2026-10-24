// Tela Finanças: Fluxo de caixa, Lançamentos (com regras), Contas (Pluggy e carteiras cripto) e Painel da carteira de investimentos.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, textoSep, clicar, preencher, enviarModal, esperar, ate } from '../helpers/dom.js';
import { abrirHub, trocarDados, CASAS } from '../helpers/tela.js';
import { banco } from '../helpers/fake-supabase.js';

let V, F, el;
const nb = s => s.replace(/ /g, ' ').replace(/⁠/g, '');
const tx = (id, data, valor, x = {}) => ({ id, data, valor, descricao: x.descricao || id, conta_id: 'ct1', ...x });
const DADOS = (x = {}) => ({
  properties: CASAS,
  fin_items: [{ id: 'it1', nome: 'Nubank', sincronizado_em: '2026-10-19T12:00:00Z', status: 'UPDATED' }],
  fin_contas: [
    { id: 'ct1', item_id: 'it1', nome: 'Conta corrente', tipo: 'BANK', saldo: 5000, numero: '123-4' },
    { id: 'ct2', item_id: 'it1', nome: 'Cartão Nubank', tipo: 'CREDIT', saldo: 1200, vence: '2026-10-25', limite_disp: 3000 },
  ],
  fin_tx: [
    tx('sal', '2026-10-05', 10000, { descricao: 'Pró-labore', categoria: 'Salário / pró-labore' }),
    tx('air', '2026-10-06', 2000, { descricao: 'AIRBNB PAYMENTS', categoria: 'Airbnb', negocio: 'alugueis', casa: 'QS39' }),
    tx('mer', '2026-10-07', -500, { descricao: 'SUPERMERCADO NORDESTAO 123', contraparte: 'SUPERMERCADO NORDESTAO', cat_pluggy: 'Groceries' }),
    tx('mer2', '2026-10-09', -80, { descricao: 'SUPERMERCADO NORDESTAO 456', contraparte: 'SUPERMERCADO NORDESTAO', cat_pluggy: 'Groceries' }),
    tx('fat', '2026-10-08', -1200, { descricao: 'Pagamento de fatura', cat_pluggy: 'Credit card payment' }),
    tx('inv', '2026-10-10', -1000, { descricao: 'Aplicação CDB', categoria: 'Investimento' }),
    tx('set', '2026-09-15', -300, { descricao: 'Cinema', categoria: 'Lazer' }),
  ],
  fin_regras: [{ id: 'r1', contem: 'AIRBNB', categoria: 'Airbnb', negocio: 'alugueis' }],
  app_config: [{ key: 'fin_status', value: JSON.stringify({ em: '2026-10-19T12:00:00Z' }) }],
  fin_invest: [
    { id: 'cdb1', fonte: 'pluggy', tipo: 'FIXED_INCOME', subtipo: 'CDB', nome: 'CDB NU FINANCEIRA - SOCIEDADE DE CREDITO', saldo: 11000, aplicado: 10000, vence: '2027-01-10', taxa_tipo: 'CDI', taxa: 100, atualizado_em: '2026-10-19T00:00:00Z', item_id: 'it1' },
    { id: 'man-1', fonte: 'manual', tipo: 'EQUITY', classe: 'acoes', nome: 'Petrobras', ticker: 'PETR4', quantidade: 100, preco_medio: 30, preco_atual: 36, aplicado: 3000, saldo: 3600, atualizado_em: '2026-10-18T00:00:00Z' },
  ],
  fin_inv_mov: [{ id: 'mv1', invest_id: 'man-1', data: '2026-10-02', tipo: 'provento', subtipo: 'dividendo', valor: 50, fonte: 'manual' }],
  fin_invest_hist: [{ invest_id: 'cdb1', dia: '2026-09-19', saldo: 10800 }, { invest_id: 'man-1', dia: '2026-09-19', saldo: 3200 }],
  fin_snap: [{ dia: '2026-09-19', contas: 4000, faturas: 1000 }],
  ...x,
});
const ir = async (aba, dados) => {
  if (dados) { globalThis.__relogio.avancar(6 * 60e3); await trocarDados(dados, { supabase: true }); }
  location.hash = '#/financas?' + aba;
  const n = banco().consultas.length;
  V.render(el);
  await ate(() => banco().consultas.length > n || !dados, { msg: 'leitura' });
  await esperar(15);
};
before(async () => {
  await abrirHub({ supabase: true, tabelas: DADOS() });
  V = await hub('v-financas.js');
  F = await hub('fin-calc.js');
  el = $('#view');
});
beforeEach(() => { $('#modal').open && $('#modal').close(); F.priv.on = false; });

describe('Fluxo de caixa', () => {
  before(() => ir('fluxo', DADOS()));
  test('status dos bancos e indicadores do mês', () => {
    assert.match(texto('.fn-head'), /Bancos lidos hoje, 09:00/);
    const k = $$('.fn-kpis .kpi').map(x => nb(textoSep(x)));
    assert.equal(k[0], 'Em contas R$ 5.000 1 conta');
    assert.equal(k[1], 'Faturas em aberto R$ 1.200 vence 25 out');
    assert.equal(k[2], 'Investido R$ 14.600 2 aplicações · ver painel');
    assert.equal(k[3], 'Resultado de outubro R$ 11.420 entrou R$ 12.000 · saiu R$ 580');
  });
  test('fatura paga e investimento ficam fora dos totais', () => {
    assert.doesNotMatch(texto('.fn-bars'), /Transferência|Investimento/);
    assert.deepEqual($$('.fn-bar').map(b => nb(textoSep(b))), ['Mercado R$ 580']);
  });
  test('frases: saídas contra setembro até o mesmo dia, com link para a categoria que mais subiu; negócio que mais rendeu', async () => {
    const bloco = $$('#view section.block').find(b => /Para onde foi/.test(b.textContent));
    assert.equal(nb(texto(bloco.querySelector('.frase'))), 'Saídas até o dia 19 93% acima de setembro. Quem mais subiu foi Mercado (+R$ 580). Ver lançamentos de Mercado');
    const neg = $$('#view section.block').find(b => /Por negócio/.test(b.textContent));
    assert.equal(nb(texto(neg.querySelector('.frase'))), 'Aluguéis foi o que mais rendeu (R$ 2.000).');
    await clicar(bloco.querySelector('.frase [data-cat]'));
    assert.ok($('[data-aba=lancamentos]').classList.contains('on'));
    assert.equal($('#fnCatF').value, 'Mercado');
    await ir('fluxo', DADOS());
  });
  test('aviso de lançamentos ainda sem a categorização automática', () => {
    assert.match(texto('#fnPend'), /^7 lançamentos ainda sem a categorização automática .* Classificar agora$/);
  });
  test('por negócio, com a casa do aluguel', () => {
    const linhas = $$('.fn-neg-tbl tbody tr').map(r => nb(textoSep(r)));
    assert.deepEqual(linhas, ['Aluguéis R$ 2.000 R$ 2.000', 'Casa Frida R$ 2.000 R$ 2.000', 'Sem negócio R$ 10.000 R$ 580 R$ 9.420']);
  });
  test('navegar meses; o próximo não passa do mês atual', async () => {
    assert.equal($('[data-mes="1"]').disabled, true);
    await clicar('[data-mes="-1"]');
    assert.match(texto('.fn-mes'), /Setembro 2026/);
    assert.deepEqual($$('.fn-bar').map(b => nb(textoSep(b))), ['Lazer R$ 300']);
    await clicar('[data-mes="1"]');
  });
  test('últimos 6 meses', () => {
    assert.equal($$('.fn-hist-col').length, 6);
    assert.ok($$('.fn-hist-col').at(-1).classList.contains('on'));
  });
  test('clicar numa categoria abre os lançamentos filtrados', async () => {
    await clicar('.fn-bar[data-cat="Mercado"]');
    assert.equal(location.hash, '#/financas?lancamentos');
    assert.deepEqual($$('tr[data-tx]').map(r => r.dataset.tx), ['mer2', 'mer']); // mais recente primeiro
    await clicar('#fnLimpa');
  });
});

describe('Lançamentos', () => {
  before(async () => { await ir('lancamentos', DADOS()); $('#fnLimpa') && await clicar('#fnLimpa'); });
  test('extrato do mês com somas; fora dos totais marcado', () => {
    assert.equal($$('tr[data-tx]').length, 6);
    assert.match(nb(texto('#view')), /6 lançamentos · entrou R\$ 12\.000,00 · saiu R\$ 2\.780,00/);
    assert.ok($('tr[data-tx=fat]').classList.contains('fn-fora'));
  });
  test('busca e filtro por conta', () => {
    const q = $('#fnQ'); q.value = 'nordestao'; q.dispatchEvent(new Event('input'));
    assert.deepEqual($$('tr[data-tx]').map(r => r.dataset.tx), ['mer2', 'mer']); // mais recente primeiro
    $('#fnQ').value = ''; $('#fnQ').dispatchEvent(new Event('input'));
    const c = $('#fnConta'); c.value = 'ct2'; c.dispatchEvent(new Event('change'));
    assert.match(texto('#view'), /Nenhum lançamento/);
    $('#fnConta').value = ''; $('#fnConta').dispatchEvent(new Event('change'));
  });
  test('classificar: categoria, negócio, casa e regra que ajusta os parecidos', async () => {
    await clicar('tr[data-tx=mer]');
    assert.equal(texto('#modalTitle'), 'Saída');
    const m = $('#modal');
    assert.equal(m.querySelector('[name=contem]').value, 'SUPERMERCADO NORDESTAO');
    preencher(m, { categoria: 'Faxina e limpeza', negocio: 'alugueis' });
    assert.equal($('#fnCasaL').hidden, false);
    preencher(m, { casa: 'QS40', regra: true });
    await enviarModal();
    await esperar(10);
    const t = id => banco().t('fin_tx').find(x => x.id === id);
    assert.deepEqual([t('mer').categoria, t('mer').negocio, t('mer').casa, t('mer').manual], ['Faxina e limpeza', 'alugueis', 'QS40', true]);
    assert.deepEqual([t('mer2').categoria, t('mer2').casa], ['Faxina e limpeza', 'QS40']);
    assert.equal(banco().t('fin_regras').at(-1).contem, 'SUPERMERCADO NORDESTAO');
    assert.equal(texto('#toast'), 'Regra criada; 1 outro lançamento ajustado');
  });
});

describe('Contas e conexões', () => {
  before(() => ir('contas', DADOS()));
  test('conexão com contas e cartão', () => {
    const contas = $$('.fn-conta').map(c => nb(textoSep(c)));
    assert.deepEqual(contas, ['Conta corrente 123-4 R$ 5.000,00 saldo', 'Cartão Nubank R$ 1.200,00 fatura, vence 25 out · limite livre R$ 3.000']);
    assert.match(texto('#view'), /Banco atualizado pela Pluggy em 19 out/);
    assert.match(texto('.fn-regras'), /"AIRBNB" → Airbnb · Aluguéis/);
  });
  test('apelido e "fora dos totais" de uma conta', async () => {
    await clicar('[data-conta=ct1]');
    preencher($('#modal'), { apelido: 'Conta PJ', oculta: true });
    await enviarModal();
    await esperar(10);
    assert.deepEqual([banco().t('fin_contas')[0].apelido, banco().t('fin_contas')[0].oculta], ['Conta PJ', true]);
  });
  test('carteira cripto: recusa frase de recuperação, endereço inválido e duplicado', async () => {
    const f = $('#fnCart');
    const enviar = async v => { f.querySelector('[name=endereco]').value = v; f.dispatchEvent(new Event('submit', { cancelable: true })); await esperar(10); };
    await enviar('abandon ability able about above absent absorb abstract absurd abuse access accident');
    assert.match(texto('#toast'), /frase de recuperação: não foi salva/);
    assert.equal($('#fnCart [name=endereco]').value, '');
    await enviar('0x123');
    assert.match(texto('#toast'), /Endereço não reconhecido/);
    assert.equal(banco().t('cripto_carteiras').length, 0);
  });
  test('carteira cripto válida: grava e pede a leitura na blockchain', async () => {
    banco().funcoes['cripto-carteiras'] = () => ({ ok: true });
    const f = $('#fnCart');
    f.querySelector('[name=endereco]').value = '0x6F269215a69aAbcB29a07D9450cD489cAAd15B7a';
    f.querySelector('[name=nome]').value = 'OneKey EVM';
    f.dispatchEvent(new Event('submit', { cancelable: true }));
    await ate(() => banco().invocacoes.some(i => i.nome === 'cripto-carteiras'), { msg: 'leitura da carteira' });
    const c = banco().t('cripto_carteiras')[0];
    assert.deepEqual([c.nome, c.rede], ['OneKey EVM', 'evm']);
    assert.deepEqual(banco().invocacoes.find(i => i.nome === 'cripto-carteiras').body, { carteira: c.id });
    await esperar(10);
    const g = $('#fnCart'); g.querySelector('[name=endereco]').value = '0x6f269215a69aabcb29a07d9450cd489caad15b7a';
    g.dispatchEvent(new Event('submit', { cancelable: true })); await esperar(10);
    assert.equal(texto('#toast'), 'Esse endereço já está cadastrado.');
    assert.equal(redeBtc('3PDdhEuviXkmkLKTAKvCdJ6B7XhcHwJzMw'), true);
  });
  test('conectar por Item ID chama o fin-sync', async () => {
    banco().funcoes['fin-sync'] = body => (body.item ? { contas: 2, novos: 5 } : {});
    const f = $('#fnConectar');
    f.querySelector('[name=item]').value = ' 1a2b3c4d-5e6f-7a8b-9c0d-112233445566 ';
    f.querySelector('[name=nome]').value = 'Mercado Pago';
    f.dispatchEvent(new Event('submit', { cancelable: true }));
    await ate(() => /Conectado/.test(texto('#toast')), { msg: 'toast de conexão' });
    assert.deepEqual(banco().invocacoes.find(i => i.nome === 'fin-sync').body, { item: '1a2b3c4d-5e6f-7a8b-9c0d-112233445566', nome: 'Mercado Pago' });
    assert.equal(texto('#toast'), 'Conectado: 2 contas, 5 lançamentos');
  });
  test('"Conectar banco" abre a janela da Pluggy e salva o banco autorizado', async () => {
    let opcoes = null;
    window.PluggyConnect = class { constructor(o) { opcoes = o; } async init() { await opcoes.onSuccess({ item: { id: 'novo-item', connector: { name: 'Nubank' } } }); } };
    banco().funcoes['fin-sync'] = body => body.connect ? { connectToken: 'tok', connectorIds: [200] } : { contas: 1, novos: 3 };
    await clicar('#fnConnect', 15);
    await ate(() => /Nubank conectado/.test(texto('#toast')), { msg: 'conexão pela Pluggy' });
    assert.deepEqual({ t: opcoes.connectToken, ids: opcoes.connectorIds, sel: opcoes.selectedConnectorId }, { t: 'tok', ids: [200], sel: 200 });
    assert.ok(banco().invocacoes.some(i => i.body?.item === 'novo-item' && i.body?.nome === 'Nubank'));
    assert.equal(texto('#toast'), 'Nubank conectado: 1 conta, 3 lançamentos');
  });
});
const redeBtc = e => /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(e); // mesma regra do Hub para endereço Bitcoin

describe('Categorização automática: revisar, aprender e classificar', () => {
  const SUGS = [{ categoria: 'Manutenção', negocio: 'alugueis', casa: 'QS40' }, { categoria: 'Faxina e limpeza', negocio: 'alugueis', casa: 'QS40' }];
  const CAT = () => DADOS({ fin_tx: [
    tx('jo1', '2026-10-12', -300, { descricao: 'Pix enviado', contraparte: 'JOAO BATISTA', categoria: 'Manutenção', negocio: 'alugueis', casa: 'QS40', origem_cat: 'ia', revisar: true, sugestoes: SUGS, ia_motivo: 'PIX sem pista' }),
    tx('jo2', '2026-09-20', -250, { descricao: 'PIX ENVIADO JOAO BATISTA', categoria: 'Outros', negocio: 'pessoal', origem_cat: 'ia', ia_motivo: 'palpite' }),
    tx('jo3', '2026-09-21', 250, { descricao: 'Pix recebido', contraparte: 'JOAO BATISTA', categoria: 'Outras entradas', origem_cat: 'ia' }),
    tx('jo4', '2026-10-05', -120, { descricao: 'Pix enviado', contraparte: 'JOAO BATISTA', categoria: 'Outros', negocio: 'pessoal', origem_cat: 'ia', revisar: true, sugestoes: [{ categoria: 'Outros', negocio: 'pessoal', casa: null }] }),
    tx('ub', '2026-10-11', -40, { descricao: 'UBER TRIP', categoria: 'Transporte', negocio: 'pessoal', origem_cat: 'ia', ia_motivo: 'corrida de app' }),
    tx('rv2', '2026-08-03', -90, { descricao: 'LOJA X', categoria: 'Compras', negocio: 'pessoal', origem_cat: 'ia', revisar: true, sugestoes: [{ categoria: 'Compras', negocio: 'pessoal', casa: null }] }),
    tx('man', '2026-10-01', -10, { descricao: 'Café', categoria: 'Alimentação fora', manual: true, origem_cat: 'manual' }),
  ] });
  before(async () => { await ir('fluxo', CAT()); });
  test('fluxo avisa o que ficou para revisar no mês; sem pendentes, sem o aviso de classificar', () => {
    assert.match(texto('.fn-aviso.warn'), /2 lançamentos de Outubro 2026 para revisar: a IA ficou em dúvida/);
    assert.equal($('#fnPend'), null);
  });
  test('fila de revisão: todos os meses, palpite e alternativa em 1 clique; selo e motivo da IA', async () => {
    await clicar('#fnRevisar');
    assert.match(textoSep('.fn-revisar-h'), /^Para revisar .* Confirmar os 3 palpites$/);
    assert.deepEqual($$('tr[data-tx]').map(r => r.dataset.tx), ['jo1', 'rv2'], 'os 2 PIX para o João viram uma linha');
    assert.match(texto('tr[data-tx=jo1] .fn-desc'), /×2 iguais/);
    assert.match(texto('#view'), /2 decisões resolvem 3 lançamentos/);
    assert.deepEqual($$('tr[data-tx=jo1] [data-sug]').map(texto), ['✓ Manutenção · Aluguéis · Casa Azul', 'Faxina e limpeza · Aluguéis · Casa Azul']);
    assert.match($('tr[data-tx=jo1] td:nth-child(3) span').getAttribute('title'), /sugerido pela IA: PIX sem pista/);
    await clicar('#fnLimpa');
    assert.equal(texto('tr[data-tx=ub] .fn-ia'), 'IA');
  });
  test('trocar pela alternativa grava como sua e ensina o mesmo recebedor (só no mesmo sentido)', async () => {
    $('#fnRevisar') || (await ir('fluxo'));
    await clicar('#fnRevisar');
    await clicar('tr[data-tx=jo1] [data-sug="jo1|1"]', 10);
    const t = id => banco().t('fin_tx').find(x => x.id === id);
    assert.deepEqual([t('jo1').categoria, t('jo1').manual, t('jo1').origem_cat, t('jo1').revisar], ['Faxina e limpeza', true, 'manual', false]);
    assert.deepEqual([t('jo2').categoria, t('jo2').negocio, t('jo2').casa, t('jo2').origem_cat], ['Faxina e limpeza', 'alugueis', 'QS40', 'memoria'], 'mesmo recebedor, outro texto');
    assert.equal(t('jo3').categoria, 'Outras entradas', 'entrada do mesmo nome não muda');
    assert.equal(t('jo4').origem_cat, 'memoria', 'o outro da fila também');
    assert.equal(texto('#toast'), 'Faxina e limpeza; e mais 2 do mesmo recebedor');
    assert.deepEqual($$('tr[data-tx]').map(r => r.dataset.tx), ['rv2']);
  });
  test('confirmar todos os palpites', async () => {
    const c = globalThis.confirm; globalThis.confirm = () => true;
    await ir('fluxo', CAT());
    await clicar('#fnRevisar');
    await clicar('#fnConfirmaTodas', 10);
    globalThis.confirm = c;
    assert.ok(banco().t('fin_tx').filter(x => ['jo1', 'jo4', 'rv2'].includes(x.id)).every(x => x.manual && !x.revisar));
    assert.match(texto('#view'), /Nada para revisar/);
  });
  test('classificar agora: chama a função em blocos até zerar e resume', async () => {
    const respostas = [{ classificados: 300, restantes: 5, revisar: 2 }, { classificados: 5, restantes: 0, revisar: 1 }];
    const dados = CAT(); dados.fin_tx.push(tx('novo1', '2026-10-13', -12, { descricao: 'PADARIA' }));
    await ir('lancamentos', dados);
    banco().funcoes['fin-classificar'] = () => respostas.shift();
    assert.match(texto('#fnPend'), /1 lançamento ainda sem a categorização automática/);
    await clicar('#fnClassificar', 15);
    await ate(() => /classificados/.test(texto('#toast')), { msg: 'resumo da classificação' });
    assert.equal(texto('#toast'), '305 lançamentos classificados; 3 para revisar');
    assert.deepEqual(banco().invocacoes.filter(i => i.nome === 'fin-classificar').map(i => i.body), [{}, {}]);
  });
  test('aba Contas: de onde vieram as categorias e reclassificar tudo', async () => {
    await ir('contas', CAT());
    assert.match(nb(textoSep('.fn-origens')), /6 pela IA 1 escolhidos por você/);
    const c = globalThis.confirm; globalThis.confirm = () => true;
    banco().invocacoes.length = 0;
    banco().funcoes['fin-classificar'] = () => ({ classificados: 5, restantes: 0, revisar: 0 });
    await clicar('#fnRefazer', 15);
    globalThis.confirm = c;
    await ate(() => /classificados/.test(texto('#toast')));
    assert.deepEqual(banco().invocacoes.filter(i => i.nome === 'fin-classificar').map(i => i.body), [{ refazer: true }]);
  });
});

describe('Atualizar, privacidade e situações especiais', () => {
  before(() => ir('fluxo', DADOS()));
  test('Atualizar chama o fin-sync e conta os novos', async () => {
    banco().funcoes['fin-sync'] = () => ({ novos: 4 });
    await clicar('#fnSync', 15);
    await ate(() => /novos/.test(texto('#toast')), { msg: 'toast' });
    assert.equal(texto('#toast'), '4 lançamentos novos');
  });
  test('erro da Pluggy no Atualizar vira aviso', async () => {
    banco().funcoes['fin-sync'] = () => ({ erro: 'Item com login expirado' });
    await clicar('#fnSync', 15);
    await ate(() => /expirado/.test(texto('#toast')), { msg: 'toast de erro' });
  });
  test('olho esconde os valores e lembra a escolha', async () => {
    await clicar('#fnOlho');
    assert.match(nb(texto('.fn-kpis')), /R\$ ••••/);
    assert.equal(localStorage.getItem('hub:fin-privado'), '1');
    await clicar('#fnOlho');
    assert.equal(localStorage.getItem('hub:fin-privado'), '0');
  });
  test('links antigos (?resumo) abrem o Fluxo de caixa', async () => {
    location.hash = '#/financas?resumo'; V.render(el);
    assert.ok($('[data-aba=fluxo]').classList.contains('on'));
  });
  test('sem banco conectado: passo a passo para conectar', async () => {
    await ir('fluxo', DADOS({ fin_items: [], fin_contas: [] }));
    assert.match(texto('.fn-conectar h2'), /Conectar seus bancos/);
  });
  test('tabelas inexistentes: aviso com o SQL a rodar', async () => {
    globalThis.__relogio.avancar(6 * 60e3);
    await trocarDados(DADOS(), { supabase: true });
    banco().falhas.fin_items = 'relation "fin_items" does not exist';
    await ir('fluxo');
    globalThis.__relogio.avancar(6 * 60e3);
    V.render(el);
    await ate(() => /ainda não existem/.test(texto('#view')), { msg: 'aviso de tabelas' });
    assert.match(texto('#view .banner'), /rode supabase\/2026-10-17_financas\.sql/);
  });
});

describe('Painel da carteira', () => {
  before(() => ir('painel', DADOS()));
  test('indicadores: patrimônio, investido, resultado, RF × RV e proventos', () => {
    const k = $$('.fn-kpis6 .kpi').map(x => nb(textoSep(x)));
    assert.match(k[0], /^Patrimônio total R\$ 18\.400 ▲ R\$ 1\.400 \(\+8,24%\) vs\. 19\/09/); // 5.000 − 1.200 + 14.600 vs. 4.000 − 1.000 + 14.000
    assert.match(k[1], /^Total investido R\$ 14\.600 ▲ R\$ 600/);
    assert.equal(k[2], 'Resultado acumulado R$ 1.600 +12,31% sobre R$ 13.000 aplicados');
    assert.match(k[3], /^Renda fixa × variável 75% × 25%/);
    assert.match(k[4], /^Proventos e rendimentos do mês R\$ 50/);
    assert.match(k[5], /^Saldo disponível R\$ 5\.000 ▲ R\$ 800 \(\+26,67%\)/); // contas − faturas: 3.800 vs. 3.000
  });
  test('listas por classe com nome curto e vencimento', () => {
    assert.match(texto('#view'), /CDB NU FINANCEIRA/);
    assert.doesNotMatch(texto('#view'), /SOCIEDADE DE CREDITO/);
    assert.ok($('[data-ativo=man-1]'));
  });
  test('filtro renda fixa e busca', async () => {
    await clicar('[data-renda=rf]');
    assert.ok(!$('tr[data-ativo=man-1]'));
    await clicar('[data-renda=""]');
    const b = $('#fnBusca'); b.value = 'petr'; b.dispatchEvent(new Event('input'));
    assert.ok($('tr[data-ativo=man-1]'));
    assert.ok(!$('tr[data-ativo=cdb1]'));
    await clicar('#fnLimparF');
  });
  test('período fica guardado no aparelho', async () => {
    await clicar('[data-per="6M"]');
    assert.equal(JSON.parse(localStorage.getItem('hub:fin-painel')).periodo, '6M');
  });
  test('detalhe do ativo', async () => {
    await clicar('tr[data-ativo=man-1]');
    assert.ok($('#modal').open);
    assert.match(texto('#modalTitle'), /Petrobras|PETR4/);
  });
  test('cadastrar ativo manual de renda variável', async () => {
    await clicar('[data-novo=ativo]');
    const m = $('#modal');
    preencher(m, { nome: 'Itaú', classe: 'acoes', ticker: 'itub4', quantidade: '10', preco_medio: '30' });
    await enviarModal();
    await esperar(10);
    const a = banco().t('fin_invest').find(i => i.ticker === 'ITUB4');
    assert.match(a.id, /^man-/);
    assert.deepEqual([a.quantidade, a.preco_medio, a.aplicado, a.saldo, a.fonte, a.tipo], [10, 30, 300, 300, 'manual', 'EQUITY']);
  });
  test('ativo manual exige quantidade e preço médio', async () => {
    await clicar('[data-novo=ativo]');
    preencher($('#modal'), { nome: 'Sem dados', classe: 'acoes' });
    await enviarModal();
    assert.match(texto('#modalErr'), /quantidade/);
  });
  test('aporte num ativo manual recalcula quantidade e preço médio', async () => {
    await ir('painel', DADOS());
    await clicar('[data-novo=aporte]');
    preencher($('#modal'), { ativo: 'man-1', valor: '420', quantidade: '10' });
    await enviarModal();
    await esperar(10);
    const a = banco().t('fin_invest').find(i => i.id === 'man-1');
    assert.deepEqual([a.quantidade, a.aplicado, Math.round(a.preco_medio * 100) / 100, a.saldo], [110, 3420, 31.09, 110 * 36]);
    assert.equal(banco().t('fin_inv_mov').at(-1).tipo, 'aporte');
  });
  test('resgate maior que o valor do ativo manual é recusado', async () => {
    await ir('painel', DADOS());
    await clicar('[data-novo=resgate]');
    preencher($('#modal'), { ativo: 'man-1', valor: '99999' });
    await enviarModal();
    assert.match(texto('#modalErr'), /O resgate passa do valor atual/);
  });
  test('provento sem ativo específico', async () => {
    await clicar('[data-novo=provento]');
    preencher($('#modal'), { valor: '12,34', subtipo: 'jcp' });
    await enviarModal();
    await esperar(10);
    const mv = banco().t('fin_inv_mov').at(-1);
    assert.deepEqual([mv.tipo, mv.subtipo, mv.valor, mv.invest_id], ['provento', 'jcp', 12.34, null]);
  });
  test('carteira vazia convida a cadastrar ou conectar', async () => {
    await ir('painel', DADOS({ fin_invest: [], fin_contas: [], fin_items: [] }));
    assert.match(texto('.fn-vazio h2'), /Sua carteira ainda está vazia/);
    await clicar('.fn-vazio [data-ir=contas]');
    assert.ok($('[data-aba=contas]').classList.contains('on'));
  });
});
