// Telas Tarefas e Contatos.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, clicar, enviarModal, preencher } from '../helpers/dom.js';
import { abrirHub, trocarDados } from '../helpers/tela.js';

let T, C, S, el;
before(async () => {
  ({ S } = await abrirHub());
  T = await hub('v-tarefas.js');
  C = await hub('v-contatos.js');
  el = $('#view');
});
const fechar = () => $('#modal').open && $('#modal').close();

describe('Tarefas', () => {
  const DADOS = () => ({ tasks: [
    { id: 'a', titulo: 'Atrasada', area: 'casa', prazo: '2026-10-10', prioridade: 2 },
    { id: 'b', titulo: 'Hoje alta', area: 'dj', prazo: '2026-10-19', prioridade: 1 },
    { id: 'c', titulo: 'Semana', area: 'dj', prazo: '2026-10-22' },
    { id: 'd', titulo: 'Adiante', area: 'consultoria', prazo: '2026-12-01' },
    { id: 'e', titulo: 'Sem data', area: 'inbox' },
    { id: 'f', titulo: 'Feita', area: 'dj', feito: true, feito_em: '2026-10-18T10:00:00Z' },
  ] });
  beforeEach(async () => { fechar(); await trocarDados(DADOS()); T.render(el); });
  test('grupos por prazo; atrasadas em destaque; prioridade alta marcada', () => {
    assert.deepEqual($$('#view section.block h2').map(h => h.firstChild.textContent.trim()), ['Atrasadas', 'Hoje', 'Próximos 7 dias', 'Mais adiante', 'Sem data']);
    assert.ok($('#view section.block').classList.contains('warn'));
    assert.match(texto($$('#view .row').find(r => /Hoje alta/.test(r.textContent))), /alta/);
    assert.equal($$('#view .row').some(r => /Feita/.test(r.textContent)), false);
  });
  test('filtro por área', async () => {
    await clicar('[data-a=dj]');
    assert.deepEqual($$('#view .row-title').map(texto), ['Hoje alta alta', 'Semana']);
    await clicar('#tNew');
    assert.equal($('#modal [name=area]').value, 'dj');
    fechar();
    await clicar('[data-a=todas]');
  });
  test('mostrar concluídas', async () => {
    await clicar('#tDone');
    assert.ok($$('#view .row.is-done').some(r => /Feita/.test(r.textContent)));
    await clicar('#tDone');
  });
  test('concluir pelo tick e editar pelo título', async () => {
    await clicar('[data-t=a]');
    assert.equal(S.tasks.find(t => t.id === 'a').feito, true);
    T.render(el);
    await clicar('[data-e=c]');
    assert.equal(texto('#modalTitle'), 'Tarefa');
    assert.equal($('#modal [name=titulo]').value, 'Semana');
  });
  test('sem tarefas abertas', async () => {
    await trocarDados({});
    T.render(el);
    assert.match(texto('#view'), /Nenhuma tarefa aberta/);
  });
});

describe('Contatos', () => {
  const DADOS = () => ({
    contacts: [
      { id: 'c1', nome: 'Ana Souza', tipo: 'contratante', telefone: '84 99999-0000', email: 'ana@x.com', ultima_interacao: '2026-10-01' },
      { id: 'c2', nome: 'Bruno', tipo: 'hospede', ultima_interacao: '2026-10-15' },
    ],
    deals: [
      { id: 'd1', titulo: 'Casamento', contato_id: 'c1', etapa: 'pago', valor: 3000, data_evento: '2026-05-01', negocio: 'dj' },
      { id: 'd2', titulo: 'Aniversário', contato_id: 'c1', etapa: 'lead', valor: 1000, negocio: 'dj', proxima_acao: 'x', data_proxima_acao: '2026-10-20' },
    ],
  });
  beforeEach(async () => { fechar(); await trocarDados(DADOS()); C.render(el); });
  test('tabela ordenada pelo último contato, com oportunidades e total pago', () => {
    const linhas = $$('tr[data-c]').map(r => [...r.cells].map(td => texto(td).replace(/ /g, ' ')));
    assert.deepEqual(linhas, [
      ['Bruno', 'hospede', '', '15 out 26', '0', 'R$ 0'],
      ['Ana Souza', 'contratante', '84 99999-0000', '1 out 26', '2', 'R$ 3.000'],
    ]);
    assert.match(texto('#view h1'), /Contatos 2/);
  });
  test('busca por nome, telefone ou e-mail (mantém o foco)', () => {
    const inp = $('#cq');
    inp.value = 'ana@'; inp.dispatchEvent(new Event('input'));
    assert.deepEqual($$('tr[data-c]').map(r => r.dataset.c), ['c1']);
    assert.equal(document.activeElement, $('#cq'));
    $('#cq').value = '9999'; $('#cq').dispatchEvent(new Event('input'));
    assert.deepEqual($$('tr[data-c]').map(r => r.dataset.c), ['c1']);
    $('#cq').value = ''; $('#cq').dispatchEvent(new Event('input'));
  });
  test('novo contato', async () => {
    await clicar('#cNew');
    preencher($('#modal'), { nome: 'Carla', tipo: 'fornecedor', telefone: '84 3333-4444' });
    await enviarModal();
    assert.equal(S.contacts.find(c => c.nome === 'Carla').tipo, 'fornecedor');
  });
  test('ficha: oportunidades do contato, WhatsApp, "Falei hoje" e nova oportunidade', async () => {
    await clicar('tr[data-c=c1]');
    assert.equal(texto('#modalTitle'), 'Ana Souza');
    assert.deepEqual($$('#modal [data-d]').map(b => texto(b).replace(/ /g, ' ')), ['1 mai 26: Casamento (Pago, R$ 3.000)', 'Aniversário (Contato, R$ 1.000)']);
    assert.equal($('#modalFoot a.btn').href, 'https://wa.me/5584999990000');
    await clicar('#cTouch');
    assert.equal(S.contacts.find(c => c.id === 'c1').ultima_interacao, '2026-10-19');
    await clicar('tr[data-c=c1]');
    await clicar('#cDeal');
    assert.equal(texto('#modalTitle'), 'Nova oportunidade');
    assert.equal($('#modal [name=contato]').value, 'Ana Souza');
  });
  test('Enter na linha abre a ficha', () => {
    $('tr[data-c=c2]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    assert.equal(texto('#modalTitle'), 'Bruno');
  });
});
