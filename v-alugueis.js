import { S, prop, ocupacao } from './store.js';
import { h, today, addDays, fmtDate, weekdayShort, brl, diffDays, relDate } from './util.js';
import { bookingForm, modal, toast } from './ui.js';
import * as db from './db.js';
import { progresso, acompanhada, prazo } from './hospedagem.js';

const ATRAS = 30; // dias passados no começo do Gantt
let rolagem = null; // posição do deslizador, mantida quando a tela redesenha

export function render(el) {
  const hoje = today();
  // de 30 dias atrás até 1 ano depois de hoje; navega-se pelo deslizador horizontal do Gantt
  const dias = Array.from({ length: ATRAS + 366 }, (_, i) => addDays(hoje, i - ATRAS));
  const fut = S.bookings.filter(b => b.checkout >= hoje && b.status !== 'cancelada').sort((a, b) => a.checkin.localeCompare(b.checkin));
  const mesAtual = hoje.slice(0, 7);
  const doMes = S.bookings.filter(b => b.status === 'confirmada' && b.checkin.slice(0, 7) === mesAtual);
  const receitaMes = doMes.reduce((s, b) => s + (+b.valor || 0), 0);
  const comValor = doMes.filter(b => +b.valor > 0).length; // o Airbnb não informa valor: avisar que o total está incompleto

  el.innerHTML = `
  <div class="view-head">
    <h1>Aluguéis</h1>
    <button class="btn" id="abQuote">Consultar Airbnb</button>
    <button class="btn primary" id="bkNew">Nova reserva</button>
  </div>
  <div class="gantt" style="--n:${dias.length}">
    <div class="g-row g-head"><span></span>${dias.map(d => `<span class="${d === hoje ? 'today' : ''} ${['sáb', 'dom'].includes(weekdayShort(d)) ? 'we' : ''}"${d.endsWith('-01') || d === dias[0] || d === hoje ? ` data-m="${h(fmtDate(d).split(' ').slice(1).join(' '))}"` : ''}>${weekdayShort(d)[0]}<b>${+d.slice(8)}</b></span>`).join('')}</div>
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
      ${fut.length ? `<table class="table"><thead><tr><th>Casa</th><th>Hóspede</th><th>Entrada</th><th>Saída</th><th>Noites</th><th>Origem</th><th>Sequência</th><th class="num">Valor</th></tr></thead><tbody>
        ${fut.map(b => `<tr data-bk="${b.id}" tabindex="0"><td><span class="dot" style="--c:${prop(b.property_id).cor}"></span>${h(prop(b.property_id).nome)}</td><td>${h(b.hospede || (b.status === 'bloqueio' ? 'Bloqueio' : ''))}</td>
          <td>${relDate(b.checkin)}</td><td>${fmtDate(b.checkout)}</td><td class="num">${diffDays(b.checkin, b.checkout)}</td><td>${h(b.origem)}</td><td>${seq(b)}</td><td class="num">${brl(b.valor)}</td></tr>`).join('')}
      </tbody></table>` : `<p class="empty">Nenhuma reserva futura. Cadastre as reservas diretas em “Nova reserva”. As do Airbnb entram sozinhas depois que você colar os links iCal em Ajustes.</p>`}
    </section>
    <aside class="col-side block">
      <h2>Este mês</h2>
      <dl class="pipe-sum">
        <div><dt>Receita com check-in no mês${comValor < doMes.length ? `<br><small class="late-lbl">só ${comValor} de ${doMes.length} reservas têm valor</small>` : ''}</dt><dd>${brl(receitaMes) || 'R$ 0'}</dd></div>
        ${S.properties.map(p => {
          const ocup = Array.from({ length: 30 }, (_, i) => ocupacao(p.id, addDays(hoje, i))).filter(b => b && b.status === 'confirmada').length;
          return `<div><dt>${h(p.nome)}, próximos 30 dias</dt><dd>${Math.round(ocup / 30 * 100)}%<small>${ocup} noites</small></dd></div>`;
        }).join('')}
      </dl>
    </aside>
  </div>`;
  const g = el.querySelector('.gantt');
  g.scrollLeft = rolagem ?? (ATRAS - 3) * 26; // abre com 3 dias antes de hoje à vista (26px por dia, ver .g-row no app.css)
  g.onscroll = () => { rolagem = g.scrollLeft; };
  el.querySelector('#bkNew').onclick = () => bookingForm();
  el.querySelector('#abQuote').onclick = () => consultaAirbnb();
  el.querySelectorAll('[data-bk]').forEach(b => b.onclick = () => bookingForm(S.bookings.find(x => x.id === b.dataset.bk)));
}

// Progresso das etapas da hospedagem: "2/6 · Enviar contrato"
function seq(b) {
  if (b.status !== 'confirmada') return '';
  const p = progresso(b);
  if (!p.proxima) return `<span class="seq ok">${p.total}/${p.total} pronto</span>`;
  if (!acompanhada(b)) return `<span class="seq">${p.feitas}/${p.total}</span>`;
  const late = prazo(b, p.proxima) < today();
  return `<span class="seq ${late ? 'late' : ''}"><b>${p.feitas}/${p.total}</b> ${h(p.proxima.nome)}${late ? ' (atrasada)' : ''}</span>`;
}

// ---------- Consulta de disponibilidade e preço no Airbnb (função airbnb-quote) ----------
// Mostra o resultado das 3 casas e um texto pronto para responder no WhatsApp.
export function consultaAirbnb({ checkin = addDays(today(), 7), checkout = addDays(today(), 10), adultos = 2 } = {}) {
  const d = modal('Consultar Airbnb', `
    <div class="grid3">
      <label>Entrada<input name="checkin" type="date" value="${h(checkin)}" min="${today()}" required></label>
      <label>Saída<input name="checkout" type="date" value="${h(checkout)}" required></label>
      <label>Hóspedes<input name="adultos" type="number" min="1" max="20" value="${h(adultos)}" required></label>
    </div>
    <div class="row-btns"><button type="button" class="btn primary" id="abGo">Consultar</button></div>
    <div id="abRes" aria-live="polite"></div>`);
  const $ = s => d.querySelector(s);
  const ir = async () => {
    const q = { checkin: $('[name=checkin]').value, checkout: $('[name=checkout]').value, adultos: +$('[name=adultos]').value || 2 };
    const res = $('#abRes');
    if (db.mode !== 'supabase') { res.innerHTML = '<p class="empty">A consulta ao Airbnb precisa do Hub conectado ao Supabase.</p>'; return; }
    if (!q.checkin || !q.checkout || q.checkout <= q.checkin) { res.innerHTML = '<p class="empty">A saída precisa ser depois da entrada.</p>'; return; }
    $('#abGo').disabled = true; res.innerHTML = '<p class="empty">Consultando o Airbnb…</p>';
    try {
      const { data, error } = await db.client().functions.invoke('airbnb-quote', { body: q });
      if (error || data?.error) throw new Error(data?.error || error.message);
      res.innerHTML = resultado(data);
      res.querySelector('#abCopy')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(res.querySelector('#abMsg').value); toast('Mensagem copiada'); }
        catch { res.querySelector('#abMsg').select(); toast('Selecione e copie a mensagem'); }
      });
    } catch (e) { res.innerHTML = `<p class="empty">Não foi possível consultar: ${h(e.message)}</p>`; }
    finally { $('#abGo').disabled = false; }
  };
  $('#abGo').onclick = ir;
  // mantém a saída depois da entrada ao trocar a data
  $('[name=checkin]').onchange = ev => { const co = $('[name=checkout]'); if (co.value <= ev.target.value) co.value = addDays(ev.target.value, 3); };
  d.querySelectorAll('#modalBody input').forEach(i => i.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); ir(); } });
}

const STATUS_AB = { livre: ['Disponível', 'ok'], ocupada: ['Ocupada', 'no'], min_noites: ['Mínimo de noites', 'warn'], capacidade: ['Não comporta', 'no'], erro: ['Erro', 'no'] };

function resultado(r) {
  const casas = r.casas.map(c => {
    const [rot, cls] = STATUS_AB[c.status] || [c.status, ''];
    const alt = c.alternativa;
    const det = c.status === 'livre' ? `<b>${brl(c.total)}</b><small>${c.diaria ? `${brl(c.diaria)} por noite` : ''}</small>`
      : c.status === 'min_noites' ? `<small>mínimo ${c.min_noites} noites${alt ? `: ${fmtDate(alt.checkin)} a ${fmtDate(alt.checkout)} por <b>${brl(alt.total)}</b>` : ''}</small>`
      : c.status === 'ocupada' ? `<small>${alt ? `livre de ${fmtDate(alt.checkin)} a ${fmtDate(alt.checkout)} por <b>${brl(alt.total)}</b>` : 'sem datas livres próximas'}</small>`
      : c.status === 'erro' ? `<small>${h(c.erro)}</small>` : '';
    return `<li><span class="dot" style="--c:${prop(c.id).cor}"></span><span class="ab-nome">${h(c.nome)}<a href="${h(c.link)}" target="_blank" rel="noopener">ver no Airbnb</a></span>
      <span class="ab-st ${cls}">${rot}</span><span class="ab-det">${det}</span></li>`;
  }).join('');
  return `<p class="muted ab-cab">${fmtDate(r.checkin)} a ${fmtDate(r.checkout)} · ${r.noites} ${r.noites === 1 ? 'noite' : 'noites'} · ${r.adultos} ${r.adultos === 1 ? 'hóspede' : 'hóspedes'} · preços do Airbnb</p>
    <ul class="ab-list">${casas}</ul>
    ${r.mensagem ? `<label>Resposta para o WhatsApp<textarea id="abMsg" rows="6">${h(r.mensagem)}</textarea></label>
    <div class="row-btns"><button type="button" class="btn" id="abCopy">Copiar mensagem</button></div>` : ''}`;
}
