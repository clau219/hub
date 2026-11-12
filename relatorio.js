// Relatório mensal de cada casa para o proprietário: reservas, ocupação, receita, despesas, comissão e repasse.
// Funções puras: a tela (v-relatorio.js) junta os dados, deixa revisar e envia; o PDF sai de relatorio-pdf.js.
// Regras: receita = reservas confirmadas com ENTRADA no mês (o valor que ficou para a casa; no Airbnb, o repasse, já sem a
// taxa dele); ocupação = noites ocupadas dentro do mês; despesas = lançamentos de Finanças do negócio Aluguéis marcados com
// a casa, menos os desmarcados na revisão, mais as "outras despesas" digitadas; comissão = % sobre a receita.
import { addDays, diffDays, mesNome } from './util.js';

export const centavos = v => Math.round((+v || 0) * 100) / 100;
export const brl2 = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const dataBr = iso => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';

// 'YYYY-MM' do mês anterior a uma data ISO
export function mesAnterior(iso) {
  const [y, m] = iso.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export const rotuloMes = mes => `${mesNome(+mes.slice(5) - 1)}/${mes.slice(0, 4)}`; // "outubro/2026"
export function limitesMes(mes) {
  const ini = mes + '-01';
  const [y, m] = mes.split('-').map(Number);
  const fim = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; // exclusivo
  return { ini, fim, dias: diffDays(ini, fim) };
}

// "Faxina extra 150" / "Lâmpadas; 42,90" / "Conserto do portão - R$ 1.200,00" → { descricao, valor }
export function lerAjustes(txt) {
  return String(txt || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(.*?)[\s;:–—-]*?(?:R\$\s*)?(-?\d[\d.]*(?:,\d{1,2})?)$/); // "-50" colado = crédito; "- 50" = separador
    if (!m || !m[1].trim()) return null;
    const n = m[2].includes(',') ? m[2].replace(/\./g, '').replace(',', '.') : /^-?\d{1,3}(\.\d{3})+$/.test(m[2]) ? m[2].replace(/\./g, '') : m[2];
    return { descricao: m[1].trim(), valor: centavos(n) };
  }).filter(a => a && a.valor);
}
export const ajustesTxt = l => (l || []).map(a => `${a.descricao} ${String(a.valor).replace('.', ',')}`).join('\n');

// Despesas de Aluguéis sem casa definida no mês (o repasse do Airbnb é entrada e fica de fora): a tela oferece "é desta casa"
export const despesasSemCasa = (tx, mes) =>
  tx.filter(t => t.negocio === 'alugueis' && !t.casa && +t.valor < 0 && t.data?.startsWith(mes)).sort((a, b) => a.data.localeCompare(b.data));

export function montarRelatorio({ casa, mes, bookings = [], tx = [], dono = {}, ajustes = [], excluidas = [] }) {
  const { ini, fim, dias } = limitesMes(mes);
  const daCasa = bookings.filter(b => b.property_id === casa.id && b.status === 'confirmada');
  const reservas = daCasa.filter(b => b.checkin >= ini && b.checkin < fim).sort((a, b) => a.checkin.localeCompare(b.checkin))
    .map(b => ({ id: b.id, hospede: b.hospede || 'Hóspede', origem: b.origem, checkin: b.checkin, checkout: b.checkout,
      noites: diffDays(b.checkin, b.checkout), valor: b.valor == null || b.valor === '' ? null : centavos(b.valor) })); // 0 vale (estadia do próprio dono)
  const noites = daCasa.reduce((s, b) => s + Math.max(0, diffDays(b.checkin > ini ? b.checkin : ini, b.checkout < fim ? b.checkout : fim)), 0);
  const fora = new Set(excluidas);
  const despesas = [
    ...tx.filter(t => t.negocio === 'alugueis' && t.casa === casa.id && +t.valor < 0 && t.data?.startsWith(mes) && !fora.has(t.id))
      .map(t => ({ id: t.id, data: t.data, descricao: t.descricao || t.categoria || 'Despesa', valor: centavos(-t.valor) })),
    ...ajustes.map(a => ({ data: null, descricao: a.descricao, valor: centavos(a.valor) })),
  ].sort((a, b) => (a.data || '9').localeCompare(b.data || '9'));
  const receita = centavos(reservas.reduce((s, r) => s + (r.valor || 0), 0));
  const totalDespesas = centavos(despesas.reduce((s, d) => s + d.valor, 0));
  const comissaoPct = +dono.comissao_pct || 0;
  const comissao = centavos(receita * comissaoPct / 100);
  const ateProx = addDays(fim, 90);
  const proximas = daCasa.filter(b => b.checkin >= fim && b.checkin < ateProx).sort((a, b) => a.checkin.localeCompare(b.checkin))
    .map(b => ({ hospede: b.hospede || 'Hóspede', origem: b.origem, checkin: b.checkin, checkout: b.checkout, noites: diffDays(b.checkin, b.checkout) }));
  return {
    casa: { id: casa.id, nome: casa.nome, cor: casa.cor }, mes, dono: { nome: dono.nome || '', email: dono.email || '' },
    reservas, semValor: reservas.filter(r => r.valor == null).length, noites, dias, ocupacao: Math.round(noites / dias * 100),
    despesas, receita, totalDespesas, comissaoPct, comissao, repasse: centavos(receita - comissao - totalDespesas), proximas,
  };
}

const primeiroNome = n => (n || '').trim().split(/\s+/)[0] || '';
export function emailRelatorio(r) {
  const nome = primeiroNome(r.dono.nome);
  const assunto = `Relatório de ${rotuloMes(r.mes)} — ${r.casa.nome}`;
  const corpo = [
    nome ? `Olá, ${nome}!` : 'Olá!', '',
    `Segue em anexo o relatório de ${rotuloMes(r.mes)} da ${r.casa.nome}.`, '',
    'Resumo:',
    `• Reservas: ${r.reservas.length} (${r.noites} ${r.noites === 1 ? 'noite ocupada' : 'noites ocupadas'}, ocupação de ${r.ocupacao}%)`,
    `• Receita: ${brl2(r.receita)}`,
    `• Despesas: ${brl2(r.totalDespesas)}`,
    ...(r.comissaoPct ? [`• Comissão de administração (${String(r.comissaoPct).replace('.', ',')}%): ${brl2(r.comissao)}`] : []),
    `• ${r.repasse < 0 ? 'Saldo negativo do mês' : 'Valor a repassar'}: ${brl2(Math.abs(r.repasse))}`, '',
    'Qualquer dúvida, fico à disposição.', '',
    'Atenciosamente,', 'Claudio Braga',
  ].join('\n');
  // nome do anexo sem acento (alguns leitores de e-mail estragam o nome acentuado)
  const arquivo = `Relatorio ${r.casa.nome} ${r.mes}.pdf`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w .-]/g, '');
  return { assunto, corpo, arquivo };
}

// ---------- Repasse do Airbnb → valor da reserva ----------
// O repasse entra em Finanças (Pluggy) sem casa, cerca de 1 dia depois do check-in. Sugere o valor só quando o par
// reserva × repasse é único nos dois sentidos (duas casas com entrada no mesmo dia ficam para você decidir).
export const ehRepasseAirbnb = t => +t.valor > 0 && !t.casa && (t.categoria === 'Airbnb' || /airbnb/i.test(`${t.descricao || ''} ${t.contraparte || ''}`));
// Reserva de canal (Airbnb, Decolar, Booking): a do iCal antigo do Airbnb ou a que chega pela Stays (origem 'outro' com
// uid de calendário). As diretas do Hub não têm uid_externo.
export const deCanal = b => b.origem === 'airbnb' || (b.origem === 'outro' && !!b.uid_externo);
export function sugerirRepasses(bookings, tx, janela = 3) {
  const reservas = bookings.filter(b => deCanal(b) && b.status === 'confirmada' && (b.valor == null || b.valor === ''));
  const pagos = tx.filter(ehRepasseAirbnb);
  const cand = r => pagos.filter(t => { const d = diffDays(r.checkin, t.data); return d >= 0 && d <= janela; });
  const out = {};
  for (const r of reservas) {
    const c = cand(r);
    if (c.length !== 1 || reservas.filter(o => cand(o).includes(c[0])).length !== 1) continue;
    out[r.id] = { tx_id: c[0].id, valor: centavos(c[0].valor), data: c[0].data };
  }
  return out;
}

// ---------- Depois do envio ----------
// Totais guardados no envio; ao reabrir, o que mudou desde então (reserva ou despesa editada depois)
const TOTAIS = [['receita', 'Receita'], ['totalDespesas', 'Despesas'], ['comissao', 'Comissão'], ['repasse', 'Repasse']];
export const totaisEnviados = r => Object.fromEntries(TOTAIS.map(([k]) => [k, r[k]]));
export function mudouDesdeEnvio(r, salvo = {}) {
  if (!salvo.enviado_em) return [];
  const antes = salvo.totais || (salvo.repasse != null ? { repasse: salvo.repasse } : {});
  return TOTAIS.filter(([k]) => k in antes && Math.abs(antes[k] - r[k]) >= 0.01).map(([k, nome]) => ({ nome, antes: antes[k], agora: r[k] }));
}
export const textoMudancas = l => l.map(m => `${m.nome} ${brl2(m.antes)} → ${brl2(m.agora)}`).join('; ');

// Saída da sua conta com o valor exato do repasse, de 2 dias antes a 20 dias depois do envio: provável pagamento ao dono
export function sugerirPagamento(salvo = {}, tx = []) {
  if (!salvo.enviado_em || !(salvo.repasse > 0)) return null;
  const env = salvo.enviado_em.slice(0, 10), ini = addDays(env, -2), fim = addDays(env, 20);
  return tx.filter(t => +t.valor < 0 && Math.abs(-t.valor - salvo.repasse) < 0.01 && t.data >= ini && t.data <= fim)
    .sort((a, b) => a.data.localeCompare(b.data))[0] || null;
}
export const janelaPagamento = salvo => ({ ini: addDays(salvo.enviado_em.slice(0, 10), -2), fim: addDays(salvo.enviado_em.slice(0, 10), 20) });
