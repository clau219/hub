// Saúde: dados do Garmin (sono, VFC, FC de repouso, Body Battery, passos, estresse, atividades).
// Os dados chegam pelo script do PC (pasta HUB\garmin), não pelo navegador. Esta tela só lê.
import { S } from './store.js';
import * as db from './db.js';
import { h, today, addDays, fmtDate, dow, weekdayShort, localDate } from './util.js';
import { insights } from './saude-insights.js';

const PERIODOS = [[7, '7 dias'], [30, '30 dias'], [90, '90 dias'], [365, '1 ano']];
let periodo = 30;
let D = { daily: [], acts: [], status: null, ultimo: null, desde: null, at: 0, erro: '' };
let carregando = false;
let viewEl = null;
const CFG = {}; // gráficos desenhados, para o hover

const naTela = () => location.hash.startsWith('#/saude');
const n0 = v => v == null ? '–' : Math.round(v).toLocaleString('pt-BR');
const hm = seg => seg == null ? '–' : `${Math.floor(seg / 3600)}h${String(Math.round(seg % 3600 / 60)).padStart(2, '0')}`;
const km = m => m ? (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km' : '';
const media = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const HRV = { BALANCED: 'equilibrada', UNBALANCED: 'desequilibrada', LOW: 'baixa', POOR: 'ruim' };
const TIPOS = {
  running: 'Corrida', treadmill_running: 'Esteira', trail_running: 'Trail', walking: 'Caminhada', hiking: 'Trilha', cycling: 'Pedal',
  indoor_cycling: 'Bike indoor', strength_training: 'Musculação', lap_swimming: 'Natação', open_water_swimming: 'Mar', swimming: 'Natação',
  yoga: 'Yoga', pilates: 'Pilates', indoor_cardio: 'Cardio', hiit: 'HIIT', surfing: 'Surfe', stand_up_paddleboarding: 'SUP', other: 'Outra',
};
const tipoNome = t => TIPOS[t] || (t ? t.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Atividade');

// Carrega do Supabase o período (+30 dias para a comparação; no mínimo 120, para as tendências dos insights); páginas de 1000 linhas
async function carregar(force) {
  const desde = addDays(today(), -Math.max(periodo + 30, 120));
  if (carregando || (!force && D.desde && D.desde <= desde && Date.now() - D.at < 5 * 60e3)) return;
  carregando = true;
  try {
    if (db.mode === 'supabase') {
      const sb = db.client();
      const todas = async (t, col) => {
        const out = [];
        for (let i = 0; ; i += 1000) {
          const { data, error } = await sb.from(t).select('*').gte(col, desde).order(col).range(i, i + 999);
          if (error) throw error;
          out.push(...data);
          if (data.length < 1000) return out;
        }
      };
      const [daily, acts, st, ult, ua] = await Promise.all([todas('health_daily', 'dia'), todas('health_activities', 'dia'),
        sb.from('app_config').select('value').eq('key', 'garmin_status').maybeSingle(),
        sb.from('health_daily').select('dia').not('passos', 'is', null).order('dia', { ascending: false }).limit(1),
        sb.from('health_activities').select('dia').order('dia', { ascending: false }).limit(1)]);
      let status = null; try { status = JSON.parse(st.data?.value || 'null'); } catch {}
      D = { daily, acts, status, ultimo: ult.data?.[0]?.dia || null, ultAtiv: ua.data?.[0]?.dia || '', desde, at: Date.now(), erro: '' };
    } else {
      const [daily, acts] = await Promise.all([db.all('health_daily'), db.all('health_activities')]);
      const ultimo = daily.filter(r => r.passos != null).map(r => r.dia).sort().at(-1) || null;
      D = { daily: daily.filter(r => r.dia >= desde), acts: acts.filter(a => a.dia >= desde), status: null, ultimo, ultAtiv: acts.map(a => a.dia).sort().at(-1) || '', desde, at: Date.now(), erro: '' };
    }
  } catch (e) {
    D.erro = 'Não foi possível carregar os dados de saúde: ' + (e.message || e);
  } finally {
    carregando = false;
    if (viewEl && naTela()) render(viewEl);
  }
}

export function render(el) {
  viewEl = el;
  const p = +(location.hash.split('?')[1] || 0);
  if (PERIODOS.some(x => x[0] === p)) periodo = p;
  carregar(false);

  const hoje = today(), ini = addDays(hoje, -(periodo - 1));
  const porDia = Object.fromEntries(D.daily.map(r => [r.dia, r]));
  const dias = Array.from({ length: periodo }, (_, i) => addDays(ini, i));
  const linhas = dias.map(d => porDia[d] || { dia: d });
  const temDados = D.ultimo || D.acts.length;
  const parado = D.ultimo && D.ultimo < addDays(hoje, -2);

  el.innerHTML = `
  <div class="view-head">
    <h1>Saúde</h1>
    <div class="seg" role="tablist">${PERIODOS.map(([k, l]) => `<button role="tab" aria-selected="${k === periodo}" class="${k === periodo ? 'on' : ''}" data-per="${k}">${l}</button>`).join('')}</div>
    <span class="muted small">${statusTxt()}</span>
  </div>
  ${D.erro ? `<p class="banner">${h(D.erro)}</p>` : ''}
  ${D.status?.erro ? `<p class="banner">Garmin: ${h(D.status.erro)}</p>` : ''}
  ${parado ? `<p class="banner sd-parado">${D.ultAtiv > D.ultimo
      ? `As atividades continuam chegando (a última em ${fmtDate(D.ultAtiv)}), mas o Garmin não tem passos, sono nem FC do dia a dia desde <b>${fmtDate(D.ultimo, { long: true })}</b>. Confira se o relógio está sendo usado fora dos treinos e se o "Monitoramento de atividades" está ligado nele.`
      : `O relógio não manda dados desde <b>${fmtDate(D.ultimo, { long: true })}</b>. Abra o app Garmin Connect no celular perto do relógio para sincronizar; o Hub pega o que chegar na próxima rodada.`}
    ${D.ultimo < ini ? `<button class="link-btn" data-per="365">Ver o último ano</button>` : ''}</p>` : ''}
  ${!temDados ? (D.at ? vazio() : '<p class="empty">Carregando…</p>') : `
  ${coach()}
  ${tiles(porDia)}
  ${gigs(porDia)}
  <div class="sd-grid">
    ${grafico('sono', 'Sono', linhas, { tipo: 'pilha', alvo: 7 * 3600, unidade: 'h por noite' })}
    ${grafico('passos', 'Passos', linhas, { campo: 'passos', tipo: 'barra', cor: 'var(--brand)', fmt: n0, alvo: media(linhas.map(r => r.meta_passos)) })}
    ${grafico('fc', 'FC de repouso', linhas, { campo: 'fc_repouso', tipo: 'linha', cor: 'var(--late)', fmt: v => n0(v) + ' bpm', unidade: 'bpm' })}
    ${grafico('hrv', 'VFC à noite', linhas, { campo: 'hrv_noite', tipo: 'linha', cor: 'var(--eng)', fmt: v => n0(v) + ' ms', unidade: 'ms' })}
    ${grafico('bb', 'Body Battery', linhas, { tipo: 'faixa', cor: 'var(--warn-ink)', unidade: 'mín. e máx. do dia' })}
    ${grafico('estresse', 'Estresse médio', linhas, { campo: 'estresse_medio', tipo: 'linha', cor: 'var(--flores)', fmt: n0, unidade: '0 a 100' })}
  </div>
  ${atividades(dias)}`}`;

  el.querySelectorAll('[data-per]').forEach(b => b.onclick = () => {
    periodo = +b.dataset.per; history.replaceState(null, '', '#/saude?' + periodo); render(el);
  });
  el.querySelectorAll('.sd-hit').forEach(bindHover);
}

function statusTxt() {
  const s = D.status;
  if (!s?.em) return db.mode === 'supabase' && D.at ? 'Garmin ainda não sincronizou' : '';
  const d = localDate(s.em);
  const quando = d === today() ? 'hoje' : d === addDays(today(), -1) ? 'ontem' : fmtDate(d);
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(s.em));
  return `Garmin sincronizado ${quando}, ${hora}`;
}

function vazio() {
  return `<section class="block sd-vazio">
    <h2>Conectar o Garmin</h2>
    <p>Os dados chegam por um programinha que roda no computador (pasta <code>HUB\\garmin</code>) e grava aqui, sozinho, de manhã e à noite.</p>
    <ol>
      <li>No terminal, dentro da pasta <code>A:\\Usuário\\HUB\\garmin</code>, rode <code>python garmin_login.py</code> e digite seu e-mail e senha do Garmin (a senha não fica salva).</li>
      <li>Depois rode <code>python garmin_sync.py --dias 90</code> para trazer os últimos meses.</li>
      <li>Para o histórico completo, peça a exportação no Garmin Connect e rode <code>python importar_exportacao.py arquivo.zip</code>.</li>
    </ol>
  </section>`;
}

// Números do topo: o último dia com dado de cada coisa, comparado à média de 30 dias
function tiles(porDia) {
  const ult = campo => { for (let i = 0; i < 4; i++) { const r = porDia[addDays(today(), -i)]; if (r?.[campo] != null) return r; } return null; };
  const med = campo => media(Array.from({ length: 30 }, (_, i) => porDia[addDays(today(), -i - 1)]?.[campo]));
  const quando = r => r.dia === today() ? 'hoje' : r.dia === addDays(today(), -1) ? 'ontem' : weekdayShort(r.dia);
  const delta = (v, m, fmt, melhorAlto = true) => {
    if (v == null || m == null) return '';
    const diff = v - m; if (Math.abs(diff) < Math.abs(m) * .03) return `<small>na média de 30 dias (${fmt(m)})</small>`;
    const bom = (diff > 0) === melhorAlto;
    return `<small class="${bom ? 'sd-bom' : 'sd-ruim'}">${diff > 0 ? '▲' : '▼'} vs. média ${fmt(m)}</small>`;
  };
  const out = [];
  let r = ult('sono_seg');
  if (r) out.push(`<div class="kpi"><span>Sono (${quando(r)})</span><b>${hm(r.sono_seg)}</b>${r.sono_score ? `<small>nota ${r.sono_score}</small>` : ''}${delta(r.sono_seg, med('sono_seg'), hm)}</div>`);
  r = ult('hrv_noite');
  if (r) out.push(`<div class="kpi"><span>VFC (${quando(r)})</span><b>${r.hrv_noite} ms</b>${r.hrv_status ? `<small>${HRV[r.hrv_status] || h(r.hrv_status.toLowerCase())}</small>` : ''}${delta(r.hrv_noite, med('hrv_noite'), v => n0(v) + ' ms')}</div>`);
  r = ult('fc_repouso');
  if (r) out.push(`<div class="kpi"><span>FC de repouso (${quando(r)})</span><b>${r.fc_repouso} bpm</b>${delta(r.fc_repouso, med('fc_repouso'), v => n0(v), false)}</div>`);
  r = ult('bb_max');
  if (r) out.push(`<div class="kpi"><span>Body Battery (${quando(r)})</span><b>${r.bb_max}</b><small>máx. do dia${r.bb_min != null ? `, mín. ${r.bb_min}` : ''}</small></div>`);
  r = porDia[today()];
  if (r?.passos != null) out.push(`<div class="kpi"><span>Passos hoje</span><b>${n0(r.passos)}</b>${r.meta_passos ? `<small>meta ${n0(r.meta_passos)} (${Math.round(r.passos / r.meta_passos * 100)}%)</small>` : ''}</div>`);
  r = ult('prontidao');
  if (r) out.push(`<div class="kpi"><span>Prontidão p/ treino</span><b>${r.prontidao}</b><small>de 100</small></div>`);
  const v = D.daily.filter(x => x.vo2max).at(-1);
  if (v) out.push(`<div class="kpi"><span>VO2máx</span><b>${(+v.vo2max).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}</b><small>${fmtDate(v.dia)}</small></div>`);
  const p = D.daily.filter(x => x.peso_kg).at(-1);
  if (p) out.push(`<div class="kpi"><span>Peso</span><b>${(+p.peso_kg).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} kg</b><small>${fmtDate(p.dia)}</small></div>`);
  return out.length ? `<div class="kpis sd-kpis">${out.join('')}</div>` : '';
}

const gigDatas = () => new Set([
  ...S.deals.filter(d => d.negocio === 'dj' && d.data_evento && ['fechado', 'realizado', 'pago'].includes(d.etapa)).map(d => d.data_evento),
  ...S.events.filter(e => e.calendario === 'dj' && e.inicio).map(e => localDate(e.inicio)),
]);

// Recomendação do dia + cartões da semana (regras em saude-insights.js)
function coach() {
  const r = insights(D.daily, D.acts, [...gigDatas()]);
  const ROT = { forte: 'Treinar forte', leve: 'Treino leve', descanso: 'Descanso ativo' };
  return `<section class="sd-coach sd-${r.estado}">
    <div class="sd-coach-main">
      <span class="sd-selo">${ROT[r.estado]}</span>
      <h2>${h(r.titulo)}</h2>
      <p>${h(r.texto)}</p>
      <p class="sd-sug"><b>Sugestão:</b> ${h(r.sugestao)}</p>
      ${r.motivos.length ? `<ul class="sd-motivos">${r.motivos.map(m => `<li class="${m.sinal > 0 ? 'pos' : m.sinal < 0 ? 'neg' : ''}"><span aria-hidden="true">${m.sinal > 0 ? '▲' : m.sinal < 0 ? '▼' : '•'}</span>${h(m.txt)}</li>`).join('')}</ul>` : ''}
    </div>
    ${r.cards.length ? `<div class="sd-ins">${r.cards.map(c => `<div class="sd-in ${c.tom}"><b>${h(c.titulo)}</b><span>${h(c.txt)}</span></div>`).join('')}</div>` : ''}
  </section>`;
}

// Noite depois de gig x demais noites (o sono do Garmin fica no dia em que você acorda)
function gigs(porDia) {
  const datas = gigDatas();
  const ini = addDays(today(), -(Math.max(periodo, 30) - 1));
  const pos = [...datas].filter(d => d >= ini && d < today()).map(d => addDays(d, 1));
  const posSet = new Set(pos);
  const noites = D.daily.filter(r => r.dia >= ini && r.sono_seg);
  const comGig = noites.filter(r => posSet.has(r.dia)), outras = noites.filter(r => !posSet.has(r.dia));
  if (comGig.length < 2 || outras.length < 3) return '';
  const sG = media(comGig.map(r => r.sono_seg)), sO = media(outras.map(r => r.sono_seg));
  const bbDepois = media(pos.map(d => porDia[addDays(d, 1)]?.bb_max)), bbO = media(noites.filter(r => !posSet.has(r.dia)).map(r => r.bb_max));
  return `<section class="block sd-gig">
    <h2>Fins de semana de gig <span class="count">${comGig.length} gigs em ${Math.max(periodo, 30)} dias</span></h2>
    <p>Na noite depois de tocar você dorme em média <b>${hm(sG)}</b>, contra <b>${hm(sO)}</b> nas outras noites (${sG < sO ? hm(sO - sG) + ' a menos' : 'nada a menos'}).
    ${bbDepois != null && bbO != null ? ` Dois dias depois, o Body Battery chega a <b>${n0(bbDepois)}</b> no máximo, contra <b>${n0(bbO)}</b> num dia comum.` : ''}</p>
  </section>`;
}

// Gráfico simples de uma série (ou pilha de fases do sono / faixa mín–máx), com dica ao passar o mouse
function grafico(id, titulo, linhas, o) {
  const W = 600, H = 150, T = 8, B = 4;
  const n = linhas.length, bw = W / n, gap = n > 120 ? 0 : Math.min(2, bw * .25);
  let vals, hi, lo = 0;
  if (o.tipo === 'pilha') vals = linhas.map(r => r.sono_seg ?? null);
  else if (o.tipo === 'faixa') vals = linhas.map(r => r.bb_max ?? null);
  else vals = linhas.map(r => r[o.campo] ?? null);
  const ok = vals.filter(v => v != null);
  if (!ok.length) return `<section class="sd-card"><h3>${titulo}</h3><p class="empty small">Sem dados no período.</p></section>`;
  hi = Math.max(...ok, o.alvo || 0);
  if (o.tipo === 'linha') { lo = Math.min(...ok); const pad = (hi - lo) * .15 || 2; lo = Math.max(0, lo - pad); hi += pad; }
  else if (o.tipo === 'faixa') { lo = 0; hi = 100; }
  else hi *= 1.08;
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const x = i => i * bw + bw / 2;
  let marks = '';
  if (o.tipo === 'barra') {
    marks = linhas.map((r, i) => vals[i] == null ? '' : `<rect x="${(i * bw + gap / 2).toFixed(1)}" width="${(bw - gap).toFixed(1)}" y="${y(vals[i]).toFixed(1)}" height="${(H - B - y(vals[i])).toFixed(1)}" fill="${o.cor}"/>`).join('');
  } else if (o.tipo === 'pilha') {
    // profundo embaixo (mais escuro), REM, leve em cima; dia sem fases vira barra única
    marks = linhas.map((r, i) => {
      if (!r.sono_seg) return '';
      const fases = r.sono_profundo_seg != null ? [['p', r.sono_profundo_seg], ['r', r.sono_rem_seg || 0], ['l', r.sono_leve_seg || 0]] : [['l', r.sono_seg]];
      let base = 0;
      return fases.map(([k, v]) => {
        const y0 = y(base), y1 = y(base + v); base += v;
        return v ? `<rect class="sd-f${k}" x="${(i * bw + gap / 2).toFixed(1)}" width="${(bw - gap).toFixed(1)}" y="${(y1 + (base > v ? .8 : 0)).toFixed(1)}" height="${Math.max(0, y0 - y1 - (base > v ? .8 : 0)).toFixed(1)}"/>` : '';
      }).join('');
    }).join('');
  } else if (o.tipo === 'faixa') {
    marks = linhas.map((r, i) => r.bb_max == null ? '' : `<rect x="${(i * bw + bw * .2).toFixed(1)}" width="${Math.max(1, bw * .6).toFixed(1)}" y="${y(r.bb_max).toFixed(1)}" height="${Math.max(1.5, y(r.bb_min ?? r.bb_max) - y(r.bb_max)).toFixed(1)}" fill="${o.cor}" opacity=".85"/>`).join('');
  } else {
    // linha com buracos onde falta dado; pontos isolados viram bolinha
    const seg = []; let cur = [];
    vals.forEach((v, i) => { if (v == null) { if (cur.length) seg.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
    if (cur.length) seg.push(cur);
    marks = seg.map(s => s.length > 1
      ? `<polyline points="${s.map(p => p.map(c => c.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${o.cor}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`
      : `<circle cx="${s[0][0]}" cy="${s[0][1]}" r="3" fill="${o.cor}"/>`).join('');
  }
  const m = media(ok);
  // Duas linhas de grade com o valor, para dar escala sem eixo
  const ticks = o.tipo === 'linha' ? [lo + (hi - lo) * .25, lo + (hi - lo) * .75] : o.tipo === 'faixa' ? [25, 75] : [hi / 1.08 * .5, hi / 1.08];
  const tickFmt = o.tipo === 'pilha' ? v => Math.round(v / 3600) + ' h' : o.tipo === 'faixa' ? n0 : v => n0(v);
  const grade = ticks.map(v => `<line class="lc-grid" x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join('');
  const ref = o.alvo ? `<line class="sd-alvo" x1="0" x2="${W}" y1="${y(o.alvo)}" y2="${y(o.alvo)}" vector-effect="non-scaling-stroke"/>` : '';
  const fmt = o.tipo === 'pilha' ? hm : o.tipo === 'faixa' ? n0 : o.fmt;
  CFG[id] = { linhas, o, W, bw, fmt };
  const legenda = o.tipo === 'pilha' ? `<div class="sd-leg"><span><i class="sd-fp"></i>Profundo</span><span><i class="sd-fr"></i>REM</span><span><i class="sd-fl"></i>Leve</span><span><i class="sd-ka"></i>7 h</span></div>`
    : o.alvo && o.campo === 'passos' ? `<div class="sd-leg"><span><i class="sd-ka"></i>Meta ${n0(o.alvo)}</span></div>` : '';
  return `<section class="sd-card">
    <h3>${titulo} <span class="muted small">${o.unidade ? h(o.unidade) + ' · ' : ''}média ${fmt(m)}</span></h3>
    ${legenda}
    <div class="sd-box">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="sd-svg" role="img" aria-label="${h(titulo)}: média ${h(fmt(m))} de ${fmtDate(linhas[0].dia)} a ${fmtDate(linhas.at(-1).dia)}">
        <line class="sd-base" x1="0" x2="${W}" y1="${H - B}" y2="${H - B}" vector-effect="non-scaling-stroke"/>${grade}${ref}${marks}
        <line class="sd-x" x1="-10" x2="-10" y1="0" y2="${H}" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="lc-ticks sd-ticks">${ticks.map(v => `<span style="top:${(y(v) / H * 100).toFixed(1)}%">${tickFmt(v)}</span>`).join('')}</div>
      <div class="sd-dates"><span>${fmtDate(linhas[0].dia)}</span><span>${linhas.at(-1).dia === today() ? 'hoje' : fmtDate(linhas.at(-1).dia)}</span></div>
      <div class="lc-tip" hidden></div>
      <div class="sd-hit" data-g="${id}"></div>
    </div>
  </section>`;
}

function bindHover(hit) {
  const c = CFG[hit.dataset.g]; if (!c) return;
  const box = hit.parentElement, tip = box.querySelector('.lc-tip'), xl = box.querySelector('.sd-x');
  hit.onpointermove = e => {
    const r = hit.getBoundingClientRect();
    const i = Math.max(0, Math.min(c.linhas.length - 1, Math.floor((e.clientX - r.left) / r.width * c.linhas.length)));
    const d = c.linhas[i], px = i * c.bw + c.bw / 2;
    xl.setAttribute('x1', px); xl.setAttribute('x2', px);
    let txt;
    if (c.o.tipo === 'pilha') txt = d.sono_seg ? [hm(d.sono_seg) + (d.sono_score ? ` · nota ${d.sono_score}` : ''),
      d.sono_profundo_seg != null ? `Profundo ${hm(d.sono_profundo_seg)} · REM ${hm(d.sono_rem_seg)} · Leve ${hm(d.sono_leve_seg)}` : ''] : ['sem dado'];
    else if (c.o.tipo === 'faixa') txt = d.bb_max != null ? [`Máx. ${d.bb_max} · mín. ${d.bb_min ?? '–'}`] : ['sem dado'];
    else txt = d[c.o.campo] != null ? [c.fmt(d[c.o.campo])] : ['sem dado'];
    tip.innerHTML = `<b>${weekdayShort(d.dia)}, ${fmtDate(d.dia)}</b>${txt.filter(Boolean).map(t => `<span>${h(t)}</span>`).join('')}`;
    tip.hidden = false;
    const left = (i + .5) / c.linhas.length * r.width;
    tip.style.left = Math.min(Math.max(left, 80), r.width - 80) + 'px';
  };
  hit.onpointerleave = () => { tip.hidden = true; xl.setAttribute('x1', -10); xl.setAttribute('x2', -10); };
}

// Minutos de atividade por semana + últimas atividades
function atividades(dias) {
  const acts = D.acts.filter(a => a.dia >= dias[0]).sort((a, b) => b.inicio.localeCompare(a.inicio));
  const semanas = [];
  for (let s = addDays(dias[0], -((dow(dias[0]) + 6) % 7)); s <= dias.at(-1); s = addDays(s, 7)) {
    const fim = addDays(s, 6), da = acts.filter(a => a.dia >= s && a.dia <= fim);
    semanas.push({ s, min: da.reduce((t, a) => t + (a.duracao_seg || 0), 0) / 60, n: da.length });
  }
  // Semana fora da curva (ex.: trilha de vários dias) não pode achatar as outras: escala até ~2x o percentil 85
  const ord = semanas.map(w => w.min).sort((a, b) => a - b);
  const p85 = ord[Math.floor(ord.length * .85)] || 0;
  const max = Math.min(Math.max(...ord, 150), Math.max(150, p85 * 2)) * 1.15;
  const meta = 150; // recomendação da OMS: 150 min de atividade moderada por semana
  return `<section class="block sd-acts">
    <h2>Atividades <span class="count">${acts.length} no período</span></h2>
    ${semanas.length > 1 ? `<div class="sd-weeks" role="img" aria-label="Minutos de atividade por semana">
      <span class="sd-wmeta" style="bottom:calc(18px + (100% - 18px) * ${(meta / max).toFixed(3)})" title="150 min por semana (OMS)"><em>150 min</em></span>
      ${semanas.map(w => `<div class="sd-wk" title="Semana de ${fmtDate(w.s)}: ${Math.round(w.min)} min em ${w.n} atividade${w.n === 1 ? '' : 's'}">
        <i style="height:${Math.min(100, w.min / max * 100).toFixed(1)}%" class="${w.min >= meta ? 'ok' : ''} ${w.min > max ? 'cut' : ''}"></i>${w.min > max ? `<b class="sd-wbig">${Math.round(w.min / 60)}h</b>` : ''}${semanas.length <= 14 ? `<span>${fmtDate(w.s)}</span>` : ''}</div>`).join('')}
    </div>` : ''}
    ${acts.length ? `<div class="list">${acts.slice(0, 12).map(a => `<div class="row sd-act">
      <div class="row-main"><b>${h(a.nome || tipoNome(a.tipo))}</b><span class="muted small">${a.nome ? tipoNome(a.tipo) + ' · ' : ''}${weekdayShort(a.dia)}, ${fmtDate(a.dia)}</span></div>
      <span class="sd-act-n">${a.duracao_seg < 3570 ? Math.round(a.duracao_seg / 60) + ' min' : hm(a.duracao_seg)}${a.distancia_m ? ` · ${km(a.distancia_m)}` : ''}${a.fc_media ? ` · ${a.fc_media} bpm` : ''}</span>
    </div>`).join('')}</div>` : '<p class="empty">Nenhuma atividade no período.</p>'}
  </section>`;
}
