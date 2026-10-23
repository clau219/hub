// Canal do dono (wa-webhook + _shared/dono.ts): o Claudio manda mensagem do número pessoal para o WhatsApp das casas
// e o Hub trata como comando. IA simulada devolve o comando; o teste confere o que foi gravado e o recibo enviado.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

const ENV = { WA_AGRUPAR_S: '0', ANTHROPIC_API_KEY: 'sk-teste', ZAPI_INSTANCE: 'INST1', ZAPI_TOKEN: 'tok1', ZAPI_CLIENT_TOKEN: 'cli1', ZAPI_WEBHOOK_KEY: 'chave-z' };
const DONO = '5584996011991';
const ZURL = /api\.z-api\.io\/instances\/INST1\/token\/tok1\/send-text/;
const HOJE = '2026-10-19'; // segunda (relógio parado dos testes)

// Comando completo que a IA devolveria (structured output): o teste diz só o que importa
const CMD = x => ({ acao: 'conversa', negocio: null, cliente: null, valor: null, recebido: null, data: null, hora: null, local: null, titulo: null, etapa: null,
  forma: null, categoria: null, casa: null, area: null, prioridade: null, consulta: null, checkin: null, checkout: null, pessoas: null, resposta: null, ...x });
const ia = x => { globalThis.__anthropic = { chamadas: [], responder: typeof x === 'function' ? x : () => CMD(x) }; };

const DADOS = (x = {}) => comCron({
  properties: [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }, { id: 'QS50', nome: 'Casa Terracota' }],
  wa_settings: [{ id: 1, bot_ativo: true, horas_silencio: 12, max_respostas_dia: 4, dono_wa: DONO, dono_resumo: true }],
  ...x,
});

let fn, seq = 0;
const enviadas = () => chamadasPara(ZURL).map(c => c.json());
// Mensagem chegando pela Z-API
async function zapi(texto, x = {}) {
  const antes = enviadas().length;
  const r = await fn(pedido('/wa-webhook?zapi=chave-z', { auth: null, corpo: {
    type: 'ReceivedCallback', instanceId: 'INST1', messageId: `ZD${++seq}`, phone: DONO, fromMe: false, momment: Date.now(),
    senderName: 'Claudio', isGroup: false, text: { message: texto }, ...x,
  } }));
  assert.equal(r.status, 200);
  return enviadas().slice(antes);
}
// O dono diz algo e recebe o recibo (texto da única resposta)
async function diz(texto, comando, x) {
  if (comando) ia(comando);
  const r = await zapi(texto, x);
  assert.equal(r.length, 1, `uma resposta para "${texto}"`);
  assert.equal(r[0].phone, x?.phone || DONO, 'responde no número de onde veio');
  return r[0].message;
}

before(async () => { fn = await carregarFuncao('wa-webhook', ENV); });
beforeEach(() => {
  limparRede();
  for (const [k, v] of Object.entries(ENV)) definirEnv(k, v);
  simular(ZURL, () => ({ messageId: `ZOUT${++seq}` }));
  simular('https://projeto.supabase.co/functions/v1/gcal-sync', { criados: 1 });
});

describe('canal do dono: quem é o dono', () => {
  test('mensagem do número pessoal não vira cliente: nada em wa_contacts, wa_messages nem deal de Aluguéis', async () => {
    novoBanco(DADOS());
    const r = await diz('oi', { acao: 'conversa', resposta: 'Oi, Claudio!' });
    assert.match(r, /Oi, Claudio!/);
    assert.match(r, /\+dj Anabela/, 'mostra o que dá para pedir');
    assert.equal(banco().t('wa_contacts').length, 0);
    assert.equal(banco().t('wa_messages').length, 0);
    assert.equal(banco().t('deals').length, 0);
    assert.deepEqual(banco().t('dono_msgs').map(m => m.direcao), ['in', 'out']);
  });
  test('reconhece o número sem o 9 (o WhatsApp às vezes omite)', async () => {
    novoBanco(DADOS());
    const r = await diz('oi', { acao: 'conversa' }, { phone: '558496011991' });
    assert.ok(r);
    assert.equal(banco().t('wa_contacts').length, 0);
  });
  test('sem número do dono cadastrado, o mesmo número é tratado como cliente', async () => {
    novoBanco(DADOS({ wa_settings: [{ id: 1, bot_ativo: false, horas_silencio: 12, max_respostas_dia: 4, dono_wa: null }] }));
    await zapi('oi');
    assert.equal(banco().t('wa_contacts').length, 1);
    assert.equal(banco().t('dono_msgs').length, 0);
  });
  test('o que você digita para o seu número no app das casas (fromMe) é ignorado', async () => {
    novoBanco(DADOS());
    assert.equal((await zapi('teste', { fromMe: true })).length, 0);
    assert.equal(banco().t('wa_contacts').length, 0);
    assert.equal(banco().t('wa_messages').length, 0);
  });
  test('mensagem repetida (reentrega da Z-API) não executa duas vezes', async () => {
    novoBanco(DADOS());
    ia({ acao: 'criar_tarefa', titulo: 'Comprar cabo XLR' });
    await zapi('comprar cabo xlr', { messageId: 'IGUAL' });
    await zapi('comprar cabo xlr', { messageId: 'IGUAL' });
    assert.equal(banco().t('tasks').length, 1);
  });
  test('áudio: pede por escrito, sem chamar a IA', async () => {
    novoBanco(DADOS());
    ia(() => { throw new Error('não deveria chamar a IA'); });
    const r = await diz(undefined, null, { text: undefined, audio: { audioUrl: 'https://x/a.ogg', mimeType: 'audio/ogg' } });
    assert.match(r, /escreve/i);
  });
  test('IA fora do ar: avisa, sem gravar nada', async () => {
    novoBanco(DADOS());
    ia(() => { throw new Error('529 overloaded'); });
    assert.match(await diz('+dj Ana 15/11'), /Não consegui falar com a IA/);
    assert.equal(banco().t('deals').length, 0);
  });
});

describe('canal do dono: oportunidades', () => {
  test('"+dj Anabela 15/11 3500": cria contato e oportunidade com próxima ação; recibo com os dados', async () => {
    novoBanco(DADOS());
    const r = await diz('+dj Anabela 15/11 3500 casamento', { acao: 'criar_oportunidade', negocio: 'dj', cliente: 'Anabela', data: '2026-11-15', valor: 3500, titulo: 'Casamento' });
    const d = banco().t('deals')[0];
    assert.equal(d.titulo, 'DJ — Anabela');
    assert.equal(d.etapa, 'lead');
    assert.equal(d.valor, 3500);
    assert.equal(d.data_evento, '2026-11-15');
    assert.equal(d.notas, 'Casamento');
    assert.equal(d.proxima_acao, 'Enviar orçamento');
    assert.equal(d.data_proxima_acao, '2026-10-20');
    assert.equal(banco().t('contacts')[0].nome, 'Anabela');
    assert.equal(banco().t('contacts')[0].tipo, 'contratante');
    assert.match(r, /Oportunidade criada: \*DJ — Anabela\*/);
    assert.match(r, /domingo, 15\/11/);
    assert.match(r, /R\$ 3\.500/);
    assert.match(r, /Contato novo/);
    assert.match(r, /desfaz/);
    assert.equal(chamadasPara('https://projeto.supabase.co/functions/v1/gcal-sync').length, 0, 'lead não vai para o Google Agenda');
  });
  test('usa o contato que já existe ("Anabela" → "Anabela Souza"); "fechei" com sinal recebido registra o pagamento e sincroniza a agenda', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Anabela Souza' }, { id: 'c2', nome: 'Ana' }] }));
    const r = await diz('fechei o casamento da anabela dia 15/11 por 4 mil, recebi 2 mil de sinal', { acao: 'criar_oportunidade', negocio: 'dj', cliente: 'Anabela', data: '2026-11-15', valor: 4000, recebido: 2000, etapa: 'fechado' });
    const d = banco().t('deals')[0];
    assert.equal(d.contato_id, 'c1');
    assert.equal(d.titulo, 'DJ — Anabela Souza');
    assert.equal(d.etapa, 'fechado');
    assert.equal(d.proxima_acao, 'Confirmar detalhes do evento');
    assert.deepEqual(d.pagamentos.map(p => p.valor), [2000]);
    assert.equal(banco().t('contacts').length, 2, 'não criou contato novo');
    assert.match(r, /falta R\$ 2\.000/);
    assert.equal(chamadasPara('https://projeto.supabase.co/functions/v1/gcal-sync').length, 1);
  });
  test('sem nome do cliente: pergunta, sem gravar', async () => {
    novoBanco(DADOS());
    assert.match(await diz('+dj 15/11', { acao: 'criar_oportunidade', data: '2026-11-15' }), /nome do cliente/);
    assert.equal(banco().t('deals').length, 0);
  });
});

describe('canal do dono: pagamentos', () => {
  const DEAL = (x = {}) => ({ id: 'd1', titulo: 'DJ — Anabela Souza', negocio: 'dj', etapa: 'fechado', contato_id: 'c1', valor: 3500, data_evento: '2026-11-15', pagamentos: [], ...x });
  test('"recebi 1750 da Anabela no pix": acrescenta o pagamento e diz quanto falta', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Anabela Souza' }], deals: [DEAL()] }));
    const r = await diz('recebi 1750 da anabela no pix', { acao: 'registrar_pagamento', cliente: 'anabela', valor: 1750, forma: 'Pix' });
    assert.deepEqual(banco().t('deals')[0].pagamentos.map(p => [p.valor, p.forma, p.data]), [[1750, 'Pix', HOJE]]);
    assert.match(r, /R\$ 1\.750 de R\$ 3\.500 · falta R\$ 1\.750/);
  });
  test('"recebeu o resto" sem valor quita o saldo; realizado quitado vira Pago', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Anabela Souza' }], deals: [DEAL({ etapa: 'realizado', pagamentos: [{ data: '2026-10-01', valor: 1750, forma: 'Pix' }], proxima_acao: 'Cobrar pagamento', data_proxima_acao: HOJE })] }));
    const r = await diz('a anabela pagou o resto', { acao: 'registrar_pagamento', cliente: 'Anabela' });
    const d = banco().t('deals')[0];
    assert.equal(d.pagamentos.at(-1).valor, 1750);
    assert.equal(d.etapa, 'pago');
    assert.equal(d.proxima_acao, null);
    assert.match(r, /quitado/);
  });
  test('duas oportunidades abertas com saldo: pergunta qual, sem gravar', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Anabela Souza' }], deals: [DEAL(), DEAL({ id: 'd2', data_evento: '2026-12-20' })] }));
    const r = await diz('recebi 500 da anabela', { acao: 'registrar_pagamento', cliente: 'Anabela', valor: 500 });
    assert.match(r, /Achei 2 oportunidades/);
    assert.ok(banco().t('deals').every(d => !d.pagamentos.length));
  });
  test('cliente sem oportunidade aberta: avisa', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Anabela Souza' }], deals: [DEAL({ etapa: 'pago' })] }));
    assert.match(await diz('recebi 500 do marcos', { acao: 'registrar_pagamento', cliente: 'Marcos', valor: 500 }), /Não achei oportunidade aberta de "Marcos"/);
  });
  test('"Ana" não casa com "Anabela"', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Anabela Souza' }], deals: [DEAL()] }));
    assert.match(await diz('recebi 500 da ana', { acao: 'registrar_pagamento', cliente: 'Ana', valor: 500 }), /Não achei/);
  });
});

describe('canal do dono: gastos e tarefas', () => {
  test('"gastei 120 de faxina na Frida": lançamento provisório de Aluguéis na casa', async () => {
    novoBanco(DADOS());
    const r = await diz('gastei 120 de faxina na frida', { acao: 'lancar_gasto', valor: 120, titulo: 'Faxina', categoria: 'Faxina e limpeza', casa: 'QS39', negocio: 'aluguel' });
    const t = banco().t('fin_tx')[0];
    assert.match(t.id, /^wa-/);
    assert.deepEqual([t.valor, t.data, t.categoria, t.negocio, t.casa, t.manual, t.conta_id], [-120, HOJE, 'Faxina e limpeza', 'alugueis', 'QS39', true, null]);
    assert.match(r, /R\$ 120 · Faxina/);
    assert.match(r, /Casa Frida/);
  });
  test('categoria fora da lista vira "Outros"', async () => {
    novoBanco(DADOS());
    await diz('uber 25', { acao: 'lancar_gasto', valor: 25, titulo: 'Uber', categoria: 'Mobilidade' });
    assert.equal(banco().t('fin_tx')[0].categoria, 'Outros');
  });
  test('"me lembra de ligar pro contador amanhã" vira tarefa com prazo', async () => {
    novoBanco(DADOS());
    const r = await diz('me lembra de ligar pro contador amanhã', { acao: 'criar_tarefa', titulo: 'Ligar para o contador', data: '2026-10-20', area: 'pessoal' });
    const t = banco().t('tasks')[0];
    assert.deepEqual([t.titulo, t.prazo, t.area, t.prioridade, t.feito], ['Ligar para o contador', '2026-10-20', 'pessoal', 2, false]);
    assert.match(r, /amanhã/);
  });
  test('"liguei pro contador" conclui a tarefa parecida', async () => {
    novoBanco(DADOS({ tasks: [{ id: 't1', titulo: 'Ligar para o contador', feito: false }, { id: 't2', titulo: 'Comprar cabo XLR', feito: false }] }));
    const r = await diz('liguei pro contador', { acao: 'concluir_tarefa', titulo: 'ligar contador' });
    assert.equal(banco().t('tasks').find(t => t.id === 't1').feito, true);
    assert.equal(banco().t('tasks').find(t => t.id === 't2').feito, false);
    assert.match(r, /Concluída: Ligar para o contador/);
  });
});

describe('canal do dono: desfazer e corrigir', () => {
  test('"desfaz" apaga a oportunidade criada e o contato novo', async () => {
    novoBanco(DADOS());
    await diz('+dj Anabela 15/11', { acao: 'criar_oportunidade', cliente: 'Anabela', data: '2026-11-15' });
    const r = await diz('desfaz', { acao: 'desfazer' });
    assert.equal(banco().t('deals').length, 0);
    assert.equal(banco().t('contacts').length, 0);
    assert.match(r, /Desfeito: Oportunidade criada/);
    assert.match(await diz('desfaz', { acao: 'desfazer' }), /nada para desfazer/);
  });
  test('"desfaz" depois de um pagamento volta os pagamentos e a etapa de antes', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Anabela Souza' }], deals: [{ id: 'd1', titulo: 'DJ — Anabela Souza', negocio: 'dj', etapa: 'realizado', contato_id: 'c1', valor: 1000, pagamentos: [], proxima_acao: 'Cobrar pagamento', data_proxima_acao: HOJE }] }));
    await diz('recebi 1000 da anabela', { acao: 'registrar_pagamento', cliente: 'Anabela', valor: 1000 });
    assert.equal(banco().t('deals')[0].etapa, 'pago');
    await diz('desfaz', { acao: 'desfazer' });
    const d = banco().t('deals')[0];
    assert.deepEqual([d.etapa, d.pagamentos.length, d.proxima_acao], ['realizado', 0, 'Cobrar pagamento']);
  });
  test('"o valor é 3800" corrige a oportunidade; a IA recebe o último registro como contexto', async () => {
    novoBanco(DADOS());
    await diz('+dj Anabela 15/11 3500', { acao: 'criar_oportunidade', cliente: 'Anabela', data: '2026-11-15', valor: 3500 });
    const r = await diz('o valor é 3800', { acao: 'corrigir', valor: 3800 });
    assert.equal(banco().t('deals')[0].valor, 3800);
    assert.match(r, /valor: R\$ 3\.500 → R\$ 3\.800/);
    assert.match(globalThis.__anthropic.chamadas[0].system, /Último registro feito por você.*DJ — Anabela/s);
    // desfazer depois de corrigir apaga o registro (volta ao estado de antes de tudo)
    await diz('desfaz', { acao: 'desfazer' });
    assert.equal(banco().t('deals').length, 0);
  });
  test('corrigir pagamento: troca valor e forma do pagamento que o canal registrou', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Anabela Souza' }], deals: [{ id: 'd1', titulo: 'DJ — Anabela Souza', negocio: 'dj', etapa: 'fechado', contato_id: 'c1', valor: 3500, pagamentos: [{ data: '2026-10-01', valor: 500, forma: 'Pix' }] }] }));
    await diz('recebi 1750 da anabela', { acao: 'registrar_pagamento', cliente: 'Anabela', valor: 1750 });
    await diz('foi 1800 em dinheiro', { acao: 'corrigir', valor: 1800, forma: 'Dinheiro' });
    assert.deepEqual(banco().t('deals')[0].pagamentos.map(p => [p.valor, p.forma]), [[500, 'Pix'], [1800, 'Dinheiro']]);
  });
  test('corrigir gasto: casa nova leva o negócio para Aluguéis', async () => {
    novoBanco(DADOS());
    await diz('gastei 80 de gás', { acao: 'lancar_gasto', valor: 80, titulo: 'Gás', categoria: 'Contas da casa' });
    await diz('é da casa azul', { acao: 'corrigir', casa: 'QS40' });
    const t = banco().t('fin_tx')[0];
    assert.deepEqual([t.casa, t.negocio], ['QS40', 'alugueis']);
  });
  test('ações de mais de 24 h não são desfeitas', async () => {
    novoBanco(DADOS({ tasks: [{ id: 't1', titulo: 'Antiga', feito: false }],
      dono_acoes: [{ id: 'a1', acao: 'criar_tarefa', tabela: 'tasks', registro_id: 't1', antes: null, depois: {}, resumo: '📝 Tarefa: Antiga', desfeita_em: null, criado_em: '2026-10-17T12:00:00Z' }] }));
    assert.match(await diz('desfaz', { acao: 'desfazer' }), /nada para desfazer/);
    assert.equal(banco().t('tasks').length, 1);
  });
});

describe('canal do dono: consultas', () => {
  const AGENDA = () => DADOS({
    contacts: [{ id: 'c1', nome: 'Júlia' }],
    deals: [
      { id: 'g1', titulo: 'DJ — Júlia', negocio: 'dj', etapa: 'fechado', data_evento: HOJE, hora_inicio: '21:00:00', local: 'Pipa Beach', valor: 4000, pagamentos: [{ valor: 1000 }], proxima_acao: 'Confirmar detalhes', data_proxima_acao: '2026-10-25' },
      { id: 'd2', titulo: 'Aluguéis — Eduardo', negocio: 'aluguel', etapa: 'lead', proxima_acao: 'Responder WhatsApp', data_proxima_acao: '2026-10-17' },
    ],
    tasks: [{ id: 't1', titulo: 'Pagar IPTU', feito: false, prazo: '2026-10-18', prioridade: 1 }, { id: 't2', titulo: 'Futuro', feito: false, prazo: '2026-10-30' }],
    bookings: [
      { id: 'b1', property_id: 'QS39', checkin: HOJE, checkout: '2026-10-22', hospede: 'Ana', status: 'confirmada', origem: 'airbnb' },
      { id: 'b2', property_id: 'QS40', checkin: '2026-10-15', checkout: HOJE, hospede: 'Bruno', status: 'confirmada', origem: 'direto' },
      { id: 'b3', property_id: 'QS50', checkin: HOJE, checkout: '2026-10-21', status: 'cancelada' },
    ],
    events: [{ id: 'e1', titulo: 'Dentista', inicio: '2026-10-19T17:00:00Z', fim: '2026-10-19T18:00:00Z', dia_inteiro: false }],
  });
  test('"o que tenho hoje?": agenda em ordem, casas, pendências com atraso e nada cancelado', async () => {
    novoBanco(AGENDA());
    const r = await diz('o que tenho hoje?', { acao: 'consultar', consulta: 'hoje' });
    assert.match(r, /14:00 Dentista[\s\S]*21:00 DJ — Júlia \(Pipa Beach\)/);
    assert.match(r, /Entra: Casa Frida — Ana \(até 22\/10, airbnb\)/);
    assert.match(r, /Sai: Casa Azul — Bruno/);
    assert.doesNotMatch(r, /Terracota/);
    assert.match(r, /Aluguéis — Eduardo: Responder WhatsApp \(2 dias atrasada\)/);
    assert.match(r, /Tarefa: Pagar IPTU ❗ \(1 dia atrasada\)/);
    assert.doesNotMatch(r, /Futuro/);
  });
  test('"quem me deve?": saldo das oportunidades fechadas', async () => {
    novoBanco(AGENDA());
    const r = await diz('quem me deve?', { acao: 'consultar', consulta: 'quem_deve' });
    assert.match(r, /A receber: R\$ 3\.000 \(1\)/);
    assert.match(r, /Júlia: R\$ 3\.000/);
  });
  test('"a Terracota tá livre 20 a 23/11 pra 4?": consulta a airbnb-quote só dessa casa', async () => {
    novoBanco(DADOS());
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', { mensagem: 'Olá! Para 20/11 a 23/11:\n• Casa Terracota: disponível, R$ 1.350 no total' });
    const r = await diz('terracota livre 20 a 23/11 pra 4?', { acao: 'consultar', consulta: 'casas_livres', checkin: '2026-11-20', checkout: '2026-11-23', pessoas: 4, casa: 'QS50' });
    const c = chamadasPara('https://projeto.supabase.co/functions/v1/airbnb-quote')[0].json();
    assert.deepEqual(c, { checkin: '2026-11-20', checkout: '2026-11-23', adultos: 4, casas: ['QS50'] });
    assert.match(r, /Casa Terracota: disponível, R\$ 1\.350/);
    assert.doesNotMatch(r, /Olá!/);
  });
  test('consulta não vira registro (desfaz não tem o que desfazer)', async () => {
    novoBanco(AGENDA());
    await diz('o que tenho hoje?', { acao: 'consultar', consulta: 'hoje' });
    assert.equal(banco().t('dono_acoes').length, 0);
  });
});

describe('canal do dono: modo teste', () => {
  test('x-hub-cron com o número do dono roda o comando sem enviar', async () => {
    novoBanco(DADOS());
    ia({ acao: 'criar_tarefa', titulo: 'Testar canal' });
    const r = await fn(pedido('/wa-webhook', { corpo: { teste: { wa_id: DONO, texto: 'testar canal' } }, auth: 'cron' }));
    const j = await r.json();
    assert.equal(j.dono, true);
    assert.equal(j.acao, 'criar_tarefa');
    assert.equal(enviadas().length, 0);
    assert.equal(banco().t('tasks').length, 1);
  });
});
