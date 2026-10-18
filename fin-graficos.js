// Gráficos da aba Finanças em SVG puro (o Hub não usa biblioteca de gráficos).
// Cada gráfico é registrado com slot() durante o render e desenhado por montar() já na largura real
// do contêiner, para o texto não encolher no celular. Redesenha sozinho quando a janela muda de tamanho.
// Dica (tooltip): qualquer elemento com data-tip; mouse, toque e foco do teclado.
import { h } from './util.js';

const fila = new Map();
let seq = 0;
export function limpar() { fila.clear(); }
// Reserva o lugar do gráfico; desenhar(largura) devolve o SVG/HTML
export function slot(desenhar, cls = '') {
  const id = 'g' + (++seq);
  fila.set(id, desenhar);
  return `<div class="fg ${cls}" data-graf="${id}"></div>`;
}
export function montar(root) {
  root.querySelectorAll('[data-graf]').forEach(el => {
    const f = fila.get(el.dataset.graf);
    if (f) el.innerHTML = f(Math.max(240, Math.floor(el.clientWidth || 320)));
  });
  dicas(root);
}
let tm = null, ultimoRoot = null;
window.addEventListener('resize', () => { clearTimeout(tm); tm = setTimeout(() => ultimoRoot?.isConnected && montar(ultimoRoot), 150); });

// ---------- Dica ----------
let tipEl = null;
function tip() {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'fg-tip'; tipEl.setAttribute('role', 'tooltip'); document.body.appendChild(tipEl); }
  return tipEl;
}
function mostrar(alvo, x, y) {
  const t = tip(); t.innerHTML = alvo.dataset.tip; t.classList.add('on');
  const r = t.getBoundingClientRect(), m = 10;
  t.style.left = Math.min(window.innerWidth - r.width - m, Math.max(m, x - r.width / 2)) + 'px';
  t.style.top = (y - r.height - 14 < m ? y + 18 : y - r.height - 14) + 'px';
}
const esconder = () => tipEl?.classList.remove('on');
function dicas(root) {
  ultimoRoot = root;
  if (root._fgDicas) return;
  root._fgDicas = true;
  root.addEventListener('pointermove', e => { const a = e.target.closest?.('[data-tip]'); if (a && root.contains(a)) mostrar(a, e.clientX, e.clientY); else esconder(); });
  root.addEventListener('pointerleave', esconder);
  root.addEventListener('focusin', e => { const a = e.target.closest?.('[data-tip]'); if (a) { const r = a.getBoundingClientRect(); mostrar(a, r.left + r.width / 2, r.top); } });
  root.addEventListener('focusout', esconder);
  document.addEventListener('scroll', esconder, { passive: true });
}
// Texto da dica: título + linhas [rótulo, valor]
export const tipTxt = (titulo, linhas = []) => h(`<b>${h(titulo)}</b>${linhas.map(([k, v]) => `<span>${h(k)}<em>${h(v)}</em></span>`).join('')}`);

// ---------- Escalas ----------
function escala(min, max, passos = 4) {
  if (min === max) { max = min + 1; min = Math.min(0, min); }
  const bruto = (max - min) / passos, mag = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= bruto);
  const ini = Math.floor(min / passo) * passo, fim = Math.ceil(max / passo) * passo;
  const ticks = []; for (let v = ini; v <= fim + passo / 2; v += passo) ticks.push(+v.toFixed(10));
  return { ini, fim, ticks };
}
// Margem esquerda pelo maior rótulo do eixo (12px ≈ 7px por caractere)
const margemEixo = (ticks, fmt) => Math.max(...ticks.map(t => String(fmt(t)).length)) * 7 + 14;
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const diaCurto = iso => `${+iso.slice(8, 10)} ${MESES[+iso.slice(5, 7) - 1]}${iso.slice(0, 4) !== String(new Date().getFullYear()) ? ' ' + iso.slice(2, 4) : ''}`;
// Barra com cantos de 4px só na ponta (topo se positiva), base reta no eixo
function barraV(x, y0, w, y1, r = 4) {
  const top = Math.min(y0, y1), alt = Math.abs(y1 - y0); r = Math.min(r, w / 2, alt);
  if (alt < 0.5) return '';
  return y1 <= y0
    ? `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${y0}Z`
    : `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

// ---------- Rosca de alocação ----------
// fatias [{id, nome, valor, peso, cor}], sel = id destacado; clique nas fatias via data-fatia
export function rosca(fatias, { sel = '', centro = '', sub = '' } = {}) {
  return w => {
    const S = Math.min(w, 260), R = S / 2 - 4, r = R * 0.62, cx = S / 2, cy = S / 2;
    const tot = fatias.reduce((t, f) => t + f.valor, 0) || 1;
    let ang = -Math.PI / 2;
    const arcos = fatias.map(f => {
      const a0 = ang, a1 = ang + f.valor / tot * Math.PI * 2; ang = a1;
      const grande = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, a) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
      const d = fatias.length === 1
        ? `M${cx - R},${cy}A${R},${R} 0 1 1 ${cx + R},${cy}A${R},${R} 0 1 1 ${cx - R},${cy}M${cx - r},${cy}A${r},${r} 0 1 0 ${cx + r},${cy}A${r},${r} 0 1 0 ${cx - r},${cy}Z`
        : `M${p(R, a0)}A${R},${R} 0 ${grande} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${grande} 0 ${p(r, a0)}Z`;
      return `<path d="${d}" fill="${f.cor}" fill-rule="evenodd" class="fg-fatia ${sel && sel !== f.id ? 'apagada' : ''} ${sel === f.id ? 'sel' : ''}" data-fatia="${h(f.id)}"
        data-tip="${f.tip}" tabindex="0" role="button" aria-label="${h(f.nome)}: ${f.peso.toFixed(1)}%"/>`;
    }).join('');
    return `<svg class="fg-rosca" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" role="img" aria-label="Alocação por classe">${arcos}
      <text x="${cx}" y="${cy - 2}" class="fg-centro">${h(centro)}</text><text x="${cx}" y="${cy + 18}" class="fg-centro-sub">${h(sub)}</text></svg>`;
  };
}

// ---------- Área (evolução) ----------
// pts [{dia, valor}]; fmt: formata o eixo/tooltip; cor da série
export function area(pts, { fmt, fmtEixo = fmt, cor = 'var(--cl-rf)', alt = 230, rotulo = 'Patrimônio' } = {}) {
  return w => {
    if (!pts.length) return '';
    const vals = pts.map(p => p.valor), mn = Math.min(...vals), mx = Math.max(...vals);
    const pad = (mx - mn) * 0.08 || Math.abs(mx) * 0.05 || 1;
    const e = escala(mn - pad, mx + pad, 4);
    const m = { t: 12, r: 12, b: 26, l: margemEixo(e.ticks, fmtEixo) }, W = w, H = alt, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const X = i => m.l + (pts.length === 1 ? iw / 2 : i / (pts.length - 1) * iw);
    const Y = v => m.t + ih - (v - e.ini) / (e.fim - e.ini) * ih;
    const linha = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.valor).toFixed(1)}`).join('');
    const base = Y(Math.max(e.ini, Math.min(0, e.fim)));
    const grade = e.ticks.map(t => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}" class="fg-grade"/><text x="${m.l - 8}" y="${Y(t) + 4}" class="fg-eixo" text-anchor="end">${h(fmtEixo(t))}</text>`).join('');
    const nx = Math.min(pts.length, Math.max(2, Math.floor(iw / 90)));
    const xs = [...new Set(Array.from({ length: nx }, (_, k) => Math.round(k * (pts.length - 1) / Math.max(1, nx - 1))))];
    const rotX = xs.map(i => `<text x="${X(i)}" y="${H - 6}" class="fg-eixo" text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}">${diaCurto(pts[i].dia)}</text>`).join('');
    const faixa = pts.length > 1 ? iw / (pts.length - 1) : iw;
    const alvos = pts.map((p, i) => `<g class="fg-pt"><rect x="${X(i) - faixa / 2}" y="${m.t}" width="${faixa}" height="${ih}" fill="transparent"
        data-tip="${p.tip || tipTxt(diaCurto(p.dia), [[rotulo, fmt(p.valor)]])}"/>
      <line x1="${X(i)}" x2="${X(i)}" y1="${m.t}" y2="${m.t + ih}" class="fg-cruz"/><circle cx="${X(i)}" cy="${Y(p.valor)}" r="4.5" fill="${cor}" class="fg-ponto"/></g>`).join('');
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(rotulo)} ao longo do tempo">
      ${grade}<path d="${linha}L${X(pts.length - 1)},${base}L${X(0)},${base}Z" fill="${cor}" opacity=".12"/>
      <path d="${linha}" fill="none" stroke="${cor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.length === 1 ? `<circle cx="${X(0)}" cy="${Y(pts[0].valor)}" r="5" fill="${cor}"/>` : ''}${rotX}${alvos}</svg>`;
  };
}

// ---------- Colunas (proventos por mês) ----------
// itens [{rot, valor, tip}]
export function colunas(itens, { fmtEixo, cor = 'var(--cl-rf)', alt = 210, rotulo = '' } = {}) {
  return w => {
    const e = escala(0, Math.max(1, ...itens.map(i => i.valor)), 3);
    const m = { t: 12, r: 8, b: 24, l: margemEixo(e.ticks, fmtEixo) }, W = w, H = alt, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const Y = v => m.t + ih - (v - e.ini) / (e.fim - e.ini) * ih;
    const passo = iw / itens.length, bw = Math.max(6, Math.min(36, passo - 6));
    const grade = e.ticks.map(t => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}" class="fg-grade"/><text x="${m.l - 8}" y="${Y(t) + 4}" class="fg-eixo" text-anchor="end">${h(fmtEixo(t))}</text>`).join('');
    const pula = passo < 30 ? 2 : 1;
    const barras = itens.map((it, k) => {
      const x = m.l + k * passo + (passo - bw) / 2;
      return `<g><rect x="${m.l + k * passo}" y="${m.t}" width="${passo}" height="${ih}" fill="transparent" data-tip="${it.tip}"/>
        <path d="${barraV(x, Y(0), bw, Y(it.valor))}" fill="${cor}" class="fg-barra" pointer-events="none"/>
        ${k % pula === 0 || k === itens.length - 1 ? `<text x="${x + bw / 2}" y="${H - 6}" class="fg-eixo" text-anchor="middle">${h(it.rot)}</text>` : ''}</g>`;
    }).join('');
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(rotulo)}">${grade}${barras}</svg>`;
  };
}

// ---------- Barras horizontais (ranking, comparação) ----------
// itens [{nome, valor, txt, cor, tip, id}]; diverge = eixo no zero (valores negativos à esquerda)
export function barrasH(itens, { diverge = false, attr = '' } = {}) {
  if (!itens.length) return '';
  const max = Math.max(...itens.map(i => Math.abs(i.valor)), 1e-9);
  const neg = diverge && itens.some(i => i.valor < 0);
  return `<div class="fg-hb ${neg ? 'diverge' : ''}">${itens.map(i => {
    const w = Math.abs(i.valor) / max * (neg ? 50 : 100);
    const pos = neg ? (i.valor < 0 ? `right:50%` : `left:50%`) : 'left:0';
    return `<div class="fg-hb-l" data-tip="${i.tip || ''}" ${i.id ? `${attr}="${h(i.id)}" tabindex="0" role="button"` : ''}>
      <span class="fg-hb-n">${h(i.nome)}</span>
      <span class="fg-hb-t"><i style="${pos};width:${Math.max(w, 1.5)}%;background:${i.cor}" class="${i.valor < 0 ? 'neg' : ''}"></i></span>
      <b>${h(i.txt)}</b></div>`;
  }).join('')}</div>`;
}

// ---------- Linha do tempo de vencimentos (próximos 12 meses) ----------
// itens [{dia, valor, cor, tip, id}]
export function linhaTempo(itens, hoje, meses = 12) {
  return w => {
    const m = { l: 14, r: 14 }, W = w, iw = W - m.l - m.r;
    const ini = Date.parse(hoje + 'T12:00:00Z'), fim = ini + meses * 30.44 * 864e5;
    const X = d => m.l + (Date.parse(d + 'T12:00:00Z') - ini) / (fim - ini) * iw;
    const max = Math.max(...itens.map(i => i.valor), 1);
    // Pontos próximos empilham para cima em vez de se sobrepor
    const usados = [];
    const pts = itens.map(i => {
      const x = X(i.dia), rr = 6 + Math.sqrt(i.valor / max) * 10;
      let nivel = 0; while (usados.some(u => u.nivel === nivel && Math.abs(u.x - x) < u.r + rr + 2)) nivel++;
      usados.push({ x, r: rr, nivel });
      return { ...i, x, rr, nivel };
    });
    const niveis = Math.max(0, ...pts.map(p => p.nivel)) + 1;
    const H = 46 + niveis * 34, eixo = H - 30;
    const marcas = Array.from({ length: meses + 1 }, (_, k) => {
      const d = new Date(ini); d.setUTCMonth(d.getUTCMonth() + k, 1);
      const iso = d.toISOString().slice(0, 10); const x = X(iso);
      if (x < m.l || x > W - m.r) return '';
      const mostra = iw / meses > 34 || k % 2 === 0;
      return `<line x1="${x}" x2="${x}" y1="${eixo - 4}" y2="${eixo + 4}" class="fg-grade"/>${mostra ? `<text x="${x}" y="${H - 8}" class="fg-eixo" text-anchor="middle">${MESES[d.getUTCMonth()]}</text>` : ''}`;
    }).join('');
    const bolas = pts.map(p => `<circle cx="${p.x}" cy="${eixo - 16 - p.nivel * 34}" r="${p.rr}" fill="${p.cor}" stroke="var(--surface)" stroke-width="2"
      class="fg-bola" data-tip="${p.tip}" ${p.id ? `data-ativo="${h(p.id)}" tabindex="0" role="button"` : ''}/>`).join('');
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Vencimentos nos próximos ${meses} meses">
      <line x1="${m.l}" x2="${W - m.r}" y1="${eixo}" y2="${eixo}" class="fg-eixo-l"/>${marcas}${bolas}</svg>`;
  };
}
