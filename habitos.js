// Rastreador de hábitos: bloco da tela Hoje + cadastro
import { S, save, del } from './store.js';
import { h, today, addDays, dow, weekdayShort, fmtDate } from './util.js';
import { modal, toast, confirmInline, closeModal } from './ui.js';

const DIAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const CORES = ['#0e7c72', '#6d3fd1', '#2457c5', '#b4600a', '#c6312b', '#6b7a7d'];

const ativos = () => S.habits.filter(x => x.ativo !== false).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || (a.created_at || '').localeCompare(b.created_at || ''));
const diasDo = hb => (Array.isArray(hb.dias) && hb.dias.length ? hb.dias : [0, 1, 2, 3, 4, 5, 6]).map(Number);
const previsto = (hb, d) => diasDo(hb).includes(dow(d));
const feito = (hb, d) => S.habit_logs.some(l => l.habit_id === hb.id && l.dia === d);

// Dias seguidos cumpridos (dias não previstos não quebram a sequência; hoje ainda em aberto também não)
export function sequencia(hb) {
  let d = today(), n = 0;
  if (!feito(hb, d)) d = addDays(d, -1);
  for (let i = 0; i < 400; i++, d = addDays(d, -1)) {
    if (!previsto(hb, d)) continue;
    if (hb.created_at && d < hb.created_at.slice(0, 10)) break;
    if (feito(hb, d)) n++; else break;
  }
  return n;
}

export function bloco() {
  const lista = ativos();
  const hoje = today();
  const dias = Array.from({ length: 7 }, (_, i) => addDays(hoje, i - 6));
  const hojePrev = lista.filter(hb => previsto(hb, hoje));
  const hojeFeitos = hojePrev.filter(hb => feito(hb, hoje)).length;
  return `<section class="block habits">
    <h2>Hábitos ${hojePrev.length ? `<span class="count">${hojeFeitos} de ${hojePrev.length} hoje</span>` : ''}<button class="mini hb-manage" data-hab-new title="Novo hábito">+ novo</button></h2>
    ${lista.length ? `<div class="hb-grid">
      <div class="hb-row hb-head"><span></span>${dias.map(d => `<span class="${d === hoje ? 'is-today' : ''}">${DIAS[dow(d)]}</span>`).join('')}<span></span></div>
      ${lista.map(hb => {
        const seq = sequencia(hb);
        return `<div class="hb-row" style="--c:${hb.cor || CORES[0]}">
          <button class="hb-name" data-hab-edit="${hb.id}" title="Editar">${h(hb.nome)}</button>
          ${dias.map(d => {
            const p = previsto(hb, d), f = feito(hb, d);
            return `<button class="hb-cell ${f ? 'on' : ''} ${p ? '' : 'off'} ${d === hoje ? 'is-today' : ''}" data-hab-tog="${hb.id}|${d}"
              aria-pressed="${f}" aria-label="${h(hb.nome)}, ${fmtDate(d, { long: true })}${f ? ', feito' : ''}" title="${weekdayShort(d)} ${+d.slice(8)}${p ? '' : ' (folga)'}"></button>`;
          }).join('')}
          <span class="hb-seq" title="Dias seguidos">${seq ? `${seq}🔥` : ''}</span>
        </div>`;
      }).join('')}
    </div>` : `<p class="empty">Nenhum hábito ainda. <button class="link-btn" data-hab-new>Criar o primeiro</button></p>`}
  </section>`;
}

// Retorna true se tratou o clique
export async function onClick(b) {
  if (b.dataset.habTog) {
    const [id, d] = b.dataset.habTog.split('|');
    const log = S.habit_logs.find(l => l.habit_id === id && l.dia === d);
    b.classList.toggle('on'); // resposta imediata
    if (log) await del('habit_logs', log.id);
    else await save('habit_logs', { habit_id: id, dia: d });
    return true;
  }
  if (b.dataset.habNew !== undefined) { habitForm(); return true; }
  if (b.dataset.habEdit) { habitForm(S.habits.find(x => x.id === b.dataset.habEdit)); return true; }
  return false;
}

export function habitForm(hb = {}) {
  const dias = diasDo(hb);
  const cor = hb.cor || CORES[S.habits.length % CORES.length];
  modal(hb.id ? 'Hábito' : 'Novo hábito', `
    <label>Nome<input name="nome" value="${h(hb.nome)}" placeholder="ex.: Treinar, Ler 20 min, Praticar mix" required autofocus></label>
    <fieldset class="hb-days"><legend>Em quais dias</legend>
      ${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((n, i) => `<label class="chk"><input type="checkbox" name="d${i}" ${dias.includes(i) ? 'checked' : ''}> ${n}</label>`).join('')}
      <div class="quick-dates"><button type="button" class="chip" data-preset="0123456">Todo dia</button><button type="button" class="chip" data-preset="12345">Dias úteis</button><button type="button" class="chip" data-preset="06">Fim de semana</button></div>
    </fieldset>
    <fieldset class="hb-colors"><legend>Cor</legend>
      ${CORES.map(c => `<label class="swatch" style="--c:${c}"><input type="radio" name="cor" value="${c}" ${c === cor ? 'checked' : ''}><span></span></label>`).join('')}
    </fieldset>`, {
    extra: hb.id ? `<button type="button" class="btn danger" id="hbArch">Arquivar</button>` : '',
    onSubmit: async f => {
      const ds = [0, 1, 2, 3, 4, 5, 6].filter(i => f['d' + i]);
      if (!ds.length) throw new Error('Escolha pelo menos um dia.');
      const row = { nome: f.nome.trim(), dias: ds, cor: f.cor, ativo: true };
      if (!hb.id) row.ordem = S.habits.length;
      await save('habits', row, hb.id);
      toast(hb.id ? 'Hábito salvo' : 'Hábito criado');
    },
  });
  const m = document.getElementById('modal');
  m.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
    const p = b.dataset.preset;
    for (let i = 0; i < 7; i++) m.querySelector(`[name=d${i}]`).checked = p.includes(String(i));
  });
  m.querySelector('#hbArch')?.addEventListener('click', async ev => {
    if (!confirmInline(ev.target)) return;
    await save('habits', { ativo: false }, hb.id); closeModal(); toast('Hábito arquivado (o histórico fica guardado)');
  });
}
