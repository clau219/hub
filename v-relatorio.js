// Relatórios mensais para os proprietários: botão "Relatórios dos donos" em Aluguéis e lembrete no Escapando (dia 1º).
// Lista das casas no mês → revisão de uma casa (dono, valor das reservas do Airbnb, despesas de Finanças, outras despesas)
// → PDF (relatorio-pdf.js) para baixar ou mandar por e-mail (função relatorio-enviar, mesmo Gmail da portaria).
import { S, save } from './store.js';
import { h, today } from './util.js';
import { modal, toast, confirmInline, closeModal } from './ui.js';
import * as db from './db.js';
import { mesAnterior, rotuloMes, limitesMes, montarRelatorio, emailRelatorio, despesasSemCasa, lerAjustes, ajustesTxt, brl2, dataBr } from './relatorio.js';
import { pdfRelatorio } from './relatorio-pdf.js';

const ORIGEM = { airbnb: 'Airbnb', direto: 'Direta', booking: 'Booking', outro: 'Outra' };

// Mês atual e os 11 anteriores, do mais recente para o mais antigo
export function mesesRecentes(hoje = today()) {
  const out = [hoje.slice(0, 7)];
  while (out.length < 12) out.push(mesAnterior(out.at(-1) + '-01'));
  return out;
}
const enviado = (p, mes) => p.relatorios?.[mes]?.enviado_em;

export function relatoriosForm(mes = mesAnterior(today())) {
  const d = modal('Relatórios dos proprietários', `
    <label>Mês<select name="mes">${mesesRecentes().map(m => `<option value="${m}" ${m === mes ? 'selected' : ''}>${h(rotuloMes(m))}</option>`).join('')}</select></label>
    <ul class="list rel-casas" id="relCasas"></ul>
    <p class="muted small">Receita pela data de entrada. As reservas do Airbnb chegam sem valor: preencha o repasse na revisão de cada casa.</p>`);
  const sel = d.querySelector('[name=mes]'), ul = d.querySelector('#relCasas');
  const lista = () => {
    ul.innerHTML = S.properties.map(p => {
      const env = enviado(p, sel.value), dono = p.dono || {};
      const situacao = env ? `Enviado em ${dataBr(env.slice(0, 10))}${p.relatorios[sel.value].para ? ' para ' + p.relatorios[sel.value].para : ''}`
        : dono.email ? 'Ainda não enviado' : 'Sem e-mail do proprietário';
      return `<li class="row"><span class="dot" style="--c:${p.cor}"></span>
        <button type="button" class="row-main" data-casa="${h(p.id)}"><span class="row-title">${h(p.nome)}${dono.nome ? ` · ${h(dono.nome)}` : ''}</span>
        <span class="row-sub">${h(situacao)}</span></button><span class="row-meta">${env ? '<span class="seq ok">enviado</span>' : ''}</span></li>`;
    }).join('');
  };
  sel.onchange = lista;
  ul.onclick = ev => { const b = ev.target.closest('[data-casa]'); if (b) relatorioCasa(b.dataset.casa, sel.value); };
  lista();
  return d;
}

// Lançamentos de Aluguéis do mês (despesas das casas e as sem casa definida)
async function lerTx(mes) {
  const { ini, fim } = limitesMes(mes);
  if (db.mode === 'supabase') {
    const { data, error } = await db.client().from('fin_tx').select('*').eq('negocio', 'alugueis').gte('data', ini).lt('data', fim).order('data');
    if (error) throw error;
    return data;
  }
  return (await db.all('fin_tx')).filter(t => t.negocio === 'alugueis' && t.data >= ini && t.data < fim);
}

const base64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

export async function relatorioCasa(casaId, mes = mesAnterior(today())) {
  const casa = S.properties.find(p => p.id === casaId);
  if (!casa) return;
  let tx;
  try { tx = await lerTx(mes); } catch (e) { console.warn('fin_tx', e); tx = []; toast('Não consegui ler as despesas de Finanças; o relatório sai só com as reservas e as outras despesas.', 5000); }
  const salvo = casa.relatorios?.[mes] || {}, dono = casa.dono || {};
  const { ini, fim } = limitesMes(mes);
  const doMes = S.bookings.filter(b => b.property_id === casa.id && b.status === 'confirmada' && b.checkin >= ini && b.checkin < fim)
    .sort((a, b) => a.checkin.localeCompare(b.checkin));
  const excluidas = new Set(salvo.excluidas || []);

  const d = modal(`Relatório de ${rotuloMes(mes)} · ${casa.nome}`, `
    <div class="rel-dono">
      <label>Proprietário<input name="dono_nome" value="${h(dono.nome)}" placeholder="Nome do dono da casa"></label>
      <label>E-mail<input name="dono_email" type="email" value="${h(dono.email)}" placeholder="dono@exemplo.com"></label>
      <label>Comissão (%)<input name="comissao_pct" type="number" min="0" max="100" step="0.5" value="${h(dono.comissao_pct ?? '')}" placeholder="0"></label>
    </div>
    <h3 class="rel-h">Reservas com entrada no mês</h3>
    ${doMes.length ? `<table class="table rel-res"><thead><tr><th>Hóspede</th><th>Datas</th><th>Origem</th><th class="num">Valor (R$)</th></tr></thead><tbody>
      ${doMes.map(b => `<tr><td>${h(b.hospede || 'Hóspede')}</td><td>${dataBr(b.checkin).slice(0, 5)} a ${dataBr(b.checkout).slice(0, 5)}</td><td>${h(ORIGEM[b.origem] || b.origem)}</td>
        <td class="num"><input name="v:${h(b.id)}" type="number" min="0" step="0.01" inputmode="decimal" value="${h(b.valor ?? '')}" placeholder="${b.origem === 'airbnb' ? 'repasse' : 'valor'}" aria-label="Valor da reserva de ${h(b.hospede || 'hóspede')}"></td></tr>`).join('')}
    </tbody></table>` : '<p class="empty">Nenhuma reserva confirmada com entrada no mês.</p>'}
    <h3 class="rel-h">Despesas da casa <small class="muted">(Finanças · Aluguéis · ${h(casa.nome)})</small></h3>
    <div id="relDesp"></div>
    <label>Outras despesas <small class="muted">(uma por linha: descrição e valor)</small><textarea name="ajustes" rows="3" placeholder="Faxina extra 150&#10;Lâmpadas 42,90">${h(ajustesTxt(salvo.ajustes))}</textarea></label>
    <dl class="pipe-sum rel-resumo" id="relResumo"></dl>
    <p class="modal-err" id="relAviso" role="alert"></p>`, {
    submit: 'Salvar',
    extra: '<button type="button" class="btn" id="relPdf">Baixar PDF</button><button type="button" class="btn" id="relEnviar">Enviar ao proprietário</button>',
    onSubmit: async () => { await gravar(estado()); toast('Relatório salvo'); },
  });
  const $ = s => d.querySelector(s);
  const campo = n => d.querySelector(`[name="${n}"]`);

  // Lançamentos com a casa (marcados = entram) e os sem casa, com "é desta casa"
  function despesas() {
    const daCasa = tx.filter(t => t.casa === casa.id && +t.valor < 0), sem = despesasSemCasa(tx, mes);
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
    return r;
  }

  // Grava o valor das reservas (o do Airbnb fica na reserva) e, na casa, o dono e a revisão do mês
  async function gravar(st, extra = {}) {
    for (const [id, valor] of Object.entries(st.valores)) {
      const b = S.bookings.find(x => x.id === id);
      if (b && (b.valor ?? null) !== valor) await db.update('bookings', id, { valor });
    }
    const atual = S.properties.find(p => p.id === casa.id) || casa;
    await save('properties', { dono: st.dono, relatorios: { ...(atual.relatorios || {}), [mes]: { ...(atual.relatorios?.[mes] || {}), ajustes: st.ajustes, excluidas: st.excluidas, ...extra } } }, casa.id);
  }

  d.querySelector('#modalForm').oninput = resumo;
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
  $('#relEnviar').onclick = async ev => {
    const btn = ev.target, aviso = $('#relAviso'), st = estado(), r = resumo();
    aviso.textContent = '';
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i.test(st.dono.email)) { aviso.textContent = 'Preencha o e-mail do proprietário.'; return; }
    if (r.semValor) { aviso.textContent = `Preencha o valor de ${r.semValor === 1 ? 'uma reserva' : r.semValor + ' reservas'} (no Airbnb, o repasse) antes de enviar.`; return; }
    if (db.mode !== 'supabase') { aviso.textContent = 'O envio precisa do Hub conectado ao Supabase.'; return; }
    if (!confirmInline(btn)) return;
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const { assunto, corpo, arquivo } = emailRelatorio(r);
      const { data, error } = await db.client().functions.invoke('relatorio-enviar', { body: { para: st.dono.email, assunto, corpo, pdf: base64(pdfRelatorio(r)), arquivo } });
      if (error || data?.error) throw new Error(data?.error || error.message);
      await gravar(st, { enviado_em: new Date().toISOString(), para: st.dono.email, repasse: r.repasse });
      closeModal();
      toast(`Relatório de ${rotuloMes(mes)} enviado para ${st.dono.email}`, 4000);
    } catch (e) {
      aviso.textContent = `Não consegui enviar: ${e.message}`;
      btn.disabled = false; btn.textContent = 'Enviar ao proprietário';
    }
  };
  if (enviado(casa, mes)) $('#relAviso').textContent = `Já enviado em ${dataBr(salvo.enviado_em.slice(0, 10))}${salvo.para ? ' para ' + salvo.para : ''}. Enviar de novo manda outra cópia.`;
  despesas(); resumo();
  return d;
}
