// saude-insights.js: recomendação do dia (forte/leve/descanso) e cartões motivacionais a partir do Garmin.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/hub.js';

let I, U;
before(async () => { I = await hub('saude-insights.js'); U = await hub('util.js'); });
const HOJE = '2026-10-19'; // segunda
const dia = n => U.addDays(HOJE, n);
// 30 dias de base normal: VFC 50, FC repouso 55, sono 7h
const base = (extra = {}) => Array.from({ length: 30 }, (_, i) => ({ dia: dia(-(i + 1)), hrv_noite: 50, fc_repouso: 55, sono_seg: 7 * 3600 }))
  .concat(Object.keys(extra).length ? [{ dia: HOJE, ...extra }] : []);

describe('recomendação do dia', () => {
  test('recuperação boa → treino forte, com motivos', () => {
    const r = I.insights(base({ hrv_noite: 56, fc_repouso: 52, sono_seg: 8 * 3600, sono_score: 88, bb_max: 90 }), [], [], HOJE);
    assert.equal(r.estado, 'forte');
    assert.equal(r.titulo, 'Dia bom para treinar forte');
    assert.equal(r.semDados, false);
    assert.equal(r.motivos.length, 4);
    assert.ok(r.motivos.every(m => m.sinal === 1));
    assert.match(r.motivos[2].txt, /Sono de 8h00 \(nota 88\)/);
    assert.match(r.sugestao, /Força completa/); // nenhum treino de força na semana
  });
  test('VFC muito baixa + FC alta + sono curto → descanso ativo', () => {
    const r = I.insights(base({ hrv_noite: 38, fc_repouso: 61, sono_seg: 5 * 3600, bb_max: 35 }), [], [], HOJE);
    assert.equal(r.estado, 'descanso');
    assert.equal(r.titulo, 'Dia de descanso ativo');
    assert.match(r.motivos[1].txt, /6 acima do normal/);
  });
  test('um sinal ruim leve → treino leve; sugere corrida se correu pouco', () => {
    const r = I.insights(base({ hrv_noite: 50, fc_repouso: 55, sono_seg: 6 * 3600 }), [], [], HOJE);
    assert.equal(r.estado, 'leve');
    assert.match(r.sugestao, /^Corrida bem leve/);
  });
  test('sem dados de hoje usa os de ontem', () => {
    const d = base(); // ontem tem dados
    const r = I.insights(d, [], [], HOJE);
    assert.equal(r.semDados, false);
  });
  test('sem nenhum dado de recuperação: "Bora treinar" e semDados', () => {
    const r = I.insights([], [], [], HOJE);
    assert.equal(r.estado, 'forte');
    assert.equal(r.titulo, 'Bora treinar');
    assert.equal(r.semDados, true);
  });
  test('dois dias puxados e gig ontem pesam contra', () => {
    const acts = [{ dia: dia(-1), tipo: 'running', duracao_seg: 50 * 60 }, { dia: dia(-2), tipo: 'cycling', duracao_seg: 90 * 60 }];
    const r = I.insights([], acts, [dia(-1)], HOJE);
    assert.equal(r.estado, 'leve');
    assert.deepEqual(r.motivos.map(m => m.txt), ['Dois dias seguidos de treino puxado', 'Gig ontem à noite']);
  });
  test('já treinou hoje: recomenda recuperar; gig hoje adiciona dica', () => {
    const r = I.insights([], [{ dia: HOJE, tipo: 'strength_training', duracao_seg: 40 * 60 }], [HOJE], HOJE);
    assert.match(r.sugestao, /^Você já treinou 40 min hoje/);
    assert.match(r.sugestao, /Tem gig hoje/);
  });
  test('3+ dias parado muda o texto para incentivar a volta', () => {
    const r = I.insights([], [{ dia: dia(-5), tipo: 'running', duracao_seg: 1800 }], [], HOJE);
    assert.match(r.texto, /^Faz 5 dias sem registrar treino/);
  });
  test('com força e corrida em dia, sugere treino longo', () => {
    const acts = [-3, -5].map(n => ({ dia: dia(n), tipo: 'strength_training', duracao_seg: 1800 }))
      .concat([-4, -6].map(n => ({ dia: dia(n), tipo: 'running', duracao_seg: 1800 })));
    assert.match(I.insights([], acts, [], HOJE).sugestao, /^Treino longo e confortável/);
  });
});

describe('cartões da semana', () => {
  test('meta da OMS batida e sequência de semanas', () => {
    // segunda (hoje) 160 min; semana passada inteira 150+ min; retrasada não
    const acts = [{ dia: HOJE, tipo: 'running', duracao_seg: 160 * 60 }, { dia: dia(-3), tipo: 'running', duracao_seg: 150 * 60 }];
    const c = I.insights([], acts, [], HOJE).cards[0];
    assert.equal(c.tom, 'bom');
    assert.match(c.txt, /160 min de atividade desde segunda/);
    assert.match(c.txt, /São 2 semanas seguidas na meta!/);
  });
  test('meta não batida diz quantos treinos faltam', () => {
    const c = I.insights([], [{ dia: HOJE, tipo: 'running', duracao_seg: 30 * 60 }], [], HOJE).cards[0];
    assert.equal(c.titulo, 'Meta da semana');
    assert.match(c.txt, /30 de 150 min\. Faltam 120 min: 3 treinos de ~40 min fecham\./);
  });
  test('passos de hoje: falta ou batida', () => {
    const falta = I.insights([{ dia: HOJE, passos: 5000, meta_passos: 8000 }], [], [], HOJE).cards.find(c => c.titulo === 'Passos de hoje');
    assert.match(falta.txt, /Faltam 3\.000 passos/);
    const ok = I.insights([{ dia: HOJE, passos: 9000, meta_passos: 8000 }], [], [], HOJE).cards.find(c => c.titulo === 'Passos de hoje');
    assert.equal(ok.tom, 'bom');
  });
  test('sono da semana só com 3+ noites', () => {
    const duas = [0, -1].map(n => ({ dia: dia(n), sono_seg: 6 * 3600 }));
    assert.equal(I.insights(duas, [], [], HOJE).cards.find(c => /Sono/.test(c.titulo)), undefined);
    const tres = [0, -1, -2].map(n => ({ dia: dia(n), sono_seg: 6 * 3600 }));
    assert.equal(I.insights(tres, [], [], HOJE).cards.find(c => /Sono/.test(c.titulo)).titulo, 'Sono da semana');
  });
  test('constância na força (8+ em 4 semanas)', () => {
    const acts = Array.from({ length: 8 }, (_, i) => ({ dia: dia(-i * 3), tipo: 'strength_training', duracao_seg: 600 }));
    const c = I.insights([], acts, [], HOJE).cards.find(c => c.titulo === 'Constância na força');
    assert.match(c.txt, /8 treinos de força em 4 semanas, 2 por semana/);
  });
  test('FC de repouso caindo e VO2máx subindo viram elogios', () => {
    const d = [];
    for (let i = 0; i < 30; i++) d.push({ dia: dia(-i), fc_repouso: 52 });
    for (let i = 60; i < 90; i++) d.push({ dia: dia(-i), fc_repouso: 56 });
    d.push({ dia: dia(-100), vo2max: 44 }, { dia: dia(-1), vo2max: 46 });
    const cards = I.insights(d, [], [], HOJE).cards.map(c => c.titulo);
    assert.ok(cards.includes('Coração mais eficiente'));
    assert.ok(cards.includes('VO2máx subindo'));
  });
});
