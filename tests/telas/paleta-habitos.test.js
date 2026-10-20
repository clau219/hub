// Paleta de busca (Ctrl+K) e cadastro de hábitos (com regra automática do Garmin).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, clicar, preencher, enviarModal, esperar } from '../helpers/dom.js';
import { abrirHub, trocarDados } from '../helpers/tela.js';

let pal, hab, S;
const DADOS = () => ({
  contacts: [{ id: 'c1', nome: 'José Álvares', telefone: '84 99999-0000', tipo: 'contratante', ultima_interacao: '2026-10-01' }, { id: 'c2', nome: 'Maria José', email: 'mj@x.com' }],
  deals: [{ id: 'd1', titulo: 'Casamento Praia', negocio: 'dj', etapa: 'orcamento', contato_id: 'c1', data_evento: '2026-12-12', local: 'Pipa' }],
  bookings: [{ id: 'b1', property_id: 'QS39', hospede: 'Joana', origem: 'airbnb', status: 'confirmada', checkin: '2026-11-01', checkout: '2026-11-03' },
    { id: 'b2', property_id: 'QS40', hospede: 'Joaquim', status: 'cancelada', checkin: '2026-11-01', checkout: '2026-11-03' }],
  tasks: [{ id: 't1', titulo: 'Jogar fora caixas', prazo: '2026-10-20' }, { id: 't2', titulo: 'Joia feita', feito: true }],
  events: [{ id: 'e1', titulo: 'Jornada', inicio: '2026-10-30T10:00:00Z', calendario: 'pessoal' }],
  habits: [{ id: 'h1', nome: 'Caminhar', dias: [1, 2, 3, 4, 5], auto: 'passos>=8000', cor: '#0e7c72', ativo: true }],
});
before(async () => {
  ({ S } = await abrirHub({ tabelas: DADOS() }));
  pal = await hub('palette.js');
  hab = await hub('habitos.js');
  pal.iniciar();
});
beforeEach(async () => {
  for (const d of ['#modal', '#pal']) $(d).open && $(d).close();
  await trocarDados(DADOS());
});
const digitar = t => { const i = $('#palIn'); i.value = t; i.dispatchEvent(new Event('input')); };
const itens = () => $$('#palList .pal-it').map(li => texto(li.querySelector('.pal-t')));
const grupos = () => $$('#palList .pal-g').map(texto);

describe('paleta (Ctrl+K)', () => {
  test('Ctrl+K abre; sem busca mostra as 4 ações e os atalhos de tela', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    assert.equal($('#pal').open, true);
    assert.deepEqual(grupos(), ['Ações', 'Ir para']);
    assert.deepEqual(itens().slice(0, 4), ['Nova oportunidade', 'Nova tarefa', 'Nova reserva', 'Novo evento na agenda']);
  });
  test('busca sem acento e pela palavra: oportunidade, contatos, reserva, tarefa e agenda', () => {
    pal.abrir();
    digitar('jo');
    assert.deepEqual(grupos(), ['Oportunidades', 'Contatos', 'Reservas', 'Tarefas', 'Agenda', 'Ações']);
    assert.deepEqual(itens().slice(0, 7), ['José Álvares', 'José Álvares', 'Maria José', 'Casa Frida · Joana', 'Jogar fora caixas', 'Jornada', 'Nova oportunidade para “jo”']);
  });
  test('reserva cancelada e tarefa feita não aparecem', () => {
    pal.abrir();
    digitar('joaquim');
    assert.ok(!grupos().includes('Reservas'));
    digitar('joia');
    assert.ok(!grupos().includes('Tarefas'));
  });
  test('contato com telefone tem atalho de WhatsApp', () => {
    pal.abrir();
    digitar('alvares');
    assert.equal($('#palList a.wa').href, 'https://wa.me/5584999990000');
  });
  test('setas e Enter executam o item escolhido', async () => {
    pal.abrir();
    digitar('casamento');
    const k = key => $('#palIn').dispatchEvent(new KeyboardEvent('keydown', { key }));
    assert.ok($('#pal-0').classList.contains('on'));
    k('ArrowDown'); k('ArrowUp'); k('ArrowUp');
    assert.ok($('#pal-0').classList.contains('on'));
    k('Enter');
    await esperar();
    assert.equal($('#pal').open, false);
    assert.equal(texto('#modalTitle'), 'Oportunidade');
  });
  test('"Nova tarefa: texto" cria a tarefa com o texto digitado', async () => {
    pal.abrir();
    digitar('Ligar contador');
    await clicar($$('#palList .pal-it').find(li => /Nova tarefa/.test(li.textContent)));
    assert.equal($('#modal [name=titulo]').value, 'Ligar contador');
  });
  test('"Ir para" muda a tela', async () => {
    pal.abrir();
    digitar('agen');
    await clicar($$('#palList .pal-it').find(li => li.textContent.includes('Agenda') && !li.querySelector('.pal-s')));
    assert.equal(location.hash, '#/agenda');
  });
  test('nada encontrado ainda oferece criar', () => {
    pal.abrir();
    digitar('zzzz');
    assert.deepEqual(grupos(), ['Ações']);
  });
  test('Ctrl+K com um formulário aberto não abre a paleta', () => {
    $('#modal').showModal();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    assert.equal($('#pal').open, false);
  });
  test('Finanças está em "Ir para"', { todo: 'palette.js: a lista IR não tem "financas" (a tela existe no menu, mas não na busca)' }, () => {
    pal.abrir();
    digitar('finan');
    assert.ok(itens().includes('Finanças'));
  });
});

describe('hábitos', () => {
  const sequencia = () => hab.sequencia(S.habits[0]);
  test('sequência: dias de folga não quebram; hoje em aberto não quebra', async () => {
    // seg a sex; hoje é segunda 19/10. Feitos: sex 16, qui 15, qua 14. Sáb/dom são folga.
    await trocarDados({ habits: [{ id: 'h1', nome: 'X', dias: [1, 2, 3, 4, 5] }], habit_logs: ['2026-10-16', '2026-10-15', '2026-10-14'].map((dia, i) => ({ id: 'l' + i, habit_id: 'h1', dia })) });
    assert.equal(sequencia(), 3);
    await trocarDados({ habits: [{ id: 'h1', nome: 'X', dias: [1, 2, 3, 4, 5] }], habit_logs: ['2026-10-19', '2026-10-16', '2026-10-14'].map((dia, i) => ({ id: 'l' + i, habit_id: 'h1', dia })) });
    assert.equal(sequencia(), 2, 'quinta 15 sem registro quebra');
  });
  test('sequência não conta antes de o hábito existir', async () => {
    await trocarDados({ habits: [{ id: 'h1', nome: 'X', created_at: '2026-10-18T10:00:00Z' }], habit_logs: ['2026-10-18', '2026-10-17'].map((dia, i) => ({ id: 'l' + i, habit_id: 'h1', dia })) });
    assert.equal(sequencia(), 1);
  });
  test('bloco: hábito automático mostra o relógio e a meta do Garmin', () => {
    const html = hab.bloco();
    assert.match(html, /Marcado sozinho pelo Garmin: Passos no dia ≥ 8\.000/);
    assert.match(html, /hb-auto/);
    assert.match(html, /0 de 1 hoje/);
    assert.equal((html.match(/hb-cell [^"]*off/g) || []).length, 2, 'sábado e domingo são folga');
  });
  test('sem hábitos: convite para criar o primeiro', async () => {
    await trocarDados({ habits: [] });
    assert.match(hab.bloco(), /Nenhum hábito ainda/);
  });
  test('novo hábito: dias, cor e regra "minutos de corrida"', async () => {
    hab.habitForm();
    const m = $('#modal');
    await clicar(m.querySelector('[data-preset="06"]'));
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(i => m.querySelector(`[name=d${i}]`).checked), [true, false, false, false, false, false, true]);
    preencher(m, { nome: 'Correr', auto_k: 'atividade' });
    assert.equal(m.querySelector('[name=auto_v]').value, '30');
    assert.equal(m.querySelector('.hb-autotipo').hidden, false);
    preencher(m, { auto_t: 'corrida', auto_v: '20,5' });
    await enviarModal();
    const h = S.habits.find(x => x.nome === 'Correr');
    assert.deepEqual({ dias: h.dias, auto: h.auto, ativo: h.ativo, ordem: h.ordem }, { dias: [0, 6], auto: 'atividade.corrida>=20.5', ativo: true, ordem: 1 });
  });
  test('validações: pelo menos um dia e meta positiva', async () => {
    hab.habitForm();
    const m = $('#modal');
    preencher(m, { nome: 'Nada', d0: false, d1: false, d2: false, d3: false, d4: false, d5: false, d6: false });
    await enviarModal();
    assert.match(texto('#modalErr'), /pelo menos um dia/);
    preencher(m, { d1: true, auto_k: 'sono', auto_v: '0' });
    await enviarModal();
    assert.match(texto('#modalErr'), /maior que zero/);
  });
  test('editar hábito existente e arquivar em 2 cliques', async () => {
    hab.habitForm(S.habits[0]);
    const m = $('#modal');
    assert.equal(m.querySelector('[name=auto_k]').value, 'passos');
    assert.equal(m.querySelector('[name=auto_v]').value, '8000');
    await clicar('#hbArch'); await clicar('#hbArch');
    assert.equal(S.habits[0].ativo, false);
  });
  test('onClick: novo e editar abrem o formulário; outro botão não é tratado', async () => {
    const b = document.createElement('button');
    b.dataset.habNew = '';
    assert.equal(await hab.onClick(b), true);
    assert.equal(texto('#modalTitle'), 'Novo hábito');
    assert.equal(await hab.onClick(document.createElement('button')), false);
  });
});
