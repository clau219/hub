import { S, items, atencao, prop, ocupacao, save, marcarCiente } from './store.js';
import { h, today, addDays, fmtDate, relDate, weekdayShort, areaTag, brl, hhmm, AREAS, NEGOCIOS_PIPE, abertasDe, etapaNoFluxo, etapa } from './util.js';
import { openItem, dealDone, snooze, toggleTask, taskForm, dealForm, toast, etapaDone, dealWa, aposWhats } from './ui.js';
import { CONFIG } from './config.js';
import * as habitos from './habitos.js';
import { fraseDia, fraseOcupacao, frasePipeline } from './frases.js';

let bound = [];
const abertos = new Set(); // grupos do Escapando expandidos ("ver mais")
const LIMITE = 5;

// Escapando em 3 grupos, do que custa dinheiro ao que é só seu
const GRUPOS = [
  ['dinheiro', 'Dinheiro em jogo', it => it.kind === 'acao'],
  ['terceiros', 'Compromissos com outras pessoas', it => it.kind === 'etapa' || it.kind === 'conflito'],
  ['pessoal', 'Tarefas', it => it.kind === 'tarefa'],
];
function escapando(att) {
  const gs = GRUPOS.map(([id, nome, f]) => [id, nome, att.filter(f)]).filter(g => g[2].length);
  const sub = gs.length > 1;
  return gs.map(([id, nome, l]) => {
    const vis = abertos.has(id) ? l : l.slice(0, LIMITE);
    return `${sub ? `<h3 class="esc-g">${nome} <span class="count">${l.length}</span></h3>` : ''}
      <ul class="list">${vis.map(i => row(i, { late: true })).join('')}</ul>
      ${l.length > LIMITE ? `<button class="link-btn" data-mais="${id}">${abertos.has(id) ? 'Mostrar menos' : `Ver mais ${l.length - LIMITE}`}</button>` : ''}`;
  }).join('');
}

function row(it, { late } = {}) {
  const idx = bound.push(it) - 1;
  const done = it.kind === 'tarefa' || it.kind === 'acao' || it.kind === 'etapa' || it.kind === 'conflito';
  const canSnooze = it.kind === 'tarefa' || it.kind === 'acao';
  const icon = { acao: '●', tarefa: '○', gig: '♪', checkin: '↘', checkout: '↗', evento: '▪' }[it.kind];
  const wa = it.kind === 'acao' ? dealWa(it.ref) : null;
  const dica = it.kind === 'acao' ? 'Feito, definir próximo passo' : it.kind === 'etapa' ? 'Marcar etapa como feita' : it.kind === 'conflito' ? 'Ciente, já está combinado' : 'Concluir';
  const lbl = it.motivo === 'atrasada' || it.motivo === 'conflito' ? relDate(it.date) : it.motivo;
  return `<li class="row ${late ? (it.motivo === 'conflito' ? 'conf' : 'late') : ''} ${it.tentative ? 'tentative' : ''} ${done ? 'swipe' : ''}" style="--c:var(--${areaVar(it.area)})">
    ${done ? `<button class="tick" data-done="${idx}" title="${dica}" aria-label="${h(dica + ': ' + it.title)}"></button>` : `<span class="kind" aria-hidden="true">${icon}</span>`}
    <button class="row-main" data-open="${idx}">
      <span class="row-title">${it.time ? `<b class="time">${h(it.time)}</b>` : ''}${h(it.title)}${it.prio === 1 ? ' <span class="prio">alta</span>' : ''}</span>
      ${it.sub ? `<span class="row-sub">${h(it.sub)}</span>` : ''}
    </button>
    <span class="row-meta">${late ? `<span class="late-lbl">${lbl}</span>` : ''}${it.kind === 'gig' && it.ref.valor ? brl(it.ref.valor) : ''}</span>
    ${canSnooze || wa ? `<span class="row-act">${wa ? `<a class="mini wa" href="${h(wa)}" target="_blank" rel="noopener" data-wa="${idx}" aria-label="WhatsApp: ${h(it.sub || it.title)}">WhatsApp</a>` : ''}${canSnooze ? `<button class="mini" data-snz="${idx}:1" aria-label="Adiar para amanhã: ${h(it.title)}">amanhã</button><button class="mini" data-snz="${idx}:3" aria-label="Adiar 3 dias: ${h(it.title)}">+3d</button>` : ''}</span>` : ''}
  </li>`;
}
// Frase que interpreta o card, com o link para a lista certa
const frase = f => f ? `<p class="frase">${h(f.texto)}${f.link ? ` <a class="link" href="${f.link}">${h(f.rotulo)}</a>` : ''}</p>` : '';
const areaVar = a => ({ dj: 'dj', alugueis: 'alug', aluguel: 'alug', consultoria: 'eng', argila: 'argila' }[a] || 'casa');

function ribbon(list) {
  const H0 = 7, H1 = 25;
  const pos = t => { const [hh, mm] = t.split(':').map(Number); const v = (hh < H0 ? hh + 24 : hh) + mm / 60; return ((Math.min(Math.max(v, H0), H1) - H0) / (H1 - H0)) * 100; };
  const timed = list.filter(i => i.time);
  const now = hhmm(new Date().toISOString());
  // Madrugada (antes das 7h): a data já é de hoje, mas o dia não começou; o marcador fica no início, não no fim
  const cedo = +now.slice(0, 2) < H0;
  const hours = [];
  for (let x = H0; x <= 24; x += 3) hours.push(`<span style="left:${((x - H0) / (H1 - H0)) * 100}%">${String(x % 24).padStart(2, '0')}h</span>`);
  return `<div class="ribbon" aria-label="Linha do dia">
    <div class="ribbon-track">
      ${timed.map((i, k) => { const a = pos(i.time); const b = i.end ? pos(i.end) : a + 4; return `<button class="slot ${i.tentative ? 'tentative' : ''}" data-open="${bound.push(i) - 1}" style="left:${a}%;width:${Math.max(b - a, 11)}%;--c:var(--${areaVar(i.area)});--r:${k % 2}" title="${h(i.time + (i.end ? '–' + i.end : '') + ' ' + i.title)}"><span>${h(i.time)} ${h(i.title)}</span></button>`; }).join('')}
      <div class="now${cedo ? ' early' : ''}" style="left:${cedo ? 0 : pos(now)}%" title="${cedo ? 'Madrugada: o dia ainda não começou' : ''}"><span>${now}</span></div>
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
  const saud = hr < 5 ? 'Boa noite' : hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite';
  // Resumo em números clicáveis: cada um leva à seção correspondente
  const stats = [
    [att.length ? 'warn' : 'ok', att.length || '✓', att.length ? 'escapando' : 'nada atrasado', att.length ? 'sec-esc' : 'sec-dia'],
    ['', doDia.length, 'para hoje', 'sec-dia'],
    ['', semanaGigs, semanaGigs === 1 ? 'gig em 7 dias' : 'gigs em 7 dias', 'sec-prox'],
  ];

  const porDia = {};
  prox.forEach(i => (porDia[i.date] ||= []).push(i));

  el.innerHTML = `
  <section class="hero">
    <div>
      <p class="hero-date">${fmtDate(hoje, { long: true })}</p>
      <h1>${saud}, Claudio</h1>
      ${(f => f ? `<p class="hero-frase">${h(f.texto)}</p>` : '')(fraseDia(doDia))}
    </div>
    <div class="hero-stats">${stats.map(([c, n, l, alvo]) => `<button class="stat ${c}" data-ir="${alvo}"><b>${n}</b><span>${l}</span></button>`).join('')}</div>
  </section>
  ${ribbon(doDia)}
  <div class="cols">
    <div class="col-main">
      ${att.length ? `<section class="block warn" id="sec-esc">
        <h2>Escapando <span class="count">${att.length}</span></h2>
        ${escapando(att)}
      </section>` : ''}
      <section class="block" id="sec-dia">
        <h2>Hoje</h2>
        ${doDia.length ? `<ul class="list">${doDia.map(i => row(i)).join('')}</ul>` : `<p class="empty">Dia livre. Anote o que aparecer no campo do topo ou pelo WhatsApp: “me lembra às 15h de ligar pro contador”.</p>`}
      </section>
      <section class="block" id="sec-prox">
        <h2>Próximos 7 dias</h2>
        ${Object.keys(porDia).length ? Object.entries(porDia).map(([d, l]) => `
          <h3 class="day">${relDate(d)}<span>${fmtDate(d)}</span></h3>
          <ul class="list">${l.map(i => row(i)).join('')}</ul>`).join('') : '<p class="empty">Semana sem gigs, reservas nem compromissos. Gig novo: “+dj Ana 15/11 3500” no campo do topo ou no WhatsApp.</p>'}
      </section>
    </div>
    <aside class="col-side">
      ${habitos.bloco()}
      <section class="block">
        <h2>Ocupação das casas</h2>
        ${frase(fraseOcupacao(S.properties, (id, d) => !!ocupacao(id, d), hoje))}
        ${ocupacaoStrip()}
        <a class="link" href="#/alugueis">Reservas e calendário</a>
      </section>
      <section class="block">
        <h2>Caixa de entrada <span class="count">${inbox.length || ''}</span></h2>
        ${inbox.length ? `<ul class="list compact">${inbox.map(t => row({ kind: 'tarefa', area: 'inbox', title: t.titulo, ref: t, prio: t.prioridade })).join('')}</ul>
          <p class="muted small">Abra um item para dar área e prazo, ou transformar em oportunidade.</p>`
          : '<p class="empty">Vazia. O que você anota sem data, aqui ou pelo WhatsApp, cai nesta caixa para organizar depois.</p>'}
      </section>
      <section class="block">
        <h2>Pipeline aberto</h2>
        ${frase(frasePipeline(S.deals, hoje))}
        ${pipeResumo()}
      </section>
    </aside>
  </div>`;

  el.onclick = async ev => {
    const a = ev.target.closest('a[data-wa]');
    if (a) { aposWhats(bound[+a.dataset.wa].ref); return; }
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.ir) return document.getElementById(b.dataset.ir)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (await habitos.onClick(b)) return;
    if (b.dataset.open) return openItem(bound[+b.dataset.open]);
    if (b.dataset.mais) { abertos.has(b.dataset.mais) ? abertos.delete(b.dataset.mais) : abertos.add(b.dataset.mais); return render(el); }
    if (b.dataset.done) {
      const it = bound[+b.dataset.done];
      if (it.kind === 'conflito') { marcarCiente(it.chave); return toast('Ok, conflito marcado como resolvido'); }
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

// Um resumo por negócio: total aberto e quantas em cada etapa (com os nomes daquele negócio)
function pipeResumo() {
  const linhas = NEGOCIOS_PIPE.map(n => {
    const ab = S.deals.filter(d => (d.negocio || 'dj') === n && abertasDe(n).includes(etapaNoFluxo(d)));
    if (!ab.length) return '';
    const etapas = abertasDe(n).map(id => [etapa(id, n).nome, ab.filter(d => etapaNoFluxo(d) === id).length]).filter(([, q]) => q);
    return `<div><dt>${AREAS[n].nome}<small class="pipe-et">${etapas.map(([nome, q]) => `${q} ${h(nome.toLowerCase())}`).join(' · ')}</small></dt>
      <dd>${ab.length}<small>${brl(ab.reduce((s, d) => s + (+d.valor || 0), 0))}</small></dd></div>`;
  }).join('');
  if (!linhas) return '<p class="empty">Nenhuma oportunidade aberta. Pelo WhatsApp, “+dj Anabela 15/11 3500” cria uma.</p>';
  return `<dl class="pipe-sum">${linhas}</dl><a class="link" href="#/pipeline">Abrir pipeline</a>`;
}
