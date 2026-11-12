// Avisos de reserva que a Stays manda por e-mail ("Stays.net | Atualização sobre a Reserva YY01J | NOME"):
// lerEmailStays() tira os campos do texto; aplicarEmailsStays() completa as reservas do Hub (tabela stays_emails).
// Usado pela função stays-email (o Apps Script do Gmail entrega os e-mails) e pelo ical-sync (a reserva costuma
// aparecer no Hub depois do e-mail).

export type EmailStays = {
  codigo: string; status: string | null; hospede: string | null; contatos: string | null; pessoas: number | null;
  checkin: string | null; checkout: string | null; noites: number | null; valor: number | null;
  acomodacao: string | null; canal: string | null; comissao: number | null;
};

const MESES: Record<string, string> = { jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06', jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12' };
const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const vazio = (s: string | undefined | null) => { const t = (s || '').trim(); return t && t !== '-' ? t : null; };
const data = (d: string, m: string, a: string) => { const mm = MESES[semAcento(m).slice(0, 3)]; return mm ? `${a}-${mm}-${d.padStart(2, '0')}` : null; };
export const dinheiro = (s: string | null) => {
  const m = (s || '').match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/);
  return m ? Number(m[1].replace(/\./g, '') + '.' + (m[2] || '0')) : null;
};

export function lerEmailStays(assunto: string, corpo: string): EmailStays | null {
  // getPlainBody do Gmail: negrito vira *texto*, links viram <https://...>, quebras \r\n
  const texto = String(corpo || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\*/g, '').replace(/\r/g, '');
  const codigo = (String(assunto || '').match(/Reserva\s+([A-Z0-9]{3,8})\b/) || texto.match(/A Reserva\s+([A-Z0-9]{3,8})\b/))?.[1];
  if (!codigo || !/stays/i.test(`${assunto} ${texto}`)) return null;
  const campo = (rotulo: string) => vazio(texto.match(new RegExp(`${rotulo}\\s*:[ \\t]*([^\\n]*)`, 'i'))?.[1]);
  const per = texto.match(/Per[ií]odo da Estadia\s*:\s*de\s+(\d{1,2})\s+([A-Za-zç]+)\.?\s+(\d{4})\s+a\s+(\d{1,2})\s+([A-Za-zç]+)\.?\s+(\d{4})/i);
  const num = (s: string | null) => (s && /\d/.test(s) ? parseInt(s.replace(/\D/g, ''), 10) : null);
  return {
    codigo,
    status: texto.match(/status\s+([\wÀ-ú-]+)\s+atualmente/i)?.[1]?.toLowerCase() || null,
    hospede: campo('Nome do H[óo]spede'),
    contatos: campo('Contatos do H[óo]spede'),
    pessoas: num(campo('N[úu]mero de H[óo]spedes')),
    checkin: per ? data(per[1], per[2], per[3]) : null,
    checkout: per ? data(per[4], per[5], per[6]) : null,
    noites: num(campo('N[úu]mero de Noites')),
    valor: dinheiro(campo('Valor Total da Reserva')),
    acomodacao: campo('Acomoda[çc][ãa]o'),
    canal: campo('Canal de Venda'),
    comissao: dinheiro(campo('Comiss[ãa]o do Canal')),
  };
}

// Casa do Hub pelo nome do anúncio ("Casa Frida no Condomínio Pipa Natureza" → a propriedade "Casa Frida")
export function casaDaAcomodacao(acomodacao: string | null, props: { id: string; nome: string }[]) {
  if (!acomodacao) return null;
  const a = semAcento(acomodacao);
  const p = props.filter(x => x.nome && a.includes(semAcento(x.nome))).sort((x, y) => y.nome.length - x.nome.length)[0];
  return p?.id || null;
}

const GENERICOS = /^(h[óo]spede( \(stays\)| airbnb)?|reserved|reserva|not available)$/i;
const CANAL_ORIGEM: Record<string, string> = { airbnb: 'airbnb', booking: 'booking', 'booking.com': 'booking' };
const CANCELADO = /cancel|delet|exclu/i;

// Linha das notas que o e-mail mantém (troca a anterior, não acumula)
const LINHA = 'E-mail Stays: ';
function notasCom(notas: string | null, e: any) {
  const partes = [e.canal ? `canal ${e.canal}` : 'reserva manual', e.pessoas ? `${e.pessoas} hóspede${e.pessoas > 1 ? 's' : ''}` : null,
    e.contatos ? `contato ${e.contatos}` : null, e.comissao ? `comissão do canal R$ ${Number(e.comissao).toFixed(2).replace('.', ',')}` : null].filter(Boolean);
  const outras = String(notas || '').split('\n').filter(l => l && !l.startsWith(LINHA));
  if (e.codigo && !outras.some(l => l.includes(`Stays ${e.codigo}`))) outras.unshift(`Stays ${e.codigo}`);
  return [...outras, LINHA + partes.join(' · ')].join('\n');
}

// Completa as reservas: pelo código ("Stays YY01J" nas notas) ou, sem código, pela casa + datas (só se for única)
export async function aplicarEmailsStays(sb: any) {
  // Pendente = aplicado_em vazio (e-mail novo ou atualizado zera; reserva ainda não encontrada continua vazio)
  const { data: pend } = await sb.from('stays_emails').select('*').is('aplicado_em', null).order('recebido_em').limit(200);
  let aplicados = 0;
  for (const e of pend || []) {
    let b: any = null;
    if (e.booking_id) b = (await sb.from('bookings').select('*').eq('id', e.booking_id).maybeSingle()).data;
    if (!b) {
      const { data: porCod } = await sb.from('bookings').select('*').ilike('notas', `%Stays ${e.codigo}%`);
      b = (porCod || []).find((x: any) => x.uid_externo) || null;
    }
    if (!b && e.casa && e.checkin && e.checkout) {
      const { data: iguais } = await sb.from('bookings').select('*').eq('property_id', e.casa).eq('checkin', e.checkin).eq('checkout', e.checkout).neq('status', 'cancelada');
      const deCal = (iguais || []).filter((x: any) => x.uid_externo);
      if (deCal.length === 1) b = deCal[0];
    }
    if (!b) {
      // Estadia que já passou há mais de 30 dias e nunca apareceu no Hub: para de procurar
      if (e.checkout && Date.parse(e.checkout) < Date.now() - 30 * 864e5) await sb.from('stays_emails').update({ aplicado_em: new Date().toISOString() }).eq('codigo', e.codigo);
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (e.valor != null && (b.valor == null || b.valor === '' || (e.valor_aplicado != null && Number(b.valor) === Number(e.valor_aplicado))) && Number(b.valor) !== Number(e.valor)) patch.valor = e.valor;
    // Taxa do canal (comissão do Airbnb...) acompanha o valor total que veio do e-mail; a digitada à mão fica
    if (e.comissao != null && (b.taxa_canal == null || b.taxa_canal === '' || 'valor' in patch) && Number(b.taxa_canal) !== Number(e.comissao)) patch.taxa_canal = e.comissao;
    if (e.hospede && (!b.hospede || GENERICOS.test(String(b.hospede).trim()) || b.hospede === e.hospede_aplicado) && b.hospede !== e.hospede) patch.hospede = e.hospede;
    const origem = CANAL_ORIGEM[semAcento(e.canal || '')];
    if (origem && b.origem === 'outro') patch.origem = origem;
    const notas = notasCom(b.notas, e);
    if (notas !== b.notas) patch.notas = notas;
    if (e.status && CANCELADO.test(e.status) && b.uid_externo && b.status !== 'cancelada') patch.status = 'cancelada';
    if (Object.keys(patch).length) { await sb.from('bookings').update(patch).eq('id', b.id); aplicados++; }
    await sb.from('stays_emails').update({ booking_id: b.id, aplicado_em: new Date().toISOString(),
      valor_aplicado: 'valor' in patch ? patch.valor : (Number(b.valor) === Number(e.valor) ? e.valor : e.valor_aplicado ?? null),
      hospede_aplicado: 'hospede' in patch ? patch.hospede : (b.hospede === e.hospede ? e.hospede : e.hospede_aplicado ?? null) }).eq('codigo', e.codigo);
  }
  return aplicados;
}

// Guarda um e-mail (o mais recente de cada reserva vale) e zera aplicado_em para ser aplicado de novo
export async function guardarEmailStays(sb: any, msg: { id?: string; assunto: string; corpo: string; data?: string }, props: { id: string; nome: string }[]) {
  const e = lerEmailStays(msg.assunto, msg.corpo);
  if (!e) return 'ignorado';
  const recebido_em = msg.data && !isNaN(Date.parse(msg.data)) ? new Date(msg.data).toISOString() : new Date().toISOString();
  const { data: ex } = await sb.from('stays_emails').select('recebido_em,msg_id').eq('codigo', e.codigo).maybeSingle();
  if (ex && (ex.msg_id && ex.msg_id === msg.id || Date.parse(ex.recebido_em) > Date.parse(recebido_em))) return 'antigo';
  const row = { ...e, casa: casaDaAcomodacao(e.acomodacao, props), assunto: msg.assunto, msg_id: msg.id || null, recebido_em, aplicado_em: null };
  const { error } = await sb.from('stays_emails').upsert(row, { onConflict: 'codigo' });
  if (error) throw new Error(error.message);
  return 'guardado';
}
