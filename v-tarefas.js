import { S, save } from './store.js';
import { h, today, addDays, relDate, areaTag, AREAS } from './util.js';
import { taskForm, toggleTask } from './ui.js';

let area = 'todas';
let feitas = false;

export function render(el) {
  const hoje = today();
  const ts = S.tasks.filter(t => area === 'todas' || t.area === area);
  const ab = ts.filter(t => !t.feito);
  const grupos = [
    ['Atrasadas', ab.filter(t => t.prazo && t.prazo < hoje), 'late'],
    ['Hoje', ab.filter(t => t.prazo === hoje)],
    ['Próximos 7 dias', ab.filter(t => t.prazo > hoje && t.prazo <= addDays(hoje, 7))],
    ['Mais adiante', ab.filter(t => t.prazo > addDays(hoje, 7))],
    ['Sem data', ab.filter(t => !t.prazo)],
  ];
  const done = ts.filter(t => t.feito).sort((a, b) => (b.feito_em || '').localeCompare(a.feito_em || '')).slice(0, 30);
  const li = t => `<li class="row ${t.feito ? 'is-done' : ''}" style="--c:${(AREAS[t.area] || AREAS.inbox).cor}">
    <button class="tick ${t.feito ? 'on' : ''}" data-t="${t.id}" aria-label="${t.feito ? 'Reabrir' : 'Concluir'}"></button>
    <button class="row-main" data-e="${t.id}"><span class="row-title">${h(t.titulo)}${t.prioridade === 1 ? ' <span class="prio">alta</span>' : ''}</span></button>
    <span class="row-meta">${area === 'todas' ? areaTag(t.area) : ''} ${t.prazo ? relDate(t.prazo) : ''}</span></li>`;

  el.innerHTML = `
  <div class="view-head">
    <h1>Tarefas</h1>
    <div class="seg">${[['todas', 'Todas'], ...Object.entries(AREAS).filter(([k]) => !['aluguel', 'pessoal'].includes(k)).map(([k, a]) => [k, a.nome])].map(([k, l]) => `<button class="${area === k ? 'on' : ''}" data-a="${k}">${l}</button>`).join('')}</div>
    <button class="btn primary" id="tNew">Nova tarefa</button>
  </div>
  ${grupos.filter(g => g[1].length).map(([n, l, cls]) => `<section class="block ${cls === 'late' ? 'warn' : ''}"><h2>${n} <span class="count">${l.length}</span></h2>
    <ul class="list">${l.sort((a, b) => (a.prazo || '').localeCompare(b.prazo || '') || a.prioridade - b.prioridade).map(li).join('')}</ul></section>`).join('') || '<p class="empty">Nenhuma tarefa aberta.</p>'}
  <section class="block"><button class="link-btn" id="tDone">${feitas ? 'Esconder' : 'Mostrar'} concluídas</button>
    ${feitas ? `<ul class="list">${done.map(li).join('')}</ul>` : ''}</section>`;

  el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { area = b.dataset.a; render(el); });
  el.querySelector('#tNew').onclick = () => taskForm({ area: area === 'todas' ? 'inbox' : area });
  el.querySelector('#tDone').onclick = () => { feitas = !feitas; render(el); };
  el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => toggleTask(S.tasks.find(t => t.id === b.dataset.t)));
  el.querySelectorAll('[data-e]').forEach(b => b.onclick = () => taskForm(S.tasks.find(t => t.id === b.dataset.e)));
}
