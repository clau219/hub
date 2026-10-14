import * as db from './db.js';
import { load, onChange, save } from './store.js';
import { parseCapture, fmtDate, relDate, AREAS } from './util.js';
import { toast, dealForm } from './ui.js';
import * as hoje from './v-hoje.js';
import * as pipeline from './v-pipeline.js';
import * as agenda from './v-agenda.js';
import * as alugueis from './v-alugueis.js';
import * as tarefas from './v-tarefas.js';
import * as contatos from './v-contatos.js';
import * as cripto from './v-cripto.js';
import * as ajustes from './v-ajustes.js';

const VIEWS = { hoje, pipeline, agenda, alugueis, tarefas, contatos, cripto, ajustes };
const $ = s => document.querySelector(s);
const route = () => (location.hash.replace(/^#\//, '') || 'hoje').split('?')[0];

function render() {
  const r = VIEWS[route()] ? route() : 'hoje';
  document.querySelectorAll('.side a[data-route]').forEach(a => a.classList.toggle('on', a.dataset.route === r));
  const el = $('#view');
  const y = window.scrollY;
  VIEWS[r].render(el);
  window.scrollTo(0, y);
}

async function start() {
  await db.init();
  const session = await db.auth.session();
  if (!session) return showLogin();
  $('#app').hidden = false;
  $('#localBanner').hidden = db.mode !== 'local';
  onChange(render);
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  await load();

  // Captura rápida
  $('#capture').onsubmit = async ev => {
    ev.preventDefault();
    const inp = $('#captureInput');
    if (!inp.value.trim()) return;
    const t = parseCapture(inp.value);
    if (!t.titulo) return;
    await save('tasks', t);
    inp.value = '';
    toast(`Anotado${t.prazo ? ' para ' + relDate(t.prazo) : ' na caixa de entrada'}${t.area !== 'inbox' ? ` (${AREAS[t.area].nome})` : ''}`);
  };
  $('#newDeal').onclick = () => dealForm();

  // Atalhos: "/" foca a captura, "n" nova oportunidade
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, dialog[open]')) return;
    if (e.key === '/') { e.preventDefault(); $('#captureInput').focus(); }
    if (e.key === 'n') { e.preventDefault(); dealForm(); }
  });

  // Relógio + recarrega ao voltar para a aba e a cada 5 min
  const tick = () => ($('#clock').textContent = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date()));
  tick(); setInterval(tick, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#modal').open) load(); });
  setInterval(() => { if (!document.hidden && !$('#modal').open) load(); }, 5 * 60 * 1000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function showLogin() {
  $('#login').hidden = false;
  $('#loginForm').onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try { await db.auth.signIn(f.get('email'), f.get('password')); location.reload(); }
    catch (e) { $('#loginErr').textContent = 'E-mail ou senha incorretos.'; }
  };
}

start().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin', `<p class="banner">Erro ao iniciar: ${e.message}</p>`);
});
