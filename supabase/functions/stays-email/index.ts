// Entrada dos avisos de reserva da Stays por e-mail. Um Apps Script no Gmail (claudiorsbraga@gmail.com, que a Stays
// avisa em Configurações › E-mails › Reserva) manda para cá cada e-mail novo de noreply@stays.net; aqui ele vira
// uma linha em stays_emails e completa a reserva do Hub (valor, nome, contato, hóspedes, canal; cancelamento).
// Auth: header x-stays-token = app_secrets 'stays_email_token' (só o script tem), ou x-hub-cron.
// Corpo: {mensagens: [{id, assunto, corpo, data}]} — ou {} só para reaplicar o que está pendente.
// Resposta: {ok, guardados, ignorados, aplicados, ids: [ids aceitos]} — o script marca como lidos só os aceitos.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { guardarEmailStays, aplicarEmailsStays } from '../_shared/stays-email.ts';

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const tok = req.headers.get('x-stays-token'), cron = req.headers.get('x-hub-cron');
  if (!tok && !cron) return json({ error: 'não autorizado' }, 401);
  const { data: seg } = await sb.from('app_secrets').select('key,value').in('key', ['stays_email_token', 'cron_token']);
  const s = Object.fromEntries((seg || []).map((r: any) => [r.key, r.value]));
  if (!((tok && s.stays_email_token && tok === s.stays_email_token) || (cron && s.cron_token && cron === s.cron_token))) return json({ error: 'não autorizado' }, 401);

  const corpo = await req.json().catch(() => ({}));
  const msgs = Array.isArray(corpo?.mensagens) ? corpo.mensagens.slice(0, 50) : [];
  const { data: props } = await sb.from('properties').select('id,nome');
  let guardados = 0, ignorados = 0;
  const ids: string[] = [], erros: string[] = [];
  for (const m of msgs) {
    try {
      const r = await guardarEmailStays(sb, { id: m.id, assunto: String(m.assunto || ''), corpo: String(m.corpo || ''), data: m.data }, props || []);
      if (r === 'guardado') guardados++; else ignorados++;
      if (m.id) ids.push(String(m.id));
    } catch (e) { erros.push(`${m.id}: ${(e as Error).message}`); }
  }
  const aplicados = await aplicarEmailsStays(sb);
  await sb.from('app_config').upsert({ key: 'stays_email_status', value: JSON.stringify({ em: new Date().toISOString(), guardados, ignorados, aplicados, erros }) }, { onConflict: 'key' });
  return json({ ok: !erros.length, guardados, ignorados, aplicados, ids, erros });
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
}
