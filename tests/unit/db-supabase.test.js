// db.js com Supabase (falso, em memória): paginação de 1000 em 1000, filtros, erros e sessão.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/hub.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';

let db;
before(async () => {
  db = await hub('db.js');
  await db.init();
});
beforeEach(() => novoBanco());

describe('db com Supabase', () => {
  test('init liga o cliente com a URL e a chave do config.js', () => {
    assert.equal(db.mode, 'supabase');
    assert.equal(db.client().url, 'https://ovcetvmvbeskgonjruvq.supabase.co');
    assert.match(db.client().key, /^sb_publishable_/);
  });
  test('all lê em páginas até acabar (mais de 1000 linhas)', async () => {
    novoBanco({ contacts: Array.from({ length: 2345 }, (_, i) => ({ id: `c${String(i).padStart(5, '0')}`, nome: `N${i}` })) });
    const l = await db.all('contacts');
    assert.equal(l.length, 2345);
    assert.equal(new Set(l.map(c => c.id)).size, 2345);
    assert.equal(banco().consultas.filter(c => c.tabela === 'contacts').length, 3);
  });
  test('exatamente 1000 linhas ainda faz a 2ª consulta (vazia)', async () => {
    novoBanco({ tasks: Array.from({ length: 1000 }, (_, i) => ({ id: `t${String(i).padStart(4, '0')}` })) });
    assert.equal((await db.all('tasks')).length, 1000);
    assert.equal(banco().consultas.length, 2);
  });
  test('events só traz os de até 400 dias atrás', async () => {
    novoBanco({ events: [
      { id: 'e1', inicio: '2026-10-01T10:00:00Z' },
      { id: 'e2', inicio: '2025-09-15T10:00:00Z' }, // 399 dias
      { id: 'e3', inicio: '2025-09-01T10:00:00Z' }, // > 400 dias
    ] });
    assert.deepEqual((await db.all('events')).map(e => e.id), ['e1', 'e2']);
  });
  test('erro do banco sobe como exceção', async () => {
    banco().falhas.deals = 'permission denied';
    await assert.rejects(db.all('deals'), /permission denied/);
    await assert.rejects(db.insert('deals', { titulo: 'x' }), /permission denied/);
    await assert.rejects(db.update('deals', 'x', {}), /permission denied/);
    await assert.rejects(db.remove('deals', 'x'), /permission denied/);
  });
  test('insert/update/upsert/remove gravam no banco e limpam ""', async () => {
    const r = await db.insert('deals', { titulo: 'A', valor: '' });
    assert.equal(banco().t('deals')[0].valor, null);
    const u = await db.update('deals', r.id, { etapa: 'pago' });
    assert.equal(u.etapa, 'pago');
    await db.upsert('crypto_snap', { dia: '2026-10-19', valor_brl: 1 }, 'dia');
    await db.upsert('crypto_snap', { dia: '2026-10-19', valor_brl: 2 }, 'dia');
    assert.deepEqual(banco().t('crypto_snap').map(s => s.valor_brl), [2]);
    await db.insertMany('tasks', [{ titulo: 'a' }, { titulo: 'b', prazo: '' }]);
    assert.equal(banco().t('tasks')[1].prazo, null);
    await db.remove('deals', r.id);
    assert.equal(banco().t('deals').length, 0);
    await db.bulkImport({ contacts: [{ id: 'c1', nome: 'Ana', telefone: '' }] });
    assert.equal(banco().t('contacts')[0].telefone, null);
  });
  test('update de id inexistente falha (single sem linha)', async () => {
    await assert.rejects(db.update('deals', 'nao-existe', { etapa: 'x' }), /no\) rows|0\)/);
  });
  test('sessão: devolve a sessão; sem sessão por falta de rede liga semRede', async () => {
    assert.equal((await db.auth.session()).access_token, 'token-teste');
    assert.equal(db.auth.semRede, false);
    banco().erroSessao = { name: 'AuthRetryableFetchError', message: 'Failed to fetch' };
    assert.equal(await db.auth.session(), null);
    assert.equal(db.auth.semRede, true);
    banco().erroSessao = null; banco().sessao = null;
    assert.equal(await db.auth.session(), null);
    assert.equal(db.auth.semRede, false, 'sessão vencida com rede: vai para o login');
  });
  test('signIn com senha errada lança; certa grava a sessão; signOut limpa', async () => {
    await assert.rejects(db.auth.signIn('a@b.c', 'errada'), /Invalid login/);
    await db.auth.signIn('a@b.c', 'senha-certa');
    assert.equal(banco().sessao.user.email, 'a@b.c');
    await db.auth.signOut();
    assert.equal(banco().sessao, null);
  });
});
