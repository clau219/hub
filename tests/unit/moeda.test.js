// moeda.js: botão R$/US$ (guardado no navegador) e conversão pela cotação do dia.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/hub.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let M;
before(async () => {
  localStorage.setItem('hub:moeda', 'USD'); // escolha salva antes de abrir o Hub
  M = await hub('moeda.js');
});
beforeEach(() => limparRede());

describe('moeda de exibição', () => {
  test('lê a escolha salva, mas sem cotação continua em reais', () => {
    assert.equal(M.moeda.cod, 'USD');
    assert.equal(M.emDolar(), false);
    assert.equal(M.cod(), 'BRL');
    assert.equal(M.conv(10), 10);
    assert.equal(M.simbolo(), 'R$');
    assert.equal(M.notaCotacao(), '');
  });
  test('garantirTaxa busca a cotação uma vez só (chamadas juntas compartilham)', async () => {
    simular('https://economia.awesomeapi.com.br/json/last/USD-BRL', { USDBRL: { bid: '5.00' } });
    const [a, b] = await Promise.all([M.garantirTaxa(), M.garantirTaxa()]);
    assert.equal(a, 5);
    assert.equal(b, 5);
    assert.equal(chamadasPara(/awesomeapi/).length, 1);
    assert.equal(await M.garantirTaxa(), 5, 'já tem taxa: não busca de novo');
    assert.equal(chamadasPara(/awesomeapi/).length, 1);
  });
  test('com cotação: converte, troca o código e o símbolo', () => {
    assert.equal(M.emDolar(), true);
    assert.equal(M.conv(50), 10);
    assert.equal(M.conv(null), null);
    assert.ok(Number.isNaN(M.conv(NaN)));
    assert.equal(M.cod(), 'USD');
    assert.equal(M.simbolo(), 'US$');
    assert.match(M.notaCotacao().replace(/ /g, ' '), /US\$ 1 = R\$ 5,00/);
  });
  test('trocar grava no navegador; valor inválido vira BRL', () => {
    M.trocar('BRL');
    assert.equal(localStorage.getItem('hub:moeda'), 'BRL');
    M.trocar('EUR');
    assert.equal(M.moeda.cod, 'BRL');
    M.trocar('USD');
    assert.equal(localStorage.getItem('hub:moeda'), 'USD');
  });
  test('definirTaxa ignora zero e negativo', () => {
    M.definirTaxa(0); M.definirTaxa(-1); M.definirTaxa(null);
    assert.equal(M.moeda.taxa, 5);
    M.definirTaxa(5.5);
    assert.equal(M.moeda.taxa, 5.5);
  });
  test('botão marca a moeda atual', () => {
    M.trocar('BRL');
    const html = M.botao();
    assert.match(html, /data-moeda="BRL" class="on" aria-pressed="true"/);
    assert.match(html, /data-moeda="USD" class="" aria-pressed="false"/);
  });
});
