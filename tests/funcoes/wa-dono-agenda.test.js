// Canal do dono, melhorias de 24/10 (conversa real): "qual a minha atividade de agora?" responde só o agora e o próximo;
// recusa curta (exemplos só com "ajuda" ou na 2ª incompreensão); resumo do dia mais limpo; e mudar compromisso da agenda
// (antes → depois, "só este ou todos?", grava no Google pelo gcal-sync, "desfaz" volta).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

const ENV = { WA_AGRUPAR_S: '0', ANTHROPIC_API_KEY: 'sk-teste', ZAPI_INSTANCE: 'INST1', ZAPI_TOKEN: 'tok1', ZAPI_CLIENT_TOKEN: 'cli1', ZAPI_WEBHOOK_KEY: 'chave-z' };
const DONO = '5584996011991';
const ZURL = /api\.z-api\.io\/instances\/INST1\/token\/tok1\/send-text/;
const GCAL = 'https://projeto.supabase.co/functions/v1/gcal-sync';
const HOJE = '2026-10-19'; // segunda, 12:00 em Pipa (relógio parado dos testes)

const CMD = x => ({ acao: 'conversa', negocio: 'nenhum', cliente: '', valor: 0, recebido: 0, data: '', hora: '', local: '', titulo: '', etapa: 'nenhum',
  forma: 'nenhum', categoria: '', casa: 'nenhum', area: 'nenhum', prioridade: 0, consulta: 'nenhum', checkin: '', checkout: '', pessoas: 0,
  evento: '', hora_fim: '', nova_data: '', escopo: 'nenhum', ajuda: 'nenhum', resposta: '', ...x });
const ia = x => { globalThis.__anthropic = { chamadas: [], responder: () => CMD(x) }; };
const DADOS = (x = {}) => comCron({
  properties: [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }, { id: 'QS50', nome: 'Casa Terracota' }],
  wa_settings: [{ id: 1, bot_ativo: true, horas_silencio: 12, max_respostas_dia: 4, dono_wa: DONO, dono_resumo: true }],
  ...x,
});

let fn, seq = 0;
const enviadas = () => chamadasPara(ZURL).map(c => c.json());
async function diz(texto, comando) {
  ia(comando);
  const antes = enviadas().length;
  const r = await fn(pedido('/wa-webhook?zapi=chave-z', { auth: null, corpo: {
    type: 'ReceivedCallback', instanceId: 'INST1', messageId: `ZA${++seq}`, phone: DONO, fromMe: false, momment: Date.now(),
    senderName: 'Claudio', isGroup: false, text: { message: texto },
  } }));
  assert.equal(r.status, 200);
  const novas = enviadas().slice(antes);
  assert.equal(novas.length, 1, `uma resposta para "${texto}"`);
  return novas[0].message;
}

before(async () => { fn = await carregarFuncao('wa-webhook', ENV); });
beforeEach(() => {
  limparRede();
  for (const [k, v] of Object.entries(ENV)) definirEnv(k, v);
  simular(ZURL, () => ({ messageId: `ZOUT${++seq}` }));
  simular(GCAL, { ok: true, alterados: 1 });
});

describe('canal do dono: responde o que foi perguntado', () => {
  const AGORA = (x = {}) => DADOS({
    contacts: [{ id: 'c1', nome: 'Bar Fonte' }],
    deals: [
      { id: 'g1', titulo: 'DJ — Bar Fonte', negocio: 'dj', etapa: 'fechado', data_evento: HOJE, hora_inicio: '21:00:00', hora_fim: '02:00:00', local: 'Bar Fonte', valor: 2000, pagamentos: [] },
      { id: 'd2', titulo: 'Aluguéis — Eduardo', negocio: 'aluguel', etapa: 'lead', proxima_acao: 'Responder WhatsApp', data_proxima_acao: '2026-10-17' },
    ],
    tasks: [{ id: 't1', titulo: 'Pagar IPTU', feito: false, prazo: HOJE }],
    events: [
      { id: 'e1', titulo: 'DJ Clau — Discotecagem Vinil', calendario: 'dj', inicio: '2026-10-19T14:30:00Z', fim: '2026-10-19T17:30:00Z', dia_inteiro: false },
      { id: 'e2', titulo: 'Dentista', calendario: 'pessoal', inicio: '2026-10-19T18:00:00Z', fim: '2026-10-19T19:00:00Z', dia_inteiro: false },
    ],
    ...x,
  });
  test('"qual a minha atividade de agora?": só o que está acontecendo (até quando, quanto falta) e o próximo', async () => {
    novoBanco(AGORA());
    const r = await diz('Qual a minha atividade de agora?', { acao: 'consultar', consulta: 'agora' });
    assert.equal(r, '▶️ Agora: *DJ Clau — Discotecagem Vinil* · 11:30–14:30 (termina em 2h30)\n⏭️ Depois: *Dentista* · 15:00–16:00 (daqui a 3h)');
    assert.doesNotMatch(r, /Pendências|IPTU|Eduardo|Bar Fonte/, 'sem resumo do dia nem pendências');
  });
  test('nada acontecendo agora: diz isso e mostra o próximo, mesmo que seja amanhã', async () => {
    novoBanco(AGORA({ deals: [], events: [{ id: 'e3', titulo: 'Reunião obra', inicio: '2026-10-20T12:00:00Z', fim: '2026-10-20T13:30:00Z', dia_inteiro: false }] }));
    const r = await diz('o que vem agora?', { acao: 'consultar', consulta: 'agora' });
    assert.equal(r, 'Nada acontecendo agora.\n⏭️ Depois: *Reunião obra* · amanhã, 09:00–10:30');
  });
  test('gig do Pipeline com o local no título: não repete o local', async () => {
    novoBanco(AGORA({ events: [] }));
    const r = await diz('qual o próximo compromisso?', { acao: 'consultar', consulta: 'agora' });
    assert.equal(r, 'Nada acontecendo agora.\n⏭️ Depois: *DJ — Bar Fonte* · 21:00–02:00 (daqui a 9h)');
  });
  test('agenda vazia na semana', async () => {
    novoBanco(DADOS());
    assert.equal(await diz('o que estou fazendo?', { acao: 'consultar', consulta: 'agora' }), 'Nada acontecendo agora.\n⏭️ Nada marcado nos próximos 7 dias.');
  });
});

describe('canal do dono: recusa curta, exemplos só quando pedir', () => {
  test('não entendeu: uma frase com alternativa, sem a lista; na 2ª seguida, aí mostra os exemplos', async () => {
    novoBanco(DADOS());
    const r1 = await diz('troca a senha do wifi', { acao: 'conversa', ajuda: 'nao_entendi', resposta: 'Ainda não mexo no wifi; posso criar uma tarefa para você lembrar.' });
    assert.equal(r1, 'Ainda não mexo no wifi; posso criar uma tarefa para você lembrar.\n_("ajuda" mostra o que eu sei fazer)_');
    const r2 = await diz('muda o wifi', { acao: 'conversa', ajuda: 'nao_entendi', resposta: 'Ainda não entendi.' });
    assert.match(r2, /^Ainda não entendi\.\n\nPode me pedir assim/);
    assert.match(r2, /\+dj Anabela/);
  });
  test('"ajuda" / "o que você faz?": a lista de exemplos, já com as novidades', async () => {
    novoBanco(DADOS());
    const r = await diz('ajuda', { acao: 'conversa', ajuda: 'pediu_ajuda', resposta: 'Claro!' });
    assert.match(r, /^Pode me pedir assim/);
    assert.match(r, /o que estou fazendo agora\?/);
    assert.match(r, /muda o fim da discotecagem para 19h/);
  });
  test('agradecimento: só a resposta', async () => {
    novoBanco(DADOS());
    assert.equal(await diz('valeu', { acao: 'conversa', resposta: 'De nada! 🙌' }), 'De nada! 🙌');
  });
  test('a IA é instruída a não listar exemplos e a classificar a recusa', async () => {
    novoBanco(DADOS());
    await diz('oi', { acao: 'conversa', resposta: 'Oi!' });
    const s = globalThis.__anthropic.chamadas[0].system;
    assert.match(s, /nao_entendi/);
    assert.match(s, /Nunca liste exemplos de comandos/);
    assert.match(s, /consulta: agora/);
  });
});

describe('canal do dono: resumo do dia mais limpo', () => {
  test('início–fim, local sem repetir e pendências de aluguel com nome, casa e datas', async () => {
    novoBanco(DADOS({
      contacts: [{ id: 'c1', nome: 'Bar Fonte' }, { id: 'c9', nome: 'Claudio Braga' }],
      deals: [
        { id: 'g1', titulo: 'DJ — Bar Fonte', negocio: 'dj', etapa: 'fechado', data_evento: HOJE, hora_inicio: '21:00:00', local: 'Bar Fonte', valor: 2000, pagamentos: [] },
        { id: 'a1', titulo: 'Aluguéis — Claudio Braga', negocio: 'aluguel', etapa: 'orcamento', contato_id: 'c9', local: 'Casa Terracota', data_evento: '2026-11-20',
          proxima_acao: 'Acompanhar: o robô enviou disponibilidade e valores', data_proxima_acao: HOJE },
        { id: 'a2', titulo: 'Aluguéis — Renata', negocio: 'aluguel', etapa: 'negociacao', local: 'Casa Azul', proxima_acao: 'Aguardando sinal de R$ 825', data_proxima_acao: HOJE },
      ],
      wa_contacts: [{ wa_id: '5584900000001', nome: 'Claudio Braga', deal_id: 'a1', pedido: { casa: 'QS50', checkin: '2026-11-20', checkout: '2026-11-23' } },
        { wa_id: '5584900000002', nome: 'Renata', deal_id: 'a2', pedido: { casa: 'QS40', checkin: '2026-12-26', checkout: '2027-01-06' } }],
      events: [{ id: 'e1', titulo: 'DJ Clau — Discotecagem Vinil', inicio: '2026-10-19T15:30:00Z', fim: '2026-10-19T18:30:00Z', dia_inteiro: false, local: 'Discotecagem Vinil' }],
    }));
    const r = await diz('o que tenho hoje?', { acao: 'consultar', consulta: 'hoje' });
    assert.match(r, /• 12:30–15:30 DJ Clau — Discotecagem Vinil\n/);
    assert.match(r, /• 21:00 DJ — Bar Fonte(\n|$)/);
    assert.doesNotMatch(r, /\(Bar Fonte\)|\(Discotecagem Vinil\)/);
    assert.match(r, /• Claudio Braga · Terracota 20–23\/11: aguardando resposta do hóspede/);
    assert.match(r, /• Renata · Azul 26\/12–06\/01: aguardando o sinal de R\$ 825/);
    assert.doesNotMatch(r, /Acompanhar: o robô/);
  });
  test('gig com início e fim: 21:00–02:00', async () => {
    novoBanco(DADOS({ deals: [{ id: 'g1', titulo: 'DJ — Júlia', negocio: 'dj', etapa: 'fechado', data_evento: HOJE, hora_inicio: '21:00:00', hora_fim: '02:00:00', local: 'Pipa Beach', valor: 1, pagamentos: [{ valor: 1 }] }] }));
    assert.match(await diz('o que tenho hoje?', { acao: 'consultar', consulta: 'hoje' }), /• 21:00–02:00 DJ — Júlia \(Pipa Beach\)/);
  });
});

describe('canal do dono: mudar compromisso da agenda', () => {
  const VINIL = (id, dia) => ({ id, titulo: 'DJ Clau — Discotecagem Vinil', calendario: 'dj', origem: 'google', uid_externo: `src:${id}@google.com`,
    inicio: `${dia}T15:30:00Z`, fim: `${dia}T18:30:00Z`, dia_inteiro: false, local: null });
  const AGENDA = () => DADOS({ events: [VINIL('v1', '2026-10-24'), VINIL('v2', '2026-10-25'), VINIL('v3', '2026-10-31'),
    { id: 'den', titulo: 'Dentista', calendario: 'pessoal', origem: 'manual', inicio: '2026-10-21T17:00:00Z', fim: '2026-10-21T18:00:00Z', dia_inteiro: false, local: null }] });
  const ev = id => banco().t('events').find(e => e.id === id);
  const gcal = () => chamadasPara(GCAL).map(c => c.json());
  const PEDIDO = { acao: 'alterar_evento', evento: 'discotecagem vinil', hora_fim: '19:00' };

  test('"altere o término da discotecagem vinil para 19:00": antes → depois e "só este ou todos?", sem gravar', async () => {
    novoBanco(AGENDA());
    const r = await diz('Altere o termino da discotecagem vinil para 19:00', PEDIDO);
    assert.equal(r, '✏️ Mudar *DJ Clau — Discotecagem Vinil* (sábado, 24/10)\n• fim: 15:30 → 19:00\nEle se repete (mais 2 até 31/10): só este ou todos os próximos?\n_Responda "só este", "todos" ou "não"._');
    assert.equal(ev('v1').fim, '2026-10-24T18:30:00Z', 'nada gravado antes da resposta');
    assert.equal(gcal().length, 0);
    assert.ok(banco().t('wa_settings')[0].dono_pendente, 'proposta esperando a resposta');
  });
  test('"só hoje": grava só esse, no Hub e no Google; "desfaz" volta nos dois', async () => {
    novoBanco(AGENDA());
    await diz('Altere o termino da discotecagem vinil para 19:00', PEDIDO);
    const r = await diz('só hoje', { acao: 'confirmar', escopo: 'so_este' });
    assert.equal(r, '📅 Alterado: *DJ Clau — Discotecagem Vinil* (sábado, 24/10)\n• fim: 15:30 → 19:00\n• Gravado também no Google Agenda\n_"desfaz" volta como estava_');
    assert.deepEqual([ev('v1').inicio, ev('v1').fim], ['2026-10-24T15:30:00.000Z', '2026-10-24T22:00:00.000Z']);
    assert.equal(ev('v2').fim, '2026-10-25T18:30:00Z', 'os outros ficam como estavam');
    assert.deepEqual(gcal(), [{ eventos: ['v1'] }]);
    assert.equal(banco().t('dono_acoes')[0].acao, 'alterar_evento');
    assert.equal(banco().t('wa_settings')[0].dono_pendente, null);
    const d = await diz('desfaz', { acao: 'desfazer' });
    assert.match(d, /Desfeito: Alterado: \*DJ Clau — Discotecagem Vinil\*/);
    assert.equal(ev('v1').fim, '2026-10-24T18:30:00Z');
    assert.deepEqual(gcal(), [{ eventos: ['v1'] }, { eventos: ['v1'] }], 'grava a volta no Google');
  });
  test('"todas": muda o horário de cada um no seu dia e grava todos no Google; "desfaz" volta todos', async () => {
    novoBanco(AGENDA());
    await diz('Altere o termino da discotecagem vinil para 19:00', PEDIDO);
    const r = await diz('todas', { acao: 'confirmar', escopo: 'todos' });
    assert.match(r, /^📅 Alterado: \*DJ Clau — Discotecagem Vinil\* \(sábado, 24\/10\) e mais 2 até 31\/10\n• fim: 15:30 → 19:00/);
    assert.deepEqual(['v1', 'v2', 'v3'].map(id => ev(id).fim), ['2026-10-24T22:00:00.000Z', '2026-10-25T22:00:00.000Z', '2026-10-31T22:00:00.000Z']);
    assert.deepEqual(gcal(), [{ eventos: ['v1', 'v2', 'v3'] }]);
    await diz('desfaz', { acao: 'desfazer' });
    assert.deepEqual(['v1', 'v2', 'v3'].map(id => ev(id).fim), ['2026-10-24T18:30:00Z', '2026-10-25T18:30:00Z', '2026-10-31T18:30:00Z']);
  });
  test('"sim" sem dizer só este ou todos: pergunta de novo, sem gravar', async () => {
    novoBanco(AGENDA());
    await diz('Altere o termino da discotecagem vinil para 19:00', PEDIDO);
    assert.match(await diz('sim', { acao: 'confirmar' }), /só este ou todos os próximos\?/);
    assert.equal(ev('v1').fim, '2026-10-24T18:30:00Z');
    await diz('todos', { acao: 'confirmar', escopo: 'todos' });
    assert.equal(ev('v3').fim, '2026-10-31T22:00:00.000Z');
  });
  test('já disse "só hoje" no pedido: propõe só esse e grava com o "sim"', async () => {
    novoBanco(AGENDA());
    assert.match(await diz('muda o fim da discotecagem pra 19h só hoje', { ...PEDIDO, escopo: 'so_este' }), /Gravo só este \(também no Google Agenda\)\?/);
    await diz('sim', { acao: 'confirmar' });
    assert.deepEqual([ev('v1').fim, ev('v2').fim], ['2026-10-24T22:00:00.000Z', '2026-10-25T18:30:00Z']);
  });
  test('evento do Hub, sem repetição: muda o início mantendo a duração; não chama o Google', async () => {
    novoBanco(AGENDA());
    const r = await diz('o dentista passou para 15h', { acao: 'alterar_evento', evento: 'dentista', hora: '15:00' });
    assert.equal(r, '✏️ Mudar *Dentista* (quarta, 21/10)\n• início: 14:00 → 15:00\n• fim: 15:00 → 16:00\nGravo?\n_Responda "sim" ou "não"._');
    await diz('sim', { acao: 'confirmar' });
    assert.deepEqual([ev('den').inicio, ev('den').fim], ['2026-10-21T18:00:00.000Z', '2026-10-21T19:00:00.000Z']);
    assert.equal(gcal().length, 0);
  });
  test('mudar de dia: só esse evento, sem perguntar da série', async () => {
    novoBanco(AGENDA());
    const r = await diz('a discotecagem de sábado passa para sexta', { acao: 'alterar_evento', evento: 'discotecagem vinil', data: '2026-10-24', nova_data: '2026-10-23' });
    assert.match(r, /• dia: sábado, 24\/10 → sexta, 23\/10\nGravo \(também no Google Agenda\)\?/);
    await diz('sim', { acao: 'confirmar' });
    assert.deepEqual([ev('v1').inicio, ev('v1').fim], ['2026-10-23T15:30:00.000Z', '2026-10-23T18:30:00.000Z']);
  });
  test('"não" descarta a proposta', async () => {
    novoBanco(AGENDA());
    await diz('Altere o termino da discotecagem vinil para 19:00', PEDIDO);
    assert.equal(await diz('não', { acao: 'cancelar' }), 'Ok, descartei.');
    assert.equal(ev('v1').fim, '2026-10-24T18:30:00Z');
  });
  test('Google recusou: o Hub volta como estava e avisa', async () => {
    novoBanco(AGENDA());
    simular(GCAL, { erro: '403 PATCH /calendars: sem permissão' });
    await diz('Altere o termino da discotecagem vinil para 19:00', PEDIDO);
    assert.match(await diz('só hoje', { acao: 'confirmar', escopo: 'so_este' }), /Não consegui gravar no Google Agenda \(403 PATCH/);
    assert.equal(ev('v1').fim, '2026-10-24T18:30:00Z');
    assert.equal(banco().t('dono_acoes').length, 0);
  });
  test('compromisso que não existe: pergunta, sem proposta', async () => {
    novoBanco(AGENDA());
    assert.match(await diz('muda o horário do pilates', { acao: 'alterar_evento', evento: 'pilates', hora: '08:00' }), /Não achei compromisso parecido com "pilates"/);
    assert.equal(banco().t('wa_settings')[0].dono_pendente ?? null, null);
  });
});
