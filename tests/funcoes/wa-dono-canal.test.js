// Canal do dono (wa-webhook + _shared/dono.ts): o Claudio manda mensagem do número pessoal para o WhatsApp das casas
// e o Hub trata como comando. IA simulada devolve o comando; o teste confere o que foi gravado e o recibo enviado.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';
import { z } from 'zod';

const ENV = { WA_AGRUPAR_S: '0', ANTHROPIC_API_KEY: 'sk-teste', ZAPI_INSTANCE: 'INST1', ZAPI_TOKEN: 'tok1', ZAPI_CLIENT_TOKEN: 'cli1', ZAPI_WEBHOOK_KEY: 'chave-z' };
const DONO = '5584996011991';
const ZURL = /api\.z-api\.io\/instances\/INST1\/token\/tok1\/send-text/;
const HOJE = '2026-10-19'; // segunda (relógio parado dos testes)

// Comando completo que a IA devolveria (structured output, sem null: "" / 0 / "nenhum"): o teste diz só o que importa
const CMD = x => ({ acao: 'conversa', negocio: 'nenhum', cliente: '', valor: 0, recebido: 0, data: '', hora: '', local: '', titulo: '', etapa: 'nenhum',
  forma: 'nenhum', categoria: '', casa: 'nenhum', area: 'nenhum', prioridade: 0, consulta: 'nenhum', checkin: '', checkout: '', pessoas: 0, resposta: '', ...x });
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
    assert.equal(r, 'Oi, Claudio!', 'cumprimento: resposta curta, sem a lista de exemplos');
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
  test('IA fora do ar: avisa com o motivo, sem gravar nada', async () => {
    novoBanco(DADOS());
    ia(() => { throw new Error('529 overloaded'); });
    const r = await diz('+dj Ana 15/11');
    assert.match(r, /Não consegui falar com a IA/);
    assert.match(r, /529 overloaded/);
    assert.equal(banco().t('deals').length, 0);
  });
  test('esquema da IA sem campos de tipo união (a API recusa mais de 16; nullable conta)', async () => {
    novoBanco(DADOS());
    await diz('oi', { acao: 'conversa' });
    const json = JSON.stringify(z.toJSONSchema(globalThis.__anthropic.chamadas[0].output_config.format.schema));
    assert.equal((json.match(/"anyOf"|"type":\[/g) || []).length, 0);
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

describe('canal do dono: a receber', () => {
  test('"tenho a receber 1300 do NAMI" sem oportunidade: cria como Realizado com "Cobrar pagamento"', async () => {
    novoBanco(DADOS());
    const r = await diz('tenho a receber 1300 do NAMI', { acao: 'a_receber', cliente: 'NAMI', valor: 1300 });
    const d = banco().t('deals')[0];
    assert.deepEqual([d.titulo, d.etapa, d.valor, d.proxima_acao, d.data_proxima_acao], ['DJ — NAMI', 'realizado', 1300, 'Cobrar pagamento', '2026-10-20']);
    assert.match(r, /A receber: R\$ 1\.300 de \*DJ — NAMI\*/);
    await diz('o valor é 1350', { acao: 'corrigir', valor: 1350 });
    assert.equal(banco().t('deals')[0].valor, 1350);
    await diz('desfaz', { acao: 'desfazer' });
    assert.equal(banco().t('deals').length, 0);
  });
  test('oportunidade aberta sem valor: preenche o valor; com valor: mostra o saldo, sem mexer', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Nami' }], deals: [{ id: 'd1', titulo: 'DJ — Nami', negocio: 'dj', etapa: 'realizado', contato_id: 'c1', valor: null, pagamentos: [] }] }));
    await diz('o nami me deve 1300', { acao: 'a_receber', cliente: 'Nami', valor: 1300 });
    assert.equal(banco().t('deals')[0].valor, 1300);
    assert.equal(banco().t('deals').length, 1);
    banco().t('deals')[0].pagamentos = [{ valor: 300 }];
    const r = await diz('tenho a receber 900 do nami', { acao: 'a_receber', cliente: 'Nami', valor: 900 });
    assert.match(r, /já está no Hub: R\$ 300 recebido de R\$ 1\.300 · falta R\$ 1\.000/);
    assert.match(r, /Se o certo é faltar R\$ 900/);
    assert.equal(banco().t('deals')[0].valor, 1300);
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
    assert.match(r, /14:00–15:00 Dentista[\s\S]*21:00 DJ — Júlia \(Pipa Beach\)/);
    assert.match(r, /Entra: Casa Frida — Ana \(até 22\/10, airbnb\)/);
    assert.match(r, /Sai: Casa Azul — Bruno/);
    assert.doesNotMatch(r, /Terracota/);
    assert.match(r, /• Eduardo: responder no WhatsApp \(atraso de 2 dias\)/);
    assert.match(r, /Tarefa: Pagar IPTU ❗ \(atraso de 1 dia\)/);
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

// IA falsa que distingue a leitura de arquivo (mensagem com imagem/PDF) do comando de texto
const iaDupla = (doc, cmd) => { globalThis.__anthropic = { chamadas: [], responder: p => Array.isArray(p.messages[0].content) ? DOC(doc) : CMD(typeof cmd === 'function' ? cmd(p) : cmd) }; };
const DOC = x => ({ tipo: 'comprovante', valor: 0, data: '', vencimento: '', recebedor: '', pagador: '', descricao: '', categoria: '', casa: 'nenhum', negocio: 'nenhum', ...x });
async function foto(legenda = '', { pdf = false } = {}) {
  const url = `https://midia.z-api.io/dono/${++seq}.${pdf ? 'pdf' : 'jpg'}`;
  simular(url, () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': pdf ? 'application/pdf' : 'image/jpeg' } }));
  const r = await zapi(undefined, pdf ? { text: undefined, document: { documentUrl: url, mimeType: 'application/pdf', fileName: 'boleto.pdf' } }
    : { text: undefined, image: { imageUrl: url, mimeType: 'image/jpeg', caption: legenda } });
  assert.equal(r.length, 1);
  return r[0].message;
}

describe('canal do dono: foto e PDF', () => {
  test('comprovante de Pix que ele pagou: propõe o gasto, só grava no "sim" (com a correção junto)', async () => {
    novoBanco(DADOS());
    iaDupla({ valor: 120, data: '2026-10-18', recebedor: 'MARIA SILVA', pagador: 'CLAUDIO ROBERTO SOUSA BRAGA', descricao: 'Faxina', categoria: 'Faxina e limpeza', casa: 'QS39' });
    const r = await foto('faxina frida');
    assert.match(r, /Comprovante: R\$ 120 para MARIA SILVA em 18\/10/);
    assert.match(r, /Lanço como gasto: Faxina · Faxina e limpeza · Casa Frida\?/);
    assert.match(r, /"sim"/);
    assert.equal(banco().t('fin_tx').length, 0, 'nada gravado antes do sim');
    assert.match(JSON.stringify(globalThis.__anthropic.chamadas[0].messages[0].content), /faxina frida/);
    iaDupla({}, { acao: 'confirmar', casa: 'QS40' });
    const ok = await diz('sim, mas é da casa azul');
    const t = banco().t('fin_tx')[0];
    assert.deepEqual([t.valor, t.data, t.casa, t.negocio, t.categoria], [-120, '2026-10-18', 'QS40', 'alugueis', 'Faxina e limpeza']);
    assert.match(ok, /Gasto: R\$ 120/);
    assert.equal(banco().t('wa_settings')[0].dono_pendente, null);
    assert.match(globalThis.__anthropic.chamadas[0].system, /PROPOSTA ESPERANDO.*Lanço como gasto/s);
  });
  test('comprovante recebido por ele: propõe o pagamento da oportunidade de quem pagou', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Anabela Souza' }], deals: [{ id: 'd1', titulo: 'DJ — Anabela Souza', negocio: 'dj', etapa: 'fechado', contato_id: 'c1', valor: 3500, pagamentos: [] }] }));
    iaDupla({ valor: 1750, data: '2026-10-19', recebedor: 'Claudio Roberto S Braga', pagador: 'ANABELA DE SOUZA LIMA' });
    const r = await foto();
    assert.match(r, /R\$ 1\.750 de ANABELA DE SOUZA LIMA/);
    assert.match(r, /pagamento de \*DJ — Anabela Souza\* \(falta R\$ 3\.500\)/);
    iaDupla({}, { acao: 'confirmar' });
    assert.match(await diz('sim'), /falta R\$ 1\.750/);
    assert.deepEqual(banco().t('deals')[0].pagamentos.map(p => [p.valor, p.data]), [[1750, HOJE]]);
  });
  test('comprovante recebido de quem não tem oportunidade: pede de quem é; "sim, é da Anabela" registra', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Anabela Souza' }], deals: [{ id: 'd1', titulo: 'DJ — Anabela Souza', negocio: 'dj', etapa: 'fechado', contato_id: 'c1', valor: 3500, pagamentos: [] }] }));
    iaDupla({ valor: 500, recebedor: 'CLAUDIO BRAGA', pagador: 'JOAO PEREIRA' });
    assert.match(await foto(), /Não achei oportunidade aberta dessa pessoa/);
    iaDupla({}, { acao: 'confirmar', cliente: 'Anabela' });
    await diz('sim, é da anabela');
    assert.equal(banco().t('deals')[0].pagamentos[0].valor, 500);
  });
  test('boleto: propõe tarefa com aviso no vencimento às 9h', async () => {
    novoBanco(DADOS());
    iaDupla({ tipo: 'boleto', valor: 312.4, vencimento: '2026-10-25', recebedor: 'COSERN', descricao: 'Conta de luz Cosern', casa: 'QS50' });
    const r = await foto('', { pdf: true });
    assert.match(r, /Boleto: Conta de luz Cosern · R\$ 312,40 · vence domingo, 25\/10/);
    assert.match(r, /aviso no dia do vencimento às 9h/);
    iaDupla({}, { acao: 'confirmar' });
    await diz('pode');
    const t = banco().t('tasks')[0];
    assert.deepEqual([t.titulo, t.prazo, t.lembrete_em, t.prioridade, t.area], ['Pagar Conta de luz Cosern (R$ 312,40)', '2026-10-25', '2026-10-25T12:00:00.000Z', 1, 'alugueis']);
  });
  test('"não" descarta; pedir outra coisa também descarta (um "sim" depois não grava o antigo)', async () => {
    novoBanco(DADOS());
    iaDupla({ valor: 80, recebedor: 'POSTO', descricao: 'Gasolina', categoria: 'Combustível' });
    await foto();
    iaDupla({}, { acao: 'cancelar' });
    assert.equal(await diz('não'), 'Ok, descartei.');
    iaDupla({ valor: 80, recebedor: 'POSTO', descricao: 'Gasolina', categoria: 'Combustível' });
    await foto();
    iaDupla({}, { acao: 'consultar', consulta: 'pendencias' });
    await diz('pendências?');
    iaDupla({}, { acao: 'confirmar' });
    assert.match(await diz('sim'), /Não tem nada esperando/);
    assert.equal(banco().t('fin_tx').length, 0);
  });
  test('arquivo que não é comprovante nem boleto: avisa, sem proposta', async () => {
    novoBanco(DADOS());
    iaDupla({ tipo: 'outro' });
    assert.match(await foto(), /Não reconheci/);
    assert.equal(banco().t('wa_settings')[0].dono_pendente ?? null, null);
  });
  test('download falhou: avisa', async () => {
    novoBanco(DADOS());
    iaDupla({ valor: 10 });
    const r = await zapi(undefined, { text: undefined, image: { imageUrl: 'https://midia.z-api.io/sumiu.jpg', mimeType: 'image/jpeg' } });
    assert.match(r[0].message, /Não consegui ler o arquivo/);
  });
});

describe('canal do dono: áudio', () => {
  const audio = async () => {
    const url = `https://midia.z-api.io/dono/${++seq}.ogg`;
    simular(url, () => new Response(new Uint8Array([9, 9]), { headers: { 'content-type': 'audio/ogg; codecs=opus' } }));
    const r = await zapi(undefined, { text: undefined, audio: { audioUrl: url, mimeType: 'audio/ogg; codecs=opus' } });
    assert.equal(r.length, 1);
    return r[0].message;
  };
  test('com GROQ_API_KEY: transcreve, mostra o que entendeu e executa', async () => {
    novoBanco(DADOS());
    definirEnv('GROQ_API_KEY', 'gsk-teste');
    simular('https://api.groq.com/openai/v1/audio/transcriptions', { text: 'me lembra de ligar pro contador amanhã' });
    ia({ acao: 'criar_tarefa', titulo: 'Ligar para o contador', data: '2026-10-20' });
    const r = await audio();
    assert.match(r, /^🎙️ _"me lembra de ligar pro contador amanhã"_/);
    assert.match(r, /Tarefa: Ligar para o contador/);
    const g = chamadasPara('https://api.groq.com/openai/v1/audio/transcriptions')[0];
    assert.equal(g.headers.authorization, 'Bearer gsk-teste');
    assert.match(globalThis.__anthropic.chamadas[0].messages[0].content, /ligar pro contador amanhã/);
    definirEnv('GROQ_API_KEY', undefined);
  });
  test('sem chave de transcrição: explica e não chama a IA', async () => {
    novoBanco(DADOS());
    ia(() => { throw new Error('não deveria chamar a IA'); });
    assert.match(await audio(), /falta a chave de transcrição/);
  });
  test('transcrição recusada: mostra o motivo', async () => {
    novoBanco(DADOS());
    definirEnv('GROQ_API_KEY', 'gsk-teste');
    simular('https://api.groq.com/openai/v1/audio/transcriptions', { status: 401, json: { error: { message: 'Invalid API Key' } } });
    assert.match(await audio(), /transcrição 401: Invalid API Key/);
    definirEnv('GROQ_API_KEY', undefined);
  });
});

describe('canal do dono: lembretes com hora', () => {
  test('"me lembra às 15h de ligar pro contador": tarefa hoje com aviso às 15h (horário de Pipa)', async () => {
    novoBanco(DADOS());
    const r = await diz('me lembra às 15h de ligar pro contador', { acao: 'criar_tarefa', titulo: 'Ligar para o contador', hora: '15:00' });
    const t = banco().t('tasks')[0];
    assert.deepEqual([t.titulo, t.prazo, t.lembrete_em, t.lembrete_enviado_em], ['Ligar para o contador', HOJE, '2026-10-19T18:00:00.000Z', null]);
    assert.match(r, /hoje · ⏰ aviso às 15:00 aqui/);
    assert.match(globalThis.__anthropic.chamadas[0].system, /agora são 12:00/);
  });
  test('hora que já passou hoje, sem data: vai para amanhã', async () => {
    novoBanco(DADOS());
    await diz('me lembra às 9h de regar', { acao: 'criar_tarefa', titulo: 'Regar as plantas', hora: '09:00' });
    assert.deepEqual([banco().t('tasks')[0].prazo, banco().t('tasks')[0].lembrete_em], ['2026-10-20', '2026-10-20T12:00:00.000Z']);
  });
  test('data de hoje com hora que já passou: cria sem aviso e avisa', async () => {
    novoBanco(DADOS());
    const r = await diz('hoje às 8h', { acao: 'criar_tarefa', titulo: 'X', data: HOJE, hora: '08:00' });
    assert.equal(banco().t('tasks')[0].lembrete_em, null);
    assert.match(r, /esse horário já passou/);
  });
  test('"era às 16h" corrige o aviso', async () => {
    novoBanco(DADOS());
    await diz('me lembra às 15h', { acao: 'criar_tarefa', titulo: 'Ligar', hora: '15:00' });
    const r = await diz('era às 16h', { acao: 'corrigir', hora: '16:00' });
    assert.equal(banco().t('tasks')[0].lembrete_em, '2026-10-19T19:00:00.000Z');
    assert.match(r, /aviso: hoje 15:00 → hoje 16:00/);
  });
  test('"adia 1h" depois do lembrete: novo aviso; "desfaz" volta', async () => {
    novoBanco(DADOS({ tasks: [{ id: 't1', titulo: 'Ligar para o contador', feito: false, prazo: HOJE, lembrete_em: '2026-10-19T14:55:00Z', lembrete_enviado_em: '2026-10-19T14:55:00Z' }] }));
    const r = await diz('adia 1h', { acao: 'adiar', data: HOJE, hora: '13:00' });
    const t = banco().t('tasks')[0];
    assert.deepEqual([t.lembrete_em, t.lembrete_enviado_em], ['2026-10-19T16:00:00.000Z', null]);
    assert.match(r, /Adiado: Ligar para o contador → hoje às 13:00/);
    assert.match(globalThis.__anthropic.chamadas[0].system, /Último lembrete enviado a ele.*Ligar para o contador/s);
    await diz('desfaz', { acao: 'desfazer' });
    assert.equal(banco().t('tasks')[0].lembrete_enviado_em, '2026-10-19T14:55:00Z');
  });
  test('"feito" sem dizer qual conclui a tarefa do último lembrete', async () => {
    novoBanco(DADOS({ tasks: [{ id: 't1', titulo: 'Ligar para o contador', feito: false, lembrete_enviado_em: '2026-10-19T14:55:00Z' }, { id: 't2', titulo: 'Outra', feito: false }] }));
    assert.match(await diz('feito', { acao: 'concluir_tarefa' }), /Concluída: Ligar para o contador/);
    assert.equal(banco().t('tasks').find(t => t.id === 't1').feito, true);
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
