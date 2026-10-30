// Envia o e-mail da portaria pelo Gmail do Claudio, só com o login dele.
//   POST {para, assunto, corpo} → {ok, messageId}
// O Gmail guarda a cópia em "Enviados". Segredos: GMAIL_USER (endereço) e GMAIL_APP_PASSWORD (senha de app do Google,
// com ou sem espaços). Porta 465 (SSL): o Supabase bloqueia a 587. Quem marca a etapa e grava a lista é o Hub.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import nodemailer from 'npm:nodemailer@6.9.16';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'método não suportado' }, 405);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt.startsWith('sb_') || !(await sb.auth.getUser(jwt)).data?.user) return json({ error: 'não autorizado' }, 401);

  const user = Deno.env.get('GMAIL_USER'), senha = (Deno.env.get('GMAIL_APP_PASSWORD') || '').replace(/\s+/g, '');
  if (!user || !senha) return json({ error: 'Gmail não configurado: cadastre GMAIL_USER e GMAIL_APP_PASSWORD nos segredos do Supabase' }, 500);

  const b = await req.json().catch(() => ({}));
  const para = String(b.para || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const assunto = String(b.assunto || '').trim(), corpo = String(b.corpo || '').trim();
  if (!para.length || para.length > 3 || !para.every(e => EMAIL.test(e))) return json({ error: 'destinatário inválido' }, 400);
  if (!assunto || assunto.length > 300 || /[\r\n]/.test(assunto)) return json({ error: 'assunto inválido' }, 400);
  if (!corpo || corpo.length > 20000) return json({ error: 'e-mail vazio ou longo demais' }, 400);

  try {
    const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass: senha } });
    const r = await t.sendMail({ from: `"Claudio Braga" <${user}>`, to: para.join(', '), subject: assunto, text: corpo });
    return json({ ok: true, messageId: r.messageId, para });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error('portaria-enviar', msg);
    // 535 = usuário/senha recusados: quase sempre a senha de app errada ou revogada
    return json({ error: /535|Invalid login|Username and Password not accepted/i.test(msg) ? 'o Gmail recusou o login (confira a senha de app)' : `o Gmail não aceitou o envio: ${msg}` }, 502);
  }
});

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
