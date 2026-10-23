// Edge Function wa-responder: enviar pela Z-API a partir do Hub (grava como mensagem sua e silencia o robô)
// e rascunho da IA com a base das casas e os valores da oportunidade.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let fn;
const ENV = { ZAPI_INSTANCE: 'INST1', ZAPI_TOKEN: 'tok1', ZAPI_CLIENT_TOKEN: 'cli1', ANTHROPIC_API_KEY: 'sk-teste' };
const ZAPI = 'https://api.z-api.io/instances/INST1/token/tok1/send-text';
const ANA = '5584991118864';
const BASE = {
  geral: { checkin: '14h', checkout: '11h', pets: 'Pet pequeno, R$ 100', pix_chave: 'pix@casas.com', pix_nome: 'Claudio', sinal_pct: '50' },
  casas: { QS40: { wifi_rede: 'CasaAzul', wifi_senha: 'segredo123', quartos: '3 suítes', localizacao: 'https://maps.app.goo.gl/azul' } },
};
const DADOS = (x = {}) => ({
  properties: [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }],
  wa_contacts: [{ wa_id: ANA, nome: 'Ana Lima', deal_id: 'd1' }],
  deals: [{ id: 'd1', titulo: 'Aluguéis — Ana Lima', etapa: 'orcamento', valor: 1650, local: 'Casa Azul', data_evento: '2026-11-17', pagamentos: [{ valor: 300 }] }],
  wa_messages: [
    { id: 'm1', wa_id: ANA, autor: 'cliente', texto: 'Tem vaga 17 a 20/11?', enviado_em: '2026-10-19T13:00:00Z' },
    { id: 'm2', wa_id: ANA, autor: 'robo', texto: 'Casa Azul livre, R$ 1.650', enviado_em: '2026-10-19T13:00:05Z' },
    { id: 'm3', wa_id: ANA, autor: 'cliente', texto: 'Qual a senha do wifi e a chave pix?', enviado_em: '2026-10-19T14:50:00Z' },
  ],
  app_config: [{ key: 'wa_base', value: JSON.stringify(BASE) }],
  ...x,
});
const chamar = (corpo, auth = 'usuario') => fn(pedido('/wa-responder', { corpo, auth })).then(lerJson);
const responderIA = x => { globalThis.__anthropic = { chamadas: [], responder: typeof x === 'function' ? x : () => x }; };

before(async () => { fn = await carregarFuncao('wa-responder', ENV); });
beforeEach(() => { limparRede(); for (const [k, v] of Object.entries(ENV)) definirEnv(k, v); });

describe('wa-responder: acesso', () => {
  test('só com o login (nem anônimo, nem sem nada)', async () => {
    novoBanco(DADOS());
    for (const auth of [null, 'anon', 'invalido']) assert.equal((await chamar({ acao: 'enviar', wa_id: ANA, texto: 'x' }, auth)).status, 401);
  });
  test('conversa inexistente: 404; ação desconhecida: 400', async () => {
    novoBanco(DADOS());
    assert.equal((await chamar({ acao: 'enviar', wa_id: '999', texto: 'x' })).status, 404);
    assert.equal((await chamar({ acao: 'apagar', wa_id: ANA })).status, 400);
  });
});

describe('wa-responder: enviar', () => {
  test('manda pela Z-API (sem "digitando"), grava como sua, silencia o robô e atualiza a oportunidade', async () => {
    novoBanco(DADOS());
    simular(ZAPI, { messageId: 'Z-hub-1' });
    const { status, corpo } = await chamar({ acao: 'enviar', wa_id: ANA, texto: '  A chave é pix@casas.com  ' });
    assert.deepEqual([status, corpo], [200, { ok: true, wamid: 'Z-hub-1' }]);
    const env = chamadasPara(ZAPI)[0];
    assert.equal(env.headers['client-token'], 'cli1');
    assert.deepEqual(env.json(), { phone: ANA, message: 'A chave é pix@casas.com' });
    const m = banco().t('wa_messages').at(-1);
    assert.deepEqual([m.wamid, m.autor, m.direcao, m.texto, m.deal_id], ['Z-hub-1', 'claudio', 'out', 'A chave é pix@casas.com', 'd1']);
    assert.equal(banco().t('wa_contacts')[0].ultima_manual, '2026-10-19T15:00:00.000Z');
    assert.deepEqual([banco().t('deals')[0].proxima_acao, banco().t('deals')[0].data_proxima_acao], ['Aguardar resposta do cliente', '2026-10-21']);
  });
  test('Z-API recusou: 502 com explicação e nada gravado', async () => {
    novoBanco(DADOS());
    simular(ZAPI, { status: 400, json: { error: 'NOT_CONNECTED' } });
    const { status, corpo } = await chamar({ acao: 'enviar', wa_id: ANA, texto: 'oi' });
    assert.equal(status, 502);
    assert.match(corpo.error, /conectado/);
    assert.equal(banco().t('wa_messages').length, 3);
  });
  test('mensagem vazia ou longa demais: 400', async () => {
    novoBanco(DADOS());
    assert.equal((await chamar({ acao: 'enviar', wa_id: ANA, texto: '   ' })).status, 400);
    assert.equal((await chamar({ acao: 'enviar', wa_id: ANA, texto: 'x'.repeat(4001) })).status, 400);
    assert.equal(chamadasPara(ZAPI).length, 0);
  });
});

describe('wa-responder: rascunho da IA', () => {
  test('a IA recebe a conversa, a base (com Wi-Fi e Pix) e os valores da oportunidade; devolve texto e o que faltou', async () => {
    novoBanco(DADOS());
    responderIA({ texto: 'A senha do Wi-Fi é segredo123 e a chave Pix é pix@casas.com.', faltou: [] });
    const { status, corpo } = await chamar({ acao: 'rascunho', wa_id: ANA });
    assert.deepEqual([status, corpo.faltou], [200, []]);
    const p = globalThis.__anthropic.chamadas[0];
    assert.equal(p.model, 'claude-haiku-5-5');
    assert.match(p.system, /Wi-Fi \(senha\): segredo123/);
    assert.match(p.system, /Casa Azul \(QS40\):\n  Link da localização: https:\/\/maps\.app\.goo\.gl\/azul/);
    assert.match(p.system, /Chave Pix: pix@casas\.com \(Claudio\)/);
    assert.match(p.system, /Valor total combinado: R\$ 1\.650,00\nSinal \(50%\): R\$ 825,00\nJá recebido: R\$ 300,00; falta R\$ 1\.350,00/);
    assert.match(p.system, /NÃO comece com "Olá"/, 'o robô respondeu há menos de 24 h');
    assert.match(p.messages[0].content, /Cliente: Tem vaga.*\nRobô: Casa Azul.*\nCliente: Qual a senha/);
  });
  test('começo de conversa: pode cumprimentar', async () => {
    novoBanco(DADOS({ wa_messages: [{ id: 'm1', wa_id: ANA, autor: 'cliente', texto: 'Oi, tudo bem?', enviado_em: '2026-10-19T14:50:00Z' }] }));
    responderIA({ texto: 'Olá!', faltou: [] });
    await chamar({ acao: 'rascunho', wa_id: ANA });
    assert.match(globalThis.__anthropic.chamadas[0].system, /pode cumprimentar brevemente/);
  });
  test('IA fora do ar: 500 com a mensagem', async () => {
    novoBanco(DADOS());
    responderIA(() => { throw new Error('overloaded'); });
    const { status, corpo } = await chamar({ acao: 'rascunho', wa_id: ANA });
    assert.deepEqual([status, corpo.error], [500, 'overloaded']);
  });
});
