import { items } from './store.js';
import { h, today, addDays, dow, mesNome, fmtDate, relDate } from './util.js';
import { openItem, eventForm } from './ui.js';

let mes = today().slice(0, 7);
let cals = new Set(JSON.parse(safeGet('hub:cals') || '["dj","alugueis","pessoal"]'));
let sel = today();
// Semana em lista é o padrão no celular (no mês, os eventos viram só um ponto)
let modo = safeGet('hub:agenda-modo') || (matchMedia('(max-width: 760px)').matches ? 'semana' : 'mes');
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

const CALS = [['dj', 'DJ', 'dj'], ['alugueis', 'Aluguéis', 'alug'], ['pessoal', 'Pessoal', 'casa']];
const cv = a => ({ dj: 'dj', alugueis: 'alug', aluguel: 'alug', consultoria: 'eng', flores: 'flores' }[a] || 'casa');
const ICON = { gig: '♪', checkin: '↘', checkout: '↗', evento: '▪', acao: '●', tarefa: '○', etapa: '✓' };
const segunda = d => addDays(d, -((dow(d) + 6) % 7));
const cap = s => s[0].toUpperCase() + s.slice(1);
// "Hoje", "Amanhã", "Ontem" ou o dia da semana por extenso
const rotulo = d => cap(['hoje', 'amanhã', 'ontem'].includes(relDate(d)) ? relDate(d) : fmtDate(d, { long: true }).split(',')[0]);

function linha(i, bound) {
  return `<li class="row ${i.tentative ? 'tentative' : ''}" style="--c:var(--${cv(i.area)})"><span class="kind" aria-hidden="true">${ICON[i.kind] || '▪'}</span>
    <button class="row-main" data-open="${bound.push(i) - 1}"><span class="row-title">${i.time ? `<b class="time">${i.time}${i.end ? '–' + i.end : ''}</b>` : ''}${h(i.title)}</span>${i.sub ? `<span class="row-sub">${h(i.sub)}</span>` : ''}</button></li>`;
}

export function render(el) {
  const bound = [];
  const toggles = `
    <div class="seg" role="group" aria-label="Visão"><button data-modo="semana" class="${modo === 'semana' ? 'on' : ''}">Semana</button><button data-modo="mes" class="${modo === 'mes' ? 'on' : ''}">Mês</button></div>
    <div class="cal-toggles">${CALS.map(([k, l, c]) => `<label class="ctog" style="--c:var(--${c})"><input type="checkbox" data-cal="${k}" ${cals.has(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    <button class="btn primary" id="evNew">Novo evento</button>`;

  if (modo === 'semana') {
    // Semana: tudo que tem data (inclusive ações e tarefas), para ver a carga de cada dia
    const ini = segunda(sel), dias = Array.from({ length: 7 }, (_, i) => addDays(ini, i)), fim = dias[6];
    const map = {}; items({ from: ini, to: fim, cals: [...cals] }).forEach(i => (map[i.date] ||= []).push(i));
    const mesIni = ini.slice(5, 7) !== fim.slice(5, 7) ? ' ' + mesNome(+ini.slice(5, 7) - 1).slice(0, 3) : '';
    el.innerHTML = `
    <div class="view-head">
      <h1>${+ini.slice(8)}${mesIni} – ${+fim.slice(8)} ${mesNome(+fim.slice(5, 7) - 1)}</h1>
      <div class="seg"><button data-sem="-7" aria-label="Semana anterior">‹</button><button data-sem="0">Hoje</button><button data-sem="7" aria-label="Próxima semana">›</button></div>
      ${toggles}
    </div>
    <div class="week">
      ${dias.map(d => {
        const l = map[d] || [];
        const gig = l.some(i => i.kind === 'gig'), casa = l.some(i => i.kind === 'checkin' || i.kind === 'checkout');
        const cheio = (gig && casa) || l.length >= 6;
        return `<section class="wday ${d === today() ? 'today' : ''} ${d < today() ? 'past' : ''}">
          <h2><span>${rotulo(d)}</span><span class="muted">${fmtDate(d)}</span>${l.length ? `<span class="count">${l.length}</span>` : ''}
            ${cheio ? '<span class="load" title="Gig e movimento nas casas no mesmo dia, ou muitos compromissos">dia cheio</span>' : ''}
            <button class="mini" data-add="${d}" aria-label="Adicionar evento em ${fmtDate(d)}">+ evento</button></h2>
          ${l.length ? `<ul class="list">${l.map(i => linha(i, bound)).join('')}</ul>` : ''}
        </section>`;
      }).join('')}
    </div>
    <p class="muted small">● próxima ação · ○ tarefa · ✓ etapa de hospedagem · ♪ gig (em itálico: ainda não fechada)</p>`;
  } else {
    const [y, m] = mes.split('-').map(Number);
    const first = `${mes}-01`;
    const dias = Array.from({ length: 42 }, (_, i) => addDays(segunda(first), i));
    // o mês mostra eventos, gigs e check-ins/outs (não as próximas ações)
    const list = items({ from: dias[0], to: dias[41], cals: [...cals] }).filter(i => ['gig', 'evento', 'checkin', 'checkout'].includes(i.kind));
    const map = {}; list.forEach(i => (map[i.date] ||= []).push(i));
    const doDia = map[sel] || [];
    el.innerHTML = `
    <div class="view-head">
      <h1>${cap(mesNome(m - 1))} <span class="muted">${y}</span></h1>
      <div class="seg"><button data-nav="-1" aria-label="Mês anterior">‹</button><button data-nav="0">Hoje</button><button data-nav="1" aria-label="Próximo mês">›</button></div>
      ${toggles}
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
        <h2>${cap(relDate(sel))}<span class="muted"> ${fmtDate(sel, { long: true })}</span></h2>
        ${doDia.length ? `<ul class="list">${doDia.map(i => linha(i, bound)).join('')}</ul>` : '<p class="empty">Nada neste dia.</p>'}
        <button class="btn" id="evDay">Adicionar neste dia</button>
        <p class="muted small">Gigs com contorno tracejado ainda não estão fechadas.</p>
      </aside>
    </div>`;
  }

  el.querySelectorAll('[data-modo]').forEach(b => b.onclick = () => { modo = b.dataset.modo; safeSet('hub:agenda-modo', modo); mes = sel.slice(0, 7); render(el); });
  el.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => {
    const n = +b.dataset.nav;
    const [y, m] = mes.split('-').map(Number);
    if (!n) { mes = today().slice(0, 7); sel = today(); }
    else mes = new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
    render(el);
  });
  el.querySelectorAll('[data-sem]').forEach(b => b.onclick = () => {
    sel = +b.dataset.sem ? addDays(sel, +b.dataset.sem) : today();
    mes = sel.slice(0, 7);
    render(el);
  });
  el.querySelectorAll('[data-cal]').forEach(c => c.onchange = () => {
    c.checked ? cals.add(c.dataset.cal) : cals.delete(c.dataset.cal);
    safeSet('hub:cals', JSON.stringify([...cals])); render(el);
  });
  el.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { sel = b.dataset.day; render(el); });
  el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => eventForm({}, b.dataset.add));
  el.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openItem(bound[+b.dataset.open]));
  el.querySelector('#evNew').onclick = () => eventForm({}, sel);
  el.querySelector('#evDay')?.addEventListener('click', () => eventForm({}, sel));
}
