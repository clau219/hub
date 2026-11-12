// Função stays-email + _shared/stays-email.ts: aviso de reserva da Stays por e-mail completa a reserva do Hub.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, comCron } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';

let fn;
const TOKEN = 'tok-stays';
// Texto como o Gmail devolve (getPlainBody): copiado do e-mail real de teste de 12/11/2026 — \r\n, links entre < >,
// negrito como *texto*, espaço no fim das linhas e a frase do status quebrada no meio
const corpo = ({ cod = 'YY01J', status = 'reservado', nome = 'TESTE HUB', contato = '-', pessoas = 1, de = '08 jun 2027', ate = '09 jun 2027', valor = 'R$ 1.280,00', casa = 'Casa Frida no Condomínio Pipa Natureza', canal = '', comissao = '' } = {}) =>
  (` <http://stays.net>   Olá Claudio Braga,\n\n  A Reserva ${cod} <https://cbraga.stays.net/i/reservation/${cod}> está com\no status *${status}* atualmente.\n\n Seguem informações úteis sobre a Reserva em questão:\n\n` +
  `  Nome do Hóspede: ${nome} \n Contatos do Hóspede: ${contato} \n Número de Hóspedes: ${pessoas} \n Período da Estadia: de ${de} a ${ate} \n` +
  ` Número de Noites: 1\n Valor Total da Reserva: ${valor} \n Acomodação: ${casa} \n Canal de Venda: ${canal} \n Comissão do Canal: ${comissao} \n\n` +
  ` Para mais detalhes, não deixe de acessar a Página da Reserva <https://cbraga.stays.net/i/reservation/${cod}> na stays.net!`).replace(/\n/g, '\r\n');
const msg = (id, o = {}, data = '2026-10-19T12:00:00Z') => ({ id, assunto: `Stays.net | Atualização sobre a Reserva ${o.cod || 'YY01J'} | ${o.nome || 'TESTE HUB'}`, corpo: corpo(o), data });
const enviar = (mensagens, token = TOKEN) => fn(pedido('/stays-email', { corpo: { mensagens }, auth: null, headers: token ? { 'x-stays-token': token } : {} })).then(lerJson);
const PROPS = [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }, { id: 'QS50', nome: 'Casa Terracota' }];
const base = (bookings = []) => novoBanco(comCron({ app_secrets: [{ key: 'cron_token', value: comCron({}).app_secrets[0].value }, { key: 'stays_email_token', value: TOKEN }], properties: PROPS, bookings }));
const bk = id => banco().t('bookings').find(b => b.id === id);
const linha = cod => banco().t('stays_emails').find(e => e.codigo === cod);

before(async () => { fn = await carregarFuncao('stays-email'); });

describe('stays-email', () => {
  test('sem token ou token errado: 401', async () => {
    base();
    assert.equal((await enviar([msg('m1')], null)).status, 401);
    assert.equal((await enviar([msg('m1')], 'errado')).status, 401);
  });
  test('lê o e-mail real: código, status, hóspede, datas, valor, casa; contato "-" e canal vazio ficam nulos', async () => {
    base();
    const { corpo: r } = await enviar([msg('m1')]);
    assert.deepEqual([r.guardados, r.ids], [1, ['m1']]);
    const e = linha('YY01J');
    assert.deepEqual([e.status, e.hospede, e.contatos, e.pessoas, e.checkin, e.checkout, e.noites, e.valor, e.casa, e.canal, e.comissao],
      ['reservado', 'TESTE HUB', null, 1, '2027-06-08', '2027-06-09', 1, 1280, 'QS39', null, null]);
  });
  test('completa a reserva da Stays pelo código nas notas: valor, nome, canal Airbnb vira origem airbnb, linha nas notas', async () => {
    base([{ id: 'b1', property_id: 'QS40', checkin: '2026-11-20', checkout: '2026-11-23', status: 'confirmada', origem: 'outro', hospede: 'Hóspede (Stays)', valor: null, uid_externo: 'fs:abc', notas: 'Stays RG01J' }]);
    await enviar([msg('m1', { cod: 'RG01J', nome: 'Renata Lima', contato: '+55 84 99999-0000', pessoas: 4, de: '20 nov 2026', ate: '23 nov 2026', valor: 'R$ 2.345,67', casa: 'Casa Azul - Pipa Natureza', canal: 'Airbnb', comissao: 'R$ 351,85' })]);
    const b = bk('b1');
    assert.deepEqual([b.valor, b.hospede, b.origem], [2345.67, 'Renata Lima', 'airbnb']);
    assert.equal(b.notas, 'Stays RG01J\nE-mail Stays: canal Airbnb · 4 hóspedes · contato +55 84 99999-0000 · comissão do canal R$ 351,85');
    assert.equal(linha('RG01J').booking_id, 'b1');
  });
  test('e-mail antes da reserva: fica guardado e entra quando a reserva aparece (casa + datas, sem código nas notas)', async () => {
    base();
    await enviar([msg('m1', { cod: 'QY01J', nome: 'Anderson', de: '12 nov 2026', ate: '16 nov 2026', valor: 'R$ 3.000,00', casa: 'Casa Azul - Pipa Natureza', canal: 'Decolar' })]);
    assert.equal(linha('QY01J').aplicado_em, null);
    banco().t('bookings').push({ id: 'b2', property_id: 'QS40', checkin: '2026-11-12', checkout: '2026-11-16', status: 'confirmada', origem: 'outro', hospede: 'Hóspede (Stays)', valor: null, uid_externo: 'fs:qy', notas: null });
    const { corpo: r } = await fn(pedido('/stays-email', { corpo: {}, auth: 'cron' })).then(lerJson);
    assert.equal(r.aplicados, 1);
    assert.deepEqual([bk('b2').valor, bk('b2').hospede, bk('b2').origem], [3000, 'Anderson', 'outro']);
    assert.match(bk('b2').notas, /^Stays QY01J\nE-mail Stays: canal Decolar/);
  });
  test('não pisa no que você digitou; um e-mail de alteração atualiza o que veio do e-mail anterior', async () => {
    base([{ id: 'b1', property_id: 'QS39', checkin: '2026-12-01', checkout: '2026-12-03', status: 'confirmada', origem: 'outro', hospede: 'Maria (você digitou)', valor: 999, uid_externo: 'fs:a', notas: 'Stays AA01J' },
      { id: 'b2', property_id: 'QS39', checkin: '2026-12-10', checkout: '2026-12-12', status: 'confirmada', origem: 'outro', hospede: 'Hóspede (Stays)', valor: null, uid_externo: 'fs:b', notas: 'Stays BB01J' }]);
    await enviar([msg('m1', { cod: 'AA01J', nome: 'Maria Souza', valor: 'R$ 1.500,00' }), msg('m2', { cod: 'BB01J', nome: 'João', valor: 'R$ 800,00' })]);
    assert.deepEqual([bk('b1').valor, bk('b1').hospede], [999, 'Maria (você digitou)']);
    assert.deepEqual([bk('b2').valor, bk('b2').hospede], [800, 'João']);
    await enviar([msg('m3', { cod: 'BB01J', nome: 'João Pedro', valor: 'R$ 950,00' }, '2026-10-20T12:00:00Z')]);
    assert.deepEqual([bk('b2').valor, bk('b2').hospede], [950, 'João Pedro']);
    // e-mail mais velho que o guardado não volta atrás
    await enviar([msg('m0', { cod: 'BB01J', valor: 'R$ 1,00' }, '2026-10-01T12:00:00Z')]);
    assert.equal(bk('b2').valor, 950);
  });
  test('cancelado no e-mail cancela a reserva da Stays no Hub (reserva direta do Hub nunca)', async () => {
    base([{ id: 'b1', property_id: 'QS39', checkin: '2027-06-08', checkout: '2027-06-09', status: 'confirmada', origem: 'outro', hospede: 'Hóspede (Stays)', valor: null, uid_externo: 'fs:y', notas: 'Stays YY01J' }]);
    await enviar([msg('m1'), msg('m2', { status: 'cancelado' }, '2026-10-19T12:05:00Z')]);
    assert.equal(bk('b1').status, 'cancelada');
  });
  test('e-mail que não é aviso de reserva da Stays é ignorado mas confirmado (o script não reenvia)', async () => {
    base();
    const { corpo: r } = await enviar([{ id: 'x1', assunto: 'Promoção da Stays', corpo: 'Conheça o novo app' }]);
    assert.deepEqual([r.guardados, r.ignorados, r.ids], [0, 1, ['x1']]);
  });
});
