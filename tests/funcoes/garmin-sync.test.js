// Edge Function garmin-sync: Garmin Connect (simulado) → health_daily/health_activities, renovação do acesso e hábitos automáticos.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, comCron } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let fn;
const AGORA = Date.parse('2026-10-19T15:00:00Z') / 1000;
const jwt = exp => ['{"alg":"none"}', JSON.stringify({ exp }), 'x'].map(s => Buffer.from(s).toString('base64url')).join('.');
const TOKENS = (exp = AGORA + 7200) => ({ id: 1, tokens: JSON.stringify({ di_token: jwt(exp), di_refresh_token: 'refresh-1', di_client_id: 'cliente-gc' }) });

// Garmin falso. dias: { 'AAAA-MM-DD': {resumo, sono, hrv, prontidao, vo2, peso} }; atividades: lista crua da API
let G;
function garmin({ dias = {}, atividades = [], renovar = { access_token: jwt(AGORA + 7200), refresh_token: 'refresh-2' }, exige401 = false } = {}) {
  G = { tokensVistos: new Set() };
  simular('https://diauth.garmin.com/di-oauth2-service/oauth/token', req => {
    G.renovou = new URLSearchParams(req.corpo).get('refresh_token');
    return renovar ? renovar : { status: 400, json: {} };
  });
  simular(/connectapi\.garmin\.com/, req => {
    const u = new URL(req.url), p = u.pathname;
    const tk = req.headers.authorization;
    G.tokensVistos.add(tk);
    if (exige401 && tk !== `Bearer ${renovar.access_token}`) return { status: 401 };
    const d = u.searchParams.get('calendarDate') || u.searchParams.get('date') || p.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    const x = dias[d] || {};
    if (p === '/userprofile-service/socialProfile') return { displayName: 'claudio' };
    if (p.startsWith('/usersummary-service/usersummary/daily/claudio')) return x.resumo ? x.resumo : { status: 204 };
    if (p.startsWith('/wellness-service/wellness/dailySleepData/claudio')) return x.sono ? { dailySleepDTO: x.sono } : { dailySleepDTO: {} };
    if (p.startsWith('/hrv-service/hrv/')) return x.hrv ? { hrvSummary: x.hrv } : { status: 404 };
    if (p.startsWith('/metrics-service/metrics/trainingreadiness/')) return x.prontidao || [];
    if (p.startsWith('/metrics-service/metrics/maxmet/daily/')) return x.vo2 ? [{ generic: { vo2MaxPreciseValue: x.vo2 } }] : [];
    if (p.startsWith('/weight-service/weight/dayview/')) return x.peso ? { totalAverage: { weight: x.peso } } : { status: 500 };
    if (p === '/activitylist-service/activities/search/activities') {
      const ini = +u.searchParams.get('start');
      return atividades.slice(ini, ini + 20);
    }
    return { status: 404 };
  });
}
const DIA19 = {
  resumo: { totalSteps: 9500, dailyStepGoal: 8000, totalDistanceMeters: 7000, totalKilocalories: 2400.6, restingHeartRate: 52, averageStressLevel: -1,
    bodyBatteryHighestValue: 88, bodyBatteryLowestValue: 22, moderateIntensityMinutes: 10, vigorousIntensityMinutes: 6 },
  sono: { sleepTimeSeconds: 27000, deepSleepSeconds: 5000, remSleepSeconds: 6000, lightSleepSeconds: 16000, sleepScores: { overall: { value: 84 } }, sleepStartTimestampGMT: Date.parse('2026-10-19T02:00:00Z') },
  hrv: { lastNightAvg: 55, weeklyAvg: 50, status: 'BALANCED' },
  prontidao: [{ score: 70, timestamp: '2026-10-19T09:00:00' }, { score: 40, timestamp: '2026-10-19T06:00:00' }],
  vo2: 47.3, peso: 80456,
};
const ATIV = (n, x = {}) => ({ activityId: 1000 + n, startTimeGMT: '2026-10-19 09:00:00', startTimeLocal: '2026-10-19 06:00:00', activityType: { typeKey: 'running' }, activityName: 'Corrida', duration: 1800.4, distance: 5000, averageHR: 150.6, ...x });
const sync = (corpo = {}, auth = 'cron') => fn(pedido('/garmin-sync', { corpo, auth })).then(lerJson);
before(async () => { fn = await carregarFuncao('garmin-sync'); });
beforeEach(() => limparRede());

describe('garmin-sync: acesso e erros', () => {
  test('sem credencial: 401', async () => {
    novoBanco(comCron({}));
    assert.equal((await sync({}, null)).status, 401);
  });
  test('sem tokens do Garmin: explica que precisa do login no PC', async () => {
    novoBanco(comCron({}));
    const { status, corpo } = await sync();
    assert.equal(status, 500);
    assert.equal(corpo.erro, 'Sem acesso ao Garmin: rode garmin_login.py no PC uma vez.');
    assert.match(banco().t('app_config')[0].value, /garmin_login\.py/);
  });
  test('renovação recusada: pede novo login', async () => {
    novoBanco(comCron({ garmin_tokens: [TOKENS(AGORA - 10)] }));
    garmin({ renovar: null });
    assert.match((await sync()).corpo.erro, /Garmin recusou renovar o acesso \(400\): rode garmin_login\.py/);
  });
});

describe('garmin-sync: dados do dia e atividades', () => {
  test('grava o resumo do dia com sono, VFC, prontidão mais recente, VO2máx e peso', async () => {
    novoBanco(comCron({ garmin_tokens: [TOKENS()] }));
    garmin({ dias: { '2026-10-19': DIA19 } });
    const { status, corpo } = await sync();
    assert.equal(status, 200);
    assert.deepEqual([corpo.de, corpo.ate, corpo.dias, corpo.onde], ['2026-10-18', '2026-10-19', 2, 'supabase']);
    const d = banco().t('health_daily').find(r => r.dia === '2026-10-19');
    assert.deepEqual([d.passos, d.meta_passos, d.calorias, d.fc_repouso, d.bb_max, d.bb_min], [9500, 8000, 2401, 52, 88, 22]);
    assert.deepEqual([d.sono_seg, d.sono_score, d.sono_inicio], [27000, 84, '2026-10-19T02:00:00Z']);
    assert.deepEqual([d.hrv_noite, d.hrv_status, d.prontidao, d.vo2max, d.peso_kg], [55, 'BALANCED', 70, 47.3, 80.46]);
    assert.equal('estresse_medio' in d, false, 'estresse -1 (sem leitura) não é gravado');
    assert.equal(d.fonte, 'garmin-api');
    const st = JSON.parse(banco().t('app_config')[0].value);
    assert.equal(st.dias, 2);
  });
  test('dia sem sono no relógio não apaga o sono já gravado', async () => {
    novoBanco(comCron({ garmin_tokens: [TOKENS()], health_daily: [{ id: 'x', dia: '2026-10-18', sono_seg: 25000, passos: 100 }] }));
    garmin({ dias: { '2026-10-18': { resumo: { totalSteps: 12000 } } } });
    await sync();
    const d = banco().t('health_daily').find(r => r.dia === '2026-10-18');
    assert.deepEqual([d.passos, d.sono_seg], [12000, 25000]);
  });
  test('relógio parado por dias: volta até o último dia com passos (máx. 60)', async () => {
    novoBanco(comCron({ garmin_tokens: [TOKENS()], health_daily: [{ id: 'x', dia: '2026-10-12', passos: 5000 }] }));
    garmin();
    assert.deepEqual([(await sync()).corpo.de, (await sync()).corpo.dias], ['2026-10-12', 8]);
    novoBanco(comCron({ garmin_tokens: [TOKENS()], health_daily: [{ id: 'x', dia: '2026-01-01', passos: 5000 }] }));
    assert.equal((await sync()).corpo.de, '2026-08-20');
    novoBanco(comCron({ garmin_tokens: [TOKENS()] }));
    assert.equal((await sync({ desde: '2026-10-01' })).corpo.de, '2026-10-01');
  });
  test('atividades paginadas de 20 em 20, com dia local e números arredondados', async () => {
    novoBanco(comCron({ garmin_tokens: [TOKENS()] }));
    garmin({ atividades: [...Array.from({ length: 25 }, (_, i) => ATIV(i)), { activityId: null }] });
    const { corpo } = await sync();
    assert.equal(corpo.atividades, 25);
    const a = banco().t('health_activities').find(x => x.id === 1000);
    assert.deepEqual([a.inicio, a.dia, a.tipo, a.duracao_seg, a.fc_media], ['2026-10-19T09:00:00Z', '2026-10-19', 'running', 1800, 151]);
    assert.equal(chamadasPara(/activities\/search/).length, 2);
  });
});

describe('garmin-sync: acesso ao Garmin', () => {
  test('token perto de vencer é renovado antes e os 2 tokens novos são gravados', async () => {
    novoBanco(comCron({ garmin_tokens: [TOKENS(AGORA + 60)] }));
    garmin();
    await sync();
    assert.equal(G.renovou, 'refresh-1');
    const t = JSON.parse(banco().t('garmin_tokens')[0].tokens);
    assert.deepEqual([t.di_refresh_token, t.di_client_id], ['refresh-2', 'cliente-gc']);
    assert.equal(chamadasPara('https://diauth.garmin.com')[0].headers.authorization, 'Basic ' + btoa('cliente-gc:'));
  });
  test('401 no meio do caminho: renova e tenta de novo', async () => {
    novoBanco(comCron({ garmin_tokens: [TOKENS()] }));
    garmin({ exige401: true, renovar: { access_token: jwt(AGORA + 9999), refresh_token: 'refresh-2' } });
    const { status } = await sync();
    assert.equal(status, 200);
    assert.equal(G.renovou, 'refresh-1');
  });
  test('token válido: não renova nem regrava', async () => {
    novoBanco(comCron({ garmin_tokens: [TOKENS()] }));
    garmin();
    await sync();
    assert.equal(G.renovou, undefined);
    assert.equal(JSON.parse(banco().t('garmin_tokens')[0].tokens).di_refresh_token, 'refresh-1');
  });
  test('{renovar: true} força a renovação', async () => {
    novoBanco(comCron({ garmin_tokens: [TOKENS()] }));
    garmin();
    await sync({ renovar: true });
    assert.equal(G.renovou, 'refresh-1');
  });
});

describe('garmin-sync: hábitos automáticos', () => {
  const hab = (id, auto, x = {}) => ({ id, nome: id, ativo: true, auto, created_at: '2026-01-01T00:00:00Z', ...x });
  test('marca os hábitos cumpridos (passos, sono, intensos, corrida), respeitando dias e data de criação', async () => {
    novoBanco(comCron({
      garmin_tokens: [TOKENS()],
      habits: [
        hab('passos', 'passos>=8000'),
        hab('sono', 'sono>=7'), // 7,5 h
        hab('intensos', 'intensos>=20'), // 10 + 2×6 = 22
        hab('corrida', 'atividade.corrida>=30'), // 30 min
        hab('forca', 'atividade.forca>=20'), // não houve força
        hab('fds', 'passos>=1000', { dias: [0, 6] }), // só fim de semana: domingo 18 conta, segunda 19 não
        hab('novo', 'passos>=1000', { created_at: '2026-10-19T10:00:00Z' }), // 18/10 é antes de existir
        hab('inativo', 'passos>=1', { ativo: false }),
        hab('manual', null),
        hab('ruim', 'passos>=abc'),
      ],
      habit_logs: [{ id: 'l0', habit_id: 'passos', dia: '2026-10-19' }],
    }));
    garmin({ dias: { '2026-10-19': DIA19, '2026-10-18': { resumo: { totalSteps: 3000 } } }, atividades: [ATIV(1)] });
    const { corpo } = await sync();
    const logs = banco().t('habit_logs').map(l => `${l.habit_id}|${l.dia}`).sort();
    assert.deepEqual(logs, ['corrida|2026-10-19', 'fds|2026-10-18', 'intensos|2026-10-19', 'novo|2026-10-19', 'passos|2026-10-19', 'sono|2026-10-19']);
    assert.equal(corpo.habitos, 6, 'conta o que cumpriu (o já marcado não duplica)');
  });
});
