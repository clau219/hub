// Edge Function ical-feed: calendários iCal do Hub (aluguéis, reservas diretas por casa para o Airbnb, gigs de DJ).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido } from '../helpers/funcao.js';
import { novoBanco } from '../helpers/fake-supabase.js';

let fn;
const DADOS = () => ({
  app_config: [{ key: 'feed_token', value: 'segredo' }],
  properties: [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }],
  contacts: [{ id: 'c1', nome: 'Ana Souza' }],
  bookings: [
    { id: 'b1', property_id: 'QS39', origem: 'airbnb', status: 'confirmada', hospede: 'Hóspede Airbnb', checkin: '2026-10-25', checkout: '2026-10-28' },
    { id: 'b2', property_id: 'QS39', origem: 'direto', status: 'confirmada', hospede: 'Marina Prado Lins', checkin: '2026-11-01', checkout: '2026-11-04', notas: 'Chega tarde, 3 carros; pet' },
    { id: 'b3', property_id: 'QS39', origem: 'direto', status: 'bloqueio', checkin: '2026-11-10', checkout: '2026-11-12' },
    { id: 'b4', property_id: 'QS39', origem: null, status: 'confirmada', hospede: null, checkin: '2026-11-15', checkout: '2026-11-16' },
    { id: 'b5', property_id: 'QS39', origem: 'booking', status: 'cancelada', hospede: 'Cancelado', checkin: '2026-11-20', checkout: '2026-11-22' },
    { id: 'b6', property_id: 'QS40', origem: 'booking', status: 'confirmada', hospede: 'Pedro', checkin: '2026-11-01', checkout: '2026-11-03' },
    { id: 'b7', property_id: 'QS39', origem: 'direto', status: 'confirmada', hospede: 'Antigo', checkin: '2026-01-01', checkout: '2026-01-05' },
    { id: 'b8', property_id: 'QS39', origem: 'direto', status: 'confirmada', hospede: 'Saiu hoje', checkin: '2026-10-15', checkout: '2026-10-19' },
  ],
  deals: [
    { id: 'd1', negocio: 'dj', etapa: 'fechado', titulo: 'Casamento', contato_id: 'c1', data_evento: '2026-11-07', hora_inicio: '22:00:00', hora_fim: '03:00:00', local: 'Pipa, RN' },
    { id: 'd2', negocio: 'dj', etapa: 'pago', titulo: 'Aniversário', data_evento: '2026-11-14', hora_inicio: null },
    { id: 'd3', negocio: 'dj', etapa: 'realizado', titulo: 'Sem fim', data_evento: '2026-11-21', hora_inicio: '20:00:00' },
    { id: 'd4', negocio: 'dj', etapa: 'lead', titulo: 'Provisório', data_evento: '2026-11-28' },
    { id: 'd5', negocio: 'consultoria', etapa: 'fechado', titulo: 'Obra', data_evento: '2026-11-28' },
  ],
});
const eventos = ics => ics.split('BEGIN:VEVENT').slice(1).map(b => Object.fromEntries(b.split('\r\n').filter(l => l.includes(':') && !l.startsWith('END')).map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)])));
const get = async q => fn(pedido('/ical-feed?' + q, { metodo: 'GET', auth: null }));
before(async () => { fn = await carregarFuncao('ical-feed'); });
beforeEach(() => novoBanco(DADOS()));

describe('ical-feed', () => {
  test('sem token ou com token errado: 401', async () => {
    assert.equal((await get('cal=alugueis')).status, 401);
    assert.equal((await get('cal=alugueis&token=errado')).status, 401);
  });
  test('aluguéis: todas as reservas ativas, com título por casa e notas escapadas', async () => {
    const r = await get('token=segredo');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/calendar; charset=utf-8');
    const txt = await r.text();
    assert.match(txt, /^BEGIN:VCALENDAR\r\nVERSION:2\.0/);
    assert.match(txt, /X-WR-CALNAME:Hub: Aluguéis/);
    const ev = eventos(txt);
    assert.deepEqual(ev.map(e => e.UID).sort(), ['bk-b1@hub', 'bk-b2@hub', 'bk-b3@hub', 'bk-b4@hub', 'bk-b6@hub', 'bk-b8@hub']);
    const b2 = ev.find(e => e.UID === 'bk-b2@hub');
    assert.equal(b2.SUMMARY, 'Casa Frida: Marina Prado Lins (direto)');
    assert.equal(b2['DTSTART;VALUE=DATE'], '20261101');
    assert.equal(b2['DTEND;VALUE=DATE'], '20261104');
    assert.equal(b2.DESCRIPTION, 'Chega tarde\\, 3 carros\\; pet');
    assert.equal(ev.find(e => e.UID === 'bk-b3@hub').SUMMARY, 'Casa Frida: bloqueado');
    assert.equal(b2.DTSTAMP, '20261019T150000Z');
  });
  test('reserva sem origem não mostra "(null)" no título', { todo: 'ical-feed: no cal=alugueis o título usa (${b.origem}) mesmo quando origem é null → "Casa Frida: reserva (null)"' }, async () => {
    const ev = eventos(await (await get('token=segredo')).text());
    assert.doesNotMatch(ev.find(e => e.UID === 'bk-b4@hub').SUMMARY, /null/);
  });
  test('diretas: exige a casa', async () => {
    assert.equal((await get('cal=diretas&token=segredo')).status, 400);
  });
  test('diretas: só o que não veio do Airbnb, só primeiro nome, sem passado', async () => {
    const ev = eventos(await (await get('cal=diretas&casa=QS39&token=segredo')).text());
    assert.deepEqual(ev.map(e => [e.UID, e.SUMMARY]), [
      ['dir-b2@hub', 'Direta: Marina (Hub)'],
      ['dir-b3@hub', 'Bloqueio (Hub)'],
      ['dir-b4@hub', 'Reserva (Hub)'],
      ['dir-b8@hub', 'Direta: Saiu (Hub)'],
    ]);
    assert.ok(ev.every(e => !e.DESCRIPTION), 'nada de notas ou documentos no feed que vai para o Airbnb');
  });
  test('diretas de outra casa: Booking aparece', async () => {
    const ev = eventos(await (await get('cal=diretas&casa=QS40&token=segredo')).text());
    assert.deepEqual(ev.map(e => e.SUMMARY), ['Booking: Pedro (Hub)']);
  });
  test('dj: gigs fechadas/realizadas/pagas, com horário de Pipa e virada da meia-noite', async () => {
    const txt = await (await get('cal=dj&token=segredo')).text();
    assert.match(txt, /X-WR-CALNAME:Hub: Gigs DJ/);
    const ev = eventos(txt);
    assert.deepEqual(ev.map(e => e.UID).sort(), ['deal-d1@hub', 'deal-d2@hub', 'deal-d3@hub']);
    const d1 = ev.find(e => e.UID === 'deal-d1@hub');
    assert.equal(d1.SUMMARY, 'DJ CLAU: Ana Souza');
    assert.equal(d1.DTSTART, '20261108T010000Z'); // 22h em Pipa
    assert.equal(d1.DTEND, '20261108T060000Z'); // 3h do dia seguinte
    assert.equal(d1.LOCATION, 'Pipa\\, RN');
    const d2 = ev.find(e => e.UID === 'deal-d2@hub');
    assert.equal(d2.SUMMARY, 'DJ CLAU: Aniversário');
    assert.equal(d2['DTSTART;VALUE=DATE'], '20261114');
    assert.equal(d2['DTEND;VALUE=DATE'], '20261115');
    const d3 = ev.find(e => e.UID === 'deal-d3@hub');
    assert.equal(d3.DTEND, '20261122T030000Z', 'sem fim: 4 horas de duração');
  });
});
