// Edge Function wa-webhook: WhatsApp das casas → oportunidade no Pipeline, IA (simulada) que entende o pedido,
// cotação pela airbnb-quote (simulada) e resposta automática pela Cloud API (simulada). Ecos silenciam o robô.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { carregarFuncao, pedido, lerJson, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let fn;
const ENV = { WA_VERIFY_TOKEN: 'verifica', WA_APP_SECRET: 'segredo-app', WA_TOKEN: 'token-wa', ANTHROPIC_API_KEY: 'sk-teste' };
const WA = '5584991118864';
const IA = (x = {}) => ({ assunto: 'disponibilidade_preco', casa: 'qualquer', checkin: null, checkout: null, noites: null, hospedes: null, datas_exatas: false, resumo: 'Quer saber valores', ...x });
const responderIA = x => { globalThis.__anthropic = { chamadas: [], responder: typeof x === 'function' ? x : () => x }; };
const COTACAO = {
  checkin: '2026-11-17', checkout: '2026-11-20', noites: 3, adultos: 6,
  casas: [{ id: 'QS40', nome: 'Casa Azul', status: 'livre', total: 1650 }, { id: 'QS39', nome: 'Casa Frida', status: 'ocupada' }],
  mensagem: 'Olá! Para 17/11 a 20/11 (3 noites, 6 hóspedes):\n• Casa Azul: disponível, R$ 1.650 no total',
};
const DADOS = (x = {}) => comCron({
  properties: [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }, { id: 'QS50', nome: 'Casa Terracota' }],
  wa_settings: [{ id: 1, bot_ativo: true, horas_silencio: 12, max_respostas_dia: 4 }],
  ...x,
});
const teste = (t, auth = 'cron') => fn(pedido('/wa-webhook', { corpo: { teste: { wa_id: WA, nome: 'Ana Lima', ...t } }, auth })).then(lerJson);
const assinar = raw => 'sha256=' + createHmac('sha256', ENV.WA_APP_SECRET).update(raw).digest('hex');
function webhook(valor, field = 'messages', { assinatura } = {}) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field, value: { metadata: { phone_number_id: '1414553548401411' }, ...valor } }] }] });
  return fn(pedido('/wa-webhook', { corpo: raw, auth: null, headers: { 'x-hub-signature-256': assinatura ?? assinar(raw), 'content-type': 'application/json' } }));
}
const msgCliente = (texto, x = {}) => ({ contacts: [{ wa_id: WA, profile: { name: 'Ana Lima' } }], messages: [{ from: WA, id: 'wamid.' + Math.random(), timestamp: String(Date.parse('2026-10-19T14:59:00Z') / 1000), type: 'text', text: { body: texto }, ...x }] });
const deal = () => banco().t('deals')[0];
before(async () => { fn = await carregarFuncao('wa-webhook', ENV); });
const ZAPI = { ZAPI_INSTANCE: 'INST1', ZAPI_TOKEN: 'tok1', ZAPI_CLIENT_TOKEN: 'cli1', ZAPI_WEBHOOK_KEY: 'chave-z' };
beforeEach(() => {
  limparRede();
  for (const [k, v] of Object.entries(ENV)) definirEnv(k, v);
  for (const k of ['WA_PHONE_ID', ...Object.keys(ZAPI)]) definirEnv(k, undefined);
});

describe('wa-webhook: Meta (verificação, assinatura)', () => {
  test('verificação do webhook (GET) com o token certo devolve o desafio', async () => {
    novoBanco(DADOS());
    const ok = await fn(pedido('/wa-webhook?hub.mode=subscribe&hub.verify_token=verifica&hub.challenge=123', { metodo: 'GET', auth: null }));
    assert.deepEqual([ok.status, await ok.text()], [200, '123']);
    const nao = await fn(pedido('/wa-webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=123', { metodo: 'GET', auth: null }));
    assert.equal(nao.status, 403);
  });
  test('outros métodos: 405', async () => {
    assert.equal((await fn(pedido('/wa-webhook', { metodo: 'PUT', corpo: {}, auth: null }))).status, 405);
  });
  test('assinatura ausente ou errada: 401, nada é gravado', async () => {
    novoBanco(DADOS());
    assert.equal((await webhook(msgCliente('oi'), 'messages', { assinatura: '' })).status, 401);
    assert.equal((await webhook(msgCliente('oi'), 'messages', { assinatura: 'sha256=' + 'a'.repeat(64) })).status, 401);
    assert.equal(banco().t('wa_messages').length, 0);
  });
  test('modo teste: precisa do x-hub-cron certo e de wa_id + texto', async () => {
    novoBanco(DADOS());
    assert.equal((await fn(pedido('/wa-webhook', { corpo: { teste: { wa_id: WA, texto: 'oi' } }, auth: null, headers: { 'x-hub-cron': 'errado' } }))).status, 401);
    assert.equal((await fn(pedido('/wa-webhook', { corpo: { teste: { wa_id: WA } }, auth: 'cron' }))).status, 400);
  });
});

describe('wa-webhook: conversa e oportunidade', () => {
  test('mensagem nova cria contato, conversa e oportunidade de Aluguéis "Responder WhatsApp"', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'outro', resumo: 'Pergunta sobre pet' }));
    const { corpo } = await teste({ texto: 'Aceitam cachorro?' });
    assert.deepEqual([corpo.respondeu, corpo.motivo], [false, 'assunto "outro": fica para você']);
    const c = banco().t('contacts')[0];
    assert.deepEqual([c.nome, c.telefone, c.tipo], ['Ana Lima', '(84) 99111-8864', 'cliente']);
    const d = deal();
    assert.deepEqual([d.titulo, d.negocio, d.etapa, d.contato_id, d.data_proxima_acao], ['Aluguéis — Ana Lima', 'aluguel', 'lead', c.id, '2026-10-19']);
    assert.equal(d.proxima_acao, 'Responder WhatsApp: Pergunta sobre pet');
    const wc = banco().t('wa_contacts')[0];
    assert.deepEqual([wc.wa_id, wc.deal_id, wc.contato_id, wc.nome], [WA, d.id, c.id, 'Ana Lima']);
    const m = banco().t('wa_messages')[0];
    assert.deepEqual([m.direcao, m.autor, m.texto, m.deal_id], ['in', 'cliente', 'Aceitam cachorro?', d.id]);
    assert.equal(m.extracao.resumo, 'Pergunta sobre pet');
  });
  test('telefone já cadastrado (últimos 8 dígitos, mesmo sem o 9) reaproveita o contato', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c9', nome: 'Ana (cliente antiga)', telefone: '(84) 9111-8864' }] }));
    responderIA(IA({ assunto: 'outro' }));
    await teste({ texto: 'oi' });
    assert.equal(banco().t('contacts').length, 1);
    assert.equal(deal().contato_id, 'c9');
    assert.equal(deal().titulo, 'Aluguéis — Ana (cliente antiga)');
  });
  test('oportunidade já fechada/perdida: a nova conversa abre outra', async () => {
    novoBanco(DADOS({ contacts: [{ id: 'c1', nome: 'Ana', telefone: WA }], deals: [{ id: 'd-velho', etapa: 'perdido' }], wa_contacts: [{ wa_id: WA, deal_id: 'd-velho', contato_id: 'c1' }] }));
    responderIA(IA({ assunto: 'outro' }));
    await teste({ texto: 'oi de novo' });
    assert.equal(banco().t('deals').length, 2);
    assert.notEqual(banco().t('wa_contacts')[0].deal_id, 'd-velho');
  });
  test('mensagem repetida (mesmo wamid, reenvio da Meta) é ignorada', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'outro' }));
    const v = msgCliente('oi');
    await webhook(v);
    await webhook(v);
    assert.equal(banco().t('wa_messages').length, 1);
  });
});

describe('wa-webhook: quando o robô fica quieto', () => {
  const casos = [
    ['robô desligado em Ajustes', d => (d.wa_settings[0].bot_ativo = false), 'robô desligado em Ajustes'],
    ['robô pausado para esta pessoa', d => (d.wa_contacts = [{ wa_id: WA, bot_pausado: true }]), 'robô pausado para esta pessoa'],
    ['você respondeu à mão há pouco', d => (d.wa_contacts = [{ wa_id: WA, ultima_manual: '2026-10-19T10:00:00Z' }]), 'você respondeu à mão nas últimas 12 h'],
    ['limite de respostas em 24 h', d => (d.wa_messages = Array.from({ length: 4 }, (_, i) => ({ id: 'r' + i, wamid: 'r' + i, wa_id: WA, autor: 'robo', enviado_em: '2026-10-19T10:00:00Z' }))), 'limite de 4 respostas automáticas em 24 h'],
  ];
  for (const [nome, ajustar, motivo] of casos) test(nome, async () => {
    const d = DADOS(); ajustar(d); novoBanco(d);
    responderIA(() => { throw new Error('a IA não devia ser chamada'); });
    const { corpo } = await teste({ texto: 'Tem vaga?' });
    assert.deepEqual([corpo.respondeu, corpo.motivo], [false, motivo]);
    assert.equal(deal().proxima_acao, 'Responder WhatsApp', 'a oportunidade continua avisando você');
  });
  test('áudio/imagem: fica para você (e o texto guardado mostra o tipo e a legenda)', async () => {
    novoBanco(DADOS());
    responderIA(() => { throw new Error('não devia'); });
    await webhook(msgCliente(null, { type: 'image', text: undefined, image: { caption: 'foto da casa' } }));
    const m = banco().t('wa_messages')[0];
    assert.equal(m.texto, '[image] foto da casa');
    assert.equal(banco().t('wa_messages').length, 1);
  });
  test('a decisão do robô fica gravada na mensagem do cliente (para a aba WhatsApp)', async () => {
    novoBanco(DADOS());
    responderIA(IA());
    await teste({ texto: 'Quanto custa?' });
    assert.equal(banco().t('wa_messages').find(m => m.autor === 'cliente').extracao.robo, 'respondeu');
    const d = DADOS(); d.wa_settings[0].bot_ativo = false; novoBanco(d);
    await teste({ texto: 'oi' });
    assert.deepEqual(banco().t('wa_messages')[0].extracao, { robo: 'robô desligado em Ajustes' });
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'outro', resumo: 'Pet' }));
    await teste({ texto: 'Aceitam cachorro?' });
    const x = banco().t('wa_messages')[0].extracao;
    assert.deepEqual([x.resumo, x.robo], ['Pet', 'assunto "outro": fica para você']);
  });
  test('dúvida que a base das casas responde: o robô responde (a base vai para a IA sem senha de Wi-Fi nem Pix)', async () => {
    const base = { geral: { pets: 'Aceitamos pet pequeno.', pix_chave: 'pix@x.com' }, casas: { QS40: { wifi_senha: 'segredo', quartos: '3 suítes', localizacao: 'https://maps.app.goo.gl/azul' } } };
    novoBanco(DADOS({ app_config: [{ key: 'wa_base', value: JSON.stringify(base) }] }));
    responderIA(IA({ assunto: 'duvida', resumo: 'Pergunta sobre pet', resposta: 'Aceitamos sim, pet de pequeno porte.' }));
    const { corpo } = await teste({ texto: 'Aceitam cachorro pequeno?' });
    assert.deepEqual([corpo.respondeu, corpo.texto], [true, 'Olá! Aceitamos sim, pet de pequeno porte.']);
    const sys = globalThis.__anthropic.chamadas[0].system;
    assert.match(sys, /Pets: Aceitamos pet pequeno\./);
    assert.match(sys, /Quartos e camas: 3 suítes/);
    assert.doesNotMatch(sys, /maps\.app\.goo\.gl/, 'o robô nunca recebe o link da localização exata');
    assert.doesNotMatch(sys, /segredo|pix@x\.com/);
    assert.equal(deal().proxima_acao, 'Acompanhar: o robô respondeu uma dúvida');
    assert.equal(banco().t('wa_messages')[0].extracao.robo, 'respondeu');
  });
  test('sem base cadastrada, "duvida" fica para você', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'duvida', resposta: 'Inventei uma resposta' }));
    const { corpo } = await teste({ texto: 'Tem churrasqueira?' });
    assert.deepEqual([corpo.respondeu, corpo.motivo], [false, 'assunto "duvida": fica para você']);
    assert.match(globalThis.__anthropic.chamadas[0].system, /nenhuma informação cadastrada/);
  });
  test('cumprimento ("oi") numa conversa nova: boas-vindas com as casas e pede datas e pessoas', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'saudacao', resumo: 'Cumprimento' }));
    const { corpo } = await teste({ texto: 'oi' });
    assert.equal(corpo.respondeu, true);
    assert.equal(corpo.texto, 'Olá! Tudo bem? Aqui é o atendimento das casas Azul, Frida e Terracota, no Condomínio Pipa Natureza, em Pipa. Me diga a data de entrada, a data de saída e quantas pessoas vão se hospedar, que eu já verifico a disponibilidade e os valores.');
    assert.equal(deal().proxima_acao, 'Acompanhar: o robô pediu as datas');
    assert.match(globalThis.__anthropic.chamadas[0].system, /"saudacao": só cumprimenta/);
  });
  test('cumprimento ou "?" numa conversa em andamento: só pede as datas, sem boas-vindas', async () => {
    novoBanco(DADOS({ wa_messages: [{ id: 'r', wamid: 'r', wa_id: WA, autor: 'robo', texto: 'Oi!', enviado_em: '2026-10-19T14:00:00Z' }] }));
    responderIA(IA({ assunto: 'saudacao' }));
    assert.equal((await teste({ texto: '?' })).corpo.texto, 'Para eu verificar a disponibilidade e os valores, me diga a data de entrada, a data de saída e quantas pessoas vão se hospedar.');
  });
  test('IA fora do ar: não responde e explica', async () => {
    novoBanco(DADOS());
    responderIA(() => { throw new Error('overloaded'); });
    assert.equal((await teste({ texto: 'Tem vaga?' })).corpo.motivo, 'IA indisponível: overloaded');
  });
  test('pedido de reserva/pagamento nunca é respondido pelo robô', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'confirmar_reserva', resumo: 'Quer pagar o sinal' }));
    const { corpo } = await teste({ texto: 'Pode me mandar o pix?' });
    assert.equal(corpo.respondeu, false);
    assert.equal(deal().proxima_acao, 'Responder WhatsApp: Quer pagar o sinal');
  });
});

describe('wa-webhook: respostas automáticas', () => {
  test('sem datas: pede entrada, saída e número de pessoas', async () => {
    novoBanco(DADOS());
    responderIA(IA());
    const { corpo } = await teste({ texto: 'Quanto custa a diária?' });
    assert.equal(corpo.respondeu, true);
    assert.match(corpo.texto, /me diga a data de entrada, a data de saída e quantas pessoas/);
    assert.equal(deal().proxima_acao, 'Acompanhar: o robô pediu as datas');
    assert.equal(deal().data_proxima_acao, '2026-10-20');
    const out = banco().t('wa_messages').find(m => m.autor === 'robo');
    assert.deepEqual([out.direcao, out.texto], ['out', corpo.texto]);
    assert.equal(chamadasPara(/graph\.facebook\.com/).length, 0, 'modo teste não envia ao WhatsApp');
  });
  test('"Olá!" só ao abrir a conversa; com resposta sua ou do robô nas últimas 24 h, segue sem cumprimentar', async () => {
    const anterior = (autor, em) => ({ wa_messages: [{ id: 'p', wamid: 'p', wa_id: WA, autor, texto: 'Oi! Em que posso ajudar?', enviado_em: em }] });
    novoBanco(DADOS(anterior('robo', '2026-10-19T09:00:00Z')));
    responderIA(IA());
    assert.equal((await teste({ texto: 'quanto custa?' })).corpo.texto, 'Para eu verificar a disponibilidade e os valores, me diga a data de entrada, a data de saída e quantas pessoas vão se hospedar.');
    novoBanco(DADOS(anterior('claudio', '2026-10-19T09:00:00Z')));
    responderIA(IA({ casa: 'QS40', checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COTACAO);
    // sem o silêncio de 12 h (é sobre quem respondeu, não sobre o cumprimento)
    banco().t('wa_settings')[0].horas_silencio = 0;
    assert.equal((await teste({ texto: 'vaga 17 a 20/11, 6 pessoas?' })).corpo.texto, 'Para 17/11 a 20/11 (3 noites, 6 hóspedes):\n• Casa Azul: disponível, R$ 1.650 no total');
    novoBanco(DADOS(anterior('robo', '2026-10-17T09:00:00Z')));
    responderIA(IA());
    assert.match((await teste({ texto: 'quanto custa?' })).corpo.texto, /^Olá! Para eu verificar/);
  });
  test('data vaga (fim de semana) e sem número de pessoas: cota já e diz o que considerou', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-10-23', checkout: '2026-10-25', datas_exatas: false }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', { ...COTACAO, mensagem: 'Olá! Para 23/10 a 25/10 (2 noites, 2 hóspedes): Casa Azul livre' });
    const { corpo } = await teste({ texto: 'Tem vaga no fim de semana?' });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-10-23', checkout: '2026-10-25', adultos: 2 });
    assert.equal(corpo.texto, 'Olá! Para 23/10 a 25/10 (2 noites, 2 hóspedes): Casa Azul livre\n\nConsiderei de 23/10 a 25/10, para 2 pessoas. Se for outra data ou mais gente, me avise que eu refaço.');
    assert.equal(deal().proxima_acao, 'Acompanhar: o robô enviou disponibilidade e valores');
  });
  test('só a data de entrada ("dia 05/11, 4 pessoas"): cota 2 noites e avisa', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-11-05', hospedes: 4, datas_exatas: false }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', { ...COTACAO, mensagem: 'Para 05/11 a 07/11: Casa Azul livre' });
    const { corpo } = await teste({ texto: 'a azul, dia 05/11, 4 pessoas' });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-05', checkout: '2026-11-07', adultos: 4 });
    assert.match(corpo.texto, /\n\nConsiderei de 05\/11 a 07\/11\. Se for outra data ou mais gente, me avise que eu refaço\.$/);
  });
  test('datas exatas e pessoas informadas: sem aviso no fim', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COTACAO);
    assert.equal((await teste({ texto: '17 a 20/11, 6 pessoas' })).corpo.texto, COTACAO.mensagem);
  });
  // A 2ª chamada à IA (com <consulta_airbnb>) escreve a resposta; a 1ª extrai os dados
  const duasIAs = (extracao, redacao) => responderIA(p => (p.system.includes('<consulta_airbnb>') ? (typeof redacao === 'function' ? redacao(p) : redacao) : extracao));
  const COT2 = { checkin: '2026-11-17', checkout: '2026-11-20', noites: 3, adultos: 6,
    casas: [{ id: 'QS40', nome: 'Casa Azul', status: 'livre', total: 1650, diaria: 550 }, { id: 'QS39', nome: 'Casa Frida', status: 'ocupada', alternativa: { checkin: '2026-11-21', checkout: '2026-11-24', total: 1500, diaria: 500 } }],
    mensagem: 'Olá! Para 17/11 a 20/11: Casa Azul livre' };
  test('a IA escreve a resposta com os números da consulta (foco na casa, nome, próximo passo)', async () => {
    novoBanco(DADOS());
    duasIAs(IA({ casa: 'QS40', checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true }),
      { texto: 'Oi, Ana! A Casa Azul está livre de 17 a 20/11 para 6 pessoas: R$ 1.650 no total (R$ 550 por noite). Quer que eu reserve?' });
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COT2);
    const { corpo } = await teste({ texto: 'tem vaga na azul de 17 a 20/11 pra 6?' });
    assert.equal(corpo.texto, 'Oi, Ana! A Casa Azul está livre de 17 a 20/11 para 6 pessoas: R$ 1.650 no total (R$ 550 por noite). Quer que eu reserve?');
    const p = globalThis.__anthropic.chamadas[1];
    assert.match(p.system, /- Casa Azul: LIVRE\. Total R\$ 1\.650 \(R\$ 550 por noite\)\./);
    assert.match(p.system, /- Casa Frida: OCUPADA nessas datas\. Alternativa livre: de 21\/11 a 24\/11, total R\$ 1\.500/);
    assert.match(p.system, /comece com um cumprimento curto usando o nome Ana/);
    assert.match(p.system, /Nunca invente valor/);
  });
  test('valor que não está na consulta: descarta o texto da IA e manda a mensagem padrão', async () => {
    novoBanco(DADOS());
    duasIAs(IA({ casa: 'QS40', checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true }),
      { texto: 'A Casa Azul sai por R$ 1.400 com desconto!' });
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COT2);
    assert.equal((await teste({ texto: 'azul 17 a 20/11, 6' })).corpo.texto, 'Olá! Para 17/11 a 20/11: Casa Azul livre');
  });
  test('texto sem nenhum valor havendo casa livre, ou IA fora do ar: mensagem padrão', async () => {
    for (const redacao of [{ texto: 'Tem sim! Quer reservar?' }, () => { throw new Error('overloaded'); }]) {
      novoBanco(DADOS());
      duasIAs(IA({ checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true }), redacao);
      simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COT2);
      assert.equal((await teste({ texto: '17 a 20/11, 6' })).corpo.texto, 'Olá! Para 17/11 a 20/11: Casa Azul livre');
    }
  });
  test('conversa em andamento: a IA é instruída a não cumprimentar; o aviso do que foi considerado vai para ela', async () => {
    novoBanco(DADOS({ wa_messages: [{ id: 'r', wamid: 'r', wa_id: WA, autor: 'robo', texto: 'Oi!', enviado_em: '2026-10-19T14:00:00Z' }] }));
    duasIAs(IA({ checkin: '2026-11-17', checkout: '2026-11-20', datas_exatas: false }), { texto: 'Para o feriado, a Casa Azul fica R$ 1.650. Considerei 2 pessoas; se forem mais, me avise.' });
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COT2);
    const { corpo } = await teste({ texto: 'e no feriado?' });
    assert.equal(corpo.texto, 'Para o feriado, a Casa Azul fica R$ 1.650. Considerei 2 pessoas; se forem mais, me avise.');
    const p = globalThis.__anthropic.chamadas[1];
    assert.match(p.system, /NÃO cumprimente/);
    assert.match(p.system, /Diga também, com suas palavras: "Considerei de 17\/11 a 20\/11, para 2 pessoas\./);
  });
  test('a extração considera pessoas e casa ditas antes na conversa', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'outro' }));
    await teste({ texto: 'e no Réveillon?' });
    assert.match(globalThis.__anthropic.chamadas[0].system, /se o cliente disse antes \("somos 6"\) e não mudou, repita/);
  });
  test('a IA sabe que escolher casa/data depois dos valores é disponibilidade, não reserva', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'outro' }));
    await teste({ texto: 'a azul, dia 05/11' });
    assert.match(globalThis.__anthropic.chamadas[0].system, /"a azul, dia 05\/11".*NÃO é confirmar: é "disponibilidade_preco"/);
  });
  test('entrada + noites, sem saída: calcula a saída', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-11-17', noites: 3, hospedes: 6, datas_exatas: true }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COTACAO);
    await teste({ texto: 'dia 17/11, 3 noites, 6 pessoas' });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 6 });
  });
  test('datas exatas: cota no Airbnb (com a chave de serviço), responde e atualiza o card', async () => {
    novoBanco(DADOS());
    responderIA(IA({ casa: 'QS40', checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true, resumo: 'Vaga 17-20/11, 6 pessoas' }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COTACAO);
    const { corpo } = await teste({ texto: 'Tem vaga de 17 a 20 de novembro para 6 pessoas na Casa Azul?' });
    assert.equal(corpo.texto, COTACAO.mensagem);
    assert.equal(chamadasPara(/airbnb-quote/)[0].headers.authorization, 'Bearer service-role-teste');
    const d = deal();
    assert.deepEqual([d.etapa, d.valor, d.local, d.data_evento, d.proxima_acao], ['orcamento', 1650, 'Casa Azul', '2026-11-17', 'Acompanhar: o robô enviou disponibilidade e valores']);
    assert.deepEqual(banco().t('wa_messages').find(m => m.autor === 'robo').cotacao.casas.length, 2);
  });
  test('Airbnb falhou: não responde', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-11-17', checkout: '2026-11-20', datas_exatas: true }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', { checkin: 'x', casas: [{ status: 'erro' }], mensagem: null });
    assert.equal((await teste({ texto: 'vaga 17 a 20/11?' })).corpo.motivo, 'consulta ao Airbnb falhou: fica para você');
  });
  test('data no passado ou estadia de mais de 60 noites: pede as datas de novo', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-10-01', checkout: '2026-10-05', datas_exatas: true }));
    assert.match((await teste({ texto: 'vaga dia 1?' })).corpo.texto, /me diga a data de entrada/);
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-11-01', checkout: '2027-03-01', datas_exatas: true }));
    assert.match((await teste({ texto: 'temporada' })).corpo.texto, /me diga a data de entrada/);
  });
  test('a IA recebe a conversa, as casas e a data de hoje', async () => {
    novoBanco(DADOS({ wa_messages: [{ id: 'm0', wamid: 'm0', wa_id: WA, autor: 'robo', texto: 'Quais datas?', enviado_em: '2026-10-19T14:00:00Z' }] }));
    responderIA(IA({ assunto: 'outro' }));
    await teste({ texto: 'Dia 17/11' });
    const p = globalThis.__anthropic.chamadas[0];
    assert.equal(p.model, 'claude-haiku-5-5');
    assert.match(p.system, /Hoje é segunda-feira, 2026-10-19/);
    assert.match(p.system, /Casas: QS40 = Casa Azul; QS39 = Casa Frida; QS50 = Casa Terracota./);
    assert.match(p.messages[0].content, /Robô: Quais datas\?\nCliente: Dia 17\/11/);
  });
});

describe('wa-webhook: envio real e ecos', () => {
  test('mensagem real: responde pela Cloud API com o token e o número do webhook', async () => {
    novoBanco(DADOS());
    responderIA(IA());
    simular(/graph\.facebook\.com/, { messages: [{ id: 'wamid.resposta' }] });
    const r = await webhook(msgCliente('Qual o valor?'));
    assert.deepEqual([r.status, await r.text()], [200, 'ok']);
    const env = chamadasPara(/graph\.facebook\.com/)[0];
    assert.equal(env.url, 'https://graph.facebook.com/v25.0/1414553548401411/messages');
    assert.equal(env.headers.authorization, 'Bearer token-wa');
    assert.deepEqual([env.json().to, env.json().type], [WA, 'text']);
    assert.equal(banco().t('wa_messages').find(m => m.autor === 'robo').wamid, 'wamid.resposta');
  });
  test('WA_PHONE_ID tem prioridade; falha no envio não registra resposta', async () => {
    novoBanco(DADOS());
    definirEnv('WA_PHONE_ID', '999');
    responderIA(IA());
    simular(/graph\.facebook\.com/, { status: 400, json: { error: { message: 'recipient not in allowed list' } } });
    await webhook(msgCliente('Qual o valor?'));
    assert.match(chamadasPara(/graph\.facebook\.com/)[0].url, /\/999\/messages$/);
    assert.equal(banco().t('wa_messages').filter(m => m.autor === 'robo').length, 0);
  });
  test('eco (você respondeu pelo app): registra, silencia o robô e muda a próxima ação', async () => {
    novoBanco(DADOS());
    responderIA(() => { throw new Error('não devia chamar a IA'); });
    await webhook({ message_echoes: [{ to: WA, id: 'wamid.eco1', timestamp: String(Date.parse('2026-10-19T14:00:00Z') / 1000), type: 'text', text: { body: 'Oi Ana, vou ver!' } }] }, 'smb_message_echoes');
    const m = banco().t('wa_messages')[0];
    assert.deepEqual([m.autor, m.direcao, m.texto], ['claudio', 'out', 'Oi Ana, vou ver!']);
    assert.equal(banco().t('wa_contacts')[0].ultima_manual, '2026-10-19T14:00:00.000Z');
    assert.deepEqual([deal().proxima_acao, deal().data_proxima_acao], ['Aguardar resposta do cliente', '2026-10-21']);
    const { corpo } = await teste({ texto: 'Tem vaga?' });
    assert.equal(corpo.motivo, 'você respondeu à mão nas últimas 12 h');
  });
  test('eco de uma mensagem que o próprio robô enviou é ignorado', async () => {
    novoBanco(DADOS({ wa_messages: [{ id: 'x', wamid: 'wamid.robo', wa_id: WA, autor: 'robo' }] }));
    const r = await teste({ texto: 'qualquer', eco: true });
    assert.equal(r.corpo.registrado, 'mensagem sua; robô em silêncio nesta conversa');
    await webhook({ message_echoes: [{ to: WA, id: 'wamid.robo', timestamp: '1', type: 'text', text: { body: 'x' } }] }, 'smb_message_echoes');
    assert.equal(banco().t('wa_messages').filter(m => m.wamid === 'wamid.robo').length, 1);
  });
  test('botão interativo vira texto (título do botão)', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'outro' }));
    await webhook(msgCliente(null, { type: 'interactive', text: undefined, interactive: { button_reply: { title: 'Quero reservar' } } }));
    assert.equal(banco().t('wa_messages')[0].texto, 'Quero reservar');
  });
});

describe('wa-webhook: Z-API', () => {
  const ZURL = /api\.z-api\.io/;
  const zapi = (x = {}, chave = 'chave-z') => fn(pedido(`/wa-webhook?zapi=${chave}`, { corpo: {
    type: 'ReceivedCallback', instanceId: 'INST1', messageId: 'Z' + Math.random(), phone: WA, fromMe: false,
    momment: Date.parse('2026-10-19T14:59:00Z'), status: 'RECEIVED', senderName: 'Ana Lima', chatName: 'Ana Lima',
    isGroup: false, isNewsletter: false, text: { message: 'Qual o valor?' }, ...x,
  }, auth: null }));
  beforeEach(() => { for (const [k, v] of Object.entries(ZAPI)) definirEnv(k, v); });

  test('chave da URL errada ou ausente nos segredos: 401, nada gravado', async () => {
    novoBanco(DADOS());
    assert.equal((await zapi({}, 'errada')).status, 401);
    definirEnv('ZAPI_WEBHOOK_KEY', undefined);
    assert.equal((await zapi({}, '')).status, 401);
    assert.equal(banco().t('wa_messages').length, 0);
  });
  test('mensagem do cliente: cria a oportunidade e responde pela Z-API (send-text com Client-Token)', async () => {
    novoBanco(DADOS());
    responderIA(IA());
    simular(ZURL, { zaapId: 'zz', messageId: 'Z-resposta', id: 'Z-resposta' });
    const r = await zapi();
    assert.deepEqual([r.status, await r.text()], [200, 'ok']);
    assert.equal(banco().t('contacts')[0].nome, 'Ana Lima');
    assert.equal(banco().t('wa_messages').find(m => m.autor === 'cliente').texto, 'Qual o valor?');
    const env = chamadasPara(ZURL)[0];
    assert.equal(env.url, 'https://api.z-api.io/instances/INST1/token/tok1/send-text');
    assert.equal(env.headers['client-token'], 'cli1');
    assert.equal(env.json().phone, WA);
    assert.match(env.json().message, /me diga a data de entrada/);
    assert.equal(banco().t('wa_messages').find(m => m.autor === 'robo').wamid, 'Z-resposta');
    assert.equal(chamadasPara(/graph\.facebook\.com/).length, 0);
  });
  test('falha no envio pela Z-API: não registra resposta', async () => {
    novoBanco(DADOS());
    responderIA(IA());
    simular(ZURL, { status: 400, json: { error: 'NOT_CONNECTED' } });
    await zapi();
    assert.equal(banco().t('wa_messages').filter(m => m.autor === 'robo').length, 0);
  });
  test('grupo, canal, status, reação, outra instância e outros eventos são ignorados', async () => {
    novoBanco(DADOS());
    responderIA(() => { throw new Error('não devia'); });
    for (const x of [{ isGroup: true }, { isNewsletter: true }, { isStatusReply: true }, { reaction: { value: '👍' } }, { instanceId: 'OUTRA' }, { type: 'MessageStatusCallback' }]) await zapi(x);
    assert.equal(banco().t('wa_messages').length, 0);
  });
  test('mensagem sua pelo celular (fromMe): vira eco e silencia o robô; a do próprio robô (fromApi) é ignorada', async () => {
    novoBanco(DADOS());
    responderIA(() => { throw new Error('não devia'); });
    await zapi({ fromMe: true, fromApi: true, messageId: 'Z-robo', text: { message: 'resposta do robô' } });
    assert.equal(banco().t('wa_messages').length, 0);
    await zapi({ fromMe: true, messageId: 'Z-eu', senderName: 'Claudio', text: { message: 'Oi Ana, vou ver!' } });
    const m = banco().t('wa_messages')[0];
    assert.deepEqual([m.autor, m.direcao, m.texto], ['claudio', 'out', 'Oi Ana, vou ver!']);
    assert.equal(banco().t('wa_contacts')[0].ultima_manual, '2026-10-19T14:59:00.000Z');
    assert.equal(banco().t('contacts')[0].nome, '(84) 99111-8864', 'o nome do eco é o seu, não o do cliente');
  });
  test('imagem com legenda e áudio ficam para você; resposta de botão vira texto', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'outro' }));
    await zapi({ messageId: 'Z1', text: undefined, image: { imageUrl: 'x', caption: 'foto da casa' } });
    await zapi({ messageId: 'Z2', text: undefined, audio: { audioUrl: 'x' } });
    await zapi({ messageId: 'Z3', text: undefined, buttonsResponseMessage: { buttonId: '1', message: 'Quero reservar' } });
    assert.deepEqual(banco().t('wa_messages').map(m => [m.tipo, m.texto]), [['image', '[image] foto da casa'], ['audio', '[audio]'], ['text', 'Quero reservar']]);
  });
  test('conversa identificada por LID: a Z-API traduz para o telefone e tudo cai na mesma oportunidade', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'outro' }));
    simular(/\/chats\/1701%40lid$/, { phone: WA, lid: '1701@lid' });
    await zapi({ messageId: 'Z-in', text: { message: 'oi' } });
    await zapi({ fromMe: true, phone: '1701@lid', messageId: 'Z-eco', text: { message: 'Oi Ana!' } });
    assert.equal(chamadasPara(/\/chats\//)[0].headers['client-token'], 'cli1');
    assert.deepEqual(banco().t('wa_messages').map(m => [m.wa_id, m.autor]), [[WA, 'cliente'], [WA, 'claudio']]);
    assert.equal(banco().t('deals').length, 1);
  });
  test('LID que a Z-API não traduz: guarda como veio, sem travar', async () => {
    novoBanco(DADOS());
    simular(/\/chats\//, { status: 404, json: {} });
    await zapi({ fromMe: true, phone: '999@lid', messageId: 'Z-x', text: { message: 'oi' } });
    assert.equal(banco().t('wa_messages')[0].wa_id, '999@lid');
  });
  test('reentrega (mesmo messageId) não duplica', async () => {
    novoBanco(DADOS());
    responderIA(IA({ assunto: 'outro' }));
    await zapi({ messageId: 'Z-mesmo' });
    await zapi({ messageId: 'Z-mesmo' });
    assert.equal(banco().t('wa_messages').length, 1);
  });
});
