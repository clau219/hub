import Anthropic from 'npm:@anthropic-ai/sdk@0.134.0';
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@0.134.0/helpers/zod';
import { z } from 'npm:zod@4.6.7';

// Canal do dono: o Claudio manda mensagem do número pessoal (wa_settings.dono_wa) para o WhatsApp das casas e o
// Hub trata como comando, não como cliente. A IA (Claude Haiku) transforma a frase em UMA ação de uma lista fechada;
// a ação roda no banco e volta um recibo. "desfaz" ou "o valor é 3800" corrigem a última ação em até 24 h
// (dono_acoes guarda o antes e o depois). Consultas (hoje, quem me deve, casa livre) só leem.
// Também monta o resumo do dia que a função wa-dono manda às 7h30 e às 18h, e os lembretes com hora.
// Áudio: transcrito (GROQ_API_KEY, ou OPENAI_API_KEY) e tratado como texto.
// Foto/PDF: a IA lê o comprovante, boleto ou nota e PROPÕE o registro (wa_settings.dono_pendente); só grava com o "sim".

type SB = any;
type Enviar = (to: string, texto: string) => Promise<{ wamid: string } | null>;
type Midia = { url?: string; mime: string; base64?: string };
export type MsgDono = { wa_id: string; wamid: string; tipo: string; texto: string | null; ts: Date; midia?: Midia | null };

const NEGOCIO_NOME: Record<string, string> = { dj: 'DJ', aluguel: 'Aluguéis', consultoria: 'Engenharia', argila: 'Argila Lab' };
const AREA_NOME: Record<string, string> = { inbox: 'Caixa de entrada', dj: 'DJ', alugueis: 'Aluguéis', consultoria: 'Engenharia', argila: 'Argila Lab', casa: 'Casa', pessoal: 'Pessoal' };
// Mesmas sugestões de próxima ação do Pipeline (util.FLUXOS): nada fica aberto sem próximo passo
const PROXIMA: Record<string, Record<string, [string, number]>> = {
  dj: { lead: ['Enviar orçamento', 1], orcamento: ['Follow-up do orçamento', 3], fechado: ['Confirmar detalhes do evento', 7] },
  aluguel: { lead: ['Enviar valor e disponibilidade', 1], orcamento: ['Follow-up do orçamento', 1], fechado: ['Receber o saldo', 7] },
  servico: { lead: ['Enviar proposta', 1], orcamento: ['Follow-up da proposta', 3], fechado: ['Atualizar o cliente', 7] },
};
const ETAPA_NOME: Record<string, string> = { lead: 'Contato', orcamento: 'Orçamento enviado', negociacao: 'Negociando', fechado: 'Fechado', realizado: 'Realizado', pago: 'Pago' };
const ABERTAS = ['lead', 'orcamento', 'negociacao', 'fechado', 'realizado'];
const CATS_SAI = ['Moradia', 'Contas da casa', 'Mercado', 'Alimentação fora', 'Transporte', 'Combustível', 'Saúde', 'Educação', 'Lazer',
  'Compras', 'Assinaturas', 'Impostos', 'Tarifas bancárias', 'Faxina e limpeza', 'Condomínio', 'Manutenção', 'Equipamento', 'Outros'];
const AJUDA = 'Pode me pedir assim (por texto ou áudio):\n• +dj Anabela 15/11 3500\n• recebi 1750 da Anabela no pix\n• gastei 120 de faxina na Frida\n• me lembra de ligar pro contador amanhã às 10h\n• o que tenho hoje? / quem me deve?\n• a Terracota tá livre de 20 a 23/11 pra 4?\n• foto ou PDF de comprovante ou boleto\nDepois de cada registro: "desfaz" ou "o valor é 3800".';

// ---------- quem é o dono ----------
const fim8 = (s: string) => String(s || '').replace(/\D/g, '').slice(-8);
export async function donoWa(sb: SB): Promise<string | null> {
  const { data } = await sb.from('wa_settings').select('dono_wa').eq('id', 1).maybeSingle();
  const n = String(data?.dono_wa || '').replace(/\D/g, '');
  return n.length >= 10 ? n : null;
}
// Compara os 8 últimos dígitos (o WhatsApp às vezes omite o 9)
export async function ehDono(sb: SB, wa_id: string) {
  const d = await donoWa(sb);
  return !!d && /^\d{10,15}$/.test(wa_id) && fim8(wa_id) === fim8(d);
}

// ---------- mensagem do dono ----------
export async function processarDono(sb: SB, m: MsgDono, { teste = false, enviar }: { teste?: boolean; enviar: Enviar }) {
  const { data: dup } = await sb.from('dono_msgs').select('id').eq('wamid', m.wamid).maybeSingle();
  if (dup) return { ignorado: 'mensagem repetida' };
  const historico = await historicoDono(sb);
  await sb.from('dono_msgs').insert({ wamid: m.wamid, direcao: 'in', texto: m.texto, criado_em: m.ts.toISOString() });

  let r: { texto: string; acao: string; [k: string]: unknown } | null = null;
  let texto = m.tipo === 'text' ? m.texto?.trim() || '' : '';
  let ouvido = '';
  if (m.tipo === 'audio') {
    try { texto = ouvido = m.midia ? await transcrever(m.midia) : ''; }
    catch (err) {
      console.error('dono áudio', err);
      const semChave = (err as Error).message === 'sem chave';
      r = { acao: 'erro', texto: semChave ? 'Áudio ainda não está ligado (falta a chave de transcrição no Supabase). Me escreve 🙏' : `Não consegui entender o áudio (${String((err as Error).message).slice(0, 120)}). Me escreve 🙏` };
    }
    if (!r && !texto) r = { acao: 'erro', texto: 'O áudio veio sem fala que eu entendesse. Me escreve 🙏' };
  }
  if (r) { /* erro do áudio já respondido */ }
  else if (['image', 'document'].includes(m.tipo) && m.midia) r = await lerDocumento(sb, m);
  else if (!texto) r = { acao: 'midia', texto: 'Esse tipo de mensagem eu não leio. Manda texto, áudio, foto ou PDF.' };
  else {
    let x: Comando;
    let falha = '';
    const pend = await pendente(sb);
    try { x = await entender(sb, historico, texto, pend); }
    catch (err) { console.error('dono IA', err); x = null as any; falha = String((err as Error)?.message || err).slice(0, 160); }
    if (!x) r = { acao: 'erro', texto: `Não consegui falar com a IA agora. Tenta de novo daqui a pouco, ou registra pelo Hub.${falha ? `\n(${falha})` : ''}` };
    else if (x.acao === 'confirmar') {
      r = pend ? await executar(sb, mesclar(pend.comando, x)) : { acao: 'conversa', texto: 'Não tem nada esperando confirmação.' };
      if (pend) await limparPendente(sb);
    } else if (x.acao === 'cancelar') {
      r = { acao: 'cancelar', texto: pend ? 'Ok, descartei.' : 'Não tem nada para cancelar.' };
      if (pend) await limparPendente(sb);
    } else {
      r = await executar(sb, x);
      // Pediu outra coisa: a proposta do comprovante/boleto não fica esperando um "sim" solto mais tarde
      if (pend) await limparPendente(sb);
    }
  }
  if (ouvido) r = { ...r!, texto: `🎙️ _"${ouvido.slice(0, 300)}"_\n\n${r.texto}` };
  const enviado = teste ? { wamid: `teste-dono-${crypto.randomUUID()}` } : await enviar(m.wa_id, r.texto);
  if (enviado) await sb.from('dono_msgs').insert({ wamid: enviado.wamid, direcao: 'out', texto: r.texto });
  return { dono: true, ...r, enviado: !!enviado };
}

async function historicoDono(sb: SB) {
  const { data } = await sb.from('dono_msgs').select('direcao,texto,criado_em').gte('criado_em', new Date(Date.now() - 864e5).toISOString())
    .order('criado_em', { ascending: false }).limit(8);
  return (data || []).reverse().filter((x: any) => x.texto);
}

// ---------- IA: a frase vira um comando ----------
// Sem campos nullable: a API de saída estruturada aceita no máximo 16 campos com tipo união (nullable conta), e
// com mais ela recusa a chamada. A IA usa "" / 0 / "nenhum" para "não disse" e normalizar() devolve null.
const ACOES = ['criar_oportunidade', 'a_receber', 'registrar_pagamento', 'lancar_gasto', 'criar_tarefa', 'concluir_tarefa', 'adiar', 'consultar', 'desfazer', 'corrigir',
  'confirmar', 'cancelar', 'conversa'] as const;
const ComandoSchema = z.object({
  acao: z.enum(ACOES),
  negocio: z.enum(['nenhum', 'dj', 'aluguel', 'consultoria', 'argila']),
  cliente: z.string(),
  valor: z.number(),
  recebido: z.number(),
  data: z.string(),
  hora: z.string(),
  local: z.string(),
  titulo: z.string(),
  etapa: z.enum(['nenhum', 'lead', 'orcamento', 'fechado']),
  forma: z.enum(['nenhum', 'Pix', 'Dinheiro', 'Transferência', 'Cartão']),
  categoria: z.string(),
  casa: z.enum(['nenhum', 'QS39', 'QS40', 'QS50']),
  area: z.enum(['nenhum', 'inbox', 'dj', 'alugueis', 'consultoria', 'argila', 'casa', 'pessoal']),
  prioridade: z.number().int(),
  consulta: z.enum(['nenhum', 'hoje', 'amanha', 'semana', 'quem_deve', 'pendencias', 'casas_livres']),
  checkin: z.string(),
  checkout: z.string(),
  pessoas: z.number().int(),
  resposta: z.string(),
});
type Bruto = z.infer<typeof ComandoSchema>;
export type Comando = { acao: Bruto['acao']; negocio: 'dj' | 'aluguel' | 'consultoria' | 'argila' | null; cliente: string | null; valor: number | null;
  recebido: number | null; data: string | null; hora: string | null; local: string | null; titulo: string | null; etapa: 'lead' | 'orcamento' | 'fechado' | null;
  forma: 'Pix' | 'Dinheiro' | 'Transferência' | 'Cartão' | null; categoria: string | null; casa: 'QS39' | 'QS40' | 'QS50' | null;
  area: 'inbox' | 'dj' | 'alugueis' | 'consultoria' | 'argila' | 'casa' | 'pessoal' | null; prioridade: number | null;
  consulta: 'hoje' | 'amanha' | 'semana' | 'quem_deve' | 'pendencias' | 'casas_livres' | null; checkin: string | null; checkout: string | null;
  pessoas: number | null; resposta: string | null };
// "" / "nenhum" / 0 (ou negativo) → null
export const normalizar = (b: Record<string, unknown>): Comando => Object.fromEntries(Object.entries(b).map(([k, v]) =>
  [k, k === 'acao' ? v : v === '' || v === 'nenhum' || (typeof v === 'number' && !(v > 0)) || v == null ? null : typeof v === 'string' ? v.trim() || null : v])) as Comando;

async function entender(sb: SB, historico: any[], texto: string, pend: Pendente | null = null): Promise<Comando> {
  const d = hoje();
  const dia = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date());
  const ultima = await ultimaAcao(sb);
  const lembrete = await ultimoLembrete(sb);
  const system = `Você é o assistente do Claudio dentro do Hub, o sistema pessoal dele. Ele é DJ (DJ CLAU), engenheiro, tem a Argila Lab (ferramentas para cerâmica) e aluga 3 casas em Pipa/RN (QS39 = Casa Frida, QS40 = Casa Azul, QS50 = Casa Terracota). Ele escreve pelo WhatsApp, do jeito que fala. Transforme a ÚLTIMA mensagem dele em UMA ação. Hoje é ${dia}, ${d}, agora são ${agoraHHMM()} (fuso de Brasília).

Ações:
- criar_oportunidade: novo negócio/cliente/evento para o Pipeline ("+dj Anabela 15/11 3500", "orçamento de engenharia pro Marcos", "fechei o casamento da Júlia dia 20/12 por 4 mil"). negocio: dj (padrão quando não diz), aluguel, consultoria (engenharia/obra), argila. cliente: o nome da pessoa. data: data do evento. valor: valor total. recebido: quanto ele JÁ recebeu (só se disser que recebeu/pagou sinal; "sinal de 50%" sem dizer que recebeu NÃO é recebido). etapa: "fechado" se diz que fechou/confirmou, "orcamento" se diz que já mandou orçamento, senão "lead". local, hora (HH:MM) se disser. titulo: detalhes que sobrarem (tipo de evento etc.), curto.
- a_receber: alguém deve dinheiro a ele, sem dizer que pagou ("tenho a receber 1300 do Nami", "o Nami me deve 1300", "falta o Marcos me pagar 800"). cliente, valor, negocio se der para saber, data do evento/serviço se disser, titulo com o que foi (se disser).
- registrar_pagamento: recebeu dinheiro de um cliente ("recebi 1750 da Anabela no pix", "a Júlia pagou o saldo"). cliente, valor (nulo se disse "o saldo"/"o resto"), forma, data (só se não for hoje).
- lancar_gasto: ele gastou/pagou algo ("gastei 120 de faxina na Frida", "paguei 300 de gás", "uber 25"). valor positivo, titulo = descrição curta, categoria (uma de: ${CATS_SAI.join(', ')}), casa se for de uma casa, negocio: aluguel se for das casas, dj se for do DJ (equipamento, transporte de gig), consultoria, argila; nulo se pessoal. data só se não for hoje.
- criar_tarefa: algo a fazer ou lembrete ("me lembra de ligar pro contador amanhã", "comprar cabo XLR", "me lembra às 15h de pagar o boleto", "daqui 2 horas me lembra do forno"). titulo curto no infinitivo (sem a hora), data = prazo (nulo se não disser), hora = horário do aviso no WhatsApp (HH:MM) quando ele diz um horário ou um tempo relativo (calcule data e hora a partir de agora; "de manhã" = 09:00, "à tarde" = 14:00, "à noite" = 19:00), nulo se não falar de horário, area (dj, alugueis, consultoria, argila, casa, pessoal, ou inbox se não der para saber), prioridade 1 se disser urgente/importante, senão 2.
- concluir_tarefa: diz que fez algo ("liguei pro contador", "feito: comprar cabo"). titulo = o que fez. Só "feito", "pronto", "já fiz" (resposta a um lembrete): titulo vazio.
- adiar: quer o lembrete de novo mais tarde ("adia 1h", "me lembra de novo amanhã às 9", "depois"). data e hora do NOVO aviso, calculadas a partir de agora ("adia 1h" = agora + 1 hora; "depois" sem tempo = agora + 1 hora). titulo só se disser qual tarefa.
- consultar: pergunta sobre a agenda ou o negócio. consulta: hoje ("o que tenho hoje?"), amanha, semana, quem_deve (quem deve dinheiro, o que falta receber), pendencias (o que está atrasado/pendente), casas_livres (se as casas estão livres e quanto custa: checkin, checkout, pessoas; casa se citar uma).
- desfazer: quer desfazer/apagar o último registro ("desfaz", "apaga isso", "errei, cancela").
- corrigir: corrige o último registro ("o valor é 3800", "era dia 16", "foi no dinheiro", "é da Casa Azul"). Preencha SÓ os campos que mudam (valor, data, hora, forma, categoria, casa, titulo, local, cliente, etapa).
- confirmar: só quando há uma proposta esperando (abaixo) e ele concorda ("sim", "pode", "confirma", "isso", "ok"). Se junto corrigir algo ("sim, mas é da Casa Azul", "pode, foi 130", "é da Anabela"), preencha só esses campos.
- cancelar: só quando há uma proposta esperando e ele recusa ("não", "descarta", "deixa pra lá").
- conversa: cumprimento, agradecimento, pedido de ajuda ou algo que não se encaixa. resposta: frase curta e simpática; se ele pediu algo que você não sabe fazer, diga isso em uma frase.

Datas em AAAA-MM-DD; sem ano = próxima ocorrência a partir de hoje; "sexta" = a próxima sexta. Valores em reais como número ("3,5 mil" = 3500, "4k" = 4000). Nunca invente dado que ele não disse.
Campo que não se aplica ou que ele não disse: texto vazio "", número 0, ou "nenhum" nas listas ("nulo" acima quer dizer isso).
${pend ? `PROPOSTA ESPERANDO o "sim" dele (de um comprovante/boleto que ele mandou): ${pend.resumo}\n` : ''}${lembrete ? `Último lembrete enviado a ele, há ${Math.round((Date.now() - Date.parse(lembrete.lembrete_enviado_em)) / 60e3)} min: "${lembrete.titulo}" ("feito"/"adia" se referem a ele).\n` : ''}${ultima ? `Último registro feito por você (é o que "desfaz"/"corrigir" alteram), há ${Math.round((Date.now() - Date.parse(ultima.criado_em)) / 60e3)} min: ${ultima.resumo}` : 'Nenhum registro nas últimas 24 h ("desfaz"/"corrigir" não têm o que alterar: use conversa).'}`;
  const conversa = historico.map(m => `${m.direcao === 'in' ? 'Claudio' : 'Hub'}: ${m.texto}`).join('\n');
  const r = await new Anthropic().messages.parse({
    model: 'claude-haiku-5-5',
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(ComandoSchema) },
    system,
    messages: [{ role: 'user', content: `${conversa ? `<conversa_recente>\n${conversa}\n</conversa_recente>\n` : ''}<mensagem>${texto}</mensagem>` }],
  });
  if (r.stop_reason === 'refusal' || !r.parsed_output) throw new Error(`sem comando (${r.stop_reason})`);
  return normalizar(r.parsed_output);
}

// ---------- execução ----------
export async function executar(sb: SB, x: Comando): Promise<{ acao: string; texto: string; [k: string]: unknown }> {
  const data = isoOk(x.data) ? x.data! : null;
  switch (x.acao) {
    case 'criar_oportunidade': return criarOportunidade(sb, x, data);
    case 'a_receber': return aReceberDe(sb, x, data);
    case 'registrar_pagamento': return registrarPagamento(sb, x, data);
    case 'lancar_gasto': return lancarGasto(sb, x, data);
    case 'criar_tarefa': return criarTarefa(sb, x, data);
    case 'concluir_tarefa': return concluirTarefa(sb, x);
    case 'adiar': return adiar(sb, x, data);
    case 'consultar': return { acao: 'consultar', texto: await consultar(sb, x) };
    case 'desfazer': return desfazer(sb);
    case 'corrigir': return corrigir(sb, x, data);
    default: return { acao: 'conversa', texto: x.resposta?.trim() ? `${x.resposta.trim()}\n\n${AJUDA}` : AJUDA };
  }
}

const RODAPE = '\n_"desfaz" ou corrija ("o valor é ...")_';
const moeda = (v: number) => 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
const centavos = (v: number) => Math.round(v * 100) / 100;
const recebidoDe = (d: any) => centavos(((d.pagamentos as any[]) || []).reduce((s, p) => s + (+p.valor || 0), 0));
const saldoDe = (d: any) => Math.max(0, centavos((+d.valor || 0) - recebidoDe(d)));

async function registrar(sb: SB, acao: string, tabela: string, id: string, antes: any, depois: any, resumo: string, extra: any = null) {
  await sb.from('dono_acoes').insert({ acao, tabela, registro_id: String(id), antes, depois, resumo, extra, desfeita_em: null, criado_em: new Date().toISOString() });
}

async function criarOportunidade(sb: SB, x: Comando, data: string | null) {
  const nome = x.cliente?.trim();
  if (!nome) return { acao: 'pergunta', texto: 'Qual o nome do cliente?' };
  const negocio = x.negocio || 'dj';
  const { contato, criado } = await garantirContato(sb, nome, negocio === 'dj' ? 'contratante' : 'cliente');
  const etapa = x.etapa || 'lead';
  const [sug, dias] = (PROXIMA[negocio] || PROXIMA.servico)[etapa] || PROXIMA.dj.lead;
  const pagamentos = x.recebido && x.recebido > 0 ? [{ data: hoje(), valor: centavos(x.recebido), forma: x.forma || 'Pix', obs: 'pelo WhatsApp' }] : [];
  const row: Record<string, unknown> = {
    titulo: `${NEGOCIO_NOME[negocio]} — ${contato.nome}`, negocio, etapa, contato_id: contato.id,
    valor: x.valor && x.valor > 0 ? centavos(x.valor) : null, data_evento: data, hora_inicio: horaOk(x.hora), local: x.local?.trim() || null,
    notas: x.titulo?.trim() || null, pagamentos, proxima_acao: sug, data_proxima_acao: addDays(hoje(), dias),
  };
  const { data: d, error } = await sb.from('deals').insert(row).select('*').single();
  if (error || !d) return { acao: 'erro', texto: `Não consegui criar a oportunidade (${error?.message || 'erro no banco'}).` };
  const linhas = [`✅ Oportunidade criada: *${d.titulo}*`];
  if (data) linhas.push(`• Data: ${diaDm(data)}${row.hora_inicio ? `, ${String(row.hora_inicio).slice(0, 5)}` : ''}`);
  if (row.local) linhas.push(`• Local: ${row.local}`);
  if (row.valor) linhas.push(`• Valor: ${moeda(row.valor as number)}${pagamentos.length ? ` · recebido ${moeda(pagamentos[0].valor)}, falta ${moeda(saldoDe(d))}` : ''}`);
  linhas.push(`• Etapa: ${ETAPA_NOME[etapa]} · próxima ação: ${sug} (${relDia(row.data_proxima_acao as string)})`);
  if (criado) linhas.push(`• Contato novo: ${contato.nome}`);
  const resumo = linhas.join('\n');
  await registrar(sb, 'criar_oportunidade', 'deals', d.id, null, d, resumo, criado ? { contato_criado: contato.id } : null);
  if (negocio === 'dj' && etapa === 'fechado') await sincronizarAgenda(sb);
  return { acao: 'criar_oportunidade', texto: resumo + RODAPE, deal_id: d.id };
}

// "Tenho a receber 1300 do Nami": se há oportunidade aberta dele, completa o valor (ou mostra o saldo);
// se não há, cria uma já como Realizado, com a próxima ação "Cobrar pagamento"
async function aReceberDe(sb: SB, x: Comando, data: string | null) {
  const nome = x.cliente?.trim();
  if (!nome) return { acao: 'pergunta', texto: 'Quem te deve?' };
  if (!(x.valor && x.valor > 0)) return { acao: 'pergunta', texto: `Quanto ${nome} te deve?` };
  const achados = await dealsDoCliente(sb, nome);
  if (achados.length > 1) return { acao: 'pergunta', texto: `Achei ${achados.length} oportunidades de ${nome}:\n${achados.slice(0, 4).map(d => `• ${d.titulo}${d.data_evento ? ` (${dm(d.data_evento)})` : ''}${d.valor ? `, falta ${moeda(saldoDe(d))}` : ''}`).join('\n')}\nAbre no Hub e ajusta a certa.` };
  if (achados.length === 1) {
    const d = achados[0];
    if (d.valor) return { acao: 'a_receber', texto: `*${d.titulo}* já está no Hub: ${moeda(recebidoDe(d))} recebido de ${moeda(+d.valor)} · falta ${moeda(saldoDe(d))}.${Math.abs(saldoDe(d) - x.valor) >= 0.01 ? `\nSe o certo é faltar ${moeda(x.valor)}, ajusta o valor no Hub.` : ''}` };
    const patch = { valor: centavos(x.valor), updated_at: new Date().toISOString() };
    await sb.from('deals').update(patch).eq('id', d.id);
    const resumo = `💰 A receber: ${moeda(x.valor)} de *${d.titulo}*\n• Valor preenchido na oportunidade que já existia`;
    await registrar(sb, 'a_receber', 'deals', d.id, pick(d, Object.keys(patch)), patch, resumo);
    return { acao: 'a_receber', texto: resumo + RODAPE, deal_id: d.id };
  }
  const negocio = x.negocio || 'dj';
  const { contato, criado } = await garantirContato(sb, nome, negocio === 'dj' ? 'contratante' : 'cliente');
  const row = { titulo: `${NEGOCIO_NOME[negocio]} — ${contato.nome}`, negocio, etapa: 'realizado', contato_id: contato.id, valor: centavos(x.valor),
    data_evento: data, notas: x.titulo?.trim() || null, pagamentos: [], proxima_acao: 'Cobrar pagamento', data_proxima_acao: addDays(hoje(), 1) };
  const { data: d, error } = await sb.from('deals').insert(row).select('*').single();
  if (error || !d) return { acao: 'erro', texto: `Não consegui anotar (${error?.message || 'erro no banco'}).` };
  const resumo = [`💰 A receber: ${moeda(x.valor)} de *${d.titulo}*`, ...(data ? [`• Evento: ${diaDm(data)}`] : []),
    '• Etapa: Realizado · próxima ação: Cobrar pagamento (amanhã)', ...(criado ? [`• Contato novo: ${contato.nome}`] : [])].join('\n');
  // Registrada como criação: "o valor é ..." e "desfaz" funcionam igual
  await registrar(sb, 'criar_oportunidade', 'deals', d.id, null, d, resumo, criado ? { contato_criado: contato.id } : null);
  return { acao: 'a_receber', texto: resumo + RODAPE, deal_id: d.id };
}

async function registrarPagamento(sb: SB, x: Comando, data: string | null) {
  const nome = x.cliente?.trim();
  if (!nome) return { acao: 'pergunta', texto: 'Recebeu de quem?' };
  const achados = await dealsDoCliente(sb, nome);
  if (!achados.length) return { acao: 'pergunta', texto: `Não achei oportunidade aberta de "${nome}". Confere o nome? (ou cria com "+dj ${nome} ...")` };
  // Mais de uma: fica a que ainda tem saldo; empate, pergunta
  const comSaldo = achados.filter(d => saldoDe(d) > 0 || !d.valor);
  const cands = comSaldo.length ? comSaldo : achados;
  if (cands.length > 1) return { acao: 'pergunta', texto: `Achei ${cands.length} oportunidades de ${nome}:\n${cands.slice(0, 4).map(d => `• ${d.titulo}${d.data_evento ? ` (${dm(d.data_evento)})` : ''}${d.valor ? `, falta ${moeda(saldoDe(d))}` : ''}`).join('\n')}\nDiz qual (ex.: "o de ${cands[0].data_evento ? dm(cands[0].data_evento) : 'dezembro'}").` };
  const d = cands[0];
  const valor = x.valor && x.valor > 0 ? centavos(x.valor) : saldoDe(d);
  if (!(valor > 0)) return { acao: 'pergunta', texto: `Quanto você recebeu de ${nome}?` };
  const pagamentos = [...((d.pagamentos as any[]) || []), { data: data || hoje(), valor, forma: x.forma || 'Pix', obs: 'pelo WhatsApp' }]
    .sort((a, b) => String(a.data).localeCompare(String(b.data)));
  const patch: Record<string, unknown> = { pagamentos, updated_at: new Date().toISOString() };
  const novo = { ...d, pagamentos };
  // Como no Hub: realizado e quitado vira Pago
  if (d.etapa === 'realizado' && d.valor && saldoDe(novo) === 0) { patch.etapa = 'pago'; patch.proxima_acao = null; patch.data_proxima_acao = null; }
  await sb.from('deals').update(patch).eq('id', d.id);
  const falta = d.valor ? saldoDe(novo) : null;
  const resumo = [`💰 Recebido ${moeda(valor)} (${x.forma || 'Pix'}) de *${d.titulo}*${data && data !== hoje() ? ` em ${dm(data)}` : ''}`,
    d.valor ? `• ${moeda(recebidoDe(novo))} de ${moeda(+d.valor)} · ${falta ? `falta ${moeda(falta)}` : 'quitado ✅'}` : '• Oportunidade sem valor total: preencha no Hub para acompanhar o saldo',
    ...(patch.etapa === 'pago' ? ['• Etapa: Pago'] : [])].join('\n');
  await registrar(sb, 'registrar_pagamento', 'deals', d.id, pick(d, Object.keys(patch)), patch, resumo);
  return { acao: 'registrar_pagamento', texto: resumo + RODAPE, deal_id: d.id };
}

async function lancarGasto(sb: SB, x: Comando, data: string | null) {
  if (!(x.valor && x.valor > 0)) return { acao: 'pergunta', texto: 'Quanto foi?' };
  const categoria = CATS_SAI.includes(x.categoria || '') ? x.categoria : 'Outros';
  const negocio = x.casa ? 'alugueis' : x.negocio === 'aluguel' ? 'alugueis' : x.negocio || null;
  // Lançamento provisório: quando o mesmo valor chegar do banco (fin-sync), o do banco herda a categoria e este sai
  const row = { id: `wa-${crypto.randomUUID()}`, conta_id: null, data: data || hoje(), descricao: x.titulo?.trim() || categoria, valor: -centavos(x.valor),
    status: 'POSTED', categoria, negocio, casa: x.casa || null, manual: true, contraparte: null, atualizado_em: new Date().toISOString() };
  const { error } = await sb.from('fin_tx').insert(row);
  if (error) return { acao: 'erro', texto: `Não consegui lançar o gasto (${error.message}).` };
  const casaNome = x.casa ? await nomeCasa(sb, x.casa) : null;
  const resumo = `🧾 Gasto: ${moeda(x.valor)} · ${row.descricao}\n• ${categoria}${negocio ? ` · ${AREA_NOME[negocio] || negocio}` : ''}${casaNome ? ` (${casaNome})` : ''} · ${relDia(row.data)}\n• Quando o lançamento do banco chegar, ele fica no lugar deste`;
  await registrar(sb, 'lancar_gasto', 'fin_tx', row.id, null, row, resumo);
  return { acao: 'lancar_gasto', texto: resumo + RODAPE, fin_tx: row.id };
}

async function criarTarefa(sb: SB, x: Comando, data: string | null) {
  const titulo = x.titulo?.trim();
  if (!titulo) return { acao: 'pergunta', texto: 'Qual a tarefa?' };
  // Com hora: aviso no WhatsApp. Sem data, é hoje se o horário ainda não passou, senão amanhã
  const hora = horaOk(x.hora);
  const dia = hora ? data || (hora.slice(0, 5) > agoraHHMM() ? hoje() : addDays(hoje(), 1)) : data;
  const lembrete = hora ? momento(dia!, hora) : null;
  const passou = !!lembrete && Date.parse(lembrete) <= Date.now();
  const row = { titulo, area: x.area || 'inbox', prazo: dia, prioridade: x.prioridade === 1 ? 1 : 2, feito: false,
    lembrete_em: passou ? null : lembrete, lembrete_enviado_em: null };
  const { data: t, error } = await sb.from('tasks').insert(row).select('*').single();
  if (error || !t) return { acao: 'erro', texto: `Não consegui criar a tarefa (${error?.message || 'erro no banco'}).` };
  const aviso = passou ? ' · ⚠️ esse horário já passou, não vou avisar' : lembrete ? ` · ⏰ aviso às ${hora!.slice(0, 5)} aqui` : '';
  const resumo = `📝 Tarefa: ${t.titulo}\n• ${dia ? relDia(dia) : 'sem prazo'}${aviso} · ${AREA_NOME[t.area] || t.area}${t.prioridade === 1 ? ' · prioridade alta' : ''}`;
  await registrar(sb, 'criar_tarefa', 'tasks', t.id, null, t, resumo);
  return { acao: 'criar_tarefa', texto: resumo + RODAPE, task_id: t.id };
}

async function concluirTarefa(sb: SB, x: Comando) {
  const alvo = palavras(x.titulo || '');
  if (!alvo.length) {
    // "feito" logo depois de um lembrete
    const l = await ultimoLembrete(sb);
    if (!l || l.feito) return { acao: 'pergunta', texto: 'Qual tarefa você concluiu?' };
    return concluir(sb, l);
  }
  const { data: ts } = await sb.from('tasks').select('*').eq('feito', false);
  const pontos = (ts || []).map((t: any) => ({ t, n: palavras(t.titulo).filter(w => alvo.some(a => mesmaPalavra(a, w))).length })).filter((p: any) => p.n > 0)
    .sort((a: any, b: any) => b.n - a.n);
  if (!pontos.length) return { acao: 'pergunta', texto: `Não achei tarefa aberta parecida com "${x.titulo}".` };
  if (pontos.length > 1 && pontos[1].n === pontos[0].n) return { acao: 'pergunta', texto: `Qual delas?\n${pontos.filter((p: any) => p.n === pontos[0].n).slice(0, 4).map((p: any) => `• ${p.t.titulo}`).join('\n')}` };
  return concluir(sb, pontos[0].t);
}

async function concluir(sb: SB, t: any) {
  const patch = { feito: true, feito_em: new Date().toISOString() };
  await sb.from('tasks').update(patch).eq('id', t.id);
  const resumo = `☑️ Concluída: ${t.titulo}`;
  await registrar(sb, 'concluir_tarefa', 'tasks', t.id, pick(t, Object.keys(patch)), patch, resumo);
  return { acao: 'concluir_tarefa', texto: resumo + RODAPE, task_id: t.id };
}

// "adia 1h" / "me lembra de novo amanhã às 9": o último lembrete enviado (ou a tarefa citada) ganha novo aviso
async function adiar(sb: SB, x: Comando, data: string | null) {
  let t: any = null;
  const alvo = palavras(x.titulo || '');
  if (alvo.length) {
    const { data: ts } = await sb.from('tasks').select('*').eq('feito', false);
    t = (ts || []).map((t: any) => ({ t, n: palavras(t.titulo).filter(w => alvo.some(a => mesmaPalavra(a, w))).length })).filter((p: any) => p.n > 0)
      .sort((a: any, b: any) => b.n - a.n)[0]?.t;
  } else t = await ultimoLembrete(sb);
  if (!t) return { acao: 'pergunta', texto: 'Adiar qual lembrete?' };
  const hora = horaOk(x.hora);
  if (!hora) return { acao: 'pergunta', texto: `Para quando eu adio "${t.titulo}"?` };
  const dia = data || (hora.slice(0, 5) > agoraHHMM() ? hoje() : addDays(hoje(), 1));
  const quando = momento(dia, hora);
  if (Date.parse(quando) <= Date.now()) return { acao: 'pergunta', texto: 'Esse horário já passou. Para quando?' };
  const patch: Record<string, unknown> = { lembrete_em: quando, lembrete_enviado_em: null, feito: false, feito_em: null };
  if (!t.prazo || t.prazo < dia) patch.prazo = dia;
  await sb.from('tasks').update(patch).eq('id', t.id);
  const resumo = `⏰ Adiado: ${t.titulo} → ${relDia(dia)} às ${hora.slice(0, 5)}`;
  await registrar(sb, 'adiar', 'tasks', t.id, pick(t, Object.keys(patch)), patch, resumo);
  return { acao: 'adiar', texto: resumo, task_id: t.id };
}

async function ultimoLembrete(sb: SB) {
  const { data } = await sb.from('tasks').select('*').gte('lembrete_enviado_em', new Date(Date.now() - 864e5).toISOString())
    .order('lembrete_enviado_em', { ascending: false }).limit(1);
  return data?.[0] || null;
}

// Lembretes vencidos (wa-dono, cron a cada minuto). Os de mais de 6 h atrás não saem: chegariam fora de hora.
export async function enviarLembretes(sb: SB, enviar: Enviar) {
  const para = await donoWa(sb);
  if (!para) return { enviados: 0, motivo: 'número do dono não cadastrado' };
  const agora = new Date().toISOString();
  const { data: ts } = await sb.from('tasks').select('*').eq('feito', false).is('lembrete_enviado_em', null)
    .lte('lembrete_em', agora).gte('lembrete_em', new Date(Date.now() - 6 * 3600e3).toISOString()).order('lembrete_em');
  let enviados = 0;
  for (const t of ts || []) {
    // Marca antes de enviar: duas rodadas do cron ao mesmo tempo não mandam duas vezes
    await sb.from('tasks').update({ lembrete_enviado_em: agora }).eq('id', t.id);
    const texto = `⏰ *Lembrete:* ${t.titulo}${t.notas ? `\n${t.notas}` : ''}\n_"feito" ou "adia 1h"_`;
    const r = await enviar(para, texto);
    if (!r) { await sb.from('tasks').update({ lembrete_enviado_em: null }).eq('id', t.id); continue; }
    await sb.from('dono_msgs').insert({ wamid: r.wamid, direcao: 'out', texto });
    enviados++;
  }
  return { enviados };
}

// ---------- foto/PDF: comprovante, boleto ou nota ----------
type Pendente = { comando: Comando; resumo: string; em: string };
async function pendente(sb: SB): Promise<Pendente | null> {
  const { data } = await sb.from('wa_settings').select('dono_pendente').eq('id', 1).maybeSingle();
  const p = data?.dono_pendente;
  return p?.comando && Date.now() - Date.parse(p.em) < 864e5 ? p : null;
}
const limparPendente = (sb: SB) => sb.from('wa_settings').update({ dono_pendente: null }).eq('id', 1);
// A proposta com o que ele corrigiu junto do "sim"
const mesclar = (base: Comando, x: Comando): Comando => ({ ...base, ...Object.fromEntries(Object.entries(x).filter(([k, v]) => v != null && !['acao', 'resposta', 'consulta'].includes(k))) });

const DocSchema = z.object({
  tipo: z.enum(['comprovante', 'boleto', 'nota_fiscal', 'outro']),
  valor: z.number(),
  data: z.string(),
  vencimento: z.string(),
  recebedor: z.string(),
  pagador: z.string(),
  descricao: z.string(),
  categoria: z.string(),
  casa: z.enum(['nenhum', 'QS39', 'QS40', 'QS50']),
  negocio: z.enum(['nenhum', 'dj', 'aluguel', 'consultoria', 'argila']),
});

async function lerDocumento(sb: SB, m: MsgDono) {
  const legenda = String(m.texto || '').replace(/^\[\w+\]\s*/, '').replace(/\.(pdf|jpe?g|png)$/i, '').trim();
  let l: z.infer<typeof DocSchema>;
  try {
    const arq = await baixar(m.midia!);
    const b64 = base64(arq.bytes);
    const bloco = arq.mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: /^image\/(jpeg|png|gif|webp)$/.test(arq.mime) ? arq.mime : 'image/jpeg', data: b64 } };
    const r = await new Anthropic().messages.parse({
      model: 'claude-haiku-5-5',
      max_tokens: 2000,
      output_config: { effort: 'low', format: zodOutputFormat(DocSchema) },
      system: `Você lê documentos financeiros brasileiros que o Claudio Roberto Sousa Braga (DJ, engenheiro, dono de 3 casas de aluguel em Pipa: QS39 Casa Frida, QS40 Casa Azul, QS50 Casa Terracota) manda para registrar. Hoje é ${hoje()}. Transcreva só o que está legível; o que não estiver: "" ou 0 ou "nenhum".
tipo: comprovante (de Pix, transferência ou pagamento já feito), boleto (a pagar, com código de barras/linha digitável), nota_fiscal (nota ou cupom de compra), outro.
valor: em reais (número). data: data do pagamento/emissão (AAAA-MM-DD). vencimento: do boleto (AAAA-MM-DD). recebedor: quem recebeu/beneficiário. pagador: quem pagou.
descricao: o que é, curto ("Conta de luz Cosern", "Faxina", "Pix para Maria Silva"). categoria (para despesa): uma de ${CATS_SAI.join(', ')}.
casa e negocio: só se o documento ou a legenda deixarem claro (negocio aluguel = casas, dj = equipamento/eventos).`,
      messages: [{ role: 'user', content: [bloco as any, { type: 'text', text: legenda ? `Legenda que ele escreveu: "${legenda}"` : 'Sem legenda.' }] }],
    });
    if (r.stop_reason === 'refusal' || !r.parsed_output) throw new Error(`sem leitura (${r.stop_reason})`);
    l = r.parsed_output;
  } catch (err) {
    console.error('dono documento', err);
    return { acao: 'erro', texto: `Não consegui ler o arquivo (${String((err as Error).message).slice(0, 120)}). Me manda por texto 🙏` };
  }
  const valor = l.valor > 0 ? centavos(l.valor) : null;
  if (l.tipo === 'outro' || !valor) return { acao: 'documento', texto: 'Não reconheci comprovante, boleto ou nota com valor nesse arquivo. Me diz por texto o que registrar.' };
  const casa = l.casa === 'nenhum' ? null : l.casa;
  const negocio = l.negocio === 'nenhum' ? (casa ? 'aluguel' : null) : l.negocio;
  const data = isoOk(l.data) && l.data <= hoje() ? l.data : null;
  const base: Comando = normalizar({ acao: 'conversa', negocio: 'nenhum', cliente: '', valor: 0, recebido: 0, data: '', hora: '', local: '', titulo: '', etapa: 'nenhum', forma: 'nenhum',
    categoria: '', casa: 'nenhum', area: 'nenhum', prioridade: 0, consulta: 'nenhum', checkin: '', checkout: '', pessoas: 0, resposta: '' });
  let comando: Comando, resumo: string;
  if (l.tipo === 'boleto') {
    const venc = isoOk(l.vencimento) ? l.vencimento : null;
    const descr = l.descricao || l.recebedor || 'boleto';
    comando = { ...base, acao: 'criar_tarefa', titulo: `Pagar ${descr} (${moeda(valor)})`, data: venc, hora: venc && venc >= hoje() ? '09:00' : null, prioridade: 1,
      area: negocio === 'aluguel' ? 'alugueis' : negocio === 'dj' ? 'dj' : negocio || 'pessoal' };
    resumo = `📄 Boleto: ${descr} · ${moeda(valor)}${venc ? ` · vence ${relDia(venc)}` : ''}\nCrio a tarefa "Pagar ${descr}"${comando.hora ? ` com aviso no dia do vencimento às 9h` : ''}?`;
  } else if (paraClaudio(l.recebedor, await pixNome(sb))) {
    // Dinheiro que ele recebeu: pagamento de um cliente
    const cands = await dealsDoPagador(sb, l.pagador);
    const quem = cands.length === 1 ? cands[0] : null;
    const nome = quem ? String(quem.titulo).split(' — ').slice(1).join(' — ') : l.pagador;
    comando = { ...base, acao: 'registrar_pagamento', cliente: nome || null, valor, data, forma: 'Pix' };
    resumo = `📄 Comprovante: ${moeda(valor)} de ${l.pagador || 'pagador ilegível'}${data ? ` em ${dm(data)}` : ''}\n` + (quem
      ? `Registro como pagamento de *${quem.titulo}*${quem.valor ? ` (falta ${moeda(saldoDe(quem))})` : ''}?`
      : cands.length > 1 ? `Tem ${cands.length} oportunidades dessa pessoa. Diz de qual é (ex.: "sim, é a do dia 15/11") ou "não".`
      : `Não achei oportunidade aberta dessa pessoa. Diz de quem é (ex.: "sim, é da Anabela") ou "não".`);
  } else {
    const categoria = CATS_SAI.includes(l.categoria) ? l.categoria : 'Outros';
    const descr = l.descricao || l.recebedor || categoria;
    comando = { ...base, acao: 'lancar_gasto', valor, titulo: descr, categoria, casa, negocio: negocio as any, data };
    const casaNome = casa ? await nomeCasa(sb, casa) : null;
    resumo = `📄 ${l.tipo === 'nota_fiscal' ? 'Nota' : 'Comprovante'}: ${moeda(valor)}${l.recebedor ? ` para ${l.recebedor}` : ''}${data ? ` em ${dm(data)}` : ''}\nLanço como gasto: ${descr} · ${categoria}${casaNome ? ` · ${casaNome}` : negocio ? ` · ${NEGOCIO_NOME[negocio] || negocio}` : ''}?`;
  }
  await sb.from('wa_settings').update({ dono_pendente: { comando, resumo, em: new Date().toISOString() } }).eq('id', 1);
  return { acao: 'proposta', texto: `${resumo}\n_Responda "sim", corrija ("é da Casa Azul") ou "não"._`, proposta: comando };
}

// O recebedor é o Claudio: primeiro e último nome do titular do Pix (base das casas) ou "Claudio … Braga"
const paraClaudio = (recebedor: string, titular: string) => {
  const r = palavras(recebedor);
  const t = palavras(titular || 'Claudio Braga');
  const tem = (w: string) => r.some(x => x === w);
  return (tem(t[0]) && tem(t.at(-1)!)) || (tem('claudio') && tem('braga'));
};
async function pixNome(sb: SB) {
  const { data } = await sb.from('app_config').select('value').eq('key', 'wa_base').maybeSingle();
  try { return JSON.parse(data?.value || '{}')?.geral?.pix_nome || ''; } catch { return ''; }
}
// Oportunidades abertas cujo contato tem todas as palavras no nome de quem pagou ("Anabela Souza" ⊂ "ANABELA DE SOUZA LIMA")
async function dealsDoPagador(sb: SB, pagador: string) {
  const ws = palavras(pagador);
  if (!ws.length) return [];
  const { data: ds } = await sb.from('deals').select('*').in('etapa', ABERTAS);
  const { data: cs } = await sb.from('contacts').select('id,nome');
  return (ds || []).filter((d: any) => {
    const nome = palavras((cs || []).find((c: any) => c.id === d.contato_id)?.nome || String(d.titulo || '').split(' — ').slice(1).join(' '));
    return nome.length > 0 && nome.every(n => ws.some(w => w === n));
  });
}

// ---------- áudio ----------
async function transcrever(midia: Midia) {
  const groq = Deno.env.get('GROQ_API_KEY'), openai = Deno.env.get('OPENAI_API_KEY');
  if (!groq && !openai) throw new Error('sem chave');
  const arq = await baixar(midia, 20);
  const fd = new FormData();
  const ext = /mpeg|mp3/.test(arq.mime) ? 'mp3' : /mp4|m4a|aac/.test(arq.mime) ? 'm4a' : /wav/.test(arq.mime) ? 'wav' : 'ogg';
  fd.append('file', new Blob([arq.bytes], { type: arq.mime }), `audio.${ext}`);
  fd.append('model', groq ? 'whisper-large-v3-turbo' : 'whisper-1');
  fd.append('language', 'pt');
  const r = await fetch(groq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${groq || openai}` }, body: fd, signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`transcrição ${r.status}: ${j?.error?.message || ''}`.trim());
  return String(j.text || '').trim();
}

async function baixar(m: Midia, maxMb = 8): Promise<{ mime: string; bytes: Uint8Array }> {
  if (m.base64) return { mime: m.mime, bytes: Uint8Array.from(atob(m.base64), c => c.charCodeAt(0)) };
  const r = await fetch(m.url!, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`download ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > maxMb * 1024 * 1024) throw new Error('arquivo grande demais');
  return { mime: (r.headers.get('content-type') || m.mime).split(';')[0].trim() || m.mime, bytes };
}
function base64(b: Uint8Array) {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------- desfazer e corrigir (última ação, até 24 h) ----------
async function ultimaAcao(sb: SB) {
  const { data } = await sb.from('dono_acoes').select('*').is('desfeita_em', null).gte('criado_em', new Date(Date.now() - 864e5).toISOString())
    .order('criado_em', { ascending: false }).limit(1);
  return data?.[0] || null;
}

async function desfazer(sb: SB) {
  const a = await ultimaAcao(sb);
  if (!a) return { acao: 'desfazer', texto: 'Não tem nada para desfazer nas últimas 24 h.' };
  if (!a.antes) {
    await sb.from(a.tabela).delete().eq('id', a.registro_id);
    // Contato criado junto com a oportunidade sai também, se não sobrou outra oportunidade dele
    const c = a.extra?.contato_criado;
    if (c) {
      const { data: outras } = await sb.from('deals').select('id').eq('contato_id', c);
      if (!outras?.length) await sb.from('contacts').delete().eq('id', c);
    }
  } else await sb.from(a.tabela).update(a.antes).eq('id', a.registro_id);
  await sb.from('dono_acoes').update({ desfeita_em: new Date().toISOString() }).eq('id', a.id);
  if (a.tabela === 'deals') await sincronizarAgenda(sb);
  return { acao: 'desfazer', texto: `↩️ Desfeito: ${String(a.resumo).split('\n')[0].replace(/^\S+\s/, '')}` };
}

async function corrigir(sb: SB, x: Comando, data: string | null) {
  const a = await ultimaAcao(sb);
  if (!a) return { acao: 'corrigir', texto: 'Não tem registro recente para corrigir. Me manda de novo completo.' };
  const { data: atual } = await sb.from(a.tabela).select('*').eq('id', a.registro_id).maybeSingle();
  if (!atual) return { acao: 'corrigir', texto: 'Esse registro não existe mais (foi apagado no Hub).' };
  const patch: Record<string, unknown> = {};
  const mudou: string[] = [];
  const muda = (campo: string, valor: unknown, rotulo: string, fmt = (v: any) => String(v ?? '—')) => {
    if (valor == null || valor === atual[campo]) return;
    patch[campo] = valor; mudou.push(`${rotulo}: ${fmt(atual[campo])} → ${fmt(valor)}`);
  };
  if (a.acao === 'criar_oportunidade' || a.acao === 'a_receber') {
    muda('valor', x.valor && x.valor > 0 ? centavos(x.valor) : null, 'valor', v => v == null ? '—' : moeda(+v));
    muda('data_evento', data, 'data', v => v ? dm(v) : '—');
    muda('hora_inicio', horaOk(x.hora), 'hora', v => v ? String(v).slice(0, 5) : '—');
    muda('local', x.local?.trim() || null, 'local');
    muda('etapa', x.etapa, 'etapa', v => ETAPA_NOME[v] || v);
    if (x.titulo?.trim()) muda('notas', x.titulo.trim(), 'notas');
    if (x.cliente?.trim() && x.cliente.trim() !== atual.titulo.split(' — ')[1]) {
      const { contato } = await garantirContato(sb, x.cliente.trim(), atual.negocio === 'dj' ? 'contratante' : 'cliente');
      if (contato.id !== atual.contato_id) {
        patch.contato_id = contato.id;
        patch.titulo = `${NEGOCIO_NOME[atual.negocio] || atual.negocio} — ${contato.nome}`;
        mudou.push(`cliente: ${contato.nome}`);
      }
    }
  } else if (a.acao === 'registrar_pagamento') {
    // Corrige o pagamento que o canal acrescentou (o último com obs "pelo WhatsApp")
    const pgs = [...((atual.pagamentos as any[]) || [])];
    const i = pgs.findLastIndex(p => p.obs === 'pelo WhatsApp');
    if (i < 0) return { acao: 'corrigir', texto: 'Não achei o pagamento para corrigir.' };
    const p = { ...pgs[i] };
    if (x.valor && x.valor > 0 && centavos(x.valor) !== p.valor) { mudou.push(`valor: ${moeda(p.valor)} → ${moeda(x.valor)}`); p.valor = centavos(x.valor); }
    if (data && data !== p.data) { mudou.push(`data: ${dm(p.data)} → ${dm(data)}`); p.data = data; }
    if (x.forma && x.forma !== p.forma) { mudou.push(`forma: ${p.forma} → ${x.forma}`); p.forma = x.forma; }
    pgs[i] = p;
    if (mudou.length) patch.pagamentos = pgs;
  } else if (a.acao === 'lancar_gasto') {
    muda('valor', x.valor && x.valor > 0 ? -centavos(x.valor) : null, 'valor', v => moeda(Math.abs(+v)));
    muda('data', data, 'data', v => dm(v));
    muda('categoria', CATS_SAI.includes(x.categoria || '') ? x.categoria : null, 'categoria');
    if (x.casa) { muda('casa', x.casa, 'casa'); if (patch.casa) patch.negocio = 'alugueis'; }
    if (x.titulo?.trim()) muda('descricao', x.titulo.trim(), 'descrição');
  } else if (a.acao === 'criar_tarefa') {
    if (x.titulo?.trim()) muda('titulo', x.titulo.trim(), 'tarefa');
    muda('prazo', data, 'prazo', v => v ? dm(v) : 'sem prazo');
    muda('area', x.area, 'área', v => AREA_NOME[v] || v);
    if (x.prioridade === 1 || x.prioridade === 2) muda('prioridade', x.prioridade, 'prioridade', v => (v === 1 ? 'alta' : 'normal'));
    // Hora nova (ou data nova de tarefa com aviso): refaz o aviso
    const hora = horaOk(x.hora) || (data && atual.lembrete_em ? `${horaLocal(atual.lembrete_em)}:00` : null);
    if (hora) {
      const dia = data || atual.prazo || hoje();
      const novo = momento(dia, hora);
      if (Date.parse(novo) > Date.now() && novo !== atual.lembrete_em) {
        patch.lembrete_em = novo; patch.lembrete_enviado_em = null;
        if (!patch.prazo && atual.prazo !== dia) patch.prazo = dia;
        mudou.push(`aviso: ${atual.lembrete_em ? `${relDia(dataLocal(atual.lembrete_em))} ${horaLocal(atual.lembrete_em)}` : 'sem aviso'} → ${relDia(dia)} ${hora.slice(0, 5)}`);
      }
    }
  } else return { acao: 'corrigir', texto: 'Esse registro não dá para corrigir por aqui: use "desfaz" e mande de novo.' };
  if (!mudou.length) return { acao: 'corrigir', texto: 'Não entendi o que mudar. Ex.: "o valor é 3800", "era dia 16".' };
  await sb.from(a.tabela).update(patch).eq('id', a.registro_id);
  // O "antes" da ação continua o original (desfazer volta ao estado de antes do registro)
  await sb.from('dono_acoes').update({ depois: { ...(a.depois || {}), ...patch } }).eq('id', a.id);
  if (a.tabela === 'deals') await sincronizarAgenda(sb);
  return { acao: 'corrigir', texto: `✏️ Corrigido (${String(a.resumo).split('\n')[0].replace(/^\S+\s/, '').replace(/\*/g, '')})\n• ${mudou.join('\n• ')}` };
}

// ---------- consultas ----------
async function consultar(sb: SB, x: Comando): Promise<string> {
  const c = x.consulta || 'hoje';
  if (c === 'hoje') return (await blocosDoDia(sb, hoje(), { pendencias: true })).join('\n\n') || 'Nada marcado para hoje 🙌';
  if (c === 'amanha') return (await blocosDoDia(sb, addDays(hoje(), 1), { titulo: true })).join('\n\n') || 'Nada marcado para amanhã 🙌';
  if (c === 'semana') return await semana(sb);
  if (c === 'quem_deve') return (await aReceber(sb, 10)) || 'Ninguém te devendo nas oportunidades do Hub 🙌';
  if (c === 'pendencias') return (await pendencias(sb, 10)) || 'Nada atrasado nem pendente para hoje 🙌';
  return await casasLivres(sb, x);
}

async function casasLivres(sb: SB, x: Comando) {
  if (!isoOk(x.checkin) || !isoOk(x.checkout) || x.checkout! <= x.checkin!) return 'Me diz a entrada e a saída (ex.: "de 20 a 23/11 pra 4").';
  try {
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/airbnb-quote`, {
      method: 'POST', headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkin: x.checkin, checkout: x.checkout, adultos: x.pessoas && x.pessoas > 0 ? x.pessoas : 2, ...(x.casa ? { casas: [x.casa] } : {}) }),
      signal: AbortSignal.timeout(40000),
    });
    const j = await r.json();
    if (!j?.mensagem) throw new Error(j?.error || `status ${r.status}`);
    return `🏠 ${dm(x.checkin!)} a ${dm(x.checkout!)}, ${x.pessoas || 2} pessoas${x.pessoas ? '' : ' (não disse quantas)'}:\n${String(j.mensagem).replace(/^Olá!\s*/, '')}`;
  } catch (e) { console.error('dono airbnb-quote', e); return 'Não consegui consultar o Airbnb agora. Tenta pelo botão em Aluguéis.'; }
}

// ---------- resumo do dia (wa-dono, 7h30 e 18h) ----------
export async function resumoDoDia(sb: SB, quando: 'manha' | 'noite') {
  const d = hoje();
  if (quando === 'manha') {
    const blocos = await blocosDoDia(sb, d, { pendencias: true, receber: true });
    const s = saudacao();
    return `${s === 'Bom dia' ? '☀️' : s === 'Boa tarde' ? '🌤️' : '🌙'} ${s}! ${cap(diaDm(d))}\n\n${blocos.join('\n\n') || 'Nada marcado e nada pendente. Dia livre 🙌'}`;
  }
  const amanha = addDays(d, 1);
  const blocos = await blocosDoDia(sb, amanha, {});
  const pend = await contarPendencias(sb);
  return `🌙 Amanhã, ${diaDm(amanha)}\n\n${blocos.join('\n\n') || 'Nada marcado para amanhã 🙌'}${pend ? `\n\n⏰ Ficou aberto hoje: ${pend} ${pend === 1 ? 'pendência' : 'pendências'} ("pendências" para ver)` : ''}`;
}

async function blocosDoDia(sb: SB, dia: string, { pendencias: comPend = false, receber = false, titulo = false } = {}) {
  const blocos: string[] = [];
  const ag = await agendaDoDia(sb, dia);
  if (ag.length) blocos.push(`📅 ${titulo || dia !== hoje() ? cap(diaDm(dia)) : 'Hoje'}\n${ag.join('\n')}`);
  const cs = await casasDoDia(sb, dia);
  if (cs.length) blocos.push(`🏠 Casas\n${cs.join('\n')}`);
  if (comPend) { const p = await pendencias(sb, 6); if (p) blocos.push(p); }
  if (receber) { const r = await aReceber(sb, 4); if (r) blocos.push(r); }
  return blocos;
}

async function agendaDoDia(sb: SB, dia: string) {
  const itens: [string, string][] = [];
  const { data: gigs } = await sb.from('deals').select('titulo,hora_inicio,local,etapa,negocio').eq('data_evento', dia).in('etapa', ['negociacao', 'fechado', 'realizado', 'pago']);
  for (const g of gigs || []) itens.push([String(g.hora_inicio || '99').slice(0, 5), `• ${g.hora_inicio ? String(g.hora_inicio).slice(0, 5) + ' ' : ''}${g.titulo}${g.local ? ` (${g.local})` : ''}${g.etapa === 'negociacao' ? ' · ainda negociando' : ''}`]);
  const { data: evs } = await sb.from('events').select('titulo,inicio,dia_inteiro,local').gte('inicio', addDays(dia, -1)).lt('inicio', addDays(dia, 2));
  for (const e of evs || []) {
    const local = e.dia_inteiro ? String(e.inicio).slice(0, 10) : dataLocal(e.inicio);
    if (local !== dia) continue;
    const h = e.dia_inteiro ? '' : horaLocal(e.inicio);
    // "DJ Clau — Makai" no local "Makai": não repete
    const onde = e.local && !semAcento(e.titulo).includes(semAcento(e.local)) ? ` (${e.local})` : '';
    itens.push([h || '00:00', `• ${h ? h + ' ' : ''}${e.titulo}${onde}`]);
  }
  const { data: ts } = await sb.from('tasks').select('titulo,prioridade,lembrete_em').eq('feito', false).eq('prazo', dia);
  for (const t of ts || []) {
    const h = t.lembrete_em && dataLocal(t.lembrete_em) === dia ? horaLocal(t.lembrete_em) : '';
    // Hoje, a tarefa sem hora já aparece nas pendências
    if (h) itens.push([h, `• ${h} ⏰ ${t.titulo}${t.prioridade === 1 ? ' ❗' : ''}`]);
    else if (dia !== hoje()) itens.push(['zz', `• Tarefa: ${t.titulo}${t.prioridade === 1 ? ' ❗' : ''}`]);
  }
  return itens.sort((a, b) => a[0].localeCompare(b[0])).map(i => i[1]);
}

async function casasDoDia(sb: SB, dia: string) {
  const { data: props } = await sb.from('properties').select('id,nome');
  const nome = (id: string) => (props || []).find((p: any) => p.id === id)?.nome || id;
  const out: string[] = [];
  const { data: ent } = await sb.from('bookings').select('property_id,hospede,checkout,origem').eq('checkin', dia).neq('status', 'cancelada').neq('status', 'bloqueio');
  for (const b of ent || []) out.push(`• Entra: ${nome(b.property_id)}${b.hospede ? ` — ${b.hospede}` : ''} (até ${dm(b.checkout)}${b.origem && b.origem !== 'direto' ? `, ${b.origem}` : ''})`);
  const { data: sai } = await sb.from('bookings').select('property_id,hospede').eq('checkout', dia).neq('status', 'cancelada').neq('status', 'bloqueio');
  for (const b of sai || []) out.push(`• Sai: ${nome(b.property_id)}${b.hospede ? ` — ${b.hospede}` : ''}`);
  return out;
}

async function pendencias(sb: SB, max: number) {
  const d = hoje();
  const { data: ds } = await sb.from('deals').select('titulo,proxima_acao,data_proxima_acao,etapa').in('etapa', ABERTAS).lte('data_proxima_acao', d).order('data_proxima_acao');
  const { data: ts } = await sb.from('tasks').select('titulo,prazo,prioridade').eq('feito', false).lte('prazo', d).order('prazo');
  const linhas = [
    ...(ds || []).map((x: any) => [x.data_proxima_acao, `• ${x.titulo}: ${x.proxima_acao || 'sem próxima ação'}${atraso(x.data_proxima_acao)}`]),
    ...(ts || []).map((t: any) => [t.prazo, `• Tarefa: ${t.titulo}${t.prioridade === 1 ? ' ❗' : ''}${atraso(t.prazo)}`]),
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(x => x[1]);
  if (!linhas.length) return '';
  return `⏰ Pendências (${linhas.length})\n${linhas.slice(0, max).join('\n')}${linhas.length > max ? `\n• e mais ${linhas.length - max}` : ''}`;
}
async function contarPendencias(sb: SB) {
  const d = hoje();
  const { count: a } = await sb.from('deals').select('id', { count: 'exact', head: true }).in('etapa', ABERTAS).lte('data_proxima_acao', d);
  const { count: b } = await sb.from('tasks').select('id', { count: 'exact', head: true }).eq('feito', false).lte('prazo', d);
  return (a || 0) + (b || 0);
}

async function aReceber(sb: SB, max: number) {
  const { data: ds } = await sb.from('deals').select('titulo,valor,pagamentos,data_evento,etapa').in('etapa', ['negociacao', 'fechado', 'realizado']);
  const lista = (ds || []).filter((d: any) => +d.valor > 0 && saldoDe(d) > 0).sort((a: any, b: any) => String(a.data_evento || '9').localeCompare(String(b.data_evento || '9')));
  if (!lista.length) return '';
  const total = centavos(lista.reduce((s: number, d: any) => s + saldoDe(d), 0));
  const d = hoje();
  return `💰 A receber: ${moeda(total)} (${lista.length})\n${lista.slice(0, max).map((x: any) => `• ${x.titulo.replace(/^[^—]+— /, '')}: ${moeda(saldoDe(x))}${x.data_evento ? ` · ${x.data_evento < d ? `evento foi ${dm(x.data_evento)}` : `evento ${dm(x.data_evento)}`}` : ''}`).join('\n')}${lista.length > max ? `\n• e mais ${lista.length - max}` : ''}`;
}

async function semana(sb: SB) {
  const partes: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dia = addDays(hoje(), i);
    const linhas = [...await agendaDoDia(sb, dia), ...await casasDoDia(sb, dia)];
    if (linhas.length) partes.push(`*${i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : cap(diaDm(dia))}*\n${linhas.join('\n')}`);
  }
  return partes.length ? `📅 Próximos 7 dias\n\n${partes.join('\n\n')}` : 'Semana livre: nada marcado nos próximos 7 dias 🙌';
}

// ---------- apoio ----------
async function garantirContato(sb: SB, nome: string, tipo: string) {
  const { data: cs } = await sb.from('contacts').select('id,nome');
  const alvo = semAcento(nome).trim();
  const lista = (cs || []).filter((c: any) => c.nome);
  // Nome igual; senão o nome dito é o começo de um só contato ("Anabela" → "Anabela Souza"), palavra inteira
  const igual = lista.find((c: any) => semAcento(c.nome).trim() === alvo);
  if (igual) return { contato: igual, criado: false };
  const comeco = lista.filter((c: any) => (semAcento(c.nome).trim() + ' ').startsWith(alvo + ' '));
  if (comeco.length === 1) return { contato: comeco[0], criado: false };
  const { data } = await sb.from('contacts').insert({ nome: nome.trim(), tipo }).select('id,nome').single();
  return { contato: data, criado: true };
}

// Oportunidades abertas cujo cliente (contato ou título) tem todas as palavras do nome dito
async function dealsDoCliente(sb: SB, nome: string) {
  const alvo = palavras(nome);
  const { data: ds } = await sb.from('deals').select('*').in('etapa', ABERTAS);
  const { data: cs } = await sb.from('contacts').select('id,nome');
  const nomeC = (id: string) => (cs || []).find((c: any) => c.id === id)?.nome || '';
  return (ds || []).filter((d: any) => {
    const ws = palavras(`${nomeC(d.contato_id)} ${String(d.titulo || '').split(' — ').slice(1).join(' ')}`);
    return alvo.length > 0 && alvo.every(a => ws.some(w => mesmaPalavra(a, w)));
  }).sort((a: any, b: any) => String(a.data_evento || '9').localeCompare(String(b.data_evento || '9')));
}

async function nomeCasa(sb: SB, id: string) {
  const { data } = await sb.from('properties').select('nome').eq('id', id).maybeSingle();
  return data?.nome || id;
}

// Gig fechado ou mudado: atualiza o Google Agenda (gcal-sync aceita o token do agendador)
async function sincronizarAgenda(sb: SB) {
  try {
    const { data } = await sb.from('app_secrets').select('value').eq('key', 'cron_token').maybeSingle();
    if (!data?.value) return;
    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/gcal-sync`, { method: 'POST', headers: { 'x-hub-cron': data.value, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
  } catch (e) { console.error('dono gcal-sync', e); }
}

const pick = (o: any, ks: string[]) => Object.fromEntries(ks.map(k => [k, o?.[k] ?? null]));
const semAcento = (t: string) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const VAZIAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'o', 'a', 'os', 'as', 'pro', 'pra', 'para', 'no', 'na', 'com']);
const palavras = (t: string) => semAcento(t).split(/[^a-z0-9]+/).filter(w => w.length > 1 && !VAZIAS.has(w));
// "contador" ~ "contadora", "ligar" ~ "liguei": mesmo começo de 4+ letras
const mesmaPalavra = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4) && (a.startsWith(b) || b.startsWith(a) || a.slice(0, 5) === b.slice(0, 5)));
const isoOk = (s: string | null | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s;
const horaOk = (h: string | null | undefined) => { const m = String(h || '').match(/^(\d{1,2})[:h]?(\d{2})?$/); return m && +m[1] < 24 && +(m[2] || 0) < 60 ? `${m[1].padStart(2, '0')}:${m[2] || '00'}:00` : null; };

export const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const diaDm = (iso: string) => `${SEMANA[new Date(iso + 'T12:00:00Z').getUTCDay()]}, ${dm(iso)}`;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const relDia = (iso: string) => { const n = dias(hoje(), iso); return n === 0 ? 'hoje' : n === 1 ? 'amanhã' : n === -1 ? 'ontem' : diaDm(iso); };
const atraso = (iso: string) => { const n = dias(iso, hoje()); return n > 0 ? ` (atraso de ${n} ${n === 1 ? 'dia' : 'dias'})` : ''; };
const agoraHHMM = () => horaLocal(new Date().toISOString());
// Pipa não tem horário de verão: sempre -03:00
const momento = (dia: string, hora: string) => new Date(`${dia}T${hora.slice(0, 5)}:00-03:00`).toISOString();
const dataLocal = (ts: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(ts));
const horaLocal = (ts: string) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).format(new Date(ts));
const saudacao = () => { const h = +new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).format(new Date()); return h >= 5 && h < 12 ? 'Bom dia' : h < 18 && h >= 12 ? 'Boa tarde' : 'Boa noite'; };
