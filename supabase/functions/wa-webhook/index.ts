// WhatsApp das casas → Hub. Recebe o webhook da Z-API (aparelho conectado por QR code) ou da WhatsApp Cloud API
// (número em coexistência com o app Business):
// - cada mensagem recebida vira/atualiza uma oportunidade de Aluguéis no Pipeline ("Responder WhatsApp");
// - a IA (Claude Haiku) lê a conversa e extrai casa, datas e hóspedes;
// - se for pergunta de disponibilidade/valor, junta o que o cliente já disse (wa_contacts.pedido), pergunta só o que
//   falta (datas, confirmação de data vaga, saída, nº de pessoas) e, com tudo certo, consulta a airbnb-quote e responde;
// - nenhum texto com campo a preencher ([nome], {data}, XX...) é enviado: fica para você;
// - pergunta que só o Claudio responde (desconto, pet, festa, check-in antecipado, pagamento fora do Airbnb, reserva,
//   informação que a base não tem): o robô diz "vou confirmar isso e já te retorno", o card fica pendente com a
//   pergunta em destaque e vai um push;
// - "quero reservar" com casa, datas e pessoas: consulta o Airbnb de novo e manda o total, o sinal e o Pix;
//   comprovante (foto/PDF) que chega depois é lido pela IA e, se tudo bater (valor, recebedor, data, E2E inédito
//   e casa ainda livre), o robô cria a reserva direta, registra o sinal e confirma; senão, manda conferir.
//   Um comprovante bem falsificado ainda passa: o push "confira o sinal no banco" existe para isso.
// - mensagens que você manda pelo app (ecos) ficam registradas e silenciam o robô naquela conversa.
// Jeito de gente: espera uns segundos e responde a rajada ("oi" / "tudo bem?" / "tem vaga dia 20?") de uma vez só;
// cumprimenta pelo horário e pelo nome; responde "obrigado" sem puxar assunto (uma vez só); pede por escrito quando
// chega áudio; não repete a mesma frase nem reenvia a mesma cotação; "digitando..." proporcional ao tamanho do texto.
// O robô só informa disponibilidade e valor: nunca confirma reserva, não negocia e não responde o que não entendeu.
//
// Segredos (supabase secrets set): ANTHROPIC_API_KEY e
//   Z-API: ZAPI_INSTANCE, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, ZAPI_WEBHOOK_KEY (a Z-API não assina o webhook: a URL
//          cadastrada nela leva ?zapi=<ZAPI_WEBHOOK_KEY>). Com ZAPI_INSTANCE definido, as respostas saem pela Z-API.
//   Meta:  WA_VERIFY_TOKEN, WA_APP_SECRET, WA_TOKEN; opcionais WA_PHONE_ID (senão usa o do webhook), WA_GRAPH_VERSION (padrão v25.0)
// Teste sem a Meta: POST com cabeçalho x-hub-cron e corpo { "teste": { "wa_id": "5584...", "nome": "Ana", "texto": "..." } }
//   (acrescente "eco": true para simular uma mensagem sua). Nada é enviado ao WhatsApp no teste.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import Anthropic from 'npm:@anthropic-ai/sdk@0.134.0';
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@0.134.0/helpers/zod';
import { z } from 'npm:zod@4.6.7';
import { enviarZapi, lerBase, baseTexto, campoAPreencher, avisarPush } from '../_shared/wa.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GRAPH = `https://graph.facebook.com/${Deno.env.get('WA_GRAPH_VERSION') || 'v25.0'}`;
const ABERTAS = ['lead', 'orcamento', 'negociacao', 'fechado', 'realizado'];
const ACAO_RESPONDER = 'Responder WhatsApp';

type SB = ReturnType<typeof createClient>;
type Midia = { url?: string; mime: string; base64?: string };
type Entrada = { wa_id: string; nome?: string | null; wamid: string; tipo: string; texto: string | null; ts: Date; phoneId?: string; midia?: Midia | null };

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
    if (!t?.wa_id || !(t?.texto || t?.midia)) return json({ error: 'informe teste.wa_id e teste.texto' }, 400);
    // teste.midia = {mime, base64}: simula um comprovante (foto/PDF) sem a Z-API
    const midia = t.midia?.base64 && t.midia?.mime ? { mime: String(t.midia.mime), base64: String(t.midia.base64) } : null;
    const e: Entrada = { wa_id: String(t.wa_id).replace(/\D/g, ''), nome: t.nome, wamid: `teste-${crypto.randomUUID()}`, tipo: midia ? (midia.mime === 'application/pdf' ? 'document' : 'image') : 'text', texto: t.texto, ts: new Date(), midia };
    return json(t.eco ? await processarEco(sb, e) : await processarEntrada(sb, e, { teste: true }));
  }

  const zapi = url.searchParams.has('zapi');
  if (zapi) {
    const chave = Deno.env.get('ZAPI_WEBHOOK_KEY');
    if (!chave || url.searchParams.get('zapi') !== chave) return new Response('chave inválida', { status: 401 });
  } else if (!(await assinaturaOk(req, raw))) return new Response('assinatura inválida', { status: 401 });
  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response('ok'); }

  // Responde 200 na hora (Meta e Z-API reenviam se demorar) e processa em segundo plano
  const tarefa = (zapi ? processarZapi(sb, body) : processarWebhook(sb, body)).catch(e => console.error('wa-webhook', e));
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

// Z-API: um evento por chamada. "Ao receber" traz as do cliente e, com "notificar as enviadas por mim", as suas
// (fromMe). As que o próprio robô mandou pela API vêm com fromApi e já estão gravadas.
async function processarZapi(sb: SB, m: any) {
  if (m?.type !== 'ReceivedCallback') return;
  const inst = Deno.env.get('ZAPI_INSTANCE');
  if (inst && m.instanceId && m.instanceId !== inst) return console.warn('Z-API: instância desconhecida', m.instanceId);
  if (m.isGroup || m.isNewsletter || m.broadcast || m.isStatusReply || m.isEdit || m.reaction || !m.phone || !m.messageId) return;
  if (m.fromMe && m.fromApi) return;
  // O WhatsApp às vezes identifica a conversa por LID ("1701...@lid") em vez do telefone, sobretudo nas suas
  // mensagens: a Z-API traduz, senão a conversa sairia duplicada no Pipeline
  let phone = String(m.phone);
  if (phone.endsWith('@lid')) phone = (await telefoneDoLid(phone)) || phone;
  const wa_id = phone.includes('@') ? phone : phone.replace(/\D/g, '');
  const { tipo, texto, midia } = conteudoZapi(m);
  const e: Entrada = { wa_id, nome: m.fromMe ? null : m.senderName || m.chatName, wamid: m.messageId, tipo, texto, ts: new Date(m.momment || Date.now()), midia };
  if (m.fromMe) await processarEco(sb, e); else await processarEntrada(sb, e, {});
}

async function telefoneDoLid(lid: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.z-api.io/instances/${Deno.env.get('ZAPI_INSTANCE')}/token/${Deno.env.get('ZAPI_TOKEN')}/chats/${encodeURIComponent(lid)}`, {
      headers: { 'Client-Token': Deno.env.get('ZAPI_CLIENT_TOKEN') || '' }, signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok && /^\d{10,15}$/.test(j.phone || '') ? j.phone : null;
  } catch (e) { console.error('Z-API lid', e); return null; }
}

function conteudoZapi(m: any): { tipo: string; texto: string | null; midia?: Midia | null } {
  if (m.text?.message != null) return { tipo: 'text', texto: m.text.message };
  if (m.buttonsResponseMessage) return { tipo: 'text', texto: m.buttonsResponseMessage.message ?? null };
  if (m.listResponseMessage) return { tipo: 'text', texto: m.listResponseMessage.title ?? m.listResponseMessage.message ?? null };
  for (const tipo of ['image', 'video', 'audio', 'document', 'sticker', 'location', 'contact']) {
    if (!m[tipo]) continue;
    const leg = m[tipo].caption || m[tipo].fileName;
    // Foto ou PDF pode ser o comprovante do sinal: guarda o link para a IA ler
    const url = tipo === 'image' ? m.image.imageUrl : tipo === 'document' ? m.document.documentUrl : null;
    const midia = url ? { url, mime: String(m[tipo].mimeType || (tipo === 'image' ? 'image/jpeg' : 'application/pdf')) } : null;
    return { tipo, texto: `[${tipo}]${leg ? ' ' + leg : ''}`, midia };
  }
  return { tipo: 'outro', texto: null };
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

  // Rajada: quem escreve "oi", "tudo bem?" e "tem vaga dia 20?" em sequência recebe uma resposta só. Espera uns
  // segundos; se chegou outra mensagem do cliente nesse tempo, quem responde é ela (com a conversa toda)
  if (!teste) {
    const espera = Number(Deno.env.get('WA_AGRUPAR_S') ?? 6);
    if (espera > 0) await new Promise(r => setTimeout(r, espera * 1000));
    if (await chegouOutra(sb, e)) {
      await sb.from('wa_messages').update({ extracao: { robo: 'juntou com a mensagem seguinte' } }).eq('id', msg!.id);
      return { deal_id, respondeu: false, motivo: 'juntou com a mensagem seguinte' };
    }
  }

  // O que o robô decidiu fica gravado na mensagem (a aba WhatsApp mostra "por que não respondeu")
  const r: Record<string, any> = await decidir(sb, e, conversa, deal_id, msg!.id, teste);
  await sb.from('wa_messages').update({ extracao: { ...(r.extracao || {}), robo: r.respondeu ? 'respondeu' : r.motivo } }).eq('id', msg!.id);
  return r;
}

async function decidir(sb: SB, e: Entrada, conversa: any, deal_id: string, msgId: string, teste: boolean) {
  // ---------- o robô deve responder? ----------
  const motivo = await motivoSilencio(sb, conversa, e);
  if (motivo) return { deal_id, respondeu: false, motivo };

  const historico = await historicoConversa(sb, e.wa_id);
  // Foto/PDF com o sinal pendente: é o comprovante
  if (comprovanteEsperado(conversa, e)) return await conferirComprovante(sb, e, conversa, deal_id, historico, teste);
  // Áudio: o robô não ouve; pede por escrito (uma vez por dia) e o áudio fica para você ouvir
  if (e.tipo === 'audio') {
    if (historico.some(m => m.autor === 'robo' && m.texto.includes(PEDE_ESCRITO) && Date.now() - Date.parse(m.enviado_em) < 864e5))
      return { deal_id, respondeu: false, motivo: 'áudio: fica para você (o robô já pediu por escrito hoje)' };
    return responderRobo(sb, e, deal_id, saudar(`${PEDE_ESCRITO} Se for sobre vaga, me conta a data de entrada, a de saída e quantas pessoas, que eu já te passo os valores.`, historico, e.nome), teste);
  }
  const { data: casas } = await sb.from('properties').select('id,nome').order('nome');
  const base = baseTexto(await lerBase(sb), casas || [], { paraRobo: true });
  let x: Extracao;
  try { x = await extrair(historico, casas || [], base); }
  catch (err) { console.error('IA', err); return { deal_id, respondeu: false, motivo: 'IA indisponível: ' + (err as Error).message }; }
  await sb.from('wa_messages').update({ extracao: x }).eq('id', msgId);
  if (x.resumo) await sb.from('deals').update({ proxima_acao: `${ACAO_RESPONDER}: ${x.resumo}`.slice(0, 140) }).eq('id', deal_id);

  // Dúvida que a base das casas responde: o robô responde só com os fatos da base (a IA escreveu a resposta)
  // Pergunta que depende do Claudio: não inventa; avisa o cliente que vai confirmar, destaca no card e manda push
  const paraClaudio = x.pergunta_claudio?.trim() || null;
  // Mensagem que completa a reserva em andamento ("somos 4") e ainda traz uma pergunta para o Claudio: segue com
  // datas/valores e avisa da pergunta; sem dados da reserva, só avisa que vai confirmar
  const trouxeDados = !!(x.checkin || x.checkout || x.noites || x.hospedes);
  const disponibilidade = x.assunto === 'disponibilidade_preco' || (!!paraClaudio && trouxeDados && !!conversa.pedido);
  if (paraClaudio && !disponibilidade) return await encaminhar(sb, e, deal_id, x, paraClaudio, historico, teste);

  // "Obrigado", "ok", "vou ver com minha esposa": resposta curta, sem puxar assunto, e o card sai do "Responder"
  if (x.assunto === 'agradecimento') return await agradecer(sb, e, conversa, deal_id, x, historico, teste);

  // Quer reservar: confere de novo no Airbnb e manda total, sinal e Pix (ou pergunta o que falta)
  if (x.assunto === 'reservar') return await reservar(sb, e, conversa, deal_id, x, historico, casas || [], teste);

  const duvida = x.assunto === 'duvida' && !!base && !!x.resposta?.trim();
  // Só cumprimento ("oi", "bom dia", "?") ou pedido genérico de informação: o robô dá as boas-vindas e pede as datas
  const saudacao = x.assunto === 'saudacao';
  if (!disponibilidade && !duvida && !saudacao) return { deal_id, respondeu: false, motivo: `assunto "${x.assunto}": fica para você`, extracao: x };

  // Disponibilidade/valor: soma o que o cliente disse agora ao que já tinha dito (estado por contato)
  const pedido = duvida || saudacao ? null : combinarPedido(conversa.pedido, x);
  // A mesma consulta (casa, datas, pessoas, pets) que o robô já mandou: não reenvia os valores ("ok obrigada", "?")
  const chave = pedido && !oQueFalta(pedido) ? chaveCotacao(pedido) : null;
  if (pedido) pedido.cotado = conversa.pedido?.cotado ?? null;
  if (pedido) await sb.from('wa_contacts').update({ pedido }).eq('wa_id', e.wa_id);
  if (chave && chave === pedido!.cotado && !paraClaudio && conversando(historico))
    return { deal_id, respondeu: false, motivo: 'mesma consulta que o robô já enviou: fica para você', extracao: x };
  const falta = pedido ? oQueFalta(pedido) : null;
  const datas = pedido && !falta ? normalizarDatas(pedido)! : null;
  let texto: string, cot: any = null, redigido: string | null = null;
  if (duvida) {
    texto = x.resposta!.trim();
  } else if (saudacao && !conversando(historico)) {
    const nomes = (casas || []).map((c: any) => String(c.nome).replace(/^Casa\s+/i, ''));
    const lista = nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}` : nomes[0] || '';
    // "tudo bem?" do cliente pede resposta, não outra pergunta igual
    const perguntouTudoBem = /tudo (bem|bom|certo|tranquilo|joia)/i.test(semAcento(ultimasDoCliente(historico)));
    texto = `${perguntouTudoBem ? 'Tudo ótimo por aqui, e com você?' : 'Tudo bem?'} Aqui é do atendimento das casas ${lista}, no Condomínio Pipa Natureza, em Pipa 🌴\n${PEDE_TUDO}`;
  } else if (saudacao || falta) {
    // Falta algo para consultar: pergunta só isso, de forma específica (não chuta data nem número de pessoas)
    texto = falta ? pergunta(falta, pedido!) : PEDE_TUDO;
    // O cliente perguntou de novo sem dar as datas: explica por que precisa, em vez de repetir a mesma frase
    if (texto === PEDE_TUDO && ultimaDoRobo(historico)?.texto.endsWith(PEDE_TUDO)) texto = PEDE_TUDO_DE_NOVO;
  } else {
    cot = await cotar(datas!.checkin, datas!.checkout, pedido!.hospedes!, pedido!.pets);
    const casasOk = (cot?.casas || []).filter((c: any) => c.status !== 'erro');
    if (!cot?.mensagem || !casasOk.length) return { deal_id, respondeu: false, motivo: 'consulta ao Airbnb falhou: fica para você', extracao: x, cotacao: cot };
    // A IA escreve a resposta com os números da consulta (foco na casa pedida, nome do cliente, próximo passo);
    // se ela errar algum valor, deixar campo a preencher ou falhar, vai a mensagem padrão da airbnb-quote
    redigido = await redigir(historico, cot, base, '', e.nome).catch(err => { console.error('redigir', err); return null; });
    if (redigido && campoAPreencher(redigido)) { console.warn('redigir: campo a preencher; vai a mensagem padrão'); redigido = null; }
    texto = redigido || cot.mensagem;
  }
  if (!redigido) texto = saudar(texto, historico, e.nome);
  if (paraClaudio && !redigido) texto += `\n\n${avisoConfirmar(true)}`;
  // Entrada hoje: a casa pode não estar pronta; o próximo passo é do Claudio (a IA foi instruída a não perguntar se quer reservar)
  const ant = cot && datas ? antecedencia(datas.checkin) : null;
  if (ant === 0 && cot.casas.some((c: any) => c.status === 'livre')) texto += `\n\n${AVISO_HOJE}`;

  // Última barreira: nada com [campo], {campo}, XX... sai para o cliente
  const campo = campoAPreencher(texto);
  if (campo) return { deal_id, respondeu: false, motivo: `texto com campo a preencher (${campo}): fica para você`, extracao: x };
  // Gente não manda a mesma frase duas vezes seguidas
  if (texto === ultimaDoRobo(historico)?.texto) return { deal_id, respondeu: false, motivo: 'seria a mesma mensagem que o robô acabou de mandar: fica para você', extracao: x };

  const enviado = teste ? { wamid: `teste-out-${crypto.randomUUID()}` } : await enviar(e.wa_id, texto, e.phoneId);
  if (!enviado) return { deal_id, respondeu: false, motivo: 'falha ao enviar pelo WhatsApp', extracao: x };
  await sb.from('wa_messages').insert({ wamid: enviado.wamid, wa_id: e.wa_id, deal_id, direcao: 'out', autor: 'robo', texto, cotacao: cot });
  if (cot && pedido) await sb.from('wa_contacts').update({ pedido: { ...pedido, cotado: chaveCotacao(pedido) } }).eq('wa_id', e.wa_id);

  // Card: orçamento enviado, com data e valor quando a casa pedida está livre
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (cot && datas) {
    patch.proxima_acao = 'Acompanhar: o robô enviou disponibilidade e valores';
    patch.data_proxima_acao = addDays(hoje(), 1);
    patch.data_evento = datas.checkin;
    const pedida = cot.casas.find((c: any) => c.id === pedido!.casa && c.status === 'livre');
    if (pedida) { patch.valor = pedida.total; patch.local = pedida.nome; }
    const { data: d } = await sb.from('deals').select('etapa').eq('id', deal_id).single();
    if (d?.etapa === 'lead') patch.etapa = 'orcamento';
  } else if (duvida) {
    patch.proxima_acao = 'Acompanhar: o robô respondeu uma dúvida';
    patch.data_proxima_acao = addDays(hoje(), 1);
  } else {
    patch.proxima_acao = falta?.confirmar ? 'Acompanhar: o robô pediu para confirmar as datas'
      : falta && !falta.datas && !falta.saida ? 'Acompanhar: o robô perguntou quantas pessoas' : 'Acompanhar: o robô pediu as datas';
    patch.data_proxima_acao = addDays(hoje(), 1);
  }
  // Entrada em até 2 dias com casa livre: card urgente e push na hora (limpeza, chaves, horário de chegada)
  const livre = cot?.casas?.find((c: any) => c.id === pedido?.casa && c.status === 'livre') || cot?.casas?.find((c: any) => c.status === 'livre');
  const urg = ant != null && ant <= DIAS_URGENTE && livre ? urgente(ant, livre.nome) : null;
  if (urg) { patch.proxima_acao = urg; patch.data_proxima_acao = hoje(); }
  if (paraClaudio) { patch.proxima_acao = destaque(paraClaudio); patch.data_proxima_acao = hoje(); }
  await sb.from('deals').update(patch).eq('id', deal_id);
  if (paraClaudio && !teste) await avisar(sb, e, paraClaudio);
  else if (urg && !teste) await avisarUrgente(sb, e, urg, `${livre.nome}, ${dm(datas!.checkin)} a ${dm(datas!.checkout)}, ${quem(pedido!.hospedes!, pedido!.pets)}: ${moeda(livre.total)}`);
  return { deal_id, respondeu: true, texto, extracao: x, teste, ...(paraClaudio ? { para_claudio: paraClaudio } : {}) };
}

// ---------- pergunta que só o Claudio responde ----------
// De madrugada "já te retorno" é promessa que não se cumpre: entre 22h e 7h o retorno é "logo cedo"
const madrugada = () => { const h = horaPipa(); return h >= 22 || h < 7; };
const avisoConfirmar = (outra = false) => outra
  ? `Sobre a sua outra pergunta, vou confirmar e ${madrugada() ? 'te retorno logo cedo' : 'já te retorno'}.`
  : `Vou confirmar isso e ${madrugada() ? 'te retorno logo cedo, tá?' : 'já te retorno.'}`;
const AVISOS_CONFIRMAR = /vou confirmar (isso )?e (já te retorno|te retorno logo cedo)/i;
const destaque = (q: string) => `❓ Cliente pergunta: ${q}`.slice(0, 140);

async function encaminhar(sb: SB, e: Entrada, deal_id: string, x: Extracao, q: string, historico: any[], teste: boolean) {
  await sb.from('deals').update({ proxima_acao: destaque(q), data_proxima_acao: hoje(), updated_at: new Date().toISOString() }).eq('id', deal_id);
  // Já avisou o cliente e o Claudio ainda não respondeu: não repete o aviso nem o push (o card já mostra a pergunta nova)
  const ultimaResposta = [...historico].reverse().find(m => m.autor !== 'cliente');
  if (ultimaResposta?.autor === 'robo' && AVISOS_CONFIRMAR.test(String(ultimaResposta.texto)))
    return { deal_id, respondeu: false, motivo: 'pergunta para você: o cliente já sabe que você vai confirmar', extracao: x, para_claudio: q };
  const texto = saudar(avisoConfirmar(), historico, e.nome);
  const enviado = teste ? { wamid: `teste-out-${crypto.randomUUID()}` } : await enviar(e.wa_id, texto, e.phoneId);
  if (!enviado) return { deal_id, respondeu: false, motivo: 'falha ao enviar pelo WhatsApp', extracao: x, para_claudio: q };
  await sb.from('wa_messages').insert({ wamid: enviado.wamid, wa_id: e.wa_id, deal_id, direcao: 'out', autor: 'robo', texto });
  if (!teste) await avisar(sb, e, q);
  return { deal_id, respondeu: true, texto, extracao: x, para_claudio: q, teste };
}

// ---------- entrada próxima ----------
// Com menos de PRAZO_INTEGRAL dias até a entrada, o pagamento é integral na reserva (não há prazo para o restante).
// Entrada hoje: o robô passa disponibilidade e valor, mas quem confirma é o Claudio (a casa precisa estar pronta).
const PRAZO_INTEGRAL = 7;
const DIAS_URGENTE = 2;
const antecedencia = (checkin: string) => dias(hoje(), checkin);
const AVISO_HOJE = 'Como a entrada é hoje, vou confirmar com o Claudio o horário em que a casa fica pronta e já te retorno 🙏';
const urgente = (n: number, casa: string) => `🔥 ${n === 0 ? 'Quer entrar HOJE' : n === 1 ? 'Quer entrar amanhã' : `Entrada em ${n} dias`}: ${casa}`.slice(0, 140);

async function avisarUrgente(sb: SB, e: Entrada, titulo: string, corpo: string) {
  const { data: c } = await sb.from('wa_contacts').select('nome').eq('wa_id', e.wa_id).maybeSingle();
  const nome = String(c?.nome || e.nome || telefoneBonito(e.wa_id)).split(' ')[0];
  await avisarPush(sb, { title: `${nome}: ${titulo.replace(/^🔥 /, '')}`, body: corpo, tag: 'wa-urgente', url: `./#/whatsapp?c=${encodeURIComponent(e.wa_id)}` })
    .catch(err => console.error('push', err));
}

async function avisar(sb: SB, e: Entrada, q: string) {
  const { data: c } = await sb.from('wa_contacts').select('nome').eq('wa_id', e.wa_id).maybeSingle();
  const nome = String(c?.nome || e.nome || telefoneBonito(e.wa_id)).split(' ')[0];
  await avisarPush(sb, { title: `${nome} perguntou algo que só você responde`, body: q, tag: 'wa-pergunta', url: `./#/whatsapp?c=${encodeURIComponent(e.wa_id)}` })
    .catch(err => console.error('push', err));
}

// ---------- agradecimento, "ok", "vou pensar" ----------
async function agradecer(sb: SB, e: Entrada, conversa: any, deal_id: string, x: Extracao, historico: any[], teste: boolean) {
  await sb.from('deals').update({ proxima_acao: `Acompanhar: ${x.resumo || 'o cliente agradeceu'}`.slice(0, 140), data_proxima_acao: addDays(hoje(), 2), updated_at: new Date().toISOString() }).eq('id', deal_id);
  // Sem pingue-pongue de "obrigado" / "imagina" / "👍": se o robô já respondeu um agradecimento, fica quieto
  const iUlt = historico.findLastIndex(m => m.autor !== 'cliente');
  const antes = iUlt > 0 ? historico.slice(0, iUlt).findLast(m => m.autor === 'cliente') : null;
  if (iUlt < 0 || historico[iUlt].autor !== 'robo' || antes?.extracao?.assunto === 'agradecimento')
    return { deal_id, respondeu: false, motivo: 'agradecimento: nada a responder', extracao: x };
  // A IA escreve uma frase curta; com número, valor ou promessa, vai a frase padrão
  const ia = x.resposta?.trim() || '';
  const ok = ia && ia.length <= 160 && !/\d|R\$|reserv|pix|confirm|garant/i.test(ia) && !campoAPreencher(ia);
  const texto = ok ? ia : conversa.pedido?.cotado
    ? 'Imagina! Se decidirem, é só me chamar que eu confiro de novo a disponibilidade 😊'
    : 'Imagina! Qualquer coisa, é só chamar 😊';
  return responderRobo(sb, e, deal_id, texto, teste, { extracao: x });
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
  if (!comprovanteEsperado(c, e) && e.tipo !== 'audio' && (e.tipo !== 'text' || !e.texto?.trim())) return `mensagem do tipo ${e.tipo}: fica para você`;
  if (c.ultima_manual && Date.now() - Date.parse(c.ultima_manual) < cfg.horas_silencio * 3600e3) return `você respondeu à mão nas últimas ${cfg.horas_silencio} h`;
  const { count } = await sb.from('wa_messages').select('id', { count: 'exact', head: true })
    .eq('wa_id', c.wa_id).eq('autor', 'robo').gte('enviado_em', new Date(Date.now() - 864e5).toISOString());
  if ((count || 0) >= cfg.max_respostas_dia) return `limite de ${cfg.max_respostas_dia} respostas automáticas em 24 h`;
  return null;
}

// Cumprimento só quando o robô abre a conversa: se você ou ele já responderam nas últimas 24 h, segue o papo sem
// cumprimentar. É pelo horário de Pipa e com o primeiro nome do perfil, quando parece um nome ("Boa tarde, Ana!")
// (a mensagem da airbnb-quote vem com "Olá!" porque também é usada no botão de Aluguéis)
function saudar(texto: string, historico: any[], nome?: string | null) {
  const corpo = texto.replace(/^Olá!\s*/, '');
  return conversando(historico) ? corpo : `${cumprimento(nome)} ${corpo}`;
}
const horaPipa = () => +new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).format(new Date());
const periodo = () => { const h = horaPipa(); return h >= 5 && h < 12 ? 'Bom dia' : h >= 12 && h < 18 ? 'Boa tarde' : 'Boa noite'; };
const primeiroNome = (nome?: string | null) => { const n = String(nome || '').trim().split(/\s+/)[0]; return /^\p{L}{2,}$/u.test(n) ? n[0].toUpperCase() + n.slice(1).toLowerCase() : ''; };
const cumprimento = (nome?: string | null) => { const n = primeiroNome(nome); return `${periodo()}${n ? `, ${n}` : ''}!`; };
const conversando = (historico: any[]) => historico.some(m => m.autor !== 'cliente' && Date.now() - Date.parse(m.enviado_em) < 864e5);
const ultimaDoRobo = (historico: any[]) => historico.findLast(m => m.autor !== 'cliente' && Date.now() - Date.parse(m.enviado_em) < 864e5);
// O que o cliente escreveu desde a última resposta (a rajada inteira)
const ultimasDoCliente = (historico: any[]) => historico.slice(historico.findLastIndex(m => m.autor !== 'cliente') + 1).map(m => m.texto).join('\n');

async function historicoConversa(sb: SB, wa_id: string) {
  const { data } = await sb.from('wa_messages').select('autor,texto,enviado_em,extracao').eq('wa_id', wa_id).order('enviado_em', { ascending: false }).limit(12);
  return (data || []).reverse().filter((m: any) => m.texto);
}

// Outra mensagem do cliente, ainda sem resposta decidida, chegou depois desta (mesmo segundo: desempata pelo id)
async function chegouOutra(sb: SB, e: Entrada) {
  const { data } = await sb.from('wa_messages').select('wamid,enviado_em,extracao').eq('wa_id', e.wa_id).eq('autor', 'cliente')
    .gte('enviado_em', new Date(e.ts.getTime() - 1000).toISOString());
  const t = e.ts.getTime();
  return (data || []).some((m: any) => m.wamid !== e.wamid && !m.extracao && (Date.parse(m.enviado_em) > t || (Date.parse(m.enviado_em) === t && m.wamid > e.wamid)));
}

// ---------- reserva direta: sinal por Pix e comprovante lido pela IA ----------
type Sinal = { casa: string; nome: string; checkin: string; checkout: string; hospedes: number; pets?: number | null; total: number; valor: number; pct: number; desde: string };
const centavos = (v: number) => Math.round(v * 100) / 100;
const comprovanteEsperado = (c: any, e: Entrada) => !!e.midia && ['image', 'document'].includes(e.tipo) && !!c?.pedido?.sinal;

async function responderRobo(sb: SB, e: Entrada, deal_id: string, texto: string, teste: boolean, extra: Record<string, unknown> = {}) {
  const campo = campoAPreencher(texto);
  if (campo) return { deal_id, respondeu: false, motivo: `texto com campo a preencher (${campo}): fica para você`, ...extra };
  const enviado = teste ? { wamid: `teste-out-${crypto.randomUUID()}` } : await enviar(e.wa_id, texto, e.phoneId);
  if (!enviado) return { deal_id, respondeu: false, motivo: 'falha ao enviar pelo WhatsApp', ...extra };
  await sb.from('wa_messages').insert({ wamid: enviado.wamid, wa_id: e.wa_id, deal_id, direcao: 'out', autor: 'robo', texto });
  return { deal_id, respondeu: true, texto, teste, ...extra };
}

async function reservar(sb: SB, e: Entrada, conversa: any, deal_id: string, x: Extracao, historico: any[], casas: { id: string; nome: string }[], teste: boolean) {
  const pedido = combinarPedido(conversa.pedido, x);
  const sinalAntes: Sinal | undefined = conversa.pedido?.sinal;
  const g = (await lerBase(sb)).geral || {};
  // Já mandou o Pix desta mesma reserva: só lembra de mandar o comprovante
  if (sinalAntes && (!isoOk(x.checkin) || x.checkin === sinalAntes.checkin) && (x.casa === 'qualquer' || x.casa === sinalAntes.casa)) {
    await sb.from('wa_contacts').update({ pedido: { ...pedido, sinal: sinalAntes } }).eq('wa_id', e.wa_id);
    return responderRobo(sb, e, deal_id, saudar(`Assim que fizer o Pix de ${moeda(sinalAntes.valor)}, me manda o comprovante aqui (foto ou PDF) que eu confirmo a reserva da ${sinalAntes.nome}.`, historico, e.nome), teste, { extracao: x });
  }
  await sb.from('wa_contacts').update({ pedido }).eq('wa_id', e.wa_id);
  const falta = oQueFalta(pedido);
  if (falta) {
    await sb.from('deals').update({ proxima_acao: 'Acompanhar: o robô pediu os dados para reservar', data_proxima_acao: addDays(hoje(), 1) }).eq('id', deal_id);
    return responderRobo(sb, e, deal_id, saudar(pergunta(falta, pedido), historico, e.nome), teste, { extracao: x });
  }
  if (!g.pix_chave?.trim() || !g.pix_nome?.trim()) {
    const nomeCasa = casas.find(c => c.id === pedido.casa)?.nome;
    return encaminhar(sb, e, deal_id, x, `Quer reservar${nomeCasa ? ` a ${nomeCasa}` : ''} de ${dm(pedido.checkin!)} a ${dm(fimDe(pedido)!)} (chave Pix não cadastrada)`, historico, teste);
  }
  const datas = normalizarDatas(pedido)!;
  const cot = await cotar(datas.checkin, datas.checkout, pedido.hospedes!, pedido.pets);
  const lista = (cot?.casas || []) as any[];
  if (!lista.some(c => c.status !== 'erro')) return { deal_id, respondeu: false, motivo: 'consulta ao Airbnb falhou: fica para você', extracao: x };
  const livres = lista.filter(c => c.status === 'livre');
  const periodo = `de ${dm(datas.checkin)} a ${dm(datas.checkout)}`;
  if (pedido.casa === 'qualquer') {
    // Falta escolher a casa: mostra só as livres
    const texto = livres.length
      ? `Para reservar ${periodo}, qual casa vocês preferem?\n${livres.map(c => `• ${c.nome}: ${moeda(c.total)} no total`).join('\n')}`
      : String(cot.mensagem).replace(/^Olá!\s*/, '');
    return responderRobo(sb, e, deal_id, saudar(texto, historico, e.nome), teste, { extracao: x });
  }
  const c = lista.find(k => k.id === pedido.casa);
  const nomeCasa = c?.nome || casas.find(k => k.id === pedido.casa)?.nome || pedido.casa;
  if (c?.status === 'nao_aceita_pet') {
    const outras = livres.length ? `\nAceitam pets e estão livres ${periodo}:\n${livres.map(k => `• ${k.nome}: ${moeda(k.total)} no total`).join('\n')}` : '';
    return responderRobo(sb, e, deal_id, saudar(`A ${nomeCasa} não aceita pets.${outras}`, historico, e.nome), teste, { extracao: x });
  }
  if (!c || c.status !== 'livre') {
    const outras = livres.length ? `\nLivres ${periodo}:\n${livres.map(k => `• ${k.nome}: ${moeda(k.total)} no total`).join('\n')}` : '';
    const alt = c?.alternativa ? `\nA ${nomeCasa} fica livre de ${dm(c.alternativa.checkin)} a ${dm(c.alternativa.checkout)}, por ${moeda(c.alternativa.total)}.` : '';
    return responderRobo(sb, e, deal_id, saudar(`A ${nomeCasa} não está mais livre ${periodo}.${alt}${outras}${alt || outras ? '' : '\nSe tiver outras datas, me diga que eu verifico.'}`, historico, e.nome), teste, { extracao: x });
  }
  // Entrada hoje: não manda Pix; o Claudio confirma se a casa fica pronta
  const ant = antecedencia(datas.checkin);
  if (ant === 0) return encaminhar(sb, e, deal_id, x, `Quer reservar a ${nomeCasa} para HOJE (${dm(datas.checkin)} a ${dm(datas.checkout)}, ${moeda(c.total)})`, historico, teste);
  // Menos de 7 dias até a entrada: pagamento integral na reserva
  const integral = ant < PRAZO_INTEGRAL;
  const pct = integral ? 100 : Math.min(100, Math.max(1, +g.sinal_pct || 50));
  const sinal: Sinal = { casa: pedido.casa, nome: nomeCasa, checkin: datas.checkin, checkout: datas.checkout, hospedes: pedido.hospedes!, ...(pedido.pets ? { pets: pedido.pets } : {}), total: c.total, valor: centavos(c.total * pct / 100), pct, desde: new Date().toISOString() };
  await sb.from('wa_contacts').update({ pedido: { ...pedido, sinal } }).eq('wa_id', e.wa_id);
  const texto = saudar(`Ótimo! Para reservar a ${nomeCasa} de ${diaDm(datas.checkin)}, a ${diaDm(datas.checkout)}, para ${quem(sinal.hospedes, sinal.pets)}, o total é ${moeda(sinal.total)}.\n` +
    (integral ? `Como a entrada é em menos de ${PRAZO_INTEGRAL} dias, o pagamento é integral: ${moeda(sinal.valor)}, por Pix:\n` : `O sinal é de ${moeda(sinal.valor)} (${pct}%), por Pix:\n`) +
    `Chave: ${g.pix_chave.trim()}\nNome: ${g.pix_nome.trim()}\n` +
    `Depois é só me mandar o comprovante aqui (foto ou PDF) que eu confirmo a reserva.`, historico, e.nome);
  const r = await responderRobo(sb, e, deal_id, texto, teste, { extracao: x, sinal });
  if (r.respondeu) await sb.from('deals').update({ etapa: 'negociacao', valor: sinal.total, local: nomeCasa, data_evento: sinal.checkin,
    proxima_acao: `Aguardando ${integral ? 'pagamento' : 'sinal'} de ${moeda(sinal.valor)}`, data_proxima_acao: addDays(hoje(), 1), updated_at: new Date().toISOString() }).eq('id', deal_id);
  return r;
}

// O que a IA lê do comprovante
const ComprovanteSchema = z.object({
  e_comprovante_pix: z.boolean(),
  valor: z.number().nullable(),
  recebedor_nome: z.string().nullable(),
  recebedor_chave: z.string().nullable(),
  pagador_nome: z.string().nullable(),
  data_hora: z.string().nullable(),
  e2e: z.string().nullable(),
});
type Leitura = z.infer<typeof ComprovanteSchema>;

async function baixarMidia(m: Midia): Promise<{ mime: string; base64: string }> {
  if (m.base64) return { mime: m.mime, base64: m.base64 };
  const r = await fetch(m.url!, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error('arquivo grande demais');
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const mime = (r.headers.get('content-type') || m.mime).split(';')[0].trim();
  return { mime: /^image\/|^application\/pdf$/.test(mime) ? mime : m.mime, base64: btoa(bin) };
}

async function lerComprovante(arq: { mime: string; base64: string }): Promise<Leitura> {
  const bloco = arq.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: arq.base64 } }
    : { type: 'image', source: { type: 'base64', media_type: /^image\/(jpeg|png|gif|webp)$/.test(arq.mime) ? arq.mime : 'image/jpeg', data: arq.base64 } };
  const r = await new Anthropic().messages.parse({
    model: 'claude-haiku-5-5',
    max_tokens: 2000,
    output_config: { effort: 'medium', format: zodOutputFormat(ComprovanteSchema) },
    system: `Você lê comprovantes de Pix de bancos brasileiros e transcreve os dados exatamente como aparecem. Não deduza nem complete nada que não esteja legível: use nulo.
e_comprovante_pix: true só se for um comprovante de transferência Pix concluída (não agendamento, não boleto, não print de chave).
valor: o valor transferido, em reais (número, ex.: 825.5). recebedor_nome e recebedor_chave: quem recebeu e a chave Pix do recebedor, como aparecem (podem vir mascarados). pagador_nome: quem pagou.
data_hora: data e hora da transferência em ISO 8601 com o fuso de Brasília (ex.: 2026-10-23T14:05:00-03:00).
e2e: o "ID da transação" / "Identificador" / "ID E2E" / "Código de autenticação" que começa com E e tem 32 caracteres, sem espaços; nulo se não houver.`,
    messages: [{ role: 'user', content: [bloco as any, { type: 'text', text: 'Transcreva os dados deste comprovante.' }] }],
  });
  if (r.stop_reason === 'refusal' || !r.parsed_output) throw new Error(`sem leitura (${r.stop_reason})`);
  return r.parsed_output;
}

const semAcento = (t: string) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PALAVRAS_VAZIAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
const palavras = (t: string) => semAcento(t).split(/[^a-z0-9]+/).filter(w => w.length > 1 && !PALAVRAS_VAZIAS.has(w));

// Recebedor confere com o titular: o primeiro e o último nome aparecem, ou a chave é a mesma
export function recebedorConfere(l: Leitura, pixNome: string, pixChave: string) {
  const esperado = palavras(pixNome), lido = new Set(palavras(l.recebedor_nome || ''));
  const nomeOk = esperado.length > 0 && lido.has(esperado[0]) && lido.has(esperado.at(-1)!);
  const ch = semAcento(pixChave).trim(), chLida = semAcento(l.recebedor_chave || '').trim();
  const dig = ch.replace(/\D/g, ''), digLido = chLida.replace(/\D/g, '');
  const chaveOk = !!chLida && (chLida === ch || (dig.length >= 11 && !/[a-z@]/.test(ch) && digLido === dig));
  return nomeOk || chaveOk;
}

// Lista do que não confere (vazia = comprovante aceito)
export function problemasComprovante(l: Leitura, s: Sinal, g: { pix_nome?: string; pix_chave?: string }, agora = Date.now()) {
  const p: string[] = [];
  if (!l.e_comprovante_pix) return ['não parece um comprovante de Pix'];
  if (l.valor == null || l.valor + 0.009 < s.valor) p.push(l.valor == null ? 'valor ilegível' : `valor ${moeda(l.valor)} menor que o sinal de ${moeda(s.valor)}`);
  if (!recebedorConfere(l, g.pix_nome || '', g.pix_chave || '')) p.push(`recebedor não confere (${l.recebedor_nome || l.recebedor_chave || 'ilegível'})`);
  const t = Date.parse(l.data_hora || '');
  if (isNaN(t)) p.push('data ilegível');
  else if (t < Date.parse(s.desde) - 15 * 60e3 || t > agora + 15 * 60e3) p.push('data fora do período da reserva');
  const e2e = String(l.e2e || '').replace(/\s/g, '');
  if (!/^E\d{20}[A-Za-z0-9]{11}$/.test(e2e)) p.push('ID da transação (E2E) ausente ou fora do formato');
  return p;
}

async function conferirComprovante(sb: SB, e: Entrada, conversa: any, deal_id: string, historico: any[], teste: boolean) {
  const s: Sinal = conversa.pedido.sinal;
  const g = (await lerBase(sb)).geral || {};
  let leitura: Leitura | null = null, problemas: string[] = [];
  try { leitura = await lerComprovante(await baixarMidia(e.midia!)); problemas = problemasComprovante(leitura, s, g); }
  catch (err) { console.error('comprovante', err); problemas = ['não consegui ler o arquivo: ' + (err as Error).message]; }
  const e2e = leitura?.e2e ? String(leitura.e2e).replace(/\s/g, '').toUpperCase() : null;
  if (!problemas.length && e2e) {
    const { data: usado } = await sb.from('wa_comprovantes').select('id').eq('e2e', e2e).eq('status', 'valido').maybeSingle();
    if (usado) problemas.push('comprovante já usado em outra reserva');
  }
  if (!problemas.length) {
    // Antes de confirmar: a casa continua livre no Airbnb e no Hub
    const cot = await cotar(s.checkin, s.checkout, s.hospedes, s.pets);
    if ((cot?.casas || []).find((c: any) => c.id === s.casa)?.status !== 'livre') problemas.push('a casa não está mais livre no Airbnb');
    const { data: bks } = await sb.from('bookings').select('id,checkin,checkout,status').eq('property_id', s.casa).neq('status', 'cancelada');
    if ((bks || []).some((b: any) => b.checkin < s.checkout && b.checkout > s.checkin)) problemas.push('já existe reserva ou bloqueio nessas datas no Hub');
  }
  const registro = { wa_id: e.wa_id, deal_id, e2e, valor: leitura?.valor ?? null, leitura, sinal: s };

  if (problemas.length) {
    const motivo = problemas.join('; ');
    await sb.from('wa_comprovantes').insert({ ...registro, status: 'invalido', motivo });
    await sb.from('deals').update({ proxima_acao: `❓ Conferir comprovante: ${motivo}`.slice(0, 140), data_proxima_acao: hoje(), updated_at: new Date().toISOString() }).eq('id', deal_id);
    const r = await responderRobo(sb, e, deal_id, saudar('Recebi o comprovante! Vou conferir e já te retorno.', historico, e.nome), teste, { comprovante: 'conferir', motivo_comprovante: motivo });
    if (!teste) await avisarComprovante(sb, e, `Comprovante para conferir (${s.nome}, ${moeda(s.valor)})`, motivo);
    return r;
  }

  // Tudo certo: reserva direta confirmada (vai para o ical-feed e bloqueia o Airbnb), sinal registrado, card fechado
  const { data: ct } = await sb.from('contacts').select('nome').eq('id', conversa.contato_id).maybeSingle();
  const hospede = ct?.nome || e.nome || telefoneBonito(e.wa_id);
  const { data: bk } = await sb.from('bookings').insert({
    property_id: s.casa, checkin: s.checkin, checkout: s.checkout, origem: 'direto', status: 'confirmada', valor: s.total,
    hospede, contato_id: conversa.contato_id, notas: `Reserva confirmada pelo robô do WhatsApp. Sinal ${moeda(leitura!.valor!)} por Pix (E2E ${e2e}). ${quem(s.hospedes, s.pets)}.`,
  }).select('id').single();
  await sb.from('wa_comprovantes').insert({ ...registro, status: 'valido', booking_id: bk?.id });
  const { data: d } = await sb.from('deals').select('pagamentos').eq('id', deal_id).maybeSingle();
  const pagamentos = [...((d?.pagamentos as any[]) || []), { data: hoje(), valor: leitura!.valor, forma: 'Pix', obs: `Sinal (comprovante lido pelo robô, E2E ${e2e})` }];
  await sb.from('deals').update({ etapa: 'fechado', valor: s.total, local: s.nome, data_evento: s.checkin, pagamentos,
    proxima_acao: 'Conferir o sinal no banco (reserva confirmada pelo robô)', data_proxima_acao: hoje(), updated_at: new Date().toISOString() }).eq('id', deal_id);
  await sb.from('wa_contacts').update({ pedido: { ...conversa.pedido, sinal: null, reservado: { booking_id: bk?.id, em: new Date().toISOString() } } }).eq('wa_id', e.wa_id);
  const falta = centavos(s.total - leitura!.valor!);
  const texto = saudar(`Reserva confirmada! ✅\n${s.nome}, de ${diaDm(s.checkin)}, a ${diaDm(s.checkout)}, para ${quem(s.hospedes, s.pets)}.\n` +
    `Recebi ${s.pct >= 100 ? 'o pagamento' : 'o sinal'} de ${moeda(leitura!.valor!)}${falta > 0 ? `; faltam ${moeda(falta)} do total de ${moeda(s.total)}` : ''}.\nQualquer dúvida, é só chamar por aqui.`, historico, e.nome);
  const r = await responderRobo(sb, e, deal_id, texto, teste, { comprovante: 'confirmada', booking_id: bk?.id });
  if (!teste) await avisarComprovante(sb, e, `Reserva confirmada pelo robô: ${s.nome}, ${dm(s.checkin)} a ${dm(s.checkout)}`, `Sinal de ${moeda(leitura!.valor!)} (E2E ${e2e}). Confira o sinal no banco.`);
  return r;
}

async function avisarComprovante(sb: SB, e: Entrada, title: string, body: string) {
  await avisarPush(sb, { title, body, tag: 'wa-comprovante', url: `./#/whatsapp?c=${encodeURIComponent(e.wa_id)}` }).catch(err => console.error('push', err));
}

// ---------- IA: o que o cliente quer ----------
const ExtracaoSchema = z.object({
  assunto: z.enum(['disponibilidade_preco', 'reservar', 'confirmar_reserva', 'duvida', 'saudacao', 'agradecimento', 'outro']),
  casa: z.enum(['QS39', 'QS40', 'QS50', 'qualquer']),
  checkin: z.string().nullable(),
  checkout: z.string().nullable(),
  noites: z.number().int().nullable(),
  hospedes: z.number().int().nullable(),
  pets: z.number().int().nullable(),
  datas_exatas: z.boolean(),
  resumo: z.string(),
  resposta: z.string().nullable(),
  pergunta_claudio: z.string().nullable(),
});
type Extracao = z.infer<typeof ExtracaoSchema>;

async function extrair(historico: any[], casas: { id: string; nome: string }[], base = ''): Promise<Extracao> {
  const d = hoje();
  const dia = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date());
  const system = `Você lê conversas do WhatsApp de atendimento de 3 casas de temporada no Condomínio Pipa Natureza (Pipa/RN) e extrai dados para um sistema. Hoje é ${dia}, ${d}.
Casas: ${casas.map(c => `${c.id} = ${c.nome}`).join('; ')}.

Classifique a ÚLTIMA mensagem do cliente, usando as anteriores como contexto. O cliente às vezes escreve em várias mensagens seguidas ("oi" / "tudo bem?" / "tem vaga dia 20?"): as mensagens dele depois da última resposta do Robô ou do Claudio contam como UMA só; classifique pelo pedido mais concreto entre elas.
- "disponibilidade_preco": pergunta se há vaga, quanto custa, valores ou diária para um período (mesmo que ainda sem datas).
- "reservar": quer reservar ou fechar uma casa ("quero reservar", "vamos fechar a azul", "como faço para reservar?"), pede o Pix ou os dados para pagar o sinal, ou diz que já pagou ou vai mandar o comprovante. Escolher uma casa ou dizer novas datas depois de receber valores SEM dizer que quer reservar ("a azul, dia 05/11", "e para o feriado?") NÃO é reservar: é "disponibilidade_preco".
- "confirmar_reserva": quer negociar desconto, condição especial ou forma de pagamento diferente do Pix do sinal (cartão, parcelado).
- "saudacao": só cumprimenta ou chama ("oi", "olá", "bom dia", "tudo bem?", "?", "alguém aí?") ou pede informações de forma genérica ("queria informações sobre as casas"), sem pergunta concreta.
- "duvida": pergunta sobre as casas, regras, localização, horários, pets ou comodidades que as INFORMAÇÕES DAS CASAS abaixo respondem por completo.
- "agradecimento": só agradece, concorda, se despede ou diz que vai pensar / falar com alguém e depois retorna ("obrigado", "ok, valeu", "show", "vou ver com minha esposa e te falo", "👍"), sem pergunta nem dado novo. Se junto vier pergunta ou dado (datas, pessoas, casa), use o assunto dela.
- "outro": qualquer outra coisa (dúvida que as informações não respondem, reclamação, pedido especial, conversa).

Datas: converta para AAAA-MM-DD. Datas sem ano são a próxima ocorrência a partir de hoje. "Fim de semana" = sexta a domingo (saída no domingo). Feriados citados pelo nome (Réveillon, Carnaval etc.): use as datas do próximo feriado. Se o cliente der só a entrada e o número de noites, preencha noites e deixe checkout nulo. Se não houver data clara, deixe nulo: nunca invente.
datas_exatas: true SOMENTE se as datas que o cliente disse são precisas, com dia e mês (ex.: "de 17 a 20 de novembro", "dia 5/12, 3 noites", "chego dia 17/11" — mesmo que ainda falte a saída), ou se respondeu confirmando ("sim", "isso", "certo") as datas que o Robô perguntou. false quando usou expressões vagas: "fim de semana", "semana que vem", feriado pelo nome (Réveillon, Carnaval, Natal, Páscoa), só o mês, dia sem o mês ("dia 20"), "umas X noites", "entre X e Y", "por volta de". Mesmo com datas_exatas false, preencha checkin/checkout com a sua melhor interpretação (o sistema pergunta ao cliente se está certo). Se nesta mensagem o cliente só respondeu o que o Robô perguntou (ex.: "fico até dia 20", "somos 4"), junte com o que ele já tinha dito antes na conversa.
casa: a casa citada pelo nome na última mensagem ou antes na conversa (se o cliente não mudou de ideia), ou "qualquer". hospedes: total de pessoas (adultos + crianças) considerando a conversa toda: se o cliente disse antes ("somos 6") e não mudou, repita; nulo só se nunca disse.
pets: quantos animais de estimação vão junto, considerando a conversa toda ("levo um cachorrinho" = 1, "dois cachorros" = 2, "não vamos levar pet" = 0); nulo se o cliente nunca falou de pet. Se perguntou se pode levar sem dizer quantos, 1.
resumo: até 8 palavras para o card, ex.: "Vaga 20-23/11, 6 pessoas, Casa Azul".
pergunta_claudio: se a ÚLTIMA mensagem do cliente traz uma pergunta ou pedido que só o dono (Claudio) pode decidir ou informar, escreva-a aqui, curta e em 3ª pessoa (ex.: "Pede desconto para 5 noites", "Quer levar um cachorro grande", "Quer fazer check-in às 8h", "Quer pagar por Pix fora do Airbnb"). Entram: desconto ou negociação de preço; pet, festa, evento ou visita quando as informações das casas não respondem; check-in antecipado ou checkout tardio; forma de pagamento diferente do Pix do sinal (cartão, parcelado); qualquer informação das casas que não está abaixo. Se a mesma mensagem também traz datas ou número de pessoas para a reserva, use assunto "disponibilidade_preco" e preencha pergunta_claudio. NÃO entram: o que o próprio cliente responde (datas, pessoas, casa), o que as informações das casas respondem, cumprimentos, agradecimentos e conversa. Senão, nulo.
resposta: quando assunto = "agradecimento": uma frase curta e calorosa, como uma pessoa responderia no WhatsApp (ex.: "Imagina! Fico à disposição 😊", "Claro, sem pressa! Qualquer dúvida é só chamar"), sem números, valores, datas nem promessas.
Quando assunto = "duvida": a resposta para o cliente, em português do Brasil, curta e cordial, como uma pessoa da equipe no WhatsApp, no tom de quem já está conversando (sem "Olá"), usando SOMENTE fatos das informações das casas, sem inventar nem prometer nada além delas. Nunca escreva campos para preencher (colchetes, chaves, "XX", "nome do cliente"): o texto vai pronto para o cliente. Nos outros assuntos, nulo.
resumo, quando assunto = "agradecimento": o que o cliente disse, ex.: "Agradeceu", "Vai falar com a esposa".

<informacoes_das_casas>
${base || '(nenhuma informação cadastrada: nunca use "duvida")'}
</informacoes_das_casas>`;
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

// ---------- o que o cliente já disse (wa_contacts.pedido) e o que falta perguntar ----------
type Pedido = { casa: string; checkin: string | null; checkout: string | null; noites: number | null; hospedes: number | null; pets?: number | null; datas_exatas: boolean; em: string; cotado?: string | null };
const isoOk = (s: string | null | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

// O que veio agora tem prioridade; o que não veio continua o que o cliente disse antes (até 7 dias)
function combinarPedido(antigo: Partial<Pedido> | null | undefined, x: Extracao): Pedido {
  const v: Partial<Pedido> = antigo && Date.now() - Date.parse(antigo.em || '') < 7 * 864e5 ? antigo : {};
  const p: Pedido = {
    casa: x.casa !== 'qualquer' ? x.casa : v.casa || 'qualquer',
    checkin: v.checkin ?? null, checkout: v.checkout ?? null, noites: v.noites ?? null,
    hospedes: x.hospedes && x.hospedes > 0 ? x.hospedes : v.hospedes ?? null,
    pets: x.pets != null && x.pets >= 0 ? Math.min(5, x.pets) : v.pets ?? null,
    datas_exatas: !!v.datas_exatas, em: new Date().toISOString(),
  };
  if (isoOk(x.checkin)) {
    // Nova entrada sem saída: a saída antiga não vale mais (pergunta de novo)
    if (x.checkin !== v.checkin) { p.checkout = null; p.noites = null; }
    p.checkin = x.checkin;
    p.datas_exatas = x.datas_exatas;
  }
  if (isoOk(x.checkout)) { p.checkout = x.checkout; p.noites = null; }
  else if (x.noites && x.noites > 0) { p.noites = x.noites; p.checkout = null; }
  return p;
}

type Falta = { datas?: boolean; confirmar?: boolean; saida?: boolean; pessoas?: boolean };
const fimDe = (p: Pedido) => (p.checkin ? (isoOk(p.checkout) ? p.checkout : p.noites ? addDays(p.checkin, p.noites) : null) : null);
function oQueFalta(p: Pedido): Falta | null {
  const f: Falta = {};
  const fim = fimDe(p);
  if (!isoOk(p.checkin) || p.checkin! < hoje() || (fim && (fim <= p.checkin! || dias(p.checkin!, fim) > 60))) f.datas = true;
  else if (!p.datas_exatas) f.confirmar = true;
  else if (!fim) f.saida = true;
  if (!p.hospedes) f.pessoas = true;
  return Object.keys(f).length ? f : null;
}

// Identifica a consulta já enviada ao cliente (casa, período, pessoas, pets)
const chaveCotacao = (p: Pedido) => { const d = normalizarDatas(p); return d ? [p.casa, d.checkin, d.checkout, p.hospedes, p.pets || 0].join('|') : null; };

function normalizarDatas(p: Pedido) {
  const fim = fimDe(p);
  if (!isoOk(p.checkin) || !fim || fim <= p.checkin! || p.checkin! < hoje() || dias(p.checkin!, fim) > 60) return null;
  return { checkin: p.checkin!, checkout: fim };
}

// "4 pessoas" / "4 pessoas e 1 pet"
const quem = (h: number, pets?: number | null) => `${h} ${h === 1 ? 'pessoa' : 'pessoas'}${pets ? ` e ${pets} ${pets === 1 ? 'pet' : 'pets'}` : ''}`;

const PEDE_TUDO = 'Me conta a data de entrada, a de saída e quantas pessoas vão, que eu já vejo a disponibilidade e os valores.';
const PEDE_TUDO_DE_NOVO = 'Os valores mudam conforme a data e o número de pessoas, por isso preciso dessas informações 😊 Qual seria a data de entrada e a de saída? E quantas pessoas vão?';
const PEDE_ESCRITO = 'Recebi seu áudio, mas por aqui não consigo ouvir agora 🙏 Pode me escrever?';
const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const diaDm = (iso: string) => `${SEMANA[new Date(iso + 'T12:00:00Z').getUTCDay()]}, ${dm(iso)}`;
// "no sábado, 05/12" / "na terça, 17/11"
const noDia = (iso: string) => `${new Date(iso + 'T12:00:00Z').getUTCDay() % 6 === 0 ? 'no' : 'na'} ${diaDm(iso)}`;

// Pergunta natural só com o que falta (sem campos a preencher: tudo vem do que o cliente já disse)
function pergunta(f: Falta, p: Pedido): string {
  const extra = f.pessoas ? ' E quantas pessoas vão se hospedar?' : '';
  if (f.datas) {
    if (f.pessoas) return PEDE_TUDO;
    return `Anotado, ${p.hospedes} ${p.hospedes === 1 ? 'pessoa' : 'pessoas'}! Agora me conta a data de entrada e a de saída, que eu já vejo os valores.`;
  }
  const fim = fimDe(p);
  if (f.confirmar) {
    return fim
      ? `Só para eu consultar certinho: seria de ${diaDm(p.checkin!)}, a ${diaDm(fim)}?${extra}`
      : `Só para eu consultar certinho: a entrada seria ${noDia(p.checkin!)}? E até que dia vocês ficariam?${extra}`;
  }
  if (f.saida) return `Anotei a entrada ${noDia(p.checkin!)}. Até que dia vocês ficam (ou quantas noites)?${extra}`;
  return `Perfeito, de ${dm(p.checkin!)} a ${dm(fim!)}. E quantas pessoas vão se hospedar?`;
}

// ---------- IA: escreve a resposta de disponibilidade e valores ----------
const RedacaoSchema = z.object({ texto: z.string() });
const moeda = (v: number) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });

// O que a consulta ao Airbnb devolveu, em texto, com os valores no mesmo formato que a IA deve copiar
function fatosCotacao(cot: any) {
  const p = (n: number, s: string, pl: string) => `${n} ${n === 1 ? s : pl}`;
  const alt = (a: any) => a ? ` Alternativa livre: de ${dm(a.checkin)} a ${dm(a.checkout)}, total ${moeda(a.total)}${a.diaria ? ` (${moeda(a.diaria)} por noite)` : ''}.` : '';
  const linhas = (cot.casas || []).map((c: any) => {
    if (c.status === 'livre') return `- ${c.nome}: LIVRE. Total ${moeda(c.total)}${c.diaria ? ` (${moeda(c.diaria)} por noite)` : ''}.`;
    if (c.status === 'nao_aceita_pet') return `- ${c.nome}: NÃO ACEITA PETS (sem pet estaria livre).`;
    if (c.status === 'capacidade') return `- ${c.nome}: NÃO COMPORTA ${p(cot.adultos, 'hóspede', 'hóspedes')}.`;
    if (c.status === 'min_noites') return `- ${c.nome}: nessa data pede no mínimo ${c.min_noites} noites.${alt(c.alternativa)}`;
    if (c.status === 'erro') return `- ${c.nome}: não foi possível consultar agora (não fale dela).`;
    return `- ${c.nome}: OCUPADA nessas datas.${alt(c.alternativa)}`;
  });
  const ant = antecedencia(cot.checkin);
  const entrada = ant === 0 ? `Entrada: HOJE (${diaDm(cot.checkin)}).` : ant === 1 ? `Entrada: amanhã (${diaDm(cot.checkin)}).` : `Entrada em ${ant} dias (${diaDm(cot.checkin)}).`;
  return [`Período consultado: ${dm(cot.checkin)} a ${dm(cot.checkout)} (${p(cot.noites, 'noite', 'noites')}), ${p(cot.adultos, 'hóspede', 'hóspedes')}${cot.pets ? ` e ${p(cot.pets, 'pet', 'pets')} (valores já com a taxa de pet)` : ''}.`, entrada, ...linhas].join('\n');
}

// Todo "R$ ..." do texto precisa ser um valor da consulta; e, havendo casa livre ou alternativa, ao menos um valor precisa aparecer
function valoresConferem(texto: string, cot: any) {
  const ok = new Set<number>();
  for (const c of cot.casas || []) for (const v of [c.total, c.diaria, c.alternativa?.total, c.alternativa?.diaria]) if (v != null) ok.add(Math.round(+v * 100));
  const achados = [...texto.matchAll(/R\$\s*([\d.]+(?:,\d{1,2})?)/g)].map(m => Math.round(+m[1].replace(/\./g, '').replace(',', '.') * 100));
  if (achados.some(v => !ok.has(v))) return false;
  return ok.size === 0 || achados.length > 0;
}

// O robô não segura data: "deixo separada", "seguro pra você", "fica garantida", "já está reservada"
const PROMESSA = /separad[ao]s?\b|\bsegur(o|ar|amos)\b.{0,20}(casa|data|pra|para)|bloque(io|ar|ada|amos)|garant(o|ir|ida|imos)\b|j[aá] (est[aá] |fica )?reservad/i;

async function redigir(historico: any[], cot: any, base: string, aviso: string, nomePerfil?: string | null) {
  const primeiro = primeiroNome(nomePerfil);
  const emAndamento = conversando(historico);
  const ant = antecedencia(cot.checkin);
  const fim = ant === 0
    ? '- A entrada é HOJE: não pergunte se quer reservar e não fale de pagamento (o sistema acrescenta o próximo passo).'
    : `- Termine com o próximo passo, perguntando se quer reservar a casa livre${ant < PRAZO_INTEGRAL
      ? ` (se falar de pagamento, diga só que, como faltam menos de ${PRAZO_INTEGRAL} dias para a entrada, o pagamento é integral na reserva; nada de sinal nem de prazo para o restante)`
      : base.includes('Como funciona o pagamento') ? ' (pode dizer, em uma frase, como funciona o pagamento, conforme as informações)' : ''}.`;
  const system = `Você responde, pelo WhatsApp, os clientes das casas de temporada do Claudio no Condomínio Pipa Natureza (Pipa/RN). Escreva a resposta para a ÚLTIMA mensagem do cliente.
Tom: português do Brasil, cordial e direto, como uma pessoa da equipe conversando no WhatsApp (não um robô nem um e-mail): frases curtas e naturais, no máximo 1 emoji, até 8 linhas. Acompanhe o jeito do cliente: se ele escreve informal, seja informal. Nada de "Prezado", "Informamos que", "Segue abaixo" ou de repetir a pergunta dele. Quebras de linha só para separar casas.
O cliente pode ter mandado várias mensagens seguidas desde a última resposta: responda a todas juntas, numa mensagem só.
${emAndamento ? 'A conversa já está em andamento: NÃO cumprimente e NÃO comece com "Olá" ou "Oi".' : `É o começo da conversa: comece com "${periodo()}${primeiro ? `, ${primeiro}` : ''}!" (é ${periodo().toLowerCase()} em Pipa agora).`}
Regras:
- Disponibilidade, datas e valores: use SOMENTE a consulta abaixo e copie os valores exatamente como estão escritos (ex.: "R$ 1.450"). Nunca invente valor, desconto, taxa, data ou disponibilidade, e não faça contas.
- Se o cliente pediu uma casa específica, responda sobre ela primeiro. Cite as outras só se a pedida não estiver livre, como alternativa.
- Se nenhuma casa estiver livre, ofereça as alternativas de data que a consulta trouxer; se não houver, peça outras datas.
- Se a mensagem do cliente também perguntar algo que as informações das casas respondem (pets, horários, capacidade, comodidades), responda junto. Se perguntar algo que não está nelas, diga que o Claudio confirma em seguida.
- Nunca confirme reserva, não peça dados pessoais e não fale de Pix.
- O texto vai direto para o cliente: nunca escreva campos para preencher (colchetes, chaves, "XX", "nome do cliente", "data"). Se não souber o nome, escreva sem nome.
- Fale de pets só se o cliente falou de pet ou se a consulta foi feita com pet.
- Você não segura, separa nem bloqueia datas: nunca ofereça "deixar separada", "segurar" ou "garantir" a casa; a data só fica reservada com o pagamento.
- Quando a entrada for hoje ou amanhã, diga "hoje" ou "amanhã" junto com a data.
${fim}${aviso ? `\n- Diga também, com suas palavras: "${aviso}"` : ''}

<consulta_airbnb>
${fatosCotacao(cot)}
</consulta_airbnb>
<informacoes_das_casas>
${base || '(nada cadastrado)'}
</informacoes_das_casas>`;
  const conversa = historico.map(m => `${m.autor === 'cliente' ? 'Cliente' : m.autor === 'robo' ? 'Atendimento' : 'Claudio'}: ${m.texto}`).join('\n');
  const r = await new Anthropic().messages.parse({
    model: 'claude-haiku-5-5',
    max_tokens: 1500,
    output_config: { effort: 'low', format: zodOutputFormat(RedacaoSchema) },
    system,
    messages: [{ role: 'user', content: `<conversa>\n${conversa}\n</conversa>` }],
  });
  const texto = r.parsed_output?.texto?.trim();
  if (!texto) return null;
  if (PROMESSA.test(texto)) { console.warn('redigir: ofereceu segurar a casa; vai a mensagem padrão'); return null; }
  if (!valoresConferem(texto, cot)) { console.warn('redigir: valor que não está na consulta; vai a mensagem padrão'); return null; }
  return texto;
}

async function cotar(checkin: string, checkout: string, adultos: number, pets?: number | null) {
  try {
    const r = await fetch(`${SB_URL}/functions/v1/airbnb-quote`, {
      method: 'POST', headers: { Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkin, checkout, adultos, ...(pets ? { pets } : {}) }), signal: AbortSignal.timeout(40000),
    });
    return await r.json();
  } catch (e) { console.error('airbnb-quote', e); return null; }
}

// ---------- envio: Z-API (se configurada) ou WhatsApp Cloud API ----------
// "digitando..." do tamanho do texto, como uma pessoa: 2 s numa frase curta, até 8 s numa resposta longa
const tempoDigitando = (t: string) => Math.min(8, Math.max(2, Math.round(t.length / 40)));

async function enviar(to: string, body: string, phoneIdWebhook?: string) {
  if (Deno.env.get('ZAPI_INSTANCE')) return enviarZapi(to, body, { digitando: tempoDigitando(body) });
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
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
function telefoneBonito(wa: string) {
  const m = wa.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : '+' + wa;
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
