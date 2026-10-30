// Edge Function portaria-enviar: manda o e-mail da portaria pelo Gmail (SMTP 465), só com o login.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, definirEnv } from '../helpers/funcao.js';
import { novoBanco } from '../helpers/fake-supabase.js';

let fn;
const ENV = { GMAIL_USER: 'claudiorsbraga@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' };
const OK = { para: 'appp.acesso@gmail.com', assunto: 'Autorização de Acesso — Casa Frida QS39 — Hóspedes (16/10 a 21/10/2026)', corpo: 'Segue abaixo a lista...\n\n1. Ana | CPF 1' };
const chamar = (corpo, auth = 'usuario') => fn(pedido('/portaria-enviar', { corpo, auth })).then(lerJson);

before(async () => { fn = await carregarFuncao('portaria-enviar', ENV); });
beforeEach(() => { novoBanco({}); globalThis.__email = { enviados: [], transporte: null, falhar: null }; for (const [k, v] of Object.entries(ENV)) definirEnv(k, v); });

describe('portaria-enviar', () => {
  test('só com o login', async () => {
    for (const auth of [null, 'anon', 'invalido']) assert.equal((await chamar(OK, auth)).status, 401);
    assert.equal(globalThis.__email.enviados.length, 0);
  });
  test('sem Gmail configurado: 500 explicando o que cadastrar', async () => {
    definirEnv('GMAIL_APP_PASSWORD', undefined);
    const { status, corpo } = await chamar(OK);
    assert.equal(status, 500);
    assert.match(corpo.error, /GMAIL_USER e GMAIL_APP_PASSWORD/);
  });
  test('envia em texto puro pelo smtp.gmail.com:465, de "Claudio Braga", senha sem espaços', async () => {
    const { status, corpo } = await chamar(OK);
    assert.deepEqual([status, corpo], [200, { ok: true, messageId: '<teste-1@gmail.com>', para: ['appp.acesso@gmail.com'] }]);
    assert.deepEqual(globalThis.__email.transporte, { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'claudiorsbraga@gmail.com', pass: 'abcdefghijklmnop' } });
    assert.deepEqual(globalThis.__email.enviados[0], { from: '"Claudio Braga" <claudiorsbraga@gmail.com>', to: 'appp.acesso@gmail.com', subject: OK.assunto, text: OK.corpo });
  });
  test('até 3 destinatários separados por vírgula', async () => {
    await chamar({ ...OK, para: 'appp.acesso@gmail.com; adm@pipa.com.br' });
    assert.equal(globalThis.__email.enviados[0].to, 'appp.acesso@gmail.com, adm@pipa.com.br');
  });
  test('recusa destinatário, assunto ou corpo inválidos', async () => {
    for (const para of ['', 'sem-arroba', 'a@b.com, x', 'a@b.com,b@c.com,c@d.com,d@e.com']) assert.match((await chamar({ ...OK, para })).corpo.error, /destinatário/);
    assert.match((await chamar({ ...OK, assunto: 'a\nBcc: x@y.com' })).corpo.error, /assunto/);
    assert.match((await chamar({ ...OK, corpo: '  ' })).corpo.error, /vazio/);
    assert.equal(globalThis.__email.enviados.length, 0);
  });
  test('senha recusada pelo Gmail vira mensagem clara; outro erro passa o motivo', async () => {
    globalThis.__email.falhar = 'Invalid login: 535-5.7.8 Username and Password not accepted';
    assert.deepEqual(await chamar(OK), { status: 502, corpo: { error: 'o Gmail recusou o login (confira a senha de app)' } });
    globalThis.__email.falhar = 'connect ETIMEDOUT';
    assert.match((await chamar(OK)).corpo.error, /não aceitou o envio: connect ETIMEDOUT/);
  });
});
