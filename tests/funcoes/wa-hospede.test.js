// Robô do WhatsApp das casas, testado como se fosse um hóspede: conversas inteiras pela Z-API, ponta a ponta.
//   hóspede (Z-API ReceivedCallback) → wa-webhook → IA simulada (helpers/ia-robo.js, segue as regras dos prompts)
//   → airbnb-quote de verdade → Airbnb falso → resposta pela Z-API (send-text) → eco fromApi da Z-API (ignorado).
// O hóspede reage ao que o robô pergunta (datas, confirmação), então os testes valem mesmo se as frases mudarem.
// Depois de cada teste, as regras que valem para TODA mensagem do robô são conferidas (ver "regras gerais").
import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';
import { relogio } from '../helpers/ambiente.js';
import { airbnbFalso, calendarSources } from '../helpers/airbnb-falso.js';
import { ligarIA } from '../helpers/ia-robo.js';

const ZAPI = { ZAPI_INSTANCE: 'INST1', ZAPI_TOKEN: 'tok1', ZAPI_CLIENT_TOKEN: 'cli1', ZAPI_WEBHOOK_KEY: 'chave-z', ANTHROPIC_API_KEY: 'sk-teste' };
const SENHA_WIFI = 'SenhaSecreta2026', PIX = 'pix@casaspipa.com.br';
const BASE = {
  geral: { endereco: 'Condomínio Pipa Natureza, Pipa/RN', checkin: '14h', checkout: '10h', pets: 'A Casa Frida e a Casa Terracota aceitam pets; a Casa Azul não aceita.',
    regras: 'Proibido festas e som alto depois das 22h.', pix_chave: PIX, pix_nome: 'Claudio', sinal_pct: '30' },
  casas: { QS40: { capacidade: '6 pessoas', wifi_rede: 'CasaAzul', wifi_senha: SENHA_WIFI, localizacao: 'https://maps.app.goo.gl/azul' } },
};
const DADOS = (x = {}) => comCron({
  properties: [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }, { id: 'QS50', nome: 'Casa Terracota' }],
  calendar_sources: calendarSources(),
  wa_settings: [{ id: 1, bot_ativo: true, horas_silencio: 12, max_respostas_dia: 4 }],
  app_config: [{ key: 'wa_base', value: JSON.stringify(BASE) }],
  ...x,
});
const CASAS = { QS39: { diaria: 450, lotacao: 8 }, QS40: { diaria: 520, lotacao: 6 }, QS50: { diaria: 380, lotacao: 7 } };

let wa, quote, ia, ab, seq = 0;
const ZURL = /api\.z-api\.io\/instances\/INST1\/token\/tok1\/send-text/;
const enviadas = () => chamadasPara(ZURL).map(c => ({ ...c.json(), clientToken: c.headers['client-token'] }));

// Um hóspede no WhatsApp das casas
class Hospede {
  constructor(fone, nome) { Object.assign(this, { fone, nome, recebidas: [] }); }
  // Manda uma mensagem e devolve o que o robô respondeu a ela (texto), ou null se ficou quieto
  async diz(texto, extra = {}) {
    relogio.avancar(60e3);
    const antes = enviadas().length;
    const id = extra.messageId || `ZIN${++seq}`;
    const r = await wa(pedido('/wa-webhook?zapi=chave-z', { auth: null, corpo: {
      type: 'ReceivedCallback', instanceId: 'INST1', messageId: id, phone: this.fone, fromMe: false, momment: Date.now(),
      status: 'RECEIVED', senderName: this.nome, chatName: this.nome, isGroup: false, isNewsletter: false, text: { message: texto }, ...extra,
    } }));
    assert.equal(r.status, 200);
    const novas = enviadas().slice(antes).filter(m => m.phone === this.fone);
    // a Z-API avisa de volta as mensagens que o robô mandou pela API (fromMe + fromApi): o robô tem de ignorar
    for (const m of novas) await zapi({ messageId: m.zid, phone: this.fone, fromMe: true, fromApi: true, text: { message: m.message } });
    this.recebidas.push(...novas.map(m => m.message));
    return novas.length ? novas.map(m => m.message).join('\n') : null;
  }
  // Conversa até receber valores: responde o que o robô perguntar (confirmação, saída, datas, pessoas), no máximo 4 voltas.
  // this.perguntas guarda as perguntas que o robô fez no caminho.
  async ateValores(primeira, { datas, saida, pessoas } = {}) {
    this.perguntas = [];
    let r = await this.diz(primeira);
    for (let i = 0; i < 4 && r && !/R\$/.test(r); i++) {
      this.perguntas.push(r);
      const partes = [];
      if (/consultar certinho|seria de|seria (no|na)|está certo/i.test(r)) partes.push('isso mesmo');
      if (/até que dia|quantas noites/i.test(r) && saida) partes.push(`até dia ${saida}`);
      if (/data de entrada/i.test(r) && datas) partes.push(datas);
      if (/quantas pessoas/i.test(r) && pessoas) partes.push(`somos ${pessoas}`);
      if (!partes.length) break;
      r = await this.diz(partes.join(', '));
    }
    return r;
  }
  get conversa() { return banco().t('wa_messages').filter(m => m.wa_id === this.fone).sort((a, b) => a.enviado_em.localeCompare(b.enviado_em)); }
  get card() { const c = banco().t('wa_contacts').find(x => x.wa_id === this.fone); return banco().t('deals').find(d => d.id === c?.deal_id); }
  get ultimaDecisao() { return this.conversa.filter(m => m.autor === 'cliente').at(-1)?.extracao?.robo; }
}
const zapi = corpo => wa(pedido('/wa-webhook?zapi=chave-z', { auth: null, corpo: { type: 'ReceivedCallback', instanceId: 'INST1', momment: Date.now(), isGroup: false, ...corpo } }));
// Valores (em centavos) que aparecem num texto: "R$ 1.660" → 166000
const valores = t => [...String(t).matchAll(/R\$\s*([\d.]+(?:,\d{1,2})?)/g)].map(m => Math.round(+m[1].replace(/\./g, '').replace(',', '.') * 100));
// Tudo que a airbnb-quote devolveu ao robô nesta conversa (totais e diárias, inclusive alternativas)
const valoresDaConsulta = h => {
  const s = new Set();
  for (const m of h.conversa) for (const c of m.cotacao?.casas || []) for (const v of [c.total, c.diaria, c.alternativa?.total, c.alternativa?.diaria]) if (v != null) s.add(Math.round(v * 100));
  return s;
};

before(async () => {
  quote = await carregarFuncao('airbnb-quote');
  wa = await carregarFuncao('wa-webhook', ZAPI);
});
beforeEach(() => {
  relogio.definir('2026-10-19T15:00:00Z');
  limparRede();
  for (const [k, v] of Object.entries(ZAPI)) definirEnv(k, v);
  novoBanco(DADOS());
  ia = ligarIA();
  ab = airbnbFalso({ casas: CASAS });
  let n = 0;
  simular(ZURL, req => { const id = `ZOUT${++n}`; return { zaapId: id, messageId: id, id }; });
  // a wa-webhook chama a airbnb-quote como função do Supabase: aqui ela roda de verdade, com o Airbnb falso
  simular('https://projeto.supabase.co/functions/v1/airbnb-quote', req => quote(new Request(req.url, { method: 'POST', headers: req.headers, body: req.corpo })));
});

// ---------- regras gerais: valem para toda mensagem do robô, em todos os testes ----------
afterEach(() => {
  const todas = chamadasPara(ZURL);
  for (const c of todas) {
    const { phone, message } = c.json();
    assert.equal(c.headers['client-token'], 'cli1', 'toda mensagem sai com o Client-Token da Z-API');
    assert.match(phone, /^\d{12,13}$/, 'sempre para o telefone do hóspede');
    assert.ok(message?.trim(), 'nunca manda mensagem vazia');
    assert.doesNotMatch(message, /undefined|null|NaN|\[object/, `texto com lixo de programação: ${message}`);
    assert.doesNotMatch(message, /\[[^\]]{1,40}\]|\{\{?[^}]*\}|_{3,}|\bX{2,}\b/, `campo a preencher esquecido: ${message}`);
    assert.ok(!message.includes(SENHA_WIFI), 'nunca manda a senha do Wi-Fi');
    assert.ok(!message.includes(PIX), 'nunca manda a chave Pix');
    assert.ok(!message.includes('maps.app.goo.gl'), 'nunca manda o link da localização exata');
    assert.doesNotMatch(message, /reserva (est[aá] )?confirmada|confirmo (a|sua) reserva/i, 'nunca confirma reserva');
  }
  for (const p of ia.chamadas) assert.ok(!String(p.system).includes(SENHA_WIFI) && !String(p.system).includes(PIX), 'senha do Wi-Fi e Pix nunca vão para a IA do robô');
});

describe('hóspede: do primeiro "oi" até os valores', () => {
  test('família: cumprimenta, recebe as boas-vindas, passa datas e pessoas e recebe os valores do Airbnb', async () => {
    const h = new Hospede('5584991110001', 'Marina Souza');
    const oi = await h.diz('Oi, boa tarde!');
    assert.ok(oi, 'o robô responde ao cumprimento');
    for (const casa of ['Azul', 'Frida', 'Terracota']) assert.match(oi, new RegExp(casa), 'as boas-vindas apresentam as 3 casas');
    assert.match(oi, /data|entrada/i, 'e pedem as datas');
    const r = await h.ateValores('Queremos de 17 a 20 de novembro, somos 6 pessoas', { datas: 'de 17 a 20 de novembro', pessoas: 6 });
    assert.match(r, /R\$/, 'recebe valores');
    assert.ok(ab.consultas.some(c => c.ci === '2026-11-17' && c.co === '2026-11-20' && c.adultos === 6), 'o Airbnb foi consultado com as datas e as 6 pessoas');
    const v = valores(r);
    assert.ok(v.length > 0);
    assert.ok(v.every(x => valoresDaConsulta(h).has(x)), `todo valor dito saiu do Airbnb: ${r}`);
    assert.ok(v.includes(ab.total('QS40', '2026-11-17', '2026-11-20') * 100), 'inclui o total da Casa Azul (cabe 6)');
    const card = h.card;
    assert.equal(card.etapa, 'orcamento', 'o card vai para "Orçamento enviado"');
    assert.equal(card.data_evento, '2026-11-17');
    assert.match(card.proxima_acao, /^Acompanhar/);
    assert.equal(card.titulo, 'Aluguéis — Marina Souza');
  });
  test('pede uma casa específica e pergunta de pet: responde sobre ela primeiro, com o valor e a regra de pets', async () => {
    const h = new Hospede('5584991110002', 'Rafael Lima');
    const r = await h.ateValores('Boa tarde! A Casa Azul está livre de 5 a 8/12 para 4 pessoas? Vou levar meu cachorro.', { datas: 'de 5 a 8/12', pessoas: 4 });
    assert.match(r, /Casa Azul/);
    const azul = ab.total('QS40', '2026-12-05', '2026-12-08');
    assert.ok(valores(r).includes(azul * 100), `fala o total da Azul (R$ ${azul})`);
    assert.match(r, /pet|cachorro/i, 'responde junto a dúvida do pet');
    assert.match(r, /Azul não aceita/, 'com a regra cadastrada (a Azul não aceita pets)');
    assert.equal(h.card.valor, azul, 'o card guarda o valor da casa pedida');
    assert.equal(h.card.local, 'Casa Azul');
  });
  test('começo de conversa: a resposta usa o primeiro nome do perfil', async () => {
    const h = new Hospede('5584991110003', 'Juliana Prado');
    const r = await h.ateValores('Quanto fica de 10 a 13/11 para 2 pessoas?', { datas: 'de 10 a 13/11', pessoas: 2 });
    assert.match(r, /Juliana/);
    assert.doesNotMatch(r, /Prado/);
  });
  test('data vaga (réveillon, um casal): primeiro confirma o período, só então consulta', async () => {
    const h = new Hospede('5584991110004', 'Pedro');
    const r = await h.ateValores('Quanto fica o réveillon para um casal?', { pessoas: 2 });
    assert.match(h.perguntas[0], /consultar certinho/i, 'pergunta antes de cotar');
    assert.match(h.perguntas[0], /30\/12.*02\/01/, 'mostrando o período que entendeu');
    assert.match(r, /R\$/);
    assert.ok(ab.consultas.some(c => c.ci === '2026-12-30' && c.co === '2027-01-02' && c.adultos === 2), 'consultou 30/12 a 02/01 para 2');
  });
  test('só a data de entrada: pergunta até que dia, junta as respostas e consulta', async () => {
    const h = new Hospede('5584991110005', 'Lia');
    const r = await h.ateValores('Tem vaga dia 15/11? Somos 3', { saida: '18/11', pessoas: 3 });
    assert.ok(h.perguntas.some(p => /até que dia/i.test(p)), 'pergunta a saída');
    assert.ok(h.perguntas.every(p => !/quantas pessoas/i.test(p)), 'não pergunta de novo o que já sabe (3 pessoas)');
    assert.match(r, /R\$/);
    assert.ok(ab.consultas.some(c => c.ci === '2026-11-15' && c.co === '2026-11-18' && c.adultos === 3));
  });
  test('sem número de pessoas: pergunta (não supõe 2)', async () => {
    const h = new Hospede('5584991110007', 'Mateus');
    const r = await h.ateValores('Tem vaga de 10 a 13/11?', { pessoas: 5 });
    assert.match(h.perguntas[0], /quantas pessoas/i);
    assert.match(r, /R\$/);
    assert.ok(ab.consultas.every(c => c.adultos === 5));
  });
  test('o hóspede muda o número de pessoas: o robô consulta de novo com o número novo', async () => {
    const h = new Hospede('5584991110006', 'Bruno');
    await h.ateValores('Tem vaga de 10 a 12/11 para 4 pessoas?', { datas: 'de 10 a 12/11', pessoas: 4 });
    const r = await h.diz('Na verdade seremos 7');
    assert.ok(r, 'responde de novo');
    assert.ok(ab.consultas.some(c => c.ci === '2026-11-10' && c.adultos === 7), 'reconsultou para 7 pessoas, mantendo as datas');
    assert.match(r, /Azul.*(não comporta|NÃO COMPORTA)|não comporta/i, 'a Azul (6 pessoas) não comporta 7');
  });
});

describe('hóspede: situações difíceis', () => {
  test('grupo grande demais para todas as casas: diz que não comporta e não inventa valor', async () => {
    const h = new Hospede('5584991110010', 'Turma da Faculdade');
    const r = await h.ateValores('Tem casa para 12 pessoas de 6 a 8/11?', { datas: 'de 6 a 8/11', pessoas: 12 });
    assert.ok(r);
    assert.match(r, /não comporta|NÃO COMPORTA/i);
    assert.deepEqual(valores(r), [], 'nenhum valor (nenhuma casa cabe 12)');
    assert.equal(h.card.valor, undefined);
  });
  test('casa pedida ocupada: avisa e oferece a data livre mais próxima com o valor certo', async () => {
    ab = airbnbFalso({ casas: { ...CASAS, QS39: { ...CASAS.QS39, ocupados: ['2026-11-20', '2026-11-21'] } } });
    const h = new Hospede('5584991110011', 'Camila');
    const r = await h.ateValores('A Casa Frida está livre de 20 a 23/11 para 2 pessoas?', { datas: 'de 20 a 23/11', pessoas: 2 });
    assert.match(r, /Frida/);
    assert.match(r, /ocupada|OCUPADA/i);
    assert.match(r, /Alternativa|livre de/i, 'oferece outra data');
    assert.ok(valores(r).every(x => valoresDaConsulta(h).has(x)), `valores da alternativa saíram do Airbnb: ${r}`);
  });
  test('data no passado: pede as datas de novo, sem consultar o Airbnb', async () => {
    const h = new Hospede('5584991110012', 'Davi');
    const r = await h.diz('Tem vaga de 01/10/2026 a 03/10/2026 para 2 pessoas?');
    assert.ok(r);
    assert.match(r, /data/i);
    assert.equal(ab.consultas.length, 0);
  });
  test('Airbnb fora do ar: o robô fica quieto e o card avisa o Claudio', async () => {
    ab = airbnbFalso({ casas: CASAS, falha: ['QS39', 'QS40', 'QS50'] });
    const h = new Hospede('5584991110013', 'Eduardo');
    const r = await h.diz('Tem vaga de 17 a 20/11 para 4 pessoas?');
    assert.equal(r, null, 'não responde com consulta quebrada');
    assert.match(h.ultimaDecisao, /Airbnb falhou/);
    assert.match(h.card.proxima_acao, /^Responder WhatsApp/);
  });
  test('a IA tenta escrever um preço que não existe: vai a mensagem padrão, com os valores reais', async () => {
    ia.mentir = true;
    const h = new Hospede('5584991110014', 'Fábio');
    const r = await h.ateValores('Quanto fica de 10 a 13/11 para 2 pessoas?', { datas: 'de 10 a 13/11', pessoas: 2 });
    assert.doesNotMatch(r, /999/, 'o valor inventado não sai');
    assert.ok(valores(r).length && valores(r).every(x => valoresDaConsulta(h).has(x)));
  });
  test('IA fora do ar: fica quieto e explica o motivo na conversa', async () => {
    ia.foraDoAr = true;
    const h = new Hospede('5584991110015', 'Gabi');
    assert.equal(await h.diz('Tem vaga de 10 a 13/11?'), null);
    assert.match(h.ultimaDecisao, /IA indisponível/);
  });
});

describe('hóspede: o que fica para o Claudio', () => {
  test('quer reservar e pede o Pix: o robô não responde (nem manda Pix) e o card avisa', async () => {
    const h = new Hospede('5584991110020', 'Helena');
    await h.ateValores('Quanto fica a Casa Azul de 5 a 8/12 para 4 pessoas?', { datas: 'de 5 a 8/12', pessoas: 4 });
    const n = h.recebidas.length;
    assert.equal(await h.diz('Perfeito, quero reservar! Me passa o pix'), null);
    assert.equal(h.recebidas.length, n);
    assert.match(h.ultimaDecisao, /fica para você/);
    assert.match(h.card.proxima_acao, /^Responder WhatsApp/);
  });
  test('pede a senha do Wi-Fi: fica para o Claudio (a senha nunca vai para o robô)', async () => {
    const h = new Hospede('5584991110021', 'Igor');
    assert.equal(await h.diz('Qual a senha do wifi da casa azul?'), null);
  });
  test('reclamação: fica para o Claudio', async () => {
    const h = new Hospede('5584991110022', 'Joana');
    assert.equal(await h.diz('O chuveiro do quarto não está esquentando'), null);
    assert.match(h.ultimaDecisao, /fica para você/);
  });
  test('áudio e foto: ficam para o Claudio, guardados com o tipo', async () => {
    const h = new Hospede('5584991110023', 'Karen');
    assert.equal(await h.diz(undefined, { text: undefined, audio: { audioUrl: 'https://x/a.ogg' } }), null);
    assert.equal(await h.diz(undefined, { text: undefined, image: { caption: 'essa é a casa?' } }), null);
    assert.deepEqual(h.conversa.map(m => m.texto), ['[audio]', '[image] essa é a casa?']);
  });
});

describe('hóspede: dúvidas que as informações das casas respondem', () => {
  test('horário de check-in: responde com o que está cadastrado', async () => {
    const h = new Hospede('5584991110030', 'Lucas');
    const r = await h.diz('Que horas é o check-in?');
    assert.match(r, /14h/);
    assert.match(h.card.proxima_acao, /dúvida/);
  });
  test('pets: responde a regra de cada casa', async () => {
    const h = new Hospede('5584991110031', 'Mariana');
    const r = await h.diz('Vocês aceitam cachorro?');
    assert.match(r, /Frida e a Casa Terracota aceitam pets; a Casa Azul não aceita/);
  });
  test('sem as informações cadastradas, a mesma dúvida fica para o Claudio', async () => {
    novoBanco(DADOS({ app_config: [] }));
    const h = new Hospede('5584991110032', 'Nina');
    assert.equal(await h.diz('Que horas é o check-in?'), null);
  });
});

describe('hóspede: ritmo da conversa', () => {
  test('o Claudio responde pelo celular no meio: o robô para de responder essa pessoa', async () => {
    const h = new Hospede('5584991110040', 'Otávio');
    assert.ok(await h.diz('Oi!'));
    relogio.avancar(60e3);
    await zapi({ messageId: 'ZCLAUDIO1', phone: h.fone, fromMe: true, fromApi: false, text: { message: 'Oi Otávio, aqui é o Claudio. Já te respondo!' } });
    assert.equal(await h.diz('Tem vaga de 10 a 13/11 para 2?'), null, 'quieto depois da resposta à mão');
    assert.match(h.ultimaDecisao, /respondeu à mão/);
    assert.deepEqual(h.conversa.map(m => m.autor), ['cliente', 'robo', 'claudio', 'cliente']);
    assert.equal(h.card.proxima_acao, 'Responder WhatsApp', 'o card avisa o Claudio para responder');
  });
  test('hóspede insistente: no máximo 4 respostas automáticas em 24 h', async () => {
    const h = new Hospede('5584991110041', 'Paula');
    const dias = ['2/11', '3/11', '4/11', '5/11', '6/11', '7/11'];
    const respostas = [];
    for (const d of dias) respostas.push(await h.diz(`E dia ${d}, 2 pessoas, quanto fica?`));
    assert.equal(respostas.filter(Boolean).length, 4);
    assert.match(h.ultimaDecisao, /limite de 4 respostas/);
  });
  test('as mensagens que o robô manda voltam da Z-API como fromApi e não viram conversa nem silêncio', async () => {
    const h = new Hospede('5584991110042', 'Quitéria');
    await h.ateValores('Oi', { datas: 'de 10 a 12/11', pessoas: 2 });
    assert.ok(h.conversa.every(m => m.autor !== 'claudio'), 'nenhuma mensagem do robô virou "do Claudio"');
    assert.equal(banco().t('wa_contacts').find(c => c.wa_id === h.fone).ultima_manual, undefined, 'o robô não se silenciou sozinho');
    assert.ok(h.recebidas.length >= 2);
  });
  test('reentrega da Z-API (mesmo messageId) não gera resposta repetida', async () => {
    const h = new Hospede('5584991110043', 'Rita');
    const a = await h.diz('Quanto fica de 10 a 13/11 para 2 pessoas?', { messageId: 'ZDUP' });
    const b = await h.diz('Quanto fica de 10 a 13/11 para 2 pessoas?', { messageId: 'ZDUP' });
    assert.ok(a);
    assert.equal(b, null);
    assert.equal(h.conversa.filter(m => m.autor === 'cliente').length, 1);
  });
  test('dois hóspedes ao mesmo tempo: cada um no seu card, cada resposta no telefone certo', async () => {
    const a = new Hospede('5584991110044', 'Sofia'), b = new Hospede('5584991110045', 'Tiago');
    await a.diz('Oi');
    await b.diz('Boa noite');
    const ra = await a.ateValores('Casa Frida de 10 a 13/11, 2 pessoas', { datas: 'de 10 a 13/11', pessoas: 2 });
    const rb = await b.ateValores('Casa Terracota de 20 a 22/11, somos 5', { datas: 'de 20 a 22/11', pessoas: 5 });
    assert.notEqual(a.card.id, b.card.id);
    assert.equal(a.card.local, 'Casa Frida');
    assert.equal(b.card.local, 'Casa Terracota');
    assert.ok(valores(ra).includes(ab.total('QS39', '2026-11-10', '2026-11-13') * 100));
    assert.ok(valores(rb).includes(ab.total('QS50', '2026-11-20', '2026-11-22') * 100));
    assert.ok(enviadas().every(m => [a.fone, b.fone].includes(m.phone)));
  });
  test('robô desligado em Ajustes: nenhuma resposta, mas a conversa e o card continuam chegando', async () => {
    banco().t('wa_settings')[0].bot_ativo = false;
    const h = new Hospede('5584991110046', 'Ulisses');
    assert.equal(await h.diz('Tem vaga de 10 a 13/11?'), null);
    assert.equal(h.card.proxima_acao, 'Responder WhatsApp');
    assert.equal(h.conversa.length, 1);
  });
});
