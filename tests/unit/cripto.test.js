// cripto.js: preço médio (Receita), vendas por mês, CSV, indicadores técnicos e cotações (com rede simulada).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/hub.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let C, Moeda;
before(async () => { C = await hub('cripto.js'); Moeda = await hub('moeda.js'); });
beforeEach(() => { limparRede(); Moeda.trocar('BRL'); });
const nb = s => s.replace(/ /g, ' ');
const perto = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const tx = (x) => ({ coin_id: 'bitcoin', simbolo: 'BTC', nome: 'Bitcoin', taxa_brl: 0, corretora: 'Binance', ...x });

describe('preço médio e resultado (calcular)', () => {
  test('compras somam custo com taxa; venda baixa pelo custo médio', () => {
    const { moedas, vendas } = C.calcular([
      tx({ data: '2026-03-01', tipo: 'compra', quantidade: 1, preco_brl: 100000, taxa_brl: 100 }),
      tx({ data: '2026-03-05', tipo: 'compra', quantidade: 1, preco_brl: 200000 }),
      tx({ data: '2026-03-10', tipo: 'venda', quantidade: 1, preco_brl: 250000, taxa_brl: 50 }),
    ]);
    const m = moedas.bitcoin;
    assert.equal(m.qtd, 1);
    perto(m.custo, 150050);
    perto(m.realizado, 99900);
    assert.equal(m.corretoras.Binance, 1);
    assert.equal(vendas.length, 1);
    assert.deepEqual({ ...vendas[0], resultado: Math.round(vendas[0].resultado) }, { mes: '2026-03', total: 250000, resultado: 99900, n: 1, porCorretora: { Binance: 250000 } });
  });
  test('ordem por data (não pela ordem do array)', () => {
    const { moedas } = C.calcular([
      tx({ data: '2026-03-10', tipo: 'venda', quantidade: 1, preco_brl: 300 }),
      tx({ data: '2026-03-01', tipo: 'compra', quantidade: 1, preco_brl: 100 }),
    ]);
    assert.equal(moedas.bitcoin.aviso, false);
    perto(moedas.bitcoin.realizado, 200);
  });
  test('vender mais do que tem marca aviso e zera a posição', () => {
    const { moedas } = C.calcular([
      tx({ data: '2026-01-01', tipo: 'compra', quantidade: 1, preco_brl: 100 }),
      tx({ data: '2026-01-02', tipo: 'venda', quantidade: 2, preco_brl: 150 }),
    ]);
    assert.equal(moedas.bitcoin.aviso, true);
    assert.equal(moedas.bitcoin.qtd, 0);
    assert.equal(moedas.bitcoin.custo, 0);
  });
  test('transferência move entre corretoras e soma só a taxa ao custo', () => {
    const { moedas } = C.calcular([
      tx({ data: '2026-01-01', tipo: 'compra', quantidade: 1, preco_brl: 100 }),
      tx({ data: '2026-01-02', tipo: 'transferencia', quantidade: 0.4, taxa_brl: 5, destino: 'OneKey' }),
    ]);
    assert.equal(moedas.bitcoin.qtd, 1);
    assert.equal(moedas.bitcoin.custo, 105);
    perto(moedas.bitcoin.corretoras.Binance, 0.6);
    perto(moedas.bitcoin.corretoras.OneKey, 0.4);
  });
  test('recebimento (staking) entra como compra', () => {
    const { moedas } = C.calcular([tx({ data: '2026-01-01', tipo: 'recebimento', quantidade: 2, preco_brl: 0, corretora: null })]);
    assert.equal(moedas.bitcoin.qtd, 2);
    assert.equal(moedas.bitcoin.corretoras['Sem corretora'], 2);
  });
  test('vendas agrupadas por mês, mais recente primeiro', () => {
    const { vendas } = C.calcular([
      tx({ data: '2026-01-01', tipo: 'compra', quantidade: 10, preco_brl: 1 }),
      tx({ data: '2026-01-15', tipo: 'venda', quantidade: 1, preco_brl: 2, corretora: 'Nubank' }),
      tx({ data: '2026-01-20', tipo: 'venda', quantidade: 1, preco_brl: 2 }),
      tx({ data: '2026-02-01', tipo: 'venda', quantidade: 1, preco_brl: 3 }),
    ]);
    assert.deepEqual(vendas.map(v => [v.mes, v.total, v.n]), [['2026-02', 3, 1], ['2026-01', 4, 2]]);
    assert.deepEqual(vendas[1].porCorretora, { Nubank: 2, Binance: 2 });
  });
});

describe('posicoes (com cotação)', () => {
  test('valor, resultado, variação de 24h e totais', () => {
    C.M.coins.bitcoin = { id: 'bitcoin', brl: 300, ch24: 50 };
    const p = C.posicoes([tx({ data: '2026-01-01', tipo: 'compra', quantidade: 2, preco_brl: 100 })]);
    const [b] = p.ativos;
    assert.equal(b.valor, 600);
    assert.equal(b.medio, 100);
    assert.equal(b.resultado, 400);
    assert.equal(b.resPct, 200);
    assert.equal(b.ontem, 400);
    assert.equal(p.tot.valor, 600);
    assert.equal(p.tot.ch24, 50);
    delete C.M.coins.bitcoin;
  });
  test('moeda sem cotação: valor null e fora do total', () => {
    const p = C.posicoes([tx({ coin_id: 'moeda-x', data: '2026-01-01', tipo: 'compra', quantidade: 1, preco_brl: 10 })]);
    assert.equal(p.ativos[0].valor, null);
    assert.equal(p.tot.valor, 0);
    assert.equal(p.tot.custo, 10);
  });
});

describe('CSV', () => {
  test('paraCsv usa ; e vírgula decimal, com BOM para o Excel', () => {
    const csv = C.paraCsv([tx({ data: '2026-01-01', tipo: 'compra', quantidade: 0.5, preco_brl: 1000.25, taxa_brl: 1, obs: 'disse "oi"; tchau' })]);
    assert.ok(csv.startsWith('﻿data;tipo;simbolo'));
    assert.match(csv, /2026-01-01;compra;BTC;bitcoin;0,5;1000,25;1;Binance;;"disse ""oi""; tchau"/);
  });
  test('ida e volta: interpretarCsv(paraCsv(x)) devolve as mesmas transações', () => {
    const orig = [tx({ data: '2026-01-01', tipo: 'compra', quantidade: 0.5, preco_brl: 1000.25, taxa_brl: 1, obs: 'a;b' }),
      tx({ data: '2026-01-02', tipo: 'transferencia', quantidade: 0.1, preco_brl: 0, destino: 'OneKey', obs: null })];
    const { linhas, erros } = C.interpretarCsv(C.paraCsv(orig));
    assert.deepEqual(erros, []);
    assert.deepEqual(linhas.map(l => [l.data, l.tipo, l.coin_id, l.quantidade, l.preco_brl, l.taxa_brl, l.corretora, l.destino, l.obs]), [
      ['2026-01-01', 'compra', 'bitcoin', 0.5, 1000.25, 1, 'Binance', null, 'a;b'],
      ['2026-01-02', 'transferencia', 'bitcoin', 0.1, 0, 0, 'Binance', 'OneKey', null],
    ]);
  });
  test('lerCsv: aspas, quebra de linha dentro de aspas, CRLF e vírgula como separador', () => {
    assert.deepEqual(C.lerCsv('a,b\r\n"x, y","linha1\nlinha2"\r\n\r\n'), [['a', 'b'], ['x, y', 'linha1\nlinha2']]);
    assert.deepEqual(C.lerCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  });
  test('lerNumero entende formatos brasileiro e americano', () => {
    assert.equal(C.lerNumero('1.234,56'), 1234.56);
    assert.equal(C.lerNumero('1,234.56'), 1234.56);
    assert.equal(C.lerNumero('0,5'), 0.5);
    assert.equal(C.lerNumero('R$ 10'), 10);
    assert.equal(C.lerNumero('-3'), -3);
    assert.equal(C.lerNumero('1e-8'), 1e-8);
    assert.equal(C.lerNumero(''), null);
    assert.equal(C.lerNumero('abc'), null);
  });
  test('interpretarCsv aceita colunas de corretora em inglês e data dd/mm/aa', () => {
    const r = C.interpretarCsv('Date;Side;Asset;Amount;Price;Fee;Exchange\n05/03/26;BUY;eth;1,5;10.000,00;-2;Binance\n2026-03-06;sell;ETH;0,5;12000;;');
    assert.deepEqual(r.erros, []);
    assert.deepEqual([...r.simbolos], ['ETH']);
    assert.deepEqual(r.linhas[0], { data: '2026-03-05', tipo: 'compra', simbolo: 'ETH', coin_id: '', quantidade: 1.5, preco_brl: 10000, taxa_brl: 2, corretora: 'Binance', destino: null, obs: null });
    assert.equal(r.linhas[1].tipo, 'venda');
  });
  test('interpretarCsv aponta linhas com erro sem parar as outras', () => {
    const r = C.interpretarCsv('data;tipo;simbolo;quantidade\n2026-01-01;doação;BTC;1\nontem;compra;BTC;1\n2026-01-01;compra;BTC;0\n2026-01-01;compra;;1\n2026-01-01;compra;BTC;1');
    assert.deepEqual(r.erros, ['linha 2: tipo “doação” não reconhecido', 'linha 3: data “ontem” inválida', 'linha 4: quantidade inválida', 'linha 5: sem moeda']);
    assert.equal(r.linhas.length, 1);
  });
  test('interpretarCsv sem colunas obrigatórias ou sem dados', () => {
    assert.match(C.interpretarCsv('foo;bar\n1;2').erros[0], /Colunas não encontradas: data, tipo, quantidade, moeda/);
    assert.deepEqual(C.interpretarCsv('data;tipo').erros, ['O arquivo não tem linhas de dados.']);
  });
});

describe('formatação', () => {
  test('preco ajusta as casas ao tamanho do valor', () => {
    assert.equal(nb(C.preco(612345.67)), 'R$ 612.346');
    assert.equal(nb(C.preco(12.3)), 'R$ 12,30');
    assert.equal(nb(C.preco(0.00012345)), 'R$ 0,0001235');
    assert.equal(nb(C.preco(0)), 'R$ 0,00');
    assert.equal(C.preco(null), '—');
    assert.equal(nb(C.preco(2, 'USD')), 'US$ 2,00');
  });
  test('pct com classe de alta/baixa', () => {
    assert.equal(C.pct(1.5), '<span class="up">+1,50%</span>');
    assert.equal(C.pct(-2), '<span class="down">-2,00%</span>');
    assert.equal(C.pct(0, false), '0,00%');
    assert.equal(C.pct(null), '<span class="muted">—</span>');
  });
  test('reais/precoV seguem o botão R$/US$; brl fica em reais', () => {
    Moeda.definirTaxa(5);
    Moeda.trocar('USD');
    assert.equal(nb(C.reais(50)), 'US$ 10,00');
    assert.equal(nb(C.brl(50)), 'R$ 50,00');
    Moeda.trocar('BRL');
  });
  test('sparkline desenha polyline; menos de 2 pontos não desenha', () => {
    const s = C.sparkline([1, 2, 3], true);
    assert.match(s, /class="spark up"/);
    assert.match(s, /points="0\.0,28\.0 55\.0,15\.0 110\.0,2\.0"/);
    assert.equal(C.sparkline([1]), '');
    assert.match(C.sparkline([5, 5]), /points="0\.0,15\.0 110\.0,15\.0"/);
  });
});

describe('indicadores técnicos', () => {
  test('sem histórico suficiente: null', () => {
    C.H.coins.curta = { at: Date.now(), p: [1, 2, 3] };
    assert.equal(C.indicadores('curta'), null);
    assert.equal(C.indicadores('nao-existe'), null);
  });
  test('série só subindo: RSI 100, variação de 30 dias e máximas', () => {
    C.H.coins.sobe = { at: Date.now(), p: Array.from({ length: 60 }, (_, i) => 100 + i) };
    const i = C.indicadores('sobe');
    assert.equal(i.rsi, 100);
    assert.equal(i.atual, 159);
    perto(i.mm50, (110 + 159) / 2);
    assert.equal(i.mm200, null);
    perto(i.ch30, (159 / 129 - 1) * 100); // p[60 - 31] = 129
    assert.equal(i.max, 159);
    assert.equal(i.min, 100);
    assert.equal(i.stable, false);
  });
  test('cruzamento das médias 50/200 nos últimos 30 dias', () => {
    const p = [...Array(200).fill(100), ...Array.from({ length: 30 }, (_, k) => 100 + (k + 1) * 3)];
    C.H.coins.cruza = { at: Date.now(), p };
    const i = C.indicadores('cruza');
    assert.ok(i.mm50 > i.mm200);
    assert.equal(typeof i.cruzou, 'number');
  });
  test('stablecoin reconhecida pela lista ou pelo preço ~1', () => {
    C.H.coins['usd-coin'] = { at: Date.now(), p: Array(20).fill(1) };
    assert.equal(C.indicadores('usd-coin').stable, true);
    C.H.coins.estavel = { at: Date.now(), p: Array.from({ length: 20 }, (_, i) => 1 + (i % 2) * 0.01) };
    assert.equal(C.indicadores('estavel').stable, true);
  });
  test('anotarDominancia guarda 1 valor por dia e só os últimos 60 dias', () => {
    for (let d = 1; d <= 70; d++) C.anotarDominancia(`2026-01-${String(d).padStart(3, '0')}`, 55.123);
    assert.equal(Object.keys(C.H.dom).length, 60);
    C.anotarDominancia('x', null);
    assert.equal(C.H.dom.x, undefined);
  });
  test('sinaisVencidos: algo sem histórico ou extras velhos', () => {
    C.H.fng = { at: Date.now(), v: [50] };
    C.H.dolar = { at: Date.now(), v: [5] };
    C.H.coins.fresca = { at: Date.now(), p: [1] };
    assert.equal(C.sinaisVencidos(['fresca', 'tether']), false);
    assert.equal(C.sinaisVencidos(['outra']), true);
  });
});

describe('cotações (rede simulada)', () => {
  const mercadoBrl = [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 600000, market_cap_rank: 1, price_change_percentage_24h_in_currency: 2,
    price_change_percentage_7d_in_currency: 5, sparkline_in_7d: { price: Array.from({ length: 168 }, (_, i) => i) }, ath_date: '2025-01-01T00:00:00Z' }];
  test('atualizar junta BRL, USD, global, medo/ganância e dólar e guarda no navegador', async () => {
    simular(/coins\/markets\?vs_currency=brl/, mercadoBrl);
    simular(/coins\/markets\?vs_currency=usd/, [{ id: 'bitcoin', current_price: 110000, ath: 120000, high_24h: 111000, low_24h: 100000 }]);
    simular('https://api.coingecko.com/api/v3/global', { data: { market_cap_percentage: { btc: 57.5 }, total_market_cap: { brl: 1e13, usd: 2e12 }, market_cap_change_percentage_24h_usd: 1 } });
    simular('https://api.alternative.me/fng/', { data: [{ value: '72', value_classification: 'Greed' }] });
    simular('https://economia.awesomeapi.com.br/json/last/USD-BRL', { USDBRL: { bid: '5.45' } });
    const p1 = C.atualizar(['bitcoin', 'bitcoin', '']);
    assert.equal(C.atualizando(), true);
    assert.equal(C.atualizar(['x']), p1, 'chamada simultânea reaproveita a consulta');
    const M = await p1;
    assert.equal(C.atualizando(), false);
    const b = M.coins.bitcoin;
    assert.equal(b.simbolo, 'BTC');
    assert.equal(b.usd, 110000);
    assert.equal(b.ch24, 2);
    assert.equal(b.spark.length, 56);
    assert.equal(b.athData, '2025-01-01');
    assert.equal(M.dolar, 5.45);
    assert.deepEqual(M.fng, { v: 72, c: 'Greed' });
    assert.equal(M.global.dom, 57.5);
    assert.equal(Moeda.moeda.taxa, 5.45);
    assert.ok(JSON.parse(localStorage.getItem('hub:cripto-mercado')).coins.bitcoin);
    assert.match(chamadasPara(/vs_currency=brl/)[0].url, /ids=bitcoin&/);
  });
  test('sem a cotação do dólar, deduz pelo BTC em reais / BTC em dólar', async () => {
    simular(/coins\/markets\?vs_currency=brl/, mercadoBrl);
    simular(/coins\/markets\?vs_currency=usd/, [{ id: 'bitcoin', current_price: 100000 }]);
    simular('https://api.coingecko.com/api/v3/global', { status: 500 });
    simular('https://api.alternative.me/fng/', { status: 500 });
    simular('https://economia.awesomeapi.com.br/json/last/USD-BRL', { status: 500 });
    const M = await C.atualizar(['bitcoin']);
    assert.equal(M.dolar, 6);
  });
  test('limite da CoinGecko (429) vira mensagem clara', async () => {
    simular(/api\.coingecko\.com/, { status: 429 });
    simular(/alternative\.me|awesomeapi/, { status: 500 });
    await assert.rejects(C.atualizar(['bitcoin']), /limitou as consultas/);
  });
  test('buscar e resolverSimbolos: conhecidas, quadro padrão e busca pelo maior valor de mercado', async () => {
    simular(/\/search\?query=ONDO/, { coins: [{ id: 'ondo-fake', symbol: 'ondo', name: 'Falso', market_cap_rank: 900 }, { id: 'ondo-finance', symbol: 'ondo', name: 'Ondo', market_cap_rank: 50 }] });
    simular(/\/search\?query=NADA/, { coins: [] });
    simular(/\/search\?query=ERRO/, { status: 500 });
    const r = await C.resolverSimbolos(['XYZ', 'BTC', 'ONDO', 'NADA', 'ERRO'], [{ simbolo: 'XYZ', coin_id: 'xyz-coin', nome: 'Xyz' }]);
    assert.deepEqual(r, { XYZ: { coin_id: 'xyz-coin', nome: 'Xyz' }, BTC: { coin_id: 'bitcoin', nome: 'Bitcoin' }, ONDO: { coin_id: 'ondo-finance', nome: 'Ondo' } });
  });
  test('atualizarSinais busca medo/ganância, dólar 30d e histórico de cada moeda', async () => {
    C.H.fng = null; C.H.dolar = null; delete C.H.coins.solana;
    simular('https://api.alternative.me/fng/?limit=31', { data: [{ value: '40' }, { value: '45' }] });
    simular('https://economia.awesomeapi.com.br/json/daily/USD-BRL/31', [{ bid: '5.4' }, { bid: '5.3' }]);
    simular(/coins\/solana\/market_chart/, { prices: [[1, 150.123456789], [2, 151]] });
    let avisos = 0;
    await C.atualizarSinais(['solana', 'tether'], () => avisos++);
    assert.deepEqual(C.H.fng.v, [40, 45]);
    assert.deepEqual(C.H.dolar.v, [5.4, 5.3]);
    assert.deepEqual(C.H.coins.solana.p, [150.123, 151]);
    assert.equal(chamadasPara(/tether\/market_chart/).length, 0, 'stablecoin não busca histórico');
    assert.ok(avisos >= 2);
    assert.equal(C.progresso.feitas, 1);
  });
  test('moeda sem histórico (404) não insiste', async () => {
    delete C.H.coins.morta;
    simular(/coins\/morta\/market_chart/, { status: 404 });
    await C.atualizarSinais(['morta']);
    assert.deepEqual(C.H.coins.morta.p, []);
  });
});
