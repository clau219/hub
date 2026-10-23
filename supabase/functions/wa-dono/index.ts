// Resumo do dia no WhatsApp do dono (wa_settings.dono_wa), mandado pelo número das casas (Z-API).
// Cron 'dono-resumo-manha' (7h30) e 'dono-resumo-noite' (18h): POST x-hub-cron { "resumo": "manha" | "noite" }.
// Botão "Mandar resumo agora" em Ajustes: mesmo corpo com o JWT do usuário. { "previa": true } só devolve o texto.
// As mensagens do dono para o número das casas são tratadas no wa-webhook (_shared/dono.ts).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { enviarZapi } from '../_shared/wa.ts';
import { donoWa, resumoDoDia } from '../_shared/dono.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hub-cron' };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'método não suportado' }, 405);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const cron = !!req.headers.get('x-hub-cron');
  if (!(await autorizado(req, sb))) return json({ error: 'não autorizado' }, 401);
  const b = await req.json().catch(() => ({}));
  const quando = b.resumo === 'noite' ? 'noite' : 'manha';

  const { data: cfg } = await sb.from('wa_settings').select('dono_wa,dono_resumo').eq('id', 1).maybeSingle();
  const para = await donoWa(sb);
  if (!para) return json({ enviado: false, motivo: 'número do dono não cadastrado em Ajustes' });
  // O agendador respeita o liga/desliga; o botão manda mesmo com o resumo automático desligado
  if (cron && cfg?.dono_resumo === false) return json({ enviado: false, motivo: 'resumo automático desligado em Ajustes' });
  const texto = await resumoDoDia(sb, quando);
  if (b.previa) return json({ enviado: false, texto });
  if (!Deno.env.get('ZAPI_INSTANCE')) return json({ enviado: false, motivo: 'Z-API não configurada', texto });
  const r = await enviarZapi(para, texto, { digitando: 0 });
  if (r) await sb.from('dono_msgs').insert({ wamid: r.wamid, direcao: 'out', texto });
  return json({ enviado: !!r, texto, ...(r ? {} : { motivo: 'falha no envio pela Z-API' }) });
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

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
