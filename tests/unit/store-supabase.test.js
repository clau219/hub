// store.js com Supabase: cópia hub:snap para ficar offline, falha parcial de tabelas e envio ao Google Agenda (gcal-sync).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { montarDom, hub, esperar } from '../helpers/dom.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';

let store, db;
before(async () => {
  montarDom();
  db = await hub('db.js');
  store = await hub('store.js');
});
const TODAS = ['contacts', 'deals', 'quotes', 'tasks', 'properties', 'bookings', 'events', 'calendar_sources', 'habits', 'habit_logs', 'crypto_watch', 'crypto_tx', 'crypto_snap', 'crypto_plano'];

describe('primeira carga sem rede usa a cópia guardada', () => {
  test('tudo falha na 1ª carga: lê hub:snap e marca offline', async () => {
    await db.init();
    localStorage.setItem('hub:snap', JSON.stringify({ at: '2026-10-18T20:00:00Z', S: { contacts: [{ id: 'c1', nome: 'Guardado' }] } }));
    const b = novoBanco();
    TODAS.forEach(t => (b.falhas[t] = 'Failed to fetch'));
    await store.load();
    assert.deepEqual(store.S.contacts.map(c => c.nome), ['Guardado']);
    assert.deepEqual(store.S.deals, []);
    assert.equal(store.meta.offline, true);
    assert.equal(store.meta.at, '2026-10-18T20:00:00Z');
    assert.equal(store.meta.erro, 'Failed to fetch');
    assert.equal(store.meta.falhas.length, TODAS.length);
  });
  test('depois de uma falha total, a próxima falha total mantém o que está na tela', async () => {
    localStorage.setItem('hub:snap', JSON.stringify({ at: 'x', S: { contacts: [{ id: 'z', nome: 'Outro' }] } }));
    await store.load();
    assert.deepEqual(store.S.contacts.map(c => c.nome), ['Guardado']);
  });
});

describe('carga normal', () => {
  beforeEach(() => novoBanco({
    contacts: [{ id: 'c1', nome: 'Ana' }],
    properties: [{ id: 'QS39', nome: 'Casa Frida' }],
    crypto_snap: [{ id: 's1', dia: '2026-10-18', valor_brl: 1 }],
  }));
  test('com tudo certo grava hub:snap (sem crypto_snap) e limpa o offline', async () => {
    await store.load();
    assert.equal(store.meta.offline, false);
    assert.equal(store.meta.erro, null);
    const snap = JSON.parse(localStorage.getItem('hub:snap'));
    assert.equal(snap.at, '2026-10-19T15:00:00.000Z');
    assert.deepEqual(snap.S.contacts, [{ id: 'c1', nome: 'Ana' }]);
    assert.equal('crypto_snap' in snap.S, false);
  });
  test('falha parcial: tabela que falhou mantém o valor anterior e não grava cópia', async () => {
    await store.load();
    localStorage.removeItem('hub:snap');
    banco().falhas.contacts = 'timeout';
    banco().t('properties').push({ id: 'QS40', nome: 'Casa Azul' });
    await store.load();
    assert.deepEqual(store.S.contacts.map(c => c.nome), ['Ana']);
    assert.equal(store.S.properties.length, 2);
    assert.equal(store.meta.erro, 'Não carregou: contacts');
    assert.deepEqual(store.meta.falhas, ['contacts']);
    assert.equal(localStorage.getItem('hub:snap'), null);
  });
  test('com Supabase não cria as casas padrão', async () => {
    novoBanco();
    await store.load();
    assert.deepEqual(store.S.properties, []);
  });
});

describe('Google Agenda (gcal-sync)', () => {
  beforeEach(() => novoBanco());
  test('várias gravações de deals/events seguidas viram uma chamada só, 1,5 s depois', async () => {
    const b = banco();
    b.funcoes['gcal-sync'] = () => ({ ok: true });
    await store.save('deals', { titulo: 'A', negocio: 'dj' });
    await store.save('events', { titulo: 'B', calendario: 'dj' });
    await store.save('tasks', { titulo: 'não conta' });
    assert.equal(b.invocacoes.length, 0);
    await new Promise(r => setTimeout(r, 1600));
    assert.deepEqual(b.invocacoes, [{ nome: 'gcal-sync', body: {} }]);
  });
  test('evento que veio do Google é atualizado na hora pelo id', async () => {
    const b = banco();
    b.t('events').push({ id: 'ev1', titulo: 'G', origem: 'google' });
    b.funcoes['gcal-sync'] = () => ({ ok: true });
    await store.save('events', { titulo: 'G2', origem: 'google' }, 'ev1');
    await esperar();
    assert.deepEqual(b.invocacoes, [{ nome: 'gcal-sync', body: { evento: 'ev1' } }]);
  });
  test('erro da função vira aviso na tela, menos a falta do segredo GCAL_SA_JSON', async () => {
    const avisos = [];
    window.addEventListener('hub:aviso', e => avisos.push(e.detail));
    const b = banco();
    b.t('events').push({ id: 'ev1', origem: 'google' }, { id: 'ev2', origem: 'google' });
    b.funcoes['gcal-sync'] = body => ({ erro: body.evento === 'ev1' ? 'quota excedida' : 'GCAL_SA_JSON ausente' });
    await store.save('events', { origem: 'google' }, 'ev1');
    await store.save('events', { origem: 'google' }, 'ev2');
    await esperar();
    assert.deepEqual(avisos, ['Google Agenda: quota excedida']);
  });
  test('del de deal também sincroniza', async () => {
    const b = banco();
    b.t('deals').push({ id: 'd1' });
    b.funcoes['gcal-sync'] = () => ({});
    await store.del('deals', 'd1');
    await new Promise(r => setTimeout(r, 1600));
    assert.equal(b.invocacoes.length, 1);
  });
});
