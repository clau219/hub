// Edge Function wa-vigia: Z-API desconectada/reconectada e clientes esperando resposta há 20+ min, avisados por push.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let fn;
const ENV = { ZAPI_INSTANCE: 'INST1', ZAPI_TOKEN: 'tok1', ZAPI_CLIENT_TOKEN: 'cli1' };
const STATUS = 'https://api.z-api.io/instances/INST1/token/tok1/status';
const ANA = '5584991118864', BIA = '5584988887777';
const min = n => new Date(Date.parse('2026-10-19T15:00:00Z') - n * 60e3).toISOString(); // relógio: 12:00 em Pipa
const msg = (id, wa_id, autor, minutos, texto = 'Tem vaga?') => ({ id, wa_id, autor, texto, tipo: 'text', enviado_em: min(minutos) });
const DADOS = (x = {}) => comCron({
  app_secrets: [{ key: 'cron_token', value: 'cron-teste' }, { key: 'vapid_public', value: 'pub' }, { key: 'vapid_private', value: 'priv' }],
  push_subscriptions: [{ id: 's1', endpoint: 'https://push/1', p256dh: 'p', auth: 'a' }],
  wa_contacts: [{ wa_id: ANA, nome: 'Ana Lima' }, { wa_id: BIA, nome: 'Bia' }],
  app_config: [],
  ...x,
});
const config = k => { const r = banco().t('app_config').find(c => c.key === k); return r ? JSON.parse(r.value) : null; };
const rodar = (corpo = {}) => fn(pedido('/wa-vigia', { corpo, auth: 'cron' })).then(lerJson);
const envios = () => globalThis.__webpush.envios;
const conectado = (ok = true) => simular(STATUS, ok ? { connected: true, smartphoneConnected: true } : { connected: false, error: 'You are not connected.' });

before(async () => { fn = await carregarFuncao('wa-vigia', ENV); });
beforeEach(() => { limparRede(); globalThis.__webpush = { envios: [], falhar: null }; for (const [k, v] of Object.entries(ENV)) definirEnv(k, v); });

describe('wa-vigia: acesso', () => {
  test('sem x-hub-cron nem login: 401', async () => {
    novoBanco(DADOS());
    assert.equal((await fn(pedido('/wa-vigia', { corpo: {}, auth: null }))).status, 401);
  });
});

describe('wa-vigia: conexão da Z-API', () => {
  test('canal pela Meta (WA_CANAL=meta): não consulta a Z-API, não avisa queda e troca o status antigo por "canal Meta"', async () => {
    novoBanco(DADOS({ app_config: [{ key: 'zapi_status', value: JSON.stringify({ ok: false, motivo: 'x', desde: min(120), avisado_em: min(120) }) }] }));
    definirEnv('WA_CANAL', 'meta');
    try {
      const { corpo } = await rodar();
      assert.equal(corpo.conexao.ignorado, 'canal é a Meta');
      assert.equal(chamadasPara(/\/status$/).length, 0);
      assert.equal(config('zapi_status').canal, 'meta');
      assert.equal(config('zapi_status').ok, undefined, 'a faixa vermelha some');
      assert.equal(envios().length, 0);
    } finally { definirEnv('WA_CANAL', undefined); }
  });
  test('conectada: grava o status e não avisa; consulta com o Client-Token', async () => {
    novoBanco(DADOS()); conectado();
    await rodar();
    assert.equal(chamadasPara(/\/status$/)[0].headers['client-token'], 'cli1');
    assert.deepEqual([config('zapi_status').ok, config('zapi_status').celular], [true, true]);
    assert.equal(envios().length, 0);
  });
  test('caiu: avisa uma vez, com o motivo em português; não repete antes de 6 h', async () => {
    novoBanco(DADOS({ app_config: [{ key: 'zapi_status', value: JSON.stringify({ ok: true, em: min(5), desde: min(600) }) }] }));
    conectado(false);
    await rodar();
    assert.equal(envios().length, 1);
    assert.equal(envios()[0].title, 'WhatsApp das casas desconectado');
    assert.match(envios()[0].body, /O celular das casas não está conectado à Z-API/);
    assert.equal(envios()[0].url, './#/whatsapp');
    const st = config('zapi_status');
    assert.deepEqual([st.ok, st.desde, !!st.avisado_em], [false, '2026-10-19T15:00:00.000Z', true]);
    globalThis.__relogio.avancar(60 * 60e3);
    await rodar();
    assert.equal(envios().length, 1, 'continua fora há 1 h: não repete');
    globalThis.__relogio.avancar(6 * 60 * 60e3);
    await rodar();
    assert.equal(envios().length, 2, 'passou de 6 h: lembra de novo');
    globalThis.__relogio.definir('2026-10-19T15:00:00Z');
  });
  test('voltou: avisa "reconectado" e limpa o aviso', async () => {
    novoBanco(DADOS({ app_config: [{ key: 'zapi_status', value: JSON.stringify({ ok: false, motivo: 'x', desde: min(30), avisado_em: min(30) }) }] }));
    conectado();
    await rodar();
    assert.deepEqual(envios().map(e => e.title), ['WhatsApp das casas reconectado']);
    assert.equal(config('zapi_status').avisado_em, null);
  });
  test('plano vencido / token trocado vira texto claro', async () => {
    novoBanco(DADOS());
    simular(STATUS, { status: 400, json: { error: 'Instance not found' } });
    await rodar();
    assert.match(envios()[0].body, /Instância da Z-API não encontrada \(plano vencido/);
  });
  test('Z-API fora do ar (erro de rede do nosso lado): não muda o estado nem avisa', async () => {
    novoBanco(DADOS());
    simular(STATUS, () => { throw new TypeError('fetch failed'); });
    const { corpo } = await rodar();
    assert.match(corpo.conexao.ignorado, /não respondeu/);
    assert.equal(config('zapi_status'), null);
    assert.equal(envios().length, 0);
  });
});

describe('wa-vigia: quem está esperando resposta', () => {
  test('cliente há 20+ min sem resposta: um aviso com nome, tempo e trecho; abre a conversa', async () => {
    novoBanco(DADOS({ wa_messages: [msg('a1', ANA, 'cliente', 25, 'Pode mandar o pix?')] }));
    conectado();
    await rodar();
    assert.deepEqual(envios().map(e => [e.title, e.body, e.url]), [['Ana Lima espera resposta há 25 min', '“Pode mandar o pix?”', `./#/whatsapp?c=${ANA}`]]);
    assert.deepEqual(config('wa_avisados'), { [ANA]: 'a1' });
  });
  test('não avisa: menos de 20 min, ou a última mensagem foi sua/do robô', async () => {
    novoBanco(DADOS({ wa_messages: [msg('a1', ANA, 'cliente', 10), msg('b1', BIA, 'cliente', 60), msg('b2', BIA, 'robo', 59)] }));
    conectado();
    const { corpo } = await rodar();
    assert.deepEqual([corpo.esperando.esperando, envios().length], [0, 0]);
  });
  test('a mesma mensagem não é avisada duas vezes; mensagem nova da mesma pessoa avisa de novo', async () => {
    novoBanco(DADOS({ wa_messages: [msg('a1', ANA, 'cliente', 25)] }));
    conectado();
    await rodar(); await rodar();
    assert.equal(envios().length, 1);
    banco().t('wa_messages').push(msg('a2', ANA, 'cliente', 21, 'Alô?'));
    await rodar();
    assert.equal(envios().length, 2);
    assert.match(envios()[1].body, /Alô\?/);
  });
  test('várias pessoas: um aviso só, com a lista', async () => {
    novoBanco(DADOS({ wa_messages: [msg('a1', ANA, 'cliente', 25), msg('b1', BIA, 'cliente', 180, 'Aceitam pet?')] }));
    conectado();
    await rodar();
    assert.equal(envios().length, 1);
    assert.equal(envios()[0].title, '2 pessoas esperando resposta no WhatsApp');
    assert.match(envios()[0].body, /Ana Lima \(25 min\).*\nBia \(3 h\): “Aceitam pet\?”/);
  });
  test('madrugada (23h–7h): fica quieta e avisa às 7h quem ainda espera', async () => {
    globalThis.__relogio.definir('2026-10-19T05:00:00Z'); // 02:00 em Pipa
    novoBanco(DADOS({ wa_messages: [{ ...msg('a1', ANA, 'cliente', 0), enviado_em: '2026-10-19T04:00:00Z' }] }));
    conectado();
    assert.equal((await rodar()).corpo.esperando.madrugada, true);
    assert.equal(envios().length, 0);
    globalThis.__relogio.definir('2026-10-19T10:05:00Z'); // 07:05
    await rodar();
    assert.match(envios()[0].title, /Ana Lima espera resposta há 6 h/);
    globalThis.__relogio.definir('2026-10-19T15:00:00Z');
  });
  test('modo teste: calcula sem mandar push', async () => {
    novoBanco(DADOS({ wa_messages: [msg('a1', ANA, 'cliente', 25)] }));
    conectado();
    const { corpo } = await rodar({ teste: true });
    assert.equal(corpo.avisos.length, 1);
    assert.equal(envios().length, 0);
  });
});

describe('wa-vigia: envio', () => {
  test('inscrição vencida (410) é apagada; o aviso vai para o registro de notificações', async () => {
    novoBanco(DADOS({ push_subscriptions: [{ id: 's1', endpoint: 'https://push/1' }, { id: 's2', endpoint: 'https://push/velho' }], wa_messages: [msg('a1', ANA, 'cliente', 25)] }));
    globalThis.__webpush.falhar = e => (e.endsWith('velho') ? 410 : 0);
    conectado();
    const { corpo } = await rodar();
    assert.equal(corpo.enviados, 1);
    assert.deepEqual(banco().t('push_subscriptions').map(s => s.id), ['s1']);
    assert.equal(banco().t('notifications_log')[0].tipo, 'wa-esperando');
  });
  test('sem chaves de push (notificações nunca ativadas): não quebra', async () => {
    novoBanco(DADOS({ app_secrets: [{ key: 'cron_token', value: 'cron-teste' }], wa_messages: [msg('a1', ANA, 'cliente', 25)] }));
    conectado();
    const { status, corpo } = await rodar();
    assert.deepEqual([status, corpo.enviados], [200, 0]);
  });
});
