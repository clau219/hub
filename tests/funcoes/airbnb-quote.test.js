// Edge Function airbnb-quote: disponibilidade e preço das 3 casas direto no Airbnb (simulado), alternativas e mensagem para o WhatsApp.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, comCron } from '../helpers/funcao.js';
import { novoBanco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let fn;
const FRIDA = '45895549', AZUL = '1315796557769332463', TERRA = '28283599';
const DADOS = () => comCron({
  properties: [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }, { id: 'QS50', nome: 'Casa Terracota' }],
  calendar_sources: [
    { id: 's1', property_id: 'QS39', url: `https://www.airbnb.com.br/calendar/ical/${FRIDA}.ics?s=abc` },
    { id: 's2', property_id: 'QS40', url: `https://www.airbnb.com/calendar/ical/${AZUL}.ics?s=def` },
    { id: 's3', property_id: 'QS50', url: `https://www.airbnb.com.br/calendar/ical/${TERRA}.ics` },
    { id: 's4', property_id: null, url: 'https://calendar.google.com/calendar/ical/dj/basic.ics' },
  ],
});
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
const range = (a, b) => { const o = []; for (let d = a; d < b; d = addDays(d, 1)) o.push(d); return o; };
const brl = v => v.toLocaleString('pt-BR');

// Airbnb falso: preço por noite + R$ 100 de limpeza; datas ocupadas, mínimo de noites e lotação por anúncio
// Pets: taxaPet por anúncio (a diária sobe, como no Airbnb); semPets: anúncio que recusa pet (indisponível, motivo OTHER)
function airbnb({ ocupados = {}, minNoites = {}, diaria = {}, lotacao = {}, falha = [], taxaPet = {}, semPets = [] } = {}) {
  simular(/airbnb\.com\.br\/api\/v3\/StaysPdpBookItQuery\//, req => {
    const v = JSON.parse(new URL(req.url).searchParams.get('variables'));
    const id = atob(v.id).split(':')[1], { startDate: ci, endDate: co } = v.dateRange, n = range(ci, co).length;
    const pets = v.guestCounts.numberOfPets || 0;
    if (falha.includes(id)) return { status: 500 };
    const nao = motivo => ({ data: { node: { pdpPresentation: { bookIt: { availability: { isAvailable: false, unavailabilityReason: motivo } } } } } });
    if (lotacao[id] && v.guestCounts.numberOfAdults > lotacao[id]) return nao('GUEST');
    if (range(ci, co).some(d => (ocupados[id] || []).includes(d)) || n < (minNoites[id] || 1)) return nao('DATE');
    if (pets && semPets.includes(id)) return nao('OTHER');
    const p = (diaria[id] || 400) + (pets ? taxaPet[id] || 0 : 0), total = n * p + 100;
    return { data: { node: { pdpPresentation: { bookIt: { availability: { isAvailable: true }, productItemDetail: { explanationData: { priceDetails: [{ items: [
      { description: `${n} noites x R$ ${brl(p)}`, priceString: `R$ ${brl(n * p)}` },
      { description: 'Taxa de limpeza', priceString: 'R$ 100' },
      { description: 'Total (BRL)', priceString: `R$ ${brl(total)}` },
    ] }] } } } } } } };
  });
  simular(/airbnb\.com\.br\/api\/v3\/PdpAvailabilityCalendar\//, req => {
    const { request: r } = JSON.parse(new URL(req.url).searchParams.get('variables'));
    const meses = Array.from({ length: r.count }, (_, k) => {
      const ini = new Date(Date.UTC(r.year, r.month - 1 + k, 1)), fim = new Date(Date.UTC(r.year, r.month + k, 1));
      return { days: range(ini.toISOString().slice(0, 10), fim.toISOString().slice(0, 10)).map(d => {
        const livre = !(ocupados[r.listingId] || []).includes(d);
        return { calendarDate: d, available: livre, availableForCheckin: livre, availableForCheckout: true, minNights: minNoites[r.listingId] || 1 };
      }) };
    });
    return { data: { merlin: { pdpAvailabilityCalendar: { calendarMonths: meses } } } };
  });
}
const cotar = (corpo, auth = 'usuario') => fn(pedido('/airbnb-quote', { corpo, auth })).then(lerJson);
before(async () => { fn = await carregarFuncao('airbnb-quote'); });
beforeEach(() => { novoBanco(DADOS()); limparRede(); });

describe('airbnb-quote: acesso e validação', () => {
  test('OPTIONS responde o CORS', async () => {
    const r = await fn(pedido('/airbnb-quote', { metodo: 'OPTIONS', auth: null }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });
  for (const [auth, st] of [[null, 401], ['anon', 401], ['invalido', 401], ['usuario', 200], ['service', 200], ['cron', 200]]) {
    test(`acesso ${auth ?? 'sem credencial'} → ${st}`, async () => {
      airbnb();
      assert.equal((await cotar({ checkin: '2026-11-10', checkout: '2026-11-13' }, auth)).status, st);
    });
  }
  test('x-hub-cron errado é recusado', async () => {
    const r = await fn(pedido('/airbnb-quote', { corpo: {}, auth: null, headers: { 'x-hub-cron': 'outro' } }));
    assert.equal(r.status, 401);
  });
  test('corpo e datas inválidos', async () => {
    const r = await fn(pedido('/airbnb-quote', { corpo: 'não é json' }));
    assert.deepEqual(await lerJson(r), { status: 400, corpo: { error: 'corpo inválido' } });
    assert.equal((await cotar({ checkin: '10/11/2026', checkout: '2026-11-13' })).corpo.error, 'datas no formato AAAA-MM-DD');
    assert.equal((await cotar({ checkin: '2026-11-13', checkout: '2026-11-13' })).corpo.error, 'a saída precisa ser depois da entrada');
    assert.equal((await cotar({ checkin: '2026-11-01', checkout: '2027-01-15' })).corpo.error, 'máximo de 60 noites');
  });
  test('sem link iCal do Airbnb cadastrado', async () => {
    novoBanco({ properties: [{ id: 'QS39', nome: 'Casa Frida' }], calendar_sources: [] });
    assert.deepEqual(await cotar({ checkin: '2026-11-10', checkout: '2026-11-13' }), { status: 400, corpo: { error: 'nenhuma casa com link iCal do Airbnb cadastrado' } });
  });
});

describe('airbnb-quote: consulta', () => {
  test('todas livres: total, diária, linhas, link e mensagem pronta', async () => {
    airbnb({ diaria: { [FRIDA]: 450, [AZUL]: 500, [TERRA]: 380 } });
    const { status, corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', adultos: 4 });
    assert.equal(status, 200);
    assert.deepEqual([corpo.noites, corpo.adultos], [3, 4]);
    assert.deepEqual(corpo.casas.map(c => [c.id, c.status, c.total, c.diaria]), [
      ['QS40', 'livre', 1600, 500], ['QS39', 'livre', 1450, 450], ['QS50', 'livre', 1240, 380], // ordem alfabética do nome
    ]);
    const frida = corpo.casas.find(c => c.id === 'QS39');
    assert.equal(frida.link, `https://www.airbnb.com.br/rooms/${FRIDA}?check_in=2026-11-10&check_out=2026-11-13&adults=4`);
    assert.deepEqual(frida.linhas, [{ descricao: '3 noites x R$ 450', valor: 1350 }, { descricao: 'Taxa de limpeza', valor: 100 }]);
    assert.equal(corpo.mensagem, [
      'Olá! Para 10/11 a 13/11 (3 noites, 4 hóspedes):',
      '• Casa Azul: disponível, R$ 1.600 no total (R$ 500 por noite)',
      '• Casa Frida: disponível, R$ 1.450 no total (R$ 450 por noite)',
      '• Casa Terracota: disponível, R$ 1.240 no total (R$ 380 por noite)',
      'Quer que eu separe alguma delas para você?',
    ].join('\n'));
    const req = chamadasPara(/StaysPdpBookItQuery/)[0];
    assert.equal(req.headers['x-airbnb-api-key'], 'd306zoyjsyarp7ifhu67rjxn52tv0t20');
  });
  test('ocupada: procura a mesma duração na data livre mais próxima', async () => {
    airbnb({ ocupados: { [AZUL]: ['2026-11-11'] } });
    const { corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', casas: ['QS40'] });
    const azul = corpo.casas[0];
    assert.equal(azul.status, 'ocupada');
    assert.deepEqual(azul.alternativa, { checkin: '2026-11-12', checkout: '2026-11-15', total: 1300, diaria: 400 });
    assert.match(corpo.mensagem, /• Casa Azul: ocupada nessas datas; livre de 12\/11 a 15\/11 por R\$ 1\.300/);
  });
  test('mínimo de noites: cota a estadia mínima a partir da mesma entrada', async () => {
    airbnb({ minNoites: { [TERRA]: 5 }, diaria: { [TERRA]: 300 } });
    const { corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', casas: ['QS50'] });
    const t = corpo.casas[0];
    assert.deepEqual([t.status, t.min_noites], ['min_noites', 5]);
    assert.deepEqual(t.alternativa, { checkin: '2026-11-10', checkout: '2026-11-15', total: 1600, diaria: 300 });
    assert.match(corpo.mensagem, /mínimo de 5 noites nessa data; de 10\/11 a 15\/11 fica R\$ 1\.600/);
  });
  test('não comporta o número de hóspedes', async () => {
    airbnb({ lotacao: { [FRIDA]: 8 } });
    const { corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', adultos: 10, casas: ['QS39'] });
    assert.equal(corpo.casas[0].status, 'capacidade');
    assert.match(corpo.mensagem, /• Casa Frida: não comporta 10 hóspedes/);
    assert.match(corpo.mensagem, /Se tiver flexibilidade nas datas/);
  });
  test('Airbnb fora do ar numa casa: status erro e a casa some da mensagem', async () => {
    airbnb({ falha: [AZUL] });
    const { corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-11' });
    const azul = corpo.casas.find(c => c.id === 'QS40');
    assert.deepEqual([azul.status, azul.erro], ['erro', 'Airbnb respondeu 500']);
    assert.doesNotMatch(corpo.mensagem, /Azul/);
    assert.match(corpo.mensagem, /\(1 noite, 2 hóspedes\)/);
  });
  test('todas com erro: sem mensagem', async () => {
    airbnb({ falha: [FRIDA, AZUL, TERRA] });
    const { corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-13' });
    assert.equal(corpo.mensagem, null);
  });
  test('resposta do Airbnb com formato novo vira erro explicado', async () => {
    simular(/airbnb\.com\.br\/api\/v3\//, { data: { node: {} } });
    const { corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', casas: ['QS39'] });
    assert.equal(corpo.casas[0].erro, 'resposta do Airbnb mudou (preço)');
  });
  test('com pet: manda numberOfPets ao Airbnb e o total já vem com a taxa de pet', async () => {
    airbnb({ taxaPet: { [TERRA]: 70 } });
    const { corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', adultos: 4, pets: 1, casas: ['QS50'] });
    assert.deepEqual(JSON.parse(new URL(chamadasPara(/StaysPdpBookItQuery/)[0].url).searchParams.get('variables')).guestCounts, { numberOfAdults: 4, numberOfPets: 1 });
    const t = corpo.casas[0];
    assert.deepEqual([corpo.pets, t.status, t.total, t.diaria], [1, 'livre', 1510, 470]);
    assert.equal(t.link, `https://www.airbnb.com.br/rooms/${TERRA}?check_in=2026-11-10&check_out=2026-11-13&adults=4&pets=1`);
    assert.match(corpo.mensagem, /^Olá! Para 10\/11 a 13\/11 \(3 noites, 4 hóspedes e 1 pet\):\n• Casa Terracota: disponível, R\$ 1\.510 no total/);
  });
  test('sem pet: não manda numberOfPets (consulta como antes)', async () => {
    airbnb();
    const { corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', casas: ['QS50'] });
    assert.deepEqual(JSON.parse(new URL(chamadasPara(/StaysPdpBookItQuery/)[0].url).searchParams.get('variables')).guestCounts, { numberOfAdults: 2 });
    assert.equal(corpo.pets, 0);
    assert.match(corpo.mensagem, /\(3 noites, 2 hóspedes\):/);
  });
  test('casa que não aceita pet: status nao_aceita_pet, sem procurar outras datas', async () => {
    airbnb({ semPets: [AZUL] });
    const { corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', adultos: 2, pets: 2 });
    const azul = corpo.casas.find(c => c.id === 'QS40');
    assert.equal(azul.status, 'nao_aceita_pet');
    assert.equal(azul.alternativa, undefined);
    assert.equal(chamadasPara(/PdpAvailabilityCalendar/).length, 0, 'não procura datas alternativas');
    assert.match(corpo.mensagem, /\(3 noites, 2 hóspedes e 2 pets\):/);
    assert.match(corpo.mensagem, /• Casa Azul: não aceita pets\n/);
    assert.match(corpo.mensagem, /• Casa Frida: disponível/);
  });
  test('com pet e a casa ocupada: continua "ocupada" (não confunde com recusa de pet)', async () => {
    airbnb({ ocupados: { [AZUL]: ['2026-11-11'] }, semPets: [] });
    const { corpo } = await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', pets: 1, casas: ['QS40'] });
    assert.equal(corpo.casas[0].status, 'ocupada');
    assert.equal(corpo.casas[0].alternativa.checkin, '2026-11-12');
  });
  test('hóspedes: padrão 2 e arredondado, mínimo 1', async () => {
    airbnb();
    assert.equal((await cotar({ checkin: '2026-11-10', checkout: '2026-11-13' })).corpo.adultos, 2);
    assert.equal((await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', adultos: '3.6' })).corpo.adultos, 4);
    assert.equal((await cotar({ checkin: '2026-11-10', checkout: '2026-11-13', adultos: -5 })).corpo.adultos, 1);
  });
});
