// WhatsApp PESSOAL (só leitura): o leitor (A:\Usuário\HUB\wa-leitor) guarda as conversas pela função wp-ingest e a
// wp-resumo faz a varredura às 7h e às 21h: resumo por categoria + o que você está deixando passar (wp_alertas).
// Aqui: conectar (QR code), alertas (feito / ignorar / virar tarefa), resumos anteriores e a escolha de quais
// grupos acompanhar e quais conversas ficam fora do resumo. Lê direto do Supabase.
import * as db from './db.js';
import { h, today, localDate, hhmm, fmtDate } from './util.js';
import { taskForm, toast } from './ui.js';

export const CATEGORIAS = {
  dj: ['DJ', 'var(--dj)'], alugueis: ['Aluguéis', 'var(--alug)'], argila: ['Argila Lab', 'var(--argila)'], engenharia: ['Engenharia', 'var(--eng)'],
  dinheiro: ['Dinheiro', 'var(--wa)'], familia_amigos: ['Família e amigos', 'var(--casa)'], compras_servicos: ['Compras e serviços', 'var(--muted)'],
  grupos: ['Grupos', 'var(--brand)'], outros: ['Outros', 'var(--muted)'],
};
export const TIPOS = {
  sem_resposta: 'Sem resposta', promessa_sua: 'Você prometeu', pedido_para_voce: 'Pediram a você', prazo: 'Prazo',
  dinheiro: 'Dinheiro', compromisso: 'Compromisso', outro: 'Atenção',
};
const URG = { alta: 0, media: 1, baixa: 2 };
const ATUALIZA = 30e3;
const PARADO_MIN = 30;

let D = { status: null, alertas: [], feitos: [], resumos: [], chats: [], at: 0, erro: '' };
let aba = 'resumo';
let resumoSel = null;   // id do resumo aberto (null = o mais recente)
let busca = '';
let viewEl = null, timer = null, carregando = false, gerando = false;
const naTela = () => location.hash.startsWith('#/pessoal');

async function carregar() {
  if (carregando || db.mode !== 'supabase') return;
  carregando = true;
  try {
    const sb = db.client();
    const desde = new Date(Date.now() - 7 * 864e5).toISOString();
    const [st, al, fe, rs, ch] = await Promise.all([
      sb.from('app_config').select('value').eq('key', 'wp_status').maybeSingle(),
      sb.from('wp_alertas').select('*').eq('status', 'aberto').order('criado_em', { ascending: false }).limit(200),
      sb.from('wp_alertas').select('*').neq('status', 'aberto').gte('resolvido_em', desde).order('resolvido_em', { ascending: false }).limit(50),
      sb.from('wp_resumos').select('id,periodo,de,ate,conteudo,mensagens,modelo,criado_em').order('criado_em', { ascending: false }).limit(14),
      sb.from('wp_chats').select('*').order('ultima_msg_em', { ascending: false, nullsFirst: false }).limit(2000),
    ]);
    const erro = al.error || fe.error || rs.error || ch.error || st.error;
    if (erro) throw erro;
    let status = null; try { status = st.data?.value ? JSON.parse(st.data.value) : null; } catch { /* ilegível */ }
    D = { status, alertas: al.data || [], feitos: fe.data || [], resumos: rs.data || [], chats: ch.data || [], at: Date.now(), erro: '' };
    pintarSelo(D.alertas.length);
  } catch (e) {
    D.erro = e.message || 'erro';
  } finally {
    carregando = false;
    if (naTela() && viewEl) desenhar(viewEl);
  }
}

export function render(el) {
  viewEl = el;
  if (db.mode !== 'supabase') { el.innerHTML = '<div class="view-head"><h1>WhatsApp pessoal</h1></div><p class="empty">O WhatsApp pessoal só aparece com o Supabase configurado.</p>'; return; }
  desenhar(el);
  if (!D.at || Date.now() - D.at > ATUALIZA) carregar();
  if (!timer) timer = setInterval(() => {
    if (!naTela()) { clearInterval(timer); timer = null; return; }
    // Esperando a leitura do QR: relê rápido para o código novo e a conexão aparecerem logo
    if (!document.hidden && (D.status?.estado === 'qr' || Date.now() - D.at > ATUALIZA)) carregar();
  }, 5e3);
}

// ---------- tela ----------
function desenhar(el) {
  const y = window.scrollY;
  el.innerHTML = `
  <div class="view-head">
    <h1>WhatsApp pessoal</h1>
    ${chipStatus()}
    <button class="btn" id="wpGerar" ${gerando ? 'disabled' : ''} title="Faz a varredura agora (além das automáticas às 7h e 21h)">${gerando ? 'Lendo as conversas…' : 'Gerar resumo agora'}</button>
  </div>
  ${D.erro ? `<p class="banner warn">Não foi possível ler os dados: ${h(D.erro)}.</p>` : ''}
  ${conexao()}
  <div class="seg wp-abas">
    <button class="${aba === 'resumo' ? 'on' : ''}" data-aba="resumo">Resumo e alertas <span class="count">${D.alertas.length || ''}</span></button>
    <button class="${aba === 'conversas' ? 'on' : ''}" data-aba="conversas">Conversas e grupos</button>
  </div>
  ${!D.at && !D.erro ? '<p class="muted small">Carregando…</p>' : aba === 'resumo' ? telaResumo() : telaConversas()}`;
  window.scrollTo(0, y);
  ligar(el);
}

function chipStatus() {
  const s = D.status;
  if (!s) return '<span class="muted small wp-st">● leitor não ligado</span>';
  const parado = Date.now() - Date.parse(s.em) > PARADO_MIN * 60e3;
  if (s.estado === 'conectado' && !parado) return `<span class="small wp-st ok" title="O leitor dá sinal a cada 5 min">● Conectado${s.numero ? ' · ' + h(fone(s.numero)) : ''}</span>`;
  if (s.estado === 'qr') return '<span class="small wp-st alerta">● Esperando o QR code</span>';
  return `<span class="small wp-st alerta">● ${s.estado === 'conectado' ? 'Sem sinal do leitor' : 'Desconectado'} desde ${quando(s.estado === 'conectado' ? s.em : s.desde)}</span>`;
}

function conexao() {
  const s = D.status;
  if (s?.estado === 'conectado' && Date.now() - Date.parse(s.em) <= PARADO_MIN * 60e3) return '';
  if (s?.estado === 'qr' && s.qr && Date.now() - Date.parse(s.em) < 3 * 60e3) {
    return `<section class="wp-qr">
      <img src="${h(s.qr)}" alt="QR code para conectar o WhatsApp" width="240" height="240">
      <div>
        <h2>Conectar seu WhatsApp</h2>
        <ol>
          <li>No celular, abra o WhatsApp → <b>Configurações</b> (ou ⋮) → <b>Aparelhos conectados</b>.</li>
          <li>Toque em <b>Conectar um aparelho</b> e aponte a câmera para este código.</li>
          <li>Pronto: aparece “Hub (só leitura)” na lista. O Hub só lê; nunca envia nada nem marca como lida.</li>
        </ol>
        <p class="muted small">O código muda a cada 20 segundos; esta tela acompanha sozinha.</p>
      </div>
    </section>`;
  }
  if (!s) return `<p class="banner">O leitor do WhatsApp ainda não está rodando, então nenhuma conversa chega aqui. Quando ele for ligado (máquina gratuita do Google Cloud, guia em <code>A:\\Usuário\\HUB\\GUIA-WHATSAPP-PESSOAL.md</code>), o QR code para conectar aparece nesta tela.</p>`;
  if (s.estado === 'desconectado' || s.estado === 'qr') return `<p class="banner warn"><b>WhatsApp pessoal desconectado.</b> ${h(s.motivo || 'O QR code expirou.')} O leitor gera um código novo sozinho; ele aparece aqui em alguns segundos.</p>`;
  return `<p class="banner warn"><b>O leitor não dá sinal desde ${quando(s.em)}.</b> As mensagens novas não estão chegando ao Hub (o WhatsApp guarda e entrega quando ele voltar). Confira se a máquina do Google Cloud está ligada.</p>`;
}

// ---------- resumo e alertas ----------
function telaResumo() {
  const alertas = [...D.alertas].sort((a, b) => (URG[a.urgencia] ?? 1) - (URG[b.urgencia] ?? 1) || b.criado_em.localeCompare(a.criado_em));
  const r = D.resumos.find(x => x.id === resumoSel) || D.resumos[0];
  return `
  <div class="cols wp-cols">
    <section>
      <div class="block ${alertas.length ? 'warn' : ''}">
        <h2>Não deixe passar <span class="count">${alertas.length}</span></h2>
        ${alertas.length ? `<ul class="wp-alertas">${alertas.map(alerta).join('')}</ul>`
          : `<p class="empty">${D.resumos.length ? 'Nada pendente nas suas conversas. 👏' : 'Os alertas aparecem depois da primeira varredura (7h e 21h, ou no botão “Gerar resumo agora”).'}</p>`}
      </div>
      ${D.feitos.length ? `<details class="wp-feitos"><summary>Resolvidos nos últimos 7 dias (${D.feitos.length})</summary>
        <ul class="wp-alertas">${D.feitos.map(alerta).join('')}</ul></details>` : ''}
    </section>
    <section class="wp-resumo">
      ${r ? resumo(r) : '<p class="empty">Nenhum resumo ainda.</p>'}
    </section>
  </div>`;
}

function alerta(a) {
  const aberto = a.status === 'aberto';
  const tel = telDoChat(a.chat_id);
  return `<li class="wp-al u-${h(a.urgencia)} ${aberto ? '' : 'fechado'}" data-id="${h(a.id)}">
    <div class="wp-al-top">
      <span class="wp-tipo">${h(TIPOS[a.tipo] || a.tipo)}</span>
      ${a.urgencia === 'alta' && aberto ? '<span class="wp-urg">urgente</span>' : ''}
      <span class="muted small">${h(a.nome || 'Conversa')} · ${quando(a.criado_em)}${a.prazo ? ` · prazo ${h(fmtDate(a.prazo))}` : ''}</span>
    </div>
    <b class="wp-al-tit">${h(a.titulo)}</b>
    ${a.detalhe ? `<p class="wp-al-det">${h(a.detalhe)}</p>` : ''}
    <div class="wp-al-acoes">
      ${aberto ? `
        ${tel ? `<a class="btn sm" href="https://wa.me/${tel}" target="_blank" rel="noopener">Abrir conversa</a>` : ''}
        <button class="btn sm" data-tarefa>Virar tarefa</button>
        <button class="btn sm" data-feito>Feito</button>
        <button class="link-btn" data-ignorar>Ignorar</button>`
      : `<span class="muted small">${a.status === 'feito' ? '✓ Resolvido' : 'Ignorado'}${a.resolvido_por === 'ia' ? ' (a IA viu nas mensagens)' : a.resolvido_por === 'automatico' ? ' (você respondeu)' : ''}</span>
         <button class="link-btn" data-reabrir>Reabrir</button>`}
    </div>
  </li>`;
}

function resumo(r) {
  const c = r.conteudo || {};
  const cats = (c.categorias || []).filter(x => CATEGORIAS[x.categoria]);
  return `
  <div class="wp-res-head">
    <h2>Resumo</h2>
    <select id="wpResumo" aria-label="Escolher resumo">${D.resumos.map(x => `<option value="${h(x.id)}" ${x.id === r.id ? 'selected' : ''}>${h(rotulo(x))}</option>`).join('')}</select>
  </div>
  <p class="muted small">${r.mensagens} mensage${r.mensagens === 1 ? 'm' : 'ns'} de ${h(dataHora(r.de))} a ${h(dataHora(r.ate))}</p>
  ${(c.avisos || []).map(a => `<p class="banner warn wp-aviso">${h(a)}</p>`).join('')}
  ${c.manchete ? `<p class="wp-manchete">${h(c.manchete)}</p>` : ''}
  ${cats.map(x => `<article class="wp-cat" style="--c:${CATEGORIAS[x.categoria][1]}">
      <h3>${h(CATEGORIAS[x.categoria][0])}</h3>
      ${x.resumo ? `<p>${h(x.resumo)}</p>` : ''}
      ${x.conversas?.length ? `<ul>${x.conversas.map(k => `<li><b>${h(k.nome)}</b>: ${h(k.resumo)}</li>`).join('')}</ul>` : ''}
    </article>`).join('')}`;
}

// ---------- conversas e grupos ----------
function telaConversas() {
  const q = norm(busca);
  const filtra = c => !q || norm(c.nome || c.id).includes(q);
  const grupos = D.chats.filter(c => c.grupo && filtra(c));
  const pessoas = D.chats.filter(c => !c.grupo && filtra(c));
  const acomp = D.chats.filter(c => c.grupo && c.acompanhar).length;
  const linha = (c, campo, rot) => `<li class="wp-chat">
      <span class="wp-chat-nome"><b>${h(c.nome || nomeChat(c.id))}</b><span class="muted small">${c.ultima_msg_em ? 'última mensagem ' + quando(c.ultima_msg_em) : 'sem mensagens recentes'}</span></span>
      <label class="wa-switch ${c[campo] ? 'on' : ''}"><input type="checkbox" data-chat="${h(c.id)}" data-campo="${campo}" ${c[campo] ? 'checked' : ''}> ${rot}</label>
    </li>`;
  return `
  <p class="muted small wp-ajuda">Conversas individuais entram todas no resumo, menos as que você marcar para ignorar. Grupos ficam de fora, a não ser que você marque <b>Acompanhar</b> (o leitor só guarda as mensagens dos grupos acompanhados a partir daí; nos outros, só quando te marcam ou respondem a você).</p>
  <input type="search" id="wpBusca" class="search wp-busca" aria-label="Buscar conversa ou grupo" placeholder="Buscar conversa ou grupo" value="${h(busca)}">
  <div class="wp-listas">
    <section>
      <h2>Grupos <span class="count">${acomp} acompanhado${acomp === 1 ? '' : 's'}</span></h2>
      ${grupos.length ? `<ul class="list wp-chats">${grupos.slice(0, 300).map(c => linha(c, 'acompanhar', 'Acompanhar')).join('')}</ul>` : '<p class="empty">Nenhum grupo ainda. Eles aparecem quando o leitor conecta.</p>'}
    </section>
    <section>
      <h2>Conversas</h2>
      ${pessoas.length ? `<ul class="list wp-chats">${pessoas.slice(0, 300).map(c => linha(c, 'ignorar', 'Ignorar no resumo')).join('')}</ul>` : '<p class="empty">Nenhuma conversa ainda.</p>'}
    </section>
  </div>`;
}

// ---------- ações ----------
function ligar(el) {
  el.querySelectorAll('[data-aba]').forEach(b => b.onclick = () => { aba = b.dataset.aba; desenhar(el); });
  el.querySelector('#wpGerar').onclick = gerar;
  el.querySelector('#wpResumo')?.addEventListener('change', e => { resumoSel = e.target.value; desenhar(el); });
  const bs = el.querySelector('#wpBusca');
  bs?.addEventListener('input', () => {
    busca = bs.value; const pos = bs.selectionStart;
    desenhar(el);
    const n = el.querySelector('#wpBusca'); n.focus(); n.setSelectionRange(pos, pos);
  });
  el.querySelectorAll('[data-chat]').forEach(i => i.onchange = async () => {
    const { chat, campo } = i.dataset;
    const { error } = await db.client().from('wp_chats').update({ [campo]: i.checked, atualizado_em: new Date().toISOString() }).eq('id', chat);
    if (error) { i.checked = !i.checked; return toast('Não foi possível salvar'); }
    const c = D.chats.find(x => x.id === chat); if (c) c[campo] = i.checked;
    toast(campo === 'acompanhar' ? (i.checked ? 'Grupo acompanhado: entra no resumo a partir das próximas mensagens' : 'Grupo fora do resumo') : (i.checked ? 'Conversa fora do resumo' : 'Conversa volta para o resumo'));
    desenhar(el);
  });
  el.querySelectorAll('.wp-al').forEach(li => {
    const a = [...D.alertas, ...D.feitos].find(x => x.id === li.dataset.id);
    if (!a) return;
    li.querySelector('[data-feito]')?.addEventListener('click', () => mudar(a, 'feito'));
    li.querySelector('[data-ignorar]')?.addEventListener('click', () => mudar(a, 'ignorado'));
    li.querySelector('[data-reabrir]')?.addEventListener('click', () => mudar(a, 'aberto'));
    li.querySelector('[data-tarefa]')?.addEventListener('click', () => {
      taskForm({ titulo: a.titulo, area: 'inbox', prazo: a.prazo || today(), prioridade: a.urgencia === 'alta' ? 1 : 2, notas: [a.detalhe, `WhatsApp: ${a.nome || ''}`].filter(Boolean).join('\n') });
    });
  });
}

async function mudar(a, status) {
  const agora = new Date().toISOString();
  const campos = status === 'aberto' ? { status, resolvido_em: null, resolvido_por: null } : { status, resolvido_em: agora, resolvido_por: 'voce' };
  const { error } = await db.client().from('wp_alertas').update(campos).eq('id', a.id);
  if (error) return toast('Não foi possível salvar');
  Object.assign(a, campos);
  D.alertas = [...D.alertas, ...D.feitos].filter(x => x.status === 'aberto');
  D.feitos = [...new Set([...D.feitos, a])].filter(x => x.status !== 'aberto');
  pintarSelo(D.alertas.length);
  toast(status === 'feito' ? 'Marcado como feito' : status === 'ignorado' ? 'Alerta ignorado' : 'Alerta reaberto');
  if (viewEl) desenhar(viewEl);
}

async function gerar() {
  if (gerando) return;
  gerando = true; if (viewEl) desenhar(viewEl);
  try {
    const { data, error } = await db.client().functions.invoke('wp-resumo', { body: { periodo: 'agora' } });
    if (error) throw new Error(await erroDe(error));
    resumoSel = data?.resumo_id || null;
    toast(data?.mensagens ? `Resumo pronto: ${data.mensagens} mensagens, ${data.alertas_novos || 0} alerta${data.alertas_novos === 1 ? '' : 's'} novo${data.alertas_novos === 1 ? '' : 's'}` : 'Resumo pronto: nenhuma mensagem nova');
  } catch (e) {
    toast('Não foi possível gerar o resumo: ' + e.message, 6000);
  } finally {
    gerando = false;
    D.at = 0;
    await carregar();
  }
}

// Selo no menu: alertas abertos (relido a cada minuto, como o do WhatsApp das casas)
let seloEm = 0;
export async function selo() {
  if (db.mode !== 'supabase' || db.leitura || Date.now() - seloEm < 60e3) return;
  seloEm = Date.now();
  const { count, error } = await db.client().from('wp_alertas').select('id', { count: 'exact', head: true }).eq('status', 'aberto');
  if (!error) pintarSelo(count || 0);
}
function pintarSelo(n) {
  for (const a of document.querySelectorAll('a[data-route="pessoal"]')) {
    let s = a.querySelector('.selo');
    if (!s) { s = document.createElement('span'); s.className = 'selo'; s.setAttribute('aria-label', 'alertas abertos'); a.append(s); }
    s.textContent = n || '';
    s.hidden = !n;
  }
}

// ---------- formatos ----------
async function erroDe(e) { try { return (await e.context.json()).error || e.message; } catch { return e?.message || 'erro'; } }
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const telDoChat = id => /^\d+@s\.whatsapp\.net$/.test(id || '') ? id.split('@')[0] : '';
function nomeChat(id) {
  const t = telDoChat(id);
  if (t) return fone(t);
  return id.endsWith('@g.us') ? 'Grupo sem nome' : 'Contato';
}
function fone(n) {
  const s = String(n).replace(/\D/g, '');
  const m = s.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : '+' + s;
}
const dm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const dataHora = ts => `${localDate(ts) === today() ? 'hoje' : dm(localDate(ts))} ${hhmm(ts)}`;
function quando(ts) {
  if (!ts) return '';
  const min = (Date.now() - Date.parse(ts)) / 60e3;
  if (min < 60) return `há ${Math.max(1, Math.round(min))} min`;
  if (min < 24 * 60) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} dia${Math.round(min / 1440) === 1 ? '' : 's'}`;
}
function rotulo(r) {
  const d = localDate(r.criado_em);
  const dia = d === today() ? 'Hoje' : fmtDate(d);
  return `${dia}, ${hhmm(r.criado_em)} · ${r.periodo === 'manha' ? 'manhã' : r.periodo === 'noite' ? 'noite' : 'manual'}`;
}
