// Paleta de comandos (Ctrl+K): busca em tudo e executa ações sem trocar de tela
import { S, contactName, prop } from './store.js';
import { h, fmtDate, etapa, AREAS, waLink } from './util.js';
import { dealForm, bookingForm, taskForm, eventForm } from './ui.js';
import { contactForm } from './v-contatos.js';

const $ = s => document.querySelector(s);
const norm = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
let lista = [], sel = 0;

// Pontua o texto: começa com a busca > alguma palavra começa > contém
function nota(txt, q) {
  const t = norm(txt);
  if (!q) return 1;
  if (t.startsWith(q)) return 3;
  if (t.split(/\s+/).some(w => w.startsWith(q))) return 2;
  return t.includes(q) ? 1 : 0;
}

const IR = [['hoje', 'Hoje'], ['pipeline', 'Pipeline'], ['agenda', 'Agenda'], ['alugueis', 'Aluguéis'], ['tarefas', 'Tarefas'], ['contatos', 'Contatos'], ['cripto', 'Cripto'], ['ajustes', 'Ajustes']];

function resultados(qRaw) {
  const q = norm(qRaw.trim());
  const out = [];
  if (q) {
    const add = (g, itens) => out.push(...itens.filter(x => x.n > 0).sort((a, b) => b.n - a.n || (b.ord || '').localeCompare(a.ord || '')).slice(0, 5).map(x => ({ ...x, g })));
    add('Oportunidades', S.deals.map(d => {
      const nome = contactName(d.contato_id) || d.titulo;
      return { n: Math.max(nota(nome, q), nota(d.titulo, q), nota(d.local, q) && 1), ord: d.data_evento || d.created_at,
        t: nome, s: [etapa(d.etapa).nome, AREAS[d.negocio]?.nome, d.data_evento && fmtDate(d.data_evento)].filter(Boolean).join(' · '), go: () => dealForm(d) };
    }));
    add('Contatos', S.contacts.map(c => ({ n: Math.max(nota(c.nome, q), nota(c.telefone, q) && 1, nota(c.email, q) && 1), ord: c.ultima_interacao,
      t: c.nome, s: [c.tipo, c.telefone].filter(Boolean).join(' · '), wa: waLink(c.telefone), go: () => contactForm(c) })));
    add('Reservas', S.bookings.filter(b => b.status !== 'cancelada').map(b => {
      const casa = prop(b.property_id).nome;
      return { n: Math.max(nota(b.hospede, q), nota(casa, q)), ord: b.checkin,
        t: `${casa} · ${b.hospede || (b.status === 'bloqueio' ? 'Bloqueio' : b.origem)}`, s: `${fmtDate(b.checkin)} a ${fmtDate(b.checkout)}`, go: () => bookingForm(b) };
    }));
    add('Tarefas', S.tasks.filter(t => !t.feito).map(t => ({ n: nota(t.titulo, q), ord: t.prazo, t: t.titulo, s: t.prazo ? fmtDate(t.prazo) : 'sem data', go: () => taskForm(t) })));
    add('Agenda', S.events.map(e => ({ n: nota(e.titulo, q), ord: e.inicio, t: e.titulo, s: fmtDate(e.inicio.slice(0, 10)), go: () => eventForm(e) })));
  }
  const txt = qRaw.trim();
  const acoes = [
    { t: txt ? `Nova oportunidade para “${txt}”` : 'Nova oportunidade', k: 'n', go: () => dealForm({}, { _contato: txt }) },
    { t: txt ? `Nova tarefa: “${txt}”` : 'Nova tarefa', go: () => taskForm({ titulo: txt, area: 'inbox' }) },
    { t: 'Nova reserva', go: () => bookingForm() },
    { t: 'Novo evento na agenda', go: () => eventForm() },
  ].map(a => ({ ...a, g: 'Ações', n: 1 }));
  const nav = IR.map(([r, l]) => ({ g: 'Ir para', t: l, n: nota(l, q) || nota(r, q), go: () => (location.hash = '#/' + r) })).filter(x => !q || x.n);
  // Sem busca: todas as ações e atalhos de navegação; com busca: resultados, as 2 ações de criar e as telas que batem
  return q ? [...out, ...acoes.slice(0, 2), ...nav] : [...acoes, ...nav];
}

function desenhar() {
  let g = null;
  $('#palList').innerHTML = lista.map((x, i) => {
    const cab = x.g !== g ? `<li class="pal-g" role="presentation">${h((g = x.g))}</li>` : '';
    return `${cab}<li id="pal-${i}" role="option" class="pal-it ${i === sel ? 'on' : ''}" aria-selected="${i === sel}" data-i="${i}">
      <span class="pal-t">${h(x.t)}</span>${x.s ? `<span class="pal-s">${h(x.s)}</span>` : ''}
      ${x.wa ? `<a class="mini wa" href="${h(x.wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</li>`;
  }).join('') || '<li class="pal-g">Nada encontrado</li>';
  $('#palIn').setAttribute('aria-activedescendant', lista.length ? 'pal-' + sel : '');
  $('#pal-' + sel)?.scrollIntoView({ block: 'nearest' });
}

function atualizar() { lista = resultados($('#palIn').value); sel = 0; desenhar(); }

function executar(i) {
  const x = lista[i]; if (!x) return;
  $('#pal').close();
  setTimeout(x.go, 0); // deixa o diálogo fechar antes de abrir o próximo modal
}

export function abrir() {
  const d = $('#pal');
  if (d.open) return;
  $('#palIn').value = '';
  atualizar();
  d.showModal();
  $('#palIn').focus();
}

export function iniciar() {
  const d = $('#pal'), inp = $('#palIn');
  inp.addEventListener('input', atualizar);
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, lista.length - 1); desenhar(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); desenhar(); }
    else if (e.key === 'Enter') { e.preventDefault(); executar(sel); }
  });
  $('#palList').addEventListener('click', e => {
    if (e.target.closest('a')) return d.close();
    const li = e.target.closest('[data-i]'); if (li) executar(+li.dataset.i);
  });
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!document.querySelector('#modal[open]')) abrir(); }
  });
}
