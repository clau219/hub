// Edge Function wa-dono: resumo do dia no WhatsApp do dono (7h30 e 18h pelo cron, ou o botão em Ajustes).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

const ENV = { ZAPI_INSTANCE: 'INST1', ZAPI_TOKEN: 'tok1', ZAPI_CLIENT_TOKEN: 'cli1' };
const DONO = '5584996011991';
const ZURL = /api\.z-api\.io\/instances\/INST1\/token\/tok1\/send-text/;
const HOJE = '2026-10-19', AMANHA = '2026-10-20';
const DADOS = (x = {}, cfg = {}) => comCron({
  properties: [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }],
  wa_settings: [{ id: 1, dono_wa: DONO, dono_resumo: true, ...cfg }],
  deals: [
    { id: 'g1', titulo: 'DJ — Júlia', negocio: 'dj', etapa: 'fechado', data_evento: AMANHA, hora_inicio: '22:00:00', valor: 3000, pagamentos: [{ valor: 3000 }], proxima_acao: 'Confirmar', data_proxima_acao: '2026-10-25' },
    { id: 'd1', titulo: 'DJ — Marcos', negocio: 'dj', etapa: 'realizado', data_evento: '2026-10-10', valor: 2000, pagamentos: [{ valor: 500 }], proxima_acao: 'Cobrar pagamento', data_proxima_acao: HOJE },
  ],
  tasks: [{ id: 't1', titulo: 'Pagar IPTU', feito: false, prazo: HOJE }, { id: 't2', titulo: 'Comprar cabo', feito: false, prazo: AMANHA }],
  bookings: [{ id: 'b1', property_id: 'QS40', checkin: AMANHA, checkout: '2026-10-23', hospede: 'Lia', status: 'confirmada', origem: 'direto' }],
  ...x,
});
const resumo = (corpo, auth = 'cron') => fn(pedido('/wa-dono', { corpo, auth })).then(lerJson);

let fn;
before(async () => { fn = await carregarFuncao('wa-dono', ENV); });
beforeEach(() => {
  limparRede();
  for (const [k, v] of Object.entries(ENV)) definirEnv(k, v);
  simular(ZURL, { messageId: 'ZR1' });
});

describe('wa-dono: resumo do dia', () => {
  test('sem credencial: 401', async () => {
    novoBanco(DADOS());
    assert.equal((await resumo({}, null)).status, 401);
  });
  test('manhã: pendências com atraso e o que falta receber, mandado para o número do dono', async () => {
    novoBanco(DADOS());
    const { corpo } = await resumo({ resumo: 'manha' });
    assert.equal(corpo.enviado, true);
    const z = chamadasPara(ZURL)[0].json();
    assert.equal(z.phone, DONO);
    assert.match(z.message, /Segunda, 19\/10/);
    assert.match(z.message, /DJ — Marcos: Cobrar pagamento/);
    assert.match(z.message, /Tarefa: Pagar IPTU/);
    assert.doesNotMatch(z.message, /Comprar cabo/, 'tarefa de amanhã não entra na manhã de hoje');
    assert.match(z.message, /A receber: R\$ 1\.500 \(1\)[\s\S]*Marcos: R\$ 1\.500 · evento foi 10\/10/);
    assert.equal(banco().t('dono_msgs')[0].direcao, 'out');
  });
  test('noite: agenda e casas de amanhã, tarefa com prazo amanhã e quantas pendências ficaram abertas', async () => {
    novoBanco(DADOS());
    const { corpo } = await resumo({ resumo: 'noite' });
    assert.match(corpo.texto, /Amanhã, terça, 20\/10/);
    assert.match(corpo.texto, /22:00 DJ — Júlia/);
    assert.match(corpo.texto, /Tarefa: Comprar cabo/);
    assert.match(corpo.texto, /Entra: Casa Azul — Lia \(até 23\/10\)/);
    assert.match(corpo.texto, /Ficou aberto hoje: 2 pendências/);
  });
  test('dia vazio: mensagem curta', async () => {
    novoBanco(DADOS({ deals: [], tasks: [], bookings: [] }));
    assert.match((await resumo({ resumo: 'manha', previa: true })).corpo.texto, /Dia livre/);
  });
  test('prévia devolve o texto sem enviar', async () => {
    novoBanco(DADOS());
    const { corpo } = await resumo({ resumo: 'manha', previa: true }, 'usuario');
    assert.equal(corpo.enviado, false);
    assert.ok(corpo.texto);
    assert.equal(chamadasPara(ZURL).length, 0);
  });
  test('resumo automático desligado: o cron não manda, o botão (usuário) manda', async () => {
    novoBanco(DADOS({}, { dono_resumo: false }));
    assert.match((await resumo({ resumo: 'manha' })).corpo.motivo, /desligado/);
    assert.equal(chamadasPara(ZURL).length, 0);
    assert.equal((await resumo({ resumo: 'manha' }, 'usuario')).corpo.enviado, true);
  });
  test('sem número do dono: não manda e explica', async () => {
    novoBanco(DADOS({}, { dono_wa: null }));
    assert.match((await resumo({ resumo: 'manha' })).corpo.motivo, /número do dono/);
  });
  test('Z-API falhou: enviado false, nada gravado', async () => {
    novoBanco(DADOS());
    simular(ZURL, { status: 500, json: { error: 'desconectado' } });
    const { corpo } = await resumo({ resumo: 'manha' });
    assert.equal(corpo.enviado, false);
    assert.equal(banco().t('dono_msgs').length, 0);
  });
});
