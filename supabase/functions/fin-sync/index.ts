// Open Finance → Hub, pelo Meu Pluggy (grátis para uso pessoal; a Pluggy atualiza cada banco a cada 24 h).
//   - Lê as conexões de fin_items (o Item ID vem do dashboard da Pluggy), as contas/cartões e os lançamentos.
//   - Lançamento novo recebe categoria/negócio/casa pelas regras (fin_regras); os já existentes só têm valor,
//     descrição e status atualizados, então o que foi ajustado no Hub não se perde.
//   - Pendentes que sumiram na Pluggy (viraram outro lançamento ao compensar) são apagados.
// Corpo: {} sincroniza tudo · {item: "<id>", nome?} cadastra uma conexão e sincroniza · {dias: N} relê N dias
//        · {connect: true} devolve {connectToken} para abrir a janela da Pluggy (Pluggy Connect) no Hub.
// Chamada pelo cron (x-hub-cron, 2x por dia) e pelo botão da tela Finanças.
// Segredos: PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hub-cron' };
const API = 'https://api.pluggy.ai';
const TZ = 'America/Sao_Paulo';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if (!(await autorizado(req, sb))) return json({ error: 'não autorizado' }, 401);
  const body = await req.json().catch(() => ({}));
  if (body.connect) {
    try {
      const key = await apiKey();
      // Na conta grátis só o conector MeuPluggy funciona com bancos reais: a janela mostra só ele
      const cons = await pg(key, '/connectors?name=MeuPluggy').catch(() => ({ results: [] }));
      const meu = (cons.results || []).filter((c: any) => /meu\s*pluggy/i.test(c.name)).map((c: any) => c.id);
      const r = await fetch(`${API}/connect_token`, {
        method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: { clientUserId: 'hub', avoidDuplicates: true } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.accessToken) throw new Error(`Pluggy ${r.status} ao abrir a conexão: ${j.message || r.statusText}`);
      return json({ connectToken: j.accessToken, connectorIds: meu });
    } catch (e) {
      return json({ erro: (e as Error).message });
    }
  }
  let res: Record<string, unknown>;
  try {
    const key = await apiKey();
    if (body.item) {
      const id = String(body.item).trim();
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Item ID inválido (deve ter 36 caracteres, como 1a2b3c4d-...).');
      await pg(key, `/items/${id}`); // confere antes de gravar
      const { error } = await sb.from('fin_items').upsert({ id, nome: body.nome || null }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
    }
    res = await sincronizar(sb, key, body.item ? [String(body.item).trim()] : null, +body.dias || 0);
  } catch (e) {
    res = { erro: (e as Error).message };
  }
  await sb.from('app_config').upsert({ key: 'fin_status', value: JSON.stringify({ em: new Date().toISOString(), ...res }) }, { onConflict: 'key' });
  return json(res); // erro vai no corpo (com 500 o Hub não consegue ler a mensagem)
});

async function sincronizar(sb: any, key: string, so: string[] | null, dias: number) {
  let q = sb.from('fin_items').select('*');
  if (so) q = q.in('id', so);
  const { data: items, error } = await q;
  if (error) throw new Error(error.message);
  if (!items?.length) return { contas: 0, novos: 0, aviso: 'Nenhuma conexão cadastrada.' };
  const { data: regras } = await sb.from('fin_regras').select('*');

  let contas = 0, novos = 0, atualizados = 0, apagados = 0;
  const erros: string[] = [];
  for (const it of items) {
    try {
      const item = await pg(key, `/items/${it.id}`);
      const accs = (await pg(key, `/accounts?itemId=${it.id}`)).results || [];
      const nome = (it.nome && !/meu\s*pluggy/i.test(it.nome) ? it.nome : '') || nomeBanco(accs) || item.connector?.name || 'Banco';
      await sb.from('fin_items').update({
        nome, status: item.status, erro: item.error?.message || null,
        sincronizado_em: item.lastUpdatedAt || null, lido_em: new Date().toISOString(),
      }).eq('id', it.id);

      for (const a of accs) {
        const c = a.creditData || {};
        const { error: ea } = await sb.from('fin_contas').upsert({
          id: a.id, item_id: it.id, tipo: a.type, subtipo: a.subtype, nome: a.marketingName || a.name, numero: a.number,
          saldo: a.balance, limite: c.creditLimit ?? null, limite_disp: c.availableCreditLimit ?? null,
          fecha: dia(c.balanceCloseDate), vence: dia(c.balanceDueDate), atualizado_em: new Date().toISOString(),
        }, { onConflict: 'id' });
        if (ea) throw new Error(ea.message);
        contas++;

        // Desde quando: N dias pedidos; senão 10 dias antes do último lançamento; na primeira vez, 1 ano
        let desde = dias ? addDays(hojeSp(), -dias) : '';
        if (!desde) {
          const { data: ult } = await sb.from('fin_tx').select('data').eq('conta_id', a.id).order('data', { ascending: false }).limit(1);
          desde = ult?.[0]?.data ? addDays(ult[0].data, -10) : addDays(hojeSp(), -365);
        }
        const txs = await transacoes(key, a.id, desde);
        const r = await gravar(sb, a, txs, desde, regras || []);
        novos += r.novos; atualizados += r.atualizados; apagados += r.apagados;
      }
    } catch (e) {
      erros.push(`${it.nome || it.id}: ${(e as Error).message}`);
      await sb.from('fin_items').update({ erro: (e as Error).message, lido_em: new Date().toISOString() }).eq('id', it.id);
    }
  }
  return { contas, novos, atualizados, apagados, ...(erros.length ? { erro: erros.join(' · ') } : {}) };
}

async function gravar(sb: any, conta: any, txs: any[], desde: string, regras: any[]) {
  const ids = txs.map(t => t.id);
  const existentes = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('fin_tx').select('id').in('id', ids.slice(i, i + 200));
    (data || []).forEach((r: any) => existentes.add(r.id));
  }
  const agora = new Date().toISOString();
  const base = (t: any) => {
    const cc = t.creditCardMetadata || {};
    const pd = t.paymentData || {};
    const outro = t.type === 'CREDIT' ? pd.payer : pd.receiver;
    return {
      id: t.id, conta_id: conta.id, data: dia(t.date)!, descricao: t.description || t.descriptionRaw || '',
      valor: t.type === 'DEBIT' ? -Math.abs(t.amount) : Math.abs(t.amount),
      status: t.status || null, cat_pluggy: t.category || null,
      contraparte: t.merchant?.businessName || t.merchant?.name || outro?.name || null,
      parcela: cc.totalInstallments > 1 ? `${cc.installmentNumber}/${cc.totalInstallments}` : null,
      atualizado_em: agora,
    };
  };
  const novos = txs.filter(t => !existentes.has(t.id)).map(t => { const b = base(t); return { ...b, ...classificar(b, regras) }; });
  const velhos = txs.filter(t => existentes.has(t.id)).map(base);
  for (const lote of [novos, velhos]) {
    for (let i = 0; i < lote.length; i += 500) {
      const { error } = await sb.from('fin_tx').upsert(lote.slice(i, i + 500), { onConflict: 'id' });
      if (error) throw new Error(error.message);
    }
  }
  // Pendentes do período que a Pluggy não devolve mais
  const { data: pend } = await sb.from('fin_tx').select('id').eq('conta_id', conta.id).eq('status', 'PENDING').gte('data', desde);
  const sumiram = (pend || []).map((p: any) => p.id).filter((id: string) => !ids.includes(id));
  if (sumiram.length) await sb.from('fin_tx').delete().in('id', sumiram);
  return { novos: novos.length, atualizados: velhos.length, apagados: sumiram.length };
}

// Regras do usuário primeiro (a mais longa ganha); depois o padrão do Airbnb
function classificar(t: any, regras: any[]) {
  const txt = `${t.descricao} ${t.contraparte || ''}`.toLowerCase();
  const r = regras.filter(r => r.contem && txt.includes(r.contem.toLowerCase())).sort((a, b) => b.contem.length - a.contem.length)[0];
  if (r) return { categoria: r.categoria || null, negocio: r.negocio || null, casa: r.casa || null };
  if (/airbnb/.test(txt) && t.valor > 0) return { categoria: 'Airbnb', negocio: 'alugueis', casa: null };
  return {};
}

// /v2/transactions: filtro dateFrom e cursor "after" tirado do link `next`; se a v2 recusar, usa /transactions (páginas)
async function transacoes(key: string, conta: string, desde: string) {
  const out: any[] = [];
  try {
    let after = '';
    for (let n = 0; n < 200; n++) {
      const r = await pg(key, `/v2/transactions?accountId=${conta}&dateFrom=${desde}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      out.push(...(r.results || []));
      after = r.next ? new URL(r.next, API).searchParams.get('after') || '' : '';
      if (!after) return out;
    }
    return out;
  } catch (e) {
    if (!/Pluggy (400|404|405) /.test((e as Error).message)) throw e;
    out.length = 0;
  }
  for (let page = 1; ; page++) {
    const r = await pg(key, `/transactions?accountId=${conta}&from=${desde}&pageSize=500&page=${page}`);
    out.push(...(r.results || []));
    if (page >= (r.totalPages || 1)) return out;
  }
}

async function apiKey() {
  const clientId = Deno.env.get('PLUGGY_CLIENT_ID'), clientSecret = Deno.env.get('PLUGGY_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Faltam os segredos PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no Supabase.');
  const r = await fetch(`${API}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.apiKey) throw new Error(`Pluggy recusou o login (${r.status}): ${j.message || 'confira Client ID e Secret'}`);
  return j.apiKey as string;
}

async function pg(key: string, path: string) {
  const r = await fetch(API + path, { headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Pluggy ${r.status} em ${path.split('?')[0]}: ${j.message || r.statusText}`);
  return j;
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

function nomeBanco(accs: any[]) {
  const txt = accs.map(a => `${a.name} ${a.marketingName || ''}`).join(' ');
  if (/nu ?pagamentos|nubank/i.test(txt)) return 'Nubank';
  if (/mercado ?pago/i.test(txt)) return 'Mercado Pago';
  return accs[0]?.marketingName || accs[0]?.name || '';
}
const dia = (s?: string | null) => s ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(s)) : null;
const hojeSp = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
