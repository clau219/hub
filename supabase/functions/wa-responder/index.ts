// Responder pelo Hub (aba WhatsApp), só com o login do Claudio:
//   POST {acao: "enviar", wa_id, texto}  → manda pela Z-API e grava como mensagem sua (silencia o robô, como
//                                           responder pelo celular) e a oportunidade passa a "Aguardar resposta".
//   POST {acao: "rascunho", wa_id}        → a IA escreve a resposta para a última mensagem do cliente, com a conversa,
//                                           a base das casas (app_config 'wa_base') e o valor/pagamentos da oportunidade.
//                                           Devolve {texto, faltou: [...]} — o que faltou na base para responder.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import Anthropic from 'npm:@anthropic-ai/sdk@0.134.0';
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@0.134.0/helpers/zod';
import { z } from 'npm:zod@4.6.7';
import { enviarZapi, lerBase, baseTexto } from '../_shared/wa.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
type SB = ReturnType<typeof createClient>;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'método não suportado' }, 405);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt.startsWith('sb_') || !(await sb.auth.getUser(jwt)).data?.user) return json({ error: 'não autorizado' }, 401);

  const b = await req.json().catch(() => ({}));
  const { data: contato } = await sb.from('wa_contacts').select('*').eq('wa_id', String(b.wa_id || '')).maybeSingle();
  if (!contato) return json({ error: 'conversa não encontrada' }, 404);
  try {
    if (b.acao === 'enviar') return await enviar(sb, contato, String(b.texto || ''));
    if (b.acao === 'rascunho') return await rascunho(sb, contato);
    return json({ error: 'ação desconhecida' }, 400);
  } catch (e) {
    console.error('wa-responder', e);
    return json({ error: (e as Error).message }, 500);
  }
});

async function enviar(sb: SB, c: any, texto: string) {
  texto = texto.trim();
  if (!texto) return json({ error: 'mensagem vazia' }, 400);
  if (texto.length > 4000) return json({ error: 'mensagem longa demais (máx. 4000 caracteres)' }, 400);
  if (!Deno.env.get('ZAPI_INSTANCE')) return json({ error: 'Z-API não configurada' }, 500);
  const r = await enviarZapi(c.wa_id, texto, { digitando: 0 });
  if (!r) return json({ error: 'a Z-API não aceitou o envio (o WhatsApp das casas está conectado?)' }, 502);
  const agora = new Date().toISOString();
  await sb.from('wa_messages').insert({ wamid: r.wamid, wa_id: c.wa_id, deal_id: c.deal_id, direcao: 'out', autor: 'claudio', tipo: 'text', texto, enviado_em: agora });
  await sb.from('wa_contacts').update({ ultima_manual: agora }).eq('wa_id', c.wa_id);
  if (c.deal_id) await sb.from('deals').update({ proxima_acao: 'Aguardar resposta do cliente', data_proxima_acao: addDays(hoje(), 2), updated_at: agora }).eq('id', c.deal_id);
  return json({ ok: true, wamid: r.wamid });
}

const RascunhoSchema = z.object({ texto: z.string(), faltou: z.array(z.string()) });

async function rascunho(sb: SB, c: any) {
  const [{ data: hist }, { data: casas }, base, { data: deal }] = await Promise.all([
    sb.from('wa_messages').select('autor,texto,enviado_em').eq('wa_id', c.wa_id).order('enviado_em', { ascending: false }).limit(20),
    sb.from('properties').select('id,nome').order('nome'),
    lerBase(sb),
    c.deal_id ? sb.from('deals').select('titulo,etapa,valor,local,data_evento,pagamentos').eq('id', c.deal_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const msgs = (hist || []).reverse().filter((m: any) => m.texto);
  if (!msgs.length) return json({ error: 'conversa sem mensagens' }, 400);
  const conversando = msgs.some((m: any) => m.autor !== 'cliente' && Date.now() - Date.parse(m.enviado_em) < 864e5);
  const pct = +(base.geral?.sinal_pct || 0);
  const recebido = ((deal?.pagamentos as any[]) || []).reduce((s, p) => s + (+p.valor || 0), 0);
  const negocio = deal ? [
    `Oportunidade: ${deal.titulo} (etapa ${deal.etapa})`,
    deal.local ? `Casa: ${deal.local}` : '', deal.data_evento ? `Entrada: ${deal.data_evento}` : '',
    deal.valor ? `Valor total combinado: R$ ${brl(deal.valor)}` : 'Valor total: ainda não definido',
    deal.valor && pct ? `Sinal (${pct}%): R$ ${brl(deal.valor * pct / 100)}` : '',
    recebido ? `Já recebido: R$ ${brl(recebido)}; falta R$ ${brl(Math.max(0, (deal.valor || 0) - recebido))}` : 'Nada recebido ainda',
  ].filter(Boolean).join('\n') : 'Sem oportunidade ligada a esta conversa.';

  const system = `Você escreve rascunhos de resposta de WhatsApp para o Claudio, que aluga 3 casas de temporada no Condomínio Pipa Natureza (Pipa/RN). Ele revisa antes de enviar.
Escreva em português do Brasil, como o Claudio escreveria: cordial, direto, frases curtas, no máximo 1 emoji. ${conversando ? 'A conversa já está em andamento: NÃO comece com "Olá" nem cumprimente de novo.' : 'É o começo da conversa: pode cumprimentar brevemente.'}
Responda à última mensagem do cliente usando SOMENTE fatos das informações das casas e da oportunidade abaixo. Nunca invente preço, disponibilidade, regra ou desconto. Se faltar uma informação para responder, deixe um marcador entre colchetes no texto, ex.: [confirmar horário de check-in], e liste em "faltou" o que faltou (ex.: "horário de check-in"). Disponibilidade e preço de datas novas: diga que vai verificar (o Claudio usa o botão Cotar datas).
Se o cliente quer pagar/reservar e houver chave Pix e valor de sinal, informe o valor do sinal e a chave Pix e peça o comprovante.

<informacoes_das_casas>
${baseTexto(base, casas || []) || '(nada cadastrado)'}
</informacoes_das_casas>
<oportunidade>
${negocio}
</oportunidade>`;
  const conversa = msgs.map((m: any) => `${m.autor === 'cliente' ? 'Cliente' : m.autor === 'robo' ? 'Robô' : 'Claudio'}: ${m.texto}`).join('\n');
  const r = await new Anthropic().messages.parse({
    model: 'claude-haiku-5-5',
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(RascunhoSchema) },
    system,
    messages: [{ role: 'user', content: `<conversa>\n${conversa}\n</conversa>` }],
  });
  if (r.stop_reason === 'refusal' || !r.parsed_output) throw new Error(`a IA não escreveu o rascunho (${r.stop_reason})`);
  return json(r.parsed_output);
}

const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
const brl = (v: number) => (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
