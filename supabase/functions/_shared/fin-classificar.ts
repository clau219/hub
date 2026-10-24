import Anthropic from 'npm:@anthropic-ai/sdk@0.134.0';
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@0.134.0/helpers/zod';
import { z } from 'npm:zod@4.6.7';

// Categorização dos lançamentos de Finanças (fin_tx), em 4 camadas, da mais barata para a mais esperta:
//   1. Tipo da Pluggy que não deixa dúvida: transferência entre contas próprias, fatura do cartão e aplicações
//      ficam fora dos totais (Transferência entre contas / Investimento).
//   2. Regras e memória: "descrição contém X" (fin_regras) e o que o Claudio já classificou à mão para o mesmo
//      pagador/recebedor (cada correção vira memória, sem precisar marcar regra). Depois, o cruzamento com o Hub:
//      PIX recebido de um hóspede de reserva direta → Reserva direta + casa; de um contratante do Pipeline → Cachê DJ
//      (ou Engenharia); repasse do Airbnb → Airbnb.
//   3. IA (Claude Haiku) para o resto, com as categorias, negócios, casas, contatos, gigs, reservas e exemplos das
//      correções dele. Certeza alta: aplica. Média/baixa: aplica o melhor palpite e marca "revisar", com 2 sugestões.
//   4. Sem IA (sem chave ou falha): fica a tradução da categoria da Pluggy, sem negócio, para tentar de novo depois.
// origem_cat diz de onde veio: manual | whatsapp | pluggy | regra | memoria | reserva | gig | airbnb | ia | pluggy_sem_ia.
// Pendente = origem_cat nulo e manual falso.

type SB = any;
export type Tx = { id: string; data: string; valor: number; descricao?: string | null; contraparte?: string | null; cat_pluggy?: string | null;
  conta_id?: string | null; parcela?: string | null; manual?: boolean; categoria?: string | null; negocio?: string | null; casa?: string | null; origem_cat?: string | null };
export type Classe = { categoria: string; negocio: string | null; casa: string | null; origem_cat: string; revisar: boolean; sugestoes: unknown; ia_motivo: string | null };

export const CATS_SAI = ['Moradia', 'Contas da casa', 'Mercado', 'Alimentação fora', 'Transporte', 'Combustível', 'Saúde', 'Educação', 'Lazer',
  'Compras', 'Assinaturas', 'Impostos', 'Tarifas bancárias', 'Faxina e limpeza', 'Condomínio', 'Manutenção', 'Obra', 'Equipamento', 'Outros'];
export const CATS_ENT = ['Airbnb', 'Reserva direta', 'Cachê DJ', 'Engenharia', 'Salário / pró-labore', 'Rendimentos', 'Reembolso', 'Outras entradas'];
export const INTERNA = 'Transferência entre contas';
export const INVEST = 'Investimento';
export const NEGOCIOS = ['pessoal', 'dj', 'alugueis', 'consultoria', 'argila', 'casa'];
const NEGOCIO_TXT: Record<string, string> = {
  pessoal: 'gastos e ganhos pessoais do Claudio (o padrão quando não é de nenhum negócio)',
  dj: 'DJ CLAU: cachês de festas e eventos nos fins de semana, equipamento de som, transporte para gigs',
  alugueis: 'as 3 casas de aluguel por temporada (Airbnb e reservas diretas): faxina, manutenção, contas, condomínio e enxoval delas',
  consultoria: 'consultoria de engenharia (trabalho de semana)',
  argila: 'Argila Lab: empresa de ferramentas para cerâmica',
  casa: 'a casa onde o Claudio mora (moradia dele, não as de aluguel)',
};

// Tradução da categoria da Pluggy (em inglês) para as do Hub
export const PLUGGY: Record<string, string> = {
  'Groceries': 'Mercado', 'Supermarket': 'Mercado', 'Eating out': 'Alimentação fora', 'Restaurants': 'Alimentação fora', 'Food delivery': 'Alimentação fora',
  'Gas stations': 'Combustível', 'Taxi and ride-hailing': 'Transporte', 'Public transportation': 'Transporte', 'Transportation': 'Transporte', 'Parking': 'Transporte', 'Tolls': 'Transporte',
  'Airport and airlines': 'Lazer', 'Accommodation': 'Lazer', 'Pharmacy': 'Saúde', 'Health': 'Saúde', 'Hospital clinics and labs': 'Saúde', 'Gyms and fitness centers': 'Saúde',
  'Education': 'Educação', 'Leisure': 'Lazer', 'Entertainment': 'Lazer', 'Travel': 'Lazer', 'Gaming': 'Lazer', 'Tickets': 'Lazer',
  'Shopping': 'Compras', 'Online shopping': 'Compras', 'Clothing': 'Compras', 'Electronics': 'Compras', 'Houseware': 'Compras', 'Bookstore': 'Compras', 'Pet supplies and vet': 'Compras',
  'Digital services': 'Assinaturas', 'Video streaming': 'Assinaturas', 'Music streaming': 'Assinaturas',
  'Taxes': 'Impostos', 'Income taxes': 'Impostos', 'Tax on financial operations': 'Impostos', 'Bank fees': 'Tarifas bancárias', 'Interests charged': 'Tarifas bancárias', 'Late payment and overdraft costs': 'Tarifas bancárias',
  'Housing': 'Moradia', 'Rent': 'Moradia', 'Houses and apartments': 'Moradia',
  'Electricity': 'Contas da casa', 'Water': 'Contas da casa', 'Gas': 'Contas da casa', 'Telecommunications': 'Contas da casa', 'Internet': 'Contas da casa', 'Mobile': 'Contas da casa', 'Utilities': 'Contas da casa',
  'Salary': 'Salário / pró-labore', 'Income': 'Outras entradas', 'Interests': 'Rendimentos', 'Proceeds interests and dividends': 'Rendimentos', 'Refunds': 'Reembolso',
  'Same person transfer': INTERNA, 'Credit card payment': INTERNA, 'Transfer - Internal': INTERNA,
  'Investments': INVEST, 'Investment': INVEST, 'Fixed income': INVEST, 'Mutual funds': INVEST, 'Variable income': INVEST,
};
const FORA = new Set(['Same person transfer', 'Credit card payment', 'Transfer - Internal', 'Investments', 'Investment', 'Fixed income', 'Mutual funds', 'Variable income']);
export const catPluggy = (t: Tx) => {
  const c = PLUGGY[t.cat_pluggy || ''];
  if (c && (t.valor > 0) === CATS_ENT.includes(c)) return c;
  if (c === INTERNA || c === INVEST) return c;
  return t.valor > 0 ? 'Outras entradas' : 'Outros';
};

// ---------- chave do pagador/recebedor (memória) ----------
export const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PREFIXOS = /^(pix|ted|doc|transf(erencia)?|pagamento|pgto|compra|debito|credito|enviad[oa]|recebid[oa]|no|de|para|pelo|pela|via|qr|code|automatico|boleto|\s)+/;
export function chave(t: Tx) {
  const base = norm(t.contraparte || t.descricao || '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const k = base.replace(PREFIXOS, '').trim().slice(0, 40);
  return k.length >= 3 ? k : '';
}
const sinal = (t: Tx) => (t.valor > 0 ? '+' : '-');
// PIX/transferência: a memória vale para a pessoa (valores variam). Compra no cartão: só para a mesma compra (mesmo valor),
// senão uma correção num "MERCADOLIVRE*" mudaria todas as compras do Mercado Livre.
export const ehTransf = (t: Tx) => /transfer|pix/i.test(t.cat_pluggy || '') || /\b(pix|ted|doc|transf)/.test(norm(t.descricao || ''));
const centavos = (v: number) => Math.round(Math.abs(+v) * 100);

// ---------- contexto do Hub ----------
export type Ctx = { regras: any[]; memoria: Map<string, any[]>; exemplos: any[]; reservas: any[]; gigs: any[]; contatos: any[]; casas: any[]; contas: Map<string, any> };
export async function contexto(sb: SB): Promise<Ctx> {
  const sel = async (t: string, q: (x: any) => any = x => x) => { const { data } = await q(sb.from(t).select('*')); return data || []; };
  const [regras, manuais, bookings, deals, contatos, casas, contas] = await Promise.all([
    sel('fin_regras'), sel('fin_tx', q => q.eq('manual', true)), sel('bookings'), sel('deals'), sel('contacts'), sel('properties'), sel('fin_contas'),
  ]);
  const memoria = new Map<string, any[]>();
  for (const t of [...manuais].sort((a, b) => String(a.data).localeCompare(String(b.data)))) {
    const k = chave(t);
    if (!k || !t.categoria) continue;
    const l = memoria.get(sinal(t) + k) || [];
    l.push({ categoria: t.categoria, negocio: t.negocio || null, casa: t.casa || null, cent: centavos(t.valor) });
    memoria.set(sinal(t) + k, l);
  }
  const nomeContato = (id: string) => contatos.find((c: any) => c.id === id)?.nome || '';
  return {
    regras, memoria, casas, contas: new Map(contas.map((c: any) => [c.id, c])),
    exemplos: manuais.filter((t: any) => t.categoria && !String(t.id).startsWith('wa-')).sort((a: any, b: any) => String(b.data).localeCompare(String(a.data))).slice(0, 60),
    reservas: bookings.filter((b: any) => b.origem !== 'airbnb' && !['cancelada', 'bloqueio'].includes(b.status) && b.hospede),
    gigs: deals.filter((d: any) => d.etapa !== 'perdido').map((d: any) => ({ ...d, nome: nomeContato(d.contato_id) })).filter((d: any) => d.nome),
    contatos: contatos.filter((c: any) => c.nome).slice(0, 400),
  };
}

// Nome da pessoa aparece no texto do lançamento: primeiro nome + outro pedaço (ou só o nome, se tiver uma palavra)
const LIGA = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
export function mesmoNome(nome: string, texto: string) {
  const ps = norm(nome).replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(p => p.length >= 3 && !LIGA.has(p));
  if (!ps.length) return false;
  const tem = (p: string) => new RegExp(`\\b${p}\\b`).test(norm(texto));
  if (!tem(ps[0])) return false;
  return ps.length === 1 || ps.slice(1).some(tem);
}
const dias = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 864e5;
const somaDias = (iso: string, n: number) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// Correções anteriores do mesmo pagador/recebedor; só vale se todas apontam para a mesma classificação
function lembrar(t: Tx, ctx: Ctx) {
  const k = chave(t);
  let l = (k && ctx.memoria.get(sinal(t) + k)) || [];
  if (!ehTransf(t)) l = l.filter(m => m.cent === centavos(t.valor));
  const tipos = new Set(l.map(m => `${m.categoria}|${m.negocio}|${m.casa}`));
  return tipos.size === 1 ? l[l.length - 1] : null;
}

// ---------- camadas 1 e 2: sem IA ----------
export function semIA(t: Tx, ctx: Ctx): Classe | null {
  const ok = (categoria: string, negocio: string | null, casa: string | null, origem_cat: string, ia_motivo: string | null = null): Classe =>
    ({ categoria, negocio, casa, origem_cat, revisar: false, sugestoes: null, ia_motivo });
  const txt = norm(`${t.descricao || ''} ${t.contraparte || ''}`);
  // Regra do usuário (a mais longa ganha)
  const r = ctx.regras.filter(r => r.contem && txt.includes(norm(r.contem))).sort((a, b) => b.contem.length - a.contem.length)[0];
  if (r && r.categoria) return ok(r.categoria, r.negocio || null, r.casa || null, 'regra', `regra "${r.contem}"`);
  // Fora dos totais pelo tipo da Pluggy
  if (FORA.has(t.cat_pluggy || '')) return ok(PLUGGY[t.cat_pluggy!], null, null, 'pluggy');
  // Memória: o mesmo pagador/recebedor já classificado à mão
  const m = lembrar(t, ctx);
  if (m) return ok(m.categoria, m.negocio, m.casa, 'memoria', 'igual ao que você já classificou');
  if (t.valor > 0) {
    if (/airbnb/.test(txt)) return ok('Airbnb', 'alugueis', null, 'airbnb');
    const texto = `${t.descricao || ''} ${t.contraparte || ''}`;
    const b = ctx.reservas.find(b => mesmoNome(b.hospede, texto) && t.data >= somaDias(b.checkin, -150) && t.data <= somaDias(b.checkout || b.checkin, 10));
    if (b) return ok('Reserva direta', 'alugueis', b.property_id || null, 'reserva', `reserva de ${b.hospede} (check-in ${b.checkin})`);
    const g = ctx.gigs.filter(d => mesmoNome(d.nome, texto) && (!d.data_evento || (t.data >= somaDias(d.data_evento, -180) && t.data <= somaDias(d.data_evento, 60))))
      .sort((a, b) => Math.abs(dias(a.data_evento || t.data, t.data)) - Math.abs(dias(b.data_evento || t.data, t.data)))[0];
    if (g) {
      const [cat, neg] = g.negocio === 'consultoria' ? ['Engenharia', 'consultoria'] : g.negocio === 'aluguel' ? ['Reserva direta', 'alugueis'] : g.negocio === 'argila' ? ['Outras entradas', 'argila'] : ['Cachê DJ', 'dj'];
      return ok(cat, neg, null, 'gig', `${g.nome}${g.data_evento ? ` (evento ${g.data_evento})` : ''}`);
    }
  }
  return null;
}

// ---------- camada 3: IA ----------
const TODAS = [...CATS_SAI, ...CATS_ENT, INTERNA, INVEST] as [string, ...string[]];
const ItemSchema = z.object({
  i: z.number().describe('número do lançamento'),
  categoria: z.enum(TODAS),
  negocio: z.string().describe('pessoal, dj, alugueis, consultoria, argila, casa ou nenhum (nenhum só para Transferência entre contas e Investimento)'),
  casa: z.string().describe('id da casa (QS39, QS40, QS50) quando o negócio é alugueis e dá para saber qual; senão ""'),
  confianca: z.enum(['alta', 'media', 'baixa']),
  alternativa: z.enum([...TODAS, 'nenhuma'] as [string, ...string[]]).describe('segunda categoria mais provável, ou nenhuma'),
  alternativa_negocio: z.string().describe('negócio da alternativa (mesma lista), ou nenhum'),
  motivo: z.string().describe('até 8 palavras, em português'),
});
const RespostaSchema = z.object({ itens: z.array(ItemSchema) });

function sistema(ctx: Ctx) {
  const casas = ctx.casas.map((c: any) => `${c.id} = ${c.nome}`).join('; ');
  const ex = ctx.exemplos.map((t: any) => `- ${t.valor > 0 ? 'entrada' : 'saída'} "${(t.contraparte || t.descricao || '').slice(0, 60)}" → ${t.categoria} · ${t.negocio || 'sem negócio'}${t.casa ? ' · ' + t.casa : ''}`).join('\n');
  const gigs = ctx.gigs.slice(-80).map((d: any) => `- ${d.nome}: ${d.negocio}, ${d.valor ? 'R$ ' + d.valor : 'valor ?'}${d.data_evento ? ', evento ' + d.data_evento : ''}`).join('\n');
  const res = ctx.reservas.slice(-60).map((b: any) => `- ${b.hospede}: ${b.property_id}, check-in ${b.checkin}${b.valor ? ', R$ ' + b.valor : ''}`).join('\n');
  const cont = ctx.contatos.filter((c: any) => c.tipo && c.tipo !== 'cliente').map((c: any) => `${c.nome} (${c.tipo})`).slice(0, 200).join('; ');
  return `Você classifica lançamentos bancários (Open Finance) do Claudio, que mora em Pipa/RN. Para cada lançamento, escolha categoria, negócio e, se for das casas de aluguel, a casa.

Negócios:
${NEGOCIOS.map(n => `- ${n}: ${NEGOCIO_TXT[n]}`).join('\n')}
Casas de aluguel: ${casas}.

Categorias de SAÍDA (valor negativo): ${CATS_SAI.join(', ')}.
Categorias de ENTRADA (valor positivo): ${CATS_ENT.join(', ')}.
Nos dois sentidos: "${INTERNA}" (dinheiro entre contas do próprio Claudio, pagamento de fatura do cartão) e "${INVEST}" (aplicação, resgate, corretora). Essas duas não têm negócio (use "nenhum").

Como decidir:
- Use a descrição, quem pagou/recebeu, o valor, a data, a conta e a categoria sugerida pelo banco (em inglês; pode estar errada).
- PIX ou transferência para o próprio Claudio (Claudio, CLAUDIO...) ou entre bancos dele = ${INTERNA}.
- PIX recebido de alguém que é contratante de gig (lista abaixo), perto da data do evento = Cachê DJ / dj. De hóspede de reserva direta = Reserva direta / alugueis com a casa.
- Faxina, diarista, lavanderia, enxoval, manutenção e contas que pelo contexto são das casas de aluguel = negócio alugueis.
- Obra x Manutenção: "Obra" é construção ou reforma (material de construção, madeira, cimento, areia, tijolo, ferragens em quantidade, pedreiro, mão de obra, marceneiro, serralheiro, arquiteto, projeto, aluguel de caçamba/betoneira). "Manutenção" é conserto pontual de algo que já existe (encanador, eletricista para reparo, troca de peça).
- Sem pista de negócio, gastos do dia a dia são "pessoal".
- confianca (o Claudio revisa à mão os de "media" e "baixa", então só rebaixe quando ele realmente precisar olhar):
  - "alta": a categoria é clara pelo nome do estabelecimento ou pelo tipo (Mercado Livre/Amazon/Shopee = Compras, supermercado = Mercado, iFood/restaurante = Alimentação fora, Uber/99 = Transporte, posto = Combustível, farmácia = Saúde, Netflix/Spotify/software recorrente = Assinaturas) e nada indica outro negócio. "pessoal" como padrão, sem pista contrária, conta como certo: não rebaixe só porque "poderia ser" das casas ou do DJ.
  - "media": categoria plausível mas genérica, ou há uma pista real de que pode ser de um negócio (ex.: material de construção ou enxoval que pode ser das casas; equipamento de som que pode ser do DJ).
  - "baixa": PIX ou transferência para/de pessoa sem pista de quem é, ou descrição que não diz nada.
- Siga o jeito dele nas correções abaixo: elas mandam mais que as regras gerais.

Correções que o Claudio já fez (exemplos):
${ex || '(nenhuma ainda)'}

Gigs e serviços no Pipeline (contratante: negócio, valor, data):
${gigs || '(nenhum)'}

Reservas diretas (hóspede: casa, check-in, valor):
${res || '(nenhuma)'}

Contatos com tipo: ${cont || '(nenhum)'}`;
}

const LOTE = 60;
export async function comIA(txs: Tx[], ctx: Ctx): Promise<Map<string, Classe>> {
  const out = new Map<string, Classe>();
  if (!txs.length || !Deno.env.get('ANTHROPIC_API_KEY')) return out;
  // Iguais (mesmo recebedor, valor, sentido e tipo do banco: parcelas e assinaturas) vão uma vez só e o resultado vale para todos
  const grupo = (t: Tx) => `${sinal(t)}|${chave(t) || t.descricao}|${centavos(t.valor)}|${t.cat_pluggy || ''}`;
  const reps = new Map<string, Tx[]>();
  for (const t of txs) { const g = grupo(t); reps.set(g, [...(reps.get(g) || []), t]); }
  txs = [...reps.values()].map(l => l[0]);
  const cli = new Anthropic();
  const system = [{ type: 'text', text: sistema(ctx), cache_control: { type: 'ephemeral' } }];
  const lotes: Tx[][] = [];
  for (let i = 0; i < txs.length; i += LOTE) lotes.push(txs.slice(i, i + LOTE));
  const umLote = async (lote: Tx[]) => {
    const linhas = lote.map((t, i) => {
      const c = ctx.contas.get(t.conta_id || '');
      return `${i + 1}. ${t.data} | ${t.valor > 0 ? '+' : ''}${(+t.valor).toFixed(2)} | ${(t.descricao || '').slice(0, 80)}${t.contraparte && t.contraparte !== t.descricao ? ` | quem: ${t.contraparte.slice(0, 60)}` : ''}${t.cat_pluggy ? ` | banco diz: ${t.cat_pluggy}` : ''}${c ? ` | ${c.tipo === 'CREDIT' ? 'cartão' : 'conta'} ${c.apelido || c.nome || ''}` : ''}${t.parcela ? ` | parcela ${t.parcela}` : ''}`;
    }).join('\n');
    const r = await cli.messages.parse({
      model: 'claude-haiku-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low', format: zodOutputFormat(RespostaSchema) },
      system,
      messages: [{ role: 'user', content: `Classifique estes ${lote.length} lançamentos (um item por número):\n${linhas}` }],
    } as any);
    if (r.stop_reason === 'refusal' || !r.parsed_output) throw new Error(`IA sem resposta (${r.stop_reason})`);
    for (const it of (r.parsed_output as any).itens || []) {
      const t = lote[it.i - 1];
      if (!t) continue;
      // Negócio fora da lista vira "pessoal" e o lançamento vai para revisão
      const negOk = NEGOCIOS.includes(it.negocio) || it.negocio === 'nenhum';
      const c = ajustar(t, it.categoria), neg = c === INTERNA || c === INVEST || it.negocio === 'nenhum' ? null : negOk ? it.negocio : 'pessoal';
      const casa = neg === 'alugueis' && ctx.casas.some((x: any) => x.id === it.casa) ? it.casa : null;
      const certo = it.confianca === 'alta' && c === it.categoria && negOk;
      const alt = it.alternativa && it.alternativa !== 'nenhuma' && it.alternativa !== c ? ajustar(t, it.alternativa) : null;
      const altNeg = !alt || alt === INTERNA || alt === INVEST || !NEGOCIOS.includes(it.alternativa_negocio) ? null : it.alternativa_negocio;
      const classe = {
        categoria: c, negocio: neg, casa, origem_cat: 'ia', revisar: !certo, ia_motivo: String(it.motivo || '').slice(0, 80) || null,
        sugestoes: certo ? null : [{ categoria: c, negocio: neg, casa }, ...(alt && alt !== c ? [{ categoria: alt, negocio: altNeg, casa: altNeg === 'alugueis' ? casa : null }] : [])],
      };
      for (const x of reps.get(grupo(t)) || [t]) out.set(x.id, classe);
    }
  };
  // 3 lotes por vez; lote que falhar (de novo) fica pendente sem derrubar os outros
  const falhas: string[] = [];
  const tentar = async (l: Tx[]) => { try { await umLote(l); } catch { try { await umLote(l); } catch (e) { falhas.push((e as Error).message.slice(0, 200)); } } };
  for (let i = 0; i < lotes.length; i += 3) await Promise.all(lotes.slice(i, i + 3).map(tentar));
  if (falhas.length && !out.size) throw new Error(falhas[0]);
  return out;
}
// Categoria de entrada num gasto (ou o contrário) vira a genérica do lado certo
function ajustar(t: Tx, c: string) {
  if (c === INTERNA || c === INVEST) return c;
  if (t.valor > 0) return CATS_ENT.includes(c) ? c : 'Outras entradas';
  return CATS_SAI.includes(c) ? c : 'Outros';
}

// ---------- tudo junto ----------
// Classifica os lançamentos dados (não manuais) e devolve {id → classe}. falhaIA = mensagem, se a IA falhou.
export async function classificar(txs: Tx[], ctx: Ctx) {
  const res = new Map<string, Classe>();
  const resto: Tx[] = [];
  for (const t of txs) {
    const c = semIA(t, ctx);
    if (c) res.set(t.id, c); else resto.push(t);
  }
  let falhaIA: string | null = null;
  let ia = new Map<string, Classe>();
  try { ia = await comIA(resto, ctx); }
  catch (e) { falhaIA = (e as Error).message; }
  const semChave = !Deno.env.get('ANTHROPIC_API_KEY');
  for (const t of resto) {
    // Sem a IA: fica a tradução da Pluggy. Sem chave, isso é definitivo; com falha, fica pendente (origem nula) para a próxima.
    res.set(t.id, ia.get(t.id) || { categoria: catPluggy(t), negocio: null, casa: null, origem_cat: semChave ? 'pluggy_sem_ia' : '', revisar: false, sugestoes: null, ia_motivo: null });
  }
  return { res, falhaIA, porIA: ia.size };
}

// Pendentes (origem_cat nulo e não manuais), mais novos primeiro, até `limite`. Grava e devolve o resumo.
export async function classificarPendentes(sb: SB, { limite = 300, ctx }: { limite?: number; ctx?: Ctx } = {}) {
  const { data: pend, error } = await sb.from('fin_tx').select('*').is('origem_cat', null).eq('manual', false).order('data', { ascending: false }).limit(limite);
  if (error) throw new Error(error.message);
  if (!pend?.length) return { classificados: 0, restantes: 0, revisar: 0, porIA: 0 };
  ctx ||= await contexto(sb);
  const { res, falhaIA, porIA } = await classificar(pend, ctx);
  const linhas = pend.map((t: any) => {
    const c = res.get(t.id)!;
    return { ...t, categoria: c.categoria, negocio: c.negocio, casa: c.casa, origem_cat: c.origem_cat || null, revisar: c.revisar, sugestoes: c.sugestoes, ia_motivo: c.ia_motivo };
  });
  for (let i = 0; i < linhas.length; i += 500) {
    const { error: e } = await sb.from('fin_tx').upsert(linhas.slice(i, i + 500), { onConflict: 'id' });
    if (e) throw new Error(e.message);
  }
  const { count } = await sb.from('fin_tx').select('id', { count: 'exact', head: true }).is('origem_cat', null).eq('manual', false);
  return { classificados: linhas.filter((l: any) => l.origem_cat).length, restantes: count ?? 0, revisar: linhas.filter((l: any) => l.revisar).length, porIA,
    ...(falhaIA ? { erro_ia: falhaIA } : {}) };
}
