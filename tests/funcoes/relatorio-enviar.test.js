// Edge Function relatorio-enviar: manda o relatório da casa ao proprietário pelo Gmail (SMTP 465), com o PDF anexo, só com o login.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, definirEnv } from '../helpers/funcao.js';
import { novoBanco } from '../helpers/fake-supabase.js';

let fn;
const ENV = { GMAIL_USER: 'claudiorsbraga@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n').toString('base64');
const OK = { para: 'maria@exemplo.com', assunto: 'Relatório de outubro/2026 — Casa Frida', corpo: 'Olá, Maria!\n\nSegue em anexo...', pdf: PDF, arquivo: 'Relatorio Casa Frida 2026-10.pdf' };
const chamar = (corpo, auth = 'usuario') => fn(pedido('/relatorio-enviar', { corpo, auth })).then(lerJson);

before(async () => { fn = await carregarFuncao('relatorio-enviar', ENV); });
beforeEach(() => { novoBanco({}); globalThis.__email = { enviados: [], transporte: null, falhar: null }; for (const [k, v] of Object.entries(ENV)) definirEnv(k, v); });

describe('relatorio-enviar', () => {
  test('só com o login', async () => {
    for (const auth of [null, 'anon', 'invalido']) assert.equal((await chamar(OK, auth)).status, 401);
    assert.equal(globalThis.__email.enviados.length, 0);
  });
  test('sem Gmail configurado: 500 explicando o que cadastrar', async () => {
    definirEnv('GMAIL_USER', undefined);
    assert.match((await chamar(OK)).corpo.error, /GMAIL_USER e GMAIL_APP_PASSWORD/);
  });
  test('envia texto + PDF anexo pelo smtp.gmail.com:465, de "Claudio Braga"', async () => {
    const { status, corpo } = await chamar(OK);
    assert.deepEqual([status, corpo], [200, { ok: true, messageId: '<teste-1@gmail.com>', para: ['maria@exemplo.com'] }]);
    assert.deepEqual(globalThis.__email.transporte, { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'claudiorsbraga@gmail.com', pass: 'abcdefghijklmnop' } });
    assert.deepEqual(globalThis.__email.enviados[0], { from: '"Claudio Braga" <claudiorsbraga@gmail.com>', to: 'maria@exemplo.com', subject: OK.assunto, text: OK.corpo,
      attachments: [{ filename: OK.arquivo, content: PDF, encoding: 'base64', contentType: 'application/pdf' }] });
  });
  test('recusa o que não é PDF, PDF grande demais e nome de arquivo estranho', async () => {
    assert.match((await chamar({ ...OK, pdf: Buffer.from('<html>').toString('base64') })).corpo.error, /PDF inválido/);
    assert.match((await chamar({ ...OK, pdf: '' })).corpo.error, /PDF inválido/);
    assert.match((await chamar({ ...OK, pdf: 'JVBERi0' + 'A'.repeat(3_000_000) })).corpo.error, /PDF inválido/);
    for (const arquivo of ['relatorio.exe', '../x.pdf', 'a\nb.pdf']) assert.match((await chamar({ ...OK, arquivo })).corpo.error, /nome do arquivo/);
    assert.equal(globalThis.__email.enviados.length, 0);
  });
  test('recusa destinatário, assunto ou corpo inválidos', async () => {
    for (const para of ['', 'sem-arroba', 'a@b.com,b@c.com,c@d.com,d@e.com']) assert.match((await chamar({ ...OK, para })).corpo.error, /destinatário/);
    assert.match((await chamar({ ...OK, assunto: 'a\nBcc: x@y.com' })).corpo.error, /assunto/);
    assert.match((await chamar({ ...OK, corpo: ' ' })).corpo.error, /vazio/);
  });
  test('teste: vai para o próprio Gmail com [Teste] no assunto, mesmo sem destinatário', async () => {
    const { status, corpo } = await chamar({ ...OK, para: '', teste: true });
    assert.deepEqual([status, corpo.para], [200, ['claudiorsbraga@gmail.com']]);
    assert.deepEqual([globalThis.__email.enviados[0].to, globalThis.__email.enviados[0].subject], ['claudiorsbraga@gmail.com', '[Teste] ' + OK.assunto]);
    await chamar({ ...OK, teste: 'sim' }); // só true liga o teste
    assert.equal(globalThis.__email.enviados[1].to, 'maria@exemplo.com');
  });
  test('senha recusada pelo Gmail vira mensagem clara', async () => {
    globalThis.__email.falhar = 'Invalid login: 535-5.7.8 Username and Password not accepted';
    assert.deepEqual(await chamar(OK), { status: 502, corpo: { error: 'o Gmail recusou o login (confira a senha de app)' } });
  });
});
