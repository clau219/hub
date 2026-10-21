// Tela Pipeline (computador): faixas por negócio com as etapas de cada um, filtro por negócio, mover cartão (teclado e arrastar), fechados.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, clicar, enviarModal, preencher } from '../helpers/dom.js';
import { abrirHub, trocarDados } from '../helpers/tela.js';

let P, S, el;
const nb = s => s.replace(/ /g, ' ');
const DADOS = () => ({
  contacts: [{ id: 'c1', nome: 'Ana', telefone: '84999990000' }],
  deals: [
    { id: 'd1', titulo: 'Festa', negocio: 'dj', etapa: 'lead', contato_id: 'c1', proxima_acao: 'Enviar orçamento', data_proxima_acao: '2026-10-18', valor: 1000, data_evento: '2026-12-12', local: 'Pipa, RN' },
    { id: 'd2', titulo: 'Show', negocio: 'dj', etapa: 'lead', proxima_acao: 'Ligar', data_proxima_acao: '2026-10-19', valor: 500 },
    { id: 'd3', titulo: 'Reforma', negocio: 'consultoria', etapa: 'negociacao', proxima_acao: 'Visitar', data_proxima_acao: '2026-10-25', valor: 3000, data_evento: '2026-11-01' },
    { id: 'd4', titulo: 'Velho', negocio: 'dj', etapa: 'pago', valor: 2000, data_evento: '2026-01-10' },
    { id: 'd5', titulo: 'Perdido', negocio: 'dj', etapa: 'perdido', data_evento: '2026-02-10' },
  ],
});
before(async () => {
  ({ S } = await abrirHub({ tabelas: DADOS() }));
  P = await hub('v-pipeline.js');
  el = $('#view');
});
beforeEach(async () => { await trocarDados(DADOS()); P.render(el); $('#modal').open && $('#modal').close(); });
const col = (id, n = 'dj') => $(`.col[data-etapa="${id}"][data-negocio="${n}"]`);
const nomesCols = sel => $$(sel).map(c => texto(c.querySelector('h2')).replace(/\s*\d.*$/, ''));

describe('quadro', () => {
  test('"Todos": uma faixa por negócio; faixa sem nada aberto vira uma linha', () => {
    assert.deepEqual($$('.lane').map(l => l.dataset.negocio || 'vazia'), ['dj', 'consultoria', 'vazia', 'vazia']);
    assert.match(texto($$('.lane.vazia')[0]), /Aluguéis.*nenhuma oportunidade aberta/);
  });
  test('cada negócio com as suas etapas', () => {
    assert.deepEqual(nomesCols('.col[data-negocio="dj"]'), ['Contato', 'Orçamento enviado', 'Negociando', 'Fechado', 'Realizado']);
    assert.deepEqual(nomesCols('.col[data-negocio="consultoria"]'), ['Contato', 'Proposta enviada', 'Em andamento', 'Entregue']);
    assert.equal(nb(texto(col('lead').querySelector('h2'))), 'Contato 2R$ 1.500');
    assert.match(texto(col('orcamento')), /Vazio/);
  });
  test('"Negociando" antigo de engenharia aparece em Proposta enviada', () => {
    assert.ok(col('orcamento', 'consultoria').querySelector('.card[data-id=d3]'));
  });
  test('filtro de Aluguéis mostra Contato, Orçamento enviado e Reservado', async () => {
    await clicar('[data-f=aluguel]');
    assert.deepEqual(nomesCols('.col'), ['Contato', 'Orçamento enviado', 'Reservado']);
    await clicar('[data-f=todos]');
  });
  test('cartão: cliente, valor, evento, próxima ação atrasada e WhatsApp', () => {
    const c = $('.card[data-id=d1]');
    assert.equal(nb(texto(c.querySelector('header'))), 'AnaR$ 1.000');
    assert.equal(texto(c.querySelector('.card-ev')), '12 dez, Pipa');
    assert.ok(c.querySelector('.card-next').classList.contains('late'));
    assert.ok(c.querySelector('a.wa'));
    assert.ok($('.card[data-id=d2] .card-next').classList.contains('today'));
  });
  test('cartões ordenados pela data da próxima ação', () => {
    assert.deepEqual([...col('lead').querySelectorAll('.card')].map(c => c.dataset.id), ['d1', 'd2']);
  });
  test('filtro por negócio esconde os outros e pré-preenche a nova oportunidade', async () => {
    await clicar('[data-f=consultoria]');
    assert.deepEqual($$('.card').map(c => c.dataset.id), ['d3']);
    await clicar('#pNew');
    assert.equal($('#modal [name=negocio]').value, 'consultoria');
    $('#modal').close();
    await clicar('[data-f=todos]');
    assert.equal($$('.card').length, 3);
  });
  test('"+ nova" da faixa abre a oportunidade já no negócio, com as etapas dele', async () => {
    await clicar('.lane.vazia [data-novo=aluguel]');
    assert.equal($('#modal [name=negocio]').value, 'aluguel');
    assert.deepEqual([...$('#modal [name=etapa]').options].map(o => o.textContent), ['Contato', 'Orçamento enviado', 'Reservado', 'Pago', 'Perdido']);
    assert.equal($('#modal [name=proxima_acao]').value, 'Enviar valor e disponibilidade');
  });
  test('trocar o negócio no formulário troca a lista de etapas', async () => {
    await clicar('#pNew');
    const neg = $('#modal [name=negocio]');
    neg.value = 'consultoria'; neg.dispatchEvent(new Event('change'));
    assert.deepEqual([...$('#modal [name=etapa]').options].map(o => o.textContent), ['Contato', 'Proposta enviada', 'Em andamento', 'Entregue', 'Pago', 'Perdido']);
    assert.equal($('#modal [name=proxima_acao]').value, 'Enviar proposta');
  });
  test('pagos e perdidos numa tabela escondida', async () => {
    assert.equal(texto('#toggleClosed'), 'Mostrar pagos e perdidos (2)');
    await clicar('#toggleClosed');
    assert.deepEqual($$('tr[data-id]').map(r => r.dataset.id), ['d5', 'd4']);
    await clicar($('tr[data-id=d4]'));
    assert.equal(texto('#modalTitle'), 'Oportunidade');
    $('#modal').close();
    await clicar('#toggleClosed');
  });
  test('clicar no cartão abre a oportunidade (etapa antiga continua na lista)', async () => {
    await clicar('.card[data-id=d3]');
    assert.equal($('#modal [name=etapa]').value, 'negociacao');
    assert.deepEqual([...$('#modal [name=etapa]').options].map(o => o.textContent), ['Negociando', 'Contato', 'Proposta enviada', 'Em andamento', 'Entregue', 'Pago', 'Perdido']);
  });
});

describe('mover cartão', () => {
  test('seta → pede a próxima ação da nova etapa e move', async () => {
    $('.card[data-id=d2]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(texto('#modalTitle'), 'Mover para Orçamento enviado');
    assert.equal($('#modal [name=proxima_acao]').value, 'Follow-up do orçamento');
    assert.equal($('#modal [name=data_proxima_acao]').value, '2026-10-22');
    await enviarModal();
    assert.equal(S.deals.find(d => d.id === 'd2').etapa, 'orcamento');
    assert.equal(texto('#toast'), 'Movido para Orçamento enviado');
  });
  test('seta → na engenharia vai de Proposta enviada para Em andamento', () => {
    $('.card[data-id=d3]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(texto('#modalTitle'), 'Mover para Em andamento');
    assert.equal($('#modal [name=proxima_acao]').value, 'Atualizar o cliente');
  });
  test('seta ← na primeira etapa não faz nada; Enter abre', () => {
    $('.card[data-id=d1]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal($('#modal').open, false);
    $('.card[data-id=d1]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(texto('#modalTitle'), 'Oportunidade');
  });
  test('soltar em "Em andamento" sugere a data 3 dias antes da data marcada', async () => {
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    ev.dataTransfer = { getData: () => 'd3' };
    col('fechado', 'consultoria').dispatchEvent(ev);
    assert.equal(texto('#modalTitle'), 'Mover para Em andamento');
    assert.equal($('#modal [name=data_proxima_acao]').value, '2026-10-29');
    preencher($('#modal'), { proxima_acao: 'Mandar contrato' });
    await enviarModal();
    const d = S.deals.find(d => d.id === 'd3');
    assert.deepEqual([d.etapa, d.proxima_acao], ['fechado', 'Mandar contrato']);
  });
  test('soltar na faixa de outro negócio não abre nada', () => {
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    ev.dataTransfer = { getData: () => 'd3' };
    col('fechado').dispatchEvent(ev);
    assert.equal($('#modal').open, false);
  });
  test('soltar na mesma coluna não abre nada', () => {
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    ev.dataTransfer = { getData: () => 'd1' };
    col('lead').dispatchEvent(ev);
    assert.equal($('#modal').open, false);
  });
});
