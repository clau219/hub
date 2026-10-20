// Tela Agenda: mês e semana, calendários liga/desliga (guardado no aparelho), navegação e novo evento.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, clicar } from '../helpers/dom.js';
import { abrirHub } from '../helpers/tela.js';

let A, el;
before(async () => {
  await abrirHub({ tabelas: {
    contacts: [{ id: 'c1', nome: 'Ana' }],
    deals: [
      { id: 'g1', titulo: 'Gig', negocio: 'dj', etapa: 'fechado', contato_id: 'c1', data_evento: '2026-10-24', hora_inicio: '22:00:00', proxima_acao: 'Confirmar', data_proxima_acao: '2026-10-22' },
      { id: 'g2', titulo: 'Provisória', negocio: 'dj', etapa: 'lead', data_evento: '2026-11-07', proxima_acao: 'x', data_proxima_acao: '2026-11-01' },
    ],
    tasks: [{ id: 't1', titulo: 'Tarefa da semana', prazo: '2026-10-21', area: 'casa' }],
    bookings: [{ id: 'b1', property_id: 'QS40', origem: 'airbnb', status: 'confirmada', hospede: 'Bia', checkin: '2026-10-24', checkout: '2026-10-26', etapas: { hospedes: 1, portaria: 1, faxina: 1 } }],
    events: [{ id: 'e1', calendario: 'pessoal', titulo: 'Dentista', inicio: '2026-10-19T13:00:00Z' }],
  } });
  A = await hub('v-agenda.js');
  el = $('#view');
});
beforeEach(() => { $('#modal').open && $('#modal').close(); });

describe('Agenda: mês (padrão no computador)', () => {
  before(() => A.render(el));
  test('outubro de 2026, grade de 6 semanas começando na segunda', () => {
    assert.equal(texto('#view h1'), 'Outubro 2026');
    const dias = $$('.md');
    assert.equal(dias.length, 42);
    assert.equal(dias[0].dataset.day, '2026-09-28');
    assert.ok(dias[0].classList.contains('out'));
    assert.ok($('.md[data-day="2026-10-19"]').classList.contains('today'));
  });
  test('mês mostra gigs, eventos e check-ins/outs, mas não ações nem tarefas', () => {
    assert.deepEqual($$('.md[data-day="2026-10-24"] .pill').map(texto), ['22:00 Ana', '↘ Casa Azul']);
    assert.deepEqual($$('.md[data-day="2026-10-26"] .pill').map(texto), ['↗ Casa Azul']);
    assert.deepEqual($$('.md[data-day="2026-10-22"] .pill'), []);
    assert.deepEqual($$('.md[data-day="2026-10-19"] .pill').map(texto), ['10:00 Dentista']);
  });
  test('gig não fechada aparece tracejada', async () => {
    await clicar('[data-nav="1"]');
    assert.equal(texto('#view h1'), 'Novembro 2026');
    assert.ok($('.md[data-day="2026-11-07"] .pill').classList.contains('tentative'));
    await clicar('[data-nav="0"]');
    assert.equal(texto('#view h1'), 'Outubro 2026');
  });
  test('clicar no dia mostra o painel do dia e abre o item', async () => {
    await clicar('.md[data-day="2026-10-24"]');
    assert.match(texto('.day-panel h2'), /sábado, 24 de outubro/);
    assert.equal($$('.day-panel li').length, 2);
    await clicar('.day-panel [data-open]');
    assert.equal(texto('#modalTitle'), 'Oportunidade');
    $('#modal').close();
    await clicar('#evDay');
    assert.equal($('#modal [name=data]').value, '2026-10-24');
  });
  test('desligar o calendário DJ some com as gigs e fica guardado', async () => {
    const cb = $('[data-cal=dj]');
    cb.checked = false; cb.dispatchEvent(new Event('change'));
    assert.deepEqual($$('.md[data-day="2026-10-24"] .pill').map(texto), ['↘ Casa Azul']);
    assert.deepEqual(JSON.parse(localStorage.getItem('hub:cals')), ['alugueis', 'pessoal']);
    const cb2 = $('[data-cal=dj]'); cb2.checked = true; cb2.dispatchEvent(new Event('change'));
  });
});

describe('Agenda: semana', () => {
  before(async () => { A.render(el); await clicar('[data-modo=semana]'); await clicar('[data-sem="0"]'); });
  test('troca para semana e guarda a escolha', () => {
    assert.equal(localStorage.getItem('hub:agenda-modo'), 'semana');
    assert.equal(texto('#view h1'), '19 – 25 outubro');
    assert.equal($$('.wday').length, 7);
  });
  test('semana inclui ações e tarefas; rótulos Hoje/Amanhã', () => {
    assert.match(texto($$('.wday')[0].querySelector('h2')), /^Hoje/);
    assert.match(texto($$('.wday')[1].querySelector('h2')), /^Amanhã/);
    assert.match(texto($$('.wday')[2]), /Tarefa da semana/);
    assert.match(texto($$('.wday')[3]), /Confirmar/);
  });
  test('gig e movimento na casa no mesmo dia = "dia cheio"', () => {
    assert.ok($$('.wday')[5].querySelector('.load'));
    assert.equal($$('.wday')[4].querySelector('.load'), null);
  });
  test('próxima semana atravessa o mês no título', async () => {
    await clicar('[data-sem="7"]');
    assert.equal(texto('#view h1'), '26 out – 1 novembro');
    await clicar('[data-sem="0"]');
    assert.equal(texto('#view h1'), '19 – 25 outubro');
  });
  test('"+ evento" do dia e "Novo evento"', async () => {
    await clicar('[data-add="2026-10-23"]');
    assert.equal($('#modal [name=data]').value, '2026-10-23');
    $('#modal').close();
    await clicar('#evNew');
    assert.equal(texto('#modalTitle'), 'Novo evento');
  });
});
