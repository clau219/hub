// Edge Function gcal-sync: gigs e eventos de DJ do Hub → Google Agenda (conta de serviço), com Google simulado.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { carregarFuncao, pedido, lerJson, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { simular, limparRede, chamadasPara } from '../helpers/rede.js';

let fn;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SA = JSON.stringify({ client_email: 'hub-agenda@projeto.iam.gserviceaccount.com', private_key: privateKey });
const CAL = 'agenda.dj@group.calendar.google.com';
const U = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const gid = (p, id) => p + id.replace(/-/g, '');

// Google Agenda falso: guarda eventos por id e registra cada chamada
let G;
function google({ conflito = [] } = {}) {
  G = { eventos: new Map(), chamadas: [] };
  simular('https://oauth2.googleapis.com/token', req => {
    const p = new URLSearchParams(req.corpo);
    const [h, c, sig] = p.get('assertion').split('.');
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'));
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    if (!ok || claims.iss !== 'hub-agenda@projeto.iam.gserviceaccount.com') return { status: 400, json: { error: 'invalid_grant' } };
    return { access_token: 'g-token', claims };
  });
  simular(/googleapis\.com\/calendar\/v3\/calendars\//, req => {
    const u = new URL(req.url);
    const [, cal, , id] = u.pathname.replace('/calendar/v3/calendars/', '/').split('/');
    G.chamadas.push({ m: req.metodo, cal: decodeURIComponent(cal), id: id && decodeURIComponent(id), corpo: req.corpo && JSON.parse(req.corpo), auth: req.headers.authorization });
    if (req.metodo === 'GET' && !id) return { items: [...G.eventos.values()].filter(e => e.extendedProperties?.private?.hub === '1') };
    if (req.metodo === 'GET') return G.eventos.get(decodeURIComponent(id)) || { status: 404, json: {} };
    const corpo = JSON.parse(req.corpo || '{}');
    if (req.metodo === 'POST') {
      if (conflito.includes(corpo.id)) return { status: 409, json: { error: 'duplicate' } };
      G.eventos.set(corpo.id, corpo); return corpo;
    }
    if (req.metodo === 'PUT') { G.eventos.set(id, corpo); return corpo; }
    if (req.metodo === 'PATCH') { G.eventos.set(decodeURIComponent(id), { ...(G.eventos.get(decodeURIComponent(id)) || {}), ...corpo }); return corpo; }
    if (req.metodo === 'DELETE') { G.eventos.delete(id); return { status: 204 }; }
  });
}
const DEAL1 = U(1), DEAL2 = U(2), DEAL3 = U(3), EV1 = U(4);
const DADOS = (x = {}) => comCron({
  calendar_sources: [{ id: 'src', calendario: 'dj', url: `https://calendar.google.com/calendar/ical/${encodeURIComponent(CAL)}/private-abc/basic.ics` }],
  contacts: [{ id: 'c1', nome: 'Ana' }],
  deals: [
    { id: DEAL1, negocio: 'dj', etapa: 'fechado', titulo: 'Casamento', contato_id: 'c1', data_evento: '2026-11-07', hora_inicio: '22:00:00', hora_fim: '02:00:00', local: 'Pipa', notas: 'som próprio' },
    { id: DEAL2, negocio: 'dj', etapa: 'pago', titulo: 'Aniversário', data_evento: '2026-10-25', hora_inicio: null },
    { id: DEAL3, negocio: 'dj', etapa: 'lead', titulo: 'Provisório', data_evento: '2026-11-20' },
    { id: U(5), negocio: 'dj', etapa: 'pago', titulo: 'Antigo', data_evento: '2026-09-01' },
    { id: U(6), negocio: 'consultoria', etapa: 'fechado', titulo: 'Obra', data_evento: '2026-11-01' },
  ],
  events: [
    { id: EV1, calendario: 'dj', origem: 'manual', titulo: 'Ensaio', dia_inteiro: false, inicio: '2026-10-22T21:00:00.000Z', fim: null },
    { id: U(7), calendario: 'pessoal', origem: 'manual', titulo: 'Médico', inicio: '2026-10-22T12:00:00Z' },
    { id: 'g1', calendario: 'dj', origem: 'google', titulo: 'Show Google', uid_externo: 'src:abc123@google.com#20261016T180000Z', inicio: '2026-10-16T19:00:00Z', fim: '2026-10-16T21:00:00Z' },
    { id: 'g2', calendario: 'dj', origem: 'google', titulo: 'Série antiga', uid_externo: 'src:serie9@google.com', dia_inteiro: true, inicio: '2026-10-20T12:00:00Z' },
  ],
  ...x,
});
const sync = (corpo = {}, auth = 'usuario') => fn(pedido('/gcal-sync', { corpo, auth })).then(lerJson);
before(async () => { fn = await carregarFuncao('gcal-sync', { GCAL_SA_JSON: SA }); });
beforeEach(() => { limparRede(); google(); novoBanco(DADOS()); definirEnv('GCAL_SA_JSON', SA); definirEnv('GCAL_DJ_ID', undefined); });

describe('gcal-sync: configuração', () => {
  test('sem credencial: 401', async () => {
    assert.equal((await sync({}, null)).status, 401);
  });
  test('sem o segredo GCAL_SA_JSON: erro no corpo e no status de Ajustes', async () => {
    definirEnv('GCAL_SA_JSON', undefined);
    const { status, corpo } = await sync();
    assert.equal(status, 200, 'erro vai no corpo para o Hub conseguir ler');
    assert.equal(corpo.erro, 'falta a chave do Google (segredo GCAL_SA_JSON)');
    assert.match(banco().t('app_config')[0].value, /falta a chave do Google/);
  });
  test('login da conta de serviço com JWT RS256 assinado (escopo de eventos)', async () => {
    await sync();
    const req = chamadasPara('https://oauth2.googleapis.com/token')[0];
    const claims = JSON.parse(Buffer.from(new URLSearchParams(req.corpo).get('assertion').split('.')[1], 'base64url').toString());
    assert.deepEqual([claims.scope, claims.aud, claims.exp - claims.iat], ['https://www.googleapis.com/auth/calendar.events', 'https://oauth2.googleapis.com/token', 3600]);
    assert.ok(G.chamadas.every(c => c.auth === 'Bearer g-token'));
  });
  test('id do calendário sai do link iCal "dj"; GCAL_DJ_ID tem prioridade', async () => {
    await sync();
    assert.ok(G.chamadas.every(c => c.cal === CAL));
    definirEnv('GCAL_DJ_ID', 'outro@group.calendar.google.com');
    limparRede(); google();
    await sync();
    assert.ok(G.chamadas.every(c => c.cal === 'outro@group.calendar.google.com'));
  });
  test('sem link iCal do Google para a agenda DJ', async () => {
    novoBanco(DADOS({ calendar_sources: [] }));
    assert.equal((await sync()).corpo.erro, 'nenhum link iCal do Google cadastrado para a agenda DJ');
  });
});

describe('gcal-sync: reconciliação Hub → Google', () => {
  test('cria as gigs fechadas/pagas e os eventos manuais de DJ com id fixo', async () => {
    const { corpo } = await sync();
    assert.deepEqual(corpo, { ok: true, total: 3, criados: 3, alterados: 0, apagados: 0 });
    const g1 = G.eventos.get(gid('hubd', DEAL1));
    assert.equal(g1.summary, 'DJ CLAU: Ana');
    assert.deepEqual(g1.start, { dateTime: '2026-11-08T01:00:00.000Z', timeZone: 'America/Sao_Paulo' });
    assert.deepEqual(g1.end, { dateTime: '2026-11-08T05:00:00.000Z', timeZone: 'America/Sao_Paulo' }, 'termina às 2h do dia seguinte');
    assert.match(g1.description, /^som próprio\n\nGig do Hub/);
    assert.equal(g1.extendedProperties.private.hub, '1');
    const g2 = G.eventos.get(gid('hubd', DEAL2));
    assert.deepEqual([g2.start, g2.end], [{ date: '2026-10-25' }, { date: '2026-10-26' }]);
    const e1 = G.eventos.get(gid('hube', EV1));
    assert.deepEqual([e1.summary, e1.end.dateTime], ['Ensaio', '2026-10-22T22:00:00.000Z']);
    const st = JSON.parse(banco().t('app_config')[0].value);
    assert.deepEqual([st.criados, st.total], [3, 3]);
  });
  test('rodar de novo sem mudanças não escreve nada (hash igual)', async () => {
    await sync();
    G.chamadas.length = 0;
    const { corpo } = await sync();
    assert.deepEqual([corpo.criados, corpo.alterados, corpo.apagados], [0, 0, 0]);
    assert.deepEqual(G.chamadas.map(c => c.m), ['GET']);
  });
  test('gig alterada no Hub é reescrita (PUT); gig perdida é apagada; evento alheio fica', async () => {
    await sync();
    G.eventos.set('evento-do-claudio', { id: 'evento-do-claudio', extendedProperties: { private: { hub: '1' } } });
    banco().t('deals').find(d => d.id === DEAL1).local = 'Natal';
    banco().t('deals').find(d => d.id === DEAL2).etapa = 'perdido';
    const { corpo } = await sync();
    assert.deepEqual([corpo.alterados, corpo.apagados], [1, 1]);
    assert.equal(G.eventos.get(gid('hubd', DEAL1)).location, 'Natal');
    assert.ok(!G.eventos.has(gid('hubd', DEAL2)));
    assert.ok(G.eventos.has('evento-do-claudio'));
  });
  test('id que já existe no Google (409) é reescrito e reativado', async () => {
    limparRede(); google({ conflito: [gid('hubd', DEAL1)] });
    const { corpo } = await sync();
    assert.deepEqual([corpo.criados, corpo.alterados], [2, 1]);
    assert.ok(G.chamadas.some(c => c.m === 'PUT' && c.id === gid('hubd', DEAL1)));
  });
});

describe('gcal-sync: evento do Google editado no Hub', () => {
  test('ocorrência de série: PATCH no id da ocorrência', async () => {
    const { corpo } = await sync({ evento: 'g1' });
    assert.deepEqual(corpo, { ok: true, alterados: 1 });
    const p = G.chamadas.find(c => c.m === 'PATCH');
    assert.equal(p.id, 'abc123_20261016T180000Z');
    assert.deepEqual(p.corpo, { summary: 'Show Google', location: '', start: { dateTime: '2026-10-16T19:00:00.000Z', timeZone: 'America/Sao_Paulo' }, end: { dateTime: '2026-10-16T21:00:00.000Z', timeZone: 'America/Sao_Paulo' } });
    assert.equal(banco().t('app_config').length, 0, 'edição pontual não sobrescreve o status');
  });
  test('linha antiga de série (sem #data): altera a 1ª ocorrência', async () => {
    G.eventos.set('serie9', { id: 'serie9', recurrence: ['RRULE:FREQ=WEEKLY'], start: { date: '2026-10-20' } });
    await sync({ evento: 'g2' });
    const p = G.chamadas.find(c => c.m === 'PATCH');
    assert.equal(p.id, 'serie9_20261020');
    assert.deepEqual(p.corpo.start, { date: '2026-10-20' });
  });
  test('evento inexistente; evento manual faz a reconciliação completa', async () => {
    assert.equal((await sync({ evento: 'nao-existe' })).corpo.erro, 'evento não encontrado');
    assert.equal((await sync({ evento: EV1 })).corpo.criados, 3);
  });
});
