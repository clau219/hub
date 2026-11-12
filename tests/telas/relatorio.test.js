// Relatórios dos proprietários (v-relatorio.js): lista das casas no mês, revisão de uma casa, PDF e envio por e-mail,
// e o lembrete no Escapando. Hoje nos testes é 19/10/2026, então o mês padrão é setembro/2026.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, clicar, preencher, esperar, enviarModal } from '../helpers/dom.js';
import { abrirHub, CASAS } from '../helpers/tela.js';
import { banco } from '../helpers/fake-supabase.js';

let V, A, S, store;
const nb = s => s.replace(/ /g, ' ');
const DONO = { nome: 'Maria Souza', email: 'maria@exemplo.com', comissao_pct: 20 };
before(async () => {
  ({ S } = await abrirHub({ supabase: true, tabelas: {
    properties: [{ ...CASAS[0], dono: DONO, relatorios: {} }, { ...CASAS[1], dono: {}, relatorios: {} },
      { ...CASAS[2], dono: { nome: 'Pedro', email: 'pedro@ex.com' }, relatorios: { '2026-09': { enviado_em: '2026-10-02T12:00:00Z', para: 'pedro@ex.com' } } }],
    bookings: [
      { id: 'b1', property_id: 'QS39', origem: 'airbnb', status: 'confirmada', hospede: 'Hóspede Airbnb', checkin: '2026-09-05', checkout: '2026-09-08', valor: null },
      { id: 'b2', property_id: 'QS39', origem: 'direto', status: 'confirmada', hospede: 'Bia', checkin: '2026-09-20', checkout: '2026-09-25', valor: 2500 },
      { id: 'b3', property_id: 'QS39', origem: 'direto', status: 'cancelada', hospede: 'X', checkin: '2026-09-10', checkout: '2026-09-12', valor: 900 },
      { id: 'b4', property_id: 'QS39', origem: 'direto', status: 'confirmada', hospede: 'Caio', checkin: '2026-10-25', checkout: '2026-10-28', valor: 1000 },
    ],
    fin_tx: [
      { id: 't1', data: '2026-09-03', descricao: 'Faxina Maria', valor: -150, negocio: 'alugueis', casa: 'QS39' },
      { id: 't2', data: '2026-09-15', descricao: 'Cosern', valor: -230.45, negocio: 'alugueis', casa: 'QS39' },
      { id: 't3', data: '2026-09-15', descricao: 'Material de limpeza', valor: -80, negocio: 'alugueis', casa: null },
      { id: 't4', data: '2026-09-15', descricao: 'Mercado', valor: -300, negocio: 'pessoal', casa: null },
      { id: 'r1', data: '2026-09-06', descricao: 'Airbnb Payments', valor: 1500, categoria: 'Airbnb', negocio: 'alugueis', casa: null },
      { id: 'p1', data: '2026-10-05', descricao: 'PIX Maria Souza', valor: -1769.55, categoria: null, negocio: null, casa: null },
    ],
  } }));
  V = await hub('v-relatorio.js');
  A = await hub('v-alugueis.js');
  store = await hub('store.js');
});
beforeEach(() => { $('#modal').open && $('#modal').close(); });

describe('lista das casas', () => {
  test('botão em Aluguéis abre a lista do mês passado com a situação de cada casa', async () => {
    A.render($('#view'));
    await clicar('#abRelatorio');
    assert.equal($('#modal [name=mes]').value, '2026-09');
    assert.deepEqual($$('#relCasas li').map(l => texto(l)), [
      'Casa Frida · Maria Souza Ainda não enviado',
      'Casa Azul Sem e-mail do proprietário',
      'Casa Terracota · Pedro Enviado em 02/10/2026 para pedro@ex.comenviado',
    ]);
    $('#modal [name=mes]').value = '2026-10';
    $('#modal [name=mes]').dispatchEvent(new Event('change'));
    assert.equal(texto($$('#relCasas li')[2]), 'Casa Terracota · Pedro Ainda não enviado');
  });
});

describe('revisão de uma casa', () => {
  test('mostra dono, reservas do mês com campo de valor, despesas da casa e as sem casa', async () => {
    await V.relatorioCasa('QS39', '2026-09');
    assert.equal(texto('#modalTitle'), 'Relatório de setembro/2026 · Casa Frida');
    assert.deepEqual(['dono_nome', 'dono_email', 'comissao_pct'].map(n => $(`#modal [name=${n}]`).value), ['Maria Souza', 'maria@exemplo.com', '20']);
    assert.deepEqual($$('.rel-res tbody tr').map(r => texto(r.cells[0])), ['Hóspede Airbnb', 'Bia']);
    assert.deepEqual([$('[name="v:b1"]').value, $('[name="v:b1"]').placeholder, $('[name="v:b2"]').value], ['', 'total', '2500']);
    assert.deepEqual($$('#relDesp .chk').map(l => nb(texto(l))), ['03/09 · Faxina MariaR$ 150,00', '15/09 · CosernR$ 230,45']);
    assert.match(texto('.rel-sem summary'), /^1 despesa de Aluguéis sem casa definida$/);
    assert.match(nb(texto('#relResumo')), /Receita1 reserva sem valorR\$ 2\.500,00/);
  });
  test('resumo acompanha o que é digitado: valor do Airbnb, despesa desmarcada e outras despesas', async () => {
    await V.relatorioCasa('QS39', '2026-09');
    preencher($('#modal'), { 'v:b1': '1500', ajustes: 'Lâmpadas 42,90' });
    $('[name="tx:t1"]').checked = false;
    $('[name="tx:t1"]').dispatchEvent(new Event('input', { bubbles: true }));
    const r = nb(texto('#relResumo'));
    assert.match(r, /^ReceitaR\$ 4\.000,00 DespesasR\$ 273,35 Comissão \(20%\)R\$ 800,00 A repassar/);
    assert.match(r, /R\$ 2\.926,65$/);
  });
  test('"É desta casa" marca o lançamento em Finanças e ele passa a contar', async () => {
    await V.relatorioCasa('QS39', '2026-09');
    await clicar('[data-dacasa=t3]', 10);
    assert.deepEqual(banco().tabelas.fin_tx.find(t => t.id === 't3'), { id: 't3', data: '2026-09-15', descricao: 'Material de limpeza', valor: -80, negocio: 'alugueis', casa: 'QS39', manual: true });
    assert.equal($('.rel-sem'), null);
    assert.equal($$('#relDesp .chk').length, 3);
    banco().tabelas.fin_tx.find(t => t.id === 't3').casa = null; // volta para os outros testes
  });
  test('Salvar grava o dono, a revisão do mês na casa e o valor do Airbnb na reserva', async () => {
    await V.relatorioCasa('QS39', '2026-09');
    preencher($('#modal'), { 'v:b1': '1500', ajustes: 'Lâmpadas 42,90', comissao_pct: '15' });
    $('[name="tx:t1"]').checked = false;
    await enviarModal();
    const p = S.properties.find(x => x.id === 'QS39');
    assert.deepEqual(p.dono, { ...DONO, comissao_pct: 15 });
    assert.deepEqual(p.relatorios['2026-09'], { ajustes: [{ descricao: 'Lâmpadas', valor: 42.9 }], excluidas: ['t1'] });
    assert.equal(S.bookings.find(b => b.id === 'b1').valor, 1500);
    assert.equal(texto('#toast'), 'Relatório salvo');
    // reabrindo, a revisão volta como ficou
    await V.relatorioCasa('QS39', '2026-09');
    assert.deepEqual([$('[name=ajustes]').value, $('[name="tx:t1"]').checked, $('[name="v:b1"]').value], ['Lâmpadas 42,9', false, '1500']);
  });
});

describe('envio', () => {
  test('sem e-mail do dono ou com reserva sem valor não envia', async () => {
    const n = banco().invocacoes.length;
    await V.relatorioCasa('QS40', '2026-09');
    await clicar('#relEnviar');
    assert.equal(texto('#relAviso'), 'Preencha o e-mail do proprietário.');
    await V.relatorioCasa('QS39', '2026-09');
    preencher($('#modal'), { 'v:b1': '' });
    await clicar('#relEnviar');
    assert.equal(texto('#relAviso'), 'Preencha o valor de uma reserva (no Airbnb, o repasse) antes de enviar.');
    assert.equal(banco().invocacoes.length, n);
  });
  test('2 cliques: manda o e-mail com o PDF e marca o mês como enviado (sai do Escapando)', async () => {
    banco().funcoes['relatorio-enviar'] = () => ({ ok: true, messageId: '<x@gmail.com>' });
    assert.ok(store.atencao().some(i => i.kind === 'relatorio' && i.ref.id === 'QS39'));
    await V.relatorioCasa('QS39', '2026-09');
    preencher($('#modal'), { 'v:b1': '1500' });
    const n = banco().invocacoes.length;
    await clicar('#relEnviar');
    assert.equal(banco().invocacoes.length, n); // 1º clique só arma
    await clicar('#relEnviar', 15);
    const { nome, body } = banco().invocacoes.at(-1);
    assert.equal(nome, 'relatorio-enviar');
    assert.equal(body.para, 'maria@exemplo.com');
    assert.equal(body.assunto, 'Relatório de setembro/2026 — Casa Frida');
    assert.equal(body.arquivo, 'Relatorio Casa Frida 2026-09.pdf');
    assert.match(body.corpo, /^Olá, Maria!/);
    assert.ok(Buffer.from(body.pdf, 'base64').toString('latin1').startsWith('%PDF-1.4'));
    const rel = S.properties.find(x => x.id === 'QS39').relatorios['2026-09'];
    assert.equal(rel.para, 'maria@exemplo.com');
    assert.ok(rel.enviado_em);
    assert.equal(typeof rel.repasse, 'number');
    assert.equal($('#modal').open, false);
    assert.equal(texto('#toast'), 'Relatório de setembro/2026 enviado para maria@exemplo.com');
    assert.ok(!store.atencao().some(i => i.kind === 'relatorio' && i.ref.id === 'QS39'));
  });
  test('erro do Gmail aparece, nada é marcado e o botão volta', async () => {
    banco().funcoes['relatorio-enviar'] = () => ({ error: 'o Gmail recusou o login (confira a senha de app)' });
    await V.relatorioCasa('QS50', '2026-10');
    await clicar('#relEnviar'); await clicar('#relEnviar', 15);
    assert.equal(texto('#relAviso'), 'Não consegui enviar: o Gmail recusou o login (confira a senha de app)');
    assert.equal(S.properties.find(x => x.id === 'QS50').relatorios['2026-10'], undefined);
    assert.deepEqual([$('#relEnviar').disabled, texto('#relEnviar')], [false, 'Enviar ao proprietário']);
  });
});

describe('Escapando', () => {
  test('lembra só das casas com e-mail do dono e relatório do mês passado não enviado; abre a revisão', async () => {
    const p = S.properties.find(x => x.id === 'QS39');
    p.relatorios = {};
    const itens = store.atencao().filter(i => i.kind === 'relatorio');
    assert.deepEqual(itens.map(i => [i.ref.id, i.title, i.sub, i.date]), [['QS39', 'Relatório de setembro/2026 · Casa Frida', 'Conferir e enviar para Maria Souza', '2026-10-01']]);
    const ui = await hub('ui.js');
    await ui.openItem(itens[0]);
    await esperar(10);
    assert.equal(texto('#modalTitle'), 'Relatório de setembro/2026 · Casa Frida');
  });
});

describe('melhorias: repasse do Airbnb, teste, mudou depois do envio, repasse pago', () => {
  const tabela = n => banco().tabelas[n];
  async function relSet(rel) { tabela('bookings').find(b => b.id === 'b1').valor = null; Object.assign(tabela('properties').find(p => p.id === 'QS39'), { relatorios: rel, dono: DONO }); await store.load(); }
  const ENVIADO = { enviado_em: '2026-10-02T12:00:00Z', para: 'maria@exemplo.com', repasse: 1769.55, ajustes: [], excluidas: [],
    totais: { receita: 2500, totalDespesas: 230.45, comissao: 500, repasse: 1769.55 } };

  test('sugere o valor do Airbnb pelo repasse em Finanças; ao salvar, o repasse ganha a casa', async () => {
    await relSet({});
    await V.relatorioCasa('QS39', '2026-09');
    assert.equal(nb(texto('[data-sug=b1]')), 'Usar repasse R$ 1.500,00');
    assert.equal($('[data-sug=b2]'), null); // reserva direta com valor: sem sugestão
    await clicar('[data-sug=b1]');
    assert.deepEqual([$('[name="v:b1"]').value, $('[data-sug=b1]')], ['1500', null]);
    assert.match(nb(texto('#relResumo')), /^ReceitaR\$ 4\.000,00/);
    await enviarModal();
    assert.equal(tabela('bookings').find(b => b.id === 'b1').valor, 1500);
    assert.deepEqual([tabela('fin_tx').find(t => t.id === 'r1').casa, tabela('fin_tx').find(t => t.id === 'r1').manual], ['QS39', true]);
    // volta para os outros testes
    tabela('bookings').find(b => b.id === 'b1').valor = null; Object.assign(tabela('fin_tx').find(t => t.id === 'r1'), { casa: null, manual: undefined });
    await relSet({});
  });
  test('valor digitado diferente da sugestão não vincula o repasse', async () => {
    await V.relatorioCasa('QS39', '2026-09');
    await clicar('[data-sug=b1]');
    preencher($('#modal'), { 'v:b1': '1400' });
    await enviarModal();
    assert.equal(tabela('fin_tx').find(t => t.id === 'r1').casa, null);
    tabela('bookings').find(b => b.id === 'b1').valor = null;
    await relSet({});
  });
  test('teste vai para o próprio Gmail e não marca o mês como enviado', async () => {
    banco().funcoes['relatorio-enviar'] = () => ({ ok: true, para: ['claudiorsbraga@gmail.com'] });
    await V.relatorioCasa('QS39', '2026-09');
    await clicar('#relTeste', 15);
    const { nome, body } = banco().invocacoes.at(-1);
    assert.deepEqual([nome, body.teste, body.para, body.assunto], ['relatorio-enviar', true, undefined, 'Relatório de setembro/2026 — Casa Frida']);
    assert.equal(texto('#toast'), 'Teste enviado para claudiorsbraga@gmail.com');
    assert.equal(S.properties.find(p => p.id === 'QS39').relatorios['2026-09'], undefined);
    assert.equal($('#modal').open, true);
  });
  test('reabrindo um mês enviado: diz o que mudou desde o envio (e a lista marca)', async () => {
    await relSet({ '2026-09': ENVIADO });
    await V.relatorioCasa('QS39', '2026-09');
    assert.ok($('#relEnv').classList.contains('mudou'));
    assert.equal(nb(texto('#relEnv')), 'Mudou desde o envio em 02/10/2026 para maria@exemplo.com: Despesas R$ 230,45 → R$ 380,45; Repasse R$ 1.769,55 → R$ 1.619,55. Enviar de novo manda a versão corrigida.');
    $('[name="tx:t1"]').checked = false; $('[name="tx:t1"]').dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(texto('#relEnv'), 'Enviado em 02/10/2026 para maria@exemplo.com. Nada mudou desde então.');
    V.relatoriosForm('2026-09');
    await esperar(15);
    assert.match(texto($$('#relCasas li')[0]), /repasse a pagarmudou depois do envio$/);
  });
  test('repasse pago: sugere a saída do extrato, marca e desfaz', async () => {
    await relSet({ '2026-09': ENVIADO });
    await V.relatorioCasa('QS39', '2026-09');
    await esperar(10);
    assert.match(nb(texto('#relPago')), /^Repasse de R\$ 1\.769,55 a pagar Marcar como pago Encontrei em Finanças: R\$ 1\.769,55 em 05\/10\/2026 \(PIX Maria Souza\)\.$/);
    assert.equal($('#relPagoData').value, '2026-10-05');
    assert.ok(store.atencao().some(i => i.kind === 'relatorio' && i.motivo === 'repasse'));
    await clicar('#relPagar', 15);
    assert.deepEqual(S.properties.find(p => p.id === 'QS39').relatorios['2026-09'], { ...ENVIADO, pago_em: '2026-10-05', pago_valor: 1769.55, pago_tx: 'p1' });
    assert.equal(nb(texto('#relPago')), '✓ Repasse de R$ 1.769,55 pago em 05/10/2026desfazer');
    assert.ok(!store.atencao().some(i => i.kind === 'relatorio' && i.motivo === 'repasse'));
    await clicar('#relDespagar', 15);
    assert.deepEqual(S.properties.find(p => p.id === 'QS39').relatorios['2026-09'], ENVIADO);
  });
  test('Escapando: repasse a pagar 5 dias depois do envio', async () => {
    await relSet({ '2026-09': ENVIADO });
    const it = store.atencao().find(i => i.motivo === 'repasse');
    assert.deepEqual([it.title, nb(it.sub), it.date, it.mes], ['Repasse de setembro/2026 · Casa Frida', 'R$ 1.769,55 para Maria Souza: marque quando pagar', '2026-10-07', '2026-09']);
    await relSet({ '2026-09': { ...ENVIADO, enviado_em: '2026-10-17T12:00:00Z' } });
    assert.ok(!store.atencao().some(i => i.motivo === 'repasse')); // só 2 dias
    await relSet({});
  });
});
