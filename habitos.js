// Rastreador de hábitos: bloco da tela Hoje + cadastro
import { S, save, del } from './store.js';
import { h, today, addDays, dow, weekdayShort, fmtDate } from './util.js';
import { modal, toast, confirmInline, closeModal } from './ui.js';

const DIAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
// Regras do Garmin (habits.auto = "passos>=8000"): o script do PC marca o dia sozinho quando cumpre
const AUTO = [['passos', 'Passos no dia', 'passos', 8000], ['atividade', 'Minutos de atividade (relógio)', 'min', 30], ['sono', 'Horas de sono', 'h', 7], ['intensos', 'Minutos de intensidade', 'min', 20]];
// "atividade.corrida>=20": só minutos daquele tipo (os grupos de tipos do Garmin ficam em garmin/hubdb.py)
const TIPOS_AT = [['', 'qualquer atividade'], ['corrida', 'corrida'], ['forca', 'força'], ['caminhada', 'caminhada'], ['trilha', 'trilha'], ['pedal', 'pedal'], ['natacao', 'natação']];
const parseAuto = a => { const [k = '', v = ''] = (a || '').split('>='); const [base, tipo = ''] = k.split('.'); return { base, tipo, v }; };
const autoTxt = a => {
  const { base, tipo, v } = parseAuto(a); const r = AUTO.find(x => x[0] === base); if (!r) return '';
  const nome = base === 'atividade' ? `Minutos de ${TIPOS_AT.find(t => t[0] === tipo)?.[1] || 'atividade'}` : r[1];
  return `${nome} ≥ ${(+v).toLocaleString('pt-BR')}${r[2] === 'passos' ? '' : ' ' + r[2]}`;
};
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
          <button class="hb-name" data-hab-edit="${hb.id}" title="${hb.auto ? 'Marcado sozinho pelo Garmin: ' + h(autoTxt(hb.auto)) : 'Editar'}">${h(hb.nome)}${hb.auto ? ' <span class="hb-auto" aria-label="automático">⌚</span>' : ''}</button>
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
    </fieldset>
    <fieldset class="hb-autof"><legend>Marcar sozinho pelo Garmin</legend>
      <div class="hb-autorow"><select name="auto_k"><option value="">Não, eu marco</option>${AUTO.map(([k, l]) => `<option value="${k}" ${parseAuto(hb.auto).base === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span>≥</span><input name="auto_v" type="number" min="0" step="any" inputmode="decimal" value="${h(parseAuto(hb.auto).v)}" placeholder="8000"></div>
      <label class="hb-autotipo" ${parseAuto(hb.auto).base === 'atividade' ? '' : 'hidden'}>Conta só<select name="auto_t">${TIPOS_AT.map(([k, l]) => `<option value="${k}" ${parseAuto(hb.auto).tipo === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <small class="muted">O dia fica marcado quando o relógio registrar a meta (o programa do PC confere de manhã e à noite).</small>
    </fieldset>`, {
    extra: hb.id ? `<button type="button" class="btn danger" id="hbArch">Arquivar</button>` : '',
    onSubmit: async f => {
      const ds = [0, 1, 2, 3, 4, 5, 6].filter(i => f['d' + i]);
      if (!ds.length) throw new Error('Escolha pelo menos um dia.');
      const v = parseFloat(String(f.auto_v || '').replace(',', '.'));
      if (f.auto_k && !(v > 0)) throw new Error('Diga a meta do Garmin (um número maior que zero).');
      const row = { nome: f.nome.trim(), dias: ds, cor: f.cor, ativo: true, auto: f.auto_k ? `${f.auto_k}${f.auto_k === 'atividade' && f.auto_t ? '.' + f.auto_t : ''}>=${v}` : null };
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
  const ak = m.querySelector('[name=auto_k]'), av = m.querySelector('[name=auto_v]');
  ak.onchange = () => {
    const r = AUTO.find(x => x[0] === ak.value); if (r) { av.placeholder = r[3]; if (!av.value) av.value = r[3]; }
    m.querySelector('.hb-autotipo').hidden = ak.value !== 'atividade';
  };
  m.querySelector('#hbArch')?.addEventListener('click', async ev => {
    if (!confirmInline(ev.target)) return;
    await save('habits', { ativo: false }, hb.id); closeModal(); toast('Hábito arquivado (o histórico fica guardado)');
  });
}
