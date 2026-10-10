import { S, save, del } from './store.js';
import { h, today, diffDays, fmtDate, brl, etapa } from './util.js';
import { modal, toast, dealForm, confirmInline, closeModal } from './ui.js';

let q = '';

export function render(el) {
  const lista = S.contacts
    .filter(c => !q || (c.nome + ' ' + (c.telefone || '') + ' ' + (c.email || '')).toLowerCase().includes(q.toLowerCase()))
    .map(c => {
      const ds = S.deals.filter(d => d.contato_id === c.id);
      return { c, ds, total: ds.filter(d => d.etapa === 'pago').reduce((s, d) => s + (+d.valor || 0), 0) };
    })
    .sort((a, b) => (b.c.ultima_interacao || '').localeCompare(a.c.ultima_interacao || ''));

  el.innerHTML = `
  <div class="view-head">
    <h1>Contatos <span class="muted">${S.contacts.length}</span></h1>
    <input class="search" id="cq" type="search" placeholder="Buscar nome, telefone ou e-mail" value="${h(q)}">
    <button class="btn primary" id="cNew">Novo contato</button>
  </div>
  <table class="table">
    <thead><tr><th>Nome</th><th>Tipo</th><th>Telefone</th><th>Último contato</th><th class="num">Oportunidades</th><th class="num">Já pagou</th></tr></thead>
    <tbody>${lista.map(({ c, ds, total }) => `<tr data-c="${c.id}" tabindex="0">
      <td><b>${h(c.nome)}</b></td><td>${h(c.tipo || '')}</td><td>${h(c.telefone || '')}</td>
      <td>${c.ultima_interacao ? fmtDate(c.ultima_interacao, { year: true }) : ''}</td>
      <td class="num">${ds.length}</td><td class="num">${brl(total)}</td></tr>`).join('')}
    </tbody>
  </table>`;
  const inp = el.querySelector('#cq');
  inp.oninput = () => { q = inp.value; render(el); const n = el.querySelector('#cq'); n.focus(); n.setSelectionRange(q.length, q.length); };
  el.querySelector('#cNew').onclick = () => contactForm();
  el.querySelectorAll('[data-c]').forEach(r => {
    const go = () => contactForm(S.contacts.find(c => c.id === r.dataset.c));
    r.onclick = go; r.onkeydown = e => e.key === 'Enter' && go();
  });
}

function contactForm(c = {}) {
  const ds = c.id ? S.deals.filter(d => d.contato_id === c.id) : [];
  const wa = c.telefone ? 'https://wa.me/55' + c.telefone.replace(/\D/g, '').replace(/^55/, '') : null;
  modal(c.id ? c.nome : 'Novo contato', `
    <div class="grid2">
      <label class="span2">Nome<input name="nome" value="${h(c.nome)}" required autofocus></label>
      <label>Tipo<select name="tipo">${['cliente', 'contratante', 'hospede', 'fornecedor', 'parceiro'].map(t => `<option ${t === (c.tipo || 'cliente') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Telefone / WhatsApp<input name="telefone" value="${h(c.telefone)}"></label>
      <label>E-mail<input name="email" type="email" value="${h(c.email)}"></label>
      <label>Instagram<input name="instagram" value="${h(c.instagram)}"></label>
    </div>
    <label>Notas<textarea name="notas" rows="2">${h(c.notas)}</textarea></label>
    ${ds.length ? `<div class="quotes"><b>Oportunidades</b>${ds.sort((a, b) => (b.data_evento || '').localeCompare(a.data_evento || '')).map(d => `<button type="button" class="link-btn" data-d="${d.id}">${d.data_evento ? fmtDate(d.data_evento, { year: true }) + ': ' : ''}${h(d.titulo)} (${etapa(d.etapa).nome}${d.valor ? ', ' + brl(d.valor) : ''})</button>`).join('')}</div>` : ''}
  `, {
    extra: c.id ? `${wa ? `<a class="btn" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}<button type="button" class="btn" id="cTouch">Falei hoje</button><button type="button" class="btn" id="cDeal">Nova oportunidade</button>` : '',
    onSubmit: async f => { await save('contacts', f, c.id); toast('Contato salvo'); },
  });
  const m = document.getElementById('modal');
  m.querySelector('#cTouch')?.addEventListener('click', async () => { await save('contacts', { ultima_interacao: today() }, c.id); closeModal(); toast('Contato registrado'); });
  m.querySelector('#cDeal')?.addEventListener('click', () => { closeModal(); dealForm({ contato_id: c.id }); });
  m.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { closeModal(); dealForm(S.deals.find(d => d.id === b.dataset.d)); });
}
