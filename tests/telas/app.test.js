// app.js com sessão válida: abre o Hub, troca de tela pelo endereço, captura rápida, atalhos, tema, folhas do celular e avisos.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, montarDom, $, $$, texto, clicar, esperar, ate } from '../helpers/dom.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { CASAS } from '../helpers/tela.js';

before(async () => {
  montarDom();
  novoBanco({
    properties: CASAS,
    contacts: [{ id: 'c1', nome: 'Ana' }, { id: 'c2', nome: 'Ana Souza' }],
    tasks: [{ id: 't0', titulo: 'Atrasada', area: 'casa', prazo: '2026-10-01' }],
  });
  await hub('app.js');
  await ate(() => !$('#app').hidden && $('.hero'), { msg: 'app aberto' });
});
beforeEach(() => { for (const d of ['#modal', '#sheetAdd', '#sheetMore', '#pal']) $(d).open && $(d).close(); });
const irPara = async r => { location.hash = '#/' + r; window.dispatchEvent(new HashChangeEvent('hashchange')); await esperar(10); };
const capturar = async (txt, form = '#capture', inp = '#captureInput') => {
  $(inp).value = txt;
  $(form).dispatchEvent(new Event('submit', { cancelable: true }));
  await esperar(15);
};

describe('abertura e navegação', () => {
  test('com sessão: mostra o app, não o login; Hoje é a tela inicial', () => {
    assert.equal($('#login').hidden, true);
    assert.equal($('#localBanner').hidden, true);
    assert.ok($('a[data-route=hoje]').classList.contains('on'));
  });
  test('cada endereço abre a sua tela e marca o menu', async () => {
    const telas = { pipeline: 'Pipeline', agenda: /Outubro|–/, alugueis: 'Aluguéis', tarefas: 'Tarefas', contatos: 'Contatos', cripto: 'Cripto', saude: 'Saúde', financas: 'Finanças', ajustes: 'Ajustes' };
    for (const [r, h1] of Object.entries(telas)) {
      await irPara(r);
      await ate(() => $('#view h1'), { msg: r });
      if (typeof h1 === 'string') assert.equal(texto('#view h1').split(' ')[0].replace(/\d+$/, ''), h1.split(' ')[0], r);
      else assert.match(texto('#view h1'), h1);
      assert.ok($(`nav.side a[data-route=${r}]`).classList.contains('on'), r);
    }
  });
  test('telas do "Mais" acendem o botão Mais no celular', async () => {
    await irPara('contatos');
    assert.ok($('#moreBtn').classList.contains('on'));
    await irPara('pipeline');
    assert.ok(!$('#moreBtn').classList.contains('on'));
  });
  test('endereço desconhecido cai no Hoje', async () => {
    await irPara('nao-existe');
    assert.ok($('.hero'));
  });
  test('o clique do Hoje não vaza para a próxima tela', async () => {
    await irPara('hoje');
    await irPara('tarefas');
    assert.equal($('#view').onclick, null);
  });
});

describe('captura rápida', () => {
  test('texto vira tarefa com prazo e área; avisa onde anotou', async () => {
    await capturar('ligar contador amanhã #casa !');
    const t = banco().t('tasks').find(x => x.titulo === 'ligar contador');
    assert.deepEqual([t.prazo, t.area, t.prioridade], ['2026-10-20', 'casa', 1]);
    assert.equal(texto('#toast'), 'Anotado para amanhã (Casa)');
    assert.equal($('#captureInput').value, '');
  });
  test('sem data vai para a caixa de entrada', async () => {
    await capturar('ideia nova');
    assert.equal(texto('#toast'), 'Anotado na caixa de entrada');
  });
  test('vazio não faz nada', async () => {
    const n = banco().t('tasks').length;
    await capturar('   ');
    assert.equal(banco().t('tasks').length, n);
  });
  test('"+dj Ana Souza casamento 12/12" abre a oportunidade com o contato certo (nome mais longo)', async () => {
    await capturar('+dj Ana Souza casamento 12/12');
    assert.equal(texto('#modalTitle'), 'Nova oportunidade');
    assert.equal($('#modal [name=contato]').value, 'Ana Souza');
    assert.equal($('#modal [name=notas]').value, 'casamento');
    assert.equal($('#modal [name=data_evento]').value, '2026-12-12');
  });
  test('"+dj Anabela" não casa com o contato "Ana"', async () => {
    await capturar('+dj Anabela festa');
    assert.equal($('#modal [name=contato]').value, 'Anabela festa');
  });
  test('folha do celular: "+" abre, captura fecha a folha', async () => {
    await clicar('#fab');
    assert.equal($('#sheetAdd').open, true);
    await capturar('pelo celular', '#capture2', '#captureInput2');
    assert.equal($('#sheetAdd').open, false);
    assert.ok(banco().t('tasks').some(t => t.titulo === 'pelo celular'));
  });
  test('botões da folha abrem reserva e tarefa', async () => {
    await clicar('#fab');
    await clicar('#sheetAdd [data-add=reserva]');
    assert.equal(texto('#modalTitle'), 'Nova reserva');
    $('#modal').close();
    await clicar('#fab');
    await clicar('#sheetAdd [data-add=tarefa]');
    assert.equal(texto('#modalTitle'), 'Nova tarefa');
  });
});

describe('atalhos, tema e menus', () => {
  test('"/" foca a captura e "n" abre nova oportunidade', async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })); // no navegador a tecla parte do body
    assert.equal(document.activeElement, $('#captureInput'));
    $('#captureInput').blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    assert.equal(texto('#modalTitle'), 'Nova oportunidade');
  });
  test('atalhos não valem digitando num campo', () => {
    $('#captureInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    assert.equal($('#modal').open, false);
  });
  test('tema: automático → claro → escuro → automático, guardado no aparelho', async () => {
    assert.equal(document.documentElement.dataset.theme, undefined);
    await clicar('#themeBtn');
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(localStorage.getItem('hub:tema'), 'light');
    await clicar('#themeBtn');
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(document.querySelector('meta[name=theme-color]').content, '#0a1113');
    await clicar('#themeBtn');
    assert.equal(document.documentElement.dataset.theme, undefined);
    assert.equal(localStorage.getItem('hub:tema'), null);
  });
  test('Buscar e "Mais" abrem a paleta e a folha de seções', async () => {
    await clicar('#searchBtn');
    assert.equal($('#pal').open, true);
    $('#pal').close();
    await clicar('#moreBtn');
    assert.equal($('#sheetMore').open, true);
    await clicar('#sheetMore [data-buscar]');
    assert.equal($('#sheetMore').open, false);
    assert.equal($('#pal').open, true);
  });
  test('"Oportunidade" no topo abre o formulário', async () => {
    await clicar('#newDeal');
    assert.equal(texto('#modalTitle'), 'Nova oportunidade');
  });
  test('relógio no topo com a hora de Pipa', () => {
    assert.equal(texto('#clock'), '12:00');
  });
});

describe('avisos', () => {
  test('falha parcial na carga mostra faixa com "Tentar de novo"', async () => {
    banco().falhas.deals = 'timeout';
    window.dispatchEvent(new Event('online')); // recarrega
    await ate(() => !$('#syncBanner').hidden, { msg: 'faixa' });
    assert.match(texto('#syncBanner'), /Não carregou: deals\. O que depende disso pode estar incompleto/);
    delete banco().falhas.deals;
    await clicar('#syncBanner [data-reload]', 15);
    await ate(() => $('#syncBanner').hidden, { msg: 'faixa some' });
  });
  test('gravação que falha fora de formulário vira aviso', async () => {
    const ev = new Event('unhandledrejection');
    ev.reason = new Error('permission denied');
    window.dispatchEvent(ev);
    assert.equal(texto('#toast'), 'Não foi possível salvar: permission denied');
  });
});
