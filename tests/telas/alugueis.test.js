// Tela Aluguéis: Gantt das casas, próximas reservas com a sequência da hospedagem, receita/ocupação e "Consultar Airbnb".
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, clicar, preencher, esperar, enviarModal } from '../helpers/dom.js';
import { abrirHub, CASAS } from '../helpers/tela.js';
import { banco } from '../helpers/fake-supabase.js';

let A, el, S;
const nb = s => s.replace(/ /g, ' ');
before(async () => {
  ({ S } = await abrirHub({ supabase: true, tabelas: {
    properties: CASAS,
    bookings: [
      { id: 'b1', property_id: 'QS39', origem: 'airbnb', status: 'confirmada', hospede: 'Ana', checkin: '2026-10-20', checkout: '2026-10-23', valor: null, etapas: { hospedes: '2026-10-17' } },
      { id: 'b2', property_id: 'QS40', origem: 'direto', status: 'confirmada', hospede: 'Bia', checkin: '2026-10-25', checkout: '2026-10-30', valor: 2500, etapas: {} },
      { id: 'b3', property_id: 'QS50', origem: 'airbnb', status: 'bloqueio', checkin: '2026-11-01', checkout: '2026-11-04' },
      { id: 'b4', property_id: 'QS50', origem: 'airbnb', status: 'cancelada', hospede: 'Cancelado', checkin: '2026-10-21', checkout: '2026-10-22' },
      { id: 'b5', property_id: 'QS39', origem: 'airbnb', status: 'confirmada', hospede: 'Velho', checkin: '2026-09-01', checkout: '2026-09-05' },
    ],
  } }));
  A = await hub('v-alugueis.js');
  el = $('#view');
  A.render(el);
});
beforeEach(() => { $('#modal').open && $('#modal').close(); });

describe('Gantt e tabela', () => {
  test('barras por casa: Airbnb, direta e bloqueio; cancelada não aparece', () => {
    const barras = $$('.bar').map(b => [b.dataset.bk, b.className.replace('bar ', ''), b.style.getPropertyValue('--s'), b.style.getPropertyValue('--e')]);
    assert.deepEqual(barras, [['b1', 'air', '31.5', '34.5'], ['b2', 'dir', '36.5', '41.5'], ['b3', 'blk', '43.5', '46.5']]);
    assert.equal(texto('.bar[data-bk=b3]'), 'Bloqueado');
  });
  test('próximas reservas com noites, origem e sequência', () => {
    const linhas = $$('tbody tr[data-bk]').map(r => [...r.cells].map(c => nb(texto(c))));
    assert.deepEqual(linhas, [
      ['Casa Frida', 'Ana', 'amanhã', '23 out', '3', 'airbnb', '1/3 Enviar lista para a portaria (atrasada)', ''],
      ['Casa Azul', 'Bia', 'dom', '30 out', '5', 'direto', '0/6 Enviar orçamento (atrasada)', 'R$ 2.500'],
      ['Casa Terracota', 'Bloqueio', '1 nov', '4 nov', '3', 'airbnb', '', ''],
    ]);
  });
  test('receita do mês avisa que o Airbnb não informa valor; ocupação de 30 dias', () => {
    const dl = $$('.pipe-sum div').map(d => nb(texto(d)));
    assert.equal(dl[0], 'Receita com check-in no mêssó 1 de 2 reservas têm valorR$ 2.500');
    assert.equal(dl[1], 'Casa Frida, próximos 30 dias10%3 noites');
    assert.equal(dl[2], 'Casa Azul, próximos 30 dias17%5 noites');
    assert.equal(dl[3], 'Casa Terracota, próximos 30 dias0%0 noites');
  });
  test('o Gantt vai de 30 dias atrás até 1 ano à frente, com o nome de cada mês', () => {
    const dias = $$('.g-head span').slice(1);
    assert.equal(dias.length, 30 + 366);
    assert.equal(texto(dias[0]), 's19'); // 19/09
    assert.equal(texto(dias.at(-1)), 't19'); // 19/10/2027
    assert.ok(dias[30].classList.contains('today'));
    const meses = $$('.g-head span[data-m]').map(s => s.dataset.m);
    assert.deepEqual(meses.slice(0, 4), ['set', 'out', 'out', 'nov']); // o de hoje também tem rótulo
    assert.deepEqual(meses.slice(-2), ['set 27', 'out 27']);
  });
  test('sem botões de semana: abre perto de hoje e guarda a posição do deslizador', () => {
    assert.equal($('[data-o]'), null);
    const g = $('.gantt');
    assert.equal(g.scrollLeft, 27 * 26);
    g.scrollLeft = 2000; g.dispatchEvent(new Event('scroll'));
    A.render(el);
    assert.equal($('.gantt').scrollLeft, 2000);
  });
  test('clicar na barra ou na linha abre a reserva', async () => {
    await clicar('.bar[data-bk=b2]');
    assert.equal($('#modal [name=hospede]').value, 'Bia');
    $('#modal').close();
    await clicar('tr[data-bk=b1]');
    assert.equal($('#modal [name=hospede]').value, 'Ana');
  });
});

describe('E-mail da portaria', () => {
  const campo = n => $(`#modal [name=${n}]`);
  test('abre na reserva cuja portaria vence primeiro, com casa e datas dela', async () => {
    await clicar('#abPortaria');
    assert.equal(texto('#modalTitle'), 'E-mail da portaria');
    assert.equal(campo('bk').value, 'b1');
    assert.equal(campo('casa').value, 'QS39');
    assert.equal(campo('casa').disabled, true);
    assert.equal(campo('assunto').value, 'Autorização de Acesso — Casa Frida QS39 — Hóspedes (20/10 a 23/10/2026)');
    assert.equal(texto('#ptAviso'), 'Falta os hóspedes.');
  });
  test('colar dados crus organiza a lista e monta o e-mail; copiar assunto e corpo', async () => {
    A.portariaForm();
    preencher($('#modal'), { cru: '1. MARIA DA SILVA - CPF 12345678900\n2. João Souza\nRG 1.234.567\ntodos os RGs são SSP/PE\nCarro: Honda HRV placa TZX3D00' });
    await clicar('#ptLer');
    assert.equal(campo('hospedes').value, 'Maria da Silva, CPF 123.456.789-00\nJoão Souza, RG 1.234.567 SSP/PE');
    assert.equal(campo('veiculos').value, 'Honda HRV, TZX3D00');
    assert.equal(campo('cru').value, '');
    assert.equal(texto('#toast'), '2 hóspedes lidos · 1 veículo · RGs SSP/PE');
    assert.match(campo('corpo').value, /\n\nCasa Frida QS39\n\n1\. Maria da Silva \| CPF 123\.456\.789-00\n2\. João Souza \| RG 1\.234\.567 \| SSP\/PE\n\nVeículos autorizados:\n— Honda HRV \| TZX3D00\n/);
    assert.equal(texto('#ptAviso'), '2 hóspedes, todos com documento.');
    await clicar('#ptCopA');
    assert.equal(await navigator.clipboard.readText(), campo('assunto').value);
    await clicar('#ptCopC');
    assert.equal(await navigator.clipboard.readText(), campo('corpo').value);
  });
  test('"adicione esses dois": o segundo texto colado entra no fim da lista', async () => {
    A.portariaForm();
    preencher($('#modal'), { hospedes: 'Maria da Silva, CPF 123.456.789-00', cru: 'Pedro Alves 98765432100\nmaria da silva' });
    await clicar('#ptLer');
    assert.equal(campo('hospedes').value, 'Maria da Silva, CPF 123.456.789-00\nPedro Alves, CPF 987.654.321-00');
  });
  test('sem reserva: escolhe casa e datas à mão; Salvar pede uma reserva', async () => {
    A.portariaForm();
    preencher($('#modal'), { bk: '' });
    assert.equal(campo('casa').disabled, false);
    preencher($('#modal'), { casa: 'QS50', checkin: '2026-12-28', checkout: '2027-01-02', hospedes: 'Lia' });
    assert.equal(campo('assunto').value, 'Autorização de Acesso — Casa Terracota QS50 — Hóspedes (28/12/2026 a 02/01/2027)');
    assert.equal(texto('#ptAviso'), 'Sem documento: Lia.');
    await enviarModal();
    assert.match(texto('#modalErr'), /Escolha uma reserva/);
  });
  test('salvar grava os hóspedes na reserva e marca hóspedes e portaria', async () => {
    A.portariaForm();
    preencher($('#modal'), { bk: 'b2', hospedes: 'Bia Lima, CPF 111.222.333-44', veiculos: 'HB20, RZW5I32' });
    await enviarModal();
    const b = S.bookings.find(x => x.id === 'b2');
    assert.deepEqual(b.hospedes, [{ nome: 'Bia Lima', doc: 'CPF 111.222.333-44' }]);
    assert.deepEqual(b.veiculos, [{ modelo: 'HB20', placa: 'RZW5I32' }]);
    assert.deepEqual(b.etapas, { hospedes: '2026-10-19', portaria: '2026-10-19' });
  });
});

describe('E-mail da portaria: print ou foto (função portaria-ler)', () => {
  const campo = n => $(`#modal [name=${n}]`);
  const png = (nome = 'print.png') => new File([new Uint8Array([137, 80, 78, 71])], nome, { type: 'image/png' });
  const anexar = async (...arqs) => { $('#ptArq').onchange({ target: { files: arqs, value: 'x' } }); await esperar(15); };
  const LIDO = (x = {}) => ({ hospedes: [], veiculos: [], casa: '', checkin: '', checkout: '', avisos: [], ...x });

  test('anexar manda a imagem em base64; o resultado passa pelo leitor (CPF formatado, nome, órgão) e cai na lista', async () => {
    banco().funcoes['portaria-ler'] = () => LIDO({
      hospedes: [{ nome: 'MARIA DA SILVA', documento: 'CPF 12345678900' }, { nome: 'Luiz Antônio da Silva', documento: 'RG 2392336 SDS/PE' }],
      veiculos: [{ modelo: 'HB20', placa: 'RZW5I32' }],
    });
    A.portariaForm(S.bookings.find(b => b.id === 'b1'));
    await anexar(png());
    assert.deepEqual(banco().invocacoes.at(-1), { nome: 'portaria-ler', body: { arquivos: [{ mime: 'image/png', base64: 'iVBORw==' }] } });
    assert.equal(campo('hospedes').value, 'Maria da Silva, CPF 123.456.789-00\nLuiz Antônio da Silva, RG 2392336 SDS/PE');
    assert.equal(campo('veiculos').value, 'HB20, RZW5I32');
    assert.match(campo('corpo').value, /2\. Luiz Antônio da Silva \| RG 2392336 \| SDS\/PE\n\nVeículos autorizados:\n— HB20 \| RZW5I32/);
    assert.equal(texto('#ptFoto'), 'Ler print ou foto');
    assert.equal($('#ptFoto').disabled, false);
  });
  test('sem reserva escolhida: casa e entrada do print acham a reserva', async () => {
    banco().funcoes['portaria-ler'] = () => LIDO({ hospedes: [{ nome: 'Bia Lima', documento: 'CPF 11122233344' }], casa: 'QS40', checkin: '2026-10-25', checkout: '2026-10-30' });
    A.portariaForm();
    preencher($('#modal'), { bk: '' });
    await anexar(png());
    assert.equal(campo('bk').value, 'b2');
    assert.match(campo('hospedes').value, /Bia Lima, CPF 111\.222\.333-44$/);
  });
  test('sem reserva no Hub: preenche casa e datas; avisos da IA aparecem para conferir', async () => {
    banco().funcoes['portaria-ler'] = () => LIDO({ hospedes: [{ nome: 'Caio Prado', documento: '' }], casa: 'QS50', checkin: '2026-12-28', checkout: '2027-01-02', avisos: ['documento do Caio não aparece no print'] });
    A.portariaForm();
    preencher($('#modal'), { bk: '' });
    await anexar(png());
    assert.deepEqual([campo('casa').value, campo('checkin').value, campo('checkout').value], ['QS50', '2026-12-28', '2027-01-02']);
    assert.equal(campo('assunto').value, 'Autorização de Acesso — Casa Terracota QS50 — Hóspedes (28/12/2026 a 02/01/2027)');
    assert.equal(texto('#ptAviso'), 'Sem documento: Caio Prado. Conferir: documento do Caio não aparece no print.');
  });
  test('print de outra casa que a reserva escolhida: avisa e não troca a reserva', async () => {
    banco().funcoes['portaria-ler'] = () => LIDO({ hospedes: [{ nome: 'Lia Souza', documento: 'RG 1234567' }], casa: 'QS40', checkin: '2026-10-25' });
    A.portariaForm(S.bookings.find(b => b.id === 'b1'));
    await anexar(png());
    assert.equal(campo('bk').value, 'b1');
    assert.match(texto('#ptAviso'), /Conferir: o print fala de Casa Azul em 25 out, diferente da reserva escolhida\.$/);
  });
  test('colar (Ctrl+V) uma imagem no campo lê o print; texto colado segue normal', async () => {
    banco().funcoes['portaria-ler'] = () => LIDO({ hospedes: [{ nome: 'Ana Paula Moura', documento: 'CPF 12345678900' }] });
    A.portariaForm(S.bookings.find(b => b.id === 'b1'));
    const n = banco().invocacoes.length;
    let evitado = false;
    campo('cru').onpaste({ clipboardData: { files: [] }, preventDefault: () => (evitado = true) });
    assert.equal(evitado, false);
    campo('cru').onpaste({ clipboardData: { files: [png()] }, preventDefault: () => (evitado = true) });
    await esperar(15);
    assert.equal(evitado, true);
    assert.equal(banco().invocacoes.length, n + 1);
    assert.match(campo('hospedes').value, /Ana Paula Moura, CPF 123\.456\.789-00/);
  });
  test('erro da função aparece e o botão volta', async () => {
    banco().funcoes['portaria-ler'] = () => ({ error: 'tipo de arquivo não aceito: image/heic (use foto, print ou PDF)' });
    A.portariaForm();
    await anexar(new File(['x'], 'foto.heic', { type: 'image/heic' }));
    assert.equal(texto('#ptAviso'), 'Não consegui ler o arquivo: tipo de arquivo não aceito: image/heic (use foto, print ou PDF)');
    assert.equal($('#ptFoto').disabled, false);
  });
  test('arquivo que não é imagem nem PDF é ignorado', async () => {
    const n = banco().invocacoes.length;
    A.portariaForm();
    await anexar(new File(['x'], 'lista.txt', { type: 'text/plain' }));
    assert.equal(banco().invocacoes.length, n);
  });
});

describe('Consultar Airbnb', () => {
  const RESPOSTA = {
    checkin: '2026-11-10', checkout: '2026-11-13', noites: 3, adultos: 4,
    casas: [
      { id: 'QS39', nome: 'Casa Frida', status: 'livre', total: 1350, diaria: 450, link: 'https://www.airbnb.com.br/rooms/45895549' },
      { id: 'QS40', nome: 'Casa Azul', status: 'ocupada', alternativa: { checkin: '2026-11-14', checkout: '2026-11-17', total: 1500 }, link: 'https://x' },
      { id: 'QS50', nome: 'Casa Terracota', status: 'min_noites', min_noites: 4, link: 'https://y' },
    ],
    mensagem: 'Oi! Para 10 a 13/11 temos a Casa Frida por R$ 1.350.',
  };
  test('padrão: daqui a 7 dias, 3 noites, 2 hóspedes', async () => {
    await clicar('#abQuote');
    assert.equal(texto('#modalTitle'), 'Consultar Airbnb');
    assert.equal($('#modal [name=checkin]').value, '2026-10-26');
    assert.equal($('#modal [name=checkout]').value, '2026-10-29');
    assert.equal($('#modal [name=adultos]').value, '2');
  });
  test('trocar a entrada para depois da saída empurra a saída 3 dias', () => {
    A.consultaAirbnb();
    preencher($('#modal'), { checkin: '2026-11-20' });
    assert.equal($('#modal [name=checkout]').value, '2026-11-23');
  });
  test('saída antes da entrada não consulta', async () => {
    const n = banco().invocacoes.length;
    A.consultaAirbnb({ checkin: '2026-11-10', checkout: '2026-11-09' });
    await clicar('#abGo');
    assert.match(texto('#abRes'), /saída precisa ser depois da entrada/);
    assert.equal(banco().invocacoes.length, n);
  });
  test('mostra as 3 casas e a mensagem pronta; copiar', async () => {
    banco().funcoes['airbnb-quote'] = () => RESPOSTA;
    A.consultaAirbnb({ checkin: '2026-11-10', checkout: '2026-11-13', adultos: 4 });
    await clicar('#abGo', 10);
    assert.deepEqual(banco().invocacoes.at(-1), { nome: 'airbnb-quote', body: { checkin: '2026-11-10', checkout: '2026-11-13', adultos: 4 } });
    assert.equal(texto('.ab-cab'), '10 nov a 13 nov · 3 noites · 4 hóspedes · preços do Airbnb');
    const casas = $$('.ab-list li').map(l => nb(texto(l)));
    assert.deepEqual(casas, [
      'Casa Fridaver no Airbnb DisponívelR$ 1.350R$ 450 por noite',
      'Casa Azulver no Airbnb Ocupadalivre de 14 nov a 17 nov por R$ 1.500',
      'Casa Terracotaver no Airbnb Mínimo de noitesmínimo 4 noites',
    ]);
    assert.equal($('#abMsg').value, RESPOSTA.mensagem);
    await clicar('#abCopy');
    assert.equal(await navigator.clipboard.readText(), RESPOSTA.mensagem);
    assert.equal(texto('#toast'), 'Mensagem copiada');
    assert.equal($('#abGo').disabled, false);
  });
  test('erro da função aparece na tela', async () => {
    banco().funcoes['airbnb-quote'] = () => ({ error: 'Airbnb fora do ar' });
    A.consultaAirbnb({ checkin: '2026-11-10', checkout: '2026-11-13' });
    await clicar('#abGo', 10);
    assert.equal(texto('#abRes'), 'Não foi possível consultar: Airbnb fora do ar');
  });
  test('falha de rede ao chamar a função também aparece', async () => {
    banco().funcoes['airbnb-quote'] = () => { throw new Error('Failed to send a request to the Edge Function'); };
    A.consultaAirbnb({ checkin: '2026-11-10', checkout: '2026-11-13' });
    await clicar('#abGo', 10);
    assert.match(texto('#abRes'), /Failed to send a request/);
  });
  test('Enter num campo também consulta', async () => {
    banco().funcoes['airbnb-quote'] = () => RESPOSTA;
    const n = banco().invocacoes.length;
    A.consultaAirbnb({ checkin: '2026-11-10', checkout: '2026-11-13' });
    $('#modal [name=adultos]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await esperar(10);
    assert.equal(banco().invocacoes.length, n + 1);
  });
});
