// Compras programadas de cripto: cada débito "Compra de criptomoedas" do extrato (fin_tx) vira uma compra na carteira
// cripto (crypto_tx), conforme o plano (crypto_plano: moeda + valor). O banco não informa a moeda nem a quantidade:
//   - a moeda vem do plano, pelo valor (no mesmo dia, cada item do plano casa com um débito do mesmo valor);
//   - a quantidade é estimada pela cotação do dia na CoinGecko (em reais, perto do meio-dia). O Nubank cobra uma diferença no preço,
//     então a quantidade real é um pouco menor; o acerto vem quando o saldo do app é lançado de novo.
// Débito que não casa com o plano (compra avulsa, valor diferente) fica de fora e é devolvido em `sem_plano`.
// Só débitos a partir do `inicio` do item (os anteriores já estão no saldo lançado à mão) e nunca o mesmo duas vezes
// (crypto_tx.fin_tx_id é único).
type SB = any;
const CG = 'https://api.coingecko.com/api/v3';
const centavos = (v: number) => Math.round(Math.abs(+v) * 100);

// Preços em reais de uma moeda num período: UMA consulta por moeda (a CoinGecko grátis aceita poucas por minuto,
// e o IP do servidor é dividido com outros). Devolve [ms, preço] em ordem; se vier o limite (429), espera e tenta de novo.
const espera = (ms: number) => new Promise(r => setTimeout(r, ms));
async function precosPeriodo(id: string, de: string, ate: string): Promise<[number, number][]> {
  const from = Math.floor(Date.parse(de + 'T00:00:00Z') / 1000) - 86400, to = Math.floor(Date.parse(ate + 'T23:59:59Z') / 1000) + 86400;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await fetch(`${CG}/coins/${encodeURIComponent(id)}/market_chart/range?vs_currency=brl&from=${from}&to=${to}`).catch(() => null);
    if (r?.ok) {
      const j = await r.json().catch(() => ({}));
      return (j.prices || []).filter((p: any) => +p[1] > 0);
    }
    if (r && r.status !== 429) return [];
    await espera(ESPERA_LIMITE_MS); // limite (o 429 às vezes chega como falha de rede, sem CORS)
  }
  return [];
}
export let ESPERA_LIMITE_MS = 20000;
export const ajustarEspera = (ms: number) => { ESPERA_LIMITE_MS = ms; }; // testes
// Preço mais perto do meio-dia (Brasília) do dia da compra
function precoNoDia(pts: [number, number][], data: string) {
  const alvo = Date.parse(data + 'T15:00:00Z');
  let melhor: [number, number] | null = null;
  for (const p of pts) if (!melhor || Math.abs(p[0] - alvo) < Math.abs(melhor[0] - alvo)) melhor = p;
  return melhor && Math.abs(melhor[0] - alvo) < 2 * 86400e3 ? melhor[1] : null;
}

export async function criptoRecorrente(sb: SB, { hoje }: { hoje?: string } = {}) {
  const { data: plano, error } = await sb.from('crypto_plano').select('*').eq('ativo', true);
  if (error || !plano?.length) return { lancados: 0, sem_plano: 0 };
  const inicio = plano.map((p: any) => p.inicio).sort()[0];
  const { data: debitos } = await sb.from('fin_tx').select('id, data, valor, descricao, status')
    .ilike('descricao', 'compra de criptomoeda%').lt('valor', 0).gte('data', inicio);
  const { data: feitos } = await sb.from('crypto_tx').select('fin_tx_id').not('fin_tx_id', 'is', null);
  const usados = new Set((feitos || []).map((x: any) => x.fin_tx_id));
  const dia = hoje || new Date().toISOString().slice(0, 10);
  const livres = (debitos || []).filter((t: any) => !usados.has(t.id) && t.data <= dia && t.status !== 'PENDING');

  // Casa por dia: cada item do plano pega um débito do mesmo valor naquele dia
  const porDia = new Map<string, any[]>();
  for (const t of livres) porDia.set(t.data, [...(porDia.get(t.data) || []), t]);
  const pares: { t: any; p: any }[] = [];
  let semPlano = 0;
  for (const [data, lista] of [...porDia.entries()].sort()) {
    const pool = [...lista];
    for (const p of plano.filter((p: any) => p.inicio <= data).sort((a: any, b: any) => String(a.simbolo).localeCompare(b.simbolo))) {
      const i = pool.findIndex(t => centavos(t.valor) === centavos(p.valor));
      if (i >= 0) pares.push({ t: pool.splice(i, 1)[0], p });
    }
    semPlano += pool.length;
  }

  // Uma consulta por moeda, cobrindo todas as datas dela
  const serie = new Map<string, [number, number][]>();
  for (const id of [...new Set(pares.map(x => x.p.coin_id))]) {
    const datas = pares.filter(x => x.p.coin_id === id).map(x => x.t.data).sort();
    if (serie.size) await espera(1500);
    serie.set(id, await precosPeriodo(id, datas[0], datas[datas.length - 1]));
  }
  const linhas: any[] = [];
  for (const { t, p } of pares) {
    const preco = precoNoDia(serie.get(p.coin_id) || [], t.data);
    if (!preco) continue;
    const valor = Math.abs(+t.valor);
    linhas.push({
      coin_id: p.coin_id, simbolo: p.simbolo, nome: p.nome || p.simbolo, tipo: 'compra', data: t.data,
      quantidade: +(valor / preco).toPrecision(10), preco_brl: +preco.toFixed(8), taxa_brl: 0, corretora: p.corretora || 'Nubank',
      obs: `Compra programada (R$ ${valor.toFixed(2).replace('.', ',')}); quantidade estimada pela cotação do dia`, fin_tx_id: t.id,
    });
  }
  if (linhas.length) {
    const { error: e } = await sb.from('crypto_tx').insert(linhas);
    if (e) throw new Error(e.message);
  }
  return { lancados: linhas.length, sem_plano: semPlano, ...(linhas.length < pares.length ? { sem_cotacao: pares.length - linhas.length } : {}) };
}
