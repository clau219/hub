// Edge Function wa-webhook: WhatsApp das casas → oportunidade no Pipeline, IA (simulada) que entende o pedido,
// cotação pela airbnb-quote (simulada) e resposta automática pela Cloud API (simulada). Ecos silenciam o robô.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { carregarFuncao, pedido, lerJson, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';
import { relogio } from '../helpers/ambiente.js';

let fn;
const ENV = { WA_AGRUPAR_S: '0', WA_VERIFY_TOKEN: 'verifica', WA_APP_SECRET: 'segredo-app', WA_TOKEN: 'token-wa', ANTHROPIC_API_KEY: 'sk-teste' };
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
    assert.deepEqual([corpo.respondeu, corpo.texto], [true, 'Boa tarde, Ana! Aceitamos sim, pet de pequeno porte.']);
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
    assert.equal(corpo.texto, 'Boa tarde, Ana! Tudo bem? Aqui é do atendimento das casas Azul, Frida e Terracota, no Condomínio Pipa Natureza, em Pipa 🌴\nMe conta a data de entrada, a de saída e quantas pessoas vão, que eu já vejo a disponibilidade e os valores.');
    assert.equal(deal().proxima_acao, 'Acompanhar: o robô pediu as datas');
    assert.match(globalThis.__anthropic.chamadas[0].system, /"saudacao": só cumprimenta/);
  });
  test('cumprimento ou "?" numa conversa em andamento: só pede as datas, sem boas-vindas', async () => {
    novoBanco(DADOS({ wa_messages: [{ id: 'r', wamid: 'r', wa_id: WA, autor: 'robo', texto: 'Oi!', enviado_em: '2026-10-19T14:00:00Z' }] }));
    responderIA(IA({ assunto: 'saudacao' }));
    assert.equal((await teste({ texto: '?' })).corpo.texto, 'Me conta a data de entrada, a de saída e quantas pessoas vão, que eu já vejo a disponibilidade e os valores.');
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
    assert.match(corpo.texto, /me conta a data de entrada, a de saída e quantas pessoas/i);
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
    assert.equal((await teste({ texto: 'quanto custa?' })).corpo.texto, 'Me conta a data de entrada, a de saída e quantas pessoas vão, que eu já vejo a disponibilidade e os valores.');
    novoBanco(DADOS(anterior('claudio', '2026-10-19T09:00:00Z')));
    responderIA(IA({ casa: 'QS40', checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COTACAO);
    // sem o silêncio de 12 h (é sobre quem respondeu, não sobre o cumprimento)
    banco().t('wa_settings')[0].horas_silencio = 0;
    assert.equal((await teste({ texto: 'vaga 17 a 20/11, 6 pessoas?' })).corpo.texto, 'Para 17/11 a 20/11 (3 noites, 6 hóspedes):\n• Casa Azul: disponível, R$ 1.650 no total');
    novoBanco(DADOS(anterior('robo', '2026-10-17T09:00:00Z')));
    responderIA(IA());
    assert.match((await teste({ texto: 'quanto custa?' })).corpo.texto, /^Boa tarde, Ana! Me conta/);
  });
  test('data vaga (fim de semana) e sem número de pessoas: pergunta a data exata e as pessoas, sem consultar', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-10-23', checkout: '2026-10-25', datas_exatas: false }));
    const { corpo } = await teste({ texto: 'Tem vaga no fim de semana?' });
    assert.equal(corpo.texto, 'Boa tarde, Ana! Só para eu consultar certinho: seria de sexta, 23/10, a domingo, 25/10? E quantas pessoas vão se hospedar?');
    assert.equal(chamadasPara(/airbnb-quote/).length, 0);
    assert.equal(deal().proxima_acao, 'Acompanhar: o robô pediu para confirmar as datas');
  });
  test('só a data de entrada, exata ("dia 05/11, 4 pessoas"): pergunta até que dia ficam', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-11-05', hospedes: 4, datas_exatas: true }));
    const { corpo } = await teste({ texto: 'a azul, dia 05/11, 4 pessoas' });
    assert.equal(corpo.texto, 'Boa tarde, Ana! Anotei a entrada na quinta, 05/11. Até que dia vocês ficam (ou quantas noites)?');
    assert.equal(chamadasPara(/airbnb-quote/).length, 0);
  });
  test('datas exatas e pessoas informadas: sem aviso no fim', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COTACAO);
    assert.equal((await teste({ texto: '17 a 20/11, 6 pessoas' })).corpo.texto, COTACAO.mensagem.replace('Olá!', 'Boa tarde, Ana!'));
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
    assert.match(p.system, /comece com "Boa tarde, Ana!"/);
    assert.match(p.system, /Nunca invente valor/);
  });
  test('valor que não está na consulta: descarta o texto da IA e manda a mensagem padrão', async () => {
    novoBanco(DADOS());
    duasIAs(IA({ casa: 'QS40', checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true }),
      { texto: 'A Casa Azul sai por R$ 1.400 com desconto!' });
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COT2);
    assert.equal((await teste({ texto: 'azul 17 a 20/11, 6' })).corpo.texto, 'Boa tarde, Ana! Para 17/11 a 20/11: Casa Azul livre');
  });
  test('texto sem nenhum valor havendo casa livre, ou IA fora do ar: mensagem padrão', async () => {
    for (const redacao of [{ texto: 'Tem sim! Quer reservar?' }, () => { throw new Error('overloaded'); }]) {
      novoBanco(DADOS());
      duasIAs(IA({ checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true }), redacao);
      simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COT2);
      assert.equal((await teste({ texto: '17 a 20/11, 6' })).corpo.texto, 'Boa tarde, Ana! Para 17/11 a 20/11: Casa Azul livre');
    }
  });
  test('conversa em andamento: a IA é instruída a não cumprimentar e a nunca deixar campo a preencher', async () => {
    novoBanco(DADOS({ wa_messages: [{ id: 'r', wamid: 'r', wa_id: WA, autor: 'robo', texto: 'Oi!', enviado_em: '2026-10-19T14:00:00Z' }] }));
    duasIAs(IA({ checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true }), { texto: 'De 17 a 20/11, a Casa Azul fica R$ 1.650. Quer reservar?' });
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COT2);
    const { corpo } = await teste({ texto: 'e de 17 a 20/11, 6 pessoas?' });
    assert.equal(corpo.texto, 'De 17 a 20/11, a Casa Azul fica R$ 1.650. Quer reservar?');
    const p = globalThis.__anthropic.chamadas[1];
    assert.match(p.system, /NÃO cumprimente/);
    assert.match(p.system, /nunca escreva campos para preencher.*Se não souber o nome, escreva sem nome/);
    assert.doesNotMatch(p.system, /Diga também/);
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
    assert.match(globalThis.__anthropic.chamadas[0].system, /"a azul, dia 05\/11".*NÃO é reservar: é "disponibilidade_preco"/);
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
    assert.equal(corpo.texto, COTACAO.mensagem.replace('Olá!', 'Boa tarde, Ana!'));
    assert.equal(chamadasPara(/airbnb-quote/)[0].headers.authorization, 'Bearer service-role-teste');
    const d = deal();
    assert.deepEqual([d.etapa, d.valor, d.local, d.data_evento, d.proxima_acao], ['orcamento', 1650, 'Casa Azul', '2026-11-17', 'Acompanhar: o robô enviou disponibilidade e valores']);
    assert.deepEqual(banco().t('wa_messages').find(m => m.autor === 'robo').cotacao.casas.length, 2);
  });
  test('Airbnb falhou: não responde', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 2, datas_exatas: true }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', { checkin: 'x', casas: [{ status: 'erro' }], mensagem: null });
    assert.equal((await teste({ texto: 'vaga 17 a 20/11?' })).corpo.motivo, 'consulta ao Airbnb falhou: fica para você');
  });
  test('data no passado ou estadia de mais de 60 noites: pede as datas de novo', async () => {
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-10-01', checkout: '2026-10-05', datas_exatas: true }));
    assert.match((await teste({ texto: 'vaga dia 1?' })).corpo.texto, /data de entrada/);
    novoBanco(DADOS());
    responderIA(IA({ checkin: '2026-11-01', checkout: '2027-03-01', datas_exatas: true }));
    assert.match((await teste({ texto: 'temporada' })).corpo.texto, /data de entrada/);
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

describe('wa-webhook: pergunta o que falta e junta as respostas (várias trocas)', () => {
  // Cada troca: a IA (simulada) extrai só o que estiver na mensagem; o robô soma ao que já foi dito (wa_contacts.pedido)
  const troca = async (texto, extracao) => { responderIA(IA(extracao)); return (await teste({ texto })).corpo; };
  const AIRBNB = 'https://projeto.supabase.co/functions/v1/airbnb-quote';
  const robo = () => banco().t('wa_messages').filter(m => m.autor === 'robo').map(m => m.texto);

  test('"tem vaga em dezembro?" → pede datas e pessoas → cliente responde → consulta e responde com os valores', async () => {
    novoBanco(DADOS());
    simular(AIRBNB, COTACAO);
    const a = await troca('tem vaga em dezembro?', {});
    assert.equal(a.texto, 'Boa tarde, Ana! Me conta a data de entrada, a de saída e quantas pessoas vão, que eu já vejo a disponibilidade e os valores.');
    assert.equal(chamadasPara(/airbnb-quote/).length, 0);
    const b = await troca('de 5 a 8 de dezembro, somos 3', { checkin: '2026-12-05', checkout: '2026-12-08', hospedes: 3, datas_exatas: true });
    assert.equal(b.respondeu, true);
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-12-05', checkout: '2026-12-08', adultos: 3 });
    assert.equal(b.texto, 'Para 17/11 a 20/11 (3 noites, 6 hóspedes):\n• Casa Azul: disponível, R$ 1.650 no total', 'conversa em andamento: sem "Olá!"');
    assert.equal(robo().length, 2);
    assert.equal(deal().proxima_acao, 'Acompanhar: o robô enviou disponibilidade e valores');
  });

  test('guarda o que já foi dito (casa e pessoas) mesmo se a IA não repetir, e consulta quando chegam as datas', async () => {
    novoBanco(DADOS());
    simular(AIRBNB, COTACAO);
    const a = await troca('somos 4, queria a casa azul', { casa: 'QS40', hospedes: 4 });
    assert.equal(a.texto, 'Boa tarde, Ana! Anotado, 4 pessoas! Agora me conta a data de entrada e a de saída, que eu já vejo os valores.');
    assert.deepEqual([banco().t('wa_contacts')[0].pedido.casa, banco().t('wa_contacts')[0].pedido.hospedes], ['QS40', 4]);
    await troca('17 a 20 de novembro', { checkin: '2026-11-17', checkout: '2026-11-20', datas_exatas: true });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 4 });
    assert.deepEqual([deal().local, deal().valor], ['Casa Azul', 1650], 'a casa dita na 1ª mensagem vale para o card');
  });

  test('data vaga → robô confirma a interpretação → "isso, 2 pessoas" → consulta', async () => {
    novoBanco(DADOS());
    simular(AIRBNB, COTACAO);
    const a = await troca('tem vaga no fim de semana?', { checkin: '2026-10-23', checkout: '2026-10-25', datas_exatas: false });
    assert.equal(a.texto, 'Boa tarde, Ana! Só para eu consultar certinho: seria de sexta, 23/10, a domingo, 25/10? E quantas pessoas vão se hospedar?');
    await troca('isso, 2 pessoas', { checkin: '2026-10-23', checkout: '2026-10-25', hospedes: 2, datas_exatas: true });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-10-23', checkout: '2026-10-25', adultos: 2 });
  });

  test('"dia 20" sem o mês: confirma a entrada e pergunta até quando', async () => {
    novoBanco(DADOS());
    const a = await troca('tem vaga dia 20? somos 2', { checkin: '2026-10-20', hospedes: 2, datas_exatas: false });
    assert.equal(a.texto, 'Boa tarde, Ana! Só para eu consultar certinho: a entrada seria na terça, 20/10? E até que dia vocês ficariam?');
    assert.equal(chamadasPara(/airbnb-quote/).length, 0);
  });

  test('entrada exata → pergunta a saída → "3 noites" (a IA só manda as noites) → calcula a saída e consulta', async () => {
    novoBanco(DADOS());
    simular(AIRBNB, COTACAO);
    const a = await troca('chego dia 17/11, somos 4', { checkin: '2026-11-17', hospedes: 4, datas_exatas: true });
    assert.equal(a.texto, 'Boa tarde, Ana! Anotei a entrada na terça, 17/11. Até que dia vocês ficam (ou quantas noites)?');
    await troca('3 noites', { noites: 3 });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 4 });
  });

  test('só faltam as pessoas: pergunta só isso e depois consulta', async () => {
    novoBanco(DADOS());
    simular(AIRBNB, COTACAO);
    const a = await troca('vaga de 17 a 20/11?', { checkin: '2026-11-17', checkout: '2026-11-20', datas_exatas: true });
    assert.equal(a.texto, 'Boa tarde, Ana! Perfeito, de 17/11 a 20/11. E quantas pessoas vão se hospedar?');
    assert.equal(deal().proxima_acao, 'Acompanhar: o robô perguntou quantas pessoas');
    await troca('somos 5', { hospedes: 5 });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 5 });
  });

  test('nova data de entrada sem saída descarta a saída antiga e pergunta de novo', async () => {
    novoBanco(DADOS({ wa_contacts: [{ wa_id: WA, pedido: { casa: 'qualquer', checkin: '2026-11-17', checkout: '2026-11-20', noites: null, hospedes: 4, datas_exatas: true, em: '2026-10-19T10:00:00Z' } }] }));
    const a = await troca('e se for a partir do dia 5/12?', { checkin: '2026-12-05', datas_exatas: true });
    assert.equal(a.texto, 'Boa tarde, Ana! Anotei a entrada no sábado, 05/12. Até que dia vocês ficam (ou quantas noites)?');
    assert.equal(banco().t('wa_contacts')[0].pedido.checkout, null);
  });

  test('o que foi dito há mais de 7 dias não vale mais', async () => {
    novoBanco(DADOS({ wa_contacts: [{ wa_id: WA, pedido: { casa: 'QS40', checkin: '2026-11-17', checkout: '2026-11-20', noites: null, hospedes: 4, datas_exatas: true, em: '2026-10-01T10:00:00Z' } }] }));
    const a = await troca('tem vaga?', {});
    assert.equal(a.texto, 'Boa tarde, Ana! Me conta a data de entrada, a de saída e quantas pessoas vão, que eu já vejo a disponibilidade e os valores.');
  });
});

describe('wa-webhook: pergunta que só o Claudio responde', () => {
  // Push só sai na mensagem real (no modo teste não, para não tocar o celular): estas usam o webhook da Meta
  const PUSH = { app_secrets: [{ key: 'cron_token', value: 'cron-teste' }, { key: 'vapid_public', value: 'pub' }, { key: 'vapid_private', value: 'priv' }],
    push_subscriptions: [{ id: 's1', endpoint: 'https://push/celular', p256dh: 'p', auth: 'a' }] };
  const comPush = (x = {}) => DADOS({ ...PUSH, ...x });
  beforeEach(() => { globalThis.__webpush = { envios: [], falhar: null }; simular(/graph\.facebook\.com/, { messages: [{ id: 'wamid.r' + Math.random() }] }); });
  const enviados = () => chamadasPara(/graph\.facebook\.com/).map(c => c.json().text.body);

  test('pergunta para o Claudio de madrugada: não promete "já te retorno", diz "logo cedo"', async () => {
    relogio.definir('2026-10-20T04:30:00Z'); // 1h30 em Pipa
    try {
      novoBanco(comPush());
      responderIA(IA({ assunto: 'outro', resumo: 'Desconto', pergunta_claudio: 'Pede desconto' }));
      await webhook(msgCliente('Fazem desconto?'));
      assert.deepEqual(enviados(), ['Boa noite, Ana! Vou confirmar isso e te retorno logo cedo, tá?']);
      responderIA(IA({ assunto: 'outro', pergunta_claudio: 'Quer fazer check-in às 8h' }));
      await webhook(msgCliente('e dá pra chegar 8h?'));
      assert.equal(enviados().length, 1, 'o aviso da madrugada também conta como "já avisou"');
    } finally { relogio.definir('2026-10-19T15:00:00Z'); }
  });
  test('desconto: o robô não inventa, avisa que vai confirmar, destaca a pergunta no card e manda push', async () => {
    novoBanco(comPush());
    responderIA(IA({ assunto: 'outro', resumo: 'Desconto 5 noites', pergunta_claudio: 'Pede desconto para 5 noites' }));
    await webhook(msgCliente('Vocês fazem desconto para 5 noites?'));
    assert.deepEqual(enviados(), ['Boa tarde, Ana! Vou confirmar isso e já te retorno.']);
    assert.equal(deal().proxima_acao, '❓ Cliente pergunta: Pede desconto para 5 noites');
    assert.equal(deal().data_proxima_acao, '2026-10-19');
    const push = globalThis.__webpush.envios;
    assert.equal(push.length, 1);
    assert.deepEqual([push[0].title, push[0].body, push[0].tag], ['Ana perguntou algo que só você responde', 'Pede desconto para 5 noites', 'wa-pergunta']);
    assert.match(push[0].url, /#\/whatsapp\?c=5584991118864/);
    assert.equal(banco().t('wa_messages').filter(m => m.autor === 'robo').length, 1);
    assert.match(globalThis.__anthropic.chamadas[0].system, /pergunta_claudio: .*desconto.*check-in antecipado.*diferente do Pix do sinal/s);
  });

  test('no meio da conversa (já pediu datas): "posso levar meu cachorro?" sem base de pets → avisa e destaca; depois a 2ª pergunta não repete aviso nem push', async () => {
    novoBanco(comPush({ wa_contacts: [{ wa_id: WA, pedido: { casa: 'qualquer', checkin: '2026-11-17', checkout: '2026-11-20', noites: null, hospedes: null, datas_exatas: true, em: '2026-10-19T10:00:00Z' } }],
      wa_messages: [{ id: 'r', wamid: 'r', wa_id: WA, autor: 'robo', texto: 'Para eu consultar de 17/11 a 20/11: quantas pessoas vão se hospedar?', enviado_em: '2026-10-19T14:00:00Z' }] }));
    responderIA(IA({ assunto: 'outro', pergunta_claudio: 'Quer levar um cachorro grande' }));
    await webhook(msgCliente('antes: posso levar meu cachorro? é grande'));
    assert.deepEqual(enviados(), ['Vou confirmar isso e já te retorno.'], 'conversa em andamento: sem "Olá!"');
    assert.equal(deal().proxima_acao, '❓ Cliente pergunta: Quer levar um cachorro grande');
    assert.equal(globalThis.__webpush.envios.length, 1);
    assert.equal(banco().t('wa_contacts')[0].pedido.checkin, '2026-11-17', 'o que o cliente já disse continua guardado');
    responderIA(IA({ assunto: 'outro', pergunta_claudio: 'Quer saber se pode fazer churrasco com amigos' }));
    await webhook(msgCliente('e pode fazer churrasco com uns amigos?'));
    assert.equal(enviados().length, 1, 'não repete o aviso');
    assert.equal(globalThis.__webpush.envios.length, 1, 'nem o push');
    assert.equal(deal().proxima_acao, '❓ Cliente pergunta: Quer saber se pode fazer churrasco com amigos', 'o card mostra a pergunta nova');
  });

  test('datas + pergunta para o Claudio na mesma mensagem: pergunta o que falta das datas, avisa da outra e destaca', async () => {
    novoBanco(comPush());
    responderIA(IA({ checkin: '2026-11-17', checkout: '2026-11-20', datas_exatas: true, pergunta_claudio: 'Quer fazer check-in às 8h' }));
    await webhook(msgCliente('tem vaga de 17 a 20/11? dá pra fazer check-in às 8h?'));
    assert.deepEqual(enviados(), ['Boa tarde, Ana! Perfeito, de 17/11 a 20/11. E quantas pessoas vão se hospedar?\n\nSobre a sua outra pergunta, vou confirmar e já te retorno.']);
    assert.equal(deal().proxima_acao, '❓ Cliente pergunta: Quer fazer check-in às 8h');
    assert.equal(globalThis.__webpush.envios.length, 1);
  });

  test('"somos 4. Posso levar meu cachorro?" completando a reserva em andamento: manda os valores e avisa da outra pergunta', async () => {
    novoBanco(comPush({ wa_contacts: [{ wa_id: WA, pedido: { casa: 'qualquer', checkin: '2026-11-17', checkout: '2026-11-20', noites: null, hospedes: null, datas_exatas: true, em: '2026-10-19T10:00:00Z' } }],
      wa_messages: [{ id: 'r', wamid: 'r', wa_id: WA, autor: 'robo', texto: 'Para eu consultar de 17/11 a 20/11: quantas pessoas vão se hospedar?', enviado_em: '2026-10-19T14:00:00Z' }] }));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COTACAO);
    responderIA(IA({ assunto: 'outro', hospedes: 4, pergunta_claudio: 'Quer levar um cachorro grande' }));
    await webhook(msgCliente('somos 4. Posso levar meu cachorro? É grande'));
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 4 });
    assert.deepEqual(enviados(), ['Para 17/11 a 20/11 (3 noites, 6 hóspedes):\n• Casa Azul: disponível, R$ 1.650 no total\n\nSobre a sua outra pergunta, vou confirmar e já te retorno.']);
    assert.equal(deal().proxima_acao, '❓ Cliente pergunta: Quer levar um cachorro grande', 'o card continua esperando você');
    assert.equal(globalThis.__webpush.envios.length, 1);
  });
  test('depois que o Claudio respondeu, uma nova pergunta para ele volta a ter aviso e push', async () => {
    novoBanco(comPush({ wa_messages: [
      { id: 'r', wamid: 'r', wa_id: WA, autor: 'robo', texto: 'Vou confirmar isso e já te retorno.', enviado_em: '2026-10-18T10:00:00Z' },
      { id: 'c', wamid: 'c', wa_id: WA, autor: 'claudio', texto: 'Pode sim!', enviado_em: '2026-10-18T11:00:00Z' }] }));
    responderIA(IA({ assunto: 'outro', pergunta_claudio: 'Quer pagar por Pix fora do Airbnb' }));
    await webhook(msgCliente('posso pagar por pix direto com você?'));
    assert.equal(enviados().length, 1);
    assert.equal(globalThis.__webpush.envios.length, 1);
  });

  test('agradecimento ou conversa (sem pergunta para o Claudio) continua sem resposta e sem push', async () => {
    novoBanco(comPush());
    responderIA(IA({ assunto: 'outro', resumo: 'Agradeceu' }));
    await webhook(msgCliente('obrigada!'));
    assert.equal(enviados().length, 0);
    assert.equal(globalThis.__webpush.envios.length, 0);
    assert.equal(deal().proxima_acao, 'Responder WhatsApp: Agradeceu');
  });

  test('modo teste: avisa e destaca, mas não manda push', async () => {
    novoBanco(comPush());
    responderIA(IA({ assunto: 'confirmar_reserva', pergunta_claudio: 'Quer fechar a Casa Azul' }));
    const { corpo } = await teste({ texto: 'quero fechar a azul' });
    assert.deepEqual([corpo.respondeu, corpo.texto, corpo.para_claudio], [true, 'Boa tarde, Ana! Vou confirmar isso e já te retorno.', 'Quer fechar a Casa Azul']);
    assert.equal(globalThis.__webpush.envios.length, 0);
  });
});

describe('wa-webhook: reserva direta com sinal por Pix e comprovante lido pela IA', () => {
  const AIRBNB = 'https://projeto.supabase.co/functions/v1/airbnb-quote';
  const BASE = { geral: { pix_chave: '12.345.678/0001-90', pix_nome: 'Claudio Roberto Sousa Braga LTDA', sinal_pct: '50' } };
  const PEDIDO = { casa: 'QS40', checkin: '2026-11-17', checkout: '2026-11-20', noites: null, hospedes: 4, datas_exatas: true, em: '2026-10-19T10:00:00Z' };
  const COT_LIVRE = { checkin: '2026-11-17', checkout: '2026-11-20', noites: 3, adultos: 4, mensagem: 'Olá! Para 17/11 a 20/11...',
    casas: [{ id: 'QS40', nome: 'Casa Azul', status: 'livre', total: 1650 }, { id: 'QS50', nome: 'Casa Terracota', status: 'livre', total: 1350 }, { id: 'QS39', nome: 'Casa Frida', status: 'ocupada' }] };
  const PUSH = { app_secrets: [{ key: 'cron_token', value: 'cron-teste' }, { key: 'vapid_public', value: 'pub' }, { key: 'vapid_private', value: 'priv' }],
    push_subscriptions: [{ id: 's1', endpoint: 'https://push/celular', p256dh: 'p', auth: 'a' }] };
  const dados = (x = {}) => DADOS({ ...PUSH, contacts: [{ id: 'c1', nome: 'Ana Lima', telefone: '(84) 99111-8864' }],
    deals: [{ id: 'd1', etapa: 'orcamento', contato_id: 'c1', pagamentos: [] }],
    wa_contacts: [{ wa_id: WA, contato_id: 'c1', deal_id: 'd1', pedido: PEDIDO }],
    app_config: [{ key: 'wa_base', value: JSON.stringify(BASE) }], ...x });
  const SINAL = { casa: 'QS40', nome: 'Casa Azul', checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 4, total: 1650, valor: 825, pct: 50, desde: '2026-10-19T14:00:00Z' };
  const comSinal = (x = {}) => dados({ wa_contacts: [{ wa_id: WA, contato_id: 'c1', deal_id: 'd1', pedido: { ...PEDIDO, sinal: SINAL } }],
    deals: [{ id: 'd1', etapa: 'negociacao', contato_id: 'c1', valor: 1650, pagamentos: [] }], ...x });
  const E2E = 'E18236120202610191455s0123456789';
  const LEITURA = (x = {}) => ({ e_comprovante_pix: true, valor: 825, recebedor_nome: 'CLAUDIO ROBERTO SOUSA BRAGA LTDA', recebedor_chave: '12.345.678/0001-90',
    pagador_nome: 'ANA LIMA', data_hora: '2026-10-19T11:55:00-03:00', e2e: E2E, ...x });
  // 1ª chamada: extração; a leitura do comprovante tem o system próprio
  const ias = (extracao, leitura) => responderIA(q => (q.system.includes('comprovantes de Pix') ? (typeof leitura === 'function' ? leitura(q) : leitura) : extracao));
  beforeEach(() => { globalThis.__webpush = { envios: [], falhar: null }; });

  test('"quero reservar" com tudo conhecido: consulta de novo e manda total, sinal (50%) e Pix; card aguardando sinal', async () => {
    novoBanco(dados());
    simular(AIRBNB, COT_LIVRE);
    responderIA(IA({ assunto: 'reservar', casa: 'QS40' }));
    const { corpo } = await teste({ texto: 'quero reservar a azul' });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 4 });
    assert.equal(corpo.texto, 'Boa tarde, Ana! Ótimo! Para reservar a Casa Azul de terça, 17/11, a sexta, 20/11, para 4 pessoas, o total é R$ 1.650.\nO sinal é de R$ 825 (50%), por Pix:\nChave: 12.345.678/0001-90\nNome: Claudio Roberto Sousa Braga LTDA\nDepois é só me mandar o comprovante aqui (foto ou PDF) que eu confirmo a reserva.');
    const d = deal();
    assert.deepEqual([d.etapa, d.valor, d.local, d.data_evento, d.proxima_acao], ['negociacao', 1650, 'Casa Azul', '2026-11-17', 'Aguardando sinal de R$ 825']);
    assert.deepEqual(banco().t('wa_contacts')[0].pedido.sinal, { ...SINAL, desde: banco().t('wa_contacts')[0].pedido.sinal.desde });
    assert.equal(banco().t('bookings').length, 0, 'nada é bloqueado antes do sinal');
  });
  test('quer reservar sem dizer a casa: mostra só as livres para escolher (sem Pix)', async () => {
    novoBanco(dados({ wa_contacts: [{ wa_id: WA, contato_id: 'c1', deal_id: 'd1', pedido: { ...PEDIDO, casa: 'qualquer' } }] }));
    simular(AIRBNB, COT_LIVRE);
    responderIA(IA({ assunto: 'reservar' }));
    const { corpo } = await teste({ texto: 'quero reservar' });
    assert.equal(corpo.texto, 'Boa tarde, Ana! Para reservar de 17/11 a 20/11, qual casa vocês preferem?\n• Casa Azul: R$ 1.650 no total\n• Casa Terracota: R$ 1.350 no total');
    assert.doesNotMatch(corpo.texto, /Chave/);
  });
  test('a casa pedida não está mais livre: diz e mostra as livres; nada de Pix', async () => {
    novoBanco(dados({ wa_contacts: [{ wa_id: WA, contato_id: 'c1', deal_id: 'd1', pedido: { ...PEDIDO, casa: 'QS39' } }] }));
    simular(AIRBNB, COT_LIVRE);
    responderIA(IA({ assunto: 'reservar', casa: 'QS39' }));
    const { corpo } = await teste({ texto: 'quero reservar a frida' });
    assert.equal(corpo.texto, 'Boa tarde, Ana! A Casa Frida não está mais livre de 17/11 a 20/11.\nLivres de 17/11 a 20/11:\n• Casa Azul: R$ 1.650 no total\n• Casa Terracota: R$ 1.350 no total');
    assert.equal(deal().etapa, 'orcamento');
  });
  test('quer reservar mas faltam dados: pergunta o que falta antes de qualquer Pix', async () => {
    novoBanco(dados({ wa_contacts: [{ wa_id: WA, contato_id: 'c1', deal_id: 'd1', pedido: null }] }));
    responderIA(IA({ assunto: 'reservar', casa: 'QS40', checkin: '2026-11-17', checkout: '2026-11-20', datas_exatas: true }));
    const { corpo } = await teste({ texto: 'quero reservar a azul de 17 a 20/11' });
    assert.equal(corpo.texto, 'Boa tarde, Ana! Perfeito, de 17/11 a 20/11. E quantas pessoas vão se hospedar?');
    assert.equal(chamadasPara(/airbnb-quote/).length, 0);
  });
  test('sem chave Pix cadastrada na base: não inventa, fica para você com a pergunta destacada', async () => {
    novoBanco(dados({ app_config: [{ key: 'wa_base', value: '{}' }] }));
    responderIA(IA({ assunto: 'reservar', casa: 'QS40' }));
    const { corpo } = await teste({ texto: 'quero reservar a azul' });
    assert.equal(corpo.texto, 'Boa tarde, Ana! Vou confirmar isso e já te retorno.');
    assert.match(deal().proxima_acao, /^❓ Cliente pergunta: Quer reservar a Casa Azul de 17\/11 a 20\/11 \(chave Pix não cadastrada\)/);
  });
  test('pede o Pix de novo com o sinal já enviado: só lembra do comprovante, sem consultar de novo', async () => {
    novoBanco(comSinal({ wa_messages: [{ id: 'r', wamid: 'r', wa_id: WA, autor: 'robo', texto: 'O sinal é de R$ 825...', enviado_em: '2026-10-19T14:00:00Z' }] }));
    responderIA(IA({ assunto: 'reservar' }));
    const { corpo } = await teste({ texto: 'me passa o pix de novo?' });
    assert.equal(corpo.texto, 'Assim que fizer o Pix de R$ 825, me manda o comprovante aqui (foto ou PDF) que eu confirmo a reserva da Casa Azul.');
    assert.equal(chamadasPara(/airbnb-quote/).length, 0);
  });

  test('comprovante válido (foto pela Z-API): lê com a IA, confere tudo, cria a reserva direta, registra o sinal, fecha o card, confirma e avisa por push', async () => {
    for (const [k, v] of Object.entries({ ZAPI_INSTANCE: 'INST1', ZAPI_TOKEN: 'tok1', ZAPI_CLIENT_TOKEN: 'cli1', ZAPI_WEBHOOK_KEY: 'chave-z' })) definirEnv(k, v);
    novoBanco(comSinal());
    simular(AIRBNB, COT_LIVRE);
    simular('https://midia.z-api.io/comprovante.jpg', new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }));
    simular(/api\.z-api\.io/, { messageId: 'z-r' + Math.random() });
    let leu;
    ias(IA(), q => { leu = q; return LEITURA(); });
    const ev = { type: 'ReceivedCallback', instanceId: 'INST1', phone: WA, messageId: 'z1', fromMe: false, senderName: 'Ana Lima', momment: Date.now(),
      image: { imageUrl: 'https://midia.z-api.io/comprovante.jpg', mimeType: 'image/jpeg', caption: '' } };
    const res = await fn(pedido('/wa-webhook?zapi=chave-z', { corpo: ev, auth: null }));
    assert.equal(res.status, 200);
    // a IA recebeu a foto (base64) e o pedido de transcrição
    assert.deepEqual([leu.messages[0].content[0].type, leu.messages[0].content[0].source.media_type, leu.messages[0].content[0].source.data], ['image', 'image/jpeg', '/9j/AQID']);
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 4 }, 'confere de novo no Airbnb');
    const bk = banco().t('bookings')[0];
    assert.deepEqual([bk.property_id, bk.checkin, bk.checkout, bk.origem, bk.status, bk.valor, bk.hospede, bk.contato_id], ['QS40', '2026-11-17', '2026-11-20', 'direto', 'confirmada', 1650, 'Ana Lima', 'c1']);
    assert.match(bk.notas, /E2E E18236120202610191455S0123456789/);
    const d = deal();
    assert.deepEqual([d.etapa, d.pagamentos.length, d.pagamentos[0].valor, d.pagamentos[0].forma, d.proxima_acao], ['fechado', 1, 825, 'Pix', 'Conferir o sinal no banco (reserva confirmada pelo robô)']);
    const cp = banco().t('wa_comprovantes')[0];
    assert.deepEqual([cp.status, cp.e2e, cp.booking_id], ['valido', E2E.toUpperCase(), bk.id]);
    const env = chamadasPara(/send-text/).map(c => c.json().message);
    assert.equal(env.at(-1), 'Boa tarde, Ana! Reserva confirmada! ✅\nCasa Azul, de terça, 17/11, a sexta, 20/11, para 4 pessoas.\nRecebi o sinal de R$ 825; faltam R$ 825 do total de R$ 1.650.\nQualquer dúvida, é só chamar por aqui.');
    const push = globalThis.__webpush.envios;
    assert.equal(push.length, 1);
    assert.match(push[0].title, /Reserva confirmada pelo robô: Casa Azul, 17\/11 a 20\/11/);
    assert.match(push[0].body, /Confira o sinal no banco/);
    assert.equal(banco().t('wa_contacts')[0].pedido.sinal, null, 'o sinal pendente acaba');
  });

  const invalidos = [
    ['valor menor que o sinal', LEITURA({ valor: 500 }), /valor R\$ 500 menor que o sinal de R\$ 825/],
    ['recebedor diferente', LEITURA({ recebedor_nome: 'FULANO DE TAL', recebedor_chave: 'fulano@x.com' }), /recebedor não confere/],
    ['data antes do pedido', LEITURA({ data_hora: '2026-10-18T09:00:00-03:00' }), /data fora do período/],
    ['sem E2E', LEITURA({ e2e: null }), /E2E\) ausente/],
    ['não é comprovante', LEITURA({ e_comprovante_pix: false }), /não parece um comprovante/],
  ];
  for (const [nome, leitura, motivo] of invalidos) test(`comprovante inválido (${nome}): não confirma, avisa que vai conferir e destaca o motivo`, async () => {
    novoBanco(comSinal());
    simular(AIRBNB, COT_LIVRE);
    ias(IA(), leitura);
    const { corpo } = await teste({ texto: '[image]', midia: { mime: 'image/png', base64: 'iVBORw0KGgo=' } });
    assert.deepEqual([corpo.respondeu, corpo.texto, corpo.comprovante], [true, 'Boa tarde, Ana! Recebi o comprovante! Vou conferir e já te retorno.', 'conferir']);
    assert.match(corpo.motivo_comprovante, motivo);
    assert.equal(banco().t('bookings').length, 0);
    assert.match(deal().proxima_acao, /^❓ Conferir comprovante: /);
    assert.equal(deal().etapa, 'negociacao');
    assert.equal(banco().t('wa_comprovantes')[0].status, 'invalido');
  });
  test('o mesmo E2E não confirma duas reservas', async () => {
    novoBanco(comSinal({ wa_comprovantes: [{ id: 'cp0', wa_id: '5584000000000', e2e: E2E.toUpperCase(), status: 'valido' }] }));
    simular(AIRBNB, COT_LIVRE);
    ias(IA(), LEITURA());
    const { corpo } = await teste({ texto: '[image]', midia: { mime: 'image/png', base64: 'iVBORw0KGgo=' } });
    assert.match(corpo.motivo_comprovante, /já usado em outra reserva/);
    assert.equal(banco().t('bookings').length, 0);
  });
  test('comprovante certo mas a casa foi ocupada no Airbnb (ou no Hub) nesse meio tempo: não confirma', async () => {
    novoBanco(comSinal());
    simular(AIRBNB, { ...COT_LIVRE, casas: [{ id: 'QS40', nome: 'Casa Azul', status: 'ocupada' }] });
    ias(IA(), LEITURA());
    assert.match((await teste({ texto: '[image]', midia: { mime: 'image/png', base64: 'iVBORw0KGgo=' } })).corpo.motivo_comprovante, /não está mais livre no Airbnb/);
    novoBanco(comSinal({ bookings: [{ id: 'b0', property_id: 'QS40', checkin: '2026-11-18', checkout: '2026-11-22', status: 'confirmada', origem: 'airbnb' }] }));
    simular(AIRBNB, COT_LIVRE);
    ias(IA(), LEITURA());
    assert.match((await teste({ texto: '[image]', midia: { mime: 'image/png', base64: 'iVBORw0KGgo=' } })).corpo.motivo_comprovante, /já existe reserva ou bloqueio/);
    assert.equal(banco().t('bookings').length, 1);
  });
  test('PDF também é lido (bloco de documento)', async () => {
    novoBanco(comSinal());
    simular(AIRBNB, COT_LIVRE);
    let leu;
    ias(IA(), q => { leu = q; return LEITURA(); });
    const { corpo } = await teste({ texto: '[document]', midia: { mime: 'application/pdf', base64: 'JVBERi0=' } });
    assert.equal(corpo.comprovante, 'confirmada');
    assert.deepEqual([leu.messages[0].content[0].type, leu.messages[0].content[0].source.media_type], ['document', 'application/pdf']);
  });
  test('foto sem sinal pendente continua ficando para você', async () => {
    novoBanco(dados());
    responderIA(() => { throw new Error('a IA não devia ser chamada'); });
    const { corpo } = await teste({ texto: '[image]', midia: { mime: 'image/png', base64: 'iVBORw0KGgo=' } });
    assert.deepEqual([corpo.respondeu, corpo.motivo], [false, 'mensagem do tipo image: fica para você']);
  });
  test('regras de recebedor: nome (primeiro e último) ou a mesma chave; chave mascarada não basta sozinha', async () => {
    novoBanco(comSinal());
    simular(AIRBNB, COT_LIVRE);
    for (const [leitura, ok] of [
      [LEITURA({ recebedor_nome: 'Claudio R S Braga Ltda', recebedor_chave: null }), true],
      [LEITURA({ recebedor_nome: null, recebedor_chave: '12345678000190' }), true],
      [LEITURA({ recebedor_nome: 'CLAUDIO SOUZA', recebedor_chave: '**.345.678/0001-**' }), false],
    ]) {
      novoBanco(comSinal()); simular(AIRBNB, COT_LIVRE); ias(IA(), leitura);
      const { corpo } = await teste({ texto: '[image]', midia: { mime: 'image/png', base64: 'iVBORw0KGgo=' } });
      assert.equal(corpo.comprovante, ok ? 'confirmada' : 'conferir', JSON.stringify(leitura));
    }
  });
});

describe('wa-webhook: pets na consulta, no sinal e na reserva', () => {
  const AIRBNB = 'https://projeto.supabase.co/functions/v1/airbnb-quote';
  const troca = async (texto, extracao) => { responderIA(IA(extracao)); return (await teste({ texto })).corpo; };
  const BASE = { geral: { pix_chave: '12.345.678/0001-90', pix_nome: 'Claudio Roberto Sousa Braga LTDA', sinal_pct: '50' } };
  const PEDIDO = { casa: 'QS50', checkin: '2026-11-17', checkout: '2026-11-20', noites: null, hospedes: 4, pets: 1, datas_exatas: true, em: '2026-10-19T10:00:00Z' };
  const COT_PET = { checkin: '2026-11-17', checkout: '2026-11-20', noites: 3, adultos: 4, pets: 1, mensagem: 'Olá! Para 17/11 a 20/11 (3 noites, 4 hóspedes e 1 pet):\n• Casa Terracota: disponível, R$ 1.850 no total\n• Casa Azul: não aceita pets',
    casas: [{ id: 'QS50', nome: 'Casa Terracota', status: 'livre', total: 1850 }, { id: 'QS40', nome: 'Casa Azul', status: 'nao_aceita_pet' }] };
  const dados = (pedido = PEDIDO) => DADOS({ contacts: [{ id: 'c1', nome: 'Ana Lima' }], deals: [{ id: 'd1', etapa: 'orcamento', contato_id: 'c1', pagamentos: [] }],
    wa_contacts: [{ wa_id: WA, contato_id: 'c1', deal_id: 'd1', pedido }], app_config: [{ key: 'wa_base', value: JSON.stringify(BASE) }] });

  test('"levo um cachorrinho": guarda o pet no pedido, consulta com pets e o pet continua valendo nas trocas seguintes', async () => {
    novoBanco(DADOS());
    simular(AIRBNB, COT_PET);
    await troca('somos 4 e levo um cachorrinho', { hospedes: 4, pets: 1 });
    assert.equal(banco().t('wa_contacts')[0].pedido.pets, 1);
    const b = await troca('de 17 a 20 de novembro', { checkin: '2026-11-17', checkout: '2026-11-20', datas_exatas: true });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 4, pets: 1 });
    assert.match(b.texto, /4 hóspedes e 1 pet/);
    assert.match(b.texto, /Casa Azul: não aceita pets/);
  });
  test('"não vamos levar pet" zera o pet: consulta sem pets', async () => {
    novoBanco(DADOS({ wa_contacts: [{ wa_id: WA, pedido: { ...PEDIDO, em: new Date().toISOString() } }] }));
    simular(AIRBNB, COTACAO);
    await troca('desistimos do cachorro, vamos sem pet', { pets: 0 });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 4 });
    assert.equal(banco().t('wa_contacts')[0].pedido.pets, 0);
  });
  test('a IA recebe os valores já com a taxa de pet e a casa que não aceita pets', async () => {
    novoBanco(DADOS({ wa_contacts: [{ wa_id: WA, pedido: { ...PEDIDO, em: new Date().toISOString() } }] }));
    simular(AIRBNB, COT_PET);
    responderIA(IA({ hospedes: 4 }));
    await teste({ texto: 'e aí, tem vaga?' });
    const redacao = globalThis.__anthropic.chamadas.map(q => JSON.stringify(q)).find(s => s.includes('Período consultado'));
    assert.match(redacao, /4 hóspedes e 1 pet \(valores já com a taxa de pet\)/);
    assert.match(redacao, /Casa Azul: NÃO ACEITA PETS/);
  });
  test('reservar com pet: total e sinal com a taxa de pet, e o pet aparece na mensagem e no sinal', async () => {
    novoBanco(dados());
    simular(AIRBNB, COT_PET);
    responderIA(IA({ assunto: 'reservar', casa: 'QS50' }));
    const { corpo } = await teste({ texto: 'quero reservar a terracota' });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 4, pets: 1 });
    assert.match(corpo.texto, /^Boa tarde, Ana! Ótimo! Para reservar a Casa Terracota de terça, 17\/11, a sexta, 20\/11, para 4 pessoas e 1 pet, o total é R\$ 1\.850\.\nO sinal é de R\$ 925 \(50%\)/);
    const s = banco().t('wa_contacts')[0].pedido.sinal;
    assert.deepEqual([s.pets, s.total, s.valor], [1, 1850, 925]);
  });
  test('reservar com pet uma casa que não aceita pets: diz e mostra as que aceitam; nada de Pix', async () => {
    novoBanco(dados({ ...PEDIDO, casa: 'QS40' }));
    simular(AIRBNB, COT_PET);
    responderIA(IA({ assunto: 'reservar', casa: 'QS40' }));
    const { corpo } = await teste({ texto: 'quero reservar a azul' });
    assert.equal(corpo.texto, 'Boa tarde, Ana! A Casa Azul não aceita pets.\nAceitam pets e estão livres de 17/11 a 20/11:\n• Casa Terracota: R$ 1.850 no total');
    assert.equal(banco().t('wa_contacts')[0].pedido.sinal ?? null, null);
  });
  test('comprovante de reserva com pet: confere no Airbnb com o pet e anota o pet na reserva', async () => {
    const SINAL = { casa: 'QS50', nome: 'Casa Terracota', checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 4, pets: 1, total: 1850, valor: 925, pct: 50, desde: '2026-10-19T14:00:00Z' };
    novoBanco(dados({ ...PEDIDO, sinal: SINAL }));
    simular(AIRBNB, COT_PET);
    responderIA(q => (q.system.includes('comprovantes de Pix')
      ? { e_comprovante_pix: true, valor: 925, recebedor_nome: 'CLAUDIO ROBERTO SOUSA BRAGA LTDA', recebedor_chave: '12.345.678/0001-90', pagador_nome: 'ANA LIMA', data_hora: '2026-10-19T11:55:00-03:00', e2e: 'E18236120202610191455s0123456789' }
      : IA()));
    const { corpo } = await teste({ texto: '', midia: { mime: 'image/jpeg', base64: '/9j/AQID' } });
    assert.deepEqual(chamadasPara(/airbnb-quote/)[0].json(), { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 4, pets: 1 });
    assert.match(banco().t('bookings')[0].notas, /4 pessoas e 1 pet\./);
    assert.match(corpo.texto, /Casa Terracota, de terça, 17\/11, a sexta, 20\/11, para 4 pessoas e 1 pet\./);
  });
});

describe('wa-webhook: nenhum campo a preencher sai para o cliente', () => {
  test('resposta de dúvida com [nome]: não envia e deixa para você', async () => {
    novoBanco(DADOS({ app_config: [{ key: 'wa_base', value: JSON.stringify({ geral: { pets: 'Aceitamos pet pequeno.' } }) }] }));
    responderIA(IA({ assunto: 'duvida', resumo: 'Pet', resposta: 'Oi [nome], aceitamos pet pequeno!' }));
    const { corpo } = await teste({ texto: 'Aceitam cachorro?' });
    assert.deepEqual([corpo.respondeu, corpo.motivo], [false, 'texto com campo a preencher ([nome]): fica para você']);
    assert.equal(banco().t('wa_messages').filter(m => m.autor === 'robo').length, 0);
    assert.equal(deal().proxima_acao, 'Responder WhatsApp: Pet');
    assert.match(globalThis.__anthropic.chamadas[0].system, /Nunca escreva campos para preencher/);
  });
  test('texto da IA com campo a preencher na resposta de valores: troca pela mensagem padrão da consulta', async () => {
    novoBanco(DADOS());
    responderIA(p => (p.system.includes('<consulta_airbnb>') ? { texto: 'Oi, {nome}! A Casa Azul fica R$ 1.650.' } : IA({ checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true })));
    simular('https://projeto.supabase.co/functions/v1/airbnb-quote', COTACAO);
    assert.equal((await teste({ texto: '17 a 20/11, 6' })).corpo.texto, COTACAO.mensagem.replace('Olá!', 'Boa tarde, Ana!'));
  });
  test('variações de campo a preencher: XX, ___, <data>, (nome do cliente)', async () => {
    for (const resposta of ['Fica R$ XX por noite', 'Check-in às ___', 'Chegada em <data>', 'Olá (nome do cliente), tudo bem?']) {
      novoBanco(DADOS({ app_config: [{ key: 'wa_base', value: JSON.stringify({ geral: { checkin: '14h' } }) }] }));
      responderIA(IA({ assunto: 'duvida', resposta }));
      assert.equal((await teste({ texto: 'horário?' })).corpo.respondeu, false, resposta);
    }
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
    assert.match(env.json().message, /data de entrada/);
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
