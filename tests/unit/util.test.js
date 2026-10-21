// util.js: datas no fuso de Pipa, formatação, WhatsApp e a captura rápida ("ligar p/ Ana amanhã #dj !").
// Relógio parado em segunda, 19/10/2026 (helpers/ambiente.js).
import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/hub.js';
import { relogio } from '../helpers/ambiente.js';

let U;
before(async () => { U = await hub('util.js'); });
afterEach(() => relogio.definir('2026-10-19T15:00:00Z'));
const nb = s => s.replace(/ /g, ' ');

describe('escape de HTML', () => {
  test('h() escapa os 5 caracteres perigosos e trata null', () => {
    assert.equal(U.h(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(U.h(null), '');
    assert.equal(U.h(undefined), '');
    assert.equal(U.h(0), '0');
  });
});

describe('datas', () => {
  test('today() usa o fuso de Pipa (21h de domingo em Pipa ainda é domingo)', () => {
    assert.equal(U.today(), '2026-10-19');
    relogio.definir('2026-10-20T00:30:00Z'); // 21h30 do dia 19 em Pipa
    assert.equal(U.today(), '2026-10-19');
  });
  test('addDays e diffDays atravessam mês e ano', () => {
    assert.equal(U.addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(U.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(U.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(U.diffDays('2026-10-19', '2026-10-26'), 7);
    assert.equal(U.diffDays('2026-10-26', '2026-10-19'), -7);
  });
  test('dow: 19/10/2026 é segunda', () => {
    assert.equal(U.dow('2026-10-19'), 1);
    assert.equal(U.weekdayShort('2026-10-25'), 'dom');
  });
  test('fmtDate curto, com ano de outro ano e por extenso', () => {
    assert.equal(U.fmtDate('2026-10-19'), '19 out');
    assert.equal(U.fmtDate('2025-03-02'), '2 mar 25');
    assert.equal(U.fmtDate('2026-10-19', { year: true }), '19 out 26');
    assert.equal(U.fmtDate('2026-10-19', { long: true }), 'segunda, 19 de outubro');
    assert.equal(U.fmtDate(''), '');
    assert.equal(U.fmtDate('2026-10-19T23:00:00Z'), '19 out');
  });
  test('relDate: hoje, amanhã, ontem, dias atrás, dia da semana e data', () => {
    assert.equal(U.relDate('2026-10-19'), 'hoje');
    assert.equal(U.relDate('2026-10-20'), 'amanhã');
    assert.equal(U.relDate('2026-10-18'), 'ontem');
    assert.equal(U.relDate('2026-10-14'), 'há 5 dias');
    assert.equal(U.relDate('2026-10-22'), 'qui');
    assert.equal(U.relDate('2026-10-29'), '29 out');
    assert.equal(U.relDate(null), 'sem data');
  });
  test('hhmm e localDate convertem timestamp UTC para Pipa', () => {
    assert.equal(U.hhmm('2026-10-19T15:00:00Z'), '12:00');
    assert.equal(U.localDate('2026-10-20T02:00:00Z'), '2026-10-19');
    assert.equal(U.mesNome(0), 'janeiro');
  });
});

describe('formatação e áreas', () => {
  test('brl sem centavos e vazio para null/""', () => {
    assert.equal(nb(U.brl(1500)), 'R$ 1.500');
    assert.equal(U.brl(null), '');
    assert.equal(U.brl(''), '');
  });
  test('areaTag usa a cor da área e cai na caixa de entrada para área desconhecida', () => {
    assert.match(U.areaTag('dj'), /--c:var\(--dj\)">DJ</);
    assert.match(U.areaTag('xyz'), /--c:var\(--muted\)">xyz</);
  });
  test('etapas do pipeline: ordem, abertas e etapa desconhecida', () => {
    assert.deepEqual(U.ETAPAS.map(e => e.id), ['lead', 'orcamento', 'negociacao', 'fechado', 'realizado', 'pago', 'perdido']);
    assert.deepEqual(U.ABERTAS, ['lead', 'orcamento', 'negociacao', 'fechado', 'realizado']);
    assert.equal(U.etapa('orcamento').sug, 'Follow-up do orçamento');
    assert.deepEqual(U.etapa('xyz'), { nome: 'xyz' });
  });
  test('etapas por negócio: mesmos ids, nomes e sugestões de cada um', () => {
    assert.deepEqual(U.abertasDe('consultoria'), ['lead', 'orcamento', 'fechado', 'realizado']);
    assert.deepEqual(U.abertasDe('flores'), U.abertasDe('consultoria'));
    assert.deepEqual(U.abertasDe('aluguel'), ['lead', 'orcamento', 'fechado']);
    assert.deepEqual(U.abertasDe('alugueis'), U.abertasDe('aluguel'));
    assert.deepEqual(U.abertasDe(undefined), U.abertasDe('dj'));
    assert.deepEqual(U.fluxo('aluguel').map(e => e.nome), ['Contato', 'Orçamento enviado', 'Reservado', 'Pago', 'Perdido']);
    assert.equal(U.etapa('fechado', 'consultoria').nome, 'Em andamento');
    assert.equal(U.etapa('realizado', 'consultoria').nome, 'Entregue');
    assert.equal(U.etapa('fechado', 'aluguel').sug, 'Receber o saldo');
    assert.equal(U.etapa('fechado', 'dj').nome, 'Fechado');
    // Etapa que o negócio não tem cai no nome do DJ
    assert.equal(U.etapa('negociacao', 'aluguel').nome, 'Negociando');
  });
  test('"Negociando" antigo fora do DJ aparece como orçamento', () => {
    assert.equal(U.etapaNoFluxo({ negocio: 'consultoria', etapa: 'negociacao' }), 'orcamento');
    assert.equal(U.etapaNoFluxo({ negocio: 'dj', etapa: 'negociacao' }), 'negociacao');
    assert.equal(U.etapaNoFluxo({ negocio: 'aluguel', etapa: 'fechado' }), 'fechado');
  });
});

describe('WhatsApp', () => {
  test('waLink normaliza os formatos de telefone brasileiros', () => {
    assert.equal(U.waLink('(84) 99999-0000', 'oi'), 'https://wa.me/5584999990000?text=oi');
    assert.equal(U.waLink('+55 84 99999-0000'), 'https://wa.me/5584999990000');
    assert.equal(U.waLink('084 99999-0000'), 'https://wa.me/5584999990000');
    assert.equal(U.waLink('5584999990000'), 'https://wa.me/5584999990000');
    assert.equal(U.waLink('Olá, tudo bem?', 'a b'), null);
    assert.equal(U.waLink('123'), null);
    assert.equal(U.waLink(null), null);
  });
  test('waLink codifica a mensagem', () => {
    assert.equal(U.waLink('84999990000', 'Oi, Ana! R$ 10 & tal'), 'https://wa.me/5584999990000?text=Oi%2C%20Ana!%20R%24%2010%20%26%20tal');
  });
  test('msgDeal: uma mensagem por etapa, com o primeiro nome', () => {
    const dj = e => U.msgDeal({ etapa: e, negocio: 'dj', data_evento: '2026-12-12' }, 'Ana Souza');
    assert.match(dj('lead'), /^Oi, Ana! Aqui é o Claudio \(DJ CLAU\)\. Me passa a data/);
    assert.match(dj('orcamento'), /Conseguiu ver o orçamento\?/);
    assert.match(dj('negociacao'), /sinal/);
    assert.match(dj('fechado'), /do dia 12 dez/);
    assert.match(dj('realizado'), /PIX/);
    assert.equal(dj('pago'), 'Oi, Ana!');
    const eng = U.msgDeal({ etapa: 'orcamento', negocio: 'consultoria' }, '');
    assert.match(eng, /^Oi! Tudo bem\? Conseguiu ver a proposta\?/);
    assert.match(U.msgDeal({ etapa: 'lead', negocio: 'consultoria' }), /Aqui é o Claudio\. Me conta/);
    assert.match(U.msgDeal({ etapa: 'fechado', negocio: 'consultoria' }), /andamento do serviço/);
    assert.match(U.msgDeal({ etapa: 'realizado', negocio: 'flores' }), /Serviço entregue!.*PIX/);
  });
  test('msgDeal de aluguel: datas e pessoas, valor, reserva garantida com PIX', () => {
    const al = e => U.msgDeal({ etapa: e, negocio: 'aluguel', data_evento: '2026-12-28' }, 'Pedro Alves');
    assert.match(al('lead'), /^Oi, Pedro! .*datas e quantas pessoas/);
    assert.match(al('orcamento'), /Conseguiu ver o valor\?/);
    assert.match(al('fechado'), /reserva está garantida para 28 dez.*PIX para o saldo/);
    assert.equal(al('pago'), 'Oi, Pedro!');
  });
});

describe('captura rápida: tarefas', () => {
  const c = t => U.parseCapture(t);
  test('texto simples vai para a caixa de entrada sem prazo', () => {
    assert.deepEqual(c('comprar cabo XLR'), { titulo: 'comprar cabo XLR', area: 'inbox', prazo: null, prioridade: 2 });
  });
  test('#tag define a área, ! marca prioridade e amanhã vira prazo', () => {
    assert.deepEqual(c('ligar p/ Guilherme amanhã #dj !'), { titulo: 'ligar p/ Guilherme', area: 'dj', prazo: '2026-10-20', prioridade: 1 });
  });
  test('tags de área conhecidas e desconhecidas', () => {
    assert.equal(c('x #aluguel').area, 'alugueis');
    assert.equal(c('x #obra').area, 'consultoria');
    assert.equal(c('x #eng').area, 'consultoria');
    assert.equal(c('x #casa').area, 'casa');
    assert.equal(c('x #pessoal').area, 'pessoal');
    assert.equal(c('x #flores').area, 'flores');
    const d = c('x #qualquer');
    assert.equal(d.area, 'inbox');
    assert.equal(d.titulo, 'x');
  });
  test('"!" grudado numa palavra não é prioridade', () => {
    assert.equal(c('oba! festa').prioridade, 2);
  });
  test('datas relativas', () => {
    assert.equal(c('pagar hoje').prazo, '2026-10-19');
    assert.equal(c('pagar depois de amanhã').prazo, '2026-10-21');
    assert.equal(c('pagar amanha').prazo, '2026-10-20');
    assert.equal(c('pagar em 3 dias').prazo, '2026-10-22');
    assert.equal(c('pagar em 1 dia').prazo, '2026-10-20');
    assert.equal(c('revisar semana que vem').prazo, '2026-10-26');
    assert.equal(c('revisar na próxima semana').prazo, '2026-10-26');
    assert.equal(c('revisar proxima semana').titulo, 'revisar');
  });
  test('"dia N": este mês ou o próximo se já passou', () => {
    assert.equal(c('IPTU dia 20').prazo, '2026-10-20');
    assert.equal(c('IPTU dia 5').prazo, '2026-11-05');
    assert.equal(c('IPTU dia 19').prazo, '2026-10-19');
  });
  test('"dia N" em dezembro passa para janeiro do ano seguinte', () => {
    relogio.definir('2026-12-20T15:00:00Z');
    assert.equal(c('IPTU dia 5').prazo, '2027-01-05');
  });
  test('"dia 31" num mês de 30 dias fica no texto, sem prazo', () => {
    relogio.definir('2026-11-05T15:00:00Z');
    const r = c('IPTU dia 31');
    assert.equal(r.prazo, null);
    assert.equal(r.titulo, 'IPTU dia 31');
  });
  test('dd/mm, dd/mm/aa e dd/mm/aaaa; data passada vai para o ano seguinte', () => {
    assert.equal(c('show 12/12').prazo, '2026-12-12');
    assert.equal(c('show 5/1').prazo, '2027-01-05');
    assert.equal(c('show 10/10/27').prazo, '2027-10-10');
    assert.equal(c('show 01/02/2028').prazo, '2028-02-01');
    assert.equal(c('show 01/02/2025').prazo, '2025-02-01'); // ano explícito não muda
  });
  test('data que não existe (31/11) fica no texto', () => {
    const r = c('show 31/11');
    assert.equal(r.prazo, null);
    assert.equal(r.titulo, 'show 31/11');
  });
  test('dia da semana por extenso e abreviado: sempre o próximo', () => {
    assert.equal(c('ligar sexta').prazo, '2026-10-23');
    assert.equal(c('ligar na quinta').prazo, '2026-10-22');
    assert.equal(c('ligar sexta-feira').prazo, '2026-10-23');
    assert.equal(c('ligar sex').prazo, '2026-10-23');
    assert.equal(c('ligar qui').prazo, '2026-10-22');
    assert.equal(c('ligar segunda').prazo, '2026-10-26'); // hoje é segunda: a próxima
    assert.equal(c('ligar terça').prazo, '2026-10-20');
    assert.equal(c('ligar terca').prazo, '2026-10-20');
    assert.equal(c('ligar sábado').prazo, '2026-10-24');
    assert.equal(c('ligar sab').prazo, '2026-10-24');
    assert.equal(c('ligar domingo').prazo, '2026-10-25');
    assert.equal(c('ligar até quarta').prazo, '2026-10-21');
    assert.equal(c('ligar ter.').prazo, '2026-10-20');
  });
  test('"ter" sozinho é o verbo, não terça', () => {
    const r = c('ter o orçamento pronto');
    assert.equal(r.prazo, null);
    assert.equal(r.titulo, 'ter o orçamento pronto');
  });
  test('palavra que só começa com dia da semana não vira data', () => {
    assert.equal(c('comprar sexta-básica').prazo, null);
    assert.equal(c('reunião seguro carro').prazo, null);
    assert.equal(c('quarteto de cordas').prazo, null);
  });
});

describe('captura rápida: oportunidades (+)', () => {
  const c = t => U.parseCapture(t);
  test('"+dj Ana Souza casamento 12/12" vira deal com data do evento', () => {
    assert.deepEqual(c('+dj Ana Souza casamento 12/12'), { tipo: 'deal', texto: 'Ana Souza casamento', negocio: 'dj', data_evento: '2026-12-12' });
  });
  test('sem negócio é DJ; aluguel, eng/obra e flores mapeiam', () => {
    assert.equal(c('+ João festa').negocio, 'dj');
    assert.equal(c('+aluguel Maria réveillon').negocio, 'aluguel');
    assert.equal(c('+alugueis Maria').negocio, 'aluguel');
    assert.equal(c('+eng reforma Pedro').negocio, 'consultoria');
    assert.equal(c('+obra Pedro').negocio, 'consultoria');
    assert.equal(c('+flores buquê').negocio, 'flores');
  });
  test('"+djalma" não é o negócio dj: é nome', () => {
    const r = c('+Djalma aniversário');
    assert.equal(r.negocio, 'dj');
    assert.equal(r.texto, 'Djalma aniversário');
  });
  test('deal sem data tem data_evento null', () => {
    assert.equal(c('+dj Ana').data_evento, null);
  });
});
