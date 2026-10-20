// Roda uma Edge Function do Supabase (supabase/functions/<nome>/index.ts) dentro do Node:
// o objeto Deno é simulado (env + serve), o supabase-js é o banco falso e a rede é a simulada em rede.js.
// Cada arquivo de teste carrega uma função só (o import roda Deno.serve uma vez por processo).
export const ENV_PADRAO = { SUPABASE_URL: 'https://projeto.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-teste' };
export const CRON = 'cron-teste';

export async function carregarFuncao(nome, env = {}) {
  const ambiente = (globalThis.__envFuncao = { ...ENV_PADRAO, ...env });
  globalThis.Deno = {
    env: { get: k => ambiente[k] },
    serve: h => { globalThis.__handler = typeof h === 'function' ? h : h.handler; },
  };
  await import(new URL(`../../supabase/functions/${nome}/index.ts`, import.meta.url).href);
  const handler = globalThis.__handler;
  if (!handler) throw new Error(`${nome}: Deno.serve não foi chamado`);
  return req => handler(req);
}
// Muda um segredo (Deno.env) no meio dos testes
export const definirEnv = (k, v) => { if (v === undefined) delete globalThis.__envFuncao[k]; else globalThis.__envFuncao[k] = v; };

// Monta o Request. auth: 'usuario' (JWT válido do banco falso), 'cron' (x-hub-cron), 'service' (chave service role),
// 'anon' (chave pública sb_...), 'invalido' (JWT recusado) ou null (sem nada).
export function pedido(caminho = '/', { metodo = 'POST', corpo, headers = {}, auth = 'usuario' } = {}) {
  const h = { ...headers };
  if (auth === 'usuario') h.Authorization = 'Bearer token-teste';
  else if (auth === 'cron') h['x-hub-cron'] = CRON;
  else if (auth === 'service') h.Authorization = 'Bearer ' + ENV_PADRAO.SUPABASE_SERVICE_ROLE_KEY;
  else if (auth === 'anon') h.Authorization = 'Bearer sb_publishable_xyz';
  else if (auth === 'invalido') h.Authorization = 'Bearer jwt-vencido';
  const tem = corpo !== undefined && metodo !== 'GET';
  if (tem && typeof corpo !== 'string') h['Content-Type'] = 'application/json';
  return new Request('https://projeto.supabase.co/functions/v1' + caminho, { method: metodo, headers: h, body: tem ? (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) : undefined });
}
export const lerJson = async r => ({ status: r.status, corpo: await r.json() });
// Segredo do agendador (tabela app_secrets)
export const comCron = tabelas => ({ app_secrets: [{ key: 'cron_token', value: CRON }], ...tabelas });
