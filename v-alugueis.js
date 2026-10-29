import { S, prop, ocupacao, save } from './store.js';
import { h, today, addDays, fmtDate, weekdayShort, brl, diffDays, relDate } from './util.js';
import { bookingForm, modal, toast } from './ui.js';
import * as db from './db.js';
import { progresso, acompanhada, prazo, alternar, parseHospedes, hospedesTxt, juntarHospedes, parseVeiculos, veiculosTxt, juntarVeiculos, emailPortaria } from './hospedagem.js';

const ATRAS = 30; // dias passados no começo do Gantt
let rolagem = null; // posição do deslizador, mantida quando a tela redesenha

export function render(el) {
  const hoje = today();
  // de 30 dias atrás até 1 ano depois de hoje; navega-se pelo deslizador horizontal do Gantt
  const dias = Array.from({ length: ATRAS + 366 }, (_, i) => addDays(hoje, i - ATRAS));
  const fut = S.bookings.filter(b => b.checkout >= hoje && b.status !== 'cancelada').sort((a, b) => a.checkin.localeCompare(b.checkin));
  const mesAtual = hoje.slice(0, 7);
  const doMes = S.bookings.filter(b => b.status === 'confirmada' && b.checkin.slice(0, 7) === mesAtual);
  const receitaMes = doMes.reduce((s, b) => s + (+b.valor || 0), 0);
  const comValor = doMes.filter(b => +b.valor > 0).length; // o Airbnb não informa valor: avisar que o total está incompleto

  el.innerHTML = `
  <div class="view-head">
    <h1>Aluguéis</h1>
    <button class="btn" id="abPortaria">E-mail da portaria</button>
    <button class="btn" id="abQuote">Consultar Airbnb</button>
    <button class="btn primary" id="bkNew">Nova reserva</button>
  </div>
  <div class="gantt" style="--n:${dias.length}">
    <div class="g-row g-head"><span></span>${dias.map(d => `<span class="${d === hoje ? 'today' : ''} ${['sáb', 'dom'].includes(weekdayShort(d)) ? 'we' : ''}"${d.endsWith('-01') || d === dias[0] || d === hoje ? ` data-m="${h(fmtDate(d).split(' ').slice(1).join(' '))}"` : ''}>${weekdayShort(d)[0]}<b>${+d.slice(8)}</b></span>`).join('')}</div>
    ${S.properties.map(p => {
      const bars = S.bookings.filter(b => b.property_id === p.id && b.status !== 'cancelada' && b.checkout > dias[0] && b.checkin <= dias.at(-1));
      return `<div class="g-row"><span class="g-name"><b>${h(p.nome)}</b><small>${h(p.id)}</small></span>
        <div class="g-track">${dias.map(d => `<span class="${d === hoje ? 'today' : ''}"></span>`).join('')}
        ${bars.map(b => {
          const s = Math.max(0, diffDays(dias[0], b.checkin)), e = Math.min(dias.length, diffDays(dias[0], b.checkout));
          const cls = b.status === 'bloqueio' ? 'blk' : b.origem === 'airbnb' ? 'air' : 'dir';
          return `<button class="bar ${cls}" data-bk="${b.id}" style="--s:${s + 0.5};--e:${e + 0.5}" title="${h(`${b.hospede || b.origem}: ${fmtDate(b.checkin)} a ${fmtDate(b.checkout)}`)}">${h(b.hospede || (b.status === 'bloqueio' ? 'Bloqueado' : b.origem))}</button>`;
        }).join('')}</div></div>`;
    }).join('')}
    <div class="occ-legend"><span><i class="cell air"></i>Airbnb</span><span><i class="cell dir"></i>Direto</span><span><i class="cell blk"></i>Bloqueio</span></div>
  </div>
  <div class="cols">
    <section class="block col-main">
      <h2>Próximas reservas</h2>
      ${fut.length ? `<table class="table"><thead><tr><th>Casa</th><th>Hóspede</th><th>Entrada</th><th>Saída</th><th>Noites</th><th>Origem</th><th>Sequência</th><th class="num">Valor</th></tr></thead><tbody>
        ${fut.map(b => `<tr data-bk="${b.id}" tabindex="0"><td><span class="dot" style="--c:${prop(b.property_id).cor}"></span>${h(prop(b.property_id).nome)}</td><td>${h(b.hospede || (b.status === 'bloqueio' ? 'Bloqueio' : ''))}</td>
          <td>${relDate(b.checkin)}</td><td>${fmtDate(b.checkout)}</td><td class="num">${diffDays(b.checkin, b.checkout)}</td><td>${h(b.origem)}</td><td>${seq(b)}</td><td class="num">${brl(b.valor)}</td></tr>`).join('')}
      </tbody></table>` : `<p class="empty">Nenhuma reserva futura. Cadastre as reservas diretas em “Nova reserva”. As do Airbnb entram sozinhas depois que você colar os links iCal em Ajustes.</p>`}
    </section>
    <aside class="col-side block">
      <h2>Este mês</h2>
      <dl class="pipe-sum">
        <div><dt>Receita com check-in no mês${comValor < doMes.length ? `<br><small class="late-lbl">só ${comValor} de ${doMes.length} reservas têm valor</small>` : ''}</dt><dd>${brl(receitaMes) || 'R$ 0'}</dd></div>
        ${S.properties.map(p => {
          const ocup = Array.from({ length: 30 }, (_, i) => ocupacao(p.id, addDays(hoje, i))).filter(b => b && b.status === 'confirmada').length;
          return `<div><dt>${h(p.nome)}, próximos 30 dias</dt><dd>${Math.round(ocup / 30 * 100)}%<small>${ocup} noites</small></dd></div>`;
        }).join('')}
      </dl>
    </aside>
  </div>`;
  const g = el.querySelector('.gantt');
  g.scrollLeft = rolagem ?? (ATRAS - 3) * 26; // abre com 3 dias antes de hoje à vista (26px por dia, ver .g-row no app.css)
  g.onscroll = () => { rolagem = g.scrollLeft; };
  el.querySelector('#bkNew').onclick = () => bookingForm();
  el.querySelector('#abQuote').onclick = () => consultaAirbnb();
  el.querySelector('#abPortaria').onclick = () => portariaForm();
  el.querySelectorAll('[data-bk]').forEach(b => b.onclick = () => bookingForm(S.bookings.find(x => x.id === b.dataset.bk)));
}

// Progresso das etapas da hospedagem: "2/6 · Enviar contrato"
function seq(b) {
  if (b.status !== 'confirmada') return '';
  const p = progresso(b);
  if (!p.proxima) return `<span class="seq ok">${p.total}/${p.total} pronto</span>`;
  if (!acompanhada(b)) return `<span class="seq">${p.feitas}/${p.total}</span>`;
  const late = prazo(b, p.proxima) < today();
  return `<span class="seq ${late ? 'late' : ''}"><b>${p.feitas}/${p.total}</b> ${h(p.proxima.nome)}${late ? ' (atrasada)' : ''}</span>`;
}

// ---------- E-mail da portaria ----------
// Cola os dados crus (WhatsApp, Airbnb, lista), o Hub organiza nome + documento e monta assunto e corpo para copiar.
// Print ou foto de documento (Ctrl+V no campo, anexo ou câmera do celular) vai para a função portaria-ler (IA),
// e o que ela devolve passa pelo mesmo leitor do texto colado.
// Com uma reserva escolhida, "Salvar" grava os hóspedes nela e marca as etapas de hóspedes e portaria.
export function portariaForm(b0) {
  const hoje = today();
  const reservas = S.bookings.filter(b => b.status === 'confirmada' && b.checkout >= hoje).sort((a, b) => a.checkin.localeCompare(b.checkin));
  // padrão: a reserva cuja portaria vence primeiro
  const ini = b0 || reservas.find(b => !b.etapas?.portaria) || null;
  const rotulo = b => `${prop(b.property_id).nome} · ${b.hospede || b.origem} · ${fmtDate(b.checkin)} a ${fmtDate(b.checkout)}${b.etapas?.portaria ? ' (já enviada)' : ''}`;
  const d = modal('E-mail da portaria', `
    <label>Reserva<select name="bk"><option value="">Outra (sem reserva no Hub)</option>${reservas.map(b => `<option value="${b.id}" ${b.id === ini?.id ? 'selected' : ''}>${h(rotulo(b))}</option>`).join('')}</select></label>
    <div class="grid3">
      <label>Casa<select name="casa">${S.properties.map(p => `<option value="${p.id}">${h(p.nome)} (${h(p.id)})</option>`).join('')}</select></label>
      <label>Entrada<input name="checkin" type="date"></label>
      <label>Saída<input name="checkout" type="date"></label>
    </div>
    <label>Cole os dados como vieram: texto ou print (WhatsApp, Airbnb, lista, foto de documento)<textarea name="cru" rows="4" placeholder="1. Maria da Silva - CPF 123.456.789-00&#10;Hóspede 02 / Nome: João Souza / RG: 1.234.567&#10;todos os RGs são SSP/PE&#10;(ou cole aqui um print com Ctrl+V)"></textarea></label>
    <div class="row-btns"><button type="button" class="btn" id="ptLer">Organizar e adicionar à lista</button>
      <button type="button" class="btn" id="ptFoto">Ler print ou foto</button>
      <input type="file" id="ptArq" accept="image/*,application/pdf" multiple hidden></div>
    <label>Hóspedes (um por linha: nome, documento)<textarea name="hospedes" rows="4"></textarea></label>
    <label>Veículos (um por linha: modelo, placa)<textarea name="veiculos" rows="2" placeholder="Honda HRV, TZX3D00"></textarea></label>
    <p class="muted small" id="ptAviso" aria-live="polite"></p>
    <label>Assunto<input name="assunto" readonly></label>
    <label>E-mail<textarea name="corpo" rows="10" readonly></textarea></label>
    <div class="row-btns"><button type="button" class="btn" id="ptCopA">Copiar assunto</button><button type="button" class="btn" id="ptCopC">Copiar e-mail</button></div>`, {
    submit: 'Salvar na reserva e marcar enviada',
    onSubmit: async f => {
      const b = S.bookings.find(x => x.id === f.bk);
      if (!b) throw new Error('Escolha uma reserva para salvar. Sem reserva, é só copiar o e-mail.');
      const hospedes = parseHospedes(f.hospedes), veiculos = parseVeiculos(f.veiculos);
      const etapas = alternar({ etapas: alternar(b, 'hospedes', hospedes.length > 0) }, 'portaria', true);
      await save('bookings', { hospedes, veiculos, etapas }, b.id);
      toast('Hóspedes salvos e portaria marcada como enviada');
    },
  });
  const $ = s => d.querySelector(s);
  const campo = n => $(`[name=${n}]`);
  let avisosIA = []; // o que a IA pediu para conferir na última leitura de print
  const atualizar = () => {
    const casa = prop(campo('casa').value), checkin = campo('checkin').value, checkout = campo('checkout').value;
    const hospedes = parseHospedes(campo('hospedes').value), veiculos = parseVeiculos(campo('veiculos').value);
    const falta = [!checkin || !checkout ? 'as datas' : '', !hospedes.length ? 'os hóspedes' : ''].filter(Boolean);
    const semDoc = hospedes.filter(x => !x.doc).map(x => x.nome);
    $('#ptAviso').textContent = (falta.length ? `Falta ${falta.join(' e ')}.` : semDoc.length ? `Sem documento: ${semDoc.join(', ')}.` : `${hospedes.length} ${hospedes.length === 1 ? 'hóspede' : 'hóspedes'}, todos com documento.`)
      + (avisosIA.length ? ` Conferir: ${avisosIA.join('; ')}.` : '');
    if (!checkin || !checkout) { campo('assunto').value = ''; campo('corpo').value = ''; return; }
    const e = emailPortaria({ checkin, checkout, hospedes, veiculos }, casa);
    campo('assunto').value = e.assunto; campo('corpo').value = e.corpo;
  };
  const escolher = () => {
    const b = S.bookings.find(x => x.id === campo('bk').value);
    ['casa', 'checkin', 'checkout'].forEach(n => (campo(n).disabled = !!b));
    if (b) { campo('casa').value = b.property_id; campo('checkin').value = b.checkin; campo('checkout').value = b.checkout; campo('hospedes').value = hospedesTxt(b.hospedes); campo('veiculos').value = veiculosTxt(b.veiculos); }
    atualizar();
  };
  campo('bk').onchange = escolher;
  ['casa', 'checkin', 'checkout'].forEach(n => campo(n).addEventListener('change', atualizar));
  campo('hospedes').oninput = atualizar;
  campo('veiculos').oninput = atualizar;
  // Junta um texto (colado ou montado a partir da leitura do print) à lista; false se não achou nada
  const juntar = (txt, origem) => {
    const r = juntarHospedes(parseHospedes(campo('hospedes').value), txt);
    const v = juntarVeiculos(parseVeiculos(campo('veiculos').value), txt);
    if (!r.novos && !r.orgao && !v.novos) { toast(`Não achei nome, documento nem placa ${origem}`); return false; }
    campo('hospedes').value = hospedesTxt(r.lista);
    campo('veiculos').value = veiculosTxt(v.lista);
    toast(`${r.novos} ${r.novos === 1 ? 'hóspede lido' : 'hóspedes lidos'}${v.novos ? ` · ${v.novos} ${v.novos === 1 ? 'veículo' : 'veículos'}` : ''}${r.orgao ? ` · RGs ${r.orgao}` : ''}`);
    return true;
  };
  $('#ptLer').onclick = () => {
    if (juntar(campo('cru').value, 'no texto colado')) campo('cru').value = '';
    atualizar();
  };
  // Casa e datas do print: acha a reserva; sem reserva escolhida, preenche casa/datas; com outra escolhida, avisa
  const aplicarLeitura = r => {
    avisosIA = r.avisos || [];
    const atual = S.bookings.find(x => x.id === campo('bk').value);
    if (r.casa || r.checkin) {
      const achada = r.casa && r.checkin && reservas.find(b => b.property_id === r.casa && b.checkin === r.checkin);
      if (!atual && achada) { campo('bk').value = achada.id; escolher(); }
      else if (!atual) {
        if (r.casa) campo('casa').value = r.casa;
        if (r.checkin) campo('checkin').value = r.checkin;
        if (r.checkout) campo('checkout').value = r.checkout;
      } else if ((r.casa && r.casa !== atual.property_id) || (r.checkin && r.checkin !== atual.checkin)) {
        avisosIA = [`o print fala de ${[r.casa && prop(r.casa).nome, r.checkin && fmtDate(r.checkin)].filter(Boolean).join(' em ')}, diferente da reserva escolhida`, ...avisosIA];
      }
    }
    const txt = [...(r.hospedes || []).map(x => x.documento ? `${x.nome}, ${x.documento}` : x.nome), ...(r.veiculos || []).map(v => `${v.modelo} ${v.placa}`.trim())].join('\n');
    juntar(txt, 'no arquivo');
    atualizar();
  };
  const lerArquivos = async lista => {
    const arqs = [...lista].filter(f => /^image\/|^application\/pdf$/.test(f.type));
    if (!arqs.length) return;
    if (db.mode !== 'supabase') { toast('Ler print precisa do Hub conectado ao Supabase'); return; }
    if (arqs.length > 6) toast('Vou ler só os 6 primeiros arquivos');
    const btn = $('#ptFoto');
    btn.disabled = true; btn.textContent = `Lendo ${arqs.length > 1 ? `${Math.min(arqs.length, 6)} arquivos` : 'o arquivo'}…`;
    try {
      const arquivos = await Promise.all(arqs.slice(0, 6).map(prepararArquivo));
      const { data, error } = await db.client().functions.invoke('portaria-ler', { body: { arquivos } });
      if (error || data?.error) throw new Error(data?.error || error.message);
      aplicarLeitura(data);
    } catch (e) { $('#ptAviso').textContent = `Não consegui ler o arquivo: ${e.message}`; }
    finally { btn.disabled = false; btn.textContent = 'Ler print ou foto'; }
  };
  $('#ptFoto').onclick = () => $('#ptArq').click();
  $('#ptArq').onchange = ev => { lerArquivos(ev.target.files); ev.target.value = ''; };
  campo('cru').onpaste = ev => {
    const fs = [...(ev.clipboardData?.files || [])];
    if (!fs.some(f => /^image\/|^application\/pdf$/.test(f.type))) return; // texto: cola normal
    ev.preventDefault();
    lerArquivos(fs);
  };
  const copiar = async (n, msg) => {
    if (!campo(n).value) { toast('Preencha as datas primeiro'); return; }
    try { await navigator.clipboard.writeText(campo(n).value); toast(msg); }
    catch { campo(n).select(); toast('Selecione e copie'); }
  };
  $('#ptCopA').onclick = () => copiar('assunto', 'Assunto copiado');
  $('#ptCopC').onclick = () => copiar('corpo', 'E-mail copiado');
  escolher();
  return d;
}

// Foto vira JPEG de até 2000 px (print grande de celular passa de 5 MB e encarece a leitura); PDF vai como está
async function prepararArquivo(f) {
  if (f.type.startsWith('image/') && typeof createImageBitmap === 'function') {
    try {
      const img = await createImageBitmap(f);
      const k = Math.min(1, 2000 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return { mime: 'image/jpeg', base64: c.toDataURL('image/jpeg', 0.88).split(',')[1] };
    } catch { /* formato que o navegador não abre: manda o original */ }
  }
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mime: f.type, base64: btoa(s) };
}

// ---------- Consulta de disponibilidade e preço no Airbnb (função airbnb-quote) ----------
// Mostra o resultado das 3 casas e um texto pronto para responder no WhatsApp.
export function consultaAirbnb({ checkin = addDays(today(), 7), checkout = addDays(today(), 10), adultos = 2 } = {}) {
  const d = modal('Consultar Airbnb', `
    <div class="grid3">
      <label>Entrada<input name="checkin" type="date" value="${h(checkin)}" min="${today()}" required></label>
      <label>Saída<input name="checkout" type="date" value="${h(checkout)}" required></label>
      <label>Hóspedes<input name="adultos" type="number" min="1" max="20" value="${h(adultos)}" required></label>
    </div>
    <div class="row-btns"><button type="button" class="btn primary" id="abGo">Consultar</button></div>
    <div id="abRes" aria-live="polite"></div>`);
  const $ = s => d.querySelector(s);
  const ir = async () => {
    const q = { checkin: $('[name=checkin]').value, checkout: $('[name=checkout]').value, adultos: +$('[name=adultos]').value || 2 };
    const res = $('#abRes');
    if (db.mode !== 'supabase') { res.innerHTML = '<p class="empty">A consulta ao Airbnb precisa do Hub conectado ao Supabase.</p>'; return; }
    if (!q.checkin || !q.checkout || q.checkout <= q.checkin) { res.innerHTML = '<p class="empty">A saída precisa ser depois da entrada.</p>'; return; }
    $('#abGo').disabled = true; res.innerHTML = '<p class="empty">Consultando o Airbnb…</p>';
    try {
      const { data, error } = await db.client().functions.invoke('airbnb-quote', { body: q });
      if (error || data?.error) throw new Error(data?.error || error.message);
      res.innerHTML = resultado(data);
      res.querySelector('#abCopy')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(res.querySelector('#abMsg').value); toast('Mensagem copiada'); }
        catch { res.querySelector('#abMsg').select(); toast('Selecione e copie a mensagem'); }
      });
    } catch (e) { res.innerHTML = `<p class="empty">Não foi possível consultar: ${h(e.message)}</p>`; }
    finally { $('#abGo').disabled = false; }
  };
  $('#abGo').onclick = ir;
  // mantém a saída depois da entrada ao trocar a data
  $('[name=checkin]').onchange = ev => { const co = $('[name=checkout]'); if (co.value <= ev.target.value) co.value = addDays(ev.target.value, 3); };
  d.querySelectorAll('#modalBody input').forEach(i => i.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); ir(); } });
}

const STATUS_AB = { livre: ['Disponível', 'ok'], ocupada: ['Ocupada', 'no'], min_noites: ['Mínimo de noites', 'warn'], capacidade: ['Não comporta', 'no'], erro: ['Erro', 'no'] };

function resultado(r) {
  const casas = r.casas.map(c => {
    const [rot, cls] = STATUS_AB[c.status] || [c.status, ''];
    const alt = c.alternativa;
    const det = c.status === 'livre' ? `<b>${brl(c.total)}</b><small>${c.diaria ? `${brl(c.diaria)} por noite` : ''}</small>`
      : c.status === 'min_noites' ? `<small>mínimo ${c.min_noites} noites${alt ? `: ${fmtDate(alt.checkin)} a ${fmtDate(alt.checkout)} por <b>${brl(alt.total)}</b>` : ''}</small>`
      : c.status === 'ocupada' ? `<small>${alt ? `livre de ${fmtDate(alt.checkin)} a ${fmtDate(alt.checkout)} por <b>${brl(alt.total)}</b>` : 'sem datas livres próximas'}</small>`
      : c.status === 'erro' ? `<small>${h(c.erro)}</small>` : '';
    return `<li><span class="dot" style="--c:${prop(c.id).cor}"></span><span class="ab-nome">${h(c.nome)}<a href="${h(c.link)}" target="_blank" rel="noopener">ver no Airbnb</a></span>
      <span class="ab-st ${cls}">${rot}</span><span class="ab-det">${det}</span></li>`;
  }).join('');
  return `<p class="muted ab-cab">${fmtDate(r.checkin)} a ${fmtDate(r.checkout)} · ${r.noites} ${r.noites === 1 ? 'noite' : 'noites'} · ${r.adultos} ${r.adultos === 1 ? 'hóspede' : 'hóspedes'} · preços do Airbnb</p>
    <ul class="ab-list">${casas}</ul>
    ${r.mensagem ? `<label>Resposta para o WhatsApp<textarea id="abMsg" rows="6">${h(r.mensagem)}</textarea></label>
    <div class="row-btns"><button type="button" class="btn" id="abCopy">Copiar mensagem</button></div>` : ''}`;
}
