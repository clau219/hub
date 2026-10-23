// Tela Ajustes: links iCal, feeds para o Airbnb/Google, Google Agenda, robô do WhatsApp, notificações e backup.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, clicar, preencher, enviarModal, esperar, ate } from '../helpers/dom.js';
import { abrirHub, trocarDados, CASAS } from '../helpers/tela.js';
import { banco } from '../helpers/fake-supabase.js';

let V, S, el;
const FN = 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1';
const DADOS = () => ({
  properties: CASAS,
  calendar_sources: [{ id: 's1', nome: 'Airbnb Frida', calendario: 'alugueis', tipo: 'airbnb', property_id: 'QS39', ultimo_sync: '2026-10-19T12:00:00Z', url: 'https://x' }],
  app_config: [
    { key: 'feed_token', value: 'tok123' },
    { key: 'gcal_status', value: JSON.stringify({ em: '2026-10-19T12:00:00Z', total: 10, criados: 1, alterados: 2, apagados: 0 }) },
    { key: 'ical_status', value: JSON.stringify({ em: '2026-10-19T12:00:00Z', erros: ['Casa Azul: 404'] }) },
  ],
  wa_settings: [{ id: 1, bot_ativo: true, horas_silencio: 12, max_respostas_dia: 4 }],
  wa_messages: [{ id: 'm1', autor: 'cliente', enviado_em: '2026-10-18T20:00:00Z' }],
});
const abrir = async () => { await V.render(el); await ate(() => $('#waCfg input') || /ainda não criadas/.test(texto('#waCfg')), { msg: 'bloco do WhatsApp' }); };
before(async () => {
  ({ S } = await abrirHub({ supabase: true, tabelas: DADOS() }));
  V = await hub('v-ajustes.js');
  el = $('#view');
});
beforeEach(async () => { $('#modal').open && $('#modal').close(); await trocarDados(DADOS(), { supabase: true }); await abrir(); });

describe('Ajustes', () => {
  test('conexão com o Supabase e botão Sair', () => {
    assert.match(texto('#view .block'), /Sincronizado com o Supabase/);
    assert.ok($('#logout'));
  });
  test('links iCal com última leitura e o erro da última leitura', () => {
    const tr = $$('#view table tbody tr')[0];
    assert.deepEqual([...tr.cells].slice(0, 5).map(texto), ['Airbnb Frida', 'Aluguéis', 'airbnb', 'QS39', '19 out']);
    assert.match(texto('#view'), /Problema na última leitura \(19 out\): Casa Azul: 404/);
  });
  test('feeds das reservas diretas por casa, com o token', () => {
    const codes = $$('code.sel').map(texto);
    assert.ok(codes.includes(`${FN}/ical-feed?cal=diretas&casa=QS39&token=tok123`));
    assert.ok(codes.includes(`${FN}/ical-feed?cal=diretas&casa=QS50&token=tok123`));
    assert.ok(codes.includes(`${FN}/ical-feed?cal=alugueis&token=tok123`));
    assert.ok(codes.includes(`${FN}/wa-webhook`));
  });
  test('status do Google Agenda', () => {
    assert.match(texto('#view'), /Última sincronização 19 out: 10 no Google \(1 criados, 2 alterados, 0 apagados\)/);
  });
  test('adicionar link do Airbnb exige a casa e força o calendário Aluguéis', async () => {
    await clicar('#srcNew');
    preencher($('#modal'), { nome: 'Airbnb Azul', tipo: 'airbnb', calendario: 'dj', url: 'https://www.airbnb.com/calendar/ical/1.ics' });
    await enviarModal();
    assert.match(texto('#modalErr'), /Escolha a casa/);
    preencher($('#modal'), { property_id: 'QS40' });
    await enviarModal();
    const s = S.calendar_sources.find(x => x.nome === 'Airbnb Azul');
    assert.deepEqual({ cal: s.calendario, casa: s.property_id }, { cal: 'alugueis', casa: 'QS40' });
  });
  test('remover link em 2 cliques', async () => {
    await clicar('[data-del=s1]'); await clicar('[data-del=s1]');
    assert.equal(S.calendar_sources.length, 0);
  });
  test('"Ler agora" chama o ical-sync e recarrega', async () => {
    banco().funcoes['ical-sync'] = () => ({ eventos: 3, reservas: 2 });
    await clicar('#syncNow', 10);
    assert.equal(texto('#toast'), 'Leitura concluída: 3 eventos, 2 reservas');
  });
  test('"Ler agora" com falha reabilita o botão', async () => {
    banco().funcoes['ical-sync'] = () => { throw new Error('500'); };
    await clicar('#syncNow', 10);
    assert.equal(texto('#toast'), 'Falha na leitura: 500');
    assert.equal($('#syncNow').disabled, false);
  });
  test('"Sincronizar agora" do Google Agenda', async () => {
    banco().funcoes['gcal-sync'] = () => ({ criados: 1, alterados: 0, apagados: 2 });
    await clicar('#gcalNow', 10);
    assert.equal(texto('#toast'), 'Google Agenda em dia: 1 criados, 0 alterados, 2 apagados');
  });
  test('robô do WhatsApp: liga/desliga e limites saneados', async () => {
    assert.match(texto('#waCfg'), /Última mensagem recebida: 18 out/);
    const bot = $('#waCfg [name=bot_ativo]');
    bot.checked = false; bot.dispatchEvent(new Event('change'));
    await esperar(5);
    assert.equal(banco().t('wa_settings')[0].bot_ativo, false);
    assert.equal(texto('#toast'), 'Robô desligado');
    const h = $('#waCfg [name=horas_silencio]');
    h.value = '999'; h.dispatchEvent(new Event('change'));
    await esperar(5);
    assert.equal(banco().t('wa_settings')[0].horas_silencio, 168);
    const m = $('#waCfg [name=max_respostas_dia]');
    m.value = '0'; m.dispatchEvent(new Event('change'));
    await esperar(5);
    assert.equal(banco().t('wa_settings')[0].max_respostas_dia, 1);
  });
  test('sem tabelas do WhatsApp avisa qual SQL rodar', async () => {
    await trocarDados({ ...DADOS(), wa_settings: [] }, { supabase: true });
    await abrir();
    assert.match(texto('#waCfg'), /2026-10-15_whatsapp\.sql/);
  });
  test('canal do dono: sem a coluna avisa o SQL; número salvo com 55, inválido recusado, vazio desliga', async () => {
    assert.match(texto('#waCfg'), /2026-10-23_dono\.sql/);
    await trocarDados({ ...DADOS(), wa_settings: [{ id: 1, bot_ativo: true, horas_silencio: 12, max_respostas_dia: 4, dono_wa: null, dono_resumo: true }] }, { supabase: true });
    await abrir();
    assert.equal($('#donoResumo').disabled, true);
    const n = $('#waCfg [name=dono_wa]');
    n.value = '(84) 99601-1991'; n.dispatchEvent(new Event('change'));
    await esperar(5);
    assert.equal(banco().t('wa_settings')[0].dono_wa, '5584996011991');
    assert.equal(n.value, '(84) 99601-1991');
    assert.match(texto('#toast'), /Canal do dono ligado/);
    assert.equal($('#donoResumo').disabled, false);
    n.value = '9960'; n.dispatchEvent(new Event('change'));
    await esperar(5);
    assert.equal(banco().t('wa_settings')[0].dono_wa, '5584996011991');
    assert.match(texto('#toast'), /Número incompleto/);
    n.value = ''; n.dispatchEvent(new Event('change'));
    await esperar(5);
    assert.equal(banco().t('wa_settings')[0].dono_wa, null);
    assert.equal(texto('#toast'), 'Canal do dono desligado');
  });
  test('canal do dono: resumo liga/desliga e "Mandar resumo agora" chama a wa-dono', async () => {
    await trocarDados({ ...DADOS(), wa_settings: [{ id: 1, bot_ativo: true, horas_silencio: 12, max_respostas_dia: 4, dono_wa: '5584996011991', dono_resumo: true }] }, { supabase: true });
    await abrir();
    assert.equal($('#waCfg [name=dono_wa]').value, '(84) 99601-1991');
    const r = $('#waCfg [name=dono_resumo]');
    r.checked = false; r.dispatchEvent(new Event('change'));
    await esperar(5);
    assert.equal(banco().t('wa_settings')[0].dono_resumo, false);
    let corpo;
    banco().funcoes['wa-dono'] = b => { corpo = b; return { enviado: true }; };
    await clicar('#donoResumo', 10);
    assert.deepEqual(corpo, { resumo: 'manha' });
    assert.equal(texto('#toast'), 'Resumo enviado no seu WhatsApp');
    banco().funcoes['wa-dono'] = () => ({ enviado: false, motivo: 'Z-API não configurada' });
    await clicar('#donoResumo', 10);
    assert.equal(texto('#toast'), 'Não foi possível mandar: Z-API não configurada');
  });
  test('notificações: mostra o estado mesmo sem service worker', () => {
    const b = $$('#view section.block').find(s => /Notificações/.test(s.textContent));
    assert.match(texto(b), /Este navegador não aceita notificações push\.|Desativadas neste aparelho\.|Ativas neste aparelho\./);
  });
  test('backup baixa um .json com todas as tabelas', async () => {
    let blob = null, nome = '';
    URL.createObjectURL = b => { blob = b; return 'blob:x'; };
    URL.revokeObjectURL = () => {};
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { nome = this.download; };
    await clicar('#exp');
    HTMLAnchorElement.prototype.click = click;
    assert.equal(nome, 'hub-backup-2026-10-19.json');
    const j = JSON.parse(await blob.text());
    assert.ok(['contacts', 'deals', 'bookings', 'crypto_tx'].every(t => Array.isArray(j[t])));
    assert.equal(j.calendar_sources[0].nome, 'Airbnb Frida');
  });
  test('importar backup junta no banco e recarrega', async () => {
    const inp = $('#imp');
    Object.defineProperty(inp, 'files', { value: [{ text: async () => JSON.stringify({ contacts: [{ id: 'cx', nome: 'Importado' }] }) }], configurable: true });
    inp.dispatchEvent(new Event('change'));
    await ate(() => S.contacts.some(c => c.nome === 'Importado'), { msg: 'importação' });
    assert.equal(texto('#toast'), 'Importação concluída');
  });
  test('importar arquivo inválido avisa', async () => {
    const inp = $('#imp');
    Object.defineProperty(inp, 'files', { value: [{ text: async () => 'não é json' }], configurable: true });
    inp.dispatchEvent(new Event('change'));
    await ate(() => /Falha ao importar/.test(texto('#toast')), { msg: 'aviso de falha' });
  });
  test('Sair encerra a sessão e apaga a cópia offline', async () => {
    localStorage.setItem('hub:snap', '{}');
    let recarregou = false;
    const orig = location.reload;
    try { Object.defineProperty(location, 'reload', { value: () => (recarregou = true), configurable: true }); } catch {}
    await clicar('#logout', 10);
    assert.equal(banco().sessao, null);
    assert.equal(localStorage.getItem('hub:snap'), null);
    try { Object.defineProperty(location, 'reload', { value: orig, configurable: true }); } catch {}
  });
});
