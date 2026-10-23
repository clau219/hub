// "IA" simulada do robô do WhatsApp: no lugar do Claude Haiku, lê os mesmos prompts (conversa, casas, informações
// das casas, consulta do Airbnb) e responde seguindo as regras escritas neles, de forma previsível.
// Serve para testar a conversa inteira com um hóspede sem chamar a Anthropic.
// Uso: ligarIA({ mentir }) instala em globalThis.__anthropic.responder; ia.chamadas guarda os prompts.

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const sem = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const pad = n => String(n).padStart(2, '0');
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
// dia/mês sem ano: a próxima ocorrência a partir de hoje
const proxima = (d, m, hoje) => { let iso = `${hoje.slice(0, 4)}-${pad(m)}-${pad(d)}`; if (iso < hoje) iso = `${+hoje.slice(0, 4) + 1}${iso.slice(4)}`; return iso; };

// "Cliente: oi\nRobô: Tudo bem?\n..." → [{autor, texto}] (respostas do robô podem ter várias linhas)
export function lerConversa(conteudo) {
  const txt = (String(conteudo).match(/<conversa>\n([\s\S]*)\n<\/conversa>/) || [])[1] || '';
  const out = [];
  for (const l of txt.split('\n')) {
    const m = l.match(/^(Cliente|Robô|Claudio|Atendimento): ([\s\S]*)$/);
    if (m) out.push({ autor: m[1], texto: m[2] }); else if (out.length) out.at(-1).texto += '\n' + l;
  }
  return out;
}

// Datas numa frase do cliente → {checkin, checkout, noites, exatas} (ou null)
export function datasDe(frase, hoje) {
  const t = sem(frase);
  const mesN = nome => MESES.findIndex(m => sem(m) === nome) + 1;
  let m;
  if ((m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:a|ate|-)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/)))
    return { checkin: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, checkout: `${m[6]}-${pad(m[5])}-${pad(m[4])}`, noites: null, exatas: true };
  if ((m = t.match(/\bate (?:o )?dia (\d{1,2})(?:\/(\d{1,2}))?/))) {
    const mes = m[2] ? +m[2] : +hoje.slice(5, 7);
    return { checkin: null, checkout: proxima(+m[1], mes, hoje), noites: null, exatas: true };
  }
  if ((m = t.match(/(\d{1,2})\/(\d{1,2})\s*(?:a|ate|-)\s*(\d{1,2})\/(\d{1,2})/))) {
    const ci = proxima(+m[1], +m[2], hoje); let co = proxima(+m[3], +m[4], hoje); if (co <= ci) co = `${+co.slice(0, 4) + 1}${co.slice(4)}`;
    return { checkin: ci, checkout: co, noites: null, exatas: true };
  }
  if ((m = t.match(/(?:de |dia )?(\d{1,2})\s*(?:a|ate)\s*(\d{1,2})(?:\/(\d{1,2})| de (\w+))/))) {
    const mes = m[3] ? +m[3] : mesN(m[4]);
    if (mes > 0) { const ci = proxima(+m[1], mes, hoje), co = proxima(+m[2], mes, hoje); return { checkin: ci, checkout: co, noites: null, exatas: true }; }
  }
  const noites = +(t.match(/(\d+)\s*noites?/) || [])[1] || null;
  if ((m = t.match(/(?:dia |entrada |de )?(\d{1,2})\/(\d{1,2})/)) || (m = t.match(/dia (\d{1,2}) de (\w+)/))) {
    const mes = /^\d+$/.test(m[2]) ? +m[2] : mesN(m[2]);
    if (mes > 0) return { checkin: proxima(+m[1], mes, hoje), checkout: null, noites, exatas: !!noites };
  }
  if (/fim de semana|final de semana/.test(t)) {
    const dow = new Date(hoje + 'T12:00:00Z').getUTCDay();
    const sexta = addDays(hoje, ((5 - dow + 7) % 7) || 7);
    return { checkin: sexta, checkout: addDays(sexta, 2), noites: null, exatas: false };
  }
  if (/reveillon|ano novo|virada/.test(t)) {
    const ano = hoje.slice(5) > '12-30' ? +hoje.slice(0, 4) + 1 : +hoje.slice(0, 4);
    return { checkin: `${ano}-12-30`, checkout: `${ano + 1}-01-02`, noites: null, exatas: false };
  }
  return null;
}
export const pessoasDe = frase => {
  const t = sem(frase);
  let m = t.match(/(\d+)\s*adultos?\s*e\s*(\d+)\s*crianc/);
  if (m) return +m[1] + +m[2];
  m = t.match(/(?:somos|seremos|sao|serao)\s*(\d+)/) || t.match(/(\d+)\s*(?:pessoas|adultos|hospedes)/) || t.match(/para\s*(\d+)\b(?!\s*(?:\/|noite|de\b))/);
  if (m) return +m[1];
  if (/\b(um casal|eu e (minha|meu) \w+)\b/.test(t)) return 2;
  return null;
};

const AFIRMA = /^(sim|isso|certo|exato|correto|pode ser|ok|confirmo|perfeito)\b/;
// "reservar": quer reservar/fechar, pede o Pix ou diz que pagou. "confirmar_reserva": negociar desconto/condição/outra forma de pagamento.
const RESERVA = /\b(reservar|reserva|fechar|fechado|pix|comprovante|sinal|pagar|paguei|transferencia)\b/;
const NEGOCIA = /\b(desconto|parcel\w*|cartao|abatimento|condicao especial|mais barato)\b/;
const SAUDA = /^(?:(?:oi+|ola|opa|bom dia|boa tarde|boa noite|tudo bem|tudo bom|e ai|\?+|alguem ai|queria (?:mais )?informacoes(?: sobre as casas)?)[!.?,\s]*)+$/;
const PRECO = /\b(vaga|dispon\w*|valor\w*|preco\w*|quanto|diaria\w*|livre|tem para|orcamento|cotar|cotacao)\b/; // palavras inteiras ("Terracota" não é "cota")
const DUVIDAS = [
  [/(pet|cachorro|cao|gato|animal)/, ['Pets']],
  [/(check-?in|que horas|horario de entrada|horario)/, ['Horário de check-in', 'Horário de check-out']],
  [/(check-?out|horario de saida)/, ['Horário de check-out']],
  [/(onde fica|endereco|localiza)/, ['Endereço']],
  [/(regras|festa|fumar|barulho)/, ['Regras da casa']],
];

function extrair(system, conteudo) {
  const hoje = (system.match(/Hoje é [^,]+, (\d{4}-\d{2}-\d{2})/) || [])[1];
  const casas = Object.fromEntries(((system.match(/Casas: (.*)\./) || [])[1] || '').split('; ').map(x => x.split(' = ')).filter(x => x[1]).map(([id, nome]) => [sem(nome.replace(/^Casa\s+/i, '')), id]));
  const base = (system.match(/<informacoes_das_casas>\n([\s\S]*?)\n<\/informacoes_das_casas>/) || [])[1] || '';
  const temBase = base && !/^\(nenhuma/.test(base);
  const conv = lerConversa(conteudo);
  const cli = conv.filter(m => m.autor === 'Cliente');
  const ult = cli.at(-1)?.texto || '';
  const u = sem(ult);
  // conversa toda: a última menção vale
  let hospedes = null, casa = 'qualquer';
  for (const m of cli) {
    hospedes = pessoasDe(m.texto) ?? hospedes;
    for (const [nome, id] of Object.entries(casas)) if (sem(m.texto).includes(nome)) casa = id;
  }
  // Como pede o prompt: só o que o cliente disse; respondendo ao Robô ("isso", "até dia 20", "somos 6"), junta com o que já tinha dito
  let d = datasDe(ult, hoje);
  const antes = () => { for (const m of [...cli].reverse().slice(1)) { const x = datasDe(m.texto, hoje); if (x?.checkin) return x; } return null; };
  if (d && !d.checkin) { const a = antes(); d = a ? { ...a, checkout: d.checkout, noites: null, exatas: true } : null; }
  else if (!d && (AFIRMA.test(u) || /^\d+\s*noites?$/.test(u) || pessoasDe(ult) != null || Object.keys(casas).some(n => u.includes(n)))) {
    const a = antes();
    if (a) d = { ...a, noites: +(u.match(/^(\d+)\s*noites?/) || [])[1] || a.noites, exatas: a.exatas || AFIRMA.test(u) };
  }
  let assunto = 'outro', resposta = null;
  const duvida = DUVIDAS.find(([re]) => re.test(u));
  if (NEGOCIA.test(u)) assunto = 'confirmar_reserva';
  else if (RESERVA.test(u) && !PRECO.test(u.replace(/reserva\w*/g, ''))) assunto = 'reservar';
  else if (SAUDA.test(u)) assunto = 'saudacao';
  else if (d || PRECO.test(u) || (pessoasDe(ult) != null && cli.length > 1)) assunto = 'disponibilidade_preco';
  else if (duvida && temBase) {
    const linhas = base.split('\n').filter(l => duvida[1].some(r => l.trim().startsWith(r + ':')));
    if (linhas.length) { assunto = 'duvida'; resposta = linhas.map(l => l.trim()).join('. ') + '.'; }
  }
  if (/wi-?fi|senha/.test(u) && assunto === 'duvida') { assunto = 'outro'; resposta = null; }
  const resumo = assunto === 'disponibilidade_preco'
    ? ['Vaga', d ? `${d.checkin.slice(8)}/${d.checkin.slice(5, 7)}` : '', hospedes ? `${hospedes} pessoas` : ''].filter(Boolean).join(' ')
    : assunto === 'reservar' ? 'Quer reservar' : assunto === 'confirmar_reserva' ? 'Quer negociar' : assunto === 'saudacao' ? 'Cumprimento' : assunto === 'duvida' ? 'Dúvida sobre a casa' : 'Assunto para o Claudio';
  return { assunto, casa, checkin: d?.checkin ?? null, checkout: d?.checkout ?? null, noites: d?.noites ?? null, hospedes, datas_exatas: !!d?.exatas, resumo, resposta };
}

// Resposta de disponibilidade e valores: copia os valores da consulta, casa pedida primeiro, próximo passo no fim
function redigir(system, conteudo, { mentir = false } = {}) {
  const consulta = (system.match(/<consulta_airbnb>\n([\s\S]*?)\n<\/consulta_airbnb>/) || [])[1] || '';
  const base = (system.match(/<informacoes_das_casas>\n([\s\S]*?)\n<\/informacoes_das_casas>/) || [])[1] || '';
  const linhas = consulta.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2)).filter(l => !/não foi possível consultar/.test(l));
  const conv = lerConversa(conteudo);
  const cli = conv.filter(m => m.autor === 'Cliente');
  const ult = sem(cli.at(-1)?.texto);
  let pedida = '';
  for (const m of cli) for (const l of linhas) { const nome = l.split(':')[0]; if (sem(m.texto).includes(sem(nome.replace(/^Casa\s+/i, '')))) pedida = nome; }
  const livre = l => /: LIVRE\./.test(l);
  const ordem = pedida ? [...linhas.filter(l => l.startsWith(pedida + ':')), ...linhas.filter(l => !l.startsWith(pedida + ':'))] : linhas;
  const usar = pedida && ordem[0] && livre(ordem[0]) ? [ordem[0]] : ordem;
  const out = [];
  const nome = (system.match(/usando o nome (\p{L}+)/u) || [])[1];
  if (/comece com um cumprimento curto/.test(system)) out.push(nome ? `Oi, ${nome}!` : 'Oi!');
  out.push(...usar.map(l => l.replace(': LIVRE. Total ', ': disponível, total ').replace(': OCUPADA nessas datas.', ': ocupada nessas datas.')));
  if (/(pet|cachorro|cao|gato)/.test(ult)) { const p = base.split('\n').find(l => l.startsWith('Pets:')); out.push(p ? `Sobre pets: ${p.slice(6).trim()}` : 'Sobre pets, o Claudio confirma em seguida.'); }
  const aviso = (system.match(/Diga também, com suas palavras: "([^"]+)"/) || [])[1];
  if (aviso) out.push(aviso);
  const casaLivre = usar.find(livre)?.split(':')[0];
  out.push(casaLivre ? `Quer reservar a ${casaLivre}?` : 'Quer que eu veja outras datas?');
  if (mentir) out.push('Para você faço por R$ 999.');
  return { texto: out.join('\n') };
}

// Comprovante falso: o "arquivo" é um JSON com o que estaria escrito nele (a leitura simulada só decodifica).
// Ex.: comprovante({ valor: 825, recebedor_nome: 'CLAUDIO BRAGA', e2e: 'E…', data_hora: '…-03:00' }); outra coisa → foto qualquer.
export const comprovante = dados => Buffer.from(JSON.stringify({ comprovante: true, ...dados }));
export const fotoQualquer = () => Buffer.from('foto da praia ao pôr do sol');
function lerComprovante(content) {
  const bloco = (Array.isArray(content) ? content : []).find(b => b.type === 'image' || b.type === 'document');
  let d = null;
  try { d = JSON.parse(Buffer.from(bloco?.source?.data || '', 'base64').toString()); } catch { /* não é comprovante */ }
  if (!d?.comprovante) return { e_comprovante_pix: false, valor: null, recebedor_nome: null, recebedor_chave: null, pagador_nome: null, data_hora: null, e2e: null };
  return { e_comprovante_pix: true, valor: d.valor ?? null, recebedor_nome: d.recebedor_nome ?? null, recebedor_chave: d.recebedor_chave ?? null,
    pagador_nome: d.pagador_nome ?? null, data_hora: d.data_hora ?? null, e2e: d.e2e ?? null };
}

export function ligarIA(opcoes = {}) {
  const ia = { chamadas: [], tipos: [], ...opcoes };
  globalThis.__anthropic = ia;
  ia.responder = params => {
    const system = String(params.system || ''), conteudo = params.messages?.[0]?.content || '';
    if (ia.foraDoAr) throw new Error('overloaded');
    if (/comprovantes de Pix/.test(system)) { ia.tipos.push('comprovante'); return lerComprovante(params.messages?.[0]?.content); }
    if (/<consulta_airbnb>/.test(system)) { ia.tipos.push('redigir'); return redigir(system, conteudo, ia); }
    if (/Classifique a ÚLTIMA mensagem/.test(system)) { ia.tipos.push('extrair'); return extrair(system, conteudo); }
    ia.tipos.push('desconhecida');
    throw new Error('chamada de IA não prevista pela IA simulada');
  };
  return ia;
}
