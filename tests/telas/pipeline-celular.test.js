// Tela Pipeline no celular (tela estreita): lista agrupada pela data da próxima ação, com a etapa no cartão.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto } from '../helpers/dom.js';
import { abrirHub } from '../helpers/tela.js';

before(async () => {
  await abrirHub({ largura: 375, tabelas: { deals: [
    { id: 'a', titulo: 'Atrasada', negocio: 'dj', etapa: 'lead', proxima_acao: 'x', data_proxima_acao: '2026-10-10' },
    { id: 'h', titulo: 'Hoje', negocio: 'dj', etapa: 'orcamento', proxima_acao: 'x', data_proxima_acao: '2026-10-19' },
    { id: 's', titulo: 'Semana', negocio: 'dj', etapa: 'fechado', proxima_acao: 'x', data_proxima_acao: '2026-10-26' },
    { id: 'd', titulo: 'Depois', negocio: 'dj', etapa: 'negociacao', proxima_acao: 'x', data_proxima_acao: '2026-11-30' },
    { id: 'p', titulo: 'Pago', negocio: 'dj', etapa: 'pago' },
  ] } });
  (await hub('v-pipeline.js')).render($('#view'));
});

describe('pipeline no celular', () => {
  test('sem quadro: grupos Atrasadas, Hoje, Próximos 7 dias e Depois', () => {
    assert.equal($('.board'), null);
    assert.deepEqual($$('#view section.block h2').map(h => h.firstChild.textContent.trim()), ['Atrasadas', 'Hoje', 'Próximos 7 dias', 'Depois']);
  });
  test('cada cartão mostra a etapa', () => {
    assert.equal(texto('.card[data-id=s] footer .tag'), 'Fechado');
    assert.equal($('.card[data-id=p]'), null);
  });
});
