// Carteiras de autocustódia (OneKey, Rabby…) → Hub, lendo a blockchain pelo endereço PÚBLICO (só leitura).
//   - Bitcoin: saldo do endereço na mempool.space.
//   - EVM (mesmo 0x… em todas as redes): saldo nativo de cada rede por RPC público; tokens do Ethereum,
//     OP Mainnet e Avalanche pela Routescan (só os que têm preço: corta os "airdrops" de golpe);
//     nas outras redes, os tokens mais comuns (stablecoins, ARB, OP) por balanceOf.
//   - Cada token recebe o id da CoinGecko (para juntar com as compras da tela Cripto e pegar o preço em R$).
// Corpo: {} lê todas · {carteira: "<uuid>"} lê uma. Chamada pelo cron (2x por dia) e pela tela Finanças.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hub-cron' };

type Rede = { id: string; nome: string; rpc: string; nativo: { simbolo: string; coin: string }; tokens: [string, string, string, number][] };
// tokens: [contrato, símbolo, coin_id, casas decimais] — contratos conferidos na própria rede (symbol()) em 18/10/2026
const REDES: Rede[] = [
  { id: 'ethereum', nome: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', nativo: { simbolo: 'ETH', coin: 'ethereum' }, tokens: [] },
  { id: 'base', nome: 'Base', rpc: 'https://base-rpc.publicnode.com', nativo: { simbolo: 'ETH', coin: 'ethereum' },
    tokens: [['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 'usd-coin', 6]] },
  { id: 'arbitrum', nome: 'Arbitrum', rpc: 'https://arbitrum-one-rpc.publicnode.com', nativo: { simbolo: 'ETH', coin: 'ethereum' },
    tokens: [['0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'USDC', 'usd-coin', 6], ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', 'USDT', 'tether', 6],
      ['0x912ce59144191c1204e64559fe8253a0e49e6548', 'ARB', 'arbitrum', 18]] },
  { id: 'optimism', nome: 'OP Mainnet', rpc: 'https://optimism-rpc.publicnode.com', nativo: { simbolo: 'ETH', coin: 'ethereum' }, tokens: [] },
  { id: 'polygon', nome: 'Polygon', rpc: 'https://polygon-bor-rpc.publicnode.com', nativo: { simbolo: 'POL', coin: 'polygon-ecosystem-token' },
    tokens: [['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 'USDC', 'usd-coin', 6], ['0xc2132d05d31c914a87c6611c10748aeb04b58e8f', 'USDT', 'tether', 6]] },
  { id: 'bsc', nome: 'BNB Chain', rpc: 'https://bsc-rpc.publicnode.com', nativo: { simbolo: 'BNB', coin: 'binancecoin' },
    tokens: [['0x55d398326f99059ff775485246999027b3197955', 'USDT', 'tether', 18], ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 'USDC', 'usd-coin', 18]] },
  { id: 'avalanche', nome: 'Avalanche', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', nativo: { simbolo: 'AVAX', coin: 'avalanche-2' }, tokens: [] },
];
// Routescan (multirrede) → nome da rede no Hub e plataforma na CoinGecko
const ROUTESCAN: Record<string, [string, string]> = { '1': ['ethereum', 'ethereum'], '10': ['optimism', 'optimistic-ethereum'], '43114': ['avalanche', 'avalanche'] };
const ID_POR_SIMBOLO: Record<string, string> = { ONDO: 'ondo-finance', USDT: 'tether', USDC: 'usd-coin', DAI: 'dai', WBTC: 'wrapped-bitcoin', WETH: 'weth',
  ARB: 'arbitrum', OP: 'optimism', LINK: 'chainlink', UNI: 'uniswap', AAVE: 'aave', PEPE: 'pepe', SHIB: 'shiba-inu', LDO: 'lido-dao', STETH: 'staked-ether' };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if (!(await autorizado(req, sb))) return json({ error: 'não autorizado' }, 401);
  const body = await req.json().catch(() => ({}));
  let q = sb.from('cripto_carteiras').select('*');
  if (body.carteira) q = q.eq('id', body.carteira);
  const { data: carteiras, error } = await q;
  if (error) return json({ erro: error.message });
  const res: Record<string, unknown> = { carteiras: carteiras?.length || 0, saldos: 0 };
  const erros: string[] = [];
  for (const c of carteiras || []) {
    try {
      const { data: antes } = await sb.from('cripto_saldos').select('chain, token, coin_id').eq('carteira_id', c.id);
      const ids = new Map((antes || []).map((r: any) => [`${r.chain}|${r.token}`, r.coin_id]));
      const { lista, avisos } = c.rede === 'btc' ? await bitcoin(c.endereco) : await evm(c.endereco, ids);
      const agora = new Date().toISOString();
      const rows = lista.filter(s => s.quantidade > 0).map(s => ({ carteira_id: c.id, ...s, atualizado_em: agora }));
      if (rows.length) { const { error: e } = await sb.from('cripto_saldos').upsert(rows, { onConflict: 'carteira_id,chain,token' }); if (e) throw new Error(e.message); }
      // O que zerou ou sumiu sai da lista
      const vivos = new Set(rows.map(r => `${r.chain}|${r.token}`));
      for (const r of antes || []) if (!vivos.has(`${r.chain}|${r.token}`)) await sb.from('cripto_saldos').delete().eq('carteira_id', c.id).eq('chain', r.chain).eq('token', r.token);
      await sb.from('cripto_carteiras').update({ lido_em: agora, erro: avisos.length ? avisos.join(' · ') : null }).eq('id', c.id);
      res.saldos = (res.saldos as number) + rows.length;
    } catch (e) {
      erros.push(`${c.nome || c.endereco.slice(0, 10)}: ${(e as Error).message}`);
      await sb.from('cripto_carteiras').update({ erro: (e as Error).message, lido_em: new Date().toISOString() }).eq('id', c.id);
    }
  }
  if (erros.length) res.erro = erros.join(' · ');
  await sb.from('app_config').upsert({ key: 'cripto_status', value: JSON.stringify({ em: new Date().toISOString(), ...res }) }, { onConflict: 'key' });
  return json(res);
});

type Saldo = { chain: string; token: string; simbolo: string; nome: string; coin_id: string | null; quantidade: number; preco_usd: number | null };

async function bitcoin(end: string) {
  const r = await getJson(`https://mempool.space/api/address/${end}`);
  const sats = r.chain_stats.funded_txo_sum - r.chain_stats.spent_txo_sum + r.mempool_stats.funded_txo_sum - r.mempool_stats.spent_txo_sum;
  const avisos = r.chain_stats.tx_count + r.mempool_stats.tx_count === 0 ? ['este endereço nunca recebeu bitcoin: a carteira pode estar usando outro endereço'] : [];
  return { lista: [{ chain: 'bitcoin', token: 'native', simbolo: 'BTC', nome: 'Bitcoin', coin_id: 'bitcoin', quantidade: sats / 1e8, preco_usd: null }] as Saldo[], avisos };
}

async function evm(end: string, ids: Map<string, string | null>) {
  const lista: Saldo[] = [], avisos: string[] = [];
  const addr = end.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  await Promise.all(REDES.map(async rd => {
    try {
      const wei = BigInt(await rpc(rd.rpc, 'eth_getBalance', [end, 'latest']));
      lista.push({ chain: rd.id, token: 'native', simbolo: rd.nativo.simbolo, nome: `${rd.nativo.simbolo} (${rd.nome})`, coin_id: rd.nativo.coin, quantidade: Number(wei) / 1e18, preco_usd: null });
      for (const [ct, sim, coin, dec] of rd.tokens) {
        const v = BigInt(await rpc(rd.rpc, 'eth_call', [{ to: ct, data: '0x70a08231' + addr }, 'latest']) || '0x0');
        if (v > 0n) lista.push({ chain: rd.id, token: ct, simbolo: sim, nome: `${sim} (${rd.nome})`, coin_id: coin, quantidade: Number(v) / 10 ** dec, preco_usd: null });
      }
    } catch (e) { avisos.push(`${rd.nome}: ${(e as Error).message}`); }
  }));
  // Tokens do Ethereum / OP / Avalanche pela Routescan; sem preço = provavelmente golpe, fica de fora
  try {
    let url = `https://api.routescan.io/v2/network/mainnet/evm/all/address/${end}/erc20-holdings?limit=100`;
    for (let n = 0; url && n < 5; n++) {
      const r = await getJson(url);
      for (const t of r.items || []) {
        const rede = ROUTESCAN[t.chainId];
        if (!rede || !t.tokenPrice) continue;
        const ct = String(t.tokenAddress).toLowerCase();
        const chave = `${rede[0]}|${ct}`;
        const sim = String(t.tokenSymbol || '').toUpperCase();
        const coin = ids.get(chave) || ID_POR_SIMBOLO[sim] || await coinIdPorContrato(rede[1], ct);
        lista.push({ chain: rede[0], token: ct, simbolo: sim, nome: t.tokenName || sim, coin_id: coin, quantidade: Number(BigInt(t.tokenQuantity)) / 10 ** t.tokenDecimals, preco_usd: +t.tokenPrice || null });
      }
      url = r.link?.next ? `https://api.routescan.io${r.link.next}` : '';
    }
  } catch (e) { avisos.push(`tokens: ${(e as Error).message}`); }
  return { lista, avisos };
}

async function coinIdPorContrato(plataforma: string, ct: string) {
  try { return (await getJson(`https://api.coingecko.com/api/v3/coins/${plataforma}/contract/${ct}`)).id || null; } catch { return null; }
}
async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json().catch(() => ({}));
  if (j.error || !('result' in j)) throw new Error(j.error?.message || `RPC ${r.status}`);
  return j.result as string;
}
async function getJson(url: string) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Hub)' } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}`);
  return r.json();
}
async function autorizado(req: Request, sb: any) {
  const cron = req.headers.get('x-hub-cron');
  if (cron) {
    const { data } = await sb.from('app_secrets').select('value').eq('key', 'cron_token').single();
    return !!data && data.value === cron;
  }
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt.startsWith('sb_')) return false;
  const { data } = await sb.auth.getUser(jwt);
  return !!data?.user;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
