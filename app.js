import * as db from './db.js';
import { load, onChange, save, meta, atencao, S } from './store.js';
import { parseCapture, fmtDate, relDate, AREAS, hhmm } from './util.js';
import { toast, dealForm, bookingForm, taskForm } from './ui.js';
import * as hoje from './v-hoje.js';
import * as pipeline from './v-pipeline.js';
import * as agenda from './v-agenda.js';
import * as alugueis from './v-alugueis.js';
import * as tarefas from './v-tarefas.js';
import * as contatos from './v-contatos.js';
import * as cripto from './v-cripto.js';
import * as saude from './v-saude.js';
import * as ajustes from './v-ajustes.js';
import * as paleta from './palette.js';

const VIEWS = { hoje, pipeline, agenda, alugueis, tarefas, contatos, cripto, saude, ajustes };
const $ = s => document.querySelector(s);
const route = () => (location.hash.replace(/^#\//, '') || 'hoje').split('?')[0];
const NO_MAIS = ['alugueis', 'tarefas', 'contatos', 'cripto', 'saude', 'ajustes'];

function render() {
  const r = VIEWS[route()] ? route() : 'hoje';
  document.querySelectorAll('a[data-route]').forEach(a => a.classList.toggle('on', a.dataset.route === r));
  $('#moreBtn').classList.toggle('on', NO_MAIS.includes(r));
  syncBanner();
  try { navigator.setAppBadge?.(atencao().length).catch(() => {}); } catch {}
  const el = $('#view');
  el.onclick = null; // o #view é compartilhado: o clique da tela anterior (Hoje) não pode valer na próxima
  const y = window.scrollY;
  VIEWS[r].render(el);
  window.scrollTo(0, y);
}

async function start() {
  await db.init();
  const session = await db.auth.session();
  if (!session) {
    // Sem internet e com o token vencido (dura 1 h), a biblioteca não renova a sessão: em vez do login,
    // abre a cópia guardada só para leitura e recarrega quando a conexão voltar
    let copia = null; try { copia = localStorage.getItem('hub:snap'); } catch {}
    if (!db.auth.semRede || !copia) return showLogin();
    db.modoLeitura();
    window.addEventListener('online', () => location.reload(), { once: true });
  }
  $('#app').hidden = false;
  $('#localBanner').hidden = db.mode !== 'local';
  onChange(render);
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  await load();

  // Captura rápida (barra do topo no computador, folha "+" no celular)
  const capturar = (form, inp) => {
    form.onsubmit = async ev => {
      ev.preventDefault();
      if (!inp.value.trim()) return;
      const t = parseCapture(inp.value);
      if (t.tipo === 'deal') {
        // "+dj Ana Souza casamento 12/12": abre a oportunidade preenchida para conferir
        inp.value = '';
        form.closest('dialog')?.close();
        // Nome do contato como palavras inteiras no início ("Ana" não casa com "Anabela")
        const tx = t.texto.toLowerCase() + ' ';
        const c = S.contacts.filter(c => c.nome && tx.startsWith(c.nome.toLowerCase().trim() + ' ')).sort((a, b) => b.nome.length - a.nome.length)[0];
        const resto = c ? t.texto.slice(c.nome.length).trim() : t.texto;
        return dealForm({}, { negocio: t.negocio, data_evento: t.data_evento, contato_id: c?.id, _contato: c ? '' : t.texto, notas: resto });
      }
      if (!t.titulo) return;
      await save('tasks', t);
      inp.value = '';
      form.closest('dialog')?.close();
      toast(`Anotado${t.prazo ? ' para ' + relDate(t.prazo) : ' na caixa de entrada'}${t.area !== 'inbox' ? ` (${AREAS[t.area].nome})` : ''}`);
    };
  };
  capturar($('#capture'), $('#captureInput'));
  capturar($('#capture2'), $('#captureInput2'));
  $('#newDeal').onclick = () => dealForm();
  tema();
  paleta.iniciar();
  $('#searchBtn').onclick = () => paleta.abrir();
  document.querySelector('[data-buscar]').onclick = e => { e.preventDefault(); $('#sheetMore').close(); paleta.abrir(); };

  // Folhas do celular: tocar fora fecha; escolher um link ou botão também
  for (const sh of [$('#sheetAdd'), $('#sheetMore')]) {
    sh.addEventListener('click', e => { if (e.target === sh || e.target.closest('a')) sh.close(); });
  }
  $('#fab').onclick = () => { $('#sheetAdd').showModal(); setTimeout(() => $('#captureInput2').focus(), 50); };
  $('#moreBtn').onclick = () => $('#sheetMore').showModal();
  $('#sheetAdd').querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    $('#sheetAdd').close();
    ({ deal: () => dealForm(), reserva: () => bookingForm(), tarefa: () => taskForm({ area: 'inbox' }) })[b.dataset.add]();
  });
  $('#syncBanner').onclick = e => { if (e.target.closest('[data-reload]')) load(); };

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
  window.addEventListener('online', () => load());
  setInterval(() => { if (!document.hidden && !$('#modal').open) load(); }, 5 * 60 * 1000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Tema: automático (segue o sistema) → claro → escuro. Vale só neste aparelho.
const TEMAS = [['', 'auto', 'Tema automático'], ['light', 'claro', 'Tema claro'], ['dark', 'escuro', 'Tema escuro']];
function tema() {
  const b = $('#themeBtn');
  const pintar = () => {
    const t = TEMAS.find(x => x[0] === (document.documentElement.dataset.theme || '')) || TEMAS[0];
    b.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#i-${t[1]}"/></svg>`;
    b.title = `${t[2]} (clique para trocar)`; b.setAttribute('aria-label', b.title);
    const escuro = t[0] === 'dark' || (!t[0] && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name=theme-color]').content = escuro ? '#0a1113' : '#f4f6f5';
  };
  b.onclick = () => {
    const i = TEMAS.findIndex(x => x[0] === (document.documentElement.dataset.theme || ''));
    const prox = TEMAS[(i + 1) % TEMAS.length][0];
    if (prox) document.documentElement.dataset.theme = prox; else delete document.documentElement.dataset.theme;
    try { prox ? localStorage.setItem('hub:tema', prox) : localStorage.removeItem('hub:tema'); } catch {}
    pintar();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', pintar);
  pintar();
}

// Faixa de aviso: sem conexão (dados guardados) ou falha parcial na leitura
function syncBanner() {
  const b = $('#syncBanner');
  if (db.leitura) {
    b.innerHTML = `Sem conexão: modo leitura, com os dados de ${meta.at ? `${fmtDate(meta.at.slice(0, 10))}, ${hhmm(meta.at)}` : 'antes'}. Nada pode ser alterado; o Hub recarrega sozinho quando a internet voltar.`;
  } else if (meta.offline) {
    b.innerHTML = meta.at
      ? `Sem conexão. Mostrando os dados de ${fmtDate(meta.at.slice(0, 10))}, ${hhmm(meta.at)}: o que mudou depois não aparece. <button class="link-btn" data-reload>Tentar de novo</button>`
      : `Sem conexão e sem dados guardados neste aparelho. <button class="link-btn" data-reload>Tentar de novo</button>`;
  } else if (meta.erro) {
    b.innerHTML = `${meta.erro}. O que depende disso pode estar incompleto. <button class="link-btn" data-reload>Tentar de novo</button>`;
  }
  b.hidden = !db.leitura && !meta.offline && !meta.erro;
}

// Gravação que falhou fora de um formulário (concluir, adiar…) não pode passar em silêncio
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  toast(navigator.onLine === false ? 'Sem conexão: a alteração não foi salva.' : 'Não foi possível salvar: ' + (e.reason?.message || 'erro'), 5000);
});

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
