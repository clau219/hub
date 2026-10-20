// Edge Function ical-sync: lê os iCal (Airbnb → reservas, Google → agenda), com séries repetidas, exceções e proteções contra feed vazio.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, comCron } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let fn;
const AIRBNB = 'https://www.airbnb.com.br/calendar/ical/45895549.ics?s=x';
const GOOGLE = 'https://calendar.google.com/calendar/ical/dj%40group.calendar.google.com/private-x/basic.ics';
const cal = (...evs) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...evs.flatMap(e => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const FEED_AIRBNB = cal(
  ['DTSTART;VALUE=DATE:20261025', 'DTEND;VALUE=DATE:20261028', 'SUMMARY:Reserved', 'UID:res1@airbnb.com',
    'DESCRIPTION:Reservation URL: https://www.airbnb.com.br/hosting/reservations/details/HMXYZ\\nPhone Number (Last 4 Digits): 1234'],
  ['DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261103', 'SUMMARY:Airbnb (Not available)', 'UID:blk1@airbnb.com'],
  ['DTSTART;VALUE=DATE:20260901', 'DTEND;VALUE=DATE:20260905', 'SUMMARY:Reserved', 'UID:velha@airbnb.com'],
);
const FEED_GOOGLE = cal(
  ['DTSTART;TZID=America/Sao_Paulo:20261024T220000', 'DTEND;TZID=America/Sao_Paulo:20261025T020000', 'SUMMARY:Show no bar\\, com DJ', 'LOCATION:Pipa\\; RN', 'UID:show1@google.com'],
  ['DTSTART:20261030T150000Z', 'DTEND:20261030T160000Z', 'SUMMARY:Reunião UTC', 'UID:utc1@google.com'],
  ['DTSTART;VALUE=DATE:20261102', 'DTEND;VALUE=DATE:20261103', 'SUMMARY:Feriado', 'UID:dia1@google.com'],
  ['DTSTART:20261026T150000Z', 'SUMMARY:Cancelado', 'UID:canc1@google.com', 'STATUS:CANCELLED'],
  ['DTSTART:20261027T150000Z', 'SUMMARY:Gig do Hub', 'UID:hubd0123456789abcdef0123456789abcdef@google.com'],
  // série semanal às 22h de terça (01h de quarta em UTC), sem 27/10 e com 03/11 remarcada
  ['DTSTART;TZID=America/Sao_Paulo:20261020T220000', 'DTEND;TZID=America/Sao_Paulo:20261020T230000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Ensaio', 'UID:serie1@google.com',
    'EXDATE;TZID=America/Sao_Paulo:20261027T220000'],
  ['RECURRENCE-ID;TZID=America/Sao_Paulo:20261103T220000', 'DTSTART;TZID=America/Sao_Paulo:20261104T200000', 'DTEND;TZID=America/Sao_Paulo:20261104T210000', 'SUMMARY:Ensaio (mudou)', 'UID:serie1@google.com'],
);
const FONTES = [
  { id: 'fa', nome: 'Airbnb Frida', tipo: 'airbnb', calendario: 'alugueis', property_id: 'QS39', url: AIRBNB },
  { id: 'fg', nome: 'Google DJ', tipo: 'google', calendario: 'dj', url: GOOGLE },
];
const ler = (auth = 'cron') => fn(pedido('/ical-sync', { corpo: {}, auth })).then(lerJson);
const feeds = ({ airbnb = FEED_AIRBNB, google = FEED_GOOGLE } = {}) => {
  simular(AIRBNB, airbnb);
  simular(GOOGLE, google);
  simular('https://projeto.supabase.co/functions/v1/gcal-sync', { ok: true, criados: 0 });
};
before(async () => { fn = await carregarFuncao('ical-sync'); });
beforeEach(() => limparRede());

describe('ical-sync: acesso e resultado', () => {
  test('sem credencial: 401', async () => {
    novoBanco(comCron({ calendar_sources: FONTES }));
    assert.equal((await ler(null)).status, 401);
  });
  test('resultado, status em Ajustes, última leitura e chamada ao gcal-sync com a mesma credencial', async () => {
    novoBanco(comCron({ calendar_sources: FONTES }));
    feeds();
    const { corpo } = await ler();
    assert.deepEqual([corpo.reservas, corpo.eventos, corpo.erros], [2, 6, []]);
    assert.deepEqual(corpo.google, { ok: true, criados: 0 });
    assert.equal(chamadasPara(/gcal-sync/)[0].headers['x-hub-cron'], 'cron-teste');
    const st = JSON.parse(banco().t('app_config').find(c => c.key === 'ical_status').value);
    assert.deepEqual([st.eventos, st.reservas], [6, 2]);
    assert.ok(banco().t('calendar_sources').every(f => f.ultimo_sync === '2026-10-19T15:00:00.000Z'));
  });
});

describe('Airbnb → reservas', () => {
  test('reserva e bloqueio futuros; telefone e link vão para as notas; passado fica de fora', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[0]] }));
    feeds();
    await ler();
    const b = Object.fromEntries(banco().t('bookings').map(x => [x.uid_externo, x]));
    assert.deepEqual(Object.keys(b).sort(), ['fa:blk1@airbnb.com', 'fa:res1@airbnb.com']);
    const r = b['fa:res1@airbnb.com'];
    assert.deepEqual([r.property_id, r.checkin, r.checkout, r.status, r.origem, r.hospede], ['QS39', '2026-10-25', '2026-10-28', 'confirmada', 'airbnb', 'Hóspede Airbnb']);
    assert.equal(r.notas, 'Tel. final 1234\nhttps://www.airbnb.com.br/hosting/reservations/details/HMXYZ');
    assert.deepEqual([b['fa:blk1@airbnb.com'].status, b['fa:blk1@airbnb.com'].hospede], ['bloqueio', null]);
  });
  test('reserva já existente: atualiza datas sem apagar nome e valor digitados no Hub', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[0]], bookings: [{ id: 'b1', uid_externo: 'fa:res1@airbnb.com', property_id: 'QS39', checkin: '2026-10-24', checkout: '2026-10-27', status: 'confirmada', origem: 'airbnb', hospede: 'Marina', valor: 1800 }] }));
    feeds();
    await ler();
    const b = banco().t('bookings').find(x => x.id === 'b1');
    assert.deepEqual([b.checkin, b.checkout, b.hospede, b.valor], ['2026-10-25', '2026-10-28', 'Marina', 1800]);
    assert.equal(banco().t('bookings').filter(x => x.uid_externo === 'fa:res1@airbnb.com').length, 1);
  });
  test('reserva futura que sumiu do feed vira cancelada', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[0]], bookings: [{ id: 'b9', uid_externo: 'fa:sumiu@airbnb.com', property_id: 'QS39', checkin: '2026-12-01', checkout: '2026-12-05', status: 'confirmada' }] }));
    feeds();
    await ler();
    assert.equal(banco().t('bookings').find(x => x.id === 'b9').status, 'cancelada');
  });
  test('feed vazio não cancela nada (proteção) e avisa', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[0]], bookings: [{ id: 'b9', uid_externo: 'fa:x@airbnb.com', property_id: 'QS39', checkin: '2026-12-01', checkout: '2026-12-05', status: 'confirmada' }] }));
    feeds({ airbnb: cal() });
    const { corpo } = await ler();
    assert.equal(banco().t('bookings')[0].status, 'confirmada');
    assert.deepEqual(corpo.erros, ['Airbnb Frida: calendário veio vazio; 1 reserva(s) futura(s) mantida(s) sem cancelar']);
  });
  test('página de erro com HTTP 200 (não é iCal) não cancela nada', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[0]], bookings: [{ id: 'b9', uid_externo: 'fa:x@airbnb.com', property_id: 'QS39', checkin: '2026-12-01', checkout: '2026-12-05', status: 'confirmada' }] }));
    feeds({ airbnb: '<html>Faça login</html>' });
    const { corpo } = await ler();
    assert.equal(banco().t('bookings')[0].status, 'confirmada');
    assert.deepEqual(corpo.erros, ['Airbnb Frida: a resposta não é um calendário iCal']);
    assert.equal(banco().t('calendar_sources')[0].ultimo_sync, undefined);
  });
  test('HTTP 404 não tenta de novo; 429 tenta de novo e consegue', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[0]] }));
    simular(AIRBNB, { status: 404 });
    simular(/gcal-sync/, {});
    assert.deepEqual((await ler()).corpo.erros, ['Airbnb Frida: HTTP 404']);
    assert.equal(chamadasPara(AIRBNB).length, 1);
    limparRede();
    let n = 0;
    simular(AIRBNB, () => (++n === 1 ? { status: 429 } : FEED_AIRBNB));
    simular(/gcal-sync/, {});
    const { corpo } = await ler();
    assert.deepEqual([corpo.erros, corpo.reservas, n], [[], 2, 2]);
  });
});

describe('Google → agenda', () => {
  test('eventos com fuso de Pipa, UTC e dia inteiro; cancelados e os do próprio Hub ficam de fora', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[1]] }));
    feeds();
    await ler();
    const e = Object.fromEntries(banco().t('events').map(x => [x.uid_externo, x]));
    const show = e['fg:show1@google.com'];
    assert.deepEqual([show.titulo, show.local, show.inicio, show.fim, show.dia_inteiro, show.calendario, show.origem],
      ['Show no bar, com DJ', 'Pipa; RN', '2026-10-25T01:00:00.000Z', '2026-10-25T05:00:00.000Z', false, 'dj', 'google']);
    assert.equal(e['fg:utc1@google.com'].inicio, '2026-10-30T15:00:00.000Z');
    assert.deepEqual([e['fg:dia1@google.com'].inicio, e['fg:dia1@google.com'].fim, e['fg:dia1@google.com'].dia_inteiro], ['2026-11-02T12:00:00Z', null, true]);
    assert.ok(!e['fg:canc1@google.com']);
    assert.ok(!Object.keys(e).some(k => k.includes('hubd')), 'evento que o Hub escreveu no Google não volta');
  });
  test('série semanal vira uma linha por ocorrência, sem a data excluída e com a remarcada', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[1]] }));
    feeds();
    await ler();
    const serie = banco().t('events').filter(x => x.uid_externo.startsWith('fg:serie1')).sort((a, b) => a.inicio.localeCompare(b.inicio));
    assert.deepEqual(serie.map(x => [x.uid_externo, x.titulo, x.inicio, x.fim]), [
      ['fg:serie1@google.com#20261021T010000Z', 'Ensaio', '2026-10-21T01:00:00.000Z', '2026-10-21T02:00:00.000Z'],
      ['fg:serie1@google.com#20261104T010000Z', 'Ensaio (mudou)', '2026-11-04T23:00:00.000Z', '2026-11-05T00:00:00.000Z'],
      ['fg:serie1@google.com#20261111T010000Z', 'Ensaio', '2026-11-11T01:00:00.000Z', '2026-11-11T02:00:00.000Z'],
    ]);
  });
  test('linha antiga da série (sem #data) é apagada; evento futuro que sumiu também', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[1]], events: [
      { id: 'old', uid_externo: 'fg:serie1@google.com', inicio: '2026-10-21T01:00:00Z' },
      { id: 'sumiu', uid_externo: 'fg:sumiu@google.com', inicio: '2026-12-01T10:00:00Z' },
      { id: 'passado', uid_externo: 'fg:passado@google.com', inicio: '2026-10-01T10:00:00Z' },
    ] }));
    feeds();
    await ler();
    const ids = banco().t('events').map(x => x.id);
    assert.ok(!ids.includes('old'));
    assert.ok(!ids.includes('sumiu'));
    assert.ok(ids.includes('passado'), 'passado não é apagado');
  });
  test('reler não duplica (upsert pelo uid)', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[1]] }));
    feeds();
    await ler();
    const n = banco().t('events').length;
    await ler();
    assert.equal(banco().t('events').length, n);
  });
});
