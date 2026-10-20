// Tela Hoje: resumo em números, Escapando em grupos, linha do dia, próximos 7 dias, ocupação, caixa de entrada, pipeline e ações das linhas.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, esperar, clicar, enviarModal, preencher } from '../helpers/dom.js';
import { abrirHub, trocarDados } from '../helpers/tela.js';

let hoje, S, el;
const DADOS = () => ({
  contacts: [{ id: 'c1', nome: 'Ana', telefone: '84 99999-0000' }],
  deals: [
    { id: 'd1', titulo: 'Festa Ana', negocio: 'dj', etapa: 'orcamento', contato_id: 'c1', proxima_acao: 'Follow-up', data_proxima_acao: '2026-10-15', valor: 2000 },
    { id: 'd2', titulo: 'Casamento', negocio: 'dj', etapa: 'fechado', proxima_acao: 'Confirmar som', data_proxima_acao: '2026-10-19', data_evento: '2026-10-19', hora_inicio: '21:00:00', hora_fim: '23:30:00', valor: 5000 },
    { id: 'd3', titulo: 'Reforma', negocio: 'consultoria', etapa: 'lead', proxima_acao: 'Visitar', data_proxima_acao: '2026-10-22', valor: 800 },
  ],
  tasks: [
    { id: 't1', titulo: 'Pagar IPTU', area: 'casa', prazo: '2026-10-17' },
    { id: 't2', titulo: 'Ideia solta', area: 'inbox' },
    { id: 't3', titulo: 'Comprar cabo', area: 'dj', prazo: '2026-10-19', prioridade: 1 },
  ],
  bookings: [{ id: 'b1', property_id: 'QS40', origem: 'airbnb', status: 'confirmada', hospede: 'Bia', checkin: '2026-10-21', checkout: '2026-10-24' }],
  habits: [{ id: 'h1', nome: 'Treinar', dias: [0, 1, 2, 3, 4, 5, 6], cor: '#0e7c72', created_at: '2026-10-01T00:00:00Z' }],
  habit_logs: [{ id: 'l1', habit_id: 'h1', dia: '2026-10-18' }, { id: 'l2', habit_id: 'h1', dia: '2026-10-17' }],
});
before(async () => {
  ({ S } = await abrirHub({ tabelas: DADOS() }));
  hoje = await hub('v-hoje.js');
  el = $('#view');
});
beforeEach(async () => { await trocarDados(DADOS()); hoje.render(el); $('#modal').open && $('#modal').close(); });

describe('Hoje: conteúdo', () => {
  test('saudação pelo horário de Pipa e data por extenso', () => {
    assert.equal(texto('.hero h1'), 'Boa tarde, Claudio'); // 12h em Pipa
    assert.equal(texto('.hero-date'), 'segunda, 19 de outubro');
    for (const [utc, s] of [['2026-10-19T11:00:00Z', 'Bom dia'], ['2026-10-19T22:00:00Z', 'Boa noite'], ['2026-10-19T06:00:00Z', 'Boa noite']]) {
      globalThis.__relogio.definir(utc);
      hoje.render(el);
      assert.equal(texto('.hero h1'), s + ', Claudio', utc);
    }
    globalThis.__relogio.definir('2026-10-19T15:00:00Z');
  });
  test('resumo: escapando, para hoje e gigs em 7 dias', () => {
    const st = $$('.stat').map(b => `${texto(b.querySelector('b'))} ${texto(b.querySelector('span'))}`);
    assert.equal(st[0], '3 escapando'); // deal atrasado + tarefa atrasada + etapa de hospedagem (hóspedes, venceu 18/10)
    assert.equal(st[1], '4 para hoje'); // ação d2, gig d2, tarefa t3, portaria da Bia (19/10)
    assert.equal(st[2], '1 gig em 7 dias');
  });
  test('Escapando separa dinheiro, compromissos e tarefas', () => {
    assert.deepEqual($$('#sec-esc .esc-g').map(e => e.firstChild.textContent.trim()), ['Dinheiro em jogo', 'Compromissos com outras pessoas', 'Tarefas']);
    assert.match(texto('#sec-esc'), /Follow-up/);
    assert.match(texto('#sec-esc'), /Receber nomes e documentos dos hóspedes · Casa Azul/);
  });
  test('ação atrasada tem WhatsApp com mensagem da etapa e botões de adiar', () => {
    const li = $$('#sec-esc li').find(l => /Follow-up/.test(l.textContent));
    assert.ok(li.querySelector('a.wa').href.startsWith('https://wa.me/5584999990000?text=Oi%2C%20Ana!'));
    assert.equal(li.querySelectorAll('[data-snz]').length, 2);
    assert.equal(texto(li.querySelector('.late-lbl')), 'há 4 dias');
  });
  test('linha do dia mostra o horário da gig', () => {
    const slot = $('.ribbon .slot');
    assert.match(slot.title, /^21:00–23:30 Casamento/);
    assert.equal(texto('.ribbon .now span'), '12:00');
  });
  test('próximos 7 dias agrupados por dia', () => {
    const dias = $$('#sec-prox h3.day').map(texto);
    assert.deepEqual(dias, ['amanhã20 out', 'qua21 out', 'qui22 out', 'sáb24 out']);
  });
  test('ocupação: Casa Azul ocupada de 21 a 23 (Airbnb)', () => {
    const azul = $$('.occ-row').find(r => texto(r.querySelector('.occ-name')) === 'Azul');
    const cel = [...azul.querySelectorAll('.cell')];
    assert.deepEqual(cel.slice(0, 6).map(c => c.className.trim()), ['cell', 'cell', 'cell air st', 'cell air', 'cell air', 'cell']);
  });
  test('caixa de entrada: só tarefa sem área e sem prazo', () => {
    const cx = $$('.col-side .block').find(b => /Caixa de entrada/.test(b.textContent));
    assert.match(texto(cx), /Ideia solta/);
    assert.doesNotMatch(texto(cx), /Pagar IPTU/);
  });
  test('resumo do pipeline com contagem e valor por etapa', () => {
    assert.deepEqual($$('.pipe-sum div').map(texto).map(s => s.replace(/ /g, ' ')), ['Contatos1R$ 800', 'Orçamentos enviados1R$ 2.000', 'Fechados1R$ 5.000']);
  });
  test('hábitos com sequência de dias', () => {
    assert.match(texto('.habits h2'), /0 de 1 hoje/);
    assert.equal(texto('.hb-seq'), '2🔥');
  });
  test('sem nada: dia livre e nada atrasado', async () => {
    await trocarDados({});
    hoje.render(el);
    assert.equal($('#sec-esc'), null);
    assert.equal(texto($$('.stat')[0]), '✓nada atrasado');
    assert.match(texto('#sec-dia'), /Dia livre/);
    assert.match(texto('#sec-prox'), /Nada marcado na semana/);
  });
});

describe('Hoje: ações', () => {
  const linha = re => $$('#view li.row').find(l => re.test(l.textContent));
  test('concluir tarefa atrasada', async () => {
    await clicar(linha(/Pagar IPTU/).querySelector('[data-done]'));
    assert.equal(S.tasks.find(t => t.id === 't1').feito, true);
  });
  test('adiar ação para amanhã', async () => {
    await clicar(linha(/Follow-up/).querySelector('[data-snz$=":1"]'));
    assert.equal(S.deals.find(d => d.id === 'd1').data_proxima_acao, '2026-10-20');
  });
  test('concluir ação abre "E agora?"', async () => {
    await clicar(linha(/Follow-up/).querySelector('[data-done]'));
    assert.equal(texto('#modalTitle'), 'Ação feita. E agora?');
  });
  test('concluir etapa da hospedagem marca no banco', async () => {
    await clicar(linha(/Receber nomes/).querySelector('[data-done]'));
    assert.deepEqual(S.bookings[0].etapas, { hospedes: '2026-10-19' });
  });
  test('abrir linha abre o formulário do item', async () => {
    await clicar(linha(/Comprar cabo/).querySelector('[data-open]'));
    assert.equal(texto('#modalTitle'), 'Tarefa');
  });
  test('marcar hábito de hoje grava o registro; clicar de novo desmarca', async () => {
    await clicar(`[data-hab-tog="h1|2026-10-19"]`);
    assert.ok(S.habit_logs.some(l => l.dia === '2026-10-19'));
    hoje.render(el);
    await clicar(`[data-hab-tog="h1|2026-10-19"]`);
    assert.ok(!S.habit_logs.some(l => l.dia === '2026-10-19'));
  });
  test('conflito gig × casa some ao marcar ciente', async () => {
    await trocarDados({ deals: [{ id: 'g', titulo: 'Gig', negocio: 'dj', etapa: 'fechado', data_evento: '2026-10-21', proxima_acao: 'x', data_proxima_acao: '2026-10-21' }],
      bookings: [{ id: 'b', property_id: 'QS39', status: 'confirmada', origem: 'airbnb', checkin: '2026-10-21', checkout: '2026-10-25', etapas: { hospedes: 1, portaria: 1, faxina: 1 } }] });
    hoje.render(el);
    const l = linha(/Gig Gig × Check-in Casa Frida/);
    assert.ok(l.classList.contains('conf'));
    await clicar(l.querySelector('[data-done]'));
    hoje.render(el);
    assert.equal(linha(/× Check-in/), undefined);
    assert.equal(texto('#toast'), 'Ok, conflito marcado como resolvido');
  });
  test('"Ver mais" abre a lista completa do grupo', async () => {
    await trocarDados({ tasks: Array.from({ length: 7 }, (_, i) => ({ id: 't' + i, titulo: 'Velha ' + i, area: 'casa', prazo: '2026-10-1' + i % 9 })).map(t => ({ ...t, prazo: '2026-10-10' })) });
    hoje.render(el);
    assert.equal($$('#sec-esc li').length, 5);
    await clicar('[data-mais]');
    assert.equal($$('#sec-esc li').length, 7);
    assert.equal(texto('[data-mais]'), 'Mostrar menos');
  });
  test('clique no número do resumo rola até a seção (sem quebrar)', async () => {
    let rolou = null;
    $('#sec-dia').scrollIntoView = () => (rolou = 'sec-dia');
    await clicar($$('.stat')[1]);
    assert.equal(rolou, 'sec-dia');
  });
  test('deslizar a linha para a direita conclui', async () => {
    const l = linha(/Pagar IPTU/);
    const toque = (tipo, x) => { const e = new Event(tipo, { bubbles: true }); e.touches = [{ clientX: x, clientY: 100 }]; l.querySelector('.row-main').dispatchEvent(e); };
    toque('touchstart', 10); toque('touchmove', 60); toque('touchmove', 110);
    l.dispatchEvent(new Event('touchend', { bubbles: true }));
    await esperar(10);
    assert.equal(S.tasks.find(t => t.id === 't1').feito, true);
  });
});
