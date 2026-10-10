import { S, prop, ocupacao } from './store.js';
import { h, today, addDays, fmtDate, weekdayShort, brl, diffDays, relDate } from './util.js';
import { bookingForm } from './ui.js';

let offset = 0;

export function render(el) {
  const hoje = today();
  const ini = addDays(hoje, offset);
  const dias = Array.from({ length: 35 }, (_, i) => addDays(ini, i));
  const fut = S.bookings.filter(b => b.checkout >= hoje && b.status !== 'cancelada').sort((a, b) => a.checkin.localeCompare(b.checkin));
  const mesAtual = hoje.slice(0, 7);
  const receitaMes = S.bookings.filter(b => b.status === 'confirmada' && b.checkin.slice(0, 7) === mesAtual).reduce((s, b) => s + (+b.valor || 0), 0);

  el.innerHTML = `
  <div class="view-head">
    <h1>Aluguéis</h1>
    <div class="seg"><button data-o="-7" aria-label="Semana anterior">‹</button><button data-o="0">Hoje</button><button data-o="7" aria-label="Próxima semana">›</button></div>
    <button class="btn primary" id="bkNew">Nova reserva</button>
  </div>
  <div class="gantt" style="--n:${dias.length}">
    <div class="g-row g-head"><span></span>${dias.map(d => `<span class="${d === hoje ? 'today' : ''} ${['sáb', 'dom'].includes(weekdayShort(d)) ? 'we' : ''}">${weekdayShort(d)[0]}<b>${+d.slice(8)}</b></span>`).join('')}</div>
    ${S.properties.map(p => {
      const bars = S.bookings.filter(b => b.property_id === p.id && b.status !== 'cancelada' && b.checkout > dias[0] && b.checkin <= dias.at(-1));
      return `<div class="g-row"><span class="g-name"><b>${h(p.nome)}</b><small>${h(p.id)}</small></span>
        <div class="g-track">${dias.map(d => `<span class="${d === hoje ? 'today' : ''}"></span>`).join('')}
        ${bars.map(b => {
          const s = Math.max(0, diffDays(dias[0], b.checkin)), e = Math.min(dias.length, diffDays(dias[0], b.checkout));
          const cls = b.status === 'bloqueio' ? 'blk' : b.origem === 'airbnb' ? 'air' : 'dir';
          return `<button class="bar ${cls}" data-bk="${b.id}" style="--s:${s + 0.5};--e:${e + 0.5}" title="${h(`${b.hospede || b.origem}: ${fmtDate(b.checkin)} a ${fmtDate(b.checkout)}`)}">${h(b.hospede || (b.status === 'bloqueio' ? 'Bloqueado' : b.origem))}</button>`;
        }).join('')}</div></div>`;
    }).join('')}
    <div class="occ-legend"><span><i class="cell air"></i>Airbnb</span><span><i class="cell dir"></i>Direto</span><span><i class="cell blk"></i>Bloqueio</span></div>
  </div>
  <div class="cols">
    <section class="block col-main">
      <h2>Próximas reservas</h2>
      ${fut.length ? `<table class="table"><thead><tr><th>Casa</th><th>Hóspede</th><th>Entrada</th><th>Saída</th><th>Noites</th><th>Origem</th><th class="num">Valor</th></tr></thead><tbody>
        ${fut.map(b => `<tr data-bk="${b.id}" tabindex="0"><td><span class="dot" style="--c:${prop(b.property_id).cor}"></span>${h(prop(b.property_id).nome)}</td><td>${h(b.hospede || (b.status === 'bloqueio' ? 'Bloqueio' : ''))}</td>
          <td>${relDate(b.checkin)}</td><td>${fmtDate(b.checkout)}</td><td class="num">${diffDays(b.checkin, b.checkout)}</td><td>${h(b.origem)}</td><td class="num">${brl(b.valor)}</td></tr>`).join('')}
      </tbody></table>` : `<p class="empty">Nenhuma reserva futura. Cadastre as reservas diretas em “Nova reserva”. As do Airbnb entram sozinhas depois que você colar os links iCal em Ajustes.</p>`}
    </section>
    <aside class="col-side block">
      <h2>Este mês</h2>
      <dl class="pipe-sum">
        <div><dt>Receita com check-in no mês</dt><dd>${brl(receitaMes) || 'R$ 0'}</dd></div>
        ${S.properties.map(p => {
          const ocup = Array.from({ length: 30 }, (_, i) => ocupacao(p.id, addDays(hoje, i))).filter(b => b && b.status === 'confirmada').length;
          return `<div><dt>${h(p.nome)}, próximos 30 dias</dt><dd>${Math.round(ocup / 30 * 100)}%<small>${ocup} noites</small></dd></div>`;
        }).join('')}
      </dl>
    </aside>
  </div>`;
  el.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { offset = +b.dataset.o ? offset + +b.dataset.o : 0; render(el); });
  el.querySelector('#bkNew').onclick = () => bookingForm();
  el.querySelectorAll('[data-bk]').forEach(b => b.onclick = () => bookingForm(S.bookings.find(x => x.id === b.dataset.bk)));
}
