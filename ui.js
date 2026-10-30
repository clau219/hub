import { h, today, addDays, fluxo, AREAS, ABERTAS, etapa, hhmm, localDate, relDate, waLink, msgDeal, brl, fmtDate, FORMAS_PGTO, recebido, saldoDeal } from './util.js';
import { S, save, del, ensureContact, byId, contactName, contatoPorNome, prop } from './store.js';
import { checklistHtml, bindChecklist, lerChecklist, alternar, ETAPAS_HOSP } from './hospedagem.js';
import * as db from './db.js';
import { textoBoasVindas, lerBase as lerBaseCasas } from './boasvindas.js';

const dlg = () => document.getElementById('modal');
export const MOTIVOS_PERDA = ['Preço', 'Data já ocupada', 'Parou de responder', 'Escolheu outro', 'Evento cancelado', 'Fora do perfil', 'Outro'];

// ---------- WhatsApp a partir de uma oportunidade ----------
// Link com mensagem pronta para a etapa; null se o contato não tem telefone
export function dealWa(d) {
  const c = byId('contacts', d.contato_id);
  return c?.telefone ? waLink(c.telefone, msgDeal(d, c.nome)) : null;
}
// Ao voltar para o Hub depois de abrir o WhatsApp, pergunta o próximo passo
let aguardando = null;
export function aposWhats(d) { aguardando = d.id; }
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !aguardando) return;
  const d = S.deals.find(x => x.id === aguardando);
  aguardando = null;
  if (d && ABERTAS.includes(d.etapa) && !dlg().open) setTimeout(() => dealDone(d, { titulo: 'Mensagem enviada? E agora?' }), 300);
});
const datasRapidas = () => `<div class="quick-dates">${[['Hoje', 0], ['Amanhã', 1], ['+3d', 3], ['+1 sem', 7]].map(([l, n]) => `<button type="button" class="chip" data-add="${n}">${l}</button>`).join('')}</div>`;
const ligarDatas = m => m.querySelectorAll('[data-add]').forEach(b => b.onclick = () => (m.querySelector('[name=data_proxima_acao]').value = addDays(today(), +b.dataset.add)));

window.addEventListener('hub:aviso', e => toast(e.detail, 6000));
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
  const enviar = async () => {
    const data = Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[type=checkbox]').forEach(c => (data[c.name] = c.checked));
    try { await onSubmit(data); d.close(); }
    catch (e) { console.error(e); d.querySelector('#modalErr').textContent = e.message || 'Não foi possível salvar.'; }
  };
  form.onsubmit = ev => {
    if (ev.submitter?.value !== 'ok') return;
    ev.preventDefault();
    enviar();
  };
  // Enter num campo salva. Sem isto o navegador envia pelo primeiro botão do form, o × do topo, e a janela fecha sem salvar.
  // Campo com sugestões (datalist) não salva: o Enter ali é para escolher a sugestão.
  form.onkeydown = ev => {
    if (ev.key !== 'Enter' || ev.defaultPrevented || ev.isComposing || !ev.target.matches('input, select')) return;
    ev.preventDefault();
    if (!onSubmit || ev.target.hasAttribute('list')) return;
    if (form.reportValidity()) enviar();
  };
  d.showModal();
  setTimeout(() => d.querySelector('#modalBody [autofocus], #modalBody input, #modalBody select')?.focus(), 30);
  return d;
}
export const closeModal = () => dlg().close();

const opt = (v, label, sel) => `<option value="${h(v)}" ${v === sel ? 'selected' : ''}>${h(label)}</option>`;
// Etapas do negócio; mantém a atual mesmo que o negócio não a tenha (dado antigo)
const etapaOpts = (negocio, sel) => {
  const l = fluxo(negocio);
  if (sel && !l.some(x => x.id === sel)) l.unshift(etapa(sel));
  return l.map(x => opt(x.id, x.nome, sel)).join('');
};
const contactsList = () => `<datalist id="dlContatos">${S.contacts.map(c => `<option value="${h(c.nome)}">`).join('')}</datalist>`;

// ---------- Oportunidade (deal) ----------
export function dealForm(d = {}, preset = {}) {
  d = { negocio: 'dj', etapa: 'lead', ...preset, ...d };
  const e = etapa(d.etapa, d.negocio);
  const prox = d.proxima_acao ?? e.sug ?? '';
  const proxData = d.data_proxima_acao ?? (e.dias ? addDays(today(), e.dias) : '');
  const quotes = d.id ? S.quotes.filter(q => q.deal_id === d.id) : [];
  modal(d.id ? 'Oportunidade' : 'Nova oportunidade', `
    ${contactsList()}
    <div class="grid2">
      <label class="span2">Cliente / contratante<input name="contato" list="dlContatos" value="${h(contactName(d.contato_id) || d._contato)}" required autofocus></label>
      <label>Telefone / WhatsApp<input name="telefone" type="tel" inputmode="tel" value="${h(byId('contacts', d.contato_id)?.telefone)}" placeholder="(84) 99999-0000"></label>
      <label>Negócio<select name="negocio">${['dj', 'consultoria', 'argila', 'aluguel'].map(n => opt(n, AREAS[n].nome, d.negocio)).join('')}</select></label>
      <label>Etapa<select name="etapa" id="fEtapa">${etapaOpts(d.negocio, d.etapa)}</select></label>
      <label>Valor (R$)<input name="valor" type="number" step="0.01" value="${h(d.valor)}"></label>
      <label>Data do evento<input name="data_evento" type="date" value="${h(d.data_evento)}"></label>
      <label>Início<input name="hora_inicio" type="time" value="${h(d.hora_inicio?.slice(0, 5))}"></label>
      <label>Fim<input name="hora_fim" type="time" value="${h(d.hora_fim?.slice(0, 5))}"></label>
      <label class="span2">Local<input name="local" value="${h(d.local)}"></label>
    </div>
    <fieldset class="pgto" id="fPgto">
      <legend>Pagamentos</legend>
      <div id="pgResumo"></div>
      <ul id="pgLista" class="pg-lista"></ul>
      <div class="pg-add">
        <input id="pgData" type="date" value="${today()}" aria-label="Data do pagamento">
        <input id="pgValor" type="number" step="0.01" min="0" placeholder="Valor recebido" aria-label="Valor recebido">
        <select id="pgForma" aria-label="Forma de pagamento">${FORMAS_PGTO.map(x => opt(x, x, 'Pix')).join('')}</select>
        <button type="button" class="btn" id="pgAdd">Registrar</button>
      </div>
      <div class="quick-dates"><button type="button" class="chip" data-pct="30">Sinal 30%</button><button type="button" class="chip" data-pct="50">Sinal 50%</button><button type="button" class="chip" data-pct="saldo">Saldo</button></div>
    </fieldset>
    <fieldset class="next" id="fNext">
      <legend>Próxima ação</legend>
      <div class="grid2">
        <label class="span2 lbl-hide">O que fazer<input name="proxima_acao" value="${h(prox)}" placeholder="ex.: Enviar orçamento por WhatsApp"></label>
        <label>Quando<input name="data_proxima_acao" type="date" value="${h(proxData)}"></label>
        ${datasRapidas()}
      </div>
    </fieldset>
    <label id="fPerda">Motivo da perda<select name="motivo_perda">${['', ...MOTIVOS_PERDA].map(m => opt(m, m || 'Escolha…', '')).join('')}</select></label>
    <label>Notas<textarea name="notas" rows="2">${h(d.notas)}</textarea></label>
    <div id="waConv"></div>
    ${quotes.length ? `<div class="quotes"><b>Orçamentos</b>${quotes.map(q => `<div>${h(q.arquivo || q.versao || 'Orçamento')}${q.valor_total ? ': R$ ' + Number(q.valor_total).toLocaleString('pt-BR') : ''}${q.horas ? `, ${q.horas}h` : ''}</div>`).join('')}</div>` : ''}
  `, {
    extra: d.id ? `${dealWa(d) ? `<a class="btn wa" id="waDeal" href="${h(dealWa(d))}" target="_blank" rel="noopener">WhatsApp</a>` : ''}<button type="button" class="btn danger" id="delDeal">Excluir</button>` : '',
    onSubmit: async f => {
      // Valor digitado e não registrado conta como pagamento: é o que se esquece de clicar
      if (+m.querySelector('#pgValor').value > 0) addPg();
      const total = { valor: f.valor, pagamentos: pgs };
      const quitou = +f.valor > 0 && saldoDeal(total) === 0;
      if (f.etapa === 'pago' && +f.valor > 0 && !quitou) {
        pgs.push({ data: today(), valor: saldoDeal(total), forma: pgs.at(-1)?.forma || 'Pix' });
        toast(`Saldo de ${brl(saldoDeal(total))} registrado hoje`);
      } else if (f.etapa === 'realizado' && quitou) f.etapa = 'pago';
      const aberta = ABERTAS.includes(f.etapa);
      if (aberta && (!f.proxima_acao?.trim() || !f.data_proxima_acao))
        throw new Error('Defina a próxima ação e a data. Nada fica aberto sem um próximo passo.');
      if (f.telefone?.trim() && !waLink(f.telefone)) throw new Error('Telefone incompleto: use DDD + número.');
      // O motivo da perda vai para as notas: com o tempo mostra por que se perde negócio
      if (f.etapa === 'perdido' && d.etapa !== 'perdido') {
        if (!f.motivo_perda) throw new Error('Diga o motivo da perda. Em alguns meses isso mostra o que ajustar.');
        f.notas = `[Perdido: ${f.motivo_perda}]${f.notas ? ' ' + f.notas : ''}`;
      }
      const contato_id = await ensureContact(f.contato, f.negocio === 'dj' ? 'contratante' : 'cliente', f.telefone);
      const titulo = d.titulo || `${AREAS[f.negocio].nome} — ${f.contato}`;
      const row = { titulo, negocio: f.negocio, etapa: f.etapa, contato_id, valor: f.valor, data_evento: f.data_evento,
        hora_inicio: f.hora_inicio, hora_fim: f.hora_fim, local: f.local, notas: f.notas, pagamentos: pgs,
        proxima_acao: aberta ? f.proxima_acao.trim() : null, data_proxima_acao: aberta ? f.data_proxima_acao : null };
      await save('deals', row, d.id);
      toast(d.id ? 'Oportunidade salva' : 'Oportunidade criada');
    },
  });
  const m = dlg();
  // Pagamentos: lista editada aqui e gravada só no Salvar
  const pgs = (d.pagamentos || []).map(p => ({ ...p }));
  const valorEl = m.querySelector('[name=valor]'), pgValor = m.querySelector('#pgValor');
  const desenharPg = () => {
    const total = { valor: valorEl.value, pagamentos: pgs }, rec = recebido(total), falta = saldoDeal(total), v = +valorEl.value || 0;
    const pct = v ? Math.min(100, Math.round(rec / v * 100)) : 0;
    m.querySelector('#pgResumo').innerHTML = !v && !rec ? '<p class="muted pg-dica">Preencha o valor para acompanhar sinal e saldo.</p>'
      : `<div class="pg-resumo"><span>Recebido <b>${brl(rec)}</b>${v ? ` de ${brl(v)} (${pct}%)` : ''}</span>${v ? (falta ? `<span class="pg-falta">Falta <b>${brl(falta)}</b></span>` : '<span class="pg-ok">Quitado</span>') : ''}</div>
        ${v ? `<div class="pg-barra"><i style="width:${pct}%"></i></div>` : ''}`;
    m.querySelector('#pgLista').innerHTML = pgs.map((p, i) => `<li><span>${fmtDate(p.data)}</span><span>${h(p.forma || '')}</span><b>${brl(p.valor)}</b><button type="button" class="pg-del" data-i="${i}" aria-label="Remover pagamento">×</button></li>`).join('');
  };
  const addPg = () => {
    const valor = Math.round(+pgValor.value * 100) / 100;
    if (!(valor > 0)) return pgValor.focus();
    pgs.push({ data: m.querySelector('#pgData').value || today(), valor, forma: m.querySelector('#pgForma').value });
    pgs.sort((a, b) => a.data.localeCompare(b.data));
    pgValor.value = '';
    desenharPg();
  };
  m.querySelector('#pgAdd').onclick = addPg;
  // Enter no valor registra o pagamento em vez de salvar a oportunidade
  pgValor.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); addPg(); } });
  m.querySelector('#pgLista').onclick = ev => { const b = ev.target.closest('.pg-del'); if (b) { pgs.splice(+b.dataset.i, 1); desenharPg(); } };
  m.querySelectorAll('[data-pct]').forEach(b => b.onclick = () => {
    const v = +valorEl.value || 0;
    if (!v) { toast('Preencha o valor total primeiro'); return valorEl.focus(); }
    const total = { valor: v, pagamentos: pgs };
    pgValor.value = b.dataset.pct === 'saldo' ? saldoDeal(total) : Math.round(v * b.dataset.pct) / 100;
    pgValor.focus();
  });
  valorEl.addEventListener('input', desenharPg);
  desenharPg();
  const sync = () => {
    const et = m.querySelector('#fEtapa').value;
    m.querySelector('#fNext').hidden = !ABERTAS.includes(et);
    m.querySelector('#fPerda').hidden = et !== 'perdido' || d.etapa === 'perdido';
    // Pagamento entra em cena a partir da negociação (sinal); antes só aparece se já houver algum
    m.querySelector('#fPgto').hidden = !pgs.length && !['negociacao', 'fechado', 'realizado', 'pago'].includes(et);
  };
  const neg = () => m.querySelector('[name=negocio]').value;
  // Trocar o negócio troca a lista de etapas; a etapa atual fica se existir no novo negócio
  m.querySelector('[name=negocio]').onchange = () => {
    const sel = m.querySelector('#fEtapa');
    const antes = sel.value;
    const atual = fluxo(neg()).some(x => x.id === antes) ? antes : 'lead';
    sel.innerHTML = etapaOpts(neg(), atual);
    sel.value = atual;
    // Nova oportunidade: a sugestão de próxima ação acompanha o negócio; existente só muda se a etapa mudou
    if (!d.id || atual !== antes) sel.dispatchEvent(new Event('change'));
  };
  m.querySelector('#fEtapa').onchange = ev => {
    const e2 = etapa(ev.target.value, neg());
    if (e2.sug) {
      m.querySelector('[name=proxima_acao]').value = e2.sug;
      m.querySelector('[name=data_proxima_acao]').value = addDays(today(), e2.dias);
    }
    sync();
  };
  ligarDatas(m);
  // Contato já cadastrado: traz o telefone dele
  m.querySelector('[name=contato]').addEventListener('change', ev => {
    const tel = m.querySelector('[name=telefone]');
    const c = contatoPorNome(ev.target.value);
    if (c?.telefone && !tel.value) tel.value = c.telefone;
  });
  m.querySelector('#waDeal')?.addEventListener('click', () => { aposWhats(d); closeModal(); });
  m.querySelector('#delDeal')?.addEventListener('click', async () => {
    if (!confirmInline(m.querySelector('#delDeal'))) return;
    await del('deals', d.id); closeModal(); toast('Oportunidade excluída');
  });
  sync();
  if (d.id) conversaWa(m.querySelector('#waConv'), d.id);
}

// Conversa do WhatsApp das casas ligada à oportunidade (wa-webhook), com pausa do robô só para esta pessoa
async function conversaWa(el, dealId) {
  if (db.mode !== 'supabase' || !el) return;
  const sb = db.client();
  const [{ data: msgs }, { data: wc }] = await Promise.all([
    sb.from('wa_messages').select('autor,texto,enviado_em').eq('deal_id', dealId).order('enviado_em').limit(60),
    sb.from('wa_contacts').select('wa_id,bot_pausado').eq('deal_id', dealId).maybeSingle(),
  ]);
  if (!msgs?.length) return;
  const quem = { cliente: 'Cliente', robo: 'Robô', claudio: 'Você' };
  el.innerHTML = `<div class="wa-conv"><div class="wa-head"><b>Conversa no WhatsApp</b>${wc ? `<label class="wa-pausa"><input type="checkbox" ${wc.bot_pausado ? 'checked' : ''}> Robô pausado com esta pessoa</label>` : ''}</div>
    <ol>${msgs.map(x => `<li class="wa-${x.autor}"><small>${quem[x.autor] || x.autor} · ${h(localDate(x.enviado_em).split('-').reverse().slice(0, 2).join('/'))} ${hhmm(x.enviado_em)}</small>${h(x.texto || '')}</li>`).join('')}</ol></div>`;
  const ol = el.querySelector('ol'); ol.scrollTop = ol.scrollHeight;
  el.querySelector('.wa-pausa input')?.addEventListener('change', async ev => {
    const { error } = await sb.from('wa_contacts').update({ bot_pausado: ev.target.checked }).eq('wa_id', wc.wa_id);
    toast(error ? 'Não foi possível salvar' : ev.target.checked ? 'Robô pausado para esta pessoa' : 'Robô ativo para esta pessoa');
  });
}

// Concluir a ação de um deal: pede a próxima (ou encerra)
export function dealDone(d, { titulo = 'Ação feita. E agora?' } = {}) {
  modal(titulo, `
    <p class="muted">${h(d.titulo)}: “${h(d.proxima_acao)}”</p>
    <div class="grid2">
      <label>Etapa<select name="etapa" id="fEtapa">${etapaOpts(d.negocio, d.etapa)}</select></label>
      <label>Quando<input name="data_proxima_acao" type="date" value="${addDays(today(), 3)}"></label>
      ${datasRapidas()}
      <label class="span2" id="fNextLbl">Próxima ação<input name="proxima_acao" value="" placeholder="ex.: Cobrar resposta" autofocus></label>
      <label class="span2" id="fPerda" hidden>Motivo da perda<select name="motivo_perda">${['', ...MOTIVOS_PERDA].map(m => opt(m, m || 'Escolha…', '')).join('')}</select></label>
    </div>`, {
    submit: 'Salvar próximo passo',
    onSubmit: async f => {
      const aberta = ABERTAS.includes(f.etapa);
      if (aberta && (!f.proxima_acao.trim() || !f.data_proxima_acao)) throw new Error('Defina a próxima ação e a data.');
      const row = { etapa: f.etapa, proxima_acao: aberta ? f.proxima_acao : null, data_proxima_acao: aberta ? f.data_proxima_acao : null };
      if (f.etapa === 'perdido') {
        if (!f.motivo_perda) throw new Error('Diga o motivo da perda.');
        row.notas = `[Perdido: ${f.motivo_perda}]${d.notas ? ' ' + d.notas : ''}`;
      }
      await save('deals', row, d.id);
      if (d.contato_id) await save('contacts', { ultima_interacao: today() }, d.contato_id);
      toast('Próximo passo salvo');
    },
  });
  const m = dlg();
  ligarDatas(m);
  m.querySelector('#fEtapa').onchange = ev => {
    const e2 = etapa(ev.target.value, d.negocio);
    m.querySelector('#fNextLbl').hidden = !e2.sug;
    m.querySelector('#fPerda').hidden = ev.target.value !== 'perdido';
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
      <label>Aviso no WhatsApp<input name="aviso" type="time" value="${t.lembrete_em ? hhmm(t.lembrete_em) : ''}"></label>
    </div>
    <label>Notas<textarea name="notas" rows="2">${h(t.notas)}</textarea></label>`, {
    extra: t.id ? `<button type="button" class="btn" id="toDeal">Virar oportunidade</button><button type="button" class="btn danger" id="delTask">Excluir</button>` : '',
    onSubmit: async f => {
      // Aviso no WhatsApp (canal do dono): no dia do prazo, na hora escolhida, horário de Pipa
      const { aviso, ...row } = f;
      if (aviso && !row.prazo) throw new Error('Escolha o prazo: o aviso sai nesse dia, na hora marcada.');
      const lembrete_em = aviso ? new Date(`${row.prazo}T${aviso}:00-03:00`).toISOString() : null;
      const mudou = lembrete_em !== (t.lembrete_em ? new Date(t.lembrete_em).toISOString() : null);
      await save('tasks', { ...row, prioridade: +row.prioridade, ...(mudou ? { lembrete_em, lembrete_enviado_em: null } : {}) }, t.id);
      toast(mudou && lembrete_em ? `Tarefa salva · aviso ${relDate(row.prazo)} às ${aviso}` : 'Tarefa salva');
    },
  });
  const m = dlg();
  m.querySelector('#delTask')?.addEventListener('click', async () => {
    if (!confirmInline(m.querySelector('#delTask'))) return;
    await del('tasks', t.id); closeModal(); toast('Tarefa excluída');
  });
  m.querySelector('#toDeal')?.addEventListener('click', async () => {
    closeModal();
    await del('tasks', t.id);
    dealForm({}, { negocio: ['dj', 'consultoria', 'argila'].includes(t.area) ? t.area : 'dj', notas: t.titulo });
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
    ${checklistHtml(b)}
    <label>Notas<textarea name="notas" rows="2">${h(b.notas)}</textarea></label>`, {
    extra: b.id ? `${b.status === 'confirmada' ? '<button type="button" class="btn" id="bvBk" title="Mensagem com localização, cofre, Wi-Fi e regras, para colar no chat do Airbnb ou no WhatsApp">Copiar boas-vindas</button>' : ''}<button type="button" class="btn danger" id="delBk">Excluir</button>` : '',
    onSubmit: async f => {
      Object.assign(f, lerChecklist(f, b));
      if (f.checkout <= f.checkin) throw new Error('O check-out precisa ser depois do check-in.');
      const conflito = S.bookings.find(x => x.id !== b.id && x.property_id === f.property_id && x.status !== 'cancelada' && f.status !== 'cancelada' && x.checkin < f.checkout && x.checkout > f.checkin);
      if (conflito) throw new Error(`Conflito com a reserva de ${conflito.hospede || conflito.origem} (${conflito.checkin} a ${conflito.checkout}).`);
      await save('bookings', f, b.id);
      toast('Reserva salva');
    },
  });
  bindChecklist(dlg(), () => prop(dlg().querySelector('[name=property_id]').value), b);
  // Boas-vindas da reserva salva (casa, datas e nome; "Hóspede Airbnb" fica sem nome) para colar no chat
  dlg().querySelector('#bvBk')?.addEventListener('click', async () => {
    try {
      const r = textoBoasVindas({ base: await lerBaseCasas(), casa: b.property_id, nomeCasa: prop(b.property_id)?.nome, checkin: b.checkin, checkout: b.checkout, nome: b.hospede });
      if (r.falta) return toast(`Preencha “${r.falta}” em WhatsApp → Informações das casas`, 5000);
      await navigator.clipboard.writeText(r.texto);
      toast('Boas-vindas copiada: cole no chat do hóspede');
    } catch (e) { toast('Não foi possível copiar: ' + (e.message || e), 5000); }
  });
  dlg().querySelector('#delBk')?.addEventListener('click', async ev => {
    if (!confirmInline(ev.target)) return;
    await del('bookings', b.id); closeModal(); toast('Reserva excluída');
  });
}

// Marca uma etapa da hospedagem como feita (a partir da tela Hoje)
export async function etapaDone(b, id) {
  await save('bookings', { etapas: alternar(b, id, true) }, b.id);
  toast(`${ETAPAS_HOSP.find(e => e.id === id).nome}: feito`);
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
  if (it.kind === 'checkin' || it.kind === 'checkout' || it.kind === 'etapa') return bookingForm(it.ref);
  if (it.kind === 'evento') return eventForm(it.ref);
  if (it.kind === 'conflito' && it.ref.property_id) return bookingForm(it.ref); // reserva dupla
  return dealForm(it.ref);
}
