// WhatsApp das casas → Hub. Recebe o webhook da WhatsApp Cloud API (número em coexistência com o app Business):
// - cada mensagem recebida vira/atualiza uma oportunidade de Aluguéis no Pipeline ("Responder WhatsApp");
// - a IA (Claude Haiku) lê a conversa e extrai casa, datas e hóspedes;
// - se for pergunta de disponibilidade/valor, consulta a airbnb-quote e responde sozinho;
// - mensagens que você manda pelo app (ecos) ficam registradas e silenciam o robô naquela conversa.
// O robô só informa disponibilidade e valor: nunca confirma reserva, não negocia e não responde o que não entendeu.
//
// Segredos (supabase secrets set): WA_VERIFY_TOKEN, WA_APP_SECRET, WA_TOKEN, ANTHROPIC_API_KEY
// Opcionais: WA_PHONE_ID (senão usa o do webhook), WA_GRAPH_VERSION (padrão v25.0)
// Teste sem a Meta: POST com cabeçalho x-hub-cron e corpo { "teste": { "wa_id": "5584...", "nome": "Ana", "texto": "..." } }
//   (acrescente "eco": true para simular uma mensagem sua). Nada é enviado ao WhatsApp no teste.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import Anthropic from 'npm:@anthropic-ai/sdk@0.134.0';
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@0.134.0/helpers/zod';
import { z } from 'npm:zod@4.6.7';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GRAPH = `https://graph.facebook.com/${Deno.env.get('WA_GRAPH_VERSION') || 'v25.0'}`;
const ABERTAS = ['lead', 'orcamento', 'negociacao', 'fechado', 'realizado'];
const ACAO_RESPONDER = 'Responder WhatsApp';

type SB = ReturnType<typeof createClient>;
type Entrada = { wa_id: string; nome?: string | null; wamid: string; tipo: string; texto: string | null; ts: Date; phoneId?: string };

Deno.serve(async req => {
  const url = new URL(req.url);
  // Verificação do webhook (Meta chama com GET ao cadastrar a URL)
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === Deno.env.get('WA_VERIFY_TOKEN');
    return ok ? new Response(url.searchParams.get('hub.challenge') || '') : new Response('proibido', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('método não suportado', { status: 405 });

  const raw = await req.text();
  const sb = createClient(SB_URL, SB_KEY);

  // Modo de teste (agendador/Claudio): roda tudo e devolve o resultado, sem enviar ao WhatsApp
  const cron = req.headers.get('x-hub-cron');
  if (cron) {
    const { data } = await sb.from('app_secrets').select('value').eq('key', 'cron_token').single();
    if (!data || data.value !== cron) return json({ error: 'não autorizado' }, 401);
    const t = JSON.parse(raw).teste;
    if (!t?.wa_id || !t?.texto) return json({ error: 'informe teste.wa_id e teste.texto' }, 400);
    const e: Entrada = { wa_id: String(t.wa_id).replace(/\D/g, ''), nome: t.nome, wamid: `teste-${crypto.randomUUID()}`, tipo: 'text', texto: t.texto, ts: new Date() };
    return json(t.eco ? await processarEco(sb, e) : await processarEntrada(sb, e, { teste: true }));
  }

  if (!(await assinaturaOk(req, raw))) return new Response('assinatura inválida', { status: 401 });
  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response('ok'); }

  // Responde 200 na hora (a Meta reenvia se demorar) e processa em segundo plano
  const tarefa = processarWebhook(sb, body).catch(e => console.error('wa-webhook', e));
  // @ts-ignore EdgeRuntime existe no Supabase
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(tarefa); else await tarefa;
  return new Response('ok');
});

async function processarWebhook(sb: SB, body: any) {
  for (const entry of body.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    const phoneId = v.metadata?.phone_number_id;
    if (ch.field === 'messages') {
      const nomes = Object.fromEntries((v.contacts || []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        await processarEntrada(sb, { wa_id: m.from, nome: nomes[m.from], wamid: m.id, tipo: m.type, texto: textoDe(m), ts: new Date(+m.timestamp * 1000), phoneId }, {});
      }
    } else if (ch.field === 'smb_message_echoes') {
      // Mensagens que você enviou pelo app WhatsApp Business (coexistência)
      for (const m of v.message_echoes || []) {
        await processarEco(sb, { wa_id: m.to, wamid: m.id, tipo: m.type, texto: textoDe(m), ts: new Date(+m.timestamp * 1000) });
      }
    }
  }
}

// ---------- mensagem do cliente ----------
async function processarEntrada(sb: SB, e: Entrada, { teste = false }) {
  const { data: dup } = await sb.from('wa_messages').select('id').eq('wamid', e.wamid).maybeSingle();
  if (dup) return { ignorado: 'mensagem repetida' };

  const conversa = await garantirConversa(sb, e.wa_id, e.nome);
  const deal_id = conversa.deal_id;
  await sb.from('wa_contacts').update({ ultima_entrada: e.ts.toISOString(), ...(e.nome ? { nome: e.nome } : {}) }).eq('wa_id', e.wa_id);
  const { data: msg } = await sb.from('wa_messages').insert({
    wamid: e.wamid, wa_id: e.wa_id, deal_id, direcao: 'in', autor: 'cliente', tipo: e.tipo, texto: e.texto, enviado_em: e.ts.toISOString(),
  }).select('id').single();
  await sb.from('deals').update({ proxima_acao: ACAO_RESPONDER, data_proxima_acao: hoje(), updated_at: new Date().toISOString() }).eq('id', deal_id);

  // ---------- o robô deve responder? ----------
  const motivo = await motivoSilencio(sb, conversa, e);
  if (motivo) return { deal_id, respondeu: false, motivo };

  const historico = await historicoConversa(sb, e.wa_id);
  const { data: casas } = await sb.from('properties').select('id,nome').order('nome');
  let x: Extracao;
  try { x = await extrair(historico, casas || []); }
  catch (err) { console.error('IA', err); return { deal_id, respondeu: false, motivo: 'IA indisponível: ' + (err as Error).message }; }
  await sb.from('wa_messages').update({ extracao: x }).eq('id', msg!.id);
  if (x.resumo) await sb.from('deals').update({ proxima_acao: `${ACAO_RESPONDER}: ${x.resumo}`.slice(0, 140) }).eq('id', deal_id);

  if (x.assunto !== 'disponibilidade_preco') return { deal_id, respondeu: false, motivo: `assunto "${x.assunto}": fica para você`, extracao: x };

  const datas = normalizarDatas(x);
  let texto: string, cot: any = null;
  if (!datas) {
    // Falta a data: pede só o que falta (não chuta)
    texto = 'Olá! Para eu verificar a disponibilidade e os valores, me diga a data de entrada, a data de saída e quantas pessoas vão se hospedar.';
  } else {
    cot = await cotar(datas.checkin, datas.checkout, x.hospedes || 2);
    const casasOk = (cot?.casas || []).filter((c: any) => c.status !== 'erro');
    if (!cot?.mensagem || !casasOk.length) return { deal_id, respondeu: false, motivo: 'consulta ao Airbnb falhou: fica para você', extracao: x, cotacao: cot };
    texto = cot.mensagem;
  }

  const enviado = teste ? { wamid: `teste-out-${crypto.randomUUID()}` } : await enviar(e.wa_id, texto, e.phoneId);
  if (!enviado) return { deal_id, respondeu: false, motivo: 'falha ao enviar pelo WhatsApp', extracao: x };
  await sb.from('wa_messages').insert({ wamid: enviado.wamid, wa_id: e.wa_id, deal_id, direcao: 'out', autor: 'robo', texto, cotacao: cot });

  // Card: orçamento enviado, com data e valor quando a casa pedida está livre
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (datas) {
    patch.proxima_acao = 'Acompanhar: o robô enviou disponibilidade e valores';
    patch.data_proxima_acao = addDays(hoje(), 1);
    patch.data_evento = datas.checkin;
    const pedida = cot.casas.find((c: any) => c.id === x.casa && c.status === 'livre');
    if (pedida) { patch.valor = pedida.total; patch.local = pedida.nome; }
    const { data: d } = await sb.from('deals').select('etapa').eq('id', deal_id).single();
    if (d?.etapa === 'lead') patch.etapa = 'orcamento';
  } else {
    patch.proxima_acao = 'Acompanhar: o robô pediu as datas';
    patch.data_proxima_acao = addDays(hoje(), 1);
  }
  await sb.from('deals').update(patch).eq('id', deal_id);
  return { deal_id, respondeu: true, texto, extracao: x, teste };
}

// ---------- mensagem sua, enviada pelo app Business ----------
async function processarEco(sb: SB, e: Entrada) {
  const { data: dup } = await sb.from('wa_messages').select('id').eq('wamid', e.wamid).maybeSingle();
  if (dup) return { ignorado: 'eco de mensagem já registrada (ex.: enviada pelo robô)' };
  const conversa = await garantirConversa(sb, e.wa_id, null);
  await sb.from('wa_messages').insert({ wamid: e.wamid, wa_id: e.wa_id, deal_id: conversa.deal_id, direcao: 'out', autor: 'claudio', tipo: e.tipo, texto: e.texto, enviado_em: e.ts.toISOString() });
  await sb.from('wa_contacts').update({ ultima_manual: e.ts.toISOString() }).eq('wa_id', e.wa_id);
  await sb.from('deals').update({ proxima_acao: 'Aguardar resposta do cliente', data_proxima_acao: addDays(hoje(), 2), updated_at: new Date().toISOString() }).eq('id', conversa.deal_id);
  return { deal_id: conversa.deal_id, registrado: 'mensagem sua; robô em silêncio nesta conversa' };
}

// Conversa → contato → oportunidade aberta (cria o que faltar)
async function garantirConversa(sb: SB, wa_id: string, nome?: string | null) {
  let { data: c } = await sb.from('wa_contacts').select('*').eq('wa_id', wa_id).maybeSingle();
  if (!c) {
    const { data } = await sb.from('wa_contacts').upsert({ wa_id, nome: nome || null }, { onConflict: 'wa_id' }).select('*').single();
    c = data;
  }
  let contato_id = c.contato_id;
  if (!contato_id) {
    // Mesmo telefone já cadastrado no Hub? Compara os 8 últimos dígitos (o WhatsApp às vezes omite o 9)
    const fim = wa_id.slice(-8);
    const { data: cs } = await sb.from('contacts').select('id,telefone');
    contato_id = (cs || []).find((x: any) => String(x.telefone || '').replace(/\D/g, '').endsWith(fim))?.id;
    if (!contato_id) {
      const { data } = await sb.from('contacts').insert({ nome: nome || telefoneBonito(wa_id), tipo: 'cliente', telefone: telefoneBonito(wa_id) }).select('id').single();
      contato_id = data!.id;
    }
  }
  let deal_id = c.deal_id;
  if (deal_id) {
    const { data: d } = await sb.from('deals').select('etapa').eq('id', deal_id).maybeSingle();
    if (!d || !ABERTAS.includes(d.etapa)) deal_id = null;
  }
  if (!deal_id) {
    const { data: ct } = await sb.from('contacts').select('nome').eq('id', contato_id).single();
    const { data } = await sb.from('deals').insert({
      titulo: `Aluguéis — ${ct?.nome || nome || telefoneBonito(wa_id)}`, negocio: 'aluguel', etapa: 'lead', contato_id,
      proxima_acao: ACAO_RESPONDER, data_proxima_acao: hoje(), notas: 'Chegou pelo WhatsApp das casas.',
    }).select('id').single();
    deal_id = data!.id;
  }
  if (deal_id !== c.deal_id || contato_id !== c.contato_id) await sb.from('wa_contacts').update({ deal_id, contato_id }).eq('wa_id', wa_id);
  return { ...c, deal_id, contato_id };
}

async function motivoSilencio(sb: SB, c: any, e: Entrada) {
  const { data: cfg } = await sb.from('wa_settings').select('*').eq('id', 1).single();
  if (!cfg?.bot_ativo) return 'robô desligado em Ajustes';
  if (c.bot_pausado) return 'robô pausado para esta pessoa';
  if (e.tipo !== 'text' || !e.texto?.trim()) return `mensagem do tipo ${e.tipo}: fica para você`;
  if (c.ultima_manual && Date.now() - Date.parse(c.ultima_manual) < cfg.horas_silencio * 3600e3) return `você respondeu à mão nas últimas ${cfg.horas_silencio} h`;
  const { count } = await sb.from('wa_messages').select('id', { count: 'exact', head: true })
    .eq('wa_id', c.wa_id).eq('autor', 'robo').gte('enviado_em', new Date(Date.now() - 864e5).toISOString());
  if ((count || 0) >= cfg.max_respostas_dia) return `limite de ${cfg.max_respostas_dia} respostas automáticas em 24 h`;
  return null;
}

async function historicoConversa(sb: SB, wa_id: string) {
  const { data } = await sb.from('wa_messages').select('autor,texto,enviado_em').eq('wa_id', wa_id).order('enviado_em', { ascending: false }).limit(12);
  return (data || []).reverse().filter((m: any) => m.texto);
}

// ---------- IA: o que o cliente quer ----------
const ExtracaoSchema = z.object({
  assunto: z.enum(['disponibilidade_preco', 'confirmar_reserva', 'outro']),
  casa: z.enum(['QS39', 'QS40', 'QS50', 'qualquer']),
  checkin: z.string().nullable(),
  checkout: z.string().nullable(),
  noites: z.number().int().nullable(),
  hospedes: z.number().int().nullable(),
  resumo: z.string(),
});
type Extracao = z.infer<typeof ExtracaoSchema>;

async function extrair(historico: any[], casas: { id: string; nome: string }[]): Promise<Extracao> {
  const d = hoje();
  const dia = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date());
  const system = `Você lê conversas do WhatsApp de atendimento de 3 casas de temporada no Condomínio Pipa Natureza (Pipa/RN) e extrai dados para um sistema. Hoje é ${dia}, ${d}.
Casas: ${casas.map(c => `${c.id} = ${c.nome}`).join('; ')}.

Classifique a ÚLTIMA mensagem do cliente, usando as anteriores como contexto:
- "disponibilidade_preco": pergunta se há vaga, quanto custa, valores ou diária para um período (mesmo que ainda sem datas).
- "confirmar_reserva": quer fechar, reservar, pagar, mandar comprovante ou negociar desconto.
- "outro": qualquer outra coisa (dúvidas sobre a casa, regras, check-in, reclamação, conversa).

Datas: converta para AAAA-MM-DD. Datas sem ano são a próxima ocorrência a partir de hoje. "Fim de semana" = sexta a domingo (saída no domingo). Feriados citados pelo nome (Réveillon, Carnaval etc.): use as datas do próximo feriado. Se o cliente der só a entrada e o número de noites, preencha noites e deixe checkout nulo. Se não houver data clara, deixe nulo: nunca invente.
casa: a casa citada pelo nome, ou "qualquer". hospedes: total de pessoas (adultos + crianças), nulo se não disser.
resumo: até 8 palavras para o card, ex.: "Vaga 20-23/11, 6 pessoas, Casa Azul".`;
  const conversa = historico.map(m => `${m.autor === 'cliente' ? 'Cliente' : m.autor === 'robo' ? 'Robô' : 'Claudio'}: ${m.texto}`).join('\n');
  const client = new Anthropic();
  const r = await client.messages.parse({
    model: 'claude-haiku-5-5',
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(ExtracaoSchema) },
    system,
    messages: [{ role: 'user', content: `<conversa>\n${conversa}\n</conversa>` }],
  });
  if (r.stop_reason === 'refusal' || !r.parsed_output) throw new Error(`sem extração (${r.stop_reason})`);
  return r.parsed_output;
}

function normalizarDatas(x: Extracao) {
  const ok = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
  if (!ok(x.checkin)) return null;
  let checkout = ok(x.checkout) ? x.checkout! : x.noites && x.noites > 0 ? addDays(x.checkin!, x.noites) : null;
  if (!checkout || checkout <= x.checkin! || x.checkin! < hoje()) return null;
  if (dias(x.checkin!, checkout) > 60) return null;
  return { checkin: x.checkin!, checkout };
}

async function cotar(checkin: string, checkout: string, adultos: number) {
  try {
    const r = await fetch(`${SB_URL}/functions/v1/airbnb-quote`, {
      method: 'POST', headers: { Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkin, checkout, adultos }), signal: AbortSignal.timeout(40000),
    });
    return await r.json();
  } catch (e) { console.error('airbnb-quote', e); return null; }
}

// ---------- WhatsApp Cloud API ----------
async function enviar(to: string, body: string, phoneIdWebhook?: string) {
  const phoneId = Deno.env.get('WA_PHONE_ID') || phoneIdWebhook;
  const token = Deno.env.get('WA_TOKEN');
  if (!phoneId || !token) { console.error('WA_TOKEN/WA_PHONE_ID ausentes'); return null; }
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('envio WhatsApp', r.status, JSON.stringify(j)); return null; }
  return { wamid: j.messages?.[0]?.id as string };
}

async function assinaturaOk(req: Request, raw: string) {
  const segredo = Deno.env.get('WA_APP_SECRET');
  const sig = req.headers.get('x-hub-signature-256') || '';
  if (!segredo || !sig.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const hex = Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
  const recebido = sig.slice(7);
  if (recebido.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ recebido.charCodeAt(i);
  return diff === 0;
}

function textoDe(m: any): string | null {
  if (m.type === 'text') return m.text?.body ?? null;
  if (m.type === 'button') return m.button?.text ?? null;
  if (m.type === 'interactive') return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || null;
  const leg = m[m.type]?.caption;
  return `[${m.type}]${leg ? ' ' + leg : ''}`;
}

const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
function telefoneBonito(wa: string) {
  const m = wa.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : '+' + wa;
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
