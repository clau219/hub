// Navegador falso (happy-dom) com o corpo do index.html real do Hub, para testar as telas sem abrir o site.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { readFileSync } from 'node:fs';
import { bloquearRede } from './rede.js';

export const RAIZ = new URL('../../', import.meta.url); // pasta hub/
export const hub = caminho => import(new URL(caminho, RAIZ).href);

export function montarDom({ hash = '', largura = 1280 } = {}) {
  const DataFixa = globalThis.Date;
  GlobalRegistrator.register({ url: 'https://clau219.github.io/hub/' + hash, width: largura, height: 900 });
  globalThis.Date = DataFixa; // o relógio parado continua valendo
  window.Date = DataFixa;
  bloquearRede(); // o happy-dom traz fetch próprio: volta o falso
  window.fetch = globalThis.fetch;
  const html = readFileSync(new URL('index.html', RAIZ), 'utf8');
  const sem = t => t.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
  document.head.innerHTML = sem(html.match(/<head>([\s\S]*)<\/head>/)[1]); // metas (theme-color) sem CSS/fontes externas
  document.body.innerHTML = sem(html.match(/<body>([\s\S]*)<\/body>/)[1]);
  corrigirSelect();
  window.scrollTo = () => {};
  if (!navigator.clipboard?.writeText) Object.defineProperty(navigator, 'clipboard', { value: { texto: '', async writeText(t) { this.texto = t; } }, configurable: true });
  window.alert = msg => (window.__alertas ||= []).push(msg);
  window.confirm = () => true;
  return document;
}

// Bug do happy-dom 21: ao montar HTML com <option selected>, o select fica com a opção ANTERIOR escolhida.
// Depois de innerHTML/insertAdjacentHTML, aplica a regra do navegador (vale a última opção marcada).
function corrigirSelect() {
  const arrumar = raiz => raiz.querySelectorAll?.('select:not([multiple])').forEach(s => {
    const marcadas = [...s.options].filter(o => o.hasAttribute('selected'));
    if (marcadas.length) s.selectedIndex = marcadas.at(-1).index;
  });
  let p = Object.getPrototypeOf(document.createElement('div'));
  while (p && !Object.getOwnPropertyDescriptor(p, 'innerHTML')) p = Object.getPrototypeOf(p);
  const d = Object.getOwnPropertyDescriptor(p, 'innerHTML');
  Object.defineProperty(p, 'innerHTML', { ...d, set(v) { d.set.call(this, v); arrumar(this); } });
  const ins = p.insertAdjacentHTML || Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (pos, html) { ins.call(this, pos, html); arrumar(this.parentNode || this); };
}

// Deixa as promessas e timers curtos rodarem (renderizações assíncronas, load() depois de save()).
export async function esperar(vezes = 5) {
  for (let i = 0; i < vezes; i++) await new Promise(r => setTimeout(r, 0));
}
// Espera até a condição valer (para telas que carregam dados do Supabase em segundo plano)
export async function ate(cond, { ms = 2000, msg = 'condição não aconteceu' } = {}) {
  const fim = performance.now() + ms;
  while (performance.now() < fim) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`Tempo esgotado: ${msg}`);
}
export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];
export const texto = el => (typeof el === 'string' ? $(el) : el)?.textContent.replace(/\s+/g, ' ').trim() ?? '';

// Preenche campos de um formulário pelo name e envia com o botão "ok" do modal
export function preencher(raiz, campos) {
  for (const [nome, v] of Object.entries(campos)) {
    const el = raiz.querySelector(`[name="${nome}"]`);
    if (!el) throw new Error(`campo ${nome} não existe no formulário`);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') raiz.querySelector(`[name="${nome}"][value="${v}"]`).checked = true;
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
export async function enviarModal() {
  const form = $('#modalForm');
  const ok = form.querySelector('button[value=ok]');
  if (!ok) throw new Error('modal sem botão de salvar');
  const ev = new Event('submit', { bubbles: true, cancelable: true });
  ev.submitter = ok;
  form.dispatchEvent(ev);
  await esperar(10);
}
export const clicar = async (el, vezes = 5) => {
  el = typeof el === 'string' ? $(el) : el;
  if (!el) throw new Error('elemento para clicar não existe');
  el.click();
  await esperar(vezes);
};
// Texto como o navegador mostraria: pedaços de elementos diferentes separados por espaço
export const textoSep = el => {
  el = typeof el === 'string' ? $(el) : el;
  if (!el) return '';
  const w = document.createTreeWalker(el, 4 /* SHOW_TEXT */);
  const partes = [];
  while (w.nextNode()) partes.push(w.currentNode.nodeValue);
  return partes.join(' ').replace(/\s+/g, ' ').trim();
};
