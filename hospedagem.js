// Sequência operacional de cada hospedagem: etapas com prazo contado a partir do check-in.
// Reservas diretas passam pelas 6 etapas; Airbnb/Booking só pelas 3 últimas (a plataforma cuida do resto).
import { h, today, addDays, fmtDate, relDate } from './util.js';

export const ETAPAS_HOSP = [
  { id: 'orcamento', nome: 'Enviar orçamento', dias: -21, direto: true },
  { id: 'contrato', nome: 'Enviar contrato', dias: -14, direto: true },
  { id: 'assinatura', nome: 'Receber contrato assinado', dias: -10, direto: true },
  { id: 'hospedes', nome: 'Receber nomes e documentos dos hóspedes', dias: -3 },
  { id: 'portaria', nome: 'Enviar lista para a portaria', dias: -2 },
  { id: 'faxina', nome: 'Confirmar faxina da casa', dias: -1 },
];

const completo = b => !['airbnb', 'booking'].includes(b.origem);
export const etapasDe = b => ETAPAS_HOSP.filter(e => !e.direto || completo(b));
export const prazo = (b, e) => addDays(b.checkin, e.dias);
export const feita = (b, e) => !!(b.etapas && b.etapas[e.id]);
export const pendentes = b => etapasDe(b).filter(e => !feita(b, e));

// Só acompanha reservas confirmadas que ainda não começaram
export const acompanhada = b => b.status === 'confirmada' && b.checkin >= today();

export function progresso(b) {
  const l = etapasDe(b);
  return { feitas: l.filter(e => feita(b, e)).length, total: l.length, proxima: pendentes(b)[0] };
}

// Marca/desmarca uma etapa; devolve o novo objeto etapas
export function alternar(b, id, on) {
  const et = { ...(b.etapas || {}) };
  if (on) et[id] = et[id] || today(); else delete et[id];
  return et;
}

// "Nome, documento" por linha  <->  [{nome, doc}]
export function parseHospedes(txt) {
  return (txt || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(.+?)\s*(?:[,;]|\s[-–—]\s|\t)\s*(.+)$/);
    return m ? { nome: m[1].trim(), doc: m[2].trim() } : { nome: l, doc: '' };
  });
}
export const hospedesTxt = l => (Array.isArray(l) ? l : []).map(x => x.doc ? `${x.nome}, ${x.doc}` : x.nome).join('\n');

const dBR = iso => iso.split('-').reverse().join('/');
export function textoPortaria(b, casa) {
  const lista = Array.isArray(b.hospedes) ? b.hospedes : [];
  return `Olá, boa tarde.

Autorizo a entrada dos hóspedes abaixo na ${casa.nome}${casa.id ? ` (${casa.id})` : ''}, com entrada em ${dBR(b.checkin)} e saída em ${dBR(b.checkout)}:

${lista.length ? lista.map((x, i) => `${i + 1}. ${x.nome}${x.doc ? ` (${x.doc})` : ''}`).join('\n') : '(lista de hóspedes ainda não preenchida)'}

Obrigado,
Claudio`;
}

// Bloco de checklist dentro do formulário da reserva
export function checklistHtml(b) {
  const tmp = { origem: b.origem || 'direto', checkin: b.checkin, etapas: b.etapas };
  return `<fieldset class="next hosp" id="fHosp">
    <legend>Sequência da hospedagem</legend>
    <ol class="hosp-steps">
      ${ETAPAS_HOSP.map(e => {
        const on = feita(tmp, e);
        const pz = tmp.checkin ? prazo(tmp, e) : null;
        const late = !on && pz && pz < today();
        return `<li data-step="${e.id}" ${e.direto ? 'data-direto' : ''} ${e.direto && !completo(tmp) ? 'hidden' : ''}>
          <label class="chk"><input type="checkbox" name="et_${e.id}" ${on ? 'checked' : ''}> ${h(e.nome)}</label>
          <span class="hosp-when ${late ? 'late-lbl' : ''}" data-dias="${e.dias}">${on ? `feito ${fmtDate(b.etapas[e.id])}` : pz ? `até ${relDate(pz)}` : ''}</span>
        </li>`;
      }).join('')}
    </ol>
    <label>Hóspedes (um por linha: nome, documento)<textarea name="hospedes" rows="3" placeholder="Maria Silva, RG 1.234.567&#10;João Souza, CPF 123.456.789-00">${h(hospedesTxt(b.hospedes))}</textarea></label>
    <button type="button" class="link-btn" id="copyPortaria">Copiar mensagem para a portaria</button>
  </fieldset>`;
}

// Liga os comportamentos do checklist no modal aberto
export function bindChecklist(m, getCasa, b) {
  const sync = () => {
    const origem = m.querySelector('[name=origem]').value;
    const checkin = m.querySelector('[name=checkin]').value;
    const bloq = m.querySelector('[name=status]').value !== 'confirmada';
    m.querySelector('#fHosp').hidden = bloq;
    m.querySelectorAll('#fHosp [data-direto]').forEach(li => (li.hidden = !completo({ origem })));
    m.querySelectorAll('#fHosp li').forEach(li => {
      const cb = li.querySelector('input'), w = li.querySelector('.hosp-when');
      if (cb.checked) { w.textContent = `feito ${fmtDate(b.etapas?.[li.dataset.step] || today())}`; w.classList.remove('late-lbl'); return; }
      if (!checkin) { w.textContent = ''; return; }
      const pz = addDays(checkin, +w.dataset.dias);
      w.textContent = `até ${relDate(pz)}`;
      w.classList.toggle('late-lbl', pz < today());
    });
  };
  ['origem', 'checkin', 'status'].forEach(n => m.querySelector(`[name=${n}]`).addEventListener('change', sync));
  m.querySelectorAll('#fHosp input[type=checkbox]').forEach(c => c.addEventListener('change', sync));
  m.querySelector('#copyPortaria').onclick = async ev => {
    const tmp = {
      checkin: m.querySelector('[name=checkin]').value, checkout: m.querySelector('[name=checkout]').value,
      hospedes: parseHospedes(m.querySelector('[name=hospedes]').value),
    };
    const btn = ev.target;
    if (!tmp.checkin || !tmp.checkout) { btn.textContent = 'Preencha check-in e check-out'; return; }
    try {
      await navigator.clipboard.writeText(textoPortaria(tmp, getCasa()));
      btn.textContent = 'Copiado. Depois de enviar, marque a etapa acima.';
    } catch { btn.textContent = 'Não consegui copiar neste navegador'; }
    setTimeout(() => (btn.textContent = 'Copiar mensagem para a portaria'), 4000);
  };
  sync();
}

// Lê o formulário e devolve {etapas, hospedes}
export function lerChecklist(f, b) {
  let et = { ...(b.etapas || {}) };
  for (const e of ETAPAS_HOSP) et = alternar({ etapas: et }, e.id, !!f['et_' + e.id]);
  for (const e of ETAPAS_HOSP) delete f['et_' + e.id];
  const hospedes = parseHospedes(f.hospedes);
  delete f.hospedes;
  return { etapas: et, hospedes };
}
