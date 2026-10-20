// sw.js (service worker): cache para abrir offline, estratégia de rede e notificações push. Roda num contexto isolado (vm).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { RAIZ } from '../helpers/hub.js';

const codigo = readFileSync(new URL('sw.js', RAIZ), 'utf8');
let ctx, ouvintes, caches, rede, janelas, notificacoes;

function montar() {
  ouvintes = {}; rede = []; notificacoes = []; janelas = [];
  const lojas = new Map();
  const loja = nome => {
    if (!lojas.has(nome)) {
      const m = new Map();
      lojas.set(nome, {
        m,
        add: async a => { if (a === 'falha.js') throw new Error('404'); m.set(a, 'ok'); },
        put: async (req, r) => m.set(typeof req === 'string' ? req : req.url, r),
        match: async req => m.get(typeof req === 'string' ? req : req.url),
      });
    }
    return lojas.get(nome);
  };
  caches = {
    lojas,
    open: async n => loja(n),
    keys: async () => [...lojas.keys()],
    delete: async n => lojas.delete(n),
    match: async req => { for (const l of lojas.values()) { const r = await l.match(req); if (r) return r; } },
  };
  const self = {
    addEventListener: (t, f) => (ouvintes[t] = f),
    skipWaiting: () => (self.pulou = true),
    clients: { claim: () => (self.assumiu = true) },
    registration: { scope: 'https://clau219.github.io/hub/', showNotification: async (t, o) => notificacoes.push([t, o]) },
  };
  const clients = {
    matchAll: async () => janelas,
    openWindow: async u => (self.abriu = u),
  };
  const fetch = async (req, opt) => { rede.push([typeof req === 'string' ? req : req.url, opt]); if (self.offline) throw new TypeError('offline'); return { ok: true, type: 'basic', clone() { return this; }, url: req.url }; };
  ctx = { self, caches, clients, fetch, URL, location: { origin: 'https://clau219.github.io' }, Promise, console };
  vm.runInNewContext(codigo, ctx);
}
// Evento com waitUntil/respondWith que guarda a promessa
const evento = (x = {}) => { const e = { esperar: [], resposta: null, waitUntil: p => e.esperar.push(p), respondWith: p => (e.resposta = p), ...x }; return e; };
const req = (url, method = 'GET') => ({ url, method });
before(montar);
beforeEach(montar);

describe('service worker', () => {
  test('a lista de arquivos guardados para offline tem todos os .js do Hub', () => {
    const lista = JSON.parse(codigo.match(/const ASSETS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
    const js = readdirSync(RAIZ).filter(f => f.endsWith('.js') && f !== 'sw.js');
    const faltam = js.filter(f => !lista.includes(f));
    assert.deepEqual(faltam, [], `arquivos fora do cache offline: ${faltam.join(', ')}`);
    assert.ok(lista.includes('index.html') && lista.includes('app.css'));
  });
  test('instalar: guarda os arquivos (um que falhe não impede) e ativa logo', async () => {
    const e = evento();
    ouvintes.install(e);
    await Promise.all(e.esperar);
    const cache = [...caches.lojas.keys()][0];
    assert.match(cache, /^hub-v\d+$/);
    assert.ok(caches.lojas.get(cache).m.has('app.js'));
    assert.equal(ctx.self.pulou, true);
  });
  test('ativar: apaga caches de versões antigas, mantém o atual e o do CDN', async () => {
    await caches.open('hub-v1'); await caches.open('hub-cdn-v1');
    const atual = codigo.match(/const CACHE = '([^']+)'/)[1];
    await caches.open(atual);
    const e = evento();
    ouvintes.activate(e);
    await Promise.all(e.esperar);
    assert.deepEqual([...caches.lojas.keys()].sort(), ['hub-cdn-v1', atual].sort());
    assert.equal(ctx.self.assumiu, true);
  });
  test('arquivos do Hub: rede primeiro (sem cache do navegador) e cópia guardada sem internet', async () => {
    const e = evento({ request: req('https://clau219.github.io/hub/app.js') });
    ouvintes.fetch(e);
    await e.resposta;
    assert.equal(rede[0][1].cache, 'no-cache'); // objeto de outro contexto (vm): compara o campo
    ctx.self.offline = true;
    const atual = codigo.match(/const CACHE = '([^']+)'/)[1];
    (await caches.open(atual)).m.set('https://clau219.github.io/hub/app.js', 'copia');
    const e2 = evento({ request: req('https://clau219.github.io/hub/app.js') });
    ouvintes.fetch(e2);
    assert.equal(await e2.resposta, 'copia');
  });
  test('supabase-js do jsDelivr e fontes: cache primeiro', async () => {
    const u = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
    (await caches.open('hub-cdn-v1')).m.set(u, 'lib-guardada');
    const e = evento({ request: req(u) });
    ouvintes.fetch(e);
    assert.equal(await e.resposta, 'lib-guardada');
    assert.equal(rede.length, 0);
  });
  test('POST e outros domínios (Supabase, APIs) passam direto', () => {
    const e1 = evento({ request: req('https://clau219.github.io/hub/x', 'POST') });
    ouvintes.fetch(e1);
    const e2 = evento({ request: req('https://ovcetvmvbeskgonjruvq.supabase.co/rest/v1/deals') });
    ouvintes.fetch(e2);
    assert.equal(e1.resposta, null);
    assert.equal(e2.resposta, null);
  });
  test('push: mostra a notificação com o link; sem JSON usa o texto', async () => {
    const e = evento({ data: { json: () => ({ title: 'Hub 7h30', body: '3 atrasados', url: './#/hoje', tag: 'resumo' }) } });
    ouvintes.push(e);
    await Promise.all(e.esperar);
    assert.deepEqual(notificacoes[0][0], 'Hub 7h30');
    assert.deepEqual([notificacoes[0][1].body, notificacoes[0][1].data.url, notificacoes[0][1].tag], ['3 atrasados', './#/hoje', 'resumo']);
    const e2 = evento({ data: { json: () => { throw new Error('texto'); }, text: () => 'só texto' } });
    ouvintes.push(e2);
    await Promise.all(e2.esperar);
    assert.deepEqual([notificacoes[1][0], notificacoes[1][1].body], ['Hub', 'só texto']);
  });
  test('clicar na notificação foca o Hub aberto ou abre uma janela', async () => {
    let navegou = null, focou = false;
    janelas = [{ url: 'https://clau219.github.io/hub/#/agenda', navigate: u => (navegou = u), focus: () => (focou = true) }];
    const e = evento({ notification: { close() {}, data: { url: './#/hoje' } } });
    ouvintes.notificationclick(e);
    await Promise.all(e.esperar);
    assert.deepEqual([navegou, focou], ['./#/hoje', true]);
    janelas = [];
    const e2 = evento({ notification: { close() {}, data: { url: './#/pipeline' } } });
    ouvintes.notificationclick(e2);
    await Promise.all(e2.esperar);
    assert.equal(ctx.self.abriu, './#/pipeline');
  });
});
