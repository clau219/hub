// Tela Saúde: dados do Garmin (Supabase), números do topo, recomendação do dia, gráficos, atividades e botão Atualizar.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, textoSep, clicar, ate, esperar } from '../helpers/dom.js';
import { abrirHub, trocarDados } from '../helpers/tela.js';
import { banco, novoBanco } from '../helpers/fake-supabase.js';

let V, U, el;
const DIAS = n => Array.from({ length: n }, (_, i) => i);
function dados({ ultimoDia = 0 } = {}) {
  const daily = DIAS(40).filter(i => i >= ultimoDia).map(i => ({ dia: U.addDays('2026-10-19', -i), sono_seg: 7 * 3600 + (i === 0 ? 1800 : 0), sono_score: 80, sono_profundo_seg: 5000, sono_rem_seg: 6000, sono_leve_seg: 14000,
    hrv_noite: 50, hrv_status: 'BALANCED', fc_repouso: 55, bb_max: 85, bb_min: 20, passos: 9000 + i, meta_passos: 8000, estresse_medio: 30 }));
  daily[0].vo2max = 47;
  for (const r of daily) if (['2026-10-18', '2026-10-11'].includes(r.dia)) r.sono_seg = 5 * 3600; // noites depois das gigs
  return {
    health_daily: daily,
    health_activities: [
      { id: 1, inicio: '2026-10-18T09:00:00Z', dia: '2026-10-18', tipo: 'running', nome: 'Corrida na praia', duracao_seg: 2700, distancia_m: 7200, fc_media: 150 },
      { id: 2, inicio: '2026-10-15T20:00:00Z', dia: '2026-10-15', tipo: 'strength_training', duracao_seg: 3600 },
    ],
    app_config: [{ key: 'garmin_status', value: JSON.stringify({ em: '2026-10-19T13:00:00Z' }) }],
    deals: [{ id: 'g', negocio: 'dj', etapa: 'fechado', data_evento: '2026-10-17', titulo: 'Gig' }, { id: 'g2', negocio: 'dj', etapa: 'pago', data_evento: '2026-10-10', titulo: 'Gig 2' }],
  };
}
// Abre a tela e espera a leitura nova do banco terminar (a tela redesenha sozinha)
const abrir = async () => {
  const n = banco().consultas.length;
  location.hash = '#/saude'; V.render(el);
  await ate(() => banco().consultas.slice(n).some(c => c.tabela === 'health_activities'), { msg: 'leitura do banco' });
  await esperar(10);
};
before(async () => {
  await abrirHub({ supabase: true });
  U = await hub('util.js');
  V = await hub('v-saude.js');
  el = $('#view');
});
beforeEach(() => globalThis.__relogio.avancar(6 * 60e3)); // a tela guarda os dados por 5 min

describe('Saúde com dados', () => {
  before(async () => { await trocarDados(dados(), { supabase: true }); await abrir(); });
  test('status da última sincronização', () => {
    assert.match(texto('.view-head'), /Garmin sincronizado hoje, 10:00/);
  });
  test('números do topo com comparação à média de 30 dias', () => {
    const k = Object.fromEntries($$('.sd-kpis .kpi').map(x => [texto(x.querySelector('span')), textoSep(x)]));
    // média de 30 noites: 28 de 7h e 2 de 5h (depois das gigs) = 6h52
    assert.match(k['Sono (hoje)'], /7h30 nota 80 ▲ vs\. média 6h52/);
    assert.match(k['VFC (hoje)'], /50 ms equilibrada na média de 30 dias/);
    assert.match(k['Passos hoje'], /9\.000 meta 8\.000 \(113%\)/);
    assert.match(k['VO2máx'], /47/);
  });
  test('recomendação do dia com motivos', () => {
    assert.ok($('.sd-coach').className.match(/sd-(forte|leve|descanso)/));
    assert.ok($$('.sd-motivos li').length >= 3);
  });
  test('6 gráficos desenhados e atividades do período', () => {
    assert.equal($$('.sd-card').length, 6);
    assert.equal($$('.sd-card svg').length, 6);
    assert.match(texto('.sd-acts h2'), /2 no período/);
    assert.match(textoSep($('.sd-act')), /Corrida na praia Corrida · dom, 18 out 45 min · 7,2 km · 150 bpm/);
  });
  test('sono depois de gig comparado às outras noites', () => {
    assert.match(texto('.sd-gig h2'), /Fins de semana de gig 2 gigs em 30 dias/);
    assert.match(texto('.sd-gig p'), /dorme em média 5h00, contra 7h0\d nas outras noites/);
  });
  test('período de 7 dias muda o endereço e o gráfico', async () => {
    await clicar('[data-per="7"]');
    assert.equal(location.hash, '#/saude?7');
    assert.match($('.sd-card svg').getAttribute('aria-label'), /de 13 out a 19 out/);
    await clicar('[data-per="30"]');
  });
  test('Atualizar chama o garmin-sync e avisa os hábitos marcados', async () => {
    banco().funcoes['garmin-sync'] = () => ({ ok: true, habitos: 2 });
    await clicar('#sdSync', 15);
    assert.deepEqual(banco().invocacoes.at(-1), { nome: 'garmin-sync', body: { dias: 2 } });
    assert.equal(texto('#toast'), 'Garmin atualizado, 2 hábito(s) marcados');
  });
  test('erro do Garmin vira aviso', async () => {
    banco().funcoes['garmin-sync'] = () => ({ erro: 'token expirado' });
    await clicar('#sdSync', 15);
    assert.equal(texto('#toast'), 'Garmin: token expirado');
  });
});

describe('Saúde: situações especiais', () => {
  test('relógio sem mandar dados há dias: faixa explicando', async () => {
    await trocarDados(dados({ ultimoDia: 5 }), { supabase: true });
    banco().t('health_activities').push({ id: 3, inicio: '2026-10-19T08:00:00Z', dia: '2026-10-19', tipo: 'walking', duracao_seg: 600 });
    await abrir();
    assert.match(texto('.sd-parado'), /As atividades continuam chegando \(a última em 19 out\), mas o Garmin não tem passos, sono nem FC do dia a dia desde quarta, 14 de outubro/);
  });
  test('sem nenhum dado: instruções para conectar o Garmin', async () => {
    await trocarDados({}, { supabase: true });
    await abrir();
    assert.match(texto('.sd-vazio h2'), /Conectar o Garmin/);
    assert.match(texto('.view-head'), /Garmin ainda não sincronizou/);
  });
  test('falha ao ler o banco mostra o erro', async () => {
    await trocarDados({}, { supabase: true });
    const b = banco();
    b.falhas.health_daily = 'permission denied for table health_daily';
    // trava de segurança: depois de 30 tentativas a falha some, para o teste não rodar para sempre
    let visto = '';
    b.aoConsultar = t => {
      if (t !== 'health_daily') return;
      visto ||= $$('#view .banner').map(texto).find(x => /permission denied/.test(x)) || '';
      if (b.consultas.filter(c => c.tabela === t).length >= 30) delete b.falhas.health_daily;
    };
    await abrir();
    assert.match(visto, /Não foi possível carregar os dados de saúde: permission denied/);
  });
  test('falha ao ler o banco não fica tentando de novo sem parar', { todo: 'v-saude.js carregar(): no erro, D.at não muda; o render() do finally chama carregar() de novo e repete sem pausa (martela o Supabase)' }, async () => {
    globalThis.__relogio.avancar(6 * 60e3);
    await trocarDados({}, { supabase: true });
    const b = banco();
    b.falhas.health_daily = 'timeout';
    b.aoConsultar = t => { if (t === 'health_daily' && b.consultas.filter(c => c.tabela === t).length >= 30) delete b.falhas.health_daily; };
    location.hash = '#/saude'; V.render(el);
    await esperar(50);
    const n = b.consultas.filter(c => c.tabela === 'health_daily').length;
    assert.ok(n <= 2, `${n} consultas a health_daily depois de uma falha`);
  });
});
