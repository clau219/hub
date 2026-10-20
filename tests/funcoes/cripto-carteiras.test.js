// Edge Function cripto-carteiras: saldos de carteiras de autocustódia lidos na blockchain (Bitcoin e redes EVM), tudo simulado.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, comCron } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let fn;
const EVM = '0x6F269215a69aAbcB29a07D9450cD489cAAd15B7a', BTC = '3PDdhEuviXkmkLKTAKvCdJ6B7XhcHwJzMw';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', ARB = '0x912ce59144191c1204e64559fe8253a0e49e6548';
const hex = n => '0x' + BigInt(n).toString(16);
// RPC falso: saldo nativo por rede e balanceOf por contrato; rede em "falha" responde erro
function rpc({ nativo = {}, tokens = {}, falha = [] } = {}) {
  simular(/publicnode\.com/, req => {
    const rede = new URL(req.url).hostname.split('-')[0];
    const { method, params } = req.json();
    if (falha.includes(rede)) return { jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } };
    if (method === 'eth_getBalance') return { jsonrpc: '2.0', id: 1, result: hex(nativo[rede] || 0) };
    if (method === 'eth_call') return { jsonrpc: '2.0', id: 1, result: hex(tokens[params[0].to] || 0) };
    return { error: { message: 'método?' } };
  });
}
const routescan = (paginas) => {
  simular(/api\.routescan\.io/, req => (new URL(req.url).searchParams.get('pagina') === '2' ? paginas[1] : paginas[0]));
};
const ler = (corpo = {}) => fn(pedido('/cripto-carteiras', { corpo, auth: 'cron' })).then(lerJson);
before(async () => { fn = await carregarFuncao('cripto-carteiras'); });
beforeEach(() => limparRede());

describe('cripto-carteiras: acesso', () => {
  test('sem credencial ou com chave pública: 401; usuário e agendador: ok', async () => {
    novoBanco(comCron({ cripto_carteiras: [] }));
    assert.equal((await fn(pedido('/cripto-carteiras', { corpo: {}, auth: null }))).status, 401);
    assert.equal((await fn(pedido('/cripto-carteiras', { corpo: {}, auth: 'anon' }))).status, 401);
    assert.equal((await fn(pedido('/cripto-carteiras', { corpo: {}, auth: 'usuario' }))).status, 200);
    assert.deepEqual(await ler(), { status: 200, corpo: { carteiras: 0, saldos: 0 } });
  });
});

describe('Bitcoin', () => {
  test('saldo do endereço (confirmado + mempool) em BTC', async () => {
    novoBanco(comCron({ cripto_carteiras: [{ id: 'k1', nome: 'OneKey BTC', rede: 'btc', endereco: BTC }] }));
    simular(`https://mempool.space/api/address/${BTC}`, { chain_stats: { funded_txo_sum: 5_000_000, spent_txo_sum: 1_705_640, tx_count: 4 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } });
    const { corpo } = await ler();
    assert.deepEqual(corpo, { carteiras: 1, saldos: 1 });
    const s = banco().t('cripto_saldos')[0];
    assert.deepEqual([s.carteira_id, s.chain, s.token, s.coin_id, s.quantidade], ['k1', 'bitcoin', 'native', 'bitcoin', 0.0329436]);
    const c = banco().t('cripto_carteiras')[0];
    assert.equal(c.erro, null);
    assert.equal(c.lido_em, '2026-10-19T15:00:00.000Z');
    assert.deepEqual(JSON.parse(banco().t('app_config')[0].value), { em: '2026-10-19T15:00:00.000Z', carteiras: 1, saldos: 1 });
  });
  test('endereço que nunca recebeu nada: avisa que a carteira pode usar outro endereço', async () => {
    novoBanco(comCron({ cripto_carteiras: [{ id: 'k1', rede: 'btc', endereco: 'bc1pvazio' }] }));
    simular('https://mempool.space/api/address/bc1pvazio', { chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } });
    await ler();
    assert.match(banco().t('cripto_carteiras')[0].erro, /nunca recebeu bitcoin/);
    assert.equal(banco().t('cripto_saldos').length, 0, 'saldo zero não é gravado');
  });
  test('falha na consulta: erro na carteira e no resultado', async () => {
    novoBanco(comCron({ cripto_carteiras: [{ id: 'k1', nome: 'Fria', rede: 'btc', endereco: BTC }] }));
    simular(/mempool\.space/, { status: 503 });
    const { corpo } = await ler();
    assert.equal(corpo.erro, 'Fria: mempool.space 503');
    assert.equal(banco().t('cripto_carteiras')[0].erro, 'mempool.space 503');
  });
});

describe('EVM (mesmo endereço em todas as redes)', () => {
  const carteira = () => comCron({
    cripto_carteiras: [{ id: 'k2', nome: 'OneKey EVM', rede: 'evm', endereco: EVM }, { id: 'k3', nome: 'Outra', rede: 'btc', endereco: BTC }],
    cripto_saldos: [{ id: 'velho', carteira_id: 'k2', chain: 'avalanche', token: 'native', coin_id: 'avalanche-2', quantidade: 3 }],
  });
  test('nativo de cada rede, stablecoins por balanceOf e tokens com preço pela Routescan', async () => {
    novoBanco(carteira());
    rpc({ nativo: { base: 5n * 10n ** 17n, polygon: 21n * 10n ** 18n }, tokens: { [USDC_BASE]: 1_363_500_000n, [ARB]: 4n * 10n ** 18n } });
    routescan([{ items: [
      { chainId: '1', tokenAddress: '0xONDO', tokenSymbol: 'ondo', tokenName: 'Ondo', tokenQuantity: '842000000000000000000', tokenDecimals: 18, tokenPrice: '0.9' },
      { chainId: '1', tokenAddress: '0xGOLPE', tokenSymbol: 'FREE', tokenName: 'Claim airdrop', tokenQuantity: '1000', tokenDecimals: 0, tokenPrice: null },
      { chainId: '137', tokenAddress: '0xOUTRA', tokenSymbol: 'X', tokenQuantity: '1', tokenDecimals: 0, tokenPrice: '1' },
      { chainId: '10', tokenAddress: '0xNOVO', tokenSymbol: 'NOVO', tokenName: 'Novo', tokenQuantity: '5', tokenDecimals: 0, tokenPrice: '2' },
    ], link: { next: '/v2/network/mainnet/evm/all/address/x/erc20-holdings?pagina=2' } }, { items: [
      { chainId: '43114', tokenAddress: '0xUSDTAVAX', tokenSymbol: 'USDT', tokenName: 'Tether', tokenQuantity: '2500000', tokenDecimals: 6, tokenPrice: '1' },
    ] }]);
    simular('https://api.coingecko.com/api/v3/coins/optimistic-ethereum/contract/0xnovo', { id: 'novo-coin' });
    const { corpo } = await ler({ carteira: 'k2' });
    assert.deepEqual(corpo, { carteiras: 1, saldos: 7 });
    const s = Object.fromEntries(banco().t('cripto_saldos').map(x => [`${x.chain}|${x.token}`, x]));
    assert.equal(s['base|native'].quantidade, 0.5);
    assert.equal(s['base|native'].nome, 'ETH (Base)');
    assert.equal(s[`base|${USDC_BASE}`].quantidade, 1363.5);
    assert.equal(s[`arbitrum|${ARB}`].quantidade, 4);
    assert.equal(s['polygon|native'].coin_id, 'polygon-ecosystem-token');
    assert.deepEqual([s['ethereum|0xondo'].coin_id, s['ethereum|0xondo'].quantidade, s['ethereum|0xondo'].preco_usd], ['ondo-finance', 842, 0.9]);
    assert.equal(s['optimism|0xnovo'].coin_id, 'novo-coin');
    assert.equal(s['avalanche|0xusdtavax'].quantidade, 2.5);
    assert.ok(!s['ethereum|0xgolpe'], 'token sem preço (golpe) fica de fora');
    assert.ok(!s['avalanche|native'], 'saldo que zerou é apagado');
    assert.equal(chamadasPara(/mempool/).length, 0, 'só a carteira pedida foi lida');
  });
  test('uma rede fora do ar vira aviso, as outras são gravadas', async () => {
    novoBanco(carteira());
    rpc({ nativo: { base: 10n ** 18n }, falha: ['bsc'] });
    routescan([{ items: [] }]);
    const { corpo } = await ler({ carteira: 'k2' });
    assert.equal(corpo.saldos, 1);
    assert.equal(banco().t('cripto_carteiras')[0].erro, 'BNB Chain: rate limited');
  });
  test('coin_id já conhecido de uma leitura anterior é reaproveitado', async () => {
    novoBanco(comCron({ cripto_carteiras: [{ id: 'k2', rede: 'evm', endereco: EVM }],
      cripto_saldos: [{ id: 'a', carteira_id: 'k2', chain: 'ethereum', token: '0xabc', coin_id: 'meu-id', quantidade: 1 }] }));
    rpc();
    routescan([{ items: [{ chainId: '1', tokenAddress: '0xABC', tokenSymbol: 'ABC', tokenQuantity: '3', tokenDecimals: 0, tokenPrice: '5' }] }]);
    await ler();
    assert.equal(banco().t('cripto_saldos').find(x => x.token === '0xabc').coin_id, 'meu-id');
    assert.equal(chamadasPara(/coingecko/).length, 0);
  });
});
