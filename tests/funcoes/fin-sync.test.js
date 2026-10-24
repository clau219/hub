// Edge Function fin-sync: Open Finance pela Pluggy (simulada) → contas, lançamentos com regras, investimentos e foto do dia.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let fn;
const ITEM = '1a2b3c4d-5e6f-7a8b-9c0d-112233445566';
const SEGREDOS = { PLUGGY_CLIENT_ID: 'cid', PLUGGY_CLIENT_SECRET: 'csec' };
const tx = (id, x = {}) => ({ id, date: '2026-10-10T15:00:00.000Z', description: id, amount: 10, type: 'DEBIT', status: 'POSTED', ...x });

// Pluggy falsa. txs: { contaId: [...] } (v2 paginada de 2 em 2); v2Recusa: força o caminho antigo /transactions
function pluggy({ txs = {}, invest = [], movs = {}, v2Recusa = false, investFalha = false, login = true } = {}) {
  simular('https://api.pluggy.ai/auth', req => (login && req.json().clientId === 'cid' ? { apiKey: 'chave-api' } : { status: 401, json: { message: 'Invalid credentials' } }));
  simular('https://api.pluggy.ai/connectors', { results: [{ id: 200, name: 'MeuPluggy' }, { id: 1, name: 'Nubank' }] });
  simular('https://api.pluggy.ai/connect_token', { accessToken: 'connect-token-1' });
  simular(/api\.pluggy\.ai\/items\//, req => (req.url.endsWith(ITEM) ? { id: ITEM, status: 'UPDATED', lastUpdatedAt: '2026-10-19T09:00:00Z', connector: { name: 'MeuPluggy' } } : { status: 404, json: { message: 'Item not found' } }));
  simular(/api\.pluggy\.ai\/accounts\?itemId=/, { results: [
    { id: 'acc1', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Conta NU PAGAMENTOS', number: '0001/123-4', balance: 5000 },
    { id: 'acc2', type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Ultravioleta', marketingName: 'Nubank Ultravioleta', balance: 1200,
      creditData: { creditLimit: 5000, availableCreditLimit: 3800, balanceCloseDate: '2026-10-18T03:00:00Z', balanceDueDate: '2026-10-25T03:00:00Z' } },
  ] });
  simular(/api\.pluggy\.ai\/v2\/transactions\?/, req => {
    if (v2Recusa) return { status: 400, json: { message: 'unknown param' } };
    const u = new URL(req.url), l = txs[u.searchParams.get('accountId')] || [], ini = +(u.searchParams.get('after') || 0);
    return { results: l.slice(ini, ini + 2), next: ini + 2 < l.length ? `/v2/transactions?accountId=x&after=${ini + 2}` : null };
  });
  simular(/api\.pluggy\.ai\/transactions\?/, req => {
    const u = new URL(req.url), l = txs[u.searchParams.get('accountId')] || [];
    return { results: l, totalPages: 1 };
  });
  simular(/api\.pluggy\.ai\/investments\?itemId=/, investFalha ? { status: 403, json: { message: 'product not enabled' } } : { results: invest, totalPages: 1 });
  simular(/api\.pluggy\.ai\/investments\/[^/]+\/transactions/, req => ({ results: movs[req.url.split('/investments/')[1].split('/')[0]] || [], totalPages: 1 }));
}
const DADOS = (x = {}) => comCron({ fin_items: [{ id: ITEM, nome: 'MeuPluggy' }], fin_regras: [], ...x });
const sync = (corpo = {}, auth = 'cron') => fn(pedido('/fin-sync', { corpo, auth })).then(lerJson);
before(async () => { fn = await carregarFuncao('fin-sync', SEGREDOS); });
beforeEach(() => { limparRede(); for (const [k, v] of Object.entries(SEGREDOS)) definirEnv(k, v); });

describe('fin-sync: acesso, segredos e conexão', () => {
  test('sem credencial: 401', async () => {
    novoBanco(DADOS());
    assert.equal((await sync({}, null)).status, 401);
  });
  test('sem os segredos da Pluggy: erro explicado', async () => {
    novoBanco(DADOS());
    definirEnv('PLUGGY_CLIENT_SECRET', undefined);
    assert.equal((await sync()).corpo.erro, 'Faltam os segredos PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no Supabase.');
  });
  test('login recusado pela Pluggy', async () => {
    novoBanco(DADOS());
    pluggy({ login: false });
    assert.equal((await sync()).corpo.erro, 'Pluggy recusou o login (401): Invalid credentials');
    assert.match(banco().t('app_config')[0].value, /Pluggy recusou o login/);
  });
  test('{connect:true}: token da janela da Pluggy, só com o conector MeuPluggy', async () => {
    novoBanco(DADOS());
    pluggy();
    assert.deepEqual((await sync({ connect: true }, 'usuario')).corpo, { connectToken: 'connect-token-1', connectorIds: [200] });
    assert.deepEqual(JSON.parse(chamadasPara('https://api.pluggy.ai/connect_token')[0].corpo), { options: { clientUserId: 'hub' } });
  });
  test('cadastrar Item ID: valida o formato e confere na Pluggy antes de gravar', async () => {
    novoBanco(comCron({ fin_regras: [] }));
    pluggy();
    assert.match((await sync({ item: 'abc' })).corpo.erro, /Item ID inválido/);
    assert.match((await sync({ item: '9a2b3c4d-5e6f-7a8b-9c0d-112233445566' })).corpo.erro, /Pluggy 404 em \/items\/9a2b3c4d.*Item not found/);
    assert.equal(banco().t('fin_items').length, 0);
    const { corpo } = await sync({ item: ` ${ITEM} `, nome: 'Nubank' });
    assert.equal(corpo.contas, 2);
    assert.deepEqual(banco().t('fin_items').map(i => [i.id, i.nome]), [[ITEM, 'Nubank']]);
  });
  test('sem conexões cadastradas', async () => {
    novoBanco(comCron({}));
    pluggy();
    assert.deepEqual((await sync()).corpo, { contas: 0, novos: 0, aviso: 'Nenhuma conexão cadastrada.' });
  });
});

describe('fin-sync: contas e lançamentos', () => {
  const TXS = {
    acc1: [
      tx('t1', { description: 'Transferência recebida', amount: 2000, type: 'CREDIT', paymentData: { payer: { name: 'AIRBNB PAYMENTS' } } }),
      tx('t2', { description: 'Compra no débito', amount: 80.5, merchant: { businessName: 'SUPERMERCADO NORDESTAO' } }),
      tx('t3', { description: 'Pix enviado', amount: 300, paymentData: { receiver: { name: 'DIARISTA MARIA' } } }),
      tx('t4', { description: 'Pendente nova', amount: 5, status: 'PENDING' }),
    ],
    acc2: [tx('c1', { description: 'LOJA X', amount: 199, creditCardMetadata: { installmentNumber: 2, totalInstallments: 10 }, category: 'Shopping' })],
  };
  test('conta e cartão com limite, fechamento e vencimento no fuso de Pipa; nome do banco tirado das contas', async () => {
    novoBanco(DADOS());
    pluggy({ txs: TXS });
    const { corpo } = await sync();
    assert.deepEqual([corpo.contas, corpo.novos, corpo.atualizados, corpo.apagados], [2, 5, 0, 0]);
    const c = Object.fromEntries(banco().t('fin_contas').map(x => [x.id, x]));
    assert.deepEqual([c.acc1.tipo, c.acc1.saldo, c.acc1.numero], ['BANK', 5000, '0001/123-4']);
    assert.deepEqual([c.acc2.nome, c.acc2.limite, c.acc2.limite_disp, c.acc2.fecha, c.acc2.vence], ['Nubank Ultravioleta', 5000, 3800, '2026-10-18', '2026-10-25']);
    const it = banco().t('fin_items')[0];
    assert.deepEqual([it.nome, it.status, it.sincronizado_em, it.erro], ['Nubank', 'UPDATED', '2026-10-19T09:00:00Z', null]);
  });
  test('sinal do valor, contraparte, parcela e categoria da Pluggy', async () => {
    novoBanco(DADOS());
    pluggy({ txs: TXS });
    await sync();
    const t = Object.fromEntries(banco().t('fin_tx').map(x => [x.id, x]));
    assert.deepEqual([t.t1.valor, t.t1.contraparte, t.t1.data], [2000, 'AIRBNB PAYMENTS', '2026-10-10']);
    assert.deepEqual([t.t2.valor, t.t2.contraparte], [-80.5, 'SUPERMERCADO NORDESTAO']);
    assert.equal(t.t3.contraparte, 'DIARISTA MARIA');
    assert.deepEqual([t.c1.parcela, t.c1.cat_pluggy, t.c1.conta_id], ['2/10', 'Shopping', 'acc2']);
  });
  test('regras: a mais longa ganha; entrada do Airbnb vai para Aluguéis sozinha', async () => {
    novoBanco(DADOS({ fin_regras: [
      { id: 'r1', contem: 'super', categoria: 'Compras' },
      { id: 'r2', contem: 'supermercado nordestao', categoria: 'Mercado', negocio: 'casa' },
      { id: 'r3', contem: 'diarista', categoria: 'Faxina e limpeza', negocio: 'alugueis', casa: 'QS39' },
    ] }));
    pluggy({ txs: TXS });
    await sync();
    const t = Object.fromEntries(banco().t('fin_tx').map(x => [x.id, x]));
    assert.deepEqual([t.t2.categoria, t.t2.negocio], ['Mercado', 'casa']);
    assert.deepEqual([t.t3.categoria, t.t3.negocio, t.t3.casa], ['Faxina e limpeza', 'alugueis', 'QS39']);
    assert.deepEqual([t.t1.categoria, t.t1.negocio], ['Airbnb', 'alugueis']);
  });
  test('lançamento já existente: atualiza valor/status, mantém a classificação feita no Hub', async () => {
    novoBanco(DADOS({ fin_tx: [{ id: 't2', conta_id: 'acc1', data: '2026-10-10', valor: -70, status: 'PENDING', categoria: 'Lazer', negocio: 'pessoal', manual: true }] }));
    pluggy({ txs: TXS });
    const { corpo } = await sync();
    assert.equal(corpo.atualizados, 1);
    const t2 = banco().t('fin_tx').find(x => x.id === 't2');
    assert.deepEqual([t2.valor, t2.status, t2.categoria, t2.negocio], [-80.5, 'POSTED', 'Lazer', 'pessoal']);
  });
  test('pendente que sumiu na Pluggy (compensou com outro id) é apagado', async () => {
    novoBanco(DADOS({ fin_tx: [{ id: 'velha-pendente', conta_id: 'acc1', data: '2026-10-12', valor: -5, status: 'PENDING' }] }));
    pluggy({ txs: TXS });
    assert.equal((await sync()).corpo.apagados, 1);
    assert.ok(!banco().t('fin_tx').some(x => x.id === 'velha-pendente'));
  });
  test('gasto anotado pelo WhatsApp (wa-…): o lançamento do banco com o mesmo valor herda a classificação e o provisório sai', async () => {
    novoBanco(DADOS({ fin_tx: [
      { id: 'wa-1', conta_id: null, data: '2026-10-08', descricao: 'Faxina', valor: -120, categoria: 'Faxina e limpeza', negocio: 'alugueis', casa: 'QS39', manual: true },
      { id: 'wa-2', conta_id: null, data: '2026-09-20', descricao: 'Gás', valor: -55, categoria: 'Contas da casa', manual: true },
    ] }));
    pluggy({ txs: { acc1: [tx('b1', { amount: 120, description: 'PIX MARIA' }), tx('b2', { amount: 55 }), tx('b3', { amount: 120, type: 'CREDIT' })] } });
    await sync();
    const t = Object.fromEntries(banco().t('fin_tx').map(x => [x.id, x]));
    assert.deepEqual([t.b1.categoria, t.b1.negocio, t.b1.casa, t.b1.manual, t.b1.descricao], ['Faxina e limpeza', 'alugueis', 'QS39', true, 'Faxina · PIX MARIA']);
    assert.ok(!t['wa-1'], 'o provisório casado sai');
    assert.ok(t['wa-2'], 'mais de 5 dias de diferença: continua provisório');
    assert.deepEqual([t.b1.origem_cat, t.b2.manual], ['whatsapp', false]);
    // sem casar: categoria vem da Pluggy (sem chave da IA neste teste), não da classificação do provisório
    assert.deepEqual([t.b2.categoria, t.b2.origem_cat], ['Outros', 'pluggy_sem_ia']);
    assert.deepEqual([t.b3.categoria, t.b3.negocio ?? null], ['Outras entradas', null], 'entrada não casa com gasto');
  });
  test('desde quando: 1 ano na primeira vez; depois 10 dias antes do último; ou N dias pedidos', async () => {
    novoBanco(DADOS());
    pluggy({ txs: TXS });
    await sync();
    const de = () => chamadasPara(/v2\/transactions\?accountId=acc1/).map(c => new URL(c.url).searchParams.get('dateFrom'));
    assert.equal(de()[0], '2025-10-19');
    limparRede(); pluggy({ txs: TXS });
    await sync();
    assert.equal(de()[0], '2026-09-30');
    limparRede(); pluggy({ txs: TXS });
    await sync({ dias: 3 });
    assert.equal(de()[0], '2026-10-16');
  });
  test('cursor "after" da v2 percorre todas as páginas; v2 recusada usa /transactions', async () => {
    novoBanco(DADOS());
    pluggy({ txs: TXS });
    await sync();
    assert.equal(chamadasPara(/v2\/transactions\?accountId=acc1/).length, 2);
    novoBanco(DADOS());
    limparRede(); pluggy({ txs: TXS, v2Recusa: true });
    assert.equal((await sync()).corpo.novos, 5);
    assert.match(chamadasPara(/\/transactions\?accountId=acc1&from=/)[0].url, /pageSize=500&page=1/);
  });
});

describe('fin-sync: investimentos e foto do dia', () => {
  const INV = [
    { id: 'i1', name: 'CDB NU', type: 'FIXED_INCOME', subtype: 'CDB', issuer: 'Nu Financeira', balance: 11000, amountOriginal: 10000, amountProfit: 1000, rate: 100, rateType: 'CDI', dueDate: '2027-01-10T03:00:00Z', status: 'ACTIVE' },
    { id: 'i2', name: 'MXRF11', type: 'EQUITY', subtype: 'REAL_ESTATE_FUND', code: 'MXRF11', quantity: 100, value: 10.5, balance: 1050, amountOriginal: 1000, status: 'ACTIVE' },
    { id: 'i3', name: 'Resgatado', type: 'FIXED_INCOME', status: 'TOTAL_WITHDRAWAL', balance: 0 },
  ];
  test('aplicações gravadas; resgatadas e sumidas saem; movimentos BUY/SELL/TAX viram aporte/resgate/imposto', async () => {
    novoBanco(DADOS({ fin_invest: [{ id: 'i3', item_id: ITEM }, { id: 'sumiu', item_id: ITEM }, { id: 'man-1', fonte: 'manual', saldo: 3600, aplicado: 3000 }] }));
    pluggy({ invest: INV, movs: { i2: [
      { id: 'm1', type: 'BUY', date: '2026-09-01T15:00:00Z', amount: -1000, quantity: 100 },
      { id: 'm2', type: 'TAX', date: '2026-10-01T15:00:00Z', netAmount: -3 },
      { id: 'm3', type: 'DIVIDEND', date: '2026-10-05T15:00:00Z', amount: 8 },
    ] } });
    const { corpo } = await sync();
    assert.equal(corpo.invest, 2);
    const inv = Object.fromEntries(banco().t('fin_invest').map(x => [x.id, x]));
    assert.deepEqual(Object.keys(inv).sort(), ['i1', 'i2', 'man-1']);
    assert.deepEqual([inv.i1.emissor, inv.i1.saldo, inv.i1.aplicado, inv.i1.rendimento, inv.i1.taxa, inv.i1.taxa_tipo, inv.i1.vence], ['Nu Financeira', 11000, 10000, 1000, 100, 'CDI', '2027-01-10']);
    assert.deepEqual([inv.i2.ticker, inv.i2.quantidade, inv.i2.preco_atual, inv.i2.preco_medio], ['MXRF11', 100, 10.5, 10]);
    const mv = banco().t('fin_inv_mov').map(m => [m.id, m.tipo, m.valor, m.data]);
    assert.deepEqual(mv, [['p-m1', 'aporte', 1000, '2026-09-01'], ['p-m2', 'imposto', 3, '2026-10-01']]);
  });
  test('produto de investimentos não liberado: o resto sincroniza e o erro é informado', async () => {
    novoBanco(DADOS());
    pluggy({ investFalha: true });
    const { corpo } = await sync();
    assert.equal(corpo.contas, 2);
    assert.match(corpo.erro, /^Nubank \(investimentos\): Pluggy 403 em \/investments: product not enabled$/);
  });
  test('foto do dia: contas − faturas (sem as ocultas) e saldo de cada investimento, inclusive os manuais', async () => {
    novoBanco(DADOS({ fin_contas: [{ id: 'oculta', tipo: 'BANK', saldo: 99999, oculta: true }], fin_invest: [{ id: 'man-1', fonte: 'manual', saldo: 3600, aplicado: 3000 }] }));
    pluggy({ invest: INV.slice(0, 1) });
    await sync();
    const snap = banco().t('fin_snap')[0];
    assert.deepEqual([snap.dia, snap.contas, snap.faturas], ['2026-10-19', 5000, 1200]);
    const hist = banco().t('fin_invest_hist').map(h => [h.invest_id, h.dia, h.saldo]).sort();
    assert.deepEqual(hist, [['i1', '2026-10-19', 11000], ['man-1', '2026-10-19', 3600]]);
  });
  test('status final fica em app_config (fin_status)', async () => {
    novoBanco(DADOS());
    pluggy();
    await sync();
    const st = JSON.parse(banco().t('app_config').find(c => c.key === 'fin_status').value);
    assert.deepEqual([st.em, st.contas], ['2026-10-19T15:00:00.000Z', 2]);
  });
});
