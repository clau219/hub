// app.js sem internet e com a sessão vencida: abre a cópia guardada (hub:snap) em modo leitura, sem permitir gravar.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { hub, montarDom, $, texto, esperar, ate } from '../helpers/dom.js';
import { novoBanco } from '../helpers/fake-supabase.js';

const TODAS = ['contacts', 'deals', 'quotes', 'tasks', 'properties', 'bookings', 'events', 'calendar_sources', 'habits', 'habit_logs', 'crypto_watch', 'crypto_tx', 'crypto_snap', 'crypto_plano'];
before(async () => {
  montarDom();
  const b = novoBanco();
  b.sessao = null;
  b.erroSessao = { name: 'AuthRetryableFetchError', message: 'Failed to fetch' };
  TODAS.forEach(t => (b.falhas[t] = 'Failed to fetch'));
  localStorage.setItem('hub:snap', JSON.stringify({ at: '2026-10-18T23:30:00Z', S: {
    tasks: [{ id: 't1', titulo: 'Tarefa guardada', area: 'inbox' }],
    properties: [{ id: 'QS39', nome: 'Casa Frida' }],
  } }));
  await hub('app.js');
  await ate(() => !$('#app').hidden && $('.hero'), { msg: 'app em modo leitura' });
});

describe('modo leitura (offline)', () => {
  test('abre com os dados guardados em vez do login', () => {
    assert.equal($('#login').hidden, true);
    assert.match(texto('.col-side'), /Tarefa guardada/);
  });
  test('faixa explica o modo leitura com a data dos dados', () => {
    assert.equal($('#syncBanner').hidden, false);
    assert.match(texto('#syncBanner'), /Sem conexão: modo leitura, com os dados de 18 out, 20:30\. Nada pode ser alterado/);
  });
  test('tentar anotar algo é bloqueado (nada é gravado) com a mensagem do modo leitura', async () => {
    // no navegador a rejeição vira "unhandledrejection" e o aviso; o happy-dom entrega como evento "error"
    const erros = [];
    window.addEventListener('error', e => erros.push(e.error?.message || e.message));
    $('#captureInput').value = 'nova tarefa';
    $('#capture').dispatchEvent(new Event('submit', { cancelable: true }));
    await esperar(15);
    assert.ok(erros.some(m => /modo leitura até a internet voltar/.test(m)), JSON.stringify(erros));
    assert.equal(JSON.parse(localStorage.getItem('hub:snap')).S.tasks.length, 1);
  });
});
