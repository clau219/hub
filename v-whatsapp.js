// WhatsApp das casas: todas as conversas que chegam pela Z-API (função wa-webhook), com o que o robô fez em cada
// mensagem do cliente (respondeu ou por que ficou quieto) e o que a IA entendeu. Lê direto do Supabase e
// atualiza sozinha a cada 10 s enquanto a tela está aberta.
import { S } from './store.js';
import * as db from './db.js';
import { h, today, localDate, hhmm, waLink, fmtDate } from './util.js';
import { dealForm, toast } from './ui.js';

const QUEM = { cliente: 'Cliente', robo: 'Robô', claudio: 'Você' };
const ASSUNTO = { disponibilidade_preco: 'Disponibilidade e valor', confirmar_reserva: 'Quer reservar / pagar', outro: 'Outro assunto' };
const CASA = { QS39: 'Casa Frida', QS40: 'Casa Azul', QS50: 'Casa Terracota' };
const ATUALIZA = 10e3;

let D = { contatos: [], msgs: [], cfg: null, zapi: null, at: 0, erro: '', assinatura: '' };
let filtro = 'todas';
let aberto = null; // wa_id da conversa aberta
let viewEl = null;
let timer = null;
let carregando = false;

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
      sb.from('app_config').select('value').eq('key', 'zapi_status').maybeSingle(),
    ]);
    const erro = c.error || m.error || s.error;
    if (erro) throw erro;
    const msgs = (m.data || []).reverse();
    let zapi = null; try { zapi = JSON.parse(z.data?.value || 'null'); } catch {}
    const assinatura = JSON.stringify([msgs.length, msgs.at(-1)?.id, msgs.map(x => x.extracao?.robo || '').join(), c.data, s.data, zapi?.ok, zapi?.motivo]);
    const mudou = assinatura !== D.assinatura;
    D = { contatos: c.data || [], msgs, cfg: s.data, zapi, at: Date.now(), erro: '', assinatura };
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

  el.innerHTML = `
  <div class="view-head">
    <h1>WhatsApp</h1>
    ${cfg ? `<label class="wa-switch wz-robo ${cfg.bot_ativo ? 'on' : ''}"><input type="checkbox" id="wzBot" ${cfg.bot_ativo ? 'checked' : ''}> <b>Robô ${cfg.bot_ativo ? 'ligado' : 'desligado'}</b></label>` : ''}
    <span class="muted small wz-at">${atualizado()}</span>
    ${D.zapi?.ok ? `<span class="muted small wz-con" title="A vigia confere a conexão a cada 5 min">● Z-API conectada · ${quandoHora(D.zapi.em)}</span>` : ''}
  </div>
  ${D.zapi?.ok === false ? `<p class="banner wz-caiu"><b>WhatsApp das casas desconectado</b> desde ${quandoHora(D.zapi.desde)}: ${h(D.zapi.motivo)}. As mensagens não estão chegando e o robô está parado. Abra a <a href="https://app.z-api.io/app/instances" target="_blank" rel="noopener">Z-API</a> e confira a instância (talvez seja preciso ler o QR code de novo).</p>` : ''}
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
  el.querySelector('#wzBot')?.addEventListener('change', async ev => {
    const v = ev.target.checked;
    const { error } = await db.client().from('wa_settings').update({ bot_ativo: v, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) { ev.target.checked = !v; return toast('Não foi possível salvar'); }
    D.cfg = { ...D.cfg, bot_ativo: v };
    toast(v ? 'Robô ligado: responde sozinho a perguntas de disponibilidade e valor' : 'Robô desligado');
    desenhar(el);
  });
  el.querySelector('#wzPausa')?.addEventListener('change', async ev => {
    const v = ev.target.checked;
    const { error } = await db.client().from('wa_contacts').update({ bot_pausado: v }).eq('wa_id', conv.wa_id);
    if (error) { ev.target.checked = !v; return toast('Não foi possível salvar'); }
    const c = D.contatos.find(x => x.wa_id === conv.wa_id); if (c) c.bot_pausado = v;
    toast(v ? 'Robô pausado para esta pessoa' : 'Robô ativo para esta pessoa');
    desenhar(el);
  });
  // Depois que você responde à mão, o robô fica quieto por N horas; aqui ele volta já na próxima mensagem
  el.querySelector('#wzLiberar')?.addEventListener('click', async () => {
    const { error } = await db.client().from('wa_contacts').update({ ultima_manual: null }).eq('wa_id', conv.wa_id);
    if (error) return toast('Não foi possível salvar');
    const c = D.contatos.find(x => x.wa_id === conv.wa_id); if (c) c.ultima_manual = null;
    toast('Robô liberado: responde já na próxima mensagem desta pessoa');
    desenhar(el);
  });
  el.querySelector('#wzDeal')?.addEventListener('click', () => dealForm(conv.deal));

  pintarSelo(esperando.length);
  const box = el.querySelector('.wz-msgs');
  if (box) box.scrollTop = noFim || yAntes == null ? box.scrollHeight : yAntes;
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
  return `
    <header class="wz-conv-head">
      <button class="icon-btn wz-voltar" id="wzVoltar" aria-label="Voltar para a lista">‹</button>
      <div class="wz-conv-quem"><b>${h(c.nomeVer)}</b><span class="muted small">${h(fone(c.wa_id))}</span></div>
      <div class="wz-conv-acoes">
        ${c.deal ? `<button class="btn" id="wzDeal">Oportunidade</button>` : ''}
        ${wa ? `<a class="btn wa" href="${h(wa)}" target="_blank" rel="noopener">Responder no WhatsApp</a>` : ''}
      </div>
    </header>
    <div class="wz-conv-sub">
      <label class="wa-pausa"><input type="checkbox" id="wzPausa" ${c.bot_pausado ? 'checked' : ''}> Robô pausado com esta pessoa</label>
      <span>${etiquetas({ ...c, bot_pausado: false })}${c.silencio && !c.bot_pausado ? ' <button class="link-btn wz-liberar" id="wzLiberar" title="O robô volta a responder já na próxima mensagem">Liberar robô agora</button>' : ''}</span>
    </div>
    <ol class="wz-msgs">${linhas}</ol>`;
}

// O que o robô fez com a mensagem do cliente e o que a IA entendeu
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
const inicial = n => (String(n).replace(/[^\p{L}\d]/gu, '')[0] || '?').toUpperCase();
const dm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const quando = ts => localDate(ts) === today() ? hhmm(ts) : dm(localDate(ts));
const quandoHora = ts => !ts ? '' : localDate(ts) === today() ? hhmm(ts) : `${dm(localDate(ts))} ${hhmm(ts)}`;
const atualizado = () => D.at ? `Atualiza sozinho · ${hhmm(new Date(D.at).toISOString())}` : '';
