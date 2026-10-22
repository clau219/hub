// Pagamentos da oportunidade: sinal, parcelas e saldo (deals.pagamentos), no formulário, no cartão do Pipeline e no "Escapando".
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, preencher, enviarModal, clicar } from '../helpers/dom.js';
import { abrirHub, trocarDados } from '../helpers/tela.js';

let ui, S, P, store, util;
const nb = s => s.replace(/ /g, ' ');
const gig = x => ({ id: 'd1', titulo: 'DJ — Roberta', negocio: 'dj', etapa: 'fechado', contato_id: 'c1', valor: 1500, data_evento: '2026-11-21',
  proxima_acao: 'Confirmar detalhes do evento', data_proxima_acao: '2026-11-18', ...x });
const dados = (d = {}) => ({ contacts: [{ id: 'c1', nome: 'Roberta' }], deals: [gig(d)] });
before(async () => {
  ({ S } = await abrirHub({ tabelas: dados() }));
  ui = await hub('ui.js'); P = await hub('v-pipeline.js'); store = await hub('store.js'); util = await hub('util.js');
});
beforeEach(() => $('#modal').open && $('#modal').close());
const m = () => $('#modal');

describe('contas', () => {
  test('recebido e saldo em centavos, saldo nunca negativo', () => {
    assert.equal(util.recebido({ pagamentos: [{ valor: 0.1 }, { valor: 0.2 }] }), 0.3);
    assert.equal(util.saldoDeal({ valor: '1500', pagamentos: [{ valor: 450 }] }), 1050);
    assert.equal(util.saldoDeal({ valor: 1000, pagamentos: [{ valor: 1200 }] }), 0);
    assert.equal(util.saldoDeal({ valor: 1000 }), 1000);
  });
});

describe('formulário', () => {
  test('sinal 30% preenche o valor; registrar mostra recebido e o que falta; salvar grava', async () => {
    await trocarDados(dados());
    ui.dealForm(S.deals[0]);
    assert.equal(m().querySelector('#fPgto').hidden, false);
    await clicar(m().querySelector('[data-pct="30"]'));
    assert.equal(m().querySelector('#pgValor').value, '450');
    m().querySelector('#pgData').value = '2026-10-15';
    await clicar(m().querySelector('#pgAdd'));
    assert.match(nb(texto('#pgResumo')), /Recebido R\$ 450 de R\$ 1.500 \(30%\)\s*Falta R\$ 1.050/);
    assert.equal($$('#pgLista li').length, 1);
    await enviarModal();
    assert.deepEqual(S.deals[0].pagamentos, [{ data: '2026-10-15', valor: 450, forma: 'Pix' }]);
    assert.equal(S.deals[0].etapa, 'fechado');
  });
  test('valor digitado sem clicar em Registrar entra no salvar; × remove', async () => {
    await trocarDados(dados({ pagamentos: [{ data: '2026-10-15', valor: 450, forma: 'Pix' }] }));
    ui.dealForm(S.deals[0]);
    await clicar(m().querySelector('.pg-del'));
    assert.equal($$('#pgLista li').length, 0);
    m().querySelector('#pgValor').value = '500';
    await enviarModal();
    assert.deepEqual(S.deals[0].pagamentos.map(p => p.valor), [500]);
  });
  test('marcar como Pago com saldo aberto registra o saldo hoje', async () => {
    await trocarDados(dados({ pagamentos: [{ data: '2026-10-15', valor: 450, forma: 'Dinheiro' }] }));
    ui.dealForm(S.deals[0]);
    preencher(m(), { etapa: 'pago' });
    await enviarModal();
    assert.deepEqual(S.deals[0].pagamentos.at(-1), { data: '2026-10-19', valor: 1050, forma: 'Dinheiro' });
    assert.equal(S.deals[0].etapa, 'pago');
  });
  test('Realizado e quitado vira Pago', async () => {
    await trocarDados(dados({ etapa: 'realizado', pagamentos: [{ data: '2026-10-15', valor: 1500, forma: 'Pix' }] }));
    ui.dealForm(S.deals[0]);
    await enviarModal();
    assert.equal(S.deals[0].etapa, 'pago');
    assert.equal(S.deals[0].proxima_acao, null);
  });
  test('contato e orçamento sem pagamentos não mostram o bloco', async () => {
    await trocarDados(dados({ etapa: 'orcamento' }));
    ui.dealForm(S.deals[0]);
    assert.equal(m().querySelector('#fPgto').hidden, true);
    preencher(m(), { etapa: 'fechado' });
    m().querySelector('#fEtapa').dispatchEvent(new Event('change'));
    assert.equal(m().querySelector('#fPgto').hidden, false);
  });
});

describe('cartão e Escapando', () => {
  test('cartão mostra o recebido e o que falta; sem sinal fica destacado; quitado', async () => {
    await trocarDados(dados({ pagamentos: [{ data: '2026-10-15', valor: 450, forma: 'Pix' }] }));
    P.render($('#view'));
    assert.equal(nb(texto('.card-pg')), 'Recebido R$ 450 · falta R$ 1.050');
    await trocarDados(dados());
    P.render($('#view'));
    assert.match(nb(texto('.card-pg')), /^Sem sinal · falta R\$ 1.500/);
    await trocarDados(dados({ pagamentos: [{ data: '2026-10-15', valor: 1500, forma: 'Pix' }] }));
    P.render($('#view'));
    assert.equal(texto('.card-pg'), 'Quitado');
  });
  test('evento passou mostra quanto falta; realizado com saldo há mais de 3 dias aparece', async () => {
    await trocarDados(dados({ data_evento: '2026-10-17', pagamentos: [{ data: '2026-10-01', valor: 450 }] }));
    const a = store.atencao().find(x => x.motivo === 'evento passou');
    assert.match(nb(a.sub), /falta R\$ 1.050$/);
    await trocarDados(dados({ etapa: 'realizado', data_evento: '2026-10-10', proxima_acao: 'Cobrar', data_proxima_acao: '2026-10-25', pagamentos: [{ data: '2026-10-01', valor: 450 }] }));
    const s = store.atencao().find(x => x.motivo === 'saldo em aberto');
    assert.match(nb(s.title), /saldo de R\$ 1.050 em aberto/);
  });
});
