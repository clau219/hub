import { S, items, atencao, prop, ocupacao, save } from './store.js';
import { h, today, addDays, fmtDate, relDate, weekdayShort, areaTag, brl, hhmm } from './util.js';
import { openItem, dealDone, snooze, toggleTask, taskForm, dealForm, toast, etapaDone, dealWa, aposWhats } from './ui.js';
import { CONFIG } from './config.js';
import * as habitos from './habitos.js';

let bound = [];

function row(it, { late } = {}) {
  const idx = bound.push(it) - 1;
  const done = it.kind === 'tarefa' || it.kind === 'acao' || it.kind === 'etapa';
  const canSnooze = it.kind === 'tarefa' || it.kind === 'acao';
  const icon = { acao: '●', tarefa: '○', gig: '♪', checkin: '↘', checkout: '↗', evento: '▪' }[it.kind];
  const wa = it.kind === 'acao' ? dealWa(it.ref) : null;
  const dica = it.kind === 'acao' ? 'Feito, definir próximo passo' : it.kind === 'etapa' ? 'Marcar etapa como feita' : 'Concluir';
  return `<li class="row ${late ? 'late' : ''} ${it.tentative ? 'tentative' : ''} ${done ? 'swipe' : ''}" style="--c:var(--${areaVar(it.area)})">
    ${done ? `<button class="tick" data-done="${idx}" title="${dica}" aria-label="${h(dica + ': ' + it.title)}"></button>` : `<span class="kind" aria-hidden="true">${icon}</span>`}
    <button class="row-main" data-open="${idx}">
      <span class="row-title">${it.time ? `<b class="time">${h(it.time)}</b>` : ''}${h(it.title)}${it.prio === 1 ? ' <span class="prio">alta</span>' : ''}</span>
      ${it.sub ? `<span class="row-sub">${h(it.sub)}</span>` : ''}
    </button>
    <span class="row-meta">${late ? `<span class="late-lbl">${it.motivo === 'atrasada' ? relDate(it.date) : it.motivo}</span>` : ''}${it.kind === 'gig' && it.ref.valor ? brl(it.ref.valor) : ''}</span>
    ${canSnooze || wa ? `<span class="row-act">${wa ? `<a class="mini wa" href="${h(wa)}" target="_blank" rel="noopener" data-wa="${idx}" aria-label="WhatsApp: ${h(it.sub || it.title)}">WhatsApp</a>` : ''}${canSnooze ? `<button class="mini" data-snz="${idx}:1" aria-label="Adiar para amanhã: ${h(it.title)}">amanhã</button><button class="mini" data-snz="${idx}:3" aria-label="Adiar 3 dias: ${h(it.title)}">+3d</button>` : ''}</span>` : ''}
  </li>`;
}
const areaVar = a => ({ dj: 'dj', alugueis: 'alug', aluguel: 'alug', consultoria: 'eng', flores: 'flores' }[a] || 'casa');

function ribbon(list) {
  const H0 = 7, H1 = 25;
  const pos = t => { const [hh, mm] = t.split(':').map(Number); const v = (hh < H0 ? hh + 24 : hh) + mm / 60; return ((Math.min(Math.max(v, H0), H1) - H0) / (H1 - H0)) * 100; };
  const timed = list.filter(i => i.time);
  const now = hhmm(new Date().toISOString());
  const hours = [];
  for (let x = H0; x <= 24; x += 3) hours.push(`<span style="left:${((x - H0) / (H1 - H0)) * 100}%">${String(x % 24).padStart(2, '0')}h</span>`);
  return `<div class="ribbon" aria-label="Linha do dia">
    <div class="ribbon-track">
      ${timed.map((i, k) => { const a = pos(i.time); const b = i.end ? pos(i.end) : a + 4; return `<button class="slot ${i.tentative ? 'tentative' : ''}" data-open="${bound.push(i) - 1}" style="left:${a}%;width:${Math.max(b - a, 11)}%;--c:var(--${areaVar(i.area)});--r:${k % 2}" title="${h(i.time + (i.end ? '–' + i.end : '') + ' ' + i.title)}"><span>${h(i.time)} ${h(i.title)}</span></button>`; }).join('')}
      <div class="now" style="left:${pos(now)}%"><span>${now}</span></div>
    </div>
    <div class="ribbon-hours">${hours.join('')}</div>
    ${timed.length ? '' : '<p class="ribbon-empty">Nada com horário marcado hoje.</p>'}
  </div>`;
}

function ocupacaoStrip() {
  const hoje = today();
  const dias = Array.from({ length: 14 }, (_, i) => addDays(hoje, i));
  return `<div class="occ">
    <div class="occ-row occ-head"><span></span>${dias.map(d => `<span class="${['sáb', 'dom'].includes(weekdayShort(d)) ? 'we' : ''}">${+d.slice(8)}</span>`).join('')}</div>
    ${S.properties.map(p => `<div class="occ-row"><span class="occ-name" title="${h(p.id)}">${h(p.nome.replace('Casa ', ''))}</span>${dias.map(d => {
      const b = ocupacao(p.id, d);
      const cls = !b ? '' : b.status === 'bloqueio' ? 'blk' : b.origem === 'airbnb' ? 'air' : 'dir';
      const start = b && b.checkin === d ? ' st' : '';
      return `<span class="cell ${cls}${start}" title="${b ? h(`${b.hospede || b.origem} (${fmtDate(b.checkin)} a ${fmtDate(b.checkout)})`) : 'livre'}"></span>`;
    }).join('')}</div>`).join('')}
    <div class="occ-legend"><span><i class="cell air"></i>Airbnb</span><span><i class="cell dir"></i>Direto</span><span><i class="cell blk"></i>Bloqueio</span></div>
  </div>`;
}

export function render(el) {
  bound = [];
  const hoje = today();
  const att = atencao();
  const doDia = items({ from: hoje, to: hoje });
  const prox = items({ from: addDays(hoje, 1), to: addDays(hoje, 7) });
  const semanaGigs = prox.filter(i => i.kind === 'gig').length + doDia.filter(i => i.kind === 'gig').length;
  const inbox = S.tasks.filter(t => !t.feito && t.area === 'inbox' && !t.prazo);
  const hr = +hhmm(new Date().toISOString()).slice(0, 2);
  const saud = hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite';
  const resumo = [
    att.length ? `${att.length} ${att.length === 1 ? 'coisa escapando' : 'coisas escapando'}` : 'nada atrasado',
    `${doDia.length} para hoje`,
    semanaGigs ? `${semanaGigs} ${semanaGigs === 1 ? 'gig' : 'gigs'} em 7 dias` : null,
  ].filter(Boolean);

  const porDia = {};
  prox.forEach(i => (porDia[i.date] ||= []).push(i));

  el.innerHTML = `
  <section class="hero">
    <div>
      <h1>${saud}, Claudio</h1>
      <p class="hero-date">${fmtDate(hoje, { long: true })}</p>
    </div>
    <p class="hero-sum">${resumo.slice(0, -1).join(', ')}${resumo.length > 1 ? ' e ' : ''}${resumo.at(-1)}.</p>
  </section>
  ${ribbon(doDia)}
  <div class="cols">
    <div class="col-main">
      ${att.length ? `<section class="block warn">
        <h2>Escapando</h2>
        <ul class="list">${att.map(i => row(i, { late: true })).join('')}</ul>
      </section>` : ''}
      <section class="block">
        <h2>Hoje</h2>
        ${doDia.length ? `<ul class="list">${doDia.map(i => row(i)).join('')}</ul>` : `<p class="empty">Dia livre. Use a captura no topo para anotar o que aparecer.</p>`}
      </section>
      <section class="block">
        <h2>Próximos 7 dias</h2>
        ${Object.keys(porDia).length ? Object.entries(porDia).map(([d, l]) => `
          <h3 class="day">${relDate(d)}<span>${fmtDate(d)}</span></h3>
          <ul class="list">${l.map(i => row(i)).join('')}</ul>`).join('') : '<p class="empty">Nada marcado na semana.</p>'}
      </section>
    </div>
    <aside class="col-side">
      ${habitos.bloco()}
      <section class="block">
        <h2>Ocupação das casas</h2>
        ${ocupacaoStrip()}
        <a class="link" href="#/alugueis">Reservas e calendário</a>
      </section>
      <section class="block">
        <h2>Caixa de entrada <span class="count">${inbox.length || ''}</span></h2>
        ${inbox.length ? `<ul class="list compact">${inbox.map(t => row({ kind: 'tarefa', area: 'inbox', title: t.titulo, ref: t, prio: t.prioridade })).join('')}</ul>
          <p class="muted small">Abra um item para dar área e prazo, ou transformar em oportunidade.</p>`
          : '<p class="empty">Vazia. Tudo que você anotar sem data aparece aqui.</p>'}
      </section>
      <section class="block">
        <h2>Pipeline aberto</h2>
        ${pipeResumo()}
      </section>
    </aside>
  </div>`;

  el.onclick = async ev => {
    const a = ev.target.closest('a[data-wa]');
    if (a) { aposWhats(bound[+a.dataset.wa].ref); return; }
    const b = ev.target.closest('button'); if (!b) return;
    if (await habitos.onClick(b)) return;
    if (b.dataset.open) return openItem(bound[+b.dataset.open]);
    if (b.dataset.done) {
      const it = bound[+b.dataset.done];
      if (it.kind === 'tarefa') return toggleTask(it.ref);
      if (it.kind === 'etapa') return etapaDone(it.ref, it.etapa);
      return dealDone(it.ref);
    }
    if (b.dataset.snz) { const [i, n] = b.dataset.snz.split(':'); return snooze(bound[+i], +n); }
  };
  ligarGestos(el);
}

// Toque: deslizar a linha para a direita conclui; para a esquerda mostra WhatsApp e adiar
function ligarGestos(el) {
  if (el._gestos) return;
  el._gestos = true;
  let li = null, x0 = 0, y0 = 0, dx = 0, eixo = null;
  el.addEventListener('touchstart', e => {
    li = e.target.closest('.row.swipe, .row:has(.row-act)');
    if (!li || e.target.closest('a, .row-act')) { li = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; eixo = null;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (!li) return;
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (!eixo && Math.abs(mx) + Math.abs(my) > 10) eixo = Math.abs(mx) > Math.abs(my) * 1.5 ? 'x' : 'y';
    if (eixo !== 'x') return;
    dx = Math.max(-120, Math.min(120, mx));
    li.style.transform = `translateX(${dx}px)`;
    li.classList.toggle('sw-done', dx > 80);
    li.classList.toggle('sw-act', dx < -80);
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (!li) return;
    const alvo = li; li = null;
    alvo.style.transform = '';
    alvo.classList.remove('sw-done', 'sw-act');
    if (eixo !== 'x') return;
    if (dx > 80) alvo.querySelector('[data-done]')?.click();
    else if (dx < -80) {
      el.querySelectorAll('.row.show-act').forEach(r => r !== alvo && r.classList.remove('show-act'));
      alvo.classList.toggle('show-act');
    }
  });
}

function pipeResumo() {
  const ab = S.deals.filter(d => ['lead', 'orcamento', 'negociacao', 'fechado', 'realizado'].includes(d.etapa));
  if (!ab.length) return '<p class="empty">Nenhuma oportunidade aberta.</p>';
  const grupos = [['lead', 'Contatos'], ['orcamento', 'Orçamentos enviados'], ['negociacao', 'Negociando'], ['fechado', 'Fechados'], ['realizado', 'A receber']];
  return `<dl class="pipe-sum">${grupos.map(([k, l]) => {
    const g = ab.filter(d => d.etapa === k); if (!g.length) return '';
    return `<div><dt>${l}</dt><dd>${g.length}<small>${brl(g.reduce((s, d) => s + (+d.valor || 0), 0))}</small></dd></div>`;
  }).join('')}</dl><a class="link" href="#/pipeline">Abrir pipeline</a>`;
}
