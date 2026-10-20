// store.js (modo local): carga, "Escapando" (atencao), conflitos gig × casa, reservas duplas, itens da agenda e contatos.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/hub.js';

let S, store;
before(async () => { store = await hub('store.js'); S = store.S; });
async function semear(t = {}) {
  localStorage.clear();
  for (const [k, v] of Object.entries(t)) localStorage.setItem('hub:' + k, JSON.stringify(v));
  await store.load();
}
const CASAS = [{ id: 'QS39', nome: 'Casa Frida', cor: '#c2410c' }, { id: 'QS40', nome: 'Casa Azul', cor: '#1d4ed8' }, { id: 'QS50', nome: 'Casa Terracota', cor: '#a16207' }];
const deal = x => ({ negocio: 'dj', etapa: 'lead', titulo: 'Deal', proxima_acao: 'Ligar', data_proxima_acao: '2026-10-25', updated_at: '2026-10-19T10:00:00Z', ...x });
const reserva = x => ({ status: 'confirmada', origem: 'airbnb', property_id: 'QS39', ...x });

describe('carga', () => {
  test('modo local sem casas cria as 3 casas padrão', async () => {
    await semear();
    assert.deepEqual(S.properties.map(p => p.id).sort(), ['QS39', 'QS40', 'QS50']);
    assert.equal(store.meta.offline, false);
    assert.equal(store.meta.erro, null);
    assert.equal(store.meta.at, '2026-10-19T15:00:00.000Z');
  });
  test('carrega todas as tabelas e avisa os ouvintes', async () => {
    let n = 0;
    store.onChange(() => n++);
    await semear({ properties: CASAS, contacts: [{ id: 'c1', nome: 'Ana' }] });
    assert.equal(S.contacts.length, 1);
    assert.ok(n >= 1);
    assert.deepEqual(store.TABLES, ['contacts', 'deals', 'quotes', 'tasks', 'properties', 'bookings', 'events', 'calendar_sources', 'habits', 'habit_logs', 'crypto_watch', 'crypto_tx', 'crypto_snap']);
  });
  test('modo local não grava a cópia hub:snap (só com Supabase)', async () => {
    await semear({ properties: CASAS });
    assert.equal(localStorage.getItem('hub:snap'), null);
  });
});

describe('buscas', () => {
  before(() => semear({ properties: CASAS, contacts: [{ id: 'c1', nome: 'Ana Souza', telefone: '84 9999-0000' }] }));
  test('byId, contactName, contatoPorNome (sem caixa e espaços), prop', () => {
    assert.equal(store.byId('contacts', 'c1').nome, 'Ana Souza');
    assert.equal(store.contactName('c1'), 'Ana Souza');
    assert.equal(store.contactName('x'), '');
    assert.equal(store.contatoPorNome('  ana souza ').id, 'c1');
    assert.equal(store.contatoPorNome(null), undefined);
    assert.equal(store.prop('QS40').nome, 'Casa Azul');
    assert.deepEqual(store.prop('ZZ'), { nome: 'ZZ', cor: '#888' });
  });
});

describe('ensureContact', () => {
  beforeEach(() => semear({ properties: CASAS, contacts: [{ id: 'c1', nome: 'Ana Souza', telefone: '111' }] }));
  test('nome existente devolve o id e atualiza o telefone novo', async () => {
    assert.equal(await store.ensureContact('ANA SOUZA', 'cliente', ' 222 '), 'c1');
    assert.equal(S.contacts[0].telefone, '222');
    assert.equal(JSON.parse(localStorage.getItem('hub:contacts'))[0].telefone, '222');
  });
  test('nome novo cria contato com tipo, telefone e última interação', async () => {
    const id = await store.ensureContact(' Bia ', 'hospede', '');
    const c = S.contacts.find(c => c.id === id);
    assert.deepEqual({ nome: c.nome, tipo: c.tipo, telefone: c.telefone, ultima_interacao: c.ultima_interacao }, { nome: 'Bia', tipo: 'hospede', telefone: null, ultima_interacao: '2026-10-19' });
  });
  test('nome vazio devolve null', async () => {
    assert.equal(await store.ensureContact('   '), null);
  });
});

describe('save e del', () => {
  test('save insere, recarrega e devolve a linha; com id atualiza; del remove', async () => {
    await semear({ properties: CASAS });
    const t = await store.save('tasks', { titulo: 'Comprar cabo' });
    assert.equal(S.tasks.length, 1);
    await store.save('tasks', { feito: true }, t.id);
    assert.equal(S.tasks[0].feito, true);
    await store.del('tasks', t.id);
    assert.equal(S.tasks.length, 0);
  });
});

describe('Escapando (atencao)', () => {
  before(() => semear({
    properties: CASAS,
    contacts: [{ id: 'c1', nome: 'Ana' }],
    deals: [
      deal({ id: 'semacao', titulo: 'Sem passo', proxima_acao: ' ', created_at: '2026-10-01T12:00:00Z', updated_at: null }),
      deal({ id: 'atrasada', etapa: 'orcamento', contato_id: 'c1', proxima_acao: 'Follow-up', data_proxima_acao: '2026-10-15' }),
      deal({ id: 'parado', etapa: 'negociacao', titulo: 'Festa', updated_at: '2026-10-10T12:00:00Z' }),
      deal({ id: 'quase', etapa: 'negociacao', updated_at: '2026-10-15T12:00:00Z' }), // 4 dias: ainda não
      deal({ id: 'passou', etapa: 'fechado', titulo: 'Casamento', data_evento: '2026-10-10' }),
      deal({ id: 'pago', etapa: 'pago', data_proxima_acao: '2026-01-01' }),
      deal({ id: 'perdido', etapa: 'perdido', proxima_acao: '' }),
    ],
    tasks: [{ id: 't1', titulo: 'Pagar IPTU', prazo: '2026-10-18', area: 'casa' }, { id: 't2', titulo: 'Feita', prazo: '2026-10-01', feito: true }, { id: 't3', titulo: 'Futura', prazo: '2026-10-30' }],
    bookings: [reserva({ id: 'b1', origem: 'direto', hospede: 'Bia', checkin: '2026-10-25', checkout: '2026-10-28', etapas: {} })],
  }));
  test('lista cada motivo uma vez, em ordem de data', () => {
    const a = store.atencao();
    assert.deepEqual(a.map(x => [x.ref.id, x.motivo]), [
      ['semacao', 'sem próxima ação'],
      ['b1', 'atrasada'], // orçamento venceu em 04/10
      ['parado', 'parado'],
      ['passou', 'evento passou'],
      ['atrasada', 'atrasada'],
      ['t1', 'atrasada'],
    ]);
  });
  test('textos dos itens', () => {
    const a = Object.fromEntries(store.atencao().map(x => [x.ref.id + x.motivo, x]));
    assert.equal(a['semacaosem próxima ação'].title, 'Sem passo: sem próxima ação');
    assert.equal(a.paradoparado.title, 'Festa: sem movimento há 9 dias');
    assert.equal(a.paradoparado.sub, 'Próxima ação: Ligar');
    assert.equal(a.atrasadaatrasada.sub, 'Ana');
    assert.equal(a['passouevento passou'].sub, 'Mover para Realizado e cobrar');
    assert.equal(a.b1atrasada.title, 'Enviar orçamento · Casa Frida');
    assert.equal(a.b1atrasada.sub, 'Bia, check-in 25/10');
  });
});

describe('conflitos gig × check-in/out', () => {
  beforeEach(() => semear({
    properties: CASAS,
    contacts: [{ id: 'c1', nome: 'Ana' }],
    deals: [
      deal({ id: 'g1', etapa: 'fechado', contato_id: 'c1', data_evento: '2026-10-24' }),
      deal({ id: 'g2', etapa: 'perdido', data_evento: '2026-10-24' }),
      deal({ id: 'g3', etapa: 'fechado', data_evento: '2026-12-24' }), // além de 30 dias
      deal({ id: 'g4', negocio: 'consultoria', etapa: 'fechado', data_evento: '2026-10-24' }),
    ],
    bookings: [
      reserva({ id: 'b1', property_id: 'QS39', checkin: '2026-10-24', checkout: '2026-10-27' }),
      reserva({ id: 'b2', property_id: 'QS40', checkin: '2026-10-20', checkout: '2026-10-25' }),
      reserva({ id: 'b4', property_id: 'QS50', checkin: '2026-10-21', checkout: '2026-10-24' }), // check-out de manhã, gig à noite: não conflita
      reserva({ id: 'b3', property_id: 'QS50', status: 'bloqueio', checkin: '2026-10-24', checkout: '2026-10-26' }),
    ],
  }));
  test('check-in no dia e check-out na manhã seguinte; ignora check-out no dia, perdido, longe, não-DJ e bloqueio', () => {
    const c = store.conflitos();
    assert.deepEqual(c.map(x => x.chave), ['g1|b1|Check-in', 'g1|b2|Check-out']);
    assert.equal(c[0].title, 'Gig Ana × Check-in Casa Frida');
    assert.match(c[0].sub, /^No mesmo dia \(24\/10\)/);
    assert.match(c[1].sub, /^Check-out na manhã seguinte \(25\/10\)/);
  });
  test('marcarCiente some com o conflito, guarda no aparelho e avisa a tela', () => {
    let avisos = 0;
    store.onChange(() => avisos++);
    store.marcarCiente('g1|b1|Check-in');
    assert.deepEqual(store.conflitos().map(x => x.chave), ['g1|b2|Check-out']);
    assert.deepEqual(JSON.parse(localStorage.getItem('hub:conflitos-ok')), ['g1|b1|Check-in']);
    assert.ok(avisos >= 1);
  });
  test('conflitos entram no Escapando', () => {
    assert.equal(store.atencao().filter(x => x.kind === 'conflito').length, 2);
  });
});

describe('reservas duplas', () => {
  beforeEach(() => semear({
    properties: CASAS,
    bookings: [
      reserva({ id: 'a', property_id: 'QS50', hospede: 'Ana', origem: 'airbnb', checkin: '2026-10-30', checkout: '2026-11-02' }),
      reserva({ id: 'b', property_id: 'QS50', hospede: null, origem: 'direto', checkin: '2026-11-01', checkout: '2026-11-03' }),
      reserva({ id: 'c', property_id: 'QS50', origem: 'direto', checkin: '2026-11-03', checkout: '2026-11-05' }), // encosta, não sobrepõe
      reserva({ id: 'd', property_id: 'QS50', status: 'bloqueio', checkin: '2026-10-30', checkout: '2026-11-05' }),
      reserva({ id: 'e', property_id: 'QS39', checkin: '2026-11-01', checkout: '2026-11-02' }),
      reserva({ id: 'f', property_id: 'QS39', checkin: '2026-10-01', checkout: '2026-10-05' }), // passada
      reserva({ id: 'g', property_id: 'QS39', checkin: '2026-10-02', checkout: '2026-10-04' }),
    ],
  }));
  test('só confirmadas, mesma casa, noites em comum e futuras', () => {
    const d = store.reservasDuplas();
    assert.equal(d.length, 1);
    assert.equal(d[0].chave, 'dupla|a|b');
    assert.equal(d[0].title, 'Reserva dupla · Casa Terracota');
    assert.equal(d[0].sub, 'Ana (airbnb, 30/10 a 02/11) × sem nome (direto, 01/11 a 03/11)');
  });
  test('ciente esconde', () => {
    store.marcarCiente('dupla|a|b');
    assert.deepEqual(store.reservasDuplas(), []);
  });
});

describe('itens da agenda (items)', () => {
  before(() => semear({
    properties: CASAS,
    contacts: [{ id: 'c1', nome: 'Ana' }],
    deals: [
      deal({ id: 'd1', etapa: 'lead', contato_id: 'c1', data_proxima_acao: '2026-10-20', proxima_acao: 'Enviar orçamento', data_evento: '2026-10-24', hora_inicio: '22:00:00', hora_fim: '02:00:00', local: 'Pipa' }),
      deal({ id: 'd2', etapa: 'fechado', titulo: 'Casamento X', data_proxima_acao: '2026-11-30', data_evento: '2026-10-21' }),
      deal({ id: 'd3', etapa: 'perdido', data_evento: '2026-10-22' }),
    ],
    tasks: [{ id: 't1', titulo: 'Tarefa', prazo: '2026-10-21', area: 'casa', prioridade: 1 }, { id: 't2', titulo: 'Feita', prazo: '2026-10-21', feito: true }],
    bookings: [
      reserva({ id: 'b1', property_id: 'QS40', hospede: 'Bia', checkin: '2026-10-22', checkout: '2026-10-23' }),
      reserva({ id: 'b2', status: 'bloqueio', checkin: '2026-10-22', checkout: '2026-10-23' }),
      reserva({ id: 'b3', status: 'cancelada', checkin: '2026-10-22', checkout: '2026-10-23' }),
    ],
    events: [
      { id: 'e1', calendario: 'pessoal', titulo: 'Dentista', inicio: '2026-10-21T13:30:00Z', fim: '2026-10-21T14:30:00Z' },
      { id: 'e2', calendario: 'dj', titulo: 'Feriado', dia_inteiro: true, inicio: '2026-10-20T00:00:00Z' },
      { id: 'e3', calendario: 'outro', titulo: 'Fora', inicio: '2026-10-21T13:00:00Z' },
    ],
  }));
  test('junta ações, gigs, tarefas, check-in/out, etapas de hospedagem e eventos, em ordem de data e hora', () => {
    const it = store.items({ from: '2026-10-19', to: '2026-10-24' });
    assert.deepEqual(it.map(i => `${i.date} ${i.time || '--'} ${i.kind} ${i.title}`), [
      '2026-10-19 -- etapa Receber nomes e documentos dos hóspedes · Casa Azul',
      '2026-10-20 -- acao Enviar orçamento',
      '2026-10-20 -- etapa Enviar lista para a portaria · Casa Azul',
      '2026-10-20 -- evento Feriado',
      '2026-10-21 10:30 evento Dentista',
      '2026-10-21 -- gig Casamento X',
      '2026-10-21 -- tarefa Tarefa',
      '2026-10-21 -- etapa Confirmar faxina da casa · Casa Azul',
      '2026-10-22 -- checkin Check-in Casa Azul',
      '2026-10-23 -- checkout Check-out Casa Azul',
      '2026-10-24 22:00 gig Ana',
    ]);
  });
  test('detalhes: gig provisória, horário, sub do check-in', () => {
    const it = store.items({ from: '2026-10-19', to: '2026-10-24' });
    const gig = it.find(i => i.kind === 'gig' && i.ref.id === 'd1');
    assert.deepEqual({ time: gig.time, end: gig.end, sub: gig.sub, tentative: gig.tentative }, { time: '22:00', end: '02:00', sub: 'Pipa', tentative: true });
    assert.equal(it.find(i => i.ref.id === 'd2' && i.kind === 'gig').tentative, false);
    assert.equal(it.find(i => i.kind === 'checkin').sub, 'Bia, airbnb');
    assert.equal(it.find(i => i.ref.id === 'e1').end, '11:30');
    assert.ok(!it.some(i => ['b2', 'b3', 'd3', 't2', 'e3'].includes(i.ref.id)));
  });
  test('etapas de hospedagem: só as pendentes que vencem de hoje em diante', () => {
    const et = store.items({ from: '2026-10-01', to: '2026-10-31' }).filter(i => i.kind === 'etapa').map(i => [i.etapa, i.date]);
    assert.deepEqual(et, [['hospedes', '2026-10-19'], ['portaria', '2026-10-20'], ['faxina', '2026-10-21']]);
  });
  test('filtro de calendários tira gigs, aluguéis e eventos', () => {
    const it = store.items({ from: '2026-10-19', to: '2026-10-24', cals: ['pessoal'] });
    assert.deepEqual([...new Set(it.map(i => i.kind))].sort(), ['acao', 'etapa', 'evento', 'tarefa']);
  });
  test('sem intervalo traz tudo que tem data', () => {
    assert.ok(store.items().length >= store.items({ from: '2026-10-19', to: '2026-10-24' }).length);
  });
});

describe('ocupação', () => {
  before(() => semear({ properties: CASAS, bookings: [reserva({ id: 'b1', checkin: '2026-10-20', checkout: '2026-10-22' }), reserva({ id: 'b2', status: 'cancelada', checkin: '2026-10-25', checkout: '2026-10-27' })] }));
  test('noite do check-in ocupa, dia do check-out não; cancelada não ocupa', () => {
    assert.equal(store.ocupacao('QS39', '2026-10-19'), undefined);
    assert.equal(store.ocupacao('QS39', '2026-10-20').id, 'b1');
    assert.equal(store.ocupacao('QS39', '2026-10-21').id, 'b1');
    assert.equal(store.ocupacao('QS39', '2026-10-22'), undefined);
    assert.equal(store.ocupacao('QS40', '2026-10-20'), undefined);
    assert.equal(store.ocupacao('QS39', '2026-10-25'), undefined);
  });
});
