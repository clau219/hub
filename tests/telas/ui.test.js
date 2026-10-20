// ui.js: formulários de oportunidade, próximo passo, tarefa, reserva (com checklist) e evento; toast, confirmação e roteamento de itens.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hub, $, $$, texto, preencher, enviarModal, esperar, clicar } from '../helpers/dom.js';
import { abrirHub, trocarDados, guardado } from '../helpers/tela.js';

let ui, S;
before(async () => {
  ({ S } = await abrirHub());
  ui = await hub('ui.js');
});
const modalAberto = () => $('#modal').open;
const erroModal = () => texto('#modalErr');
const fechar = () => $('#modal').open && $('#modal').close();
beforeEach(fechar);

describe('toast e modal', () => {
  test('toast mostra a mensagem', () => {
    ui.toast('Olá');
    assert.equal(texto('#toast'), 'Olá');
    assert.ok($('#toast').classList.contains('on'));
  });
  test('evento hub:aviso vira toast', () => {
    window.dispatchEvent(new CustomEvent('hub:aviso', { detail: 'Google Agenda: erro' }));
    assert.equal(texto('#toast'), 'Google Agenda: erro');
  });
  test('modal: erro do onSubmit fica visível e mantém aberto; sucesso fecha', async () => {
    let n = 0;
    ui.modal('Teste', '<input name="a" value="1"><input type="checkbox" name="c">', { onSubmit: async f => { n++; if (n === 1) throw new Error('falhou'); assert.deepEqual(f, { a: '1', c: false }); } });
    assert.equal(texto('#modalTitle'), 'Teste');
    await enviarModal();
    assert.equal(erroModal(), 'falhou');
    assert.equal(modalAberto(), true);
    await enviarModal();
    assert.equal(modalAberto(), false);
  });
  test('modal sem onSubmit não tem botão salvar; closeModal fecha', () => {
    ui.modal('Só ler', '<p>x</p>');
    assert.equal($('#modalFoot button[value=ok]'), null);
    ui.closeModal();
    assert.equal(modalAberto(), false);
  });
  test('confirmInline pede o segundo clique', () => {
    const b = document.createElement('button'); b.textContent = 'Excluir';
    assert.equal(ui.confirmInline(b), false);
    assert.equal(b.textContent, 'Clique de novo para confirmar');
    assert.equal(ui.confirmInline(b), true);
  });
});

describe('oportunidade (dealForm)', () => {
  beforeEach(() => trocarDados({ contacts: [{ id: 'c1', nome: 'Bia Lima', telefone: '84 98888-7777' }] }));
  test('nova: sugere a próxima ação da etapa e cria contato + oportunidade', async () => {
    ui.dealForm();
    assert.equal(texto('#modalTitle'), 'Nova oportunidade');
    const m = $('#modal');
    assert.equal(m.querySelector('[name=proxima_acao]').value, 'Enviar orçamento');
    assert.equal(m.querySelector('[name=data_proxima_acao]').value, '2026-10-20');
    preencher(m, { contato: 'Ana Souza', telefone: '(84) 99999-0000', valor: '1500', data_evento: '2026-12-12', local: 'Pipa' });
    await enviarModal();
    assert.equal(modalAberto(), false, erroModal());
    const c = S.contacts.find(c => c.nome === 'Ana Souza');
    assert.equal(c.tipo, 'contratante');
    assert.equal(c.telefone, '(84) 99999-0000');
    const d = S.deals[0];
    assert.deepEqual({ titulo: d.titulo, etapa: d.etapa, contato_id: d.contato_id, valor: d.valor, proxima_acao: d.proxima_acao, data_evento: d.data_evento },
      { titulo: 'DJ — Ana Souza', etapa: 'lead', contato_id: c.id, valor: '1500', proxima_acao: 'Enviar orçamento', data_evento: '2026-12-12' });
    assert.equal(texto('#toast'), 'Oportunidade criada');
  });
  test('etapa aberta sem próxima ação não salva', async () => {
    ui.dealForm();
    preencher($('#modal'), { contato: 'X', proxima_acao: '  ' });
    await enviarModal();
    assert.match(erroModal(), /Nada fica aberto sem um próximo passo/);
    assert.equal(S.deals.length, 0);
  });
  test('telefone incompleto não salva', async () => {
    ui.dealForm();
    preencher($('#modal'), { contato: 'X', telefone: '9999' });
    await enviarModal();
    assert.match(erroModal(), /Telefone incompleto/);
  });
  test('trocar a etapa troca a sugestão; etapa fechada (pago) esconde a próxima ação', () => {
    ui.dealForm();
    const m = $('#modal');
    preencher(m, { etapa: 'negociacao' });
    assert.equal(m.querySelector('[name=proxima_acao]').value, 'Fechar e pedir sinal');
    assert.equal(m.querySelector('[name=data_proxima_acao]').value, '2026-10-21');
    preencher(m, { etapa: 'pago' });
    assert.equal(m.querySelector('#fNext').hidden, true);
    assert.equal(m.querySelector('#fPerda').hidden, true);
    preencher(m, { etapa: 'perdido' });
    assert.equal(m.querySelector('#fPerda').hidden, false);
  });
  test('perdido exige motivo, que vai para as notas; sem próxima ação', async () => {
    ui.dealForm();
    preencher($('#modal'), { contato: 'Caio', etapa: 'perdido', notas: 'achou caro' });
    await enviarModal();
    assert.match(erroModal(), /motivo da perda/);
    preencher($('#modal'), { motivo_perda: 'Preço' });
    await enviarModal();
    const d = S.deals[0];
    assert.equal(d.notas, '[Perdido: Preço] achou caro');
    assert.equal(d.proxima_acao, null);
    assert.equal(d.data_proxima_acao, null);
  });
  test('escolher contato existente traz o telefone dele', () => {
    ui.dealForm();
    const m = $('#modal');
    preencher(m, { contato: 'bia lima' });
    assert.equal(m.querySelector('[name=telefone]').value, '84 98888-7777');
  });
  test('datas rápidas preenchem a data da próxima ação', async () => {
    ui.dealForm();
    await clicar($$('#modal [data-add]').find(b => b.textContent === '+1 sem'));
    assert.equal($('#modal [name=data_proxima_acao]').value, '2026-10-26');
  });
  test('preset da captura (+dj) preenche negócio, data, contato digitado e notas', () => {
    ui.dealForm({}, { negocio: 'consultoria', data_evento: '2026-11-11', _contato: 'Novo Cliente', notas: 'reforma' });
    const m = $('#modal');
    assert.equal(m.querySelector('[name=negocio]').value, 'consultoria');
    assert.equal(m.querySelector('[name=data_evento]').value, '2026-11-11');
    assert.equal(m.querySelector('[name=contato]').value, 'Novo Cliente');
    assert.equal(m.querySelector('[name=notas]').value, 'reforma');
  });
  test('existente: WhatsApp com mensagem da etapa, editar mantém o título, excluir em 2 cliques', async () => {
    await trocarDados({ contacts: [{ id: 'c1', nome: 'Bia Lima', telefone: '84 98888-7777' }],
      deals: [{ id: 'd1', titulo: 'Casamento Bia', negocio: 'dj', etapa: 'orcamento', contato_id: 'c1', proxima_acao: 'Follow-up', data_proxima_acao: '2026-10-22' }],
      quotes: [{ id: 'q1', deal_id: 'd1', arquivo: 'orc.docx', valor_total: 3500, horas: 5 }] });
    ui.dealForm(S.deals[0]);
    assert.equal(texto('#modalTitle'), 'Oportunidade');
    const wa = $('#waDeal');
    assert.ok(wa.href.startsWith('https://wa.me/5584988887777?text=Oi%2C%20Bia!'));
    assert.match(texto('.quotes'), /orc\.docx: R\$ 3\.500, 5h/);
    preencher($('#modal'), { valor: '4000' });
    await enviarModal();
    assert.equal(S.deals[0].titulo, 'Casamento Bia');
    assert.equal(S.deals[0].valor, '4000');
    ui.dealForm(S.deals[0]);
    await clicar('#delDeal');
    assert.equal(S.deals.length, 1);
    await clicar('#delDeal');
    assert.equal(S.deals.length, 0);
    assert.equal(texto('#toast'), 'Oportunidade excluída');
  });
});

describe('próximo passo (dealDone) e adiar', () => {
  beforeEach(() => trocarDados({ contacts: [{ id: 'c1', nome: 'Bia' }],
    deals: [{ id: 'd1', titulo: 'Festa', negocio: 'dj', etapa: 'lead', contato_id: 'c1', proxima_acao: 'Enviar orçamento', data_proxima_acao: '2026-10-18', notas: 'velha' }],
    tasks: [{ id: 't1', titulo: 'Tarefa', prazo: '2026-10-18' }] }));
  test('salva etapa e próxima ação e atualiza a última interação do contato', async () => {
    ui.dealDone(S.deals[0]);
    assert.match(texto('#modalBody'), /Festa: “Enviar orçamento”/);
    preencher($('#modal'), { etapa: 'orcamento' });
    assert.equal($('#modal [name=proxima_acao]').value, 'Follow-up do orçamento');
    await enviarModal();
    assert.deepEqual({ etapa: S.deals[0].etapa, p: S.deals[0].proxima_acao, d: S.deals[0].data_proxima_acao }, { etapa: 'orcamento', p: 'Follow-up do orçamento', d: '2026-10-22' });
    assert.equal(S.contacts[0].ultima_interacao, '2026-10-19');
  });
  test('sem próxima ação não salva; perdido pede motivo e junta às notas', async () => {
    ui.dealDone(S.deals[0]);
    await enviarModal();
    assert.match(erroModal(), /Defina a próxima ação/);
    preencher($('#modal'), { etapa: 'perdido' });
    assert.equal($('#fNextLbl').hidden, true);
    await enviarModal();
    assert.match(erroModal(), /motivo/);
    preencher($('#modal'), { motivo_perda: 'Escolheu outro' });
    await enviarModal();
    assert.equal(S.deals[0].notas, '[Perdido: Escolheu outro] velha');
    assert.equal(S.deals[0].proxima_acao, null);
  });
  test('título personalizado (volta do WhatsApp)', () => {
    ui.dealDone(S.deals[0], { titulo: 'Mensagem enviada? E agora?' });
    assert.equal(texto('#modalTitle'), 'Mensagem enviada? E agora?');
  });
  test('snooze adia tarefa e ação de deal', async () => {
    await ui.snooze({ kind: 'tarefa', ref: S.tasks[0] }, 1);
    assert.equal(S.tasks[0].prazo, '2026-10-20');
    assert.equal(texto('#toast'), 'Adiado para amanhã');
    await ui.snooze({ kind: 'acao', ref: S.deals[0] }, 3);
    assert.equal(S.deals[0].data_proxima_acao, '2026-10-22');
    assert.equal(texto('#toast'), 'Adiado 3 dias');
  });
  test('voltar ao Hub depois de abrir o WhatsApp pergunta o próximo passo', async () => {
    ui.aposWhats(S.deals[0]);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 350));
    assert.equal(modalAberto(), true);
    assert.equal(texto('#modalTitle'), 'Mensagem enviada? E agora?');
  });
  test('dealWa: sem telefone, sem link', () => {
    assert.equal(ui.dealWa(S.deals[0]), null);
  });
});

describe('tarefa', () => {
  beforeEach(() => trocarDados({ tasks: [{ id: 't1', titulo: 'Ligar Ana', area: 'dj', prioridade: 2 }] }));
  test('nova tarefa com área, prazo e prioridade numérica', async () => {
    ui.taskForm({ area: 'inbox' });
    preencher($('#modal'), { titulo: 'Comprar cabo', area: 'casa', prazo: '2026-10-25', prioridade: '1' });
    await enviarModal();
    const t = S.tasks.find(t => t.titulo === 'Comprar cabo');
    assert.deepEqual({ area: t.area, prazo: t.prazo, prioridade: t.prioridade }, { area: 'casa', prazo: '2026-10-25', prioridade: 1 });
  });
  test('toggleTask conclui e reabre', async () => {
    await ui.toggleTask(S.tasks[0]);
    assert.equal(S.tasks[0].feito, true);
    assert.equal(S.tasks[0].feito_em, '2026-10-19T15:00:00.000Z');
    assert.equal(texto('#toast'), 'Tarefa concluída');
    await ui.toggleTask(S.tasks[0]);
    assert.equal(S.tasks[0].feito, false);
    assert.equal(S.tasks[0].feito_em, null);
  });
  test('"Virar oportunidade" apaga a tarefa e abre o deal com o texto nas notas', async () => {
    ui.taskForm(S.tasks[0]);
    await clicar('#toDeal');
    assert.equal(S.tasks.length, 0);
    assert.equal(texto('#modalTitle'), 'Nova oportunidade');
    assert.equal($('#modal [name=notas]').value, 'Ligar Ana');
    assert.equal($('#modal [name=negocio]').value, 'dj');
  });
  test('excluir tarefa em 2 cliques', async () => {
    ui.taskForm(S.tasks[0]);
    await clicar('#delTask'); await clicar('#delTask');
    assert.equal(S.tasks.length, 0);
  });
});

describe('reserva (bookingForm)', () => {
  beforeEach(() => trocarDados({ bookings: [{ id: 'b1', property_id: 'QS39', origem: 'airbnb', status: 'confirmada', hospede: 'Ana', checkin: '2026-11-10', checkout: '2026-11-13' }] }));
  test('check-out antes do check-in não salva', async () => {
    ui.bookingForm();
    preencher($('#modal'), { checkin: '2026-11-05', checkout: '2026-11-05' });
    await enviarModal();
    assert.match(erroModal(), /check-out precisa ser depois/);
  });
  test('sobreposição na mesma casa avisa o conflito; outra casa ou cancelada passa', async () => {
    ui.bookingForm();
    preencher($('#modal'), { property_id: 'QS39', checkin: '2026-11-12', checkout: '2026-11-15' });
    await enviarModal();
    assert.match(erroModal(), /Conflito com a reserva de Ana \(2026-11-10 a 2026-11-13\)/);
    preencher($('#modal'), { property_id: 'QS40' });
    await enviarModal();
    assert.equal(modalAberto(), false, erroModal());
    assert.equal(S.bookings.length, 2);
  });
  test('reserva direta grava etapas marcadas e hóspedes', async () => {
    ui.bookingForm();
    const m = $('#modal');
    preencher(m, { property_id: 'QS50', origem: 'direto', hospede: 'Caio', checkin: '2026-12-20', checkout: '2026-12-27', et_orcamento: true, hospedes: 'Caio Prado, RG 1\nLia' });
    await enviarModal();
    const b = S.bookings.find(b => b.hospede === 'Caio');
    assert.deepEqual(b.etapas, { orcamento: '2026-10-19' });
    assert.deepEqual(b.hospedes, [{ nome: 'Caio Prado', doc: 'RG 1' }, { nome: 'Lia', doc: '' }]);
    assert.equal(b.status, 'confirmada');
  });
  test('checklist reage à origem, ao status e ao check-in', () => {
    ui.bookingForm();
    const m = $('#modal');
    preencher(m, { origem: 'airbnb', checkin: '2026-10-20' }); // portaria = check-in − 2 = ontem
    assert.ok($$('#fHosp [data-direto]').every(li => li.hidden));
    const portaria = m.querySelector('[data-step=portaria] .hosp-when');
    assert.equal(portaria.textContent, 'até ontem');
    assert.ok(portaria.classList.contains('late-lbl'));
    preencher(m, { origem: 'direto' });
    assert.ok($$('#fHosp [data-direto]').every(li => !li.hidden));
    preencher(m, { status: 'bloqueio' });
    assert.equal($('#fHosp').hidden, true);
  });
  test('copiar mensagem da portaria vai para a área de transferência', async () => {
    ui.bookingForm();
    const m = $('#modal');
    await clicar('#copyPortaria');
    assert.equal(texto('#copyPortaria'), 'Preencha check-in e check-out');
    preencher(m, { property_id: 'QS40', checkin: '2026-12-01', checkout: '2026-12-03', hospedes: 'Ana, RG 9' });
    await clicar('#copyPortaria');
    assert.match(await navigator.clipboard.readText(), /na Casa Azul \(QS40\), com entrada em 01\/12\/2026[\s\S]*1\. Ana \(RG 9\)/);
    assert.match(texto('#copyPortaria'), /^Copiado/);
  });
  test('etapaDone marca a etapa a partir do Hoje', async () => {
    await ui.etapaDone(S.bookings[0], 'faxina');
    assert.deepEqual(S.bookings[0].etapas, { faxina: '2026-10-19' });
    assert.equal(texto('#toast'), 'Confirmar faxina da casa: feito');
  });
  test('excluir reserva em 2 cliques', async () => {
    ui.bookingForm(S.bookings[0]);
    await clicar('#delBk'); await clicar('#delBk');
    assert.equal(S.bookings.length, 0);
  });
});

describe('evento manual', () => {
  beforeEach(() => trocarDados({ events: [{ id: 'e1', titulo: 'Google', origem: 'google', calendario: 'dj', inicio: '2026-10-20T23:00:00Z' }, { id: 'e2', titulo: 'Meu', origem: 'manual', calendario: 'pessoal', dia_inteiro: true, inicio: '2026-10-21T12:00:00Z' }] }));
  test('com horário: converte de Pipa (-03:00) para UTC', async () => {
    ui.eventForm({}, '2026-10-25');
    assert.equal($('#modal [name=data]').value, '2026-10-25');
    preencher($('#modal'), { titulo: 'Show', calendario: 'dj', hi: '22:00', hf: '23:30', local: 'Bar' });
    await enviarModal();
    const e = S.events.find(e => e.titulo === 'Show');
    assert.deepEqual({ i: e.inicio, f: e.fim, d: e.dia_inteiro, o: e.origem }, { i: '2026-10-26T01:00:00.000Z', f: '2026-10-26T02:30:00.000Z', d: false, o: 'manual' });
  });
  test('sem horário vira dia inteiro', async () => {
    ui.eventForm();
    preencher($('#modal'), { titulo: 'Feriado' });
    await enviarModal();
    const e = S.events.find(e => e.titulo === 'Feriado');
    assert.deepEqual({ i: e.inicio, f: e.fim, d: e.dia_inteiro }, { i: '2026-10-19T12:00:00Z', f: null, d: true });
  });
  test('evento do Google abre com hora local e não pode ser excluído; manual pode', async () => {
    ui.eventForm(S.events.find(e => e.id === 'e1'));
    assert.equal($('#modal [name=hi]').value, '20:00');
    assert.equal($('#modal [name=data]').value, '2026-10-20');
    assert.equal($('#delEv'), null);
    ui.eventForm(S.events.find(e => e.id === 'e2'));
    assert.equal($('#modal [name=data]').value, '2026-10-21');
    await clicar('#delEv'); await clicar('#delEv');
    assert.equal(S.events.length, 1);
  });
});

describe('openItem abre o formulário certo', () => {
  before(() => trocarDados({ bookings: [{ id: 'b1', property_id: 'QS39', checkin: '2026-11-01', checkout: '2026-11-02', status: 'confirmada' }] }));
  const casos = [
    [{ kind: 'tarefa', ref: { id: 't', titulo: 'x' } }, 'Tarefa'],
    [{ kind: 'checkin', ref: { id: 'b1', property_id: 'QS39' } }, 'Reserva'],
    [{ kind: 'etapa', ref: { id: 'b1', property_id: 'QS39' } }, 'Reserva'],
    [{ kind: 'evento', ref: { id: 'e', inicio: '2026-10-20T10:00:00Z' } }, 'Evento'],
    [{ kind: 'conflito', ref: { id: 'b1', property_id: 'QS39' } }, 'Reserva'],
    [{ kind: 'conflito', ref: { id: 'd', etapa: 'fechado' } }, 'Oportunidade'],
    [{ kind: 'gig', ref: { id: 'd', etapa: 'fechado' } }, 'Oportunidade'],
  ];
  for (const [it, titulo] of casos) test(`${it.kind}${it.ref.property_id ? ' (reserva)' : ''} → ${titulo}`, () => {
    fechar();
    ui.openItem(it);
    assert.equal(texto('#modalTitle'), titulo);
  });
});
