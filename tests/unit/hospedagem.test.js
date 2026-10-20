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
  test('textoPortaria lista hóspedes numerados com casa e datas', () => {
    const t = H.textoPortaria(direta({ hospedes: [{ nome: 'Maria', doc: 'RG 1' }, { nome: 'Pedro', doc: '' }] }), { id: 'QS39', nome: 'Casa Frida' });
    assert.match(t, /na Casa Frida \(QS39\), com entrada em 20\/11\/2026 e saída em 23\/11\/2026/);
    assert.match(t, /1\. Maria \(RG 1\)\n2\. Pedro\n/);
    assert.match(t, /Claudio$/);
  });
  test('textoPortaria sem hóspedes avisa que a lista falta', () => {
    assert.match(H.textoPortaria(direta(), { nome: 'Casa Azul' }), /\(lista de hóspedes ainda não preenchida\)/);
    assert.doesNotMatch(H.textoPortaria(direta(), { nome: 'Casa Azul' }), /\(undefined\)/);
  });
});

describe('formulário (lerChecklist)', () => {
  test('lê as caixas et_*, remove do objeto e converte hóspedes', () => {
    const f = { et_orcamento: true, et_contrato: false, et_hospedes: true, hospedes: 'Maria, RG 1', nome: 'x' };
    const r = H.lerChecklist(f, { etapas: { contrato: '2026-10-01', portaria: '2026-10-10' } });
    assert.deepEqual(r.etapas, { orcamento: '2026-10-19', hospedes: '2026-10-19' });
    assert.deepEqual(r.hospedes, [{ nome: 'Maria', doc: 'RG 1' }]);
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
