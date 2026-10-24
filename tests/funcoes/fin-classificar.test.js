// Edge Function fin-classificar (+ _shared/fin-classificar.ts): categorização dos lançamentos em camadas
// (tipo da Pluggy, regras, memória das correções, reservas/gigs do Hub) e IA simulada para o resto.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { carregarFuncao, pedido, lerJson, comCron, definirEnv } from '../helpers/funcao.js';
import { novoBanco, banco } from '../helpers/fake-supabase.js';
import { limparRede } from '../helpers/rede.js';

let fn;
const IA = () => (globalThis.__anthropic ||= { chamadas: [], responder: () => { throw new Error('IA não simulada'); } });
const t = (id, valor, descricao, x = {}) => ({ id, conta_id: 'acc1', data: '2026-10-10', valor, descricao, status: 'POSTED', manual: false, ...x });
const CASAS = [{ id: 'QS39', nome: 'Casa Frida' }, { id: 'QS40', nome: 'Casa Azul' }, { id: 'QS50', nome: 'Casa Terracota' }];
const DADOS = (x = {}) => comCron({ fin_regras: [], fin_contas: [{ id: 'acc1', tipo: 'BANK', nome: 'Nubank' }], properties: CASAS, bookings: [], deals: [], contacts: [], ...x });
const rodar = (corpo = {}, auth = 'cron') => fn(pedido('/fin-classificar', { corpo, auth })).then(lerJson);
const porId = () => Object.fromEntries(banco().t('fin_tx').map(x => [x.id, x]));
// IA que responde por texto do lançamento: mapa { trecho: {categoria, negocio, confianca, ...} }
function iaResponde(mapa) {
  IA().responder = params => {
    const linhas = params.messages[0].content.split('\n').slice(1);
    return { itens: linhas.map((l, k) => {
      const r = Object.entries(mapa).find(([trecho]) => l.includes(trecho))?.[1] || {};
      return { i: k + 1, categoria: 'Outros', negocio: 'pessoal', casa: '', confianca: 'baixa', alternativa: 'nenhuma', alternativa_negocio: 'nenhum', motivo: 'sem pista', ...r };
    }) };
  };
}

before(async () => { fn = await carregarFuncao('fin-classificar', { ANTHROPIC_API_KEY: 'sk-teste' }); });
beforeEach(() => { limparRede(); IA().chamadas = []; definirEnv('ANTHROPIC_API_KEY', 'sk-teste'); });

describe('fin-classificar: acesso', () => {
  test('sem credencial: 401; usuário logado pode', async () => {
    novoBanco(DADOS({ fin_tx: [] }));
    assert.equal((await rodar({}, null)).status, 401);
    assert.equal((await rodar({}, 'usuario')).status, 200);
  });
});

describe('camadas sem IA', () => {
  test('tipo da Pluggy, regra, memória, Airbnb, reserva direta e gig; o resto vai para a IA', async () => {
    novoBanco(DADOS({
      fin_regras: [{ id: 'r1', contem: 'condominio pipa', categoria: 'Condomínio', negocio: 'alugueis', casa: 'QS40' }],
      bookings: [{ id: 'b1', property_id: 'QS50', hospede: 'Ana Paula Souza', checkin: '2026-11-02', checkout: '2026-11-06', origem: 'direto', status: 'confirmada', valor: 3200 }],
      contacts: [{ id: 'c1', nome: 'Guilherme Prado', tipo: 'contratante' }],
      deals: [{ id: 'd1', negocio: 'dj', etapa: 'fechado', contato_id: 'c1', valor: 3500, data_evento: '2026-10-25' }],
      fin_tx: [
        t('fatura', -900, 'Pagamento de fatura', { cat_pluggy: 'Credit card payment' }),
        t('acoes', -500, 'Compra PETR4', { cat_pluggy: 'Variable income' }),
        t('cond', -650, 'BOLETO CONDOMINIO PIPA SOL', { cat_pluggy: 'Housing' }),
        t('maria-antiga', -150, 'Pix enviado', { contraparte: 'Maria José Lima', categoria: 'Faxina e limpeza', negocio: 'alugueis', casa: 'QS39', manual: true, origem_cat: 'manual', data: '2026-09-01' }),
        t('maria', -150, 'PIX ENVIADO MARIA JOSE LIMA', { cat_pluggy: 'Transfers' }),
        t('maria-entrada', 150, 'Pix recebido', { contraparte: 'Maria José Lima', cat_pluggy: 'Transfers' }),
        t('airbnb', 2100, 'TED AIRBNB PAYMENTS UK', { cat_pluggy: 'Transfers' }),
        t('ana', 1600, 'Pix recebido', { contraparte: 'ANA SOUZA', cat_pluggy: 'Transfers' }),
        t('gui', 1750, 'Pix recebido', { contraparte: 'GUILHERME P PRADO', cat_pluggy: 'Transfers' }),
        t('gui-velho', 1750, 'Pix recebido', { contraparte: 'GUILHERME P PRADO', data: '2025-12-01' }),
      ],
    }));
    iaResponde({});
    const { corpo } = await rodar();
    const x = porId();
    const ver = id => [x[id].categoria, x[id].negocio ?? null, x[id].casa ?? null, x[id].origem_cat];
    assert.deepEqual(ver('fatura'), ['Transferência entre contas', null, null, 'pluggy']);
    assert.deepEqual(ver('acoes'), ['Investimento', null, null, 'pluggy']);
    assert.deepEqual(ver('cond'), ['Condomínio', 'alugueis', 'QS40', 'regra']);
    assert.deepEqual(ver('maria'), ['Faxina e limpeza', 'alugueis', 'QS39', 'memoria'], 'mesmo recebedor, com prefixo diferente');
    assert.deepEqual(ver('airbnb'), ['Airbnb', 'alugueis', null, 'airbnb']);
    assert.deepEqual(ver('ana'), ['Reserva direta', 'alugueis', 'QS50', 'reserva']);
    assert.match(x.ana.ia_motivo, /reserva de Ana Paula Souza/);
    assert.deepEqual(ver('gui'), ['Cachê DJ', 'dj', null, 'gig']);
    // Memória vale só no mesmo sentido; gig longe da data do evento não casa: os dois vão para a IA
    assert.equal(x['maria-entrada'].origem_cat, 'ia');
    assert.equal(x['gui-velho'].origem_cat, 'ia');
    assert.equal(x['maria-antiga'].origem_cat, 'manual', 'manual não é mexido');
    assert.equal(IA().chamadas.length, 1);
    assert.deepEqual({ classificados: corpo.classificados, restantes: corpo.restantes }, { classificados: 9, restantes: 0 });
  });
});

describe('memória e repetidos', () => {
  test('compra no cartão: a correção só vale para a mesma compra (mesmo valor); correções divergentes não viram memória', async () => {
    novoBanco(DADOS({ fin_tx: [
      t('ml-man', -110.93, 'MERCADOLIVRE*MERC', { cat_pluggy: 'Online shopping', manual: true, origem_cat: 'manual', categoria: 'Equipamento', negocio: 'dj', data: '2026-09-11' }),
      t('ml-parc', -110.93, 'MERCADOLIVRE*MERC', { cat_pluggy: 'Online shopping' }),
      t('ml-outra', -50.94, 'MERCADOLIVRE*MERC', { cat_pluggy: 'Online shopping' }),
      t('ze1', -100, 'Pix enviado', { contraparte: 'JOSE COSTA', manual: true, origem_cat: 'manual', categoria: 'Manutenção', negocio: 'alugueis', data: '2026-08-01' }),
      t('ze2', -80, 'Pix enviado', { contraparte: 'JOSE COSTA', manual: true, origem_cat: 'manual', categoria: 'Lazer', negocio: 'pessoal', data: '2026-08-05' }),
      t('ze3', -90, 'Pix enviado', { contraparte: 'JOSE COSTA', cat_pluggy: 'Transfers' }),
    ] }));
    iaResponde({ MERCADOLIVRE: { categoria: 'Compras', negocio: 'pessoal', confianca: 'alta' } });
    await rodar();
    const x = porId();
    assert.deepEqual([x['ml-parc'].categoria, x['ml-parc'].origem_cat], ['Equipamento', 'memoria'], 'outra parcela da mesma compra');
    assert.deepEqual([x['ml-outra'].categoria, x['ml-outra'].origem_cat], ['Compras', 'ia'], 'outra compra no mesmo site não herda');
    assert.equal(x.ze3.origem_cat, 'ia', 'o mesmo recebedor com classificações diferentes: decide a IA');
  });
  test('parcelas e assinaturas iguais vão uma vez só para a IA e recebem o mesmo resultado', async () => {
    novoBanco(DADOS({ fin_tx: [1, 2, 3, 4].map(m => t('as' + m, -17.95, `Asaas *Useoinc ${m}/12`, { cat_pluggy: 'Services', contraparte: 'Asaas Useoinc', data: `2026-0${m}-25` })) }));
    iaResponde({ Asaas: { categoria: 'Assinaturas', negocio: 'pessoal', confianca: 'alta', motivo: 'serviço recorrente' } });
    await rodar();
    assert.equal(IA().chamadas[0].messages[0].content.split('\n').length, 2, 'cabeçalho + 1 lançamento');
    assert.ok(Object.values(porId()).every(x => x.categoria === 'Assinaturas' && x.origem_cat === 'ia'));
  });
});

describe('IA', () => {
  test('certeza alta aplica; média/baixa aplica o palpite e marca revisar com 2 sugestões; sentido e casa conferidos', async () => {
    novoBanco(DADOS({
      contacts: [{ id: 'c1', nome: 'Joana Reis', tipo: 'fornecedor' }],
      fin_tx: [
        t('ifood', -62, 'IFOOD *RESTAURANTE', { cat_pluggy: 'Food delivery' }),
        t('pix-joao', -300, 'Pix enviado', { contraparte: 'JOAO BATISTA', cat_pluggy: 'Transfers' }),
        t('ent-errada', 90, 'Estorno loja', { cat_pluggy: 'Shopping' }),
        t('casa-falsa', -80, 'LAVANDERIA PIPA', { cat_pluggy: 'Services' }),
        t('manual', -10, 'Café', { manual: true, categoria: 'Alimentação fora', negocio: 'pessoal', origem_cat: 'manual' }),
      ],
    }));
    iaResponde({
      IFOOD: { categoria: 'Alimentação fora', negocio: 'pessoal', confianca: 'alta', motivo: 'delivery de comida' },
      JOAO: { categoria: 'Manutenção', negocio: 'alugueis', casa: 'QS40', confianca: 'baixa', alternativa: 'Faxina e limpeza', alternativa_negocio: 'alugueis' },
      Estorno: { categoria: 'Compras', negocio: 'pessoal', confianca: 'alta' },
      LAVANDERIA: { categoria: 'Faxina e limpeza', negocio: 'alugueis', casa: 'QS99', confianca: 'media' },
    });
    const { corpo } = await rodar();
    const x = porId();
    assert.deepEqual([x.ifood.categoria, x.ifood.negocio, x.ifood.revisar, x.ifood.sugestoes, x.ifood.ia_motivo], ['Alimentação fora', 'pessoal', false, null, 'delivery de comida']);
    assert.deepEqual([x['pix-joao'].categoria, x['pix-joao'].casa, x['pix-joao'].revisar], ['Manutenção', 'QS40', true]);
    assert.deepEqual(x['pix-joao'].sugestoes, [
      { categoria: 'Manutenção', negocio: 'alugueis', casa: 'QS40' }, { categoria: 'Faxina e limpeza', negocio: 'alugueis', casa: 'QS40' }]);
    assert.deepEqual([x['ent-errada'].categoria, x['ent-errada'].revisar], ['Outras entradas', true], 'categoria de gasto numa entrada: troca e pede revisão');
    assert.deepEqual([x['casa-falsa'].casa ?? null, x['casa-falsa'].revisar], [null, true], 'casa que não existe é descartada');
    assert.equal(x.manual.categoria, 'Alimentação fora');
    assert.equal(corpo.revisar, 3);
    // O que a IA recebeu: categorias, casas, contatos e a correção do Claudio como exemplo; modelo e cache do contexto
    const p = IA().chamadas[0];
    assert.equal(p.model, 'claude-haiku-5-5');
    assert.equal(p.system[0].cache_control.type, 'ephemeral');
    assert.match(p.system[0].text, /QS39 = Casa Frida/);
    assert.match(p.system[0].text, /Joana Reis \(fornecedor\)/);
    assert.match(p.system[0].text, /"Café" → Alimentação fora · pessoal/);
    assert.match(p.messages[0].content, /JOAO BATISTA \| banco diz: Transfers \| conta Nubank/);
    assert.doesNotMatch(p.messages[0].content, /Café/, 'manual não vai para a IA');
  });
  test('muitos lançamentos: lotes de 60; limite por chamada e o que falta', async () => {
    novoBanco(DADOS({ fin_tx: Array.from({ length: 130 }, (_, i) => t('x' + i, -(i + 1), 'Compra ' + i, { data: `2026-${String(1 + (i % 9)).padStart(2, '0')}-10` })) }));
    iaResponde({});
    let r = (await rodar({ limite: 100 })).corpo;
    assert.deepEqual([r.classificados, r.restantes, IA().chamadas.length], [100, 30, 2]);
    r = (await rodar({ limite: 100 })).corpo;
    assert.deepEqual([r.classificados, r.restantes], [30, 0]);
  });
  test('IA fora do ar: fica a categoria da Pluggy, pendente para tentar de novo, e o erro volta', async () => {
    novoBanco(DADOS({ fin_tx: [t('a', -40, 'UBER TRIP', { cat_pluggy: 'Taxi and ride-hailing' }), t('b', -900, 'Fatura', { cat_pluggy: 'Credit card payment' })] }));
    IA().responder = () => { throw new Error('overloaded'); };
    const { corpo } = await rodar();
    const x = porId();
    assert.deepEqual([x.a.categoria, x.a.origem_cat ?? null], ['Transporte', null]);
    assert.equal(x.b.origem_cat, 'pluggy', 'o que não depende da IA já fica certo');
    assert.equal(corpo.erro_ia, 'overloaded');
    assert.equal(corpo.restantes, 1);
  });
  test('sem chave da Anthropic: categoria da Pluggy como definitiva (não fica em loop)', async () => {
    definirEnv('ANTHROPIC_API_KEY', undefined);
    novoBanco(DADOS({ fin_tx: [t('a', -40, 'UBER TRIP', { cat_pluggy: 'Taxi and ride-hailing' })] }));
    const { corpo } = await rodar();
    assert.deepEqual([porId().a.categoria, porId().a.origem_cat, corpo.restantes], ['Transporte', 'pluggy_sem_ia', 0]);
    assert.equal(IA().chamadas.length, 0);
  });
  test('refazer: volta os não manuais para pendente e reclassifica; manual fica', async () => {
    novoBanco(DADOS({ fin_tx: [
      t('a', -40, 'UBER TRIP', { categoria: 'Lazer', origem_cat: 'ia', revisar: true }),
      t('m', -40, 'UBER TRIP', { categoria: 'Transporte', negocio: 'dj', manual: true, origem_cat: 'manual' }),
    ] }));
    iaResponde({ UBER: { categoria: 'Transporte', negocio: 'pessoal', confianca: 'alta' } });
    await rodar({ refazer: true });
    const x = porId();
    // a correção manual do mesmo recebedor vira memória e ganha da IA
    assert.deepEqual([x.a.categoria, x.a.negocio, x.a.origem_cat, x.a.revisar], ['Transporte', 'dj', 'memoria', false]);
    assert.deepEqual([x.m.categoria, x.m.negocio, x.m.origem_cat], ['Transporte', 'dj', 'manual']);
  });
});
