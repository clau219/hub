// app.js sem sessão: mostra o login, avisa senha errada e entra com a certa.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { hub, montarDom, $, texto, esperar, ate } from '../helpers/dom.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';

let recarregou = 0;
before(async () => {
  montarDom();
  novoBanco().sessao = null;
  try { Object.defineProperty(location, 'reload', { value: () => recarregou++, configurable: true }); } catch {}
  await hub('app.js');
  await ate(() => !$('#login').hidden, { msg: 'tela de login' });
});
const entrar = async (email, senha) => {
  const f = $('#loginForm');
  f.querySelector('[name=email]').value = email;
  f.querySelector('[name=password]').value = senha;
  f.dispatchEvent(new Event('submit', { cancelable: true }));
  await esperar(10);
};

describe('login', () => {
  test('sem sessão: login aparece e o app fica escondido', () => {
    assert.equal($('#app').hidden, true);
  });
  test('senha errada: mensagem e continua no login', async () => {
    await entrar('claudio@x.com', 'errada');
    assert.equal(texto('#loginErr'), 'E-mail ou senha incorretos.');
    assert.equal(recarregou, 0);
  });
  test('senha certa: entra e recarrega a página', async () => {
    await entrar('claudio@x.com', 'senha-certa');
    assert.deepEqual(banco().login, ['claudio@x.com', 'senha-certa']);
    assert.ok(banco().sessao);
    assert.equal(recarregou, 1);
  });
});
