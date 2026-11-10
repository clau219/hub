// Tela WhatsApp pessoal: conexão (QR code), alertas "não deixe passar", resumos e escolha de grupos/conversas.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, esperar, ate } from '../helpers/dom.js';
import { abrirHub, trocarDados } from '../helpers/tela.js';
import { banco } from '../helpers/fake-supabase.js';

let V, el;
const ANA = '5584999990000@s.whatsapp.net', FAMILIA = '1203630001@g.us', CONDO = '1203630002@g.us';
const h = n => new Date(Date.parse('2026-10-19T15:00:00Z') - n * 3600e3).toISOString();
const OK = { key: 'wp_status', value: JSON.stringify({ estado: 'conectado', numero: '+5584996011991', em: h(0.05), desde: h(10) }) };
const dados = (x = {}) => ({
  app_config: [OK],
  wp_alertas: [
    { id: 'x1', chat_id: ANA, nome: 'Ana Noiva', tipo: 'pedido_para_voce', urgencia: 'media', titulo: 'Mandar orçamento para a Ana', detalhe: 'Pediu ontem.', prazo: '2026-10-20', status: 'aberto', criado_em: h(3) },
    { id: 'x2', chat_id: FAMILIA, nome: 'Família', tipo: 'compromisso', urgencia: 'alta', titulo: 'Confirmar almoço de domingo', detalhe: '', prazo: null, status: 'aberto', criado_em: h(5) },
    { id: 'x3', chat_id: ANA, nome: 'Ana Noiva', tipo: 'sem_resposta', urgencia: 'baixa', titulo: 'Responder a Ana', status: 'feito', resolvido_por: 'automatico', criado_em: h(30), resolvido_em: h(20) },
  ],
  wp_resumos: [
    { id: 'r2', periodo: 'manha', de: h(15), ate: h(5), mensagens: 12, criado_em: h(5),
      conteudo: { manchete: 'Ana quer orçamento para 12/12.', avisos: [], categorias: [
        { categoria: 'dj', resumo: 'Pedido de orçamento de casamento.', conversas: [{ chat_id: ANA, nome: 'Ana Noiva', resumo: 'Casamento em 12/12.' }] },
        { categoria: 'familia_amigos', resumo: 'Almoço de domingo na vó.', conversas: [] }] } },
    { id: 'r1', periodo: 'noite', de: h(30), ate: h(15), mensagens: 3, criado_em: h(15), conteudo: { manchete: 'Dia calmo.', categorias: [] } },
  ],
  wp_chats: [
    { id: ANA, nome: 'Ana Noiva', grupo: false, acompanhar: false, ignorar: false, ultima_msg_em: h(3) },
    { id: FAMILIA, nome: 'Família', grupo: true, acompanhar: true, ignorar: false, ultima_msg_em: h(4) },
    { id: CONDO, nome: 'Condomínio Pipa', grupo: true, acompanhar: false, ignorar: false, ultima_msg_em: h(6) },
  ],
  tasks: [],
  ...x,
});
const abrir = async (hash = '#/pessoal') => {
  globalThis.__relogio.avancar(31e3);
  const n = banco().consultas.length;
  location.hash = hash; V.render(el);
  await ate(() => banco().consultas.slice(n).some(c => c.tabela === 'wp_chats'), { msg: 'leitura do banco' });
  await esperar(10);
};

before(async () => {
  await abrirHub({ supabase: true, tabelas: dados() });
  V = await hub('v-pessoal.js');
  el = $('#view');
});

describe('WhatsApp pessoal: menu', () => {
  test('aba no menu lateral e na folha "Mais", com ícone próprio', () => {
    assert.equal($$('a[data-route="pessoal"]').length, 2);
    assert.match(texto('nav.side a[data-route="pessoal"]'), /WhatsApp pessoal/);
    assert.ok($('#i-conversa'));
  });
});

describe('WhatsApp pessoal: conexão', () => {
  test('conectado: selo verde com o número, sem faixa', async () => {
    await trocarDados(dados(), { supabase: true }); await abrir();
    assert.match(texto('.wp-st'), /Conectado · \(84\) 99601-1991/);
    assert.ok(!$('.wp-qr') && !$('#view .banner'));
  });
  test('esperando o QR: mostra o código e o passo a passo', async () => {
    await trocarDados(dados({ app_config: [{ key: 'wp_status', value: JSON.stringify({ estado: 'qr', qr: 'data:image/png;base64,QQ', em: h(0.01), desde: h(0.01) }) }] }), { supabase: true });
    await abrir();
    assert.equal($('.wp-qr img').getAttribute('src'), 'data:image/png;base64,QQ');
    assert.match(texto('.wp-qr'), /Aparelhos conectados.*Conectar um aparelho/);
  });
  test('QR velho (leitor parado) não aparece: avisa que está desconectado', async () => {
    await trocarDados(dados({ app_config: [{ key: 'wp_status', value: JSON.stringify({ estado: 'qr', qr: 'data:x', em: h(1), desde: h(1) }) }] }), { supabase: true });
    await abrir();
    assert.ok(!$('.wp-qr'));
    assert.match(texto('#view .banner'), /WhatsApp pessoal desconectado/);
  });
  test('leitor sem sinal há 30+ min', async () => {
    await trocarDados(dados({ app_config: [{ key: 'wp_status', value: JSON.stringify({ estado: 'conectado', em: h(2), desde: h(20) }) }] }), { supabase: true });
    await abrir();
    assert.match(texto('#view .banner'), /não dá sinal desde há 2 h/);
    assert.match(texto('.wp-st'), /Sem sinal do leitor/);
  });
  test('leitor nunca ligado: explica o que falta', async () => {
    await trocarDados(dados({ app_config: [] }), { supabase: true });
    await abrir();
    assert.match(texto('#view .banner'), /ainda não está rodando/);
  });
});

describe('WhatsApp pessoal: alertas e resumo', () => {
  before(async () => { await trocarDados(dados(), { supabase: true }); await abrir(); });
  test('urgente primeiro; tipo, conversa, quando e prazo', () => {
    const al = $$('.wp-alertas')[0].querySelectorAll('.wp-al');
    assert.deepEqual([...al].map(a => texto(a.querySelector('.wp-al-tit'))), ['Confirmar almoço de domingo', 'Mandar orçamento para a Ana']);
    assert.match(texto(al[0]), /Compromisso urgente Família · há 5 h/);
    assert.match(texto(al[1]), /Pediram a você Ana Noiva · há 3 h · prazo 20 out/);
    assert.match(texto('.block.warn h2'), /Não deixe passar 2/);
  });
  test('"Abrir conversa" só em conversa individual (link do WhatsApp)', () => {
    const [familia, ana] = $$('.wp-alertas')[0].querySelectorAll('.wp-al');
    assert.ok(!familia.querySelector('a.btn'));
    assert.equal(ana.querySelector('a.btn').getAttribute('href'), 'https://wa.me/5584999990000');
  });
  test('resumo mais recente: manchete e categorias; dá para abrir o anterior', async () => {
    assert.match(texto('.wp-manchete'), /Ana quer orçamento para 12\/12/);
    assert.deepEqual($$('.wp-cat h3').map(texto), ['DJ', 'Família e amigos']);
    assert.match(texto('.wp-cat'), /Ana Noiva: Casamento em 12\/12/);
    assert.match(texto('.wp-resumo'), /12 mensagens de 18\/10 21:00 a hoje 07:00/);
    const s = $('#wpResumo'); s.value = 'r1'; s.dispatchEvent(new Event('change')); await esperar();
    assert.match(texto('.wp-manchete'), /Dia calmo/);
  });
  test('resolvidos recentes ficam escondidos, com quem resolveu', () => {
    assert.match(texto('.wp-feitos summary'), /Resolvidos nos últimos 7 dias \(1\)/);
    assert.match(texto('.wp-feitos'), /✓ Resolvido \(você respondeu\)/);
  });
  test('"Feito" grava no banco e tira da lista; "Reabrir" volta', async () => {
    $('.wp-al[data-id="x2"] [data-feito]').click(); await esperar(10);
    const x2 = banco().t('wp_alertas').find(a => a.id === 'x2');
    assert.deepEqual([x2.status, x2.resolvido_por], ['feito', 'voce']);
    assert.match(texto('.block.warn h2'), /Não deixe passar 1/);
    $('.wp-al[data-id="x2"] [data-reabrir]').click(); await esperar(10);
    assert.equal(banco().t('wp_alertas').find(a => a.id === 'x2').status, 'aberto');
    assert.match(texto('.block.warn h2'), /Não deixe passar 2/);
  });
  test('"Ignorar" grava como ignorado', async () => {
    $('.wp-al[data-id="x1"] [data-ignorar]').click(); await esperar(10);
    assert.equal(banco().t('wp_alertas').find(a => a.id === 'x1').status, 'ignorado');
  });
  test('"Virar tarefa" abre a tarefa já preenchida', async () => {
    $('.wp-al[data-id="x2"] [data-tarefa]').click(); await esperar(10);
    assert.equal($('#modal [name=titulo]').value, 'Confirmar almoço de domingo');
    assert.equal($('#modal [name=prioridade]').value, '1');
    assert.match($('#modal [name=notas]').value, /WhatsApp: Família/);
    $('#modal').close();
  });
  test('"Gerar resumo agora" chama a wp-resumo e abre o resumo novo', async () => {
    banco().funcoes['wp-resumo'] = body => {
      banco().t('wp_resumos').push({ id: 'r3', periodo: 'agora', de: h(5), ate: h(0), mensagens: 4, criado_em: h(0), conteudo: { manchete: 'Resumo novo.', categorias: [] } });
      return { resumo_id: 'r3', mensagens: 4, alertas_novos: 1, periodo: body.periodo };
    };
    $('#wpGerar').click();
    await ate(() => /Resumo novo/.test(texto('.wp-manchete')), { msg: 'resumo novo na tela' });
    assert.deepEqual(banco().invocacoes.at(-1), { nome: 'wp-resumo', body: { periodo: 'agora' } });
  });
});

describe('WhatsApp pessoal: conversas e grupos', () => {
  before(async () => { await trocarDados(dados(), { supabase: true }); await abrir(); $('[data-aba=conversas]').click(); await esperar(); });
  test('grupos com "Acompanhar" e conversas com "Ignorar no resumo"', () => {
    const [grupos, pessoas] = $$('.wp-chats');
    assert.deepEqual([...grupos.querySelectorAll('b')].map(texto), ['Família', 'Condomínio Pipa']);
    assert.deepEqual([...pessoas.querySelectorAll('b')].map(texto), ['Ana Noiva']);
    assert.match(texto('.wp-listas h2'), /1 acompanhado/);
  });
  test('marcar "Acompanhar" grava no banco', async () => {
    const i = $(`[data-chat="${CONDO}"]`); i.checked = true; i.dispatchEvent(new Event('change')); await esperar(10);
    assert.equal(banco().t('wp_chats').find(c => c.id === CONDO).acompanhar, true);
    assert.match(texto('.wp-listas h2'), /2 acompanhados/);
  });
  test('marcar "Ignorar no resumo" grava no banco', async () => {
    const i = $(`[data-chat="${ANA}"]`); i.checked = true; i.dispatchEvent(new Event('change')); await esperar(10);
    assert.equal(banco().t('wp_chats').find(c => c.id === ANA).ignorar, true);
  });
  test('busca sem acento filtra as duas listas', async () => {
    const b = $('#wpBusca'); b.value = 'condominio'; b.dispatchEvent(new Event('input')); await esperar();
    assert.deepEqual($$('.wp-chat b').map(texto), ['Condomínio Pipa']);
    assert.equal(document.activeElement.id, 'wpBusca', 'o foco continua na busca');
  });
});
