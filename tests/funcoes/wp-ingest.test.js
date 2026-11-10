// Edge Function wp-ingest: o leitor do WhatsApp pessoal manda estado da conexão, conversas, mensagens e áudios.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let fn;
const TOKEN = 'leitor-teste';
const ANA = '5584999990000@s.whatsapp.net', GRUPO = '120363000000@g.us', CASAS = '558491118864@s.whatsapp.net';
const DADOS = (x = {}) => ({ app_secrets: [{ key: 'wp_leitor_token', value: TOKEN }], app_config: [], wp_chats: [], wp_mensagens: [], ...x });
const enviar = (corpo, token = TOKEN) => fn(pedido('/wp-ingest', { corpo, auth: null, headers: token ? { 'x-wp-token': token } : {} })).then(lerJson);
const status = () => JSON.parse(banco().t('app_config').find(c => c.key === 'wp_status').value);
const msg = (id, x = {}) => ({ chat_id: ANA, id, de_mim: false, autor: 'Ana', tipo: 'texto', texto: 'Oi, tudo bem?', enviado_em: '2026-10-19T14:00:00Z', ...x });

before(async () => { fn = await carregarFuncao('wp-ingest', { GROQ_API_KEY: 'groq-teste' }); });
beforeEach(() => limparRede());

describe('wp-ingest: acesso', () => {
  test('sem token ou com token errado: 401 e nada gravado', async () => {
    novoBanco(DADOS());
    assert.equal((await enviar({ mensagens: [msg('m1')] }, null)).status, 401);
    assert.equal((await enviar({ mensagens: [msg('m1')] }, 'outro')).status, 401);
    assert.equal(banco().t('wp_mensagens').length, 0);
  });
  test('login do Hub (JWT) não serve: só o token do leitor', async () => {
    novoBanco(DADOS());
    assert.equal((await fn(pedido('/wp-ingest', { corpo: { mensagens: [msg('m1')] }, auth: 'usuario' }))).status, 401);
  });
});

describe('wp-ingest: estado da conexão', () => {
  test('QR code fica guardado só enquanto espera; "desde" muda só quando o estado muda', async () => {
    novoBanco(DADOS());
    await enviar({ status: { estado: 'qr', qr: 'data:image/png;base64,AAA' } });
    assert.deepEqual([status().estado, status().qr], ['qr', 'data:image/png;base64,AAA']);
    globalThis.__relogio.avancar(60e3);
    await enviar({ status: { estado: 'conectado', numero: '+5584996011991' } });
    const s1 = status();
    assert.deepEqual([s1.estado, s1.qr, s1.numero], ['conectado', null, '+5584996011991']);
    globalThis.__relogio.avancar(5 * 60e3);
    await enviar({ status: { estado: 'conectado' } });
    assert.equal(status().desde, s1.desde, 'continua conectado: desde não muda');
    assert.notEqual(status().em, s1.em, 'mas o último sinal muda');
    assert.equal(status().numero, '+5584996011991', 'número é lembrado');
    globalThis.__relogio.definir('2026-10-19T15:00:00Z');
  });
  test('estado desconhecido: 500 com o erro', async () => {
    novoBanco(DADOS());
    const r = await enviar({ status: { estado: 'qualquer' } });
    assert.equal(r.status, 500);
  });
});

describe('wp-ingest: conversas e mensagens', () => {
  test('mensagem cria a conversa; repetida não duplica; última mensagem é a mais recente', async () => {
    novoBanco(DADOS());
    await enviar({ mensagens: [msg('m1'), msg('m2', { enviado_em: '2026-10-19T14:05:00Z', de_mim: true, texto: 'Tudo!' })] });
    await enviar({ mensagens: [msg('m1')] });
    assert.equal(banco().t('wp_mensagens').length, 2);
    const c = banco().t('wp_chats').find(x => x.id === ANA);
    assert.deepEqual([c.grupo, c.acompanhar, c.ignorar, c.ultima_msg_em], [false, false, false, '2026-10-19T14:05:00.000Z']);
  });
  test('nome conhecido não é apagado por uma atualização sem nome; acompanhar/ignorar escolhidos na aba ficam', async () => {
    novoBanco(DADOS({ wp_chats: [{ id: GRUPO, nome: 'Família', grupo: true, acompanhar: true, ignorar: false, ultima_msg_em: '2026-10-19T10:00:00Z' }] }));
    await enviar({ chats: [{ id: GRUPO, grupo: true, ultima_msg_em: '2026-10-18T10:00:00Z' }] });
    const c = banco().t('wp_chats')[0];
    assert.deepEqual([c.nome, c.acompanhar, c.ultima_msg_em], ['Família', true, '2026-10-19T10:00:00.000Z']);
  });
  test('conversa com o número das casas nasce ignorada (é onde você manda comandos ao robô)', async () => {
    novoBanco(DADOS());
    await enviar({ chats: [{ id: CASAS, nome: 'Casa Frida Pipa' }] });
    assert.equal(banco().t('wp_chats')[0].ignorar, true);
  });
  test('resposta traz os grupos acompanhados e as conversas ignoradas (o leitor filtra por elas)', async () => {
    novoBanco(DADOS({ wp_chats: [
      { id: GRUPO, grupo: true, acompanhar: true, ignorar: false },
      { id: '1203639@g.us', grupo: true, acompanhar: false, ignorar: false },
      { id: CASAS, grupo: false, acompanhar: false, ignorar: true },
    ] }));
    const { corpo } = await enviar({ status: { estado: 'conectado' } });
    assert.deepEqual([corpo.grupos, corpo.ignorar], [[GRUPO], [CASAS]]);
  });
  test('mensagem sem data ou sem id é descartada; texto muito longo é cortado', async () => {
    novoBanco(DADOS());
    await enviar({ mensagens: [msg('m1', { enviado_em: 'ontem' }), msg(null), msg('m3', { texto: 'x'.repeat(9000) })] });
    assert.deepEqual(banco().t('wp_mensagens').map(m => [m.id, m.texto.length]), [['m3', 8000]]);
  });
});

describe('wp-ingest: áudio', () => {
  test('transcreve pelo Groq e grava o texto na mensagem', async () => {
    novoBanco(DADOS());
    simular('https://api.groq.com/openai/v1/audio/transcriptions', { text: ' Claudio, consegue me mandar o orçamento hoje? ' });
    await enviar({ mensagens: [msg('a1', { tipo: 'audio', texto: '', segundos: 12 })] });
    const r = await enviar({ audios: [{ chat_id: ANA, id: 'a1', mime: 'audio/ogg; codecs=opus', base64: btoa('ogg') }] });
    assert.equal(r.corpo.audios, 1);
    assert.equal(chamadasPara(/groq/)[0].headers.authorization, 'Bearer groq-teste');
    assert.equal(banco().t('wp_mensagens')[0].texto, 'Claudio, consegue me mandar o orçamento hoje?');
  });
  test('áudio já transcrito não perde o texto quando a mensagem chega de novo', async () => {
    novoBanco(DADOS({ wp_mensagens: [msg('a1', { tipo: 'audio', texto: 'já transcrito' })] }));
    await enviar({ mensagens: [msg('a1', { tipo: 'audio', texto: null })] });
    assert.equal(banco().t('wp_mensagens')[0].texto, 'já transcrito');
  });
  test('sem chave de transcrição: avisa e não quebra', async () => {
    novoBanco(DADOS());
    definirEnv('GROQ_API_KEY', undefined);
    try {
      const r = await enviar({ audios: [{ chat_id: ANA, id: 'a1', mime: 'audio/ogg', base64: btoa('x') }] });
      assert.equal(r.status, 200);
      assert.equal(r.corpo.audios.erro, 'sem GROQ_API_KEY');
    } finally { definirEnv('GROQ_API_KEY', 'groq-teste'); }
  });
});
