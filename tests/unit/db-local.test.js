// db.js em modo local (sem Supabase): dados no localStorage, mesmo contrato do banco.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/hub.js';

let db;
before(async () => { db = await hub('db.js'); });
beforeEach(() => localStorage.clear());
const guardado = t => JSON.parse(localStorage.getItem('hub:' + t) || '[]');

describe('db local', () => {
  test('começa em modo local, sem cliente', async () => {
    assert.equal(db.mode, 'local');
    assert.equal(db.client(), null);
    assert.deepEqual(await db.auth.session(), { local: true });
    await db.auth.signOut(); // não quebra sem cliente
  });
  test('insert cria id e created_at; deals ganham updated_at; "" vira null', async () => {
    const r = await db.insert('deals', { titulo: 'Casamento', valor: '' });
    assert.match(r.id, /^[0-9a-f-]{36}$/);
    assert.equal(r.created_at, '2026-10-19T15:00:00.000Z');
    assert.equal(r.updated_at, r.created_at);
    assert.equal(r.valor, null);
    assert.deepEqual(guardado('deals'), [r]);
    const t = await db.insert('tasks', { titulo: 'x' });
    assert.equal(t.updated_at, undefined);
  });
  test('all lê a tabela; tabela vazia ou JSON corrompido vira []', async () => {
    assert.deepEqual(await db.all('nada'), []);
    localStorage.setItem('hub:quebrada', '{não é json');
    assert.deepEqual(await db.all('quebrada'), []);
  });
  test('update mescla, atualiza updated_at de deals e falha se não achar', async () => {
    const r = await db.insert('deals', { titulo: 'A', etapa: 'lead' });
    globalThis.__relogio.avancar(60_000);
    const u = await db.update('deals', r.id, { etapa: 'orcamento', notas: '' });
    assert.equal(u.titulo, 'A');
    assert.equal(u.etapa, 'orcamento');
    assert.equal(u.notas, null);
    assert.equal(u.updated_at, '2026-10-19T15:01:00.000Z');
    await assert.rejects(db.update('deals', 'nao-existe', {}), /Registro não encontrado/);
  });
  test('insertMany e remove', async () => {
    await db.insertMany('crypto_tx', [{ simbolo: 'BTC' }, { simbolo: 'ETH', obs: '' }]);
    const l = await db.all('crypto_tx');
    assert.equal(l.length, 2);
    assert.equal(l[1].obs, null);
    await db.remove('crypto_tx', l[0].id);
    assert.deepEqual((await db.all('crypto_tx')).map(r => r.simbolo), ['ETH']);
  });
  test('upsert pela chave: insere a primeira vez e atualiza depois', async () => {
    const a = await db.upsert('crypto_snap', { dia: '2026-10-19', valor_brl: 10 }, 'dia');
    const b = await db.upsert('crypto_snap', { dia: '2026-10-19', valor_brl: 20 }, 'dia');
    assert.equal(a.id, b.id);
    assert.equal(b.valor_brl, 20);
    assert.equal(guardado('crypto_snap').length, 1);
  });
  test('bulkImport junta sem duplicar ids e ignora o que não é lista', async () => {
    await db.insert('contacts', { id: 'c1', nome: 'Ana' });
    await db.bulkImport({ contacts: [{ id: 'c1', nome: 'Outra' }, { id: 'c2', nome: 'Bia' }], lixo: 'x', vazio: [] });
    assert.deepEqual((await db.all('contacts')).map(c => c.nome), ['Ana', 'Bia']);
  });
  test('modo leitura bloqueia toda gravação (e é permanente)', async () => {
    db.modoLeitura();
    assert.equal(db.leitura, true);
    for (const f of [() => db.insert('t', {}), () => db.update('t', '1', {}), () => db.insertMany('t', []), () => db.upsert('t', {}, 'id'), () => db.remove('t', '1')])
      await assert.rejects(f(), /modo leitura/);
    assert.deepEqual(await db.all('t'), [], 'leitura continua funcionando');
  });
});
