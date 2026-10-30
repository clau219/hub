// WhatsApp das casas: todas as conversas que chegam pela Z-API (função wa-webhook), com o que o robô fez em cada
// mensagem do cliente (respondeu ou por que ficou quieto) e o que a IA entendeu. Lê direto do Supabase e
// atualiza sozinha a cada 10 s enquanto a tela está aberta.
// Responder daqui: caixa de texto (sai pela Z-API, função wa-responder), respostas prontas montadas com a base
// das casas (app_config 'wa_base') e a oportunidade, rascunho da IA e painel com oportunidade, reservas e cotação.
import { S } from './store.js';
import * as db from './db.js';
import { h, today, localDate, hhmm, waLink, fmtDate, etapa, recebido, saldoDeal } from './util.js';
import { dealForm, bookingForm, modal, toast } from './ui.js';

const QUEM = { cliente: 'Cliente', robo: 'Robô', claudio: 'Você' };
const ASSUNTO = { disponibilidade_preco: 'Disponibilidade e valor', confirmar_reserva: 'Quer reservar / pagar', duvida: 'Dúvida respondida pela base', saudacao: 'Cumprimento', outro: 'Outro assunto' };
const CASA = { QS39: 'Casa Frida', QS40: 'Casa Azul', QS50: 'Casa Terracota' };
const ATUALIZA = 10e3;
// Mesma regra de supabase/functions/_shared/wa.ts (campoAPreencher)
const CAMPO_A_PREENCHER = /\[[^\]\n]{1,60}\]|\{\{?[^}\n]{0,60}\}?\}|\bX{2,}\b|_{3,}|<[^>\n]{1,40}>|\(\s*(?:nome|data|valor|n[uú]mero)\b[^)\n]{0,40}\)/i;
const PRONTAS = [['boasvindas', 'Boas-vindas'], ['pix', 'Pix do sinal'], ['local', 'Localização'], ['horarios', 'Check-in/out'], ['regras', 'Regras'], ['pets', 'Pets']];

let D = { contatos: [], msgs: [], cfg: null, zapi: null, base: {}, at: 0, erro: '', assinatura: '' };
let filtro = 'todas';
let aberto = null; // wa_id da conversa aberta
let viewEl = null;
let timer = null;
let carregando = false;
// Sobrevivem ao redesenho de 10 s: o que você está escrevendo, o que faltou no rascunho da IA e a cotação
const rascunhos = {};
const faltou = {};
const cotas = {};

const naTela = () => location.hash.startsWith('#/whatsapp');

async function carregar() {
  if (carregando || db.mode !== 'supabase') return;
  carregando = true;
  try {
    const sb = db.client();
    const [c, m, s, z] = await Promise.all([
      sb.from('wa_contacts').select('*'),
      sb.from('wa_messages').select('id,wa_id,deal_id,direcao,autor,tipo,texto,extracao,enviado_em').order('enviado_em', { ascending: false }).limit(1000),
      sb.from('wa_settings').select('*').eq('id', 1).maybeSingle(),
      sb.from('app_config').select('key,value').in('key', ['zapi_status', 'wa_base']),
    ]);
    const erro = c.error || m.error || s.error;
    if (erro) throw erro;
    const msgs = (m.data || []).reverse();
    const cfgApp = k => { try { return JSON.parse((z.data || []).find(r => r.key === k)?.value || 'null'); } catch { return null; } };
    const zapi = cfgApp('zapi_status');
    const base = cfgApp('wa_base') || {};
    const assinatura = JSON.stringify([msgs.length, msgs.at(-1)?.id, msgs.map(x => x.extracao?.robo || '').join(), c.data, s.data, zapi?.ok, zapi?.motivo, base]);
    const mudou = assinatura !== D.assinatura;
    D = { contatos: c.data || [], msgs, cfg: s.data, zapi, base, at: Date.now(), erro: '', assinatura };
    if (mudou && naTela() && viewEl) desenhar(viewEl);
    else if (naTela() && viewEl) { const t = viewEl.querySelector('.wz-at'); if (t) t.textContent = atualizado(); }
  } catch (e) {
    D.erro = e.message || 'erro';
    if (naTela() && viewEl) desenhar(viewEl);
  } finally { carregando = false; }
}

export function render(el) {
  viewEl = el;
  if (db.mode !== 'supabase') { el.innerHTML = '<div class="view-head"><h1>WhatsApp</h1></div><p class="empty">As conversas do WhatsApp só aparecem com o Supabase configurado.</p>'; return; }
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  if (p.get('c')) aberto = p.get('c');
  desenhar(el);
  if (!D.at || Date.now() - D.at > ATUALIZA) carregar();
  if (!timer) timer = setInterval(() => {
    if (!naTela()) { clearInterval(timer); timer = null; return; }
    if (!document.hidden) carregar();
  }, ATUALIZA);
}

// ---------- conversas ----------
function conversas() {
  const porWa = new Map();
  for (const m of D.msgs) (porWa.get(m.wa_id) || porWa.set(m.wa_id, []).get(m.wa_id)).push(m);
  const silencioH = D.cfg?.horas_silencio ?? 12;
  return D.contatos.filter(c => porWa.has(c.wa_id)).map(c => {
    const msgs = porWa.get(c.wa_id);
    const ult = msgs.at(-1);
    const contato = S.contacts.find(x => x.id === c.contato_id);
    const deal = S.deals.find(x => x.id === c.deal_id) || S.deals.find(x => x.id === ult.deal_id);
    const ateSilencio = c.ultima_manual ? Date.parse(c.ultima_manual) + silencioH * 3600e3 : 0;
    return {
      ...c, msgs, ult, contato, deal,
      nomeVer: c.nome || contato?.nome || fone(c.wa_id),
      esperando: ult.autor === 'cliente',
      silencio: ateSilencio > Date.now() ? new Date(ateSilencio).toISOString() : null,
    };
  }).sort((a, b) => b.ult.enviado_em.localeCompare(a.ult.enviado_em));
}

function desenhar(el) {
  const todas = conversas();
  const esperando = todas.filter(c => c.esperando);
  const lista = filtro === 'esperando' ? esperando : todas;
  const conv = todas.find(c => c.wa_id === aberto);
  const cfg = D.cfg;
  const yThread = el.querySelector('.wz-msgs');
  const noFim = !yThread || yThread.scrollHeight - yThread.scrollTop - yThread.clientHeight < 40;
  const yAntes = yThread?.scrollTop;
  // O redesenho não pode tirar o foco nem o cursor de quem está escrevendo
  const foco = document.activeElement?.closest?.('#view') ? document.activeElement : null;
  const focoId = foco?.id, sel = foco && 'selectionStart' in foco ? [foco.selectionStart, foco.selectionEnd] : null;

  el.innerHTML = `
  <div class="view-head">
    <h1>WhatsApp</h1>
    ${cfg ? `<label class="wa-switch wz-robo ${cfg.bot_ativo ? 'on' : ''}"><input type="checkbox" id="wzBot" ${cfg.bot_ativo ? 'checked' : ''}> <b>Robô ${cfg.bot_ativo ? 'ligado' : 'desligado'}</b></label>` : ''}
    <button class="btn" id="wzBase" title="Endereço, horários, regras, pets, Pix e o que cada casa tem: usado nas respostas prontas, no rascunho da IA e pelo robô">Informações das casas</button>
    <span class="muted small wz-at">${atualizado()}</span>
    ${D.zapi?.canal === 'meta' ? '<span class="muted small wz-con" title="As conversas chegam e saem pela API oficial do WhatsApp (Meta)">● API oficial da Meta</span>'
      : D.zapi?.ok ? `<span class="muted small wz-con" title="A vigia confere a conexão a cada 5 min">● Z-API conectada · ${quandoHora(D.zapi.em)}</span>` : ''}
  </div>
  ${D.zapi?.canal !== 'meta' && D.zapi?.ok === false ?`<p class="banner wz-caiu"><b>WhatsApp das casas desconectado</b> desde ${quandoHora(D.zapi.desde)}: ${h(D.zapi.motivo)}. As mensagens não estão chegando e o robô está parado. Abra a <a href="https://app.z-api.io/app/instances" target="_blank" rel="noopener">Z-API</a> e confira a instância (talvez seja preciso ler o QR code de novo).</p>` : ''}
  ${D.erro ? `<p class="banner warn">Não foi possível ler as conversas: ${h(D.erro)}. Tentando de novo a cada 10 s.</p>` : ''}
  ${cfg && !cfg.bot_ativo ? '<p class="muted small wz-aviso">Com o robô desligado, as mensagens só chegam aqui e no Pipeline; ninguém recebe resposta automática.</p>' : ''}
  <div class="wz ${conv ? 'tem-aberta' : ''}">
    <section class="wz-col-lista">
      <div class="seg">
        <button class="${filtro === 'todas' ? 'on' : ''}" data-f="todas">Todas <span class="count">${todas.length}</span></button>
        <button class="${filtro === 'esperando' ? 'on' : ''}" data-f="esperando">Esperando você <span class="count">${esperando.length}</span></button>
      </div>
      ${!D.at && !D.erro ? '<p class="muted small">Carregando…</p>'
        : lista.length ? `<ul class="wz-lista">${lista.map(itemLista).join('')}</ul>`
        : `<p class="empty">${filtro === 'esperando' ? 'Ninguém esperando resposta.' : 'Nenhuma conversa ainda. Quando alguém mandar mensagem para o WhatsApp das casas, ela aparece aqui.'}</p>`}
    </section>
    <section class="wz-col-conversa">${conv ? conversa(conv) : '<p class="empty wz-vazio">Escolha uma conversa.</p>'}</section>
  </div>`;

  el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filtro = b.dataset.f; desenhar(el); });
  el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { aberto = b.dataset.c; desenhar(el); el.querySelector('.wz-col-conversa')?.scrollIntoView?.({ block: 'nearest' }); });
  el.querySelector('#wzVoltar')?.addEventListener('click', () => { aberto = null; desenhar(el); });
  el.querySelector('#wzBase').onclick = () => baseForm();
  el.querySelector('#wzBot')?.addEventListener('change', async ev => {
    const v = ev.target.checked;
    const { error } = await db.client().from('wa_settings').update({ bot_ativo: v, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) { ev.target.checked = !v; return toast('Não foi possível salvar'); }
    D.cfg = { ...D.cfg, bot_ativo: v };
    toast(v ? 'Robô ligado: responde sozinho a disponibilidade, valor e dúvidas que a base das casas cobre' : 'Robô desligado');
    desenhar(el);
  });
  if (conv) ligarConversa(el, conv);

  pintarSelo(esperando.length);
  const box = el.querySelector('.wz-msgs');
  if (box) box.scrollTop = noFim || yAntes == null ? box.scrollHeight : yAntes;
  if (focoId) {
    const f = el.querySelector('#' + focoId);
    if (f) { f.focus({ preventScroll: true }); if (sel && 'setSelectionRange' in f) try { f.setSelectionRange(...sel); } catch {} }
  }
}

function itemLista(c) {
  const u = c.ult;
  const prefixo = u.autor === 'cliente' ? '' : QUEM[u.autor] + ': ';
  return `<li><button class="wz-item ${c.wa_id === aberto ? 'on' : ''} ${c.esperando ? 'esperando' : ''}" data-c="${h(c.wa_id)}">
    <span class="wz-av" aria-hidden="true">${h(inicial(c.nomeVer))}</span>
    <span class="wz-item-txt">
      <span class="wz-item-top"><b>${h(c.nomeVer)}</b><time>${quando(u.enviado_em)}</time></span>
      <span class="wz-prev">${h(prefixo + (u.texto || `[${u.tipo}]`))}</span>
      <span class="wz-tags">${etiquetas(c)}</span>
    </span></button></li>`;
}

function etiquetas(c) {
  const t = [];
  if (c.esperando) t.push('<span class="wz-tag quente">Esperando você</span>');
  if (c.bot_pausado) t.push('<span class="wz-tag">Robô pausado</span>');
  else if (c.silencio) t.push(`<span class="wz-tag">Robô quieto até ${hhmm(c.silencio)}</span>`);
  return t.join('');
}

function conversa(c) {
  const wa = /^\d+$/.test(c.wa_id) ? waLink(c.wa_id) : null;
  let dia = '';
  const linhas = c.msgs.map(m => {
    const d = localDate(m.enviado_em);
    const sep = d !== dia ? `<li class="wz-dia">${d === today() ? 'Hoje' : fmtDate(d)}</li>` : '';
    dia = d;
    return sep + `<li class="wz-msg wz-${m.autor}"><small>${QUEM[m.autor] || m.autor} · ${hhmm(m.enviado_em)}</small>${h(m.texto || `[${m.tipo}]`)}${m.autor === 'cliente' ? robo(m) : ''}</li>`;
  }).join('');
  const falta = faltou[c.wa_id];
  return `<div class="wz-conv-grid">
  <div class="wz-conv-main">
    <header class="wz-conv-head">
      <button class="icon-btn wz-voltar" id="wzVoltar" aria-label="Voltar para a lista">‹</button>
      <div class="wz-conv-quem"><b>${h(c.nomeVer)}</b><span class="muted small">${h(fone(c.wa_id))}</span></div>
      ${wa ? `<a class="btn wa" href="${h(wa)}" target="_blank" rel="noopener">Abrir no WhatsApp</a>` : ''}
    </header>
    <div class="wz-conv-sub">
      <label class="wa-pausa"><input type="checkbox" id="wzPausa" ${c.bot_pausado ? 'checked' : ''}> Robô pausado com esta pessoa</label>
      <span>${etiquetas({ ...c, bot_pausado: false })}${c.silencio && !c.bot_pausado ? ' <button class="link-btn wz-liberar" id="wzLiberar" title="O robô volta a responder já na próxima mensagem">Liberar robô agora</button>' : ''}</span>
    </div>
    <ol class="wz-msgs">${linhas}</ol>
    <div class="wz-composer">
      <div class="wz-prontas" role="group" aria-label="Respostas prontas">
        ${PRONTAS.map(([k, l]) => `<button type="button" class="chip" data-pronta="${k}">${l}</button>`).join('')}
        <button type="button" class="chip wz-ia-btn" id="wzIA" title="A IA escreve a resposta para a última mensagem do cliente; você revisa antes de enviar">✨ Rascunho da IA</button>
      </div>
      ${falta?.length ? `<p class="wz-faltou">A IA não achou na base: ${h(falta.join(', '))}. Complete os [colchetes] antes de enviar ou <button type="button" class="link-btn" id="wzFaltouBase">preencha a base</button>.</p>` : ''}
      <div class="wz-escrever">
        <textarea id="wzTexto" rows="3" placeholder="Escreva a resposta… (Ctrl+Enter envia)" aria-label="Resposta">${h(rascunhos[c.wa_id] || '')}</textarea>
        <button type="button" class="btn primary" id="wzEnviar">Enviar</button>
      </div>
      <p class="muted small wz-dica">Sai pelo WhatsApp das casas, como se você respondesse pelo celular (o robô fica quieto nesta conversa).</p>
    </div>
  </div>
  <aside class="wz-painel">${painel(c)}</aside>
  </div>`;
}

// Painel: oportunidade, reservas no nome da pessoa e cotação no Airbnb
function painel(c) {
  const d = c.deal;
  const nome = c.contato?.nome || c.nome || '';
  const reservas = nome ? S.bookings.filter(b => b.status !== 'cancelada' && mesmoNome(b.hospede, nome)).sort((a, b) => b.checkin.localeCompare(a.checkin)).slice(0, 5) : [];
  const casa = id => S.properties.find(p => p.id === id)?.nome || CASA[id] || id;
  const q = cotas[c.wa_id] || (cotas[c.wa_id] = datasDaConversa(c));
  return `
    <section class="wz-bloco"><h3>Oportunidade</h3>
      ${d ? `<button type="button" class="link-btn wz-deal" id="wzDeal">${h(d.titulo)}</button>
        <dl class="wz-dl">
          <dt>Etapa</dt><dd>${h(etapa(d.etapa, d.negocio).nome)}</dd>
          ${d.data_evento ? `<dt>Entrada</dt><dd>${fmtDate(d.data_evento)}</dd>` : ''}
          <dt>Valor</dt><dd>${d.valor ? reais(d.valor) : '—'}</dd>
          ${d.valor ? `<dt>Recebido</dt><dd>${reais(recebido(d))}${saldoDeal(d) ? ` · falta <b>${reais(saldoDeal(d))}</b>` : ' · quitado'}</dd>` : ''}
        </dl>` : '<p class="muted small">Sem oportunidade ligada a esta conversa.</p>'}
    </section>
    <section class="wz-bloco"><h3>Reservas${nome ? ` de ${h(nome.split(' ')[0])}` : ''}</h3>
      ${reservas.length ? `<ul class="wz-reservas">${reservas.map(b => `<li><button type="button" class="link-btn" data-bk="${b.id}">${h(casa(b.property_id))}: ${fmtDate(b.checkin)} a ${fmtDate(b.checkout)}</button>${b.valor ? ` <span class="muted">${reais(b.valor)}</span>` : ''}</li>`).join('')}</ul>`
        : '<p class="muted small">Nenhuma reserva com esse nome.</p>'}
    </section>
    <section class="wz-bloco"><h3>Cotar datas</h3>
      <div class="wz-cota">
        <label>Entrada<input type="date" id="wzQin" value="${h(q.checkin)}" min="${today()}"></label>
        <label>Saída<input type="date" id="wzQout" value="${h(q.checkout)}"></label>
        <label>Pessoas<input type="number" id="wzQad" min="1" max="20" value="${h(q.adultos)}"></label>
      </div>
      <button type="button" class="btn" id="wzCotar" ${q.carregando ? 'disabled' : ''}>${q.carregando ? 'Consultando o Airbnb…' : 'Cotar no Airbnb'}</button>
      ${q.res ? `<ul class="wz-cota-res">${q.res.map(x => `<li class="${x.status === 'livre' ? 'ok' : ''}">${h(x.nome)}: ${x.status === 'livre' ? `livre${x.total ? ', ' + reais(x.total) : ''}` : h(STATUS[x.status] || x.status)}</li>`).join('')}</ul>` : ''}
      ${q.erro ? `<p class="wz-faltou">${h(q.erro)}</p>` : ''}
    </section>`;
}
const STATUS = { ocupada: 'ocupada', min_noites: 'pede mais noites', capacidade: 'não comporta', erro: 'não consultou' };

function ligarConversa(el, conv) {
  const wa = conv.wa_id;
  // A tela só se redesenha quando chegam mensagens: no clique, usa a conversa e a oportunidade de agora
  const atual = () => conversas().find(c => c.wa_id === wa) || conv;
  const $ = s => el.querySelector(s);
  const tx = $('#wzTexto');
  tx.oninput = () => { rascunhos[wa] = tx.value; };
  tx.onkeydown = ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); enviar(); } };
  const inserir = t => {
    const atual = tx.value.trim();
    tx.value = atual ? `${atual}\n\n${t}` : t;
    rascunhos[wa] = tx.value;
    tx.focus();
  };

  const enviar = async () => {
    const texto = tx.value.trim();
    if (!texto) return tx.focus();
    // Campo a preencher esquecido ([...], {…}, XX…): não sai para o cliente (o servidor também recusa)
    const campo = texto.match(CAMPO_A_PREENCHER)?.[0];
    if (campo) {
      toast(`Complete ${campo} antes de enviar.`);
      const i = tx.value.indexOf(campo); tx.focus(); if (i >= 0) tx.setSelectionRange(i, i + campo.length);
      return;
    }
    const b = $('#wzEnviar'); b.disabled = true; b.textContent = 'Enviando…';
    try {
      const { data, error } = await db.client().functions.invoke('wa-responder', { body: { acao: 'enviar', wa_id: wa, texto } });
      if (error || data?.error) throw new Error(data?.error || await erroDe(error));
      rascunhos[wa] = ''; delete faltou[wa];
      // aparece na hora; a leitura seguinte traz a mensagem gravada pelo servidor
      D.msgs.push({ id: 'local-' + Date.now(), wa_id: wa, deal_id: conv.deal_id, autor: 'claudio', direcao: 'out', tipo: 'text', texto, enviado_em: new Date().toISOString() });
      const ct = D.contatos.find(x => x.wa_id === wa); if (ct) ct.ultima_manual = new Date().toISOString();
      D.assinatura = '';
      toast('Enviado');
      desenhar(el);
      carregar();
    } catch (e) {
      toast('Não foi possível enviar: ' + e.message, 5000);
      b.disabled = false; b.textContent = 'Enviar';
    }
  };
  $('#wzEnviar').onclick = enviar;

  el.querySelectorAll('[data-pronta]').forEach(b => b.onclick = () => {
    const r = pronta(b.dataset.pronta, atual());
    if (r.aviso) return toast(r.aviso, 5000);
    if (r.falta) { toast(`Preencha “${r.falta}” em Informações das casas`, 4000); return baseForm(); }
    inserir(r.texto);
  });
  $('#wzIA').onclick = async () => {
    const b = $('#wzIA'); b.disabled = true; b.textContent = '✨ Escrevendo…';
    try {
      const { data, error } = await db.client().functions.invoke('wa-responder', { body: { acao: 'rascunho', wa_id: wa } });
      if (error || data?.error) throw new Error(data?.error || await erroDe(error));
      faltou[wa] = data.faltou || [];
      rascunhos[wa] = data.texto;
      desenhar(el);
      el.querySelector('#wzTexto')?.focus();
    } catch (e) {
      toast('A IA não conseguiu escrever: ' + e.message, 5000);
      b.disabled = false; b.textContent = '✨ Rascunho da IA';
    }
  };
  $('#wzFaltouBase')?.addEventListener('click', () => baseForm());

  $('#wzDeal')?.addEventListener('click', () => dealForm(atual().deal));
  el.querySelectorAll('[data-bk]').forEach(b => b.onclick = () => bookingForm(S.bookings.find(x => x.id === b.dataset.bk)));
  el.querySelector('#wzPausa').onchange = async ev => {
    const v = ev.target.checked;
    const { error } = await db.client().from('wa_contacts').update({ bot_pausado: v }).eq('wa_id', wa);
    if (error) { ev.target.checked = !v; return toast('Não foi possível salvar'); }
    const c = D.contatos.find(x => x.wa_id === wa); if (c) c.bot_pausado = v;
    toast(v ? 'Robô pausado para esta pessoa' : 'Robô ativo para esta pessoa');
    desenhar(el);
  };
  // Depois que você responde à mão, o robô fica quieto por N horas; aqui ele volta já na próxima mensagem
  $('#wzLiberar')?.addEventListener('click', async () => {
    const { error } = await db.client().from('wa_contacts').update({ ultima_manual: null }).eq('wa_id', wa);
    if (error) return toast('Não foi possível salvar');
    const c = D.contatos.find(x => x.wa_id === wa); if (c) c.ultima_manual = null;
    toast('Robô liberado: responde já na próxima mensagem desta pessoa');
    desenhar(el);
  });

  // Cotação: as datas ficam guardadas por conversa; o resultado vai para a caixa de texto
  const q = cotas[wa];
  $('#wzQin').onchange = ev => { q.checkin = ev.target.value; if (q.checkout <= q.checkin) { q.checkout = somaDias(q.checkin, 3); $('#wzQout').value = q.checkout; } };
  $('#wzQout').onchange = ev => { q.checkout = ev.target.value; };
  $('#wzQad').onchange = ev => { q.adultos = Math.max(1, +ev.target.value || 2); };
  $('#wzCotar').onclick = async () => {
    if (!q.checkin || !q.checkout || q.checkout <= q.checkin) { q.erro = 'A saída precisa ser depois da entrada.'; return desenhar(el); }
    Object.assign(q, { carregando: true, erro: '', res: null }); desenhar(el);
    try {
      const { data, error } = await db.client().functions.invoke('airbnb-quote', { body: { checkin: q.checkin, checkout: q.checkout, adultos: q.adultos } });
      if (error || data?.error) throw new Error(data?.error || await erroDe(error));
      q.res = data.casas || [];
      if (data.mensagem) { inserirRascunho(wa, saudar(data.mensagem, atual())); }
      else q.erro = 'O Airbnb não devolveu uma mensagem pronta.';
    } catch (e) { q.erro = 'Não foi possível consultar: ' + e.message; }
    q.carregando = false;
    desenhar(el);
  };
}

function inserirRascunho(wa, t) {
  const atual = (rascunhos[wa] || '').trim();
  rascunhos[wa] = atual ? `${atual}\n\n${t}` : t;
}

// "Olá!" só quando a conversa está começando (mesma regra do robô)
function saudar(texto, conv) {
  const corpo = texto.replace(/^Olá!\s*/, '');
  const conversando = conv.msgs.some(m => m.autor !== 'cliente' && Date.now() - Date.parse(m.enviado_em) < 864e5);
  return conversando ? corpo : `Olá! ${corpo}`;
}

// Datas para a cotação: as que a IA entendeu na conversa (última mensagem com data), senão daqui a 7 dias
function datasDaConversa(c) {
  const x = [...c.msgs].reverse().find(m => m.extracao?.checkin && m.extracao.checkin >= today())?.extracao;
  const checkin = x?.checkin || somaDias(today(), 7);
  const checkout = x?.checkout && x.checkout > checkin ? x.checkout : somaDias(checkin, x?.noites || 3);
  return { checkin, checkout, adultos: x?.hospedes || 2 };
}

// ---------- respostas prontas ----------
function pronta(tipo, conv) {
  const g = D.base.geral || {};
  const falta = campo => ({ falta: campo });
  if (tipo === 'pix') {
    if (!g.pix_chave?.trim()) return falta('Chave Pix');
    const chave = `Chave Pix: ${g.pix_chave.trim()}${g.pix_nome?.trim() ? ` (${g.pix_nome.trim()})` : ''}`;
    const d = conv.deal;
    const pct = +g.sinal_pct || 50;
    if (!d?.valor) return { texto: `Para garantir a reserva, o sinal é de ${pct}% do total.\n${chave}\nAssim que fizer, me manda o comprovante, por favor.` };
    const sinal = Math.max(0, d.valor * pct / 100 - recebido(d));
    if (!sinal) return { texto: `O sinal já está pago ✅ Falta ${reais(saldoDeal(d))} do total de ${reais(d.valor)}.\n${chave}` };
    return { texto: `Para garantir a reserva, o sinal é de ${reais(sinal)} (${pct}% do total de ${reais(d.valor)}).\n${chave}\nAssim que fizer, me manda o comprovante, por favor.` };
  }
  if (tipo === 'local') {
    // Cada casa tem o seu link: o da casa da conversa; sem saber a casa, os links de todas
    const casas = casasDaBase();
    const link = id => D.base.casas?.[id]?.localizacao?.trim();
    const casa = casaDaConversa(conv);
    const endereco = g.endereco?.trim() ? `Endereço: ${g.endereco.trim()}` : '';
    if (casa) {
      const nome = casas.find(c => c.id === casa)?.nome || casa;
      if (!link(casa)) return falta(`Link da localização (${nome})`);
      return { texto: [endereco, `Localização da ${nome}: ${link(casa)}`].filter(Boolean).join('\n') };
    }
    const comLink = casas.filter(c => link(c.id));
    if (!comLink.length) return falta('Link da localização');
    return { texto: [endereco, 'Localização de cada casa:', ...comLink.map(c => `• ${c.nome}: ${link(c.id)}`)].filter(Boolean).join('\n') };
  }
  if (tipo === 'horarios') {
    if (!g.checkin?.trim() || !g.checkout?.trim()) return falta(!g.checkin?.trim() ? 'Horário de check-in' : 'Horário de check-out');
    return { texto: `O check-in é a partir das ${g.checkin.trim()} e o check-out até as ${g.checkout.trim()}.` };
  }
  if (tipo === 'boasvindas') return boasVindas(conv);
  if (tipo === 'regras') return g.regras?.trim() ? { texto: g.regras.trim() } : falta('Regras da casa');
  if (tipo === 'pets') return g.pets?.trim() ? { texto: g.pets.trim() } : falta('Pets');
  return falta(tipo);
}

// Boas-vindas (perto da chegada): localização, horários, cofre, Wi-Fi e regras da casa da reserva.
// Reserva = a próxima no nome da pessoa (de preferência na casa da conversa); sem reserva, a casa da conversa com
// as datas em [colchetes], que o Enviar não deixa sair sem preencher.
function boasVindas(conv) {
  const g = D.base.geral || {};
  const nome = conv.contato?.nome || conv.nome || '';
  const casaConv = casaDaConversa(conv);
  const proximas = nome ? S.bookings.filter(b => b.status !== 'cancelada' && b.checkout >= today() && mesmoNome(b.hospede, nome)).sort((a, b) => a.checkin.localeCompare(b.checkin)) : [];
  const b = proximas.find(x => x.property_id === casaConv) || proximas[0];
  const casa = b?.property_id || casaConv;
  if (!casa) return { aviso: 'Não achei reserva nem casa nesta conversa: lance a reserva no nome da pessoa ou diga a casa na oportunidade.' };
  const nomeCasa = casasDaBase().find(c => c.id === casa)?.nome || CASA[casa] || casa;
  const x = D.base.casas?.[casa] || {};
  const v = k => String(x[k] || '').trim();
  if (!g.checkin?.trim() || !g.checkout?.trim()) return { falta: !g.checkin?.trim() ? 'Horário de check-in' : 'Horário de check-out' };
  for (const [k, rot] of [['localizacao', 'Link da localização'], ['cofre_senha', 'Senha do cofre'], ['wifi_rede', 'Wi-Fi (rede)'], ['wifi_senha', 'Wi-Fi (senha)'], ['lixo', 'Onde fica o lixo']]) {
    if (!v(k)) return { falta: `${rot} (${nomeCasa})` };
  }
  const data = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '[dd/mm/aaaa]';
  const primeiro = (b?.hospede || nome).trim().split(/\s+/)[0] || '[Nome]';
  const cap = v('capacidade').match(/\d+/)?.[0];
  const pets = v('pets') || g.pets?.trim();
  return { texto: `Olá, ${primeiro}! 😊 Que alegria receber você na ${nomeCasa}!

🏡 ${nomeCasa.toUpperCase()} ${casa}
${g.endereco?.trim() || 'Condomínio Pipa Natureza – Praia da Pipa, Tibau do Sul/RN'}
📍 Localização: ${v('localizacao')}
Na portaria, informe seu nome e a casa. Seu acesso já estará liberado.

📅 CHECK-IN
${data(b?.checkin)}, a partir das ${g.checkin.trim()}
🔑 Ao chegarem, a chave estará no cofre da frente.
Senha do cofre: ${v('cofre_senha')}
Me avise o horário previsto de chegada, por favor.

📅 CHECK-OUT
${data(b?.checkout)}, até as ${g.checkout.trim()}
Deixe a chave de volta no cofre e confira se portas e janelas ficaram fechadas.

📶 WI-FI
Rede: ${v('wifi_rede')}
Senha: ${v('wifi_senha')}

📋 REGRAS DA CASA
${[cap ? `• Até ${cap} hóspedes. Visitas só com aviso prévio, porque o condomínio exige autorização na portaria` : '• Visitas só com aviso prévio, porque o condomínio exige autorização na portaria',
  '• Silêncio a partir das 22h', '• Proibido fumar dentro da casa', '• Festas e eventos não são permitidos',
  pets ? `• ${pets}` : '', '• Ao sair, desligue o ar-condicionado e as luzes', `• Lixo: ${v('lixo')}`,
  '• Danos a móveis e utensílios serão cobrados'].filter(Boolean).join('\n')}

Qualquer dúvida, é só me chamar por aqui. Boa estadia! 🌴
Claudio` };
}

// ---------- base de informações das casas (app_config 'wa_base') ----------
const GERAL = [
  ['endereco', 'Endereço (do condomínio)', 'Condomínio Pipa Natureza, …'],
  ['checkin', 'Check-in a partir das', '14h'], ['checkout', 'Check-out até as', '11h'],
  ['pix_chave', 'Chave Pix', 'CNPJ, e-mail ou telefone'], ['pix_nome', 'Nome na conta do Pix', 'Claudio R. S. Braga'],
  ['sinal_pct', 'Sinal para reservar (%)', '50'],
];
const GERAL_LONGO = [
  ['pets', 'Pets', 'Ex.: Aceitamos pet de pequeno porte, com taxa de R$ 100 por estadia.'],
  ['regras', 'Regras da casa', 'Ex.: Proibido festa e som alto depois das 22h; máximo de pessoas = capacidade da casa…'],
  ['pagamento', 'Como funciona o pagamento', 'Ex.: Sinal no Pix para reservar e o restante até o dia do check-in.'],
  ['outros', 'Outras informações (estacionamento, roupa de cama, limpeza…)', ''],
];
const POR_CASA = [
  ['localizacao', 'Link da localização — vai nas respostas prontas e no rascunho, nunca pelo robô', 'https://maps.app.goo.gl/…'], ['capacidade', 'Capacidade', '8 pessoas'], ['quartos', 'Quartos e camas', '3 suítes: 2 casal + 1 com 2 solteiro'],
  ['comodidades', 'Comodidades', 'Piscina, churrasqueira, ar-condicionado nos quartos…'], ['wifi_rede', 'Wi-Fi (rede)', ''],
  ['wifi_senha', 'Wi-Fi (senha) — só vai no rascunho da IA, nunca pelo robô', ''],
  ['cofre_senha', 'Senha do cofre da chave — só vai nas Boas-vindas, nunca pelo robô nem pela IA', ''],
  ['lixo', 'Onde fica o lixo', 'Ao lado da vaga da garagem'], ['pets', 'Pets nesta casa (vai nas Boas-vindas)', 'Pets são bem-vindos… / Não aceitamos pets'],
  ['observacoes', 'Observações', ''],
];
function baseForm() {
  const b = D.base || {}; const g = b.geral || {};
  const campo = (nome, rot, ph, v, longo) => longo
    ? `<label class="span2">${rot}<textarea name="${nome}" rows="2" placeholder="${h(ph)}">${h(v || '')}</textarea></label>`
    : `<label>${rot}<input name="${nome}" value="${h(v || '')}" placeholder="${h(ph)}"></label>`;
  const casas = casasDaBase();
  modal('Informações das casas', `
    <p class="muted small">Usadas nas respostas prontas, no rascunho da IA e pelo robô, que passa a responder sozinho as dúvidas que estas informações cobrem (nunca senha de Wi-Fi nem Pix).</p>
    <h3 class="wz-form-h">Todas as casas</h3>
    <div class="grid2">${GERAL.map(([k, r, ph]) => campo(`g.${k}`, r, ph, g[k])).join('')}${GERAL_LONGO.map(([k, r, ph]) => campo(`g.${k}`, r, ph, g[k], true)).join('')}</div>
    ${casas.map(c => `<h3 class="wz-form-h">${h(c.nome)}</h3>
      <div class="grid2">${POR_CASA.map(([k, r, ph]) => campo(`c.${c.id}.${k}`, r, ph, b.casas?.[c.id]?.[k], k === 'comodidades' || k === 'observacoes')).join('')}</div>`).join('')}`, {
    onSubmit: async data => {
      const nova = { geral: {}, casas: {} };
      for (const [k, v] of Object.entries(data)) {
        const val = String(v).trim();
        if (!val) continue;
        const p = k.split('.');
        if (p[0] === 'g') nova.geral[p[1]] = val;
        else if (p[0] === 'c') (nova.casas[p[1]] ||= {})[p[2]] = val;
      }
      const { error } = await db.client().from('app_config').upsert({ key: 'wa_base', value: JSON.stringify(nova) }, { onConflict: 'key' });
      if (error) throw new Error('Não foi possível salvar: ' + error.message);
      D.base = nova; D.assinatura = '';
      toast('Informações das casas salvas');
      if (naTela() && viewEl) desenhar(viewEl);
    },
  });
}

const casasDaBase = () => (S.properties.length ? S.properties : Object.entries(CASA).map(([id, nome]) => ({ id, nome })));
// A casa de que se fala na conversa: a da oportunidade (campo local) ou a última que a IA entendeu
function casaDaConversa(conv) {
  const local = String(conv.deal?.local || '').toLowerCase();
  const pelaDeal = local && casasDaBase().find(c => local.includes(c.nome.toLowerCase()) || local.includes(c.id.toLowerCase()));
  if (pelaDeal) return pelaDeal.id;
  return [...conv.msgs].reverse().find(m => m.extracao?.casa && m.extracao.casa !== 'qualquer')?.extracao.casa || null;
}

// O que a IA entendeu e o que o robô fez com a mensagem do cliente
function robo(m) {
  const x = m.extracao;
  if (!x) return '';
  const r = x.robo;
  const motivo = String(r || '').replace(/assunto "(\w+)"/, (_, a) => (ASSUNTO[a] || a).toLowerCase());
  const fez = !r ? '' : r === 'respondeu' ? '<b class="ok">Robô respondeu</b>' : `<b>Robô quieto:</b> ${h(motivo)}`;
  const ia = x.assunto ? [ASSUNTO[x.assunto] || x.assunto, x.casa && x.casa !== 'qualquer' ? CASA[x.casa] || x.casa : '',
    x.checkin ? `${dm(x.checkin)}${x.checkout ? ' a ' + dm(x.checkout) : x.noites ? `, ${x.noites} noites` : ''}${x.datas_exatas ? '' : ' (data a confirmar)'}` : '',
    x.hospedes ? `${x.hospedes} pessoas` : ''].filter(Boolean).join(' · ') : '';
  return fez || ia ? `<span class="wz-ia">${fez}${fez && ia ? '<br>' : ''}${ia ? `IA: ${h(ia)}` : ''}</span>` : '';
}

// ---------- número no menu: quantas pessoas esperam resposta ----------
// Chamado pelo app a cada redesenho; consulta o banco no máximo 1x por minuto (a aba aberta atualiza na hora)
let seloEm = 0;
export async function selo() {
  if (db.mode !== 'supabase' || db.leitura || Date.now() - seloEm < 60e3) return;
  seloEm = Date.now();
  const { data, error } = await db.client().from('wa_messages').select('wa_id,autor').order('enviado_em', { ascending: false }).limit(1000);
  if (error) return;
  const ult = new Map();
  for (const m of data || []) if (!ult.has(m.wa_id)) ult.set(m.wa_id, m.autor);
  pintarSelo([...ult.values()].filter(a => a === 'cliente').length);
}
function pintarSelo(n) {
  for (const a of document.querySelectorAll('a[data-route="whatsapp"], #moreBtn')) {
    let s = a.querySelector('.selo');
    if (!s) { s = document.createElement('span'); s.className = 'selo'; s.setAttribute('aria-label', 'esperando resposta'); a.append(s); }
    s.textContent = n || '';
    s.hidden = !n;
  }
}

// ---------- formatos ----------
function fone(wa) {
  const s = String(wa || '');
  if (s.includes('@')) return 'número oculto pelo WhatsApp';
  const m = s.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : '+' + s;
}
// "Ana Lima" × "ana lima souza": mesmo primeiro nome e, se os dois tiverem, mesmo segundo nome
function mesmoNome(a, b) {
  const p = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
  const x = p(a), y = p(b);
  return !!x[0] && x[0] === y[0] && (!x[1] || !y[1] || x[1] === y[1]);
}
// Erro de functions.invoke: a mensagem útil vem no corpo da resposta
async function erroDe(e) { try { return (await e.context.json()).error || e.message; } catch { return e?.message || 'erro'; } }
const reais = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }).replace(/\s/g, ' ');
const somaDias = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const inicial = n => (String(n).replace(/[^\p{L}\d]/gu, '')[0] || '?').toUpperCase();
const dm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const quando = ts => localDate(ts) === today() ? hhmm(ts) : dm(localDate(ts));
const quandoHora = ts => !ts ? '' : localDate(ts) === today() ? hhmm(ts) : `${dm(localDate(ts))} ${hhmm(ts)}`;
const atualizado = () => D.at ? `Atualiza sozinho · ${hhmm(new Date(D.at).toISOString())}` : '';
