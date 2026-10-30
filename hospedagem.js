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
    const m = l.match(/^(.+?)\s*(?:[,;|]|\s[-–—]\s|\t)\s*(.+)$/);
    return m ? { nome: m[1].trim(), doc: m[2].trim().replace(/\s*\|\s*/g, ' ') } : { nome: l, doc: '' };
  });
}
export const hospedesTxt = l => (Array.isArray(l) ? l : []).map(x => x.doc ? `${x.nome}, ${x.doc}` : x.nome).join('\n');

// Veículos: placa antiga (ABC-1234) ou Mercosul (ABC1D23). "Honda HRV, TZX3D00" <-> [{modelo, placa}]
const PLACA = /\b([A-Z]{3})[\s-]?(\d[A-Z0-9]\d{2})\b/i;
const veiculoDaLinha = l => {
  const m = l.match(PLACA);
  const modelo = l.replace(PLACA, '').replace(/\b(placa|carro|ve[ií]culo)\b\s*:?/gi, '').replace(/^[\s|,;:–—-]+|[\s|,;:–—-]+$/g, '').replace(/\s+/g, ' ');
  return m ? { modelo, placa: (m[1] + m[2]).toUpperCase() } : null;
};
export const temPlaca = l => PLACA.test(l);
export function parseVeiculos(txt) {
  return (txt || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => veiculoDaLinha(l) || { modelo: l, placa: '' });
}
export const veiculosTxt = l => (Array.isArray(l) ? l : []).map(v => [v.modelo, v.placa].filter(Boolean).join(', ')).join('\n');
// Do texto cru, só as linhas com placa
export const lerVeiculosCru = txt => (txt || '').split('\n').map(l => veiculoDaLinha(l.trim())).filter(Boolean);
export function juntarVeiculos(lista, txtCru) {
  const out = (lista || []).map(v => ({ ...v }));
  const novos = lerVeiculosCru(txtCru);
  for (const v of novos) if (!out.some(x => x.placa === v.placa)) out.push(v);
  return { lista: out, novos: novos.length };
}

// ---------- Dados crus (WhatsApp, Airbnb, lista solta) -> [{nome, doc}] ----------
const TIPOS_DOC = [['CPF', /^cpf\b/i], ['RG', /^(rg|identidade|carteira de identidade)\b/i], ['CNH', /^(cnh|habilita[çc][aã]o)\b/i],
  ['Passaporte', /^(passaporte|passport)\b/i], ['RNM', /^(rnm|rne)\b/i], ['DNI', /^dni\b/i], ['', /^(doc(umento)?|n[º°o]\.?)\b/i]];
const ROTULO_DOC = /^(?:cpf|rg|identidade|carteira de identidade|cnh|habilita[çc][aã]o|passaporte|passport|rnm|rne|dni|doc(?:umento)?)\b/i;
const ORGAO = /\b(SSP|SDS|SESP|SSPDS|PC|PCRN|DETRAN|IFP|IGP|DGPC|SEJUSP|DIC)\s*[/-]\s*([A-Z]{2})\b/i;
// "Claudio Braga" é a assinatura do próprio e-mail (quando ele cola um e-mail antigo)
const RUIDO = /\b(segue|seguem|ol[aá]|oi|bom dia|boa tarde|boa noite|obrigad|abra[cç]o|atenciosamente|dados|lista|check|casa|entrada|sa[ií]da|reserva|chegada|pessoas|adultos|crian[çc]as|ve[ií]culos?|claudio braga)\b/i;
const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
const fmtCpf = d => d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

// "MARIA DA SILVA" / "maria da silva" -> "Maria da Silva"; nome já escrito com maiúsculas e minúsculas fica como está
export function nomeProprio(s) {
  s = s.replace(/\s+/g, ' ').trim();
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;
  return s.toLowerCase().split(' ').map((w, i) => i && PARTICULAS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// "todos os RGs são SSP/PE" -> "SSP/PE"
export function orgaoGeral(txt) {
  const l = (txt || '').split('\n').find(l => /\btod[oa]s\b/i.test(l) && /\bRGs?\b/i.test(l) && ORGAO.test(l));
  if (!l) return '';
  const m = l.match(ORGAO);
  return `${m[1].toUpperCase()}/${m[2].toUpperCase()}`;
}

// Normaliza um documento: "cpf: 12345678900" -> "CPF 123.456.789-00"; "rg 1.234.567 ssp/pe" -> "RG 1.234.567 SSP/PE"
export function normDoc(raw, orgao = '') {
  let s = raw.trim().replace(/^[:\-–—=,;\s]+/, '');
  let tipo = null;
  for (const [t, re] of TIPOS_DOC) if (re.test(s)) { tipo = t; s = s.replace(re, ''); break; }
  s = s.replace(/^[\s:.\-–—=]*(n[º°o]\.?\s*)?/i, '').trim();
  const dig = s.replace(/\D/g, '');
  if (tipo === 'CPF' || (!tipo && dig.length === 11 && /^[\d.\-\s/]+$/.test(s))) return dig.length === 11 ? `CPF ${fmtCpf(dig)}` : `CPF ${s}`;
  if (tipo === 'RG') {
    const m = s.match(ORGAO);
    const num = (m ? s.replace(ORGAO, '') : s).replace(/[\s,;|-]+$/, '').trim();
    const org = m ? `${m[1].toUpperCase()}/${m[2].toUpperCase()}` : orgao;
    return `RG ${num}${org ? ' ' + org : ''}`;
  }
  return tipo ? `${tipo} ${s.toUpperCase()}` : s;
}

// Lê texto bagunçado: lista numerada, "Hóspede 01 / Nome: / CPF: / RG:", "Nome 123.456.789-00", conversa do WhatsApp.
// Com CPF e RG da mesma pessoa, fica o CPF (a portaria aceita qualquer um; o CPF é o mais curto de conferir).
export function lerHospedesCru(txt, orgao = orgaoGeral(txt)) {
  const lista = [];
  let atual = null, bloco = false;
  const novo = () => { atual = { nome: '', docs: [] }; lista.push(atual); };
  const nome = n => { if (!atual || atual.nome) novo(); atual.nome = n; };
  const doc = d => { if (!atual) novo(); atual.docs.push(normDoc(d, orgao)); };
  for (let l of (txt || '').split('\n')) {
    l = l.trim()
      .replace(/^\[[^\]]{4,30}\]\s*[^:]{1,40}:\s*/, '') // [10:32, 20/10/2026] Fulano:
      .replace(/[*_~]/g, '') // formatação do WhatsApp: *negrito*, _itálico_, ~riscado~
      .trim()
      .replace(/^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}\s+-\s+[^:]{1,40}:\s*/, '') // 20/10/2026 10:32 - Fulano:
      .replace(/^(?:\d{1,2}\s*[)º°]\s*|\d{1,2}\s*[.\-–]\s+|[•*·–-]\s+)/, '') // 1) 1. 1 - • -
      .trim();
    if (!l || temPlaca(l)) continue; // veículo: lerVeiculosCru
    if (/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(l)) continue; // período/data: nunca é linha de hóspede
    if (/^h[oó]spedes?\s*(n[º°o]\.?\s*)?\d*\s*:?$/i.test(l)) { if (/\d/.test(l)) { novo(); bloco = true; } continue; }
    if (/\btod[oa]s\b/i.test(l) && /\bRGs?\b/i.test(l)) continue;
    const rot = l.match(/^nome(?:\s+completo)?\s*[:\-=]\s*(.+)$/i);
    if (rot) { nome(nomeProprio(rot[1])); continue; }
    if (ROTULO_DOC.test(l) || /^[A-Z]{0,2}[\d.\-/\s]{5,}[A-Z/\s]*$/i.test(l) && /\d{5}/.test(l.replace(/\D/g, ''))) { doc(l); continue; }
    // nome e documento na mesma linha
    const m = l.match(/^(.*?[A-Za-zÀ-ÿ])\s*(?:[,;:|–—-]\s*|\s+)((?:cpf|rg|cnh|passaporte|passport|rnm|rne|dni|doc(?:umento)?|identidade)\b.*|[A-Z]{0,2}\d[\d.\-/ ]{4,}.*)$/i);
    if (m && /^[A-Za-zÀ-ÿ'´. -]+$/.test(m[1]) && !RUIDO.test(m[1]) && m[1].split(/\s+/).length <= 8) { nome(nomeProprio(m[1])); doc(m[2]); continue; }
    // só o nome: pelo menos 2 palavras (ou 1 dentro de um bloco "Hóspede 01"), sem cara de frase
    if (/^[A-Za-zÀ-ÿ'´. -]+$/.test(l) && !RUIDO.test(l) && (l.split(/\s+/).length >= 2 || bloco) && l.split(/\s+/).length <= 8) nome(nomeProprio(l));
  }
  return lista.filter(x => x.nome || x.docs.length).map(x => ({ nome: x.nome, doc: x.docs.find(d => d.startsWith('CPF')) || x.docs[0] || '' }));
}

// Acrescenta os novos à lista (sem repetir o mesmo nome) e aplica o órgão geral aos RGs sem órgão
const chave = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
export function juntarHospedes(lista, txtCru) {
  const orgao = orgaoGeral(txtCru);
  const out = (lista || []).map(x => ({ ...x }));
  const novos = lerHospedesCru(txtCru, orgao);
  for (const n of novos) {
    const ja = n.nome && out.find(x => chave(x.nome) === chave(n.nome));
    if (ja) { if (!ja.doc && n.doc) ja.doc = n.doc; } else out.push(n);
  }
  if (orgao) for (const x of out) if (/^RG\s/.test(x.doc) && !ORGAO.test(x.doc)) x.doc = `${x.doc} ${orgao}`;
  return { lista: out, novos: novos.length, orgao };
}

// ---------- E-mail para a portaria do Condomínio Pipa Natureza (modelo do Claudio) ----------
const dBR = iso => iso.split('-').reverse().join('/');
export const casaRotulo = c => `${c.nome}${c.id ? ' ' + c.id : ''}`; // "Casa Frida QS39"
// "RG 2392336 SDS/PE" -> "RG 2392336 | SDS/PE"
const docLinha = d => d.replace(new RegExp(`\\s+(${ORGAO.source})$`, 'i'), ' | $1');

export function emailPortaria(b, casa) {
  const lista = Array.isArray(b.hospedes) ? b.hospedes.filter(x => x.nome || x.doc) : [];
  const veiculos = Array.isArray(b.veiculos) ? b.veiculos.filter(v => v.modelo || v.placa) : [];
  // "(20/11 a 23/11/2026)"; virando o ano, as duas datas levam o ano
  const ini = b.checkin.slice(0, 4) === b.checkout.slice(0, 4) ? dBR(b.checkin).slice(0, 5) : dBR(b.checkin);
  const rot = casaRotulo(casa);
  const assunto = `Autorização de Acesso — ${rot} — Hóspedes (${ini} a ${dBR(b.checkout)})`;
  const corpo = `Segue abaixo a lista de hóspedes autorizados para o período de ${dBR(b.checkin)} a ${dBR(b.checkout)}:

${rot}

${lista.length ? lista.map((x, i) => `${i + 1}. ${x.nome || '(nome a confirmar)'} | ${x.doc ? docLinha(x.doc) : 'documento a enviar'}`).join('\n') : '(lista de hóspedes ainda não preenchida)'}
${veiculos.length ? `
Veículos autorizados:
${veiculos.map(v => `— ${[v.modelo, v.placa].filter(Boolean).join(' | ')}`).join('\n')}
` : ''}
Solicito a liberação de acesso para os hóspedes listados acima durante o período indicado.

Qualquer dúvida, fico à disposição.

Atenciosamente,
Claudio Braga`;
  return { assunto, corpo };
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
    <label>Veículos (um por linha: modelo, placa)<textarea name="veiculos" rows="2" placeholder="Honda HRV, TZX3D00">${h(veiculosTxt(b.veiculos))}</textarea></label>
    <div class="row-btns"><button type="button" class="link-btn" id="copyAssunto">Copiar assunto</button>
    <button type="button" class="link-btn" id="copyPortaria">Copiar e-mail para a portaria</button></div>
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
  const copiar = (sel, parte, rotulo) => m.querySelector(sel).onclick = async ev => {
    const tmp = {
      checkin: m.querySelector('[name=checkin]').value, checkout: m.querySelector('[name=checkout]').value,
      hospedes: parseHospedes(m.querySelector('[name=hospedes]').value),
      veiculos: parseVeiculos(m.querySelector('[name=veiculos]').value),
    };
    const btn = ev.target;
    if (!tmp.checkin || !tmp.checkout) { btn.textContent = 'Preencha check-in e check-out'; return; }
    try {
      await navigator.clipboard.writeText(emailPortaria(tmp, getCasa())[parte]);
      btn.textContent = parte === 'corpo' ? 'Copiado. Depois de enviar, marque a etapa acima.' : 'Assunto copiado';
    } catch { btn.textContent = 'Não consegui copiar neste navegador'; }
    setTimeout(() => (btn.textContent = rotulo), 4000);
  };
  copiar('#copyAssunto', 'assunto', 'Copiar assunto');
  copiar('#copyPortaria', 'corpo', 'Copiar e-mail para a portaria');
  sync();
}

// Lê o formulário e devolve {etapas, hospedes, veiculos}
export function lerChecklist(f, b) {
  let et = { ...(b.etapas || {}) };
  for (const e of ETAPAS_HOSP) et = alternar({ etapas: et }, e.id, !!f['et_' + e.id]);
  for (const e of ETAPAS_HOSP) delete f['et_' + e.id];
  const hospedes = parseHospedes(f.hospedes), veiculos = parseVeiculos(f.veiculos);
  delete f.hospedes; delete f.veiculos;
  return { etapas: et, hospedes, veiculos };
}
