import { h, today, addDays, ETAPAS, AREAS, ABERTAS, etapa, hhmm, localDate } from './util.js';
import { S, save, del, ensureContact, byId, contactName } from './store.js';

const dlg = () => document.getElementById('modal');

export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), ms);
}

// Abre um modal com formulário. onSubmit(dados) pode lançar erro para manter aberto.
export function modal(title, body, { submit = 'Salvar', onSubmit, extra = '' } = {}) {
  const d = dlg();
  d.querySelector('#modalTitle').textContent = title;
  d.querySelector('#modalBody').innerHTML = body;
  d.querySelector('#modalFoot').innerHTML = `<p class="modal-err" id="modalErr" role="alert"></p>${extra}<span class="sp"></span>
    <button class="btn" value="cancel" formnovalidate>Cancelar</button>
    ${onSubmit ? `<button class="btn primary" value="ok">${h(submit)}</button>` : ''}`;
  const form = d.querySelector('#modalForm');
  form.onsubmit = async ev => {
    if (ev.submitter?.value !== 'ok') return;
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[type=checkbox]').forEach(c => (data[c.name] = c.checked));
    try { await onSubmit(data); d.close(); }
    catch (e) { console.error(e); d.querySelector('#modalErr').textContent = e.message || 'Não foi possível salvar.'; }
  };
  d.showModal();
  setTimeout(() => d.querySelector('#modalBody [autofocus], #modalBody input, #modalBody select')?.focus(), 30);
  return d;
}
export const closeModal = () => dlg().close();

const opt = (v, label, sel) => `<option value="${h(v)}" ${v === sel ? 'selected' : ''}>${h(label)}</option>`;
const contactsList = () => `<datalist id="dlContatos">${S.contacts.map(c => `<option value="${h(c.nome)}">`).join('')}</datalist>`;

// ---------- Oportunidade (deal) ----------
export function dealForm(d = {}, preset = {}) {
  d = { negocio: 'dj', etapa: 'lead', ...preset, ...d };
  const e = etapa(d.etapa);
  const prox = d.proxima_acao ?? e.sug ?? '';
  const proxData = d.data_proxima_acao ?? (e.dias ? addDays(today(), e.dias) : '');
  const quotes = d.id ? S.quotes.filter(q => q.deal_id === d.id) : [];
  modal(d.id ? 'Oportunidade' : 'Nova oportunidade', `
    ${contactsList()}
    <div class="grid2">
      <label class="span2">Cliente / contratante<input name="contato" list="dlContatos" value="${h(contactName(d.contato_id))}" required autofocus></label>
      <label>Negócio<select name="negocio">${['dj', 'consultoria', 'flores', 'aluguel'].map(n => opt(n, AREAS[n].nome, d.negocio)).join('')}</select></label>
      <label>Etapa<select name="etapa" id="fEtapa">${ETAPAS.map(x => opt(x.id, x.nome, d.etapa)).join('')}</select></label>
      <label>Valor (R$)<input name="valor" type="number" step="0.01" value="${h(d.valor)}"></label>
      <label>Data do evento<input name="data_evento" type="date" value="${h(d.data_evento)}"></label>
      <label>Início<input name="hora_inicio" type="time" value="${h(d.hora_inicio?.slice(0, 5))}"></label>
      <label>Fim<input name="hora_fim" type="time" value="${h(d.hora_fim?.slice(0, 5))}"></label>
      <label class="span2">Local<input name="local" value="${h(d.local)}"></label>
    </div>
    <fieldset class="next" id="fNext">
      <legend>Próxima ação</legend>
      <div class="grid2">
        <label class="span2 lbl-hide">O que fazer<input name="proxima_acao" value="${h(prox)}" placeholder="ex.: Enviar orçamento por WhatsApp"></label>
        <label>Quando<input name="data_proxima_acao" type="date" value="${h(proxData)}"></label>
        <div class="quick-dates">${[['Hoje', 0], ['Amanhã', 1], ['+3d', 3], ['+1 sem', 7]].map(([l, n]) => `<button type="button" class="chip" data-add="${n}">${l}</button>`).join('')}</div>
      </div>
    </fieldset>
    <label>Notas<textarea name="notas" rows="2">${h(d.notas)}</textarea></label>
    ${quotes.length ? `<div class="quotes"><b>Orçamentos</b>${quotes.map(q => `<div>${h(q.arquivo || q.versao || 'Orçamento')}${q.valor_total ? ': R$ ' + Number(q.valor_total).toLocaleString('pt-BR') : ''}${q.horas ? `, ${q.horas}h` : ''}</div>`).join('')}</div>` : ''}
  `, {
    extra: d.id ? `<button type="button" class="btn danger" id="delDeal">Excluir</button>` : '',
    onSubmit: async f => {
      const aberta = ABERTAS.includes(f.etapa);
      if (aberta && (!f.proxima_acao?.trim() || !f.data_proxima_acao))
        throw new Error('Defina a próxima ação e a data. Nada fica aberto sem um próximo passo.');
      const contato_id = await ensureContact(f.contato, f.negocio === 'dj' ? 'contratante' : 'cliente');
      const titulo = d.titulo || `${AREAS[f.negocio].nome} — ${f.contato}`;
      const row = { titulo, negocio: f.negocio, etapa: f.etapa, contato_id, valor: f.valor, data_evento: f.data_evento,
        hora_inicio: f.hora_inicio, hora_fim: f.hora_fim, local: f.local, notas: f.notas,
        proxima_acao: aberta ? f.proxima_acao.trim() : null, data_proxima_acao: aberta ? f.data_proxima_acao : null };
      await save('deals', row, d.id);
      toast(d.id ? 'Oportunidade salva' : 'Oportunidade criada');
    },
  });
  const m = dlg();
  const sync = () => { m.querySelector('#fNext').hidden = !ABERTAS.includes(m.querySelector('#fEtapa').value); };
  m.querySelector('#fEtapa').onchange = ev => {
    const e2 = etapa(ev.target.value);
    if (e2.sug) {
      m.querySelector('[name=proxima_acao]').value = e2.sug;
      m.querySelector('[name=data_proxima_acao]').value = addDays(today(), e2.dias);
    }
    sync();
  };
  m.querySelectorAll('[data-add]').forEach(b => b.onclick = () => (m.querySelector('[name=data_proxima_acao]').value = addDays(today(), +b.dataset.add)));
  m.querySelector('#delDeal')?.addEventListener('click', async () => {
    if (!confirmInline(m.querySelector('#delDeal'))) return;
    await del('deals', d.id); closeModal(); toast('Oportunidade excluída');
  });
  sync();
}

// Concluir a ação de um deal: pede a próxima (ou encerra)
export function dealDone(d) {
  modal('Ação feita. E agora?', `
    <p class="muted">${h(d.titulo)}: “${h(d.proxima_acao)}”</p>
    <div class="grid2">
      <label>Etapa<select name="etapa" id="fEtapa">${ETAPAS.map(x => opt(x.id, x.nome, d.etapa)).join('')}</select></label>
      <label>Quando<input name="data_proxima_acao" type="date" value="${addDays(today(), 3)}"></label>
      <label class="span2" id="fNextLbl">Próxima ação<input name="proxima_acao" value="" placeholder="ex.: Cobrar resposta" autofocus></label>
    </div>`, {
    submit: 'Salvar próximo passo',
    onSubmit: async f => {
      const aberta = ABERTAS.includes(f.etapa);
      if (aberta && (!f.proxima_acao.trim() || !f.data_proxima_acao)) throw new Error('Defina a próxima ação e a data.');
      await save('deals', { etapa: f.etapa, proxima_acao: aberta ? f.proxima_acao : null, data_proxima_acao: aberta ? f.data_proxima_acao : null }, d.id);
      if (d.contato_id) await save('contacts', { ultima_interacao: today() }, d.contato_id);
      toast('Próximo passo salvo');
    },
  });
  const m = dlg();
  m.querySelector('#fEtapa').onchange = ev => {
    const e2 = etapa(ev.target.value);
    m.querySelector('#fNextLbl').hidden = !e2.sug;
    if (e2.sug) { m.querySelector('[name=proxima_acao]').value = e2.sug; m.querySelector('[name=data_proxima_acao]').value = addDays(today(), e2.dias); }
  };
}

export async function snooze(item, n) {
  const d = addDays(today(), n);
  if (item.kind === 'tarefa') await save('tasks', { prazo: d }, item.ref.id);
  else await save('deals', { data_proxima_acao: d }, item.ref.id);
  toast(n === 1 ? 'Adiado para amanhã' : `Adiado ${n} dias`);
}

// ---------- Tarefa ----------
export function taskForm(t = {}) {
  modal(t.id ? 'Tarefa' : 'Nova tarefa', `
    <label>Tarefa<input name="titulo" value="${h(t.titulo)}" required autofocus></label>
    <div class="grid2">
      <label>Área<select name="area">${Object.entries(AREAS).filter(([k]) => k !== 'aluguel').map(([k, a]) => opt(k, a.nome, t.area || 'inbox')).join('')}</select></label>
      <label>Prazo<input name="prazo" type="date" value="${h(t.prazo)}"></label>
      <label>Prioridade<select name="prioridade">${[[1, 'Alta'], [2, 'Normal'], [3, 'Baixa']].map(([v, l]) => opt(String(v), l, String(t.prioridade || 2))).join('')}</select></label>
    </div>
    <label>Notas<textarea name="notas" rows="2">${h(t.notas)}</textarea></label>`, {
    extra: t.id ? `<button type="button" class="btn" id="toDeal">Virar oportunidade</button><button type="button" class="btn danger" id="delTask">Excluir</button>` : '',
    onSubmit: async f => { await save('tasks', { ...f, prioridade: +f.prioridade }, t.id); toast('Tarefa salva'); },
  });
  const m = dlg();
  m.querySelector('#delTask')?.addEventListener('click', async () => {
    if (!confirmInline(m.querySelector('#delTask'))) return;
    await del('tasks', t.id); closeModal(); toast('Tarefa excluída');
  });
  m.querySelector('#toDeal')?.addEventListener('click', async () => {
    closeModal();
    await del('tasks', t.id);
    dealForm({}, { negocio: ['dj', 'consultoria', 'flores'].includes(t.area) ? t.area : 'dj', notas: t.titulo });
  });
}

export async function toggleTask(t) {
  await save('tasks', { feito: !t.feito, feito_em: !t.feito ? new Date().toISOString() : null }, t.id);
  toast(t.feito ? 'Tarefa reaberta' : 'Tarefa concluída');
}

// ---------- Reserva ----------
export function bookingForm(b = {}) {
  modal(b.id ? 'Reserva' : 'Nova reserva', `
    <div class="grid2">
      <label>Casa<select name="property_id">${S.properties.map(p => opt(p.id, `${p.nome} (${p.id})`, b.property_id)).join('')}</select></label>
      <label>Origem<select name="origem">${['direto', 'airbnb', 'booking', 'outro'].map(o => opt(o, o === 'direto' ? 'Direto (fora do Airbnb)' : o[0].toUpperCase() + o.slice(1), b.origem || 'direto')).join('')}</select></label>
      <label class="span2">Hóspede<input name="hospede" value="${h(b.hospede)}" autofocus></label>
      <label>Check-in<input name="checkin" type="date" value="${h(b.checkin)}" required></label>
      <label>Check-out<input name="checkout" type="date" value="${h(b.checkout)}" required></label>
      <label>Valor total (R$)<input name="valor" type="number" step="0.01" value="${h(b.valor)}"></label>
      <label>Status<select name="status">${['confirmada', 'bloqueio', 'cancelada'].map(s => opt(s, s[0].toUpperCase() + s.slice(1), b.status || 'confirmada')).join('')}</select></label>
    </div>
    <label>Notas<textarea name="notas" rows="2">${h(b.notas)}</textarea></label>`, {
    extra: b.id ? `<button type="button" class="btn danger" id="delBk">Excluir</button>` : '',
    onSubmit: async f => {
      if (f.checkout <= f.checkin) throw new Error('O check-out precisa ser depois do check-in.');
      const conflito = S.bookings.find(x => x.id !== b.id && x.property_id === f.property_id && x.status !== 'cancelada' && f.status !== 'cancelada' && x.checkin < f.checkout && x.checkout > f.checkin);
      if (conflito) throw new Error(`Conflito com a reserva de ${conflito.hospede || conflito.origem} (${conflito.checkin} a ${conflito.checkout}).`);
      await save('bookings', f, b.id);
      toast('Reserva salva');
    },
  });
  dlg().querySelector('#delBk')?.addEventListener('click', async ev => {
    if (!confirmInline(ev.target)) return;
    await del('bookings', b.id); closeModal(); toast('Reserva excluída');
  });
}

// ---------- Evento manual na agenda ----------
export function eventForm(e = {}, dia = today()) {
  modal(e.id ? 'Evento' : 'Novo evento', `
    <label>Título<input name="titulo" value="${h(e.titulo)}" required autofocus></label>
    <div class="grid2">
      <label>Calendário<select name="calendario">${[['dj', 'DJ'], ['alugueis', 'Aluguéis'], ['pessoal', 'Pessoal']].map(([v, l]) => opt(v, l, e.calendario || 'dj')).join('')}</select></label>
      <label>Data<input name="data" type="date" value="${h(e.inicio ? (e.dia_inteiro ? e.inicio.slice(0, 10) : localDate(e.inicio)) : dia)}" required></label>
      <label>Início<input name="hi" type="time" value="${e.inicio && !e.dia_inteiro ? hhmm(e.inicio) : ''}"></label>
      <label>Fim<input name="hf" type="time" value="${e.fim && !e.dia_inteiro ? hhmm(e.fim) : ''}"></label>
      <label class="span2">Local<input name="local" value="${h(e.local)}"></label>
    </div>
    <p class="muted small">Sem horário, o evento fica como dia inteiro.</p>`, {
    extra: e.id && e.origem === 'manual' ? `<button type="button" class="btn danger" id="delEv">Excluir</button>` : '',
    onSubmit: async f => {
      const allDay = !f.hi;
      const ts = (d, t) => new Date(`${d}T${t}:00-03:00`).toISOString();
      const row = { titulo: f.titulo, calendario: f.calendario, local: f.local, dia_inteiro: allDay, origem: e.origem || 'manual',
        inicio: allDay ? f.data + 'T12:00:00Z' : ts(f.data, f.hi), fim: allDay || !f.hf ? null : ts(f.data, f.hf) };
      await save('events', row, e.id);
      toast('Evento salvo');
    },
  });
  dlg().querySelector('#delEv')?.addEventListener('click', async ev => {
    if (!confirmInline(ev.target)) return;
    await del('events', e.id); closeModal(); toast('Evento excluído');
  });
}

// Confirmação em dois cliques, sem diálogo do navegador
export function confirmInline(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = 'Clique de novo para confirmar';
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 3000);
  return false;
}

// Abre o item certo a partir de um item unificado
export function openItem(it) {
  if (it.kind === 'tarefa') return taskForm(it.ref);
  if (it.kind === 'checkin' || it.kind === 'checkout') return bookingForm(it.ref);
  if (it.kind === 'evento') return eventForm(it.ref);
  return dealForm(it.ref);
}
