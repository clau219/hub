// Tela WhatsApp: conversas que chegaram pela wa-webhook, quem está esperando resposta, o que o robô fez em cada
// mensagem (respondeu ou por que ficou quieto), liga/desliga do robô e pausa por pessoa.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, textoSep, ate, esperar } from '../helpers/dom.js';
import { abrirHub, trocarDados } from '../helpers/tela.js';
import { banco } from '../helpers/fake-supabase.js';

let V, el;
const ANA = '5584991118864', BIA = '5584988887777';
const dados = (x = {}) => ({
  contacts: [{ id: 'c1', nome: 'Ana Lima', telefone: '(84) 99111-8864' }],
  deals: [{ id: 'd1', titulo: 'Aluguéis — Ana Lima', negocio: 'aluguel', etapa: 'orcamento', contato_id: 'c1' }],
  wa_settings: [{ id: 1, bot_ativo: false, horas_silencio: 12, max_respostas_dia: 4 }],
  wa_contacts: [
    { wa_id: ANA, nome: 'Ana Lima', contato_id: 'c1', deal_id: 'd1', bot_pausado: false },
    { wa_id: BIA, nome: 'Bia', bot_pausado: true, ultima_manual: '2026-10-19T14:30:00Z' },
    { wa_id: '5584900000000', nome: 'Sem mensagens' },
  ],
  wa_messages: [
    { id: 'm1', wa_id: ANA, deal_id: 'd1', direcao: 'in', autor: 'cliente', tipo: 'text', texto: 'Tem vaga 17 a 20/11 para 6?', enviado_em: '2026-10-18T13:00:00Z',
      extracao: { assunto: 'disponibilidade_preco', casa: 'QS40', checkin: '2026-11-17', checkout: '2026-11-20', hospedes: 6, datas_exatas: true, robo: 'respondeu' } },
    { id: 'm2', wa_id: ANA, deal_id: 'd1', direcao: 'out', autor: 'robo', tipo: 'text', texto: 'Casa Azul: disponível, R$ 1.650', enviado_em: '2026-10-18T13:00:05Z' },
    { id: 'm3', wa_id: ANA, deal_id: 'd1', direcao: 'in', autor: 'cliente', tipo: 'text', texto: 'Pode mandar o pix?', enviado_em: '2026-10-19T14:50:00Z',
      extracao: { assunto: 'confirmar_reserva', casa: 'qualquer', robo: 'robô desligado em Ajustes' } },
    { id: 'm4', wa_id: BIA, direcao: 'in', autor: 'cliente', tipo: 'text', texto: 'oi', enviado_em: '2026-10-19T14:00:00Z' },
    { id: 'm5', wa_id: BIA, direcao: 'out', autor: 'claudio', tipo: 'text', texto: 'Olá Bia!', enviado_em: '2026-10-19T14:30:00Z' },
  ],
  ...x,
});
// A tela guarda a leitura por 10 s: avança o relógio para ela reler o banco
const abrir = async (hash = '#/whatsapp') => {
  globalThis.__relogio.avancar(11e3);
  const n = banco().consultas.length;
  location.hash = hash; V.render(el);
  await ate(() => banco().consultas.slice(n).some(c => c.tabela === 'wa_settings'), { msg: 'leitura do banco' });
  await esperar(10);
};
const nomes = () => $$('.wz-item b').map(texto);

before(async () => {
  await abrirHub({ supabase: true, tabelas: dados() });
  V = await hub('v-whatsapp.js');
  el = $('#view');
});

describe('WhatsApp: lista de conversas', () => {
  before(async () => { await trocarDados(dados(), { supabase: true }); await abrir(); });
  test('mais recente primeiro; contato sem mensagens não aparece', () => {
    assert.deepEqual(nomes(), ['Ana Lima', 'Bia']);
  });
  test('quem mandou a última mensagem: "Esperando você" só quando foi o cliente', () => {
    const [ana, bia] = $$('.wz-item');
    assert.ok(ana.classList.contains('esperando'));
    assert.match(texto(ana), /Pode mandar o pix\?.*Esperando você/);
    assert.ok(!bia.classList.contains('esperando'));
    assert.match(texto(bia), /Você: Olá Bia!.*Robô pausado/);
    assert.match(texto('[data-f=esperando]'), /Esperando você 1/);
  });
  test('robô desligado aparece no topo, com aviso', () => {
    assert.match(texto('.wz-robo'), /Robô desligado/);
    assert.match(texto('.wz-aviso'), /ninguém recebe resposta automática/);
  });
  test('filtro "Esperando você"', async () => {
    $('[data-f=esperando]').click(); await esperar();
    assert.deepEqual(nomes(), ['Ana Lima']);
    $('[data-f=todas]').click(); await esperar();
  });
});

describe('WhatsApp: conversa aberta', () => {
  before(async () => { await trocarDados(dados(), { supabase: true }); await abrir(); $(`[data-c="${ANA}"]`).click(); await esperar(); });
  test('mensagens em ordem, com dia, autor e hora', () => {
    assert.deepEqual($$('.wz-dia').map(texto), ['18 out', 'Hoje']);
    assert.deepEqual($$('.wz-msg small').map(texto), ['Cliente · 10:00', 'Robô · 10:00', 'Cliente · 11:50']);
  });
  test('o que o robô fez e o que a IA entendeu, em cada mensagem do cliente', () => {
    const ia = $$('.wz-ia').map(textoSep);
    assert.equal(ia[0], 'Robô respondeu IA: Disponibilidade e valor · Casa Azul · 17/11 a 20/11 · 6 pessoas');
    assert.equal(ia[1], 'Robô quieto: robô desligado em Ajustes IA: Quer reservar / pagar');
  });
  test('cabeçalho: telefone, oportunidade e link do WhatsApp', () => {
    assert.match(textoSep($('.wz-conv-quem')), /Ana Lima \(84\) 99111-8864/);
    assert.ok($('#wzDeal'));
    assert.equal($('.wz-conv-head a.wa').getAttribute('href'), `https://wa.me/${ANA}`);
  });
  test('pausar o robô só com esta pessoa grava no banco', async () => {
    const p = $('#wzPausa'); p.checked = true; p.dispatchEvent(new Event('change')); await esperar(10);
    assert.equal(banco().t('wa_contacts').find(c => c.wa_id === ANA).bot_pausado, true);
    assert.match(texto('.wz-item.on'), /Robô pausado/);
  });
  test('"Liberar robô agora" apaga o silêncio depois da sua resposta', async () => {
    const d = dados(); d.wa_contacts[1].bot_pausado = false; await trocarDados(d, { supabase: true });
    await abrir(`#/whatsapp?c=${BIA}`);
    assert.match(texto('.wz-conv-sub'), /Robô quieto até 23:30/);
    $('#wzLiberar').click(); await esperar(10);
    assert.equal(banco().t('wa_contacts').find(c => c.wa_id === BIA).ultima_manual, null);
    assert.ok(!$('#wzLiberar'));
    assert.doesNotMatch(texto('.wz-conv-sub'), /Robô quieto/);
  });
  test('link direto #/whatsapp?c= abre a conversa', async () => {
    await abrir(`#/whatsapp?c=${BIA}`);
    assert.match(texto('.wz-conv-quem'), /Bia/);
    assert.ok(!$('#wzDeal'), 'sem oportunidade, sem botão');
  });
});

describe('WhatsApp: robô e atualização', () => {
  before(async () => { await trocarDados(dados(), { supabase: true }); await abrir('#/whatsapp'); });
  test('ligar o robô pelo topo grava em wa_settings', async () => {
    const b = $('#wzBot'); b.checked = true; b.dispatchEvent(new Event('change')); await esperar(10);
    assert.equal(banco().t('wa_settings')[0].bot_ativo, true);
    assert.match(texto('.wz-robo'), /Robô ligado/);
    assert.ok(!$('.wz-aviso'));
  });
  test('mensagem nova aparece ao recarregar (a tela relê o banco sozinha)', async () => {
    banco().t('wa_messages').push({ id: 'm9', wa_id: BIA, direcao: 'in', autor: 'cliente', tipo: 'audio', texto: '[audio]', enviado_em: '2026-10-19T14:59:00Z' });
    await abrir('#/whatsapp');
    assert.deepEqual(nomes(), ['Bia', 'Ana Lima']);
    assert.match(texto('.wz-item'), /\[audio\]/);
  });
  test('conversa identificada por LID: sem link do WhatsApp e telefone "oculto"', async () => {
    const d = dados();
    d.wa_contacts.push({ wa_id: '1701@lid', nome: null });
    d.wa_messages.push({ id: 'mx', wa_id: '1701@lid', direcao: 'out', autor: 'claudio', tipo: 'text', texto: 'Oi', enviado_em: '2026-10-19T14:58:00Z' });
    await trocarDados(d, { supabase: true });
    await abrir('#/whatsapp?c=1701@lid');
    assert.match(texto('.wz-conv-quem'), /número oculto pelo WhatsApp/);
    assert.ok(!$('.wz-conv-head a.wa'));
  });
});

describe('WhatsApp: conexão da Z-API e número no menu', () => {
  test('Z-API desconectada: faixa vermelha com o motivo e link para a Z-API', async () => {
    await trocarDados(dados({ app_config: [{ key: 'zapi_status', value: JSON.stringify({ ok: false, motivo: 'O celular das casas não está conectado à Z-API', desde: '2026-10-19T14:10:00Z', em: '2026-10-19T14:55:00Z' }) }] }), { supabase: true });
    await abrir();
    assert.match(texto('.wz-caiu'), /WhatsApp das casas desconectado desde 11:10: O celular das casas não está conectado/);
    assert.equal($('.wz-caiu a').getAttribute('href'), 'https://app.z-api.io/app/instances');
    assert.ok(!$('.wz-con'));
  });
  test('conectada: selo verde discreto com a hora da última verificação', async () => {
    await trocarDados(dados({ app_config: [{ key: 'zapi_status', value: JSON.stringify({ ok: true, em: '2026-10-19T14:55:00Z' }) }] }), { supabase: true });
    await abrir();
    assert.ok(!$('.wz-caiu'));
    assert.match(texto('.wz-con'), /Z-API conectada · 11:55/);
  });
  test('menu mostra quantas pessoas esperam resposta (some quando ninguém espera)', async () => {
    await trocarDados(dados(), { supabase: true });
    await abrir();
    const selos = $$('a[data-route="whatsapp"] .selo');
    assert.ok(selos.length >= 1);
    assert.ok(selos.every(s => texto(s) === '1' && !s.hidden));
    const d = dados(); d.wa_messages.push({ id: 'm9', wa_id: ANA, autor: 'claudio', direcao: 'out', tipo: 'text', texto: 'Mando sim', enviado_em: '2026-10-19T14:58:00Z' });
    await trocarDados(d, { supabase: true });
    await abrir();
    assert.ok($$('a[data-route="whatsapp"] .selo').every(s => s.hidden));
  });
  test('selo() do app consulta o banco no máximo 1x por minuto', async () => {
    await trocarDados(dados(), { supabase: true });
    globalThis.__relogio.avancar(61e3);
    const n = () => banco().consultas.filter(c => c.tabela === 'wa_messages').length;
    const a = n(); await V.selo(); await V.selo(); await esperar(5);
    assert.equal(n() - a, 1);
  });
});

// ---------- responder pelo Hub ----------
const BASE = { geral: { pix_chave: '12.345.678/0001-90', pix_nome: 'Claudio Braga', sinal_pct: '50', endereco: 'Cond. Pipa Natureza, casa 39', localizacao: 'https://maps.app.goo.gl/x', checkin: '14h', checkout: '11h', pets: 'Aceitamos pet pequeno.', regras: 'Sem festas.' } };
const comBase = (x = {}) => {
  const d = dados(x);
  d.app_config = [...(d.app_config || []), { key: 'wa_base', value: JSON.stringify(BASE) }];
  d.deals[0] = { ...d.deals[0], valor: 1650, pagamentos: [] };
  d.bookings = [{ id: 'b1', property_id: 'QS40', hospede: 'Ana Lima Souza', checkin: '2026-11-17', checkout: '2026-11-20', valor: 1650, status: 'confirmada' }, { id: 'b2', property_id: 'QS39', hospede: 'Anabela', checkin: '2026-12-01', checkout: '2026-12-03', status: 'confirmada' }];
  d.properties = [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }, { id: 'QS50', nome: 'Casa Terracota' }];
  return d;
};
const tx = () => $('#wzTexto');
const digitar = v => { tx().value = v; tx().dispatchEvent(new Event('input')); };

describe('WhatsApp: responder pelo Hub', () => {
  beforeEach(async () => { await trocarDados(comBase(), { supabase: true }); await abrir(`#/whatsapp?c=${ANA}`); digitar(''); });
  test('Enviar: chama a wa-responder com o texto, limpa a caixa e mostra a mensagem como sua', async () => {
    // como o servidor: grava a mensagem como sua
    banco().funcoes['wa-responder'] = async b => { banco().t('wa_messages').push({ id: 'z1', wa_id: b.wa_id, autor: 'claudio', direcao: 'out', tipo: 'text', texto: b.texto, enviado_em: new Date().toISOString() }); return { ok: true, wamid: 'Z1' }; };
    digitar('Oi Ana, mando já!');
    $('#wzEnviar').click(); await esperar(10);
    assert.deepEqual(banco().invocacoes.at(-1), { nome: 'wa-responder', body: { acao: 'enviar', wa_id: ANA, texto: 'Oi Ana, mando já!' } });
    assert.equal(tx().value, '');
    const ult = $$('.wz-msg').at(-1);
    assert.match(texto(ult.querySelector('small')), /^Você ·/);
    assert.match(texto(ult), /Oi Ana, mando já!/);
  });
  test('falha no envio: avisa e mantém o texto', async () => {
    banco().funcoes['wa-responder'] = async () => ({ error: 'a Z-API não aceitou o envio' });
    digitar('teste');
    $('#wzEnviar').click(); await esperar(10);
    assert.match(texto('#toast'), /Não foi possível enviar: a Z-API não aceitou/);
    assert.equal(tx().value, 'teste');
  });
  test('o texto em andamento sobrevive ao redesenho automático (mensagem nova chegando)', async () => {
    digitar('Estou escrevendo…');
    banco().t('wa_messages').push({ id: 'm9', wa_id: BIA, autor: 'cliente', direcao: 'in', tipo: 'text', texto: 'oi', enviado_em: '2026-10-19T14:59:30Z' });
    await abrir(`#/whatsapp?c=${ANA}`);
    assert.equal(tx().value, 'Estou escrevendo…');
  });
  test('Pix do sinal: 50% do valor da oportunidade, com a chave e o nome', () => {
    $('[data-pronta=pix]').click();
    assert.equal(tx().value, 'Para garantir a reserva, o sinal é de R$ 825 (50% do total de R$ 1.650).\nChave Pix: 12.345.678/0001-90 (Claudio Braga)\nAssim que fizer, me manda o comprovante, por favor.');
  });
  test('Pix com sinal já pago: diz o que falta', async () => {
    const d = comBase(); d.deals[0].pagamentos = [{ data: '2026-10-18', valor: 825, forma: 'Pix' }];
    await trocarDados(d, { supabase: true }); await abrir(`#/whatsapp?c=${ANA}`);
    $('[data-pronta=pix]').click();
    assert.match(tx().value, /^O sinal já está pago ✅ Falta R\$ 825 do total de R\$ 1\.650\./);
  });
  test('respostas prontas se somam ao que já está escrito', () => {
    digitar('Claro!');
    $('[data-pronta=horarios]').click();
    $('[data-pronta=local]').click();
    assert.equal(tx().value, 'Claro!\n\nO check-in é a partir das 14h e o check-out até as 11h.\n\nEndereço: Cond. Pipa Natureza, casa 39\nhttps://maps.app.goo.gl/x');
  });
  test('resposta pronta sem a informação na base: avisa e abre o formulário da base', async () => {
    const d = comBase(); d.app_config = [{ key: 'wa_base', value: '{}' }];
    await trocarDados(d, { supabase: true }); await abrir(`#/whatsapp?c=${ANA}`);
    $('[data-pronta=pets]').click(); await esperar();
    assert.match(texto('#toast'), /Preencha “Pets” em Informações das casas/);
    assert.equal(texto('#modalTitle'), 'Informações das casas');
    $('#modal').close();
  });
  test('Rascunho da IA: coloca o texto na caixa e mostra o que faltou na base', async () => {
    banco().funcoes['wa-responder'] = async b => (b.acao === 'rascunho' ? { texto: 'O Wi-Fi é [senha do Wi-Fi].', faltou: ['senha do Wi-Fi'] } : {});
    $('#wzIA').click(); await esperar(10);
    assert.equal(tx().value, 'O Wi-Fi é [senha do Wi-Fi].');
    assert.match(texto('.wz-faltou'), /A IA não achou na base: senha do Wi-Fi/);
  });
  test('Enviar com [colchetes] pede confirmação', async () => {
    banco().funcoes['wa-responder'] = async () => ({ ok: true });
    let perguntou = ''; globalThis.confirm = m => { perguntou = m; return false; };
    digitar('Sinal de [valor]');
    $('#wzEnviar').click(); await esperar(10);
    assert.match(perguntou, /\[colchetes\]/);
    assert.equal(banco().invocacoes.filter(i => i.body?.acao === 'enviar').length, 0);
  });
});

describe('WhatsApp: painel ao lado da conversa', () => {
  beforeEach(async () => { await trocarDados(comBase(), { supabase: true }); await abrir(`#/whatsapp?c=${ANA}`); digitar(''); });
  test('oportunidade com etapa, valor e quanto falta', () => {
    assert.match(textoSep($('.wz-painel')), /Aluguéis — Ana Lima.*Valor R\$ 1\.650.*Recebido R\$ 0 · falta R\$ 1\.650/s);
  });
  test('reservas pelo nome (Ana Lima × "Ana Lima Souza"; "Anabela" não)', () => {
    assert.deepEqual($$('.wz-reservas li').map(texto), ['Casa Azul: 17 nov a 20 nov R$ 1.650']);
  });
  test('Cotar datas: usa as datas que a IA entendeu e põe a mensagem na caixa, sem "Olá" na conversa em andamento', async () => {
    const d = comBase(); d.wa_messages.push({ id: 'r', wa_id: ANA, autor: 'robo', direcao: 'out', tipo: 'text', texto: 'x', enviado_em: '2026-10-19T14:55:00Z' });
    await trocarDados(d, { supabase: true }); await abrir(`#/whatsapp?c=${ANA}`);
    assert.deepEqual([$('#wzQin').value, $('#wzQout').value, $('#wzQad').value], ['2026-11-17', '2026-11-20', '6']);
    banco().funcoes['airbnb-quote'] = async () => ({ casas: [{ id: 'QS40', nome: 'Casa Azul', status: 'livre', total: 1650 }, { id: 'QS39', nome: 'Casa Frida', status: 'ocupada' }], mensagem: 'Olá! Para 17/11 a 20/11: Casa Azul livre, R$ 1.650.' });
    $('#wzCotar').click(); await esperar(10);
    assert.deepEqual(banco().invocacoes.at(-1).body, { checkin: '2026-11-17', checkout: '2026-11-20', adultos: 6 });
    assert.equal(tx().value, 'Para 17/11 a 20/11: Casa Azul livre, R$ 1.650.');
    assert.deepEqual($$('.wz-cota-res li').map(texto), ['Casa Azul: livre, R$ 1.650', 'Casa Frida: ocupada']);
  });
  test('Cotar com saída antes da entrada: avisa sem consultar', async () => {
    const i = $('#wzQout'); i.value = '2026-11-10'; i.dispatchEvent(new Event('change'));
    $('#wzCotar').click(); await esperar(5);
    assert.match(texto('.wz-painel'), /A saída precisa ser depois da entrada/);
    assert.equal(banco().invocacoes.filter(x => x.nome === 'airbnb-quote').length, 0);
  });
});

describe('WhatsApp: informações das casas', () => {
  test('salva a base em app_config wa_base (vazios ficam de fora)', async () => {
    await trocarDados(comBase(), { supabase: true }); await abrir();
    $('#wzBase').click(); await esperar();
    const f = $('#modalForm');
    f.querySelector('[name="g.pets"]').value = 'Não aceitamos pets.';
    f.querySelector('[name="c.QS40.wifi_rede"]').value = 'CasaAzul';
    f.querySelector('[name="g.regras"]').value = '';
    const ev = new Event('submit', { bubbles: true, cancelable: true }); ev.submitter = f.querySelector('button[value=ok]');
    f.dispatchEvent(ev); await esperar(10);
    const v = JSON.parse(banco().t('app_config').find(c => c.key === 'wa_base').value);
    assert.equal(v.geral.pets, 'Não aceitamos pets.');
    assert.equal(v.geral.pix_chave, '12.345.678/0001-90');
    assert.ok(!('regras' in v.geral));
    assert.deepEqual(v.casas, { QS40: { wifi_rede: 'CasaAzul' } });
  });
});
