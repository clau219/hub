// Relatórios mensais para os proprietários: botão "Relatórios dos donos" em Aluguéis e lembretes no Escapando
// (dia 1º: relatório a enviar; 5 dias depois do envio: repasse a pagar).
// Lista das casas no mês → revisão de uma casa (dono, valor das reservas do Airbnb com sugestão pelo repasse em Finanças,
// despesas, outras despesas) → PDF para baixar, teste para o próprio Gmail ou envio ao dono (função relatorio-enviar).
// Depois do envio: aviso se algo mudou desde então e registro do repasse pago (com sugestão pelo extrato).
import { S, save } from './store.js';
import { h, today, addDays } from './util.js';
import { modal, toast, confirmInline, closeModal } from './ui.js';
import * as db from './db.js';
import { deCanal, mesAnterior, rotuloMes, limitesMes, montarRelatorio, emailRelatorio, despesasSemCasa, lerAjustes, ajustesTxt, brl2, dataBr,
  sugerirRepasses, totaisEnviados, mudouDesdeEnvio, textoMudancas, sugerirPagamento, janelaPagamento } from './relatorio.js';
import { pdfRelatorio } from './relatorio-pdf.js';

const ORIGEM = { airbnb: 'Airbnb', direto: 'Direta', booking: 'Booking', outro: 'Outra' };
const JANELA_AIRBNB = 3; // dias entre o check-in e o repasse do Airbnb

// Mês atual e os 11 anteriores, do mais recente para o mais antigo
export function mesesRecentes(hoje = today()) {
  const out = [hoje.slice(0, 7)];
  while (out.length < 12) out.push(mesAnterior(out.at(-1) + '-01'));
  return out;
}
const enviado = (p, mes) => p.relatorios?.[mes]?.enviado_em;
const situacaoRepasse = r => !r?.enviado_em || !(r.repasse > 0) ? '' : r.pago_em ? ` · repasse pago em ${dataBr(r.pago_em)}` : ' · repasse a pagar';

export function relatoriosForm(mes = mesAnterior(today())) {
  const d = modal('Relatórios dos proprietários', `
    <label>Mês<select name="mes">${mesesRecentes().map(m => `<option value="${m}" ${m === mes ? 'selected' : ''}>${h(rotuloMes(m))}</option>`).join('')}</select></label>
    <ul class="list rel-casas" id="relCasas"></ul>
    <p class="muted small">Receita pela data de entrada. O valor das reservas do Airbnb é sugerido pelo repasse que entrou em Finanças; confira na revisão de cada casa.</p>`);
  const sel = d.querySelector('[name=mes]'), ul = d.querySelector('#relCasas');
  let vez = 0;
  const lista = async () => {
    const m = sel.value, minha = ++vez;
    const linha = p => {
      const rel = p.relatorios?.[m], env = enviado(p, m), dono = p.dono || {};
      const situacao = env ? `Enviado em ${dataBr(env.slice(0, 10))}${rel.para ? ' para ' + rel.para : ''}${situacaoRepasse(rel)}`
        : dono.email ? 'Ainda não enviado' : 'Sem e-mail do proprietário';
      return `<li class="row"><span class="dot" style="--c:${p.cor}"></span>
        <button type="button" class="row-main" data-casa="${h(p.id)}"><span class="row-title">${h(p.nome)}${dono.nome ? ` · ${h(dono.nome)}` : ''}</span>
        <span class="row-sub">${h(situacao)}</span></button><span class="row-meta">${env ? '<span class="seq ok">enviado</span>' : ''}</span></li>`;
    };
    ul.innerHTML = S.properties.map(linha).join('');
    // Relatório enviado que mudou depois (reserva ou despesa editada): precisa dos lançamentos do mês
    if (!S.properties.some(p => enviado(p, m))) return;
    const tx = await lerTx(m).catch(() => null);
    if (!tx || minha !== vez || !ul.isConnected) return;
    for (const p of S.properties) {
      const rel = p.relatorios?.[m] || {};
      const r = enviado(p, m) && montarRelatorio({ casa: p, mes: m, bookings: S.bookings, tx, dono: p.dono || {}, ajustes: rel.ajustes || [], excluidas: rel.excluidas || [] });
      const meta = ul.querySelector(`[data-casa="${p.id}"]`)?.nextElementSibling;
      if (meta && r && mudouDesdeEnvio(r, rel).length) meta.innerHTML = '<span class="late-lbl">mudou depois do envio</span>'; // só a etiqueta: não atrapalha um clique
    }
  };
  sel.onchange = lista;
  ul.onclick = ev => { const b = ev.target.closest('[data-casa]'); if (b) relatorioCasa(b.dataset.casa, sel.value); };
  lista();
  return d;
}

// Lançamentos de Aluguéis do mês e dos primeiros dias do seguinte (repasse do Airbnb de quem entrou no fim do mês)
async function lerTx(mes) {
  const { ini, fim } = limitesMes(mes), ate = addDays(fim, JANELA_AIRBNB);
  if (db.mode === 'supabase') {
    const { data, error } = await db.client().from('fin_tx').select('*').eq('negocio', 'alugueis').gte('data', ini).lt('data', ate).order('data');
    if (error) throw error;
    return data;
  }
  return (await db.all('fin_tx')).filter(t => t.negocio === 'alugueis' && t.data >= ini && t.data < ate);
}
// Saídas com o valor do repasse perto do envio (qualquer negócio: o PIX ao dono pode estar sem categoria)
async function lerPagamentos(salvo) {
  const { ini, fim } = janelaPagamento(salvo);
  if (db.mode === 'supabase') {
    const { data, error } = await db.client().from('fin_tx').select('*').eq('valor', -salvo.repasse).gte('data', ini).lte('data', fim);
    if (error) throw error;
    return data;
  }
  return (await db.all('fin_tx')).filter(t => t.data >= ini && t.data <= fim);
}

const base64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

export async function relatorioCasa(casaId, mes = mesAnterior(today())) {
  const casa = S.properties.find(p => p.id === casaId);
  if (!casa) return;
  let tx;
  try { tx = await lerTx(mes); } catch (e) { console.warn('fin_tx', e); tx = []; toast('Não consegui ler as despesas de Finanças; o relatório sai só com as reservas e as outras despesas.', 5000); }
  const salvo = casa.relatorios?.[mes] || {}, dono = casa.dono || {};
  const relAtual = () => S.properties.find(p => p.id === casa.id)?.relatorios?.[mes] || {};
  const { ini, fim } = limitesMes(mes);
  const doMes = S.bookings.filter(b => b.property_id === casa.id && b.status === 'confirmada' && b.checkin >= ini && b.checkin < fim)
    .sort((a, b) => a.checkin.localeCompare(b.checkin));
  const excluidas = new Set(salvo.excluidas || []);
  const sugestoes = sugerirRepasses(S.bookings, tx, JANELA_AIRBNB), vincular = {}; // reserva → repasse aceito (ganha a casa em Finanças)

  const celulaValor = b => {
    const s = (b.valor == null || b.valor === '') && sugestoes[b.id];
    return `<input name="v:${h(b.id)}" type="number" min="0" step="0.01" inputmode="decimal" value="${h(b.valor ?? '')}" placeholder="${deCanal(b) ? 'repasse' : 'valor'}" aria-label="Valor da reserva de ${h(b.hospede || 'hóspede')}">
      ${s ? `<button type="button" class="chip rel-sug" data-sug="${h(b.id)}" title="Repasse do Airbnb de ${dataBr(s.data)} em Finanças">Usar ${brl2(s.valor)}</button>` : ''}`;
  };
  const nSug = doMes.filter(b => (b.valor == null || b.valor === '') && sugestoes[b.id]).length;
  const d = modal(`Relatório de ${rotuloMes(mes)} · ${casa.nome}`, `
    <p class="rel-env" id="relEnv" hidden></p>
    <div class="rel-pago" id="relPago" hidden></div>
    <div class="rel-dono">
      <label>Proprietário<input name="dono_nome" value="${h(dono.nome)}" placeholder="Nome do dono da casa"></label>
      <label>E-mail<input name="dono_email" type="email" value="${h(dono.email)}" placeholder="dono@exemplo.com"></label>
      <label>Comissão (%)<input name="comissao_pct" type="number" min="0" max="100" step="0.5" value="${h(dono.comissao_pct ?? '')}" placeholder="0"></label>
    </div>
    <h3 class="rel-h">Reservas com entrada no mês${nSug > 1 ? ` <button type="button" class="chip" id="relSugTodas">Usar os ${nSug} repasses encontrados</button>` : ''}</h3>
    ${doMes.length ? `<table class="table rel-res"><thead><tr><th>Hóspede</th><th>Datas</th><th>Origem</th><th class="num">Valor (R$)</th></tr></thead><tbody>
      ${doMes.map(b => `<tr><td>${h(b.hospede || 'Hóspede')}</td><td>${dataBr(b.checkin).slice(0, 5)} a ${dataBr(b.checkout).slice(0, 5)}</td><td>${h(ORIGEM[b.origem] || b.origem)}</td>
        <td class="num">${celulaValor(b)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="empty">Nenhuma reserva confirmada com entrada no mês.</p>'}
    <h3 class="rel-h">Despesas da casa <small class="muted">(Finanças · Aluguéis · ${h(casa.nome)})</small></h3>
    <div id="relDesp"></div>
    <label>Outras despesas <small class="muted">(uma por linha: descrição e valor)</small><textarea name="ajustes" rows="3" placeholder="Faxina extra 150&#10;Lâmpadas 42,90">${h(ajustesTxt(salvo.ajustes))}</textarea></label>
    <dl class="pipe-sum rel-resumo" id="relResumo"></dl>
    <p class="muted small">Antes de mandar ao dono: <button type="button" class="link-btn" id="relTeste">enviar um teste para mim</button> (não marca como enviado).</p>
    <p class="modal-err" id="relAviso" role="alert"></p>`, {
    submit: 'Salvar',
    extra: '<button type="button" class="btn" id="relPdf">Baixar PDF</button><button type="button" class="btn" id="relEnviar">Enviar ao proprietário</button>',
    onSubmit: async () => { await gravar(estado()); toast('Relatório salvo'); },
  });
  const $ = s => d.querySelector(s);
  const campo = n => d.querySelector(`[name="${n}"]`);

  // Lançamentos com a casa (marcados = entram) e os sem casa, com "é desta casa"
  function despesas() {
    const doMesTx = tx.filter(t => t.data?.startsWith(mes));
    const daCasa = doMesTx.filter(t => t.casa === casa.id && +t.valor < 0), sem = despesasSemCasa(tx, mes);
    $('#relDesp').innerHTML = `${daCasa.length ? `<ul class="rel-tx">${daCasa.map(t => `<li><label class="chk"><input type="checkbox" name="tx:${h(t.id)}" ${excluidas.has(t.id) ? '' : 'checked'}>
        <span>${dataBr(t.data).slice(0, 5)} · ${h(t.descricao || t.categoria || 'Despesa')}</span><b>${brl2(-t.valor)}</b></label></li>`).join('')}</ul>`
      : '<p class="muted small">Nenhum lançamento de Aluguéis marcado com esta casa no mês.</p>'}
      ${sem.length ? `<details class="rel-sem"><summary>${sem.length} ${sem.length === 1 ? 'despesa' : 'despesas'} de Aluguéis sem casa definida</summary><ul class="rel-tx">
        ${sem.map(t => `<li><span>${dataBr(t.data).slice(0, 5)} · ${h(t.descricao || t.categoria || 'Despesa')}</span><b>${brl2(-t.valor)}</b>
          <button type="button" class="chip" data-dacasa="${h(t.id)}">É desta casa</button></li>`).join('')}</ul></details>` : ''}`;
  }

  // O que está na tela agora (sem gravar)
  function estado() {
    for (const c of d.querySelectorAll('input[name^="tx:"]')) c.checked ? excluidas.delete(c.name.slice(3)) : excluidas.add(c.name.slice(3));
    const valores = {};
    for (const i of d.querySelectorAll('input[name^="v:"]')) valores[i.name.slice(2)] = i.value === '' ? null : +i.value;
    return {
      dono: { nome: campo('dono_nome').value.trim(), email: campo('dono_email').value.trim(), comissao_pct: +campo('comissao_pct').value || 0 },
      valores, excluidas: [...excluidas], ajustes: lerAjustes(campo('ajustes').value),
    };
  }
  const calcular = st => montarRelatorio({ casa, mes, tx, dono: st.dono, ajustes: st.ajustes, excluidas: st.excluidas,
    bookings: S.bookings.map(b => b.id in st.valores ? { ...b, valor: st.valores[b.id] } : b) });

  function resumo() {
    const r = calcular(estado());
    $('#relResumo').innerHTML = `
      <div><dt>Receita${r.semValor ? `<br><small class="late-lbl">${r.semValor} ${r.semValor === 1 ? 'reserva sem valor' : 'reservas sem valor'}</small>` : ''}</dt><dd>${brl2(r.receita)}</dd></div>
      <div><dt>Despesas</dt><dd>${brl2(r.totalDespesas)}</dd></div>
      <div><dt>Comissão${r.comissaoPct ? ` (${String(r.comissaoPct).replace('.', ',')}%)` : ''}</dt><dd>${brl2(r.comissao)}</dd></div>
      <div><dt>${r.repasse < 0 ? 'Saldo negativo' : 'A repassar'}<br><small>ocupação ${r.ocupacao}% · ${r.noites} noites</small></dt><dd>${brl2(Math.abs(r.repasse))}</dd></div>`;
    // Já enviado: diz se o que está na tela ainda é o que o dono recebeu
    const rel = relAtual(), env = $('#relEnv');
    env.hidden = !rel.enviado_em;
    if (rel.enviado_em) {
      const mud = mudouDesdeEnvio(r, rel), quando = `${dataBr(rel.enviado_em.slice(0, 10))}${rel.para ? ' para ' + rel.para : ''}`;
      env.classList.toggle('mudou', mud.length > 0);
      env.textContent = mud.length ? `Mudou desde o envio em ${quando}: ${textoMudancas(mud)}. Enviar de novo manda a versão corrigida.`
        : `Enviado em ${quando}. Nada mudou desde então.`;
    }
    return r;
  }

  // Repasse ao dono: depois do envio, marcar quando pagou (sugestão: saída com o valor exato no extrato)
  async function blocoPago() {
    const rel = relAtual(), el = $('#relPago');
    el.hidden = !rel.enviado_em || !(rel.repasse > 0);
    if (el.hidden) return;
    if (rel.pago_em) {
      el.innerHTML = `<span>✓ Repasse de <b>${brl2(rel.pago_valor ?? rel.repasse)}</b> pago em ${dataBr(rel.pago_em)}</span><button type="button" class="link-btn" id="relDespagar">desfazer</button>`;
      return;
    }
    el.innerHTML = `<span>Repasse de <b>${brl2(rel.repasse)}</b> a pagar</span>
      <input type="date" id="relPagoData" value="${today()}" aria-label="Data do pagamento"><button type="button" class="btn" id="relPagar">Marcar como pago</button>
      <small class="muted" id="relPagoSug"></small>`;
    const t = sugerirPagamento(rel, await lerPagamentos(rel).catch(() => []));
    if (t && !el.hidden && $('#relPagoSug')) {
      $('#relPagoData').value = t.data;
      $('#relPagoSug').textContent = `Encontrei em Finanças: ${brl2(-t.valor)} em ${dataBr(t.data)}${t.descricao ? ` (${t.descricao})` : ''}.`;
      $('#relPagar').dataset.tx = t.id;
    }
  }
  async function marcarPago(dados) {
    const atual = S.properties.find(p => p.id === casa.id) || casa, rel = { ...relAtual() };
    if (dados) Object.assign(rel, dados); else { delete rel.pago_em; delete rel.pago_valor; delete rel.pago_tx; }
    await save('properties', { relatorios: { ...(atual.relatorios || {}), [mes]: rel } }, casa.id);
    await blocoPago();
  }

  // Grava o valor das reservas (o do Airbnb fica na reserva; o repasse usado ganha a casa em Finanças) e, na casa, o dono e a revisão do mês
  async function gravar(st, extra = {}) {
    for (const [id, valor] of Object.entries(st.valores)) {
      const b = S.bookings.find(x => x.id === id);
      if (b && (b.valor ?? null) !== valor) await db.update('bookings', id, { valor });
      const s = vincular[id];
      if (s && valor === s.valor) { await db.update('fin_tx', s.tx_id, { casa: casa.id, manual: true }); delete vincular[id]; }
    }
    const atual = S.properties.find(p => p.id === casa.id) || casa;
    await save('properties', { dono: st.dono, relatorios: { ...(atual.relatorios || {}), [mes]: { ...(atual.relatorios?.[mes] || {}), ajustes: st.ajustes, excluidas: st.excluidas, ...extra } } }, casa.id);
  }
  const usarSugestao = id => {
    const s = sugestoes[id], i = campo('v:' + id);
    if (!s || !i) return;
    i.value = s.valor; vincular[id] = s;
    d.querySelector(`[data-sug="${id}"]`)?.remove();
  };

  d.querySelector('#modalForm').oninput = resumo;
  d.querySelector('.rel-res')?.addEventListener('click', ev => { const b = ev.target.closest('[data-sug]'); if (b) { usarSugestao(b.dataset.sug); resumo(); } });
  $('#relSugTodas')?.addEventListener('click', ev => { for (const b of d.querySelectorAll('[data-sug]')) usarSugestao(b.dataset.sug); ev.target.remove(); resumo(); });
  $('#relPago').onclick = async ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    b.disabled = true;
    try {
      if (b.id === 'relPagar') await marcarPago({ pago_em: $('#relPagoData').value || today(), pago_valor: relAtual().repasse, ...(b.dataset.tx ? { pago_tx: b.dataset.tx } : {}) });
      else if (b.id === 'relDespagar') await marcarPago(null);
      toast(b.id === 'relPagar' ? 'Repasse marcado como pago' : 'Pagamento desfeito');
    } catch (e) { $('#relAviso').textContent = `Não consegui gravar: ${e.message}`; b.disabled = false; }
  };
  $('#relDesp').onclick = async ev => {
    const b = ev.target.closest('[data-dacasa]');
    if (!b) return;
    b.disabled = true;
    try {
      await db.update('fin_tx', b.dataset.dacasa, { casa: casa.id, manual: true });
      estado(); // guarda as marcações antes de redesenhar
      tx.find(t => t.id === b.dataset.dacasa).casa = casa.id;
      despesas(); resumo();
    } catch (e) { $('#relAviso').textContent = `Não consegui marcar a casa: ${e.message}`; b.disabled = false; }
  };
  $('#relPdf').onclick = () => {
    const r = resumo(), { arquivo } = emailRelatorio(r);
    const url = URL.createObjectURL(new Blob([pdfRelatorio(r)], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: arquivo });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const corpoEnvio = r => { const { assunto, corpo, arquivo } = emailRelatorio(r); return { assunto, corpo, arquivo, pdf: base64(pdfRelatorio(r)) }; };
  // Teste: vai para o Gmail do Claudio com "[Teste]" no assunto; não exige e-mail do dono nem marca o mês
  $('#relTeste').onclick = async ev => {
    const btn = ev.target, aviso = $('#relAviso');
    aviso.textContent = '';
    if (db.mode !== 'supabase') { aviso.textContent = 'O envio precisa do Hub conectado ao Supabase.'; return; }
    btn.disabled = true; btn.textContent = 'enviando o teste…';
    try {
      const { data, error } = await db.client().functions.invoke('relatorio-enviar', { body: { teste: true, ...corpoEnvio(resumo()) } });
      if (error || data?.error) throw new Error(data?.error || error.message);
      toast(`Teste enviado para ${(data.para || []).join(', ') || 'o seu Gmail'}`, 4000);
    } catch (e) { aviso.textContent = `Não consegui enviar o teste: ${e.message}`; }
    btn.disabled = false; btn.textContent = 'enviar um teste para mim';
  };
  $('#relEnviar').onclick = async ev => {
    const btn = ev.target, aviso = $('#relAviso'), st = estado(), r = resumo();
    aviso.textContent = '';
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i.test(st.dono.email)) { aviso.textContent = 'Preencha o e-mail do proprietário.'; return; }
    if (r.semValor) { aviso.textContent = `Preencha o valor de ${r.semValor === 1 ? 'uma reserva' : r.semValor + ' reservas'} (no Airbnb, o repasse) antes de enviar.`; return; }
    if (db.mode !== 'supabase') { aviso.textContent = 'O envio precisa do Hub conectado ao Supabase.'; return; }
    if (!confirmInline(btn)) return;
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const { data, error } = await db.client().functions.invoke('relatorio-enviar', { body: { para: st.dono.email, ...corpoEnvio(r) } });
      if (error || data?.error) throw new Error(data?.error || error.message);
      await gravar(st, { enviado_em: new Date().toISOString(), para: st.dono.email, repasse: r.repasse, totais: totaisEnviados(r) });
      closeModal();
      toast(`Relatório de ${rotuloMes(mes)} enviado para ${st.dono.email}`, 4000);
    } catch (e) {
      aviso.textContent = `Não consegui enviar: ${e.message}`;
      btn.disabled = false; btn.textContent = 'Enviar ao proprietário';
    }
  };
  despesas(); resumo(); blocoPago();
  return d;
}
