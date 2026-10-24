// Classifica os lançamentos de Finanças que ainda não têm categoria do Hub (regras, memória, cruzamento com
// reservas/gigs e IA; ver _shared/fin-classificar.ts). Cada chamada faz até `limite` lançamentos (padrão 300,
// mais novos primeiro) e devolve quantos faltam: a tela chama de novo até zerar, mostrando o progresso.
// Corpo: {} pendentes · {limite: N} · {refazer: true} volta todos os não manuais para pendente antes (reclassifica tudo).
// Chamada pela tela Finanças (usuário logado) e pelo cron (x-hub-cron). Segredo: ANTHROPIC_API_KEY.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { classificarPendentes } from '../_shared/fin-classificar.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hub-cron' };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if (!(await autorizado(req, sb))) return json({ error: 'não autorizado' }, 401);
  const body = await req.json().catch(() => ({}));
  try {
    if (body.refazer) {
      const { error } = await sb.from('fin_tx').update({ origem_cat: null, revisar: false, sugestoes: null, ia_motivo: null }).eq('manual', false);
      if (error) throw new Error(error.message);
    }
    const limite = Math.min(Math.max(+body.limite || 300, 1), 600);
    return json(await classificarPendentes(sb, { limite }));
  } catch (e) {
    return json({ erro: (e as Error).message }); // erro no corpo: com 500 a tela não lê a mensagem
  }
});

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
