import { S, contactName, save } from './store.js';
import { h, ETAPAS, ABERTAS, AREAS, etapa, brl, relDate, today, fmtDate, addDays } from './util.js';
import { dealForm, modal, toast } from './ui.js';

let filtro = 'todos';
let mostrarFechados = false;

function card(d) {
  const late = d.data_proxima_acao && d.data_proxima_acao < today();
  const isToday = d.data_proxima_acao === today();
  return `<article class="card" draggable="true" data-id="${d.id}" tabindex="0" style="--c:${AREAS[d.negocio]?.cor}">
    <header><b>${h(contactName(d.contato_id) || d.titulo)}</b>${d.valor ? `<span>${brl(d.valor)}</span>` : ''}</header>
    ${d.data_evento || d.local ? `<p class="card-ev">${d.data_evento ? fmtDate(d.data_evento) : ''}${d.data_evento && d.local ? ', ' : ''}${h((d.local || '').split(',')[0])}</p>` : ''}
    ${d.proxima_acao ? `<p class="card-next ${late ? 'late' : isToday ? 'today' : ''}"><span>${relDate(d.data_proxima_acao)}</span> ${h(d.proxima_acao)}</p>` : ''}
    ${filtro === 'todos' ? `<span class="tag" style="--c:${AREAS[d.negocio]?.cor}">${AREAS[d.negocio]?.nome}</span>` : ''}
  </article>`;
}

export function render(el) {
  const deals = S.deals.filter(d => filtro === 'todos' || d.negocio === filtro);
  const cols = ETAPAS.filter(e => ABERTAS.includes(e.id));
  const fechados = deals.filter(d => !ABERTAS.includes(d.etapa)).sort((a, b) => (b.data_evento || '').localeCompare(a.data_evento || ''));
  el.innerHTML = `
  <div class="view-head">
    <h1>Pipeline</h1>
    <div class="seg" role="group" aria-label="Filtrar negócio">
      ${[['todos', 'Todos'], ['dj', 'DJ'], ['consultoria', 'Engenharia'], ['flores', 'Flores do Sol'], ['aluguel', 'Aluguéis']].map(([k, l]) => `<button class="${filtro === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
    </div>
    <button class="btn primary" id="pNew">Nova oportunidade</button>
  </div>
  <p class="muted small">Arraste os cartões entre colunas. Toda oportunidade aberta tem uma próxima ação com data.</p>
  <div class="board">
    ${cols.map(c => {
      const l = deals.filter(d => d.etapa === c.id).sort((a, b) => (a.data_proxima_acao || '').localeCompare(b.data_proxima_acao || ''));
      const tot = l.reduce((s, d) => s + (+d.valor || 0), 0);
      return `<section class="col" data-etapa="${c.id}">
        <h2>${c.nome} <span class="count">${l.length}</span>${tot ? `<small>${brl(tot)}</small>` : ''}</h2>
        <div class="drop">${l.map(card).join('') || '<p class="empty">Vazio</p>'}</div>
      </section>`;
    }).join('')}
  </div>
  <section class="block">
    <button class="link-btn" id="toggleClosed">${mostrarFechados ? 'Esconder' : 'Mostrar'} pagos e perdidos (${fechados.length})</button>
    ${mostrarFechados ? `<table class="table"><thead><tr><th>Cliente</th><th>Evento</th><th>Local</th><th>Valor</th><th>Etapa</th></tr></thead><tbody>
      ${fechados.map(d => `<tr data-id="${d.id}" tabindex="0"><td>${h(contactName(d.contato_id) || d.titulo)}</td><td>${d.data_evento ? fmtDate(d.data_evento, { year: true }) : ''}</td><td>${h((d.local || '').split(',')[0])}</td><td class="num">${brl(d.valor)}</td><td>${etapa(d.etapa).nome}</td></tr>`).join('')}
    </tbody></table>` : ''}
  </section>`;

  el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filtro = b.dataset.f; render(el); });
  el.querySelector('#pNew').onclick = () => dealForm({}, filtro !== 'todos' ? { negocio: filtro } : {});
  el.querySelector('#toggleClosed').onclick = () => { mostrarFechados = !mostrarFechados; render(el); };
  const open = id => dealForm(S.deals.find(d => d.id === id));
  el.querySelectorAll('.card, tr[data-id]').forEach(c => {
    c.onclick = () => open(c.dataset.id);
    c.onkeydown = e => { if (e.key === 'Enter') open(c.dataset.id); };
  });

  // Arrastar e soltar
  el.querySelectorAll('.card').forEach(c => c.ondragstart = e => { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); });
  el.querySelectorAll('.col').forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = e => {
      e.preventDefault(); col.classList.remove('over');
      const d = S.deals.find(x => x.id === e.dataTransfer.getData('text/plain'));
      if (d && d.etapa !== col.dataset.etapa) mover(d, col.dataset.etapa);
    };
  });
}

// Ao mudar de etapa, pede a nova próxima ação (com sugestão)
function mover(d, para) {
  const e = etapa(para);
  let data = addDays(today(), e.dias);
  if (para === 'fechado' && d.data_evento) data = addDays(d.data_evento, -3) > today() ? addDays(d.data_evento, -3) : today();
  modal(`Mover para ${e.nome}`, `
    <p class="muted">${h(contactName(d.contato_id) || d.titulo)}</p>
    <div class="grid2">
      <label class="span2">Próxima ação<input name="proxima_acao" value="${h(e.sug)}" required autofocus></label>
      <label>Quando<input name="data_proxima_acao" type="date" value="${data}" required></label>
    </div>`, {
    submit: 'Mover',
    onSubmit: async f => {
      await save('deals', { etapa: para, ...f }, d.id);
      toast(`Movido para ${e.nome}`);
    },
  });
}
