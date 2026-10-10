import { items } from './store.js';
import { h, today, addDays, dow, mesNome, fmtDate, relDate } from './util.js';
import { openItem, eventForm } from './ui.js';

let mes = today().slice(0, 7);
let cals = new Set(JSON.parse(safeGet('hub:cals') || '["dj","alugueis","pessoal"]'));
let sel = today();
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

const CALS = [['dj', 'DJ', 'dj'], ['alugueis', 'Aluguéis', 'alug'], ['pessoal', 'Pessoal', 'casa']];
const cv = a => ({ dj: 'dj', alugueis: 'alug' }[a] || 'casa');

export function render(el) {
  const [y, m] = mes.split('-').map(Number);
  const first = `${mes}-01`;
  const start = addDays(first, -((dow(first) + 6) % 7)); // semana começa na segunda
  const dias = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  // agenda mostra eventos, gigs e check-ins/outs (não as próximas ações)
  const list = items({ from: dias[0], to: dias[41], cals: [...cals] }).filter(i => ['gig', 'evento', 'checkin', 'checkout'].includes(i.kind));
  const map = {}; list.forEach(i => (map[i.date] ||= []).push(i));
  const doDia = map[sel] || [];
  let bound = [];

  el.innerHTML = `
  <div class="view-head">
    <h1>${mesNome(m - 1)[0].toUpperCase() + mesNome(m - 1).slice(1)} <span class="muted">${y}</span></h1>
    <div class="seg"><button data-nav="-1" aria-label="Mês anterior">‹</button><button data-nav="0">Hoje</button><button data-nav="1" aria-label="Próximo mês">›</button></div>
    <div class="cal-toggles">${CALS.map(([k, l, c]) => `<label class="ctog" style="--c:var(--${c})"><input type="checkbox" data-cal="${k}" ${cals.has(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    <button class="btn primary" id="evNew">Novo evento</button>
  </div>
  <div class="agenda">
    <div class="month">
      ${['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'].map(d => `<div class="mh">${d}</div>`).join('')}
      ${dias.map(d => {
        const l = map[d] || [];
        return `<button class="md ${d.slice(0, 7) !== mes ? 'out' : ''} ${d === today() ? 'today' : ''} ${d === sel ? 'sel' : ''}" data-day="${d}">
          <span class="dn">${+d.slice(8)}</span>
          ${l.slice(0, 3).map(i => `<span class="pill ${i.tentative ? 'tentative' : ''}" style="--c:var(--${cv(i.area)})">${i.time ? i.time + ' ' : ''}${h(i.kind === 'checkin' ? '↘ ' + i.title.replace('Check-in ', '') : i.kind === 'checkout' ? '↗ ' + i.title.replace('Check-out ', '') : i.title)}</span>`).join('')}
          ${l.length > 3 ? `<span class="more">+${l.length - 3}</span>` : ''}
        </button>`;
      }).join('')}
    </div>
    <aside class="day-panel">
      <h2>${relDate(sel)[0].toUpperCase() + relDate(sel).slice(1)}<span class="muted"> ${fmtDate(sel, { long: true })}</span></h2>
      ${doDia.length ? `<ul class="list">${doDia.map(i => `<li class="row ${i.tentative ? 'tentative' : ''}" style="--c:var(--${cv(i.area)})"><span class="kind">${{ gig: '♪', checkin: '↘', checkout: '↗', evento: '▪' }[i.kind]}</span>
        <button class="row-main" data-open="${bound.push(i) - 1}"><span class="row-title">${i.time ? `<b class="time">${i.time}${i.end ? '–' + i.end : ''}</b>` : ''}${h(i.title)}</span>${i.sub ? `<span class="row-sub">${h(i.sub)}</span>` : ''}</button></li>`).join('')}</ul>`
        : '<p class="empty">Nada neste dia.</p>'}
      <button class="btn" id="evDay">Adicionar neste dia</button>
      <p class="muted small">Gigs com contorno tracejado ainda não estão fechadas.</p>
    </aside>
  </div>`;

  el.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => {
    const n = +b.dataset.nav;
    if (!n) { mes = today().slice(0, 7); sel = today(); }
    else { const d = new Date(Date.UTC(y, m - 1 + n, 1)); mes = d.toISOString().slice(0, 7); }
    render(el);
  });
  el.querySelectorAll('[data-cal]').forEach(c => c.onchange = () => {
    c.checked ? cals.add(c.dataset.cal) : cals.delete(c.dataset.cal);
    safeSet('hub:cals', JSON.stringify([...cals])); render(el);
  });
  el.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { sel = b.dataset.day; render(el); });
  el.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openItem(bound[+b.dataset.open]));
  el.querySelector('#evNew').onclick = () => eventForm({}, sel);
  el.querySelector('#evDay').onclick = () => eventForm({}, sel);
}
