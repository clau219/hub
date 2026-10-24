// frases.js: as frases que interpretam os cards do Hoje e de Finanças (relógio parado em segunda, 19/10/2026).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { hub } from '../helpers/dom.js';

let F;
before(async () => { F = await hub('frases.js'); });
const HOJE = '2026-10-19';
// sem os espaços que não quebram e o "junta" do sinal (⁠)
const sem = s => s.replace(/ /g, ' ').replace(/⁠/g, '');

describe('frases do Hoje', () => {
  test('dia: gig com hora, check-in, check-out e compromisso numa frase só', () => {
    const f = F.fraseDia([
      { kind: 'gig', time: '21:00', title: 'DJ — Makai' },
      { kind: 'checkin', title: 'Check-in Casa Frida' },
      { kind: 'checkout', title: 'Check-out Casa Azul' },
      { kind: 'evento', time: '14:00', title: 'Dentista' },
    ]);
    assert.equal(f.texto, 'Gig às 21:00 (Makai), check-in na Frida, check-out na Azul e 14:00 Dentista.');
  });
  test('dia vazio ou só com tarefas: sem frase', () => {
    assert.equal(F.fraseDia([]), null);
    assert.equal(F.fraseDia([{ kind: 'tarefa', title: 'X' }]), null);
  });
  test('ocupação: % das próximas 14 noites por casa e o fim de semana livre da mais vazia', () => {
    const casas = [{ id: 'A', nome: 'Casa Azul' }, { id: 'F', nome: 'Casa Frida' }];
    // Frida ocupada nas 14 noites; Azul ocupada só de 19 a 22 (4 noites) → livre sex 23 e sáb 24
    const ocupada = (id, d) => id === 'F' || (d >= '2026-10-19' && d <= '2026-10-22');
    assert.equal(F.fraseOcupacao(casas, ocupada, HOJE).texto, 'Próximas 2 semanas: Frida 100%, Azul 29%. A Azul está livre neste fim de semana.');
    // Fim de semana livre mais adiante: diz qual
    const cheia = (id, d) => id === 'F' || d < '2026-10-26';
    assert.match(F.fraseOcupacao(casas, cheia, HOJE).texto, /livre no próximo fim de semana \(30 out\)\.$/);
    assert.equal(F.fraseOcupacao([], ocupada, HOJE), null);
  });
  test('pipeline: negociações paradas (próxima ação vencida) e o maior saldo a receber', () => {
    const deals = [
      { titulo: 'DJ — Rafael', etapa: 'orcamento', data_proxima_acao: '2026-10-11' },
      { titulo: 'DJ — Bruno', etapa: 'lead', data_proxima_acao: '2026-10-16' },
      { titulo: 'DJ — Hoje', etapa: 'lead', data_proxima_acao: HOJE },
      { titulo: 'DJ — Fechado parado', etapa: 'fechado', data_proxima_acao: '2026-10-01', valor: 1000, pagamentos: [{ valor: 1000 }] },
      { titulo: 'DJ — Kamilla', etapa: 'fechado', valor: 4000, pagamentos: [{ valor: 550 }] },
      { titulo: 'DJ — Roberta', etapa: 'realizado', valor: 595, pagamentos: [] },
      { titulo: 'DJ — Pago', etapa: 'pago', valor: 900, pagamentos: [] },
    ];
    assert.equal(sem(F.frasePipeline(deals, HOJE).texto),
      '2 negociações paradas: a mais antiga é Rafael (8 dias sem o próximo passo). A receber: R$ 4.045, o maior saldo é Kamilla (R$ 3.450).');
    assert.equal(F.frasePipeline([{ titulo: 'DJ — Ok', etapa: 'lead', data_proxima_acao: '2026-10-25' }], HOJE), null);
  });
});

describe('frases de Finanças', () => {
  const cat = t => t.categoria || 'Outros';
  const tx = (data, valor, categoria) => ({ data, valor, categoria });
  test('mês em andamento compara com o anterior até o mesmo dia e aponta a categoria que mais subiu', () => {
    const l = [
      tx('2026-10-05', -1000, 'Mercado'), tx('2026-10-10', -1240, 'Manutenção'), tx('2026-10-12', 5000, 'Airbnb'),
      tx('2026-09-05', -1100, 'Mercado'), tx('2026-09-15', -300, 'Manutenção'),
      tx('2026-09-25', -9000, 'Moradia'), // depois do dia 19: não entra na comparação
    ];
    const f = F.fraseSaidas(l, '2026-10', cat, { hoje: HOJE });
    assert.equal(sem(f.texto), 'Saídas até o dia 19 60% acima de setembro. Quem mais subiu foi Manutenção (+R$ 940).');
    assert.equal(f.cat, 'Manutenção');
  });
  test('mês fechado compara o mês inteiro; diferença pequena vira "parecidas", sem link', () => {
    const l = [tx('2026-09-28', -1020, 'Mercado'), tx('2026-08-03', -1000, 'Mercado')];
    const f = F.fraseSaidas(l, '2026-09', cat, { hoje: HOJE });
    assert.equal(f.texto, 'Saídas no mês parecidas com agosto.');
    assert.equal(f.cat, undefined);
  });
  test('saídas caíram: diz quanto, sem apontar categoria', () => {
    const f = F.fraseSaidas([tx('2026-10-02', -500, 'Mercado'), tx('2026-09-02', -1000, 'Mercado')], '2026-10', cat, { hoje: HOJE });
    assert.equal(f.texto, 'Saídas até o dia 19 50% abaixo de setembro.');
  });
  test('sem base no mês anterior: sem frase', () => {
    assert.equal(F.fraseSaidas([tx('2026-10-02', -500, 'Mercado')], '2026-10', cat, { hoje: HOJE }), null);
  });
  test('usa o formatador da tela (modo privado, R$/US$)', () => {
    const f = F.fraseSaidas([tx('2026-10-02', -2000, 'Mercado'), tx('2026-09-02', -1000, 'Mercado')], '2026-10', cat, { hoje: HOJE, fmt: () => '•••' });
    assert.match(sem(f.texto), /\(\+•••\)/);
  });
  test('negócios: o que mais rendeu (com a casa da frente) e quem ficou no vermelho', () => {
    // casa (gasto pessoal) não entra como "no vermelho"
    const g = { casa: { ent: 0, sai: -2000, casas: {} }, alugueis: { ent: 6000, sai: -1500, casas: { QS39: { ent: 4000, sai: -500 }, QS40: { ent: 2000, sai: -1000 } } }, dj: { ent: 0, sai: -800, casas: {} }, '': { ent: 0, sai: -5000, casas: {} } };
    const nomes = { alugueis: 'Aluguéis', dj: 'DJ' };
    const f = F.fraseNegocios(g, n => nomes[n], c => ({ QS39: 'Casa Frida', QS40: 'Casa Azul' }[c]));
    assert.equal(sem(f.texto), 'Aluguéis foi o que mais rendeu (R$ 4.500), com a Casa Frida na frente. DJ (-R$ 800) ficou no vermelho.');
  });
});
