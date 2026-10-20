// fin-calc.js: classes de ativo, totais, agrupamento, evolução e rentabilidade da carteira (funções puras).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/hub.js';

let F, M;
before(async () => { F = await hub('fin-calc.js'); M = await hub('moeda.js'); });
beforeEach(() => { F.priv.on = false; M.trocar('BRL'); });
const nb = s => s.replace(/ /g, ' ');
const perto = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

describe('classeDe: dedução pela Pluggy', () => {
  const casos = [
    [{ classe: 'fiis', tipo: 'EQUITY', subtipo: 'STOCK' }, 'fiis', 'escolha do usuário vence'],
    [{ classe: 'inexistente', tipo: 'ETF' }, 'etfs', 'classe inválida é ignorada'],
    [{ fonte: 'cripto' }, 'cripto', 'fonte cripto'],
    [{ tipo: 'EQUITY', subtipo: 'STOCK' }, 'acoes'],
    [{ tipo: 'EQUITY', subtipo: 'REAL_ESTATE_FUND' }, 'fiis'],
    [{ tipo: 'EQUITY', subtipo: 'BDR' }, 'bdrs'],
    [{ tipo: 'EQUITY', subtipo: 'ETF' }, 'etfs'],
    [{ tipo: 'EQUITY', ticker: 'AAPL34' }, 'bdrs', 'ticker de BDR'],
    [{ tipo: 'EQUITY', ticker: 'MXRF11' }, 'fiis', 'ticker 11'],
    [{ tipo: 'EQUITY', ticker: 'PETR4' }, 'acoes', 'ticker de ação'],
    [{ tipo: 'EQUITY' }, 'outros_rv'],
    [{ tipo: 'ETF' }, 'etfs'],
    [{ tipo: 'COE' }, 'outros_rv'],
    [{ tipo: 'MUTUAL_FUND', subtipo: 'FIXED_INCOME_FUND' }, 'fundos_rf'],
    [{ tipo: 'MUTUAL_FUND', subtipo: 'MULTIMARKET_FUND' }, 'fundos_rv'],
    [{ tipo: 'SECURITY' }, 'previdencia'],
    [{ tipo: 'FIXED_INCOME', nome: 'Caixinha Turbo' }, 'reserva'],
    [{ tipo: 'FIXED_INCOME', nome: 'Poupança' }, 'reserva'],
    [{ tipo: 'FIXED_INCOME', subtipo: 'TREASURY', nome: 'X' }, 'tesouro'],
    [{ tipo: 'FIXED_INCOME', nome: 'Tesouro IPCA+ 2035' }, 'tesouro'],
    [{ tipo: 'FIXED_INCOME', subtipo: 'CRI' }, 'credito'],
    [{ tipo: 'FIXED_INCOME', subtipo: 'DEBENTURES' }, 'credito'],
    [{ tipo: 'FIXED_INCOME', subtipo: 'CDB', nome: 'CDB Nu' }, 'bancario'],
    [{ vence: '2030-01-01' }, 'outros_rf', 'sem tipo, com vencimento'],
    [{}, 'outros_rv', 'sem nada'],
  ];
  for (const [i, esperado, nome] of casos) test(`${nome || JSON.stringify(i)} → ${esperado}`, () => assert.equal(F.classeDe(i), esperado));
});

describe('tesouro, liquidez e taxa', () => {
  test('tesouroTipo pelo nome ou indexador', () => {
    assert.equal(F.tesouroTipo({ nome: 'Tesouro Selic 2029' }), 'Selic');
    assert.equal(F.tesouroTipo({ nome: 'LFT' }), 'Selic');
    assert.equal(F.tesouroTipo({ nome: 'Tesouro IPCA+ 2035' }), 'IPCA+');
    assert.equal(F.tesouroTipo({ nome: 'NTN-B Principal' }), 'IPCA+');
    assert.equal(F.tesouroTipo({ nome: 'Tesouro Prefixado 2027' }), 'Prefixado');
    assert.equal(F.tesouroTipo({ nome: 'X', taxa_tipo: 'PRE' }), 'Prefixado');
    assert.equal(F.tesouroTipo({ nome: 'Tesouro' }), '');
  });
  test('liquidezDe deduz pelo tipo e respeita a escolha do usuário', () => {
    assert.deepEqual(F.liquidezDe({}, 'reserva'), { cod: 'diaria', txt: 'Diária', diaria: true });
    assert.deepEqual(F.liquidezDe({ vence: '2030-01-01' }, 'bancario'), { cod: 'vencimento', txt: 'No vencimento', diaria: false });
    assert.equal(F.liquidezDe({}, 'bancario').cod, 'diaria');
    assert.deepEqual(F.liquidezDe({}, 'tesouro'), { cod: 'D+1', txt: 'D+1', diaria: true });
    assert.equal(F.liquidezDe({}, 'previdencia').cod, 'D+30');
    assert.deepEqual(F.liquidezDe({}, 'cripto'), { cod: 'imediata', txt: 'Imediata', diaria: false });
    assert.equal(F.liquidezDe({}, 'acoes').cod, 'D+2');
    assert.equal(F.liquidezDe({}, 'fundos_rv').cod, '');
    assert.equal(F.liquidezDe({ liquidez: 'D+0' }, 'acoes').diaria, true);
  });
  test('taxaTxt: % do CDI, IPCA + fixo e prefixado', () => {
    assert.equal(F.taxaTxt({ taxa_tipo: 'CDI', taxa: 110 }), '110,00% do CDI');
    assert.equal(F.taxaTxt({ taxa_tipo: 'IPCA', taxa_fixa: 6.2 }), 'IPCA + 6,20%');
    assert.equal(F.taxaTxt({ taxa_tipo: 'PRE', taxa: 12.5 }), '12,50% a.a. (prefixado)');
    assert.equal(F.taxaTxt({ taxa_tipo: 'TAXA_SELIC', taxa: 100 }), '100,00% do TAXA SELIC');
    assert.equal(F.taxaTxt({}), '');
  });
});

describe('datas e formatação', () => {
  test('somaDias, diasEntre e início do período', () => {
    assert.equal(F.hojeIso(), '2026-10-19');
    assert.equal(F.somaDias('2026-10-19', 30), '2026-11-18');
    assert.equal(F.diasEntre('2026-10-19', '2027-10-19'), 365);
    assert.equal(F.inicioPeriodo('1M', '2026-10-19'), '2026-09-19');
    assert.equal(F.inicioPeriodo('1A', '2026-10-19'), '2025-10-19');
    assert.equal(F.inicioPeriodo('Tudo'), '0000-01-01');
  });
  test('money, moneyC, pct e dataBr', () => {
    assert.equal(nb(F.money(1234.5)), 'R$ 1.234,50');
    assert.equal(nb(F.money(1234.5, 0)), 'R$ 1.235');
    assert.equal(F.money(null), '–');
    assert.equal(nb(F.moneyC(2_500_000)), 'R$ 2,5 mi');
    assert.equal(nb(F.moneyC(950)), 'R$ 950');
    assert.equal(F.pct(3.456), '+3,46%');
    assert.equal(F.pct(-1, 1), '-1,0%');
    assert.equal(F.pct(2, 0, false), '2%');
    assert.equal(F.pct(Infinity), '–');
    assert.equal(F.dataBr('2026-10-19'), '19/10/2026');
    assert.equal(F.dataBr(null), '–');
    assert.equal(F.qtdTxt(0.123456789), '0,12345679');
  });
  test('modo privacidade esconde valores', () => {
    F.priv.on = true;
    assert.equal(nb(F.money(100)), 'R$ ••••');
    assert.equal(nb(F.moneyC(5e6)), 'R$ ••••');
  });
  test('em dólar converte pela cotação', () => {
    M.definirTaxa(5);
    M.trocar('USD');
    assert.equal(nb(F.money(100)), 'US$ 20,00');
    M.trocar('BRL');
    assert.equal(nb(F.money(100)), 'R$ 100,00');
  });
  test('nomeCurto tira o sufixo jurídico', () => {
    assert.equal(F.nomeCurto('CDB - NU FINANCEIRA S.A. - SOCIEDADE DE CREDITO, FINANCIAMENTO E INVESTIMENTO'), 'CDB - NU FINANCEIRA S.A.');
    assert.equal(F.nomeCurto('CDB BANCO X - BANCO MÚLTIPLO S.A.'), 'CDB BANCO X');
    assert.equal(F.nomeCurto(null), '');
  });
});

describe('deInvest: formato único de ativo', () => {
  test('ação com quantidade, preço médio e preço atual', () => {
    const a = F.deInvest({ id: 'i1', tipo: 'EQUITY', ticker: 'PETR4', nome: 'Petrobras', quantidade: 100, preco_medio: 30, preco_atual: 36 });
    assert.equal(a.classe, 'acoes');
    assert.equal(a.grupo, 'rv');
    assert.equal(a.valor, 3600);
    assert.equal(a.custo, 3000);
    assert.equal(a.resultado, 600);
    assert.equal(a.resPct, 20);
    assert.equal(a.fonte, 'pluggy');
  });
  test('CDB pelo saldo e rendimento, com dias até o vencimento', () => {
    const a = F.deInvest({ id: 'c', tipo: 'FIXED_INCOME', nome: 'CDB X', saldo: 1100, rendimento: 100, vence: '2026-11-18', taxa_tipo: 'CDI', taxa: 100 }, '2026-10-19');
    assert.equal(a.custo, 1000);
    assert.equal(a.resultado, 100);
    perto(a.resPct, 10);
    assert.equal(a.dias, 30);
    assert.equal(a.liquidez.cod, 'vencimento');
    assert.equal(a.taxa, '100,00% do CDI');
  });
  test('aplicado explícito vence o cálculo; strings vazias viram null', () => {
    const a = F.deInvest({ id: 'x', tipo: 'FIXED_INCOME', saldo: '1500', aplicado: '1000', rendimento: '' });
    assert.equal(a.custo, 1000);
    assert.equal(a.resultado, 500);
    assert.equal(a.nome, 'Aplicação');
  });
  test('sem preço nem saldo: valor null', () => {
    const a = F.deInvest({ id: 'y', tipo: 'EQUITY', ticker: 'XYZW3' });
    assert.equal(a.valor, null);
    assert.equal(a.resPct, null);
  });
});

describe('mesclarCripto: compras lançadas + saldo na blockchain', () => {
  const coins = { bitcoin: { brl: 600000, nome: 'Bitcoin', simbolo: 'btc' }, 'usd-coin': { brl: 5.5, nome: 'USDC', simbolo: 'usdc' } };
  test('só lançamentos (sem carteira): qtd e custo do ledger', () => {
    const lista = [{ coin_id: 'bitcoin', simbolo: 'BTC', nome: 'Bitcoin', qtd: 0.1, custo: 50000, corretoras: { Nubank: 0.1 } }];
    const [a] = F.mesclarCripto(lista, [], coins);
    assert.equal(a.id, 'cg-bitcoin');
    assert.equal(a.qtd, 0.1);
    assert.equal(a.valor, 60000);
    assert.equal(a.custo, 50000);
    assert.equal(a.resultado, 10000);
    assert.equal(a.ticker, 'BTC');
    assert.equal(a.emissor, 'Nubank');
  });
  test('blockchain + corretora: soma; o que está lançado na OneKey é trocado pelo saldo real', () => {
    const lista = [{ coin_id: 'bitcoin', simbolo: 'BTC', qtd: 0.3, custo: 150000, corretoras: { Nubank: 0.1, OneKey: 0.2 } }];
    const saldos = [{ coin_id: 'bitcoin', chain: 'bitcoin', quantidade: '0.25', carteira_id: 'w1' }];
    const [a] = F.mesclarCripto(lista, saldos, coins, { carteiras: [{ id: 'w1', nome: 'OneKey BTC' }] });
    perto(a.qtd, 0.35);
    perto(a.pm, 500000);
    perto(a.custo, 175000);
    assert.deepEqual(a.divergente, { lancado: 0.2, carteira: 0.25 });
    assert.equal(a.emissor, 'OneKey BTC · Bitcoin, Nubank');
    assert.equal(a.porLocal.length, 2);
    assert.equal(a.porLocal[0].blockchain, true);
  });
  test('token só na blockchain, sem cotação da CoinGecko: usa preco_usd × dólar; sem custo', () => {
    const saldos = [{ coin_id: null, chain: 'base', token: '0xabc', quantidade: 10, preco_usd: 2, simbolo: 'foo', nome: 'Foo', carteira_id: 'w2' }];
    const [a] = F.mesclarCripto([], saldos, {}, { dolar: 5 });
    assert.equal(a.id, 'tk:base:0xabc');
    assert.equal(a.valor, 100);
    assert.equal(a.semCusto, true);
    assert.equal(a.ticker, 'FOO');
    assert.equal(a.emissor, 'Carteira · Base');
  });
  test('sem preço nenhum: semPreco; posição zerada some', () => {
    const r = F.mesclarCripto([{ coin_id: 'x', qtd: 1, custo: 10, corretoras: {} }, { coin_id: 'z', qtd: 0, custo: 0 }], [{ coin_id: 'w', quantidade: 0 }], {});
    assert.equal(r.length, 1);
    assert.equal(r[0].semPreco, true);
  });
  test('nome de carteira com caracteres especiais não quebra a regex', () => {
    assert.doesNotThrow(() => F.mesclarCripto([], [], {}, { carteiras: [{ id: 'a', nome: 'Minha (fria) [1]+' }] }));
  });
});

describe('totais, classes, alocação, filtros', () => {
  const at = (x) => ({ oculta: false, custo: null, ...x });
  const lista = [
    at({ id: 'a', classe: 'acoes', grupo: 'rv', nome: 'Petro', ticker: 'PETR4', emissor: '', valor: 1000, custo: 800, resPct: 25 }),
    at({ id: 'b', classe: 'bancario', grupo: 'rf', nome: 'CDB Nu', ticker: '', emissor: 'Nu', valor: 3000, custo: 2900, resPct: 3.4, vence: '2027-01-10' }),
    at({ id: 'c', classe: 'cripto', grupo: 'rv', nome: 'Bitcoin', ticker: 'BTC', emissor: 'OneKey', valor: 1000, custo: 1200, resPct: -16.7 }),
    at({ id: 'd', classe: 'fiis', grupo: 'rv', nome: 'MXRF', ticker: 'MXRF11', emissor: '', valor: null }),
    at({ id: 'e', classe: 'tesouro', grupo: 'rf', nome: 'Tesouro', ticker: '', emissor: '', valor: 9999, oculta: true }),
  ];
  test('totais ignora ocultos e conta os sem preço', () => {
    const t = F.totais(lista);
    assert.equal(t.valor, 5000);
    assert.equal(t.custo, 4900);
    assert.equal(t.resultado, 100);
    perto(t.resPct, 100 / 4900 * 100);
    assert.equal(t.rf, 3000);
    assert.equal(t.rv, 2000);
    assert.equal(t.n, 4);
    assert.equal(t.semPreco, 1);
  });
  test('peso', () => {
    assert.equal(F.peso(lista[0], 5000), 20);
    assert.equal(F.peso(lista[4], 5000), null);
    assert.equal(F.peso(lista[0], 0), null);
  });
  test('porClasse segue a ordem fixa das classes', () => {
    const g = F.porClasse(lista, 5000);
    assert.deepEqual(g.map(x => x.classe), ['acoes', 'fiis', 'cripto', 'tesouro', 'bancario']);
    assert.equal(g.find(x => x.classe === 'bancario').peso, 60);
  });
  test('alocacao por fatia de cor, sem fatias vazias', () => {
    const a = F.alocacao(lista);
    assert.deepEqual(a.map(f => [f.id, f.valor, f.peso]), [['rf', 3000, 60], ['acoes', 1000, 20], ['cripto', 1000, 20]]);
  });
  test('filtrar por classe, fatia, renda e busca', () => {
    assert.deepEqual(F.filtrar(lista, { classe: 'acoes' }).map(a => a.id), ['a']);
    assert.deepEqual(F.filtrar(lista, { classe: 'f:rf' }).map(a => a.id), ['b', 'e']);
    assert.deepEqual(F.filtrar(lista, { renda: 'rv' }).map(a => a.id), ['a', 'c', 'd']);
    assert.deepEqual(F.filtrar(lista, { q: ' onekey ' }).map(a => a.id), ['c']);
    assert.equal(F.filtrar(lista).length, 5);
  });
  test('ordenar por valor, nome e vencimento', () => {
    assert.deepEqual(F.ordenar(lista, 'valor').map(a => a.id), ['e', 'b', 'a', 'c', 'd']);
    assert.deepEqual(F.ordenar(lista, 'nome', 1).map(a => a.id), ['c', 'b', 'd', 'a', 'e']);
    assert.equal(F.ordenar(lista, 'vence', 1)[0].id, 'b');
    assert.deepEqual(F.ordenar(lista, 'inexistente').map(a => a.id), F.ordenar(lista, 'valor').map(a => a.id));
  });
  test('ranking: maiores, altas e baixas', () => {
    const r = F.ranking(lista, 2);
    assert.deepEqual(r.maiores.map(a => a.id), ['b', 'a']);
    assert.deepEqual(r.altas.map(a => a.id), ['a', 'b']);
    assert.deepEqual(r.baixas.map(a => a.id), ['c']);
  });
  test('vencimentos só da renda fixa visível dentro da janela', () => {
    assert.deepEqual(F.vencimentos(lista, 12, '2026-10-19').map(a => a.id), ['b']);
    assert.deepEqual(F.vencimentos(lista, 2, '2026-10-19'), []);
  });
});

describe('agrupar títulos iguais', () => {
  const cdb = (id, x = {}) => ({ id, classe: 'bancario', grupo: 'rf', fonte: 'pluggy', nome: 'CDB Nu', ticker: '', taxa: '100,00% do CDI', valor: 1000, custo: 900, qtd: 1,
    vence: null, dias: null, liquidez: { cod: 'diaria', txt: 'Diária', diaria: true }, oculta: false, ...x });
  test('mesma classe+nome+taxa viram um grupo com totais', () => {
    const r = F.agrupar([cdb('1', { vence: '2027-05-01', dias: 194 }), cdb('2', { vence: '2026-12-01', dias: 43 }), cdb('3', { taxa: '110,00% do CDI' })]);
    assert.equal(r.length, 2);
    const g = r.find(x => x.itens);
    assert.match(g.id, /^grp:/);
    assert.equal(g.nItens, 2);
    assert.equal(g.valor, 2000);
    assert.equal(g.custo, 1800);
    assert.equal(g.resultado, 200);
    assert.equal(g.vence, '2026-12-01');
    assert.equal(g.venceAte, '2027-05-01');
    assert.equal(g.dias, 43);
    assert.equal(g.qtd, 2);
    assert.equal(g.pm, 900);
  });
  test('liquidez diferente vira "Várias"; grupo todo oculto fica oculto', () => {
    const r = F.agrupar([cdb('1', { liquidez: { txt: 'Diária', diaria: true }, oculta: true }), cdb('2', { liquidez: { txt: 'No vencimento', diaria: false }, oculta: true })]);
    assert.equal(r[0].oculta, true);
    assert.equal(r[0].liquidez.txt, 'Várias');
  });
  test('cripto nunca agrupa moedas diferentes', () => {
    const c = (id) => ({ id, classe: 'cripto', fonte: 'cripto', nome: 'X', ticker: 'X', taxa: '', valor: 1, liquidez: { txt: 'Imediata' } });
    assert.equal(F.agrupar([c('cg-a'), c('cg-b')]).length, 2);
  });
});

describe('evolução, variação, proventos e rentabilidade', () => {
  test('evolucao soma investimentos, cripto e contas (− faturas) por dia, carregando o último valor', () => {
    const s = F.evolucao({
      hist: [{ invest_id: 'a', dia: '2026-10-01', saldo: 1000 }, { invest_id: 'b', dia: '2026-10-01', saldo: 500 }, { invest_id: 'a', dia: '2026-10-02', saldo: 1010 }],
      snaps: [{ dia: '2026-10-01', contas: 300, faturas: 100 }],
      cripto: [{ dia: '2026-10-01', valor_brl: 2000 }, { dia: '2026-10-03', valor_brl: 2100 }],
    });
    assert.deepEqual(s, [
      { dia: '2026-10-01', investido: 3500, contas: 200, valor: 3700 },
      { dia: '2026-10-02', investido: 3010, contas: 200, valor: 3210 },
      { dia: '2026-10-03', investido: 2100, contas: 200, valor: 2300 },
    ]);
  });
  test('evolucao com filtro de ids, sem cripto, sem contas e desde', () => {
    const s = F.evolucao({ hist: [{ invest_id: 'a', dia: '2026-10-01', saldo: 1 }, { invest_id: 'b', dia: '2026-10-02', saldo: 5 }], cripto: [{ dia: '2026-10-05', valor_brl: 9 }],
      snaps: [{ dia: '2026-10-06', contas: 1 }], ids: new Set(['b']), comCripto: false, comContas: false, desde: '2026-10-02' });
    assert.deepEqual(s, [{ dia: '2026-10-02', investido: 5, contas: 0, valor: 5 }]);
  });
  test('variacao contra o ponto de N dias atrás', () => {
    const serie = [{ dia: '2026-09-01', valor: 100 }, { dia: '2026-09-19', valor: 110 }, { dia: '2026-10-19', valor: 121 }];
    const v = F.variacao(serie, 'valor', 30, '2026-10-19');
    assert.equal(v.antes, 110);
    assert.equal(v.delta, 11);
    perto(v.pct, 10);
    assert.equal(v.desde, '2026-09-19');
    assert.equal(F.variacao([serie[0]]), null);
    assert.equal(F.variacao([{ dia: '2026-10-19', valor: 1 }, { dia: '2026-10-19', valor: 2 }], 'valor', 30, '2026-10-19'), null);
  });
  test('proventosPorMes: 12 meses, tipos separados, fora da janela ignorado', () => {
    const r = F.proventosPorMes([
      { tipo: 'provento', subtipo: 'dividendo', data: '2026-10-05', valor: 10 },
      { tipo: 'provento', data: '2026-10-06', valor: 5 },
      { tipo: 'aporte', data: '2026-10-06', valor: 999 },
      { tipo: 'provento', data: '2024-01-01', valor: 7 },
    ], [{ data: '2026-09-10', valor: 2 }], 12, '2026-10-19');
    assert.equal(r.length, 12);
    assert.equal(r[0].mes, '2025-11');
    assert.deepEqual(r[11], { mes: '2026-10', valor: 15, tipos: { dividendo: 10, rendimento: 5 } });
    assert.deepEqual(r[10].tipos, { juros: 2 });
  });
  test('rentabilidade (Dietz modificado) desconta aportes', () => {
    const serie = [{ dia: '2026-10-01', investido: 1000 }, { dia: '2026-10-31', investido: 1600 }];
    const r = F.rentabilidade(serie, [{ data: '2026-10-16', valor: 500 }], '2026-10-01');
    // ganho 100 sobre base 1000 + 500·(15/30) = 1250 → 8%
    perto(r.pct, 8);
    assert.equal(F.rentabilidade(serie.slice(0, 1), [], '2026-10-01'), null);
    assert.equal(F.rentabilidade([{ dia: 'a', investido: 0 }, { dia: 'b', investido: 1 }], [], ''), null);
  });
  test('acumular CDI/IPCA compõe as taxas do intervalo (exclui o primeiro dia)', () => {
    perto(F.acumular([['2026-01-01', 1], ['2026-02-01', 1], ['2026-03-01', 1]], '2026-01-01', '2026-03-01'), 2.01);
    assert.equal(F.acumular([['2026-01-01', 1]], '2026-01-01', '2026-03-01'), null);
  });
});
