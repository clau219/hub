// relatorio.js + relatorio-pdf.js: relatório mensal da casa para o proprietário (cálculo, e-mail e PDF).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/hub.js';

let R, P;
before(async () => { R = await hub('relatorio.js'); P = await hub('relatorio-pdf.js'); });

const FRIDA = { id: 'QS39', nome: 'Casa Frida', cor: '#c2410c' };
const bk = (id, checkin, checkout, x = {}) => ({ id, property_id: 'QS39', origem: 'direto', status: 'confirmada', hospede: 'Ana', checkin, checkout, valor: 1000, ...x });
const BOOKINGS = [
  bk('a', '2026-09-29', '2026-10-02', { valor: 900 }),                         // entrou em setembro: 1 noite em outubro, receita fora
  bk('b', '2026-10-10', '2026-10-15', { hospede: 'Bia', valor: 2500 }),
  bk('c', '2026-10-30', '2026-11-03', { hospede: 'Hóspede Airbnb', origem: 'airbnb', valor: null }), // entra em outubro: receita toda aqui
  bk('d', '2026-10-20', '2026-10-22', { status: 'cancelada' }),
  bk('e', '2026-10-05', '2026-10-07', { property_id: 'QS40' }),
  bk('f', '2026-11-20', '2026-11-23', { hospede: 'Caio' }),
  bk('g', '2027-03-01', '2027-03-05', { hospede: 'Longe' }),                   // além de 90 dias
];
const TX = [
  { id: 't1', data: '2026-10-05', descricao: 'Faxina Maria', valor: -150, negocio: 'alugueis', casa: 'QS39' },
  { id: 't2', data: '2026-10-12', descricao: 'Cosern', valor: -230.45, negocio: 'alugueis', casa: 'QS39' },
  { id: 't3', data: '2026-10-12', descricao: 'Repasse Airbnb', valor: 1800, negocio: 'alugueis', casa: 'QS39' }, // entrada: fora
  { id: 't4', data: '2026-10-14', descricao: 'Faxina Azul', valor: -150, negocio: 'alugueis', casa: 'QS40' },
  { id: 't5', data: '2026-11-01', descricao: 'Novembro', valor: -99, negocio: 'alugueis', casa: 'QS39' },
  { id: 't6', data: '2026-10-08', descricao: 'Material de limpeza', valor: -80, negocio: 'alugueis', casa: null },
  { id: 't7', data: '2026-10-08', descricao: 'Mercado', valor: -300, negocio: 'pessoal', casa: null },
];

describe('meses', () => {
  test('mês anterior, rótulo e limites', () => {
    assert.equal(R.mesAnterior('2026-11-02'), '2026-10');
    assert.equal(R.mesAnterior('2027-01-15'), '2026-12');
    assert.equal(R.rotuloMes('2026-03'), 'março/2026');
    assert.deepEqual(R.limitesMes('2026-12'), { ini: '2026-12-01', fim: '2027-01-01', dias: 31 });
    assert.equal(R.limitesMes('2028-02').dias, 29);
  });
});

describe('outras despesas digitadas', () => {
  test('descrição e valor em vários formatos; linha sem valor é ignorada', () => {
    assert.deepEqual(R.lerAjustes('Faxina extra 150\nLâmpadas; 42,90\nConserto do portão - R$ 1.200,00\nPintura 1.500\nsó texto\n\nCrédito do hóspede -50'), [
      { descricao: 'Faxina extra', valor: 150 }, { descricao: 'Lâmpadas', valor: 42.9 }, { descricao: 'Conserto do portão', valor: 1200 },
      { descricao: 'Pintura', valor: 1500 }, { descricao: 'Crédito do hóspede', valor: -50 }]);
  });
  test('volta ao texto que a pessoa digitou', () => {
    assert.equal(R.ajustesTxt([{ descricao: 'Lâmpadas', valor: 42.9 }, { descricao: 'Faxina', valor: 150 }]), 'Lâmpadas 42,9\nFaxina 150');
    assert.deepEqual(R.lerAjustes(R.ajustesTxt([{ descricao: 'Lâmpadas', valor: 42.9 }])), [{ descricao: 'Lâmpadas', valor: 42.9 }]);
  });
});

describe('montarRelatorio', () => {
  const rel = (x = {}) => R.montarRelatorio({ casa: FRIDA, mes: '2026-10', bookings: BOOKINGS, tx: TX, dono: { nome: 'Maria Souza', email: 'maria@ex.com', comissao_pct: 20 }, ...x });
  test('reservas com entrada no mês; Airbnb sem valor fica marcado', () => {
    const r = rel();
    assert.deepEqual(r.reservas.map(b => [b.id, b.noites, b.valor]), [['b', 5, 2500], ['c', 4, null]]);
    assert.equal(r.semValor, 1);
    assert.equal(r.receita, 2500);
  });
  test('ocupação conta só as noites dentro do mês, inclusive de reservas que cruzam o mês', () => {
    const r = rel();
    assert.deepEqual([r.noites, r.dias, r.ocupacao], [1 + 5 + 2, 31, 26]);
  });
  test('despesas: só saídas de Aluguéis da casa no mês, menos as desmarcadas, mais as digitadas', () => {
    assert.deepEqual(rel().despesas.map(d => [d.id, d.valor]), [['t1', 150], ['t2', 230.45]]);
    const r = rel({ excluidas: ['t1'], ajustes: [{ descricao: 'Faxina extra', valor: 150 }] });
    assert.deepEqual(r.despesas.map(d => [d.descricao, d.valor]), [['Cosern', 230.45], ['Faxina extra', 150]]);
    assert.equal(r.totalDespesas, 380.45);
  });
  test('comissão sobre a receita e repasse com centavos', () => {
    const r = rel({ bookings: BOOKINGS.map(b => b.id === 'c' ? { ...b, valor: 1777.77 } : b) });
    assert.equal(r.receita, 4277.77);
    assert.equal(r.comissao, 855.55);
    assert.equal(r.repasse, 3041.77);
    assert.equal(r.semValor, 0);
  });
  test('valor 0 vale (estadia do próprio dono); sem comissão cadastrada = 0', () => {
    const r = rel({ dono: {}, bookings: BOOKINGS.map(b => b.id === 'c' ? { ...b, valor: 0 } : b) });
    assert.deepEqual([r.semValor, r.comissaoPct, r.comissao, r.repasse], [0, 0, 0, 2500 - 380.45]);
  });
  test('próximas reservas: depois do mês, até 90 dias', () => {
    assert.deepEqual(rel().proximas.map(b => b.hospede), ['Caio']);
  });
  test('despesas de Aluguéis sem casa definida, para a revisão', () => {
    assert.deepEqual(R.despesasSemCasa(TX, '2026-10').map(t => t.id), ['t6']);
  });
});

describe('e-mail', () => {
  test('assunto, resumo e nome do anexo sem acento', () => {
    const r = R.montarRelatorio({ casa: FRIDA, mes: '2026-10', bookings: BOOKINGS.map(b => b.id === 'c' ? { ...b, valor: 1500 } : b), tx: TX, dono: { nome: 'Maria Souza', comissao_pct: 20 } });
    const e = R.emailRelatorio(r);
    assert.equal(e.assunto, 'Relatório de outubro/2026 — Casa Frida');
    assert.equal(e.arquivo, 'Relatorio Casa Frida 2026-10.pdf');
    const nb = s => s.replace(/ /g, ' ');
    assert.equal(nb(e.corpo), [
      'Olá, Maria!', '', 'Segue em anexo o relatório de outubro/2026 da Casa Frida.', '', 'Resumo:',
      '• Reservas: 2 (8 noites ocupadas, ocupação de 26%)', '• Receita: R$ 4.000,00', '• Despesas: R$ 380,45',
      '• Comissão de administração (20%): R$ 800,00', '• Valor a repassar: R$ 2.819,55', '',
      'Qualquer dúvida, fico à disposição.', '', 'Atenciosamente,', 'Claudio Braga'].join('\n'));
  });
  test('saldo negativo e sem comissão', () => {
    const r = R.montarRelatorio({ casa: FRIDA, mes: '2026-10', bookings: [], tx: TX, dono: {} });
    const e = R.emailRelatorio(r);
    assert.match(e.corpo, /^Olá!\n/);
    assert.doesNotMatch(e.corpo, /Comissão/);
    assert.match(e.corpo.replace(/ /g, ' '), /• Saldo negativo do mês: R\$ 380,45/);
  });
});

describe('PDF', () => {
  const latin1 = bytes => String.fromCharCode(...bytes);
  // Textos desenhados: <hex> Tj em WinAnsi
  const textos = s => [...s.matchAll(/<([0-9a-f]+)> Tj/g)].map(m => m[1].match(/../g).map(x => String.fromCharCode(parseInt(x, 16))).join(''));
  const relCheio = (n = 3) => R.montarRelatorio({ casa: FRIDA, mes: '2026-10', tx: TX, dono: { nome: 'Maria Souza', comissao_pct: 20 },
    bookings: Array.from({ length: n }, (_, i) => bk('x' + i, '2026-10-' + String(1 + (i % 28)).padStart(2, '0'), '2026-10-' + String(2 + (i % 28)).padStart(2, '0'), { hospede: 'Hóspede ' + i, valor: 200 })) });

  test('arquivo PDF válido: cabeçalho, tabela xref apontando para cada objeto, trailer', () => {
    const s = latin1(P.pdfRelatorio(relCheio(), { hoje: '2026-11-02' }));
    assert.ok(s.startsWith('%PDF-1.4\n'));
    assert.ok(s.endsWith('%%EOF\n'));
    const xref = +s.match(/startxref\n(\d+)/)[1];
    assert.ok(s.slice(xref).startsWith('xref\n'));
    const offs = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => +m[1]);
    offs.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj\n`), `objeto ${i + 1}`));
    // /Length bate com o conteúdo
    for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) assert.equal(s.slice(m.index + m[0].length + +m[1], m.index + m[0].length + +m[1] + 10), '\nendstream');
  });
  test('textos com acento em WinAnsi: casa, dono, valores, seções e rodapé', () => {
    const t = textos(latin1(P.pdfRelatorio(relCheio(), { hoje: '2026-11-02' })));
    for (const x of ['RELATÓRIO MENSAL DO PROPRIETÁRIO', 'Casa Frida', 'Maria Souza', 'Reservas com entrada no mês', 'Hóspede 0', 'Despesas da casa',
      'Faxina Maria', 'Fechamento', 'Valor a repassar', 'Próximas reservas (90 dias)', '1/1']) assert.ok(t.includes(x), x);
    assert.ok(t.includes('QS39 · Condomínio Pipa Natureza · outubro/2026'));
    assert.ok(t.some(x => x.startsWith('Gerado pelo Hub em 02/11/2026')));
    assert.ok(t.includes('R$ 600,00')); // receita das 3 reservas
  });
  test('muitas reservas quebram a página e repetem o cabeçalho da tabela; rodapé com o total', () => {
    const s = latin1(P.pdfRelatorio(relCheio(60), { hoje: '2026-11-02' }));
    const paginas = +s.match(/\/Count (\d+)/)[1];
    assert.ok(paginas >= 2);
    const t = textos(s);
    assert.ok(t.filter(x => x === 'Hóspede').length >= 2);
    assert.ok(t.includes(`${paginas}/${paginas}`));
  });
  test('largura pelas métricas da Helvetica; texto longo é cortado com reticências', () => {
    assert.equal(P.largura('Aa', 10), (667 + 556) / 100);
    assert.equal(P.largura('ã', 10), P.largura('a', 10));
    assert.equal(P.largura('W', 10, true), 9.44);
    const c = P.cortar('Conserto completo do portão eletrônico da garagem', 80, 9);
    assert.ok(c.endsWith('…') && P.largura(c, 9) <= 80);
    assert.equal(P.cortar('curto', 80, 9), 'curto');
  });
  test('caracteres fora do WinAnsi viram "?"; travessão e marcador têm código próprio', () => {
    assert.deepEqual(['—', '•', 'ç', ' ', '😀'].map(P.codigo), [0x97, 0x95, 0xe7, 0xa0, 63]);
  });
});
