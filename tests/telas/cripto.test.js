// Tela Cripto: abas Mercado (quadro, ordenação, favoritas, detalhes), Carteira (posições, lançamentos, CSV, imposto, blockchain) e Sinais.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, textoSep, clicar, preencher, enviarModal, esperar, ate } from '../helpers/dom.js';
import { abrirHub, trocarDados } from '../helpers/tela.js';
import { banco } from '../helpers/fake-supabase.js';
import { simular, limparRede } from '../helpers/rede.js';

let V, S, el;
const nb = s => s.replace(/ /g, ' ');
const AGORA = Date.parse('2026-10-19T15:00:00Z');
const coin = (id, simbolo, brl, x = {}) => ({ id, simbolo, nome: x.nome || simbolo, brl, usd: brl / 5, ch24: 1, ch7: 2, rank: 1, mcap: 1e12, vol: 1e10, ath: -10, ...x });
const MERCADO = {
  coins: {
    bitcoin: coin('bitcoin', 'BTC', 600000, { nome: 'Bitcoin', ch24: 3, rank: 1 }),
    ethereum: coin('ethereum', 'ETH', 20000, { nome: 'Ethereum', ch24: -4, rank: 2 }),
    'usd-coin': coin('usd-coin', 'USDC', 5, { nome: 'USDC', ch24: 0, rank: 6, usd: 1 }),
    solana: coin('solana', 'SOL', 1000, { nome: 'Solana', ch24: 1, rank: 5 }),
  },
  global: { dom: 57.5, mcap: 2e13, mcapUsd: 4e12, ch24: 1.2 }, fng: { v: 72, c: 'Greed' }, dolar: 5, at: AGORA,
};
const serie = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const HIST = {
  coins: {
    bitcoin: { at: AGORA, p: serie(250, i => 200000 - i * 320) }, // caindo até ~US$ 120 mil (= cotação atual): abaixo das médias
    ethereum: { at: AGORA, p: serie(250, i => 2000 + i * 8) }, // subindo até ~US$ 4 mil
    solana: { at: AGORA, p: serie(250, i => 200) },
  },
  fng: { at: AGORA, v: serie(31, i => 50 + (i % 5)) }, dolar: { at: AGORA, v: serie(31, () => 5) }, dom: {},
};
const WATCH = [
  { id: 'w1', coin_id: 'bitcoin', simbolo: 'BTC', nome: 'Bitcoin', ordem: 0, favorita: false },
  { id: 'w2', coin_id: 'ethereum', simbolo: 'ETH', nome: 'Ethereum', ordem: 1, favorita: true },
  { id: 'w3', coin_id: 'usd-coin', simbolo: 'USDC', nome: 'USDC', ordem: 2, favorita: false },
];
const TX = [
  { id: 'x1', data: '2026-01-10', tipo: 'compra', coin_id: 'bitcoin', simbolo: 'BTC', nome: 'Bitcoin', quantidade: 0.1, preco_brl: 400000, taxa_brl: 0, corretora: 'Nubank' },
  { id: 'x2', data: '2026-02-10', tipo: 'compra', coin_id: 'ethereum', simbolo: 'ETH', nome: 'Ethereum', quantidade: 2, preco_brl: 15000, taxa_brl: 10, corretora: 'Binance' },
  { id: 'x3', data: '2026-03-10', tipo: 'venda', coin_id: 'ethereum', simbolo: 'ETH', nome: 'Ethereum', quantidade: 1, preco_brl: 40000, taxa_brl: 0, corretora: 'Binance' },
];
const DADOS = (x = {}) => ({ crypto_watch: WATCH, crypto_tx: TX, crypto_snap: [], ...x });
// CoinGecko/alternative.me/AwesomeAPI respondendo com as cotações de MERCADO
function simularCotacoes() {
  const cs = Object.values(MERCADO.coins);
  simular(/coins\/markets\?vs_currency=brl/, cs.map(c => ({ id: c.id, symbol: c.simbolo.toLowerCase(), name: c.nome, current_price: c.brl, market_cap_rank: c.rank,
    price_change_percentage_24h_in_currency: c.ch24, price_change_percentage_7d_in_currency: c.ch7, market_cap: c.mcap, total_volume: c.vol, ath_change_percentage: c.ath })));
  simular(/coins\/markets\?vs_currency=usd/, cs.map(c => ({ id: c.id, current_price: c.usd })));
  simular('https://api.coingecko.com/api/v3/global', { data: { market_cap_percentage: { btc: 57.5 }, total_market_cap: { brl: 2e13, usd: 4e12 }, market_cap_change_percentage_24h_usd: 1.2 } });
  simular('https://api.alternative.me/fng/', { data: [{ value: '72', value_classification: 'Greed' }] });
  simular('https://economia.awesomeapi.com.br/json/last/USD-BRL', { USDBRL: { bid: '5' } });
}
const irPara = async aba => { location.hash = '#/cripto?' + aba; V.render(el); await esperar(10); };
before(async () => {
  ({ S } = await abrirHub({ supabase: true, tabelas: DADOS() }));
  localStorage.setItem('hub:cripto-mercado', JSON.stringify(MERCADO));
  localStorage.setItem('hub:cripto-hist', JSON.stringify(HIST));
  V = await hub('v-cripto.js');
  el = $('#view');
});
beforeEach(async () => { $('#modal').open && $('#modal').close(); limparRede(); (await hub('moeda.js')).trocar('BRL'); });

describe('Mercado', () => {
  before(async () => { await trocarDados(DADOS(), { supabase: true }); await irPara('mercado'); });
  test('indicadores do topo: dólar, dominância, valor total e medo/ganância', () => {
    const k = $$('.kpis .kpi').map(x => nb(textoSep(x)));
    assert.equal(k[0], 'Dólar R$ 5,00');
    assert.equal(k[1], 'Dominância do BTC 57,5%');
    assert.match(k[3], /^Medo e Ganância 72 Ganância/);
    assert.equal(texto('#crAt'), 'atualizado agora');
  });
  test('quadro: favorita primeiro, depois a minha ordem; quantidade na carteira', () => {
    assert.deepEqual($$('tr[data-coin]').map(r => r.dataset.coin), ['ethereum', 'bitcoin', 'usd-coin']);
    assert.equal(nb(textoSep($('tr[data-coin=bitcoin] td:nth-child(12)'))), '0,1 R$ 60.000,00');
  });
  test('destaques de alta, queda e máxima histórica', () => {
    const chips = $$('.insights .chip-static').map(texto);
    assert.equal(chips[0], 'Maior alta 24h: BTC +3,00%');
    assert.equal(chips[1], 'Maior queda 24h: ETH -4,00%');
  });
  test('ordenar pela coluna 24h: maior primeiro, depois menor, depois volta à minha ordem', async () => {
    await clicar('[data-sort=ch24]');
    assert.deepEqual($$('tr[data-coin]').map(r => r.dataset.coin), ['ethereum', 'bitcoin', 'usd-coin'], 'favorita continua no topo');
    await clicar('[data-sort=ch24]');
    assert.deepEqual($$('tr[data-coin]').map(r => r.dataset.coin), ['ethereum', 'usd-coin', 'bitcoin']);
    assert.ok($('#crMine'));
    await clicar('[data-sort=ch24]');
    assert.equal($('#crMine'), null);
  });
  test('favoritar e remover (2 cliques) gravam no banco', async () => {
    await clicar('[data-fav=w1]');
    assert.equal(banco().t('crypto_watch').find(w => w.id === 'w1').favorita, true);
    V.render(el);
    await clicar('[data-rm=w3]');
    assert.equal(banco().t('crypto_watch').length, 3);
    await clicar('[data-rm=w3]');
    assert.equal(banco().t('crypto_watch').length, 2);
    assert.equal(texto('#toast'), 'USDC removida do quadro');
    await trocarDados(DADOS(), { supabase: true }); V.render(el);
  });
  test('clicar numa moeda mostra os detalhes com médias e RSI', async () => {
    await clicar('tr[data-coin=bitcoin]');
    assert.match(textoSep('.cr-sel'), /Bitcoin BTC · #1 em valor de mercado/);
    const k = Object.fromEntries($$('.cr-det .kpi').map(x => [texto(x.querySelector('span')), nb(textoSep(x))]));
    assert.match(k['RSI de 14 dias'], /RSI de 14 dias 0 sobrevendido/);
    assert.match(k['Média de 200 dias'], /preço .* abaixo/);
    assert.match(k['Na sua carteira'], /0,1 BTC · médio R\$ 400\.000/);
    await clicar('#crSelX');
    assert.equal($('.cr-sel'), null);
  });
  test('detalhe traz o gráfico de preço: resumo, dica ao percorrer e troca de período', async () => {
    const T = Date.parse('2026-10-19T00:00:00Z');
    simular(/ethereum\/market_chart\?vs_currency=brl&days=30$/, { prices: serie(31, i => [T - (30 - i) * 864e5, 20000 + i * 100]) });
    simular(/ethereum\/market_chart\?vs_currency=brl&days=7$/, { prices: serie(8, i => [T - (7 - i) * 864e5, 25000 - i * 100]) });
    await clicar('tr[data-coin=ethereum]');
    await ate(() => $('.cr-graf-hit'), { msg: 'gráfico desenhado' });
    assert.match(nb(texto('#crGrafRes')), /^\+15,00% em 30 dias · mín\. R\$ 20\.000 · máx\. R\$ 23\.000 · seu preço médio R\$ 15\.005 \(abaixo do gráfico\)$/);
    assert.equal($('.cr-graf [data-per="30"]').classList.contains('on'), true);
    // percorrer pelo teclado (o mouse usa o mesmo caminho): início, um passo à direita, fim
    const hit = $('.cr-graf-hit');
    hit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.match(nb(textoSep('.cr-graf-tip')), /^R\$ 20\.000 .* 0,00% desde o início do período \+33,29% sobre o seu preço médio$/);
    assert.equal($('.cr-graf-mira').hasAttribute('hidden'), false, 'linha vertical e ponto aparecem');
    hit.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.match(nb(texto('.cr-graf-tip')), /^R\$ 20\.100/);
    hit.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.match(nb(textoSep('.cr-graf-tip')), /^R\$ 23\.000 .*\+15,00% desde o início/);
    hit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal($('.cr-graf-mira').hasAttribute('hidden'), true);
    // outro período: nova consulta à CoinGecko
    await clicar('.cr-graf [data-per="7"]');
    await ate(() => /em 7 dias/.test(texto('#crGrafRes')), { msg: 'período de 7 dias' });
    assert.match(nb(texto('#crGrafRes')), /^-2,80% em 7 dias · mín\. R\$ 24\.300 · máx\. R\$ 25\.000/);
    // CoinGecko no limite: 90 dias sai do histórico diário dos Sinais (aproximado); 24h não tem reserva e avisa
    simular(/ethereum\/market_chart/, { status: 429 });
    await clicar('.cr-graf [data-per="90"]');
    await ate(() => /aproximado/.test(texto('#crGrafRes')), { msg: 'reserva do histórico diário' });
    assert.ok($('.cr-graf-hit'));
    await clicar('.cr-graf [data-per="1"]');
    await ate(() => /limitou/.test(texto('#crGrafArea')), { msg: 'aviso do limite' });
    assert.match(texto('#crGrafArea'), /Tentando de novo em instantes… Tentar agora/);
    await clicar('#crSelX');
  });
  test('"+ Carteira" abre o lançamento com a moeda e a cotação atual', async () => {
    await clicar('[data-buy=ethereum]');
    assert.equal(texto('#modalTitle'), 'Novo lançamento');
    assert.equal($('#txMoeda').value, 'ethereum');
    assert.equal($('#txP').value, '20000');
  });
  test('adicionar moeda pela busca da CoinGecko', async () => {
    simular(/coingecko|alternative|awesomeapi/, { status: 500 });
    simular(/\/search\?query=sol/, { coins: [{ id: 'solana', symbol: 'sol', name: 'Solana', thumb: 'x.png', market_cap_rank: 5 }, { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', thumb: 'b.png' }] });
    await clicar('#crAdd');
    const q = $('#crQ'); q.value = 'sol';
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await ate(() => $('#crRes [data-add=solana]'), { msg: 'resultado da busca' });
    assert.match(textoSep('#crRes'), /Bitcoin BTC no quadro/);
    await clicar('#crRes [data-add=solana]', 10);
    const w = banco().t('crypto_watch').find(w => w.coin_id === 'solana');
    assert.deepEqual({ simbolo: w.simbolo, ordem: w.ordem, favorita: w.favorita }, { simbolo: 'SOL', ordem: 3, favorita: false });
    await trocarDados(DADOS(), { supabase: true });
  });
  test('falha ao atualizar cotações mostra aviso mantendo as salvas', async () => {
    simular(/coingecko|alternative|awesomeapi/, { status: 429 });
    V.render(el);
    await clicar('#crRef', 15);
    await ate(() => $('.cr-banner'), { msg: 'aviso de erro' });
    assert.match(texto('.cr-banner'), /limitou as consultas.*Mostrando as últimas cotações salvas/);
  });
});

describe('Carteira', () => {
  before(async () => {
    // as carteiras da blockchain são relidas a cada 5 min: o relógio anda e as cotações continuam "de agora"
    globalThis.__relogio.avancar(6 * 60e3);
    (await hub('cripto.js')).M.at = Date.now();
    simularCotacoes();
    await trocarDados(DADOS({ cripto_carteiras: [{ id: 'k1', nome: 'OneKey EVM', lido_em: '2026-10-19T10:00:00Z' }],
      cripto_saldos: [{ id: 's1', carteira_id: 'k1', chain: 'base', coin_id: 'usd-coin', simbolo: 'USDC', quantidade: 1000 }, { id: 's2', carteira_id: 'k1', chain: 'polygon', coin_id: 'usd-coin', simbolo: 'USDC', quantidade: 500 }] }), { supabase: true });
    await irPara('carteira');
    await ate(() => $('.cr-oc-kpis'), { msg: 'bloco da blockchain' });
    await clicar('#crRef', 10); // cotação nova grava a foto do dia
    await ate(() => banco().t('crypto_snap').length, { msg: 'foto do dia' });
    V.render(el);
  });
  test('resumo: valor, custo, resultado e variação de 24h', () => {
    const k = $$('.kpis:not(.cr-oc-kpis) .kpi').map(x => nb(textoSep(x)));
    assert.equal(k[0], 'Valor atual R$ 80.000,00 US$ 16.000'); // 0,1 BTC (60 mil) + 1 ETH (20 mil)
    assert.equal(k[1], 'Custo total R$ 55.005,00'); // 40 mil + metade de 30.010
    assert.equal(k[2], 'Resultado R$ 24.995,00 +45,44%');
  });
  test('posições ordenadas por valor e lucro já realizado', () => {
    assert.deepEqual($$('.block table')[1].querySelectorAll('tbody tr').length, 2);
    assert.match(nb(textoSep('#view')), /Lucro\/prejuízo já realizado em vendas: R\$ 24\.995,00/);
  });
  test('vendas por mês com a situação do imposto', () => {
    const v = $$('section.block').find(s => /Vendas por mês/.test(s.textContent));
    assert.match(nb(textoSep(v)), /março 2026 1 R\$ 40\.000,00 R\$ 24\.995,00 Binance: R\$ 40 mil Acima de R\$ 35 mil ganho tributável/);
  });
  test('bloco das carteiras na blockchain soma as redes', () => {
    const b = $$('section.block').find(s => /Carteiras na blockchain/.test(s.textContent));
    assert.match(nb(textoSep(b)), /Valor nas carteiras R\$ 7\.500,00/);
    assert.match(texto(b), /OneKey EVM · Base, OneKey EVM · Polygon/);
    assert.match(texto(b), /última leitura 19 out/);
  });
  test('filtro de lançamentos por moeda', () => {
    const f = $('#crFiltro'); f.value = 'ethereum'; f.dispatchEvent(new Event('change'));
    assert.deepEqual($$('tr[data-tx]').map(r => r.dataset.tx), ['x3', 'x2']);
    const g = $('#crFiltro'); g.value = ''; g.dispatchEvent(new Event('change'));
    assert.equal($$('tr[data-tx]').length, 3);
  });
  test('alocação por moeda e por corretora', async () => {
    assert.deepEqual($$('.al-name').map(texto), ['BTC', 'ETH']);
    await clicar('[data-aloc=corretora]');
    assert.deepEqual($$('.al-name').map(texto), ['Nubank', 'Binance']);
    await clicar('[data-aloc=moeda]');
  });
  test('guarda a foto do dia da carteira (crypto_snap)', () => {
    const s = banco().t('crypto_snap');
    assert.deepEqual(s.map(x => [x.dia, x.valor_brl, x.custo_brl]), [['2026-10-19', 80000, 55005]]);
  });
  test('gráfico aparece a partir do 2º dia', async () => {
    assert.match(texto('#view'), /O gráfico aparece a partir do segundo dia/);
    banco().t('crypto_snap').push({ id: 'old', dia: '2026-10-10', valor_brl: 70000, custo_brl: 55005 });
    await trocarDados(banco().tabelas, { supabase: true });
    V.render(el);
    assert.ok($('.lc-svg'));
  });
  test('US$: valores convertidos pela cotação, imposto continua em reais', async () => {
    await clicar('[data-moeda=USD]', 10);
    assert.match(nb(textoSep($$('.kpis:not(.cr-oc-kpis) .kpi')[0])), /^Valor atual US\$ 16\.000,00 R\$ 80\.000,00/);
    assert.match(nb(textoSep('#view')), /R\$ 40\.000,00/); // vendas por mês
    await clicar('[data-moeda=BRL]', 10);
  });
});

describe('Lançamentos', () => {
  beforeEach(async () => { await trocarDados(DADOS(), { supabase: true }); await irPara('carteira'); });
  test('compra exige preço; venda maior que o saldo é recusada; transferência exige destino', async () => {
    await clicar('#crTx');
    const m = $('#modal');
    preencher(m, { coin_id: 'bitcoin', quantidade: '0,5', preco_brl: '' });
    await enviarModal();
    assert.match(texto('#modalErr'), /preço unitário/);
    preencher(m, { tipo: 'venda', preco_brl: '600000' });
    await enviarModal();
    assert.match(texto('#modalErr'), /Você tem 0,1 BTC registrados/);
    preencher(m, { tipo: 'transferencia', quantidade: '0,05' });
    assert.equal($('#txDL').hidden, false);
    assert.equal($('#txPL').hidden, true);
    await enviarModal();
    assert.match(texto('#modalErr'), /para onde foi/);
    preencher(m, { destino: 'OneKey', taxa_brl: '2,50' });
    assert.match(nb(textoSep('#txTot')), /Taxa de R\$ 2,50 entra no custo/);
    await enviarModal();
    const t = S.crypto_tx.find(x => x.tipo === 'transferencia');
    assert.deepEqual({ q: t.quantidade, p: t.preco_brl, taxa: t.taxa_brl, de: t.corretora, para: t.destino }, { q: 0.05, p: 0, taxa: 2.5, de: null, para: 'OneKey' });
  });
  test('compra válida com total ao vivo e toast', async () => {
    await clicar('#crTx');
    const m = $('#modal');
    preencher(m, { coin_id: 'ethereum', quantidade: '2', preco_brl: '900,5', taxa_brl: '1', corretora: 'Binance' });
    assert.match(nb(textoSep('#txTot')), /Total: R\$ 1\.802,00 · a cotação agora daria R\$ 40\.000,00/);
    await enviarModal();
    assert.equal(texto('#toast'), 'Compra de ETH registrada');
    assert.ok(S.crypto_tx.some(t => t.coin_id === 'ethereum' && t.preco_brl === 900.5));
  });
  test('editar e excluir lançamento', async () => {
    await clicar('tr[data-tx=x1]');
    assert.equal(texto('#modalTitle'), 'Lançamento');
    assert.equal($('#txQ').value, '0,1');
    await clicar('#delTx'); await clicar('#delTx');
    assert.ok(!S.crypto_tx.some(t => t.id === 'x1'));
  });
  test('exportar CSV e baixar modelo', async () => {
    const baixados = [];
    const blobs = new Map();
    URL.createObjectURL = b => { const u = 'blob:' + blobs.size; blobs.set(u, b); return u; };
    URL.revokeObjectURL = () => {};
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) baixados.push([this.download, blobs.get(this.getAttribute('href'))]); else click.call(this); };
    await clicar('#crExp');
    await clicar('#crModelo');
    HTMLAnchorElement.prototype.click = click;
    assert.deepEqual(baixados.map(b => b[0]), ['hub-cripto-2026-10-19.csv', 'modelo-cripto.csv']);
    const csv = await baixados[0][1].text();
    assert.match(csv, /^﻿?data;tipo;simbolo/);
    assert.equal(csv.trim().split('\r\n').length, 4);
  });
  test('importar CSV: ignora duplicados, resolve símbolo e lista erros', async () => {
    const csv = 'data;tipo;simbolo;coin_id;quantidade;preco_brl\n2026-01-10;compra;BTC;bitcoin;0,1;400000\n2026-04-01;compra;SOL;;3;800\n2026-04-02;compra;XYZ;;1;1\nontem;compra;BTC;bitcoin;1;1';
    simular(/coingecko|alternative|awesomeapi/, { status: 500 });
    simular(/\/search\?query=XYZ/, { coins: [] });
    const inp = $('#crImp');
    Object.defineProperty(inp, 'files', { value: [{ text: async () => csv }], configurable: true });
    inp.dispatchEvent(new Event('change'));
    await ate(() => $('#modal').open && /Importar lançamentos/.test(texto('#modalTitle')), { msg: 'modal de importação' });
    const corpo = texto('#modalBody');
    assert.match(corpo, /1 lançamento pronto para importar; 1 já existia e será ignorado/);
    assert.match(corpo, /Moeda não encontrada: XYZ/);
    assert.match(corpo, /1 linha com problema/);
    await enviarModal();
    await esperar(10);
    const sol = S.crypto_tx.find(t => t.coin_id === 'solana');
    assert.deepEqual({ q: sol.quantidade, nome: sol.nome }, { q: 3, nome: 'Solana' });
  });
  test('carteira vazia convida a lançar ou importar', async () => {
    await trocarDados({ crypto_watch: WATCH }, { supabase: true });
    V.render(el);
    assert.match(texto('#view'), /Nenhum lançamento ainda/);
    assert.equal($('#crExp').hidden, true);
  });
});

describe('Sinais', () => {
  before(async () => { await trocarDados(DADOS(), { supabase: true }); await irPara('sinais'); });
  test('aviso de que não é recomendação de investimento', () => {
    assert.match(texto('.sg-aviso'), /não são recomendação de investimento nem aconselhamento financeiro/);
  });
  test('clima do mercado: medo/ganância, bitcoin vs média, dominância e dólar', () => {
    const c = $$('.sg-clima li b').map(texto);
    assert.equal(c[0], 'Medo e Ganância em 72: Ganância');
    assert.equal(c[1], 'Bitcoin abaixo da média de 200 dias');
    assert.ok(c.some(t => /Dominância do BTC em 57,5%/.test(t)));
    assert.ok(c.some(t => /Dólar estável em 30 dias/.test(t)));
  });
  test('cartões por moeda, sem stablecoin; mais sinais de desconto primeiro', () => {
    const cards = $$('.sg-coins .sg-card');
    assert.deepEqual(cards.map(c => texto(c.querySelector('header b'))), ['Bitcoin', 'Ethereum']);
    assert.match(texto(cards[0].querySelector('.sg-n')), /^\d+ sinais de preço descontado$/);
    assert.match(texto(cards[0]), /RSI em 0: sobrevendido/);
    assert.match(texto(cards[1]), /Acima do seu preço médio/);
    assert.match(texto('.sg-resumo'), /Uma moeda tem 3 ou mais sinais de preço descontado: BTC/);
  });
});
