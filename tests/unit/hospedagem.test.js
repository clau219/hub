// hospedagem.js: sequência operacional de cada reserva (orçamento → faxina), hóspedes e texto da portaria.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/hub.js';

let H;
before(async () => { H = await hub('hospedagem.js'); });

const direta = (x = {}) => ({ id: 'b1', origem: 'direto', status: 'confirmada', checkin: '2026-11-20', checkout: '2026-11-23', ...x });

describe('etapas por origem', () => {
  test('reserva direta tem as 6 etapas; Airbnb e Booking só as 3 últimas', () => {
    assert.deepEqual(H.etapasDe(direta()).map(e => e.id), ['orcamento', 'contrato', 'assinatura', 'hospedes', 'portaria', 'faxina']);
    assert.deepEqual(H.etapasDe(direta({ origem: 'airbnb' })).map(e => e.id), ['hospedes', 'portaria', 'faxina']);
    assert.deepEqual(H.etapasDe(direta({ origem: 'booking' })).map(e => e.id), ['hospedes', 'portaria', 'faxina']);
    assert.equal(H.etapasDe(direta({ origem: null })).length, 6);
  });
  test('prazos contados do check-in: −21, −14, −10, −3, −2, −1 dias', () => {
    const b = direta();
    assert.deepEqual(H.etapasDe(b).map(e => H.prazo(b, e)), ['2026-10-30', '2026-11-06', '2026-11-10', '2026-11-17', '2026-11-18', '2026-11-19']);
  });
  test('feita/pendentes/progresso leem b.etapas', () => {
    const b = direta({ etapas: { orcamento: '2026-10-01', contrato: '2026-10-05' } });
    const [orc, , ass] = H.ETAPAS_HOSP;
    assert.equal(H.feita(b, orc), true);
    assert.equal(H.feita(b, ass), false);
    assert.deepEqual(H.pendentes(b).map(e => e.id), ['assinatura', 'hospedes', 'portaria', 'faxina']);
    const p = H.progresso(b);
    assert.equal(p.feitas, 2);
    assert.equal(p.total, 6);
    assert.equal(p.proxima.id, 'assinatura');
  });
  test('progresso com tudo feito não tem próxima', () => {
    const b = direta({ origem: 'airbnb', etapas: { hospedes: 'x', portaria: 'x', faxina: 'x' } });
    assert.deepEqual({ ...H.progresso(b), proxima: H.progresso(b).proxima ?? null }, { feitas: 3, total: 3, proxima: null });
  });
  test('acompanhada: só confirmada e com check-in hoje ou depois', () => {
    assert.equal(H.acompanhada(direta()), true);
    assert.equal(H.acompanhada(direta({ checkin: '2026-10-19' })), true);
    assert.equal(H.acompanhada(direta({ checkin: '2026-10-18' })), false);
    assert.equal(H.acompanhada(direta({ status: 'bloqueio' })), false);
    assert.equal(H.acompanhada(direta({ status: 'cancelada' })), false);
  });
});

describe('alternar etapa', () => {
  test('marcar grava a data de hoje e não sobrescreve data antiga', () => {
    assert.deepEqual(H.alternar(direta(), 'contrato', true), { contrato: '2026-10-19' });
    assert.deepEqual(H.alternar(direta({ etapas: { contrato: '2026-10-01' } }), 'contrato', true), { contrato: '2026-10-01' });
  });
  test('desmarcar remove e não altera o objeto original', () => {
    const b = direta({ etapas: { contrato: '2026-10-01', orcamento: '2026-09-30' } });
    assert.deepEqual(H.alternar(b, 'contrato', false), { orcamento: '2026-09-30' });
    assert.deepEqual(b.etapas, { contrato: '2026-10-01', orcamento: '2026-09-30' });
  });
});

describe('hóspedes', () => {
  test('parseHospedes aceita vírgula, ponto e vírgula, travessão e tab', () => {
    assert.deepEqual(H.parseHospedes('Maria Silva, RG 1.234\nJoão; CPF 123\nAna – 999\nPedro\tPassaporte X\n\n  Lia  '), [
      { nome: 'Maria Silva', doc: 'RG 1.234' }, { nome: 'João', doc: 'CPF 123' }, { nome: 'Ana', doc: '999' },
      { nome: 'Pedro', doc: 'Passaporte X' }, { nome: 'Lia', doc: '' },
    ]);
    assert.deepEqual(H.parseHospedes(''), []);
    assert.deepEqual(H.parseHospedes(null), []);
  });
  test('nome com hífen (Ana-Clara) não é separado', () => {
    assert.deepEqual(H.parseHospedes('Ana-Clara Souza'), [{ nome: 'Ana-Clara Souza', doc: '' }]);
  });
  test('hospedesTxt é o inverso de parseHospedes', () => {
    const txt = 'Maria Silva, RG 1\nPedro';
    assert.equal(H.hospedesTxt(H.parseHospedes(txt)), txt);
    assert.equal(H.hospedesTxt(null), '');
  });
});

// E-mail real enviado pelo Claudio à portaria (outubro/2026)
const MODELO = `Segue abaixo a lista de hóspedes autorizados para o período de 16/10/2026 a 21/10/2026:

Casa Frida QS39

1. Mauricio Batista da Silva Júnior | CPF 433.935.708-11
2. Luiz Antônio da Silva | RG 2392336 | SDS/PE
3. Lucineide Anjos da Silva | RG 3797768 | SDS/PE
4. Josias Pedrosa da Silva | RG 1146627 | SSP/PE
5. Flávia Pedrosa da Silva | RG 6204884 | SSP/PE
6. Letice Maria da Silva | RG 57.720.661-8 | SSP/SP
7. Mauricio Batista da Silva | RG 19.229.524-X | SSP/SP

Veículos autorizados:
— Honda HRV | TZX3D00
— HB20 | RZW5I32

Solicito a liberação de acesso para os hóspedes listados acima durante o período indicado.

Qualquer dúvida, fico à disposição.

Atenciosamente,
Claudio Braga`;

describe('e-mail da portaria', () => {
  const FRIDA = { id: 'QS39', nome: 'Casa Frida' };
  test('assunto no formato fixo, com a casa e o período', () => {
    assert.equal(H.emailPortaria(direta(), FRIDA).assunto, 'Autorização de Acesso — Casa Frida QS39 — Hóspedes (20/11 a 23/11/2026)');
  });
  test('virando o ano, a entrada também leva o ano', () => {
    assert.equal(H.emailPortaria(direta({ checkin: '2026-12-28', checkout: '2027-01-02' }), { id: 'QS40', nome: 'Casa Azul' }).assunto,
      'Autorização de Acesso — Casa Azul QS40 — Hóspedes (28/12/2026 a 02/01/2027)');
  });
  test('corpo no modelo do Claudio: período, casa, lista "nome | documento | órgão", sem saudação', () => {
    const { corpo } = H.emailPortaria(direta({ hospedes: [{ nome: 'Maria', doc: 'RG 1.234 SSP/PE' }, { nome: 'Pedro', doc: '' }] }), FRIDA);
    assert.equal(corpo, `Segue abaixo a lista de hóspedes autorizados para o período de 20/11/2026 a 23/11/2026:

Casa Frida QS39

1. Maria | RG 1.234 | SSP/PE
2. Pedro | documento a enviar

Solicito a liberação de acesso para os hóspedes listados acima durante o período indicado.

Qualquer dúvida, fico à disposição.

Atenciosamente,
Claudio Braga`);
  });
  test('o e-mail real do Claudio colado como texto cru gera o mesmo e-mail, com os veículos', () => {
    const hospedes = H.lerHospedesCru(MODELO), veiculos = H.lerVeiculosCru(MODELO);
    assert.equal(hospedes.length, 7);
    assert.deepEqual(veiculos, [{ modelo: 'Honda HRV', placa: 'TZX3D00' }, { modelo: 'HB20', placa: 'RZW5I32' }]);
    const e = H.emailPortaria({ checkin: '2026-10-16', checkout: '2026-10-21', hospedes, veiculos }, FRIDA);
    assert.equal(e.assunto, 'Autorização de Acesso — Casa Frida QS39 — Hóspedes (16/10 a 21/10/2026)');
    assert.equal(e.corpo, MODELO);
  });
  test('sem hóspedes avisa que a lista falta', () => {
    const { corpo } = H.emailPortaria(direta(), { nome: 'Casa Azul' });
    assert.match(corpo, /\(lista de hóspedes ainda não preenchida\)/);
    assert.doesNotMatch(corpo, /undefined/);
  });
});

describe('dados crus dos hóspedes', () => {
  test('lista numerada de conversa do WhatsApp, com nome em maiúsculas e CPF sem pontos', () => {
    assert.deepEqual(H.lerHospedesCru(`[10:32, 20/10/2026] Ana Paula: Segue os dados
1. MARIA DA SILVA - CPF 123.456.789-00
2. joão pedro souza 98765432100
3) Ana-Clara Lima, RG 1.234.567 SSP/PE`), [
      { nome: 'Maria da Silva', doc: 'CPF 123.456.789-00' },
      { nome: 'João Pedro Souza', doc: 'CPF 987.654.321-00' },
      { nome: 'Ana-Clara Lima', doc: 'RG 1.234.567 SSP/PE' },
    ]);
  });
  test('blocos "Hóspede 01 / Nome / CPF / RG": fica o CPF; "todos os RGs são SSP/PE" vale para os RGs', () => {
    assert.deepEqual(H.lerHospedesCru(`Hóspede 01
Nome: Carlos Alberto Nunes
CPF: 111.222.333-44
RG: 5.555.555

Hóspede 02
Nome: Beatriz
RG: 6.666.666
todos os RGs são SSP/PE`), [
      { nome: 'Carlos Alberto Nunes', doc: 'CPF 111.222.333-44' },
      { nome: 'Beatriz', doc: 'RG 6.666.666 SSP/PE' },
    ]);
  });
  test('nome com número solto e passaporte; frases da conversa ficam de fora', () => {
    assert.deepEqual(H.lerHospedesCru('Bom dia! Somos 3 pessoas\nPedro Henrique Alves 12.345.678\nLucas Martins passaporte fx123456\nSegue a lista dos hóspedes'), [
      { nome: 'Pedro Henrique Alves', doc: '12.345.678' },
      { nome: 'Lucas Martins', doc: 'Passaporte FX123456' },
    ]);
  });
  test('documento na linha de baixo do nome (lista do Airbnb)', () => {
    assert.deepEqual(H.lerHospedesCru('Maria Souza\n123.456.789-00\nJosé Lima\nRG 9.999.999'), [
      { nome: 'Maria Souza', doc: 'CPF 123.456.789-00' }, { nome: 'José Lima', doc: 'RG 9.999.999' },
    ]);
  });
  test('juntarHospedes acrescenta sem repetir, completa o documento e aplica o órgão geral', () => {
    const r = H.juntarHospedes([{ nome: 'Beatriz Nunes', doc: 'RG 6.666.666' }, { nome: 'Caio Prado', doc: '' }],
      'todos os RGs são SSP/PE\nCAIO PRADO, CPF 22233344455\nLia Prado - RG 7.777.777');
    assert.deepEqual(r.lista, [
      { nome: 'Beatriz Nunes', doc: 'RG 6.666.666 SSP/PE' }, { nome: 'Caio Prado', doc: 'CPF 222.333.444-55' }, { nome: 'Lia Prado', doc: 'RG 7.777.777 SSP/PE' },
    ]);
    assert.equal(r.novos, 2);
    assert.equal(r.orgao, 'SSP/PE');
  });
  test('veículos: placa antiga ou Mercosul, com ou sem modelo; linha de veículo não vira hóspede', () => {
    const txt = 'Maria Souza, CPF 12345678900\nCarro: Fiat Uno placa abc-1234\nRZW5I32\nHonda HRV, TZX3D00';
    assert.deepEqual(H.lerVeiculosCru(txt), [{ modelo: 'Fiat Uno', placa: 'ABC1234' }, { modelo: '', placa: 'RZW5I32' }, { modelo: 'Honda HRV', placa: 'TZX3D00' }]);
    assert.deepEqual(H.lerHospedesCru(txt), [{ nome: 'Maria Souza', doc: 'CPF 123.456.789-00' }]);
    assert.deepEqual(H.juntarVeiculos([{ modelo: 'HB20', placa: 'RZW5I32' }], 'HB20 RZW5I32\nGol QWE9R87').lista,
      [{ modelo: 'HB20', placa: 'RZW5I32' }, { modelo: 'Gol', placa: 'QWE9R87' }]);
    assert.deepEqual(H.parseVeiculos('Honda HRV, TZX3D00\nmoto vermelha'), [{ modelo: 'Honda HRV', placa: 'TZX3D00' }, { modelo: 'moto vermelha', placa: '' }]);
  });
  test('o formato salvo ("nome, documento") volta igual', () => {
    const l = H.lerHospedesCru('Maria da Silva - CPF 123.456.789-00');
    assert.deepEqual(H.parseHospedes(H.hospedesTxt(l)), l);
  });
});

describe('formulário (lerChecklist)', () => {
  test('lê as caixas et_*, remove do objeto e converte hóspedes', () => {
    const f = { et_orcamento: true, et_contrato: false, et_hospedes: true, hospedes: 'Maria, RG 1', nome: 'x' };
    const r = H.lerChecklist(f, { etapas: { contrato: '2026-10-01', portaria: '2026-10-10' } });
    assert.deepEqual(r.etapas, { orcamento: '2026-10-19', hospedes: '2026-10-19' });
    assert.deepEqual(r.hospedes, [{ nome: 'Maria', doc: 'RG 1' }]);
    assert.deepEqual(r.veiculos, []);
    assert.deepEqual(f, { nome: 'x' });
  });
  test('checklistHtml esconde as etapas exclusivas de reserva direta no Airbnb', () => {
    const html = H.checklistHtml({ origem: 'airbnb', checkin: '2026-11-20', etapas: {} });
    assert.equal((html.match(/data-direto hidden/g) || []).length, 3);
    assert.match(html, /name="et_faxina"/);
    const dir = H.checklistHtml({ origem: 'direto', checkin: '2026-10-25', etapas: { orcamento: '2026-10-01' } });
    assert.doesNotMatch(dir, /data-direto hidden/);
    assert.match(dir, /name="et_orcamento" checked/);
    assert.match(dir, /feito 1 out/);
    assert.match(dir, /late-lbl/); // contrato venceu em 11/10
  });
});
