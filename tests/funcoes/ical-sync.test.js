// Edge Function ical-sync: lê os iCal (Airbnb → reservas, Google → agenda), com séries repetidas, exceções e proteções contra feed vazio.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, comCron } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';
import { relogio } from '../helpers/ambiente.js';

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

describe('Stays → reservas (link de exportação do anúncio)', () => {
  const STAYS = 'https://cbraga.stays.net/apartment/CO03J/ical';
  const FS = { id: 'fs', nome: 'Stays Frida', tipo: 'outro', calendario: 'alugueis', property_id: 'QS39', url: STAYS };
  const ev = (uid, ini, fim, resumo, id = 'RG01J', iurl = '') => [`DTSTAMP:20261019T150000Z`, `UID:${uid}`, `SUMMARY:${resumo}`,
    `DESCRIPTION:ID: ${id}\nIDEX: cbraga-${id}\nDT: 2026-10-19\nIURL: ${iurl}\nIURLC: c`, ` bragaCO03J`, `DTSTART:${ini}`, `DTEND:${fim}`];
  const FEED_STAYS = cal(
    ev('aaa1', '20261025T140000Z', '20261028T100000Z', ''), // reserva (Airbnb, Decolar...): sem nome
    ev('aaa2', '20261101T140000Z', '20261110T100000Z', 'REFORMA', 'QW01J'), // bloqueio manual
    ev('aaa3', '20261028T230000Z', '20261029T010000Z', 'fake_blocked', ''), // tempo de preparação
    ev('aaa4', '20261120T140000Z', '20261122T100000Z', 'Direta: Marina (Hub)', 'ZZ01J', 'https://projeto.supabase.co/functions/v1/ical-feed?cal=diretas'), // eco do Hub
    ev('aaa5', '20260901T140000Z', '20260905T100000Z', ''), // passado
    ev('aaa6', '20271019T140000Z', '20291019T100000Z', 'fake_blocked', ''), // fim da janela de venda
  );
  const lerStays = (feed = FEED_STAYS) => { simular(STAYS, feed); simular(AIRBNB, FEED_AIRBNB); simular(/gcal-sync/, {}); return ler(); };

  test('reserva direta do Hub que também foi bloqueada à mão na Stays não duplica; o espelho dela no Airbnb sai', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[0], FS], bookings: [
      { id: 'd1', uid_externo: null, property_id: 'QS39', checkin: '2026-11-01', checkout: '2026-11-10', status: 'confirmada', origem: 'direto', hospede: 'Nelsinho', valor: 1500 },
      { id: 'e1', uid_externo: 'fa:espelho@airbnb.com', property_id: 'QS39', checkin: '2026-11-01', checkout: '2026-11-10', status: 'bloqueio', origem: 'airbnb' },
    ] }));
    await lerStays();
    assert.equal(banco().t('bookings').filter(x => x.checkin === '2026-11-01' && x.status !== 'cancelada').length, 1);
    assert.equal(banco().t('bookings').find(x => x.id === 'e1').status, 'cancelada');
  });
  test('cópia da Stays que já tinha entrado ao lado da reserva direta é cancelada na leitura seguinte', async () => {
    novoBanco(comCron({ calendar_sources: [FS], bookings: [
      { id: 'd1', uid_externo: null, property_id: 'QS39', checkin: '2026-11-01', checkout: '2026-11-10', status: 'confirmada', origem: 'direto', hospede: 'Nelsinho' },
      { id: 'c1', uid_externo: 'fs:aaa2', property_id: 'QS39', checkin: '2026-11-01', checkout: '2026-11-10', status: 'bloqueio', origem: 'airbnb' },
    ] }));
    await lerStays();
    await lerStays();
    assert.deepEqual([banco().t('bookings').find(x => x.id === 'c1').status, banco().t('bookings').find(x => x.id === 'd1').status], ['cancelada', 'confirmada']);
    assert.equal(banco().t('bookings').length, 3); // d1, c1 (cancelada) e a reserva aaa1
    assert.deepEqual([banco().t('bookings').find(x => x.id === 'd1').status, banco().t('bookings').find(x => x.id === 'd1').uid_externo], ['confirmada', null]);
  });
  test('reserva sem nome, bloqueio com a anotação; preparação, eco do Hub e passado ficam de fora', async () => {
    novoBanco(comCron({ calendar_sources: [FS] }));
    const { corpo } = await lerStays();
    assert.deepEqual([corpo.reservas, corpo.erros], [2, []]);
    const b = Object.fromEntries(banco().t('bookings').map(x => [x.uid_externo, x]));
    assert.deepEqual(Object.keys(b).sort(), ['fs:aaa1', 'fs:aaa2']);
    assert.deepEqual([b['fs:aaa1'].checkin, b['fs:aaa1'].checkout, b['fs:aaa1'].status, b['fs:aaa1'].hospede, b['fs:aaa1'].notas],
      ['2026-10-25', '2026-10-28', 'confirmada', 'Hóspede (Stays)', 'Stays RG01J']);
    assert.deepEqual([b['fs:aaa2'].checkin, b['fs:aaa2'].checkout, b['fs:aaa2'].status, b['fs:aaa2'].hospede, b['fs:aaa2'].notas],
      ['2026-11-01', '2026-11-10', 'bloqueio', null, 'Stays QW01J\nREFORMA']);
  });
  test('com link da Stays, o iCal do Airbnb da mesma casa não é lido; a reserva que veio dele passa para a Stays sem perder nome e valor', async () => {
    novoBanco(comCron({ calendar_sources: [FONTES[0], FS], bookings: [
      { id: 'b1', uid_externo: 'fa:res1@airbnb.com', property_id: 'QS39', checkin: '2026-10-25', checkout: '2026-10-28', status: 'confirmada', origem: 'airbnb', hospede: 'Marina', valor: 1800 },
      { id: 'b2', uid_externo: 'fa:blk1@airbnb.com', property_id: 'QS39', checkin: '2026-12-01', checkout: '2026-12-03', status: 'bloqueio', origem: 'airbnb' },
      { id: 'b3', uid_externo: 'fa:res9@airbnb.com', property_id: 'QS39', checkin: '2026-12-10', checkout: '2026-12-12', status: 'confirmada', origem: 'airbnb', hospede: 'Sem par' },
    ] }));
    const { corpo } = await lerStays();
    assert.equal(chamadasPara(AIRBNB).length, 0);
    const b1 = banco().t('bookings').find(x => x.id === 'b1');
    assert.deepEqual([b1.uid_externo, b1.hospede, b1.valor, b1.origem], ['fs:aaa1', 'Marina', 1800, 'airbnb']);
    assert.equal(banco().t('bookings').filter(x => x.checkin === '2026-10-25').length, 1);
    assert.equal(banco().t('bookings').find(x => x.id === 'b2').status, 'cancelada');
    assert.equal(banco().t('bookings').find(x => x.id === 'b3').status, 'confirmada');
    assert.deepEqual(corpo.avisos, ['QS39: 1 reserva(s) do Airbnb sem par na Stays (entrada 2026-12-10): confira', 'QS39: 1 reserva(s) do Airbnb passaram a vir da Stays']);
  });
  test('eco de reserva direta apagada no Hub não vira "Hóspede (Stays)" enquanto a Stays não tira; depois é esquecido', async () => {
    // a Stays devolve a reserva direta sem nome e sem IURL (como uma reserva de verdade): aaa1 = eco da d1
    novoBanco(comCron({ calendar_sources: [FS], bookings: [
      { id: 'd1', uid_externo: null, property_id: 'QS39', checkin: '2026-10-25', checkout: '2026-10-28', status: 'confirmada', origem: 'direto', hospede: 'TESTE' },
    ] }));
    await lerStays();
    const ecos = () => JSON.parse(banco().t('app_config').find(c => c.key === 'stays_ecos')?.value || '{}');
    assert.deepEqual(Object.keys(ecos()), ['fs:aaa1']);
    assert.equal(ecos()['fs:aaa1'].bk, 'd1');
    // reserva direta apagada; a Stays ainda manda o eco
    banco().t('bookings').splice(banco().t('bookings').findIndex(x => x.id === 'd1'), 1);
    await lerStays();
    assert.equal(banco().t('bookings').filter(x => x.checkin === '2026-10-25').length, 0);
    // a Stays tirou o eco: a lembrança some
    await lerStays(cal(ev('aaa2', '20261101T140000Z', '20261110T100000Z', 'REFORMA', 'QW01J')));
    assert.deepEqual(Object.keys(ecos()), []);
  });
  test('reserva-fantasma que já tinha entrado é cancelada quando o eco é reconhecido; data mudada atualiza a lembrança', async () => {
    novoBanco(comCron({ calendar_sources: [FS], bookings: [
      { id: 'd1', uid_externo: null, property_id: 'QS39', checkin: '2026-10-25', checkout: '2026-10-28', status: 'confirmada', origem: 'direto', hospede: 'Ana' },
    ] }));
    await lerStays();
    // datas da reserva direta mudam; a Stays ainda manda o eco nas datas antigas
    Object.assign(banco().t('bookings').find(x => x.id === 'd1'), { checkin: '2026-10-26', checkout: '2026-10-29' });
    await lerStays();
    assert.equal(banco().t('bookings').filter(x => x.status !== 'cancelada' && x.checkin === '2026-10-25').length, 0);
    // a Stays reimporta: o mesmo evento vem com as datas novas e continua sendo eco
    await lerStays(cal(ev('aaa1', '20261026T140000Z', '20261029T100000Z', '')));
    assert.deepEqual(banco().t('bookings').filter(x => x.status !== 'cancelada').map(x => x.id), ['d1']);
    assert.equal(JSON.parse(banco().t('app_config').find(c => c.key === 'stays_ecos').value)['fs:aaa1'].checkin, '2026-10-26');
  });
  test('o sentinela do feed "diretas" que volta da Stays (400 dias à frente, sem título) não vira reserva', async () => {
    novoBanco(comCron({ calendar_sources: [FS] }));
    await lerStays(cal(ev('aaa1', '20261025T140000Z', '20261028T100000Z', ''), ev('sent', '20271123T140000Z', '20271124T100000Z', '', 'ZQ01J')));
    assert.deepEqual(banco().t('bookings').map(b => b.uid_externo), ['fs:aaa1']);
  });
  test('conferência: reserva direta em andamento (entrou ontem) não vira "bloqueio preso"', async () => {
    relogio.definir('2026-10-26T15:00:00Z'); // hóspede da d1 (25/10–28/10) está na casa
    novoBanco(comCron({ calendar_sources: [FS], properties: [{ id: 'QS39', nome: 'Casa Frida' }], bookings: [
      { id: 'd1', uid_externo: null, property_id: 'QS39', checkin: '2026-10-25', checkout: '2026-10-28', status: 'confirmada', origem: 'direto', hospede: 'Anderson' },
    ] }));
    // o eco já tinha sido reconhecido quando a reserva era futura
    banco().t('app_config').push({ key: 'stays_ecos', value: JSON.stringify({ 'fs:aaa1': { casa: 'QS39', checkin: '2026-10-25', checkout: '2026-10-28', bk: 'd1', codigo: 'RG01J' } }) });
    await lerStays();
    relogio.avancar(60 * 60e3);
    await lerStays();
    assert.equal(JSON.parse(banco().t('app_config').find(c => c.key === 'stays_conferencia')?.value || '{}')['preso:fs:aaa1'], undefined);
    assert.equal((banco().t('tasks') || []).length, 0);
    relogio.definir('2026-10-19T15:00:00Z');
  });
  describe('conferência Hub × Stays', () => {
    const PUSH = { app_secrets: [{ key: 'cron_token', value: comCron({}).app_secrets[0].value }, { key: 'vapid_public', value: 'pub' }, { key: 'vapid_private', value: 'priv' }],
      push_subscriptions: [{ id: 'p1', endpoint: 'https://push/1', p256dh: 'x', auth: 'y' }], properties: [{ id: 'QS39', nome: 'Casa Frida' }] };
    const est = () => JSON.parse(banco().t('app_config').find(c => c.key === 'stays_conferencia')?.value || '{}');
    beforeEach(() => { relogio.definir('2026-10-19T15:00:00Z'); globalThis.__webpush = { envios: [], vapid: null, falhar: null }; });
    test('reserva direta que não chegou na Stays: espera o prazo, depois tarefa + push; quando chega, a tarefa é concluída', async () => {
      novoBanco(comCron({ ...PUSH, calendar_sources: [FS], bookings: [
        { id: 'd9', uid_externo: null, property_id: 'QS39', checkin: '2026-12-01', checkout: '2026-12-03', status: 'confirmada', origem: 'direto', hospede: 'Ana Souza' },
      ] }));
      await lerStays();
      assert.deepEqual(Object.keys(est()), ['falta:d9']);
      assert.equal(banco().t('tasks').length, 0, 'antes do prazo é o atraso normal da Stays');
      relogio.avancar(41 * 60e3);
      const { corpo } = await lerStays();
      const t = banco().t('tasks');
      assert.equal(t.length, 1);
      assert.match(t[0].titulo, /Reserva direta de Ana \(Casa Frida, 01\/12–03\/12\) não chegou/);
      assert.deepEqual([t[0].area, t[0].prazo, t[0].feito], ['alugueis', '2026-10-19', false]);
      assert.equal(globalThis.__webpush.envios.length, 1);
      assert.ok(corpo.avisos.some(a => /não chegou/.test(a)));
      await lerStays(); // não repete o aviso
      assert.equal(banco().t('tasks').length, 1);
      assert.equal(globalThis.__webpush.envios.length, 1);
      // a Stays importou (eco sem nome nas mesmas datas): resolvido
      await lerStays(cal(ev('aaa9', '20261201T140000Z', '20261203T100000Z', '', 'QY01J')));
      assert.equal(banco().t('tasks')[0].feito, true);
      assert.deepEqual(est(), {});
    });
    test('bloqueio preso: reserva direta apagada e a Stays não liberou → tarefa com o código da Stays; some quando a Stays tira', async () => {
      novoBanco(comCron({ ...PUSH, calendar_sources: [FS], bookings: [
        { id: 'd1', uid_externo: null, property_id: 'QS39', checkin: '2026-10-25', checkout: '2026-10-28', status: 'confirmada', origem: 'direto', hospede: 'TESTE' },
      ] }));
      await lerStays();
      assert.deepEqual(est(), {});
      banco().t('bookings').splice(banco().t('bookings').findIndex(x => x.id === 'd1'), 1);
      await lerStays();
      assert.deepEqual(Object.keys(est()), ['preso:fs:aaa1']);
      relogio.avancar(41 * 60e3);
      await lerStays();
      const t = banco().t('tasks');
      assert.equal(t.length, 1);
      assert.equal(t[0].titulo, 'Apagar na Stays o bloqueio RG01J (Casa Frida, 25/10–28/10)');
      assert.match(globalThis.__webpush.envios[0].body, /continua bloqueando/);
      assert.equal(banco().t('bookings').filter(x => x.checkin === '2026-10-25' && x.status !== 'cancelada').length, 0, 'e não vira reserva-fantasma');
      await lerStays(cal(ev('aaa2', '20261101T140000Z', '20261110T100000Z', 'REFORMA', 'QW01J')));
      assert.equal(banco().t('tasks')[0].feito, true);
      assert.deepEqual(est(), {});
    });
  });
  test('reler não duplica; o que sumiu do feed vira cancelado; feed só com fim de janela não cancela à toa', async () => {
    novoBanco(comCron({ calendar_sources: [FS] }));
    await lerStays();
    await lerStays();
    assert.equal(banco().t('bookings').length, 2);
    limparRede();
    await lerStays(cal(ev('aaa1', '20261025T140000Z', '20261028T100000Z', '')));
    assert.equal(banco().t('bookings').find(x => x.uid_externo === 'fs:aaa2').status, 'cancelada');
    assert.equal(banco().t('bookings').find(x => x.uid_externo === 'fs:aaa1').status, 'confirmada');
  });
});
