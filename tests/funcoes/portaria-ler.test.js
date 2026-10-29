// Edge Function portaria-ler: print/foto de documento → hóspedes, veículos, casa e datas (Claude Haiku), só com o login.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, definirEnv } from '../helpers/funcao.js';
import { novoBanco } from '../helpers/fake-supabase.js';

let fn;
const ENV = { ANTHROPIC_API_KEY: 'sk-teste' };
const CASAS = [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }, { id: 'QS50', nome: 'Casa Terracota' }];
const PRINT = { mime: 'image/png', base64: 'iVBORw0KGgo=' };
const chamar = (corpo, auth = 'usuario') => fn(pedido('/portaria-ler', { corpo, auth })).then(lerJson);
const responderIA = x => { globalThis.__anthropic = { chamadas: [], responder: typeof x === 'function' ? x : () => x }; };
const LEITURA = (x = {}) => ({ hospedes: [], veiculos: [], casa: '', checkin: '', checkout: '', avisos: [], ...x });

before(async () => { fn = await carregarFuncao('portaria-ler', ENV); });
beforeEach(() => { novoBanco({ properties: CASAS }); definirEnv('ANTHROPIC_API_KEY', 'sk-teste'); responderIA(LEITURA()); });

describe('portaria-ler: acesso e validação', () => {
  test('só com o login (nem anônimo, nem sem nada)', async () => {
    for (const auth of [null, 'anon', 'invalido']) assert.equal((await chamar({ arquivos: [PRINT] }, auth)).status, 401);
  });
  test('sem chave da Anthropic: 500 com aviso', async () => {
    definirEnv('ANTHROPIC_API_KEY', undefined);
    assert.deepEqual(await chamar({ arquivos: [PRINT] }), { status: 500, corpo: { error: 'chave da Anthropic não cadastrada' } });
  });
  test('arquivos: nenhum, demais, vazio, tipo errado ou grande demais', async () => {
    assert.match((await chamar({})).corpo.error, /nenhum arquivo/);
    assert.match((await chamar({ arquivos: Array(7).fill(PRINT) })).corpo.error, /no máximo 6/);
    assert.match((await chamar({ arquivos: [{ mime: 'image/png', base64: '' }] })).corpo.error, /arquivo vazio/);
    assert.match((await chamar({ arquivos: [{ mime: 'image/heic', base64: 'x' }] })).corpo.error, /image\/heic/);
    assert.match((await chamar({ arquivos: [{ mime: 'image/jpeg', base64: 'a'.repeat(6_800_001) }] })).corpo.error, /grande demais/);
    assert.equal(globalThis.__anthropic.chamadas.length, 0);
  });
});

describe('portaria-ler: leitura', () => {
  test('manda imagens e PDF para o Haiku com a lista das casas e devolve o que ele leu', async () => {
    responderIA(LEITURA({
      hospedes: [{ nome: ' Mauricio Batista da Silva Júnior ', documento: 'CPF 433.935.708-11' }, { nome: 'Luiz Antônio da Silva', documento: 'RG 2392336 SDS/PE' }, { nome: '', documento: '' }],
      veiculos: [{ modelo: 'Honda HRV', placa: 'tzx-3d00' }, { modelo: 'moto', placa: '' }],
      casa: 'QS39', checkin: '2026-10-16', checkout: '2026-10-21', avisos: ['RG do Luiz cortado no print', ' '],
    }));
    const { status, corpo } = await chamar({ arquivos: [PRINT, { mime: 'application/pdf', base64: 'JVBERi0=' }] });
    assert.equal(status, 200);
    assert.deepEqual(corpo, {
      hospedes: [{ nome: 'Mauricio Batista da Silva Júnior', documento: 'CPF 433.935.708-11' }, { nome: 'Luiz Antônio da Silva', documento: 'RG 2392336 SDS/PE' }],
      veiculos: [{ modelo: 'Honda HRV', placa: 'TZX3D00' }],
      casa: 'QS39', checkin: '2026-10-16', checkout: '2026-10-21', avisos: ['RG do Luiz cortado no print'],
    });
    const p = globalThis.__anthropic.chamadas[0];
    assert.equal(p.model, 'claude-haiku-5-5');
    assert.deepEqual(p.messages[0].content.map(c => c.type), ['image', 'document', 'text']);
    assert.deepEqual(p.messages[0].content[0].source, { type: 'base64', media_type: 'image/png', data: PRINT.base64 });
    assert.match(p.system, /QS39: Casa Frida QS39 \(também chamada de "Casa Frida", "Casa 39" ou "QS39"\)/);
    assert.match(p.system, /Não invente nada/);
    assert.match(p.system, /hoje \(2026-10-19\)/);
  });
  test('casa fora do cadastro, data inválida e saída antes da entrada viram ""', async () => {
    responderIA(LEITURA({ casa: 'Casa 39', checkin: '16/10/2026', checkout: '2026-10-10' }));
    const { corpo } = await chamar({ arquivos: [PRINT] });
    assert.deepEqual([corpo.casa, corpo.checkin, corpo.checkout], ['', '', '2026-10-10']);
    responderIA(LEITURA({ casa: 'QS40', checkin: '2026-11-20', checkout: '2026-11-18' }));
    const r = (await chamar({ arquivos: [PRINT] })).corpo;
    assert.deepEqual([r.casa, r.checkin, r.checkout], ['QS40', '2026-11-20', '']);
  });
  test('IA sem resposta: 500 com o motivo', async () => {
    responderIA(null);
    const { status, corpo } = await chamar({ arquivos: [PRINT] });
    assert.equal(status, 500);
    assert.match(corpo.error, /a IA não conseguiu ler/);
  });
});
