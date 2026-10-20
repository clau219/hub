// Tela Aluguéis: Gantt das casas, próximas reservas com a sequência da hospedagem, receita/ocupação e "Consultar Airbnb".
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, clicar, preencher, esperar } from '../helpers/dom.js';
import { abrirHub, CASAS } from '../helpers/tela.js';
import { banco } from '../helpers/fake-supabase.js';

let A, el;
const nb = s => s.replace(/ /g, ' ');
before(async () => {
  await abrirHub({ supabase: true, tabelas: {
    properties: CASAS,
    bookings: [
      { id: 'b1', property_id: 'QS39', origem: 'airbnb', status: 'confirmada', hospede: 'Ana', checkin: '2026-10-20', checkout: '2026-10-23', valor: null, etapas: { hospedes: '2026-10-17' } },
      { id: 'b2', property_id: 'QS40', origem: 'direto', status: 'confirmada', hospede: 'Bia', checkin: '2026-10-25', checkout: '2026-10-30', valor: 2500, etapas: {} },
      { id: 'b3', property_id: 'QS50', origem: 'airbnb', status: 'bloqueio', checkin: '2026-11-01', checkout: '2026-11-04' },
      { id: 'b4', property_id: 'QS50', origem: 'airbnb', status: 'cancelada', hospede: 'Cancelado', checkin: '2026-10-21', checkout: '2026-10-22' },
      { id: 'b5', property_id: 'QS39', origem: 'airbnb', status: 'confirmada', hospede: 'Velho', checkin: '2026-09-01', checkout: '2026-09-05' },
    ],
  } });
  A = await hub('v-alugueis.js');
  el = $('#view');
  A.render(el);
});
beforeEach(() => { $('#modal').open && $('#modal').close(); });

describe('Gantt e tabela', () => {
  test('barras por casa: Airbnb, direta e bloqueio; cancelada não aparece', () => {
    const barras = $$('.bar').map(b => [b.dataset.bk, b.className.replace('bar ', ''), b.style.getPropertyValue('--s'), b.style.getPropertyValue('--e')]);
    assert.deepEqual(barras, [['b1', 'air', '1.5', '4.5'], ['b2', 'dir', '6.5', '11.5'], ['b3', 'blk', '13.5', '16.5']]);
    assert.equal(texto('.bar[data-bk=b3]'), 'Bloqueado');
  });
  test('próximas reservas com noites, origem e sequência', () => {
    const linhas = $$('tbody tr[data-bk]').map(r => [...r.cells].map(c => nb(texto(c))));
    assert.deepEqual(linhas, [
      ['Casa Frida', 'Ana', 'amanhã', '23 out', '3', 'airbnb', '1/3 Enviar lista para a portaria (atrasada)', ''],
      ['Casa Azul', 'Bia', 'dom', '30 out', '5', 'direto', '0/6 Enviar orçamento (atrasada)', 'R$ 2.500'],
      ['Casa Terracota', 'Bloqueio', '1 nov', '4 nov', '3', 'airbnb', '', ''],
    ]);
  });
  test('receita do mês avisa que o Airbnb não informa valor; ocupação de 30 dias', () => {
    const dl = $$('.pipe-sum div').map(d => nb(texto(d)));
    assert.equal(dl[0], 'Receita com check-in no mêssó 1 de 2 reservas têm valorR$ 2.500');
    assert.equal(dl[1], 'Casa Frida, próximos 30 dias10%3 noites');
    assert.equal(dl[2], 'Casa Azul, próximos 30 dias17%5 noites');
    assert.equal(dl[3], 'Casa Terracota, próximos 30 dias0%0 noites');
  });
  test('navegar semanas move a janela; "Hoje" volta', async () => {
    await clicar('[data-o="7"]');
    assert.equal(texto($$('.g-head span')[1]), 's26');
    await clicar('[data-o="0"]');
    assert.equal(texto($$('.g-head span')[1]), 's19');
  });
  test('clicar na barra ou na linha abre a reserva', async () => {
    await clicar('.bar[data-bk=b2]');
    assert.equal($('#modal [name=hospede]').value, 'Bia');
    $('#modal').close();
    await clicar('tr[data-bk=b1]');
    assert.equal($('#modal [name=hospede]').value, 'Ana');
  });
});

describe('Consultar Airbnb', () => {
  const RESPOSTA = {
    checkin: '2026-11-10', checkout: '2026-11-13', noites: 3, adultos: 4,
    casas: [
      { id: 'QS39', nome: 'Casa Frida', status: 'livre', total: 1350, diaria: 450, link: 'https://www.airbnb.com.br/rooms/45895549' },
      { id: 'QS40', nome: 'Casa Azul', status: 'ocupada', alternativa: { checkin: '2026-11-14', checkout: '2026-11-17', total: 1500 }, link: 'https://x' },
      { id: 'QS50', nome: 'Casa Terracota', status: 'min_noites', min_noites: 4, link: 'https://y' },
    ],
    mensagem: 'Oi! Para 10 a 13/11 temos a Casa Frida por R$ 1.350.',
  };
  test('padrão: daqui a 7 dias, 3 noites, 2 hóspedes', async () => {
    await clicar('#abQuote');
    assert.equal(texto('#modalTitle'), 'Consultar Airbnb');
    assert.equal($('#modal [name=checkin]').value, '2026-10-26');
    assert.equal($('#modal [name=checkout]').value, '2026-10-29');
    assert.equal($('#modal [name=adultos]').value, '2');
  });
  test('trocar a entrada para depois da saída empurra a saída 3 dias', () => {
    A.consultaAirbnb();
    preencher($('#modal'), { checkin: '2026-11-20' });
    assert.equal($('#modal [name=checkout]').value, '2026-11-23');
  });
  test('saída antes da entrada não consulta', async () => {
    A.consultaAirbnb({ checkin: '2026-11-10', checkout: '2026-11-09' });
    await clicar('#abGo');
    assert.match(texto('#abRes'), /saída precisa ser depois da entrada/);
    assert.equal(banco().invocacoes.length, 0);
  });
  test('mostra as 3 casas e a mensagem pronta; copiar', async () => {
    banco().funcoes['airbnb-quote'] = () => RESPOSTA;
    A.consultaAirbnb({ checkin: '2026-11-10', checkout: '2026-11-13', adultos: 4 });
    await clicar('#abGo', 10);
    assert.deepEqual(banco().invocacoes.at(-1), { nome: 'airbnb-quote', body: { checkin: '2026-11-10', checkout: '2026-11-13', adultos: 4 } });
    assert.equal(texto('.ab-cab'), '10 nov a 13 nov · 3 noites · 4 hóspedes · preços do Airbnb');
    const casas = $$('.ab-list li').map(l => nb(texto(l)));
    assert.deepEqual(casas, [
      'Casa Fridaver no Airbnb DisponívelR$ 1.350R$ 450 por noite',
      'Casa Azulver no Airbnb Ocupadalivre de 14 nov a 17 nov por R$ 1.500',
      'Casa Terracotaver no Airbnb Mínimo de noitesmínimo 4 noites',
    ]);
    assert.equal($('#abMsg').value, RESPOSTA.mensagem);
    await clicar('#abCopy');
    assert.equal(await navigator.clipboard.readText(), RESPOSTA.mensagem);
    assert.equal(texto('#toast'), 'Mensagem copiada');
    assert.equal($('#abGo').disabled, false);
  });
  test('erro da função aparece na tela', async () => {
    banco().funcoes['airbnb-quote'] = () => ({ error: 'Airbnb fora do ar' });
    A.consultaAirbnb({ checkin: '2026-11-10', checkout: '2026-11-13' });
    await clicar('#abGo', 10);
    assert.equal(texto('#abRes'), 'Não foi possível consultar: Airbnb fora do ar');
  });
  test('falha de rede ao chamar a função também aparece', async () => {
    banco().funcoes['airbnb-quote'] = () => { throw new Error('Failed to send a request to the Edge Function'); };
    A.consultaAirbnb({ checkin: '2026-11-10', checkout: '2026-11-13' });
    await clicar('#abGo', 10);
    assert.match(texto('#abRes'), /Failed to send a request/);
  });
  test('Enter num campo também consulta', async () => {
    banco().funcoes['airbnb-quote'] = () => RESPOSTA;
    const n = banco().invocacoes.length;
    A.consultaAirbnb({ checkin: '2026-11-10', checkout: '2026-11-13' });
    $('#modal [name=adultos]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await esperar(10);
    assert.equal(banco().invocacoes.length, n + 1);
  });
});
