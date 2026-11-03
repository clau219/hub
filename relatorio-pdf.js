// PDF do relatório do proprietário, sem biblioteca: Helvetica (fonte que todo leitor de PDF já tem) em WinAnsi, que cobre
// os acentos do português. Página A4 em pontos; aqui y conta de cima para baixo (o PDF conta de baixo para cima).
import { today } from './util.js';
import { brl2, dataBr, rotuloMes } from './relatorio.js';

const W = 595.28, H = 841.89, M = 48, RODAPE = 64;
// Larguras (milésimos do corpo) dos caracteres 32–126, das métricas oficiais da Helvetica e da Helvetica-Bold
const LARG = {
  n: '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584',
  b: '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584',
};
for (const k in LARG) LARG[k] = LARG[k].split(',').map(Number);
const WINANSI = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, ' ': 0xa0 };
const LARG_ESP = { '…': 1000, '•': 350, '–': 556, '—': 1000, '‘': 222, '’': 222, '“': 333, '”': 333, ' ': 278, ' ': 278 };

export function codigo(ch) {
  const c = ch.codePointAt(0);
  if ((c >= 32 && c < 127) || (c >= 0xa0 && c <= 0xff)) return c;
  return WINANSI[ch] ?? 63; // fora do WinAnsi vira "?"
}
function largCar(ch, negrito) {
  const t = LARG[negrito ? 'b' : 'n'], c = ch.codePointAt(0);
  if (c >= 32 && c < 127) return t[c - 32];
  if (LARG_ESP[ch]) return LARG_ESP[ch];
  const base = ch.normalize('NFD')[0].codePointAt(0); // "ã" mede como "a"
  return base >= 32 && base < 127 ? t[base - 32] : 556;
}
export const largura = (s, tam, negrito = false) => [...String(s)].reduce((w, ch) => w + largCar(ch, negrito), 0) * tam / 1000;
export function cortar(s, max, tam, negrito = false) {
  s = String(s ?? '');
  if (largura(s, tam, negrito) <= max) return s;
  while (s && largura(s + '…', tam, negrito) > max) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}
const hex = s => [...String(s)].map(ch => codigo(ch).toString(16).padStart(2, '0')).join('');
const n = v => +v.toFixed(2);
const rgb = c => { const x = parseInt((c || '#000').replace('#', ''), 16); return [x >> 16, (x >> 8) & 255, x & 255].map(v => n(v / 255)).join(' '); };

// Documento mínimo: páginas com texto, linhas e retângulos cheios
export function documento(titulo = '') {
  const paginas = [];
  let ops;
  const doc = {
    paginas,
    novaPagina() { ops = []; paginas.push(ops); },
    naPagina(i) { ops = paginas[i]; }, // volta a desenhar numa página anterior (rodapé com o total de páginas)
    texto(x, y, s, { tam = 10, negrito = false, cor = '#1f2937', alinhar = 'esq' } = {}) {
      const w = largura(s, tam, negrito), x0 = alinhar === 'dir' ? x - w : alinhar === 'centro' ? x - w / 2 : x;
      ops.push(`BT /${negrito ? 'F2' : 'F1'} ${tam} Tf ${rgb(cor)} rg ${n(x0)} ${n(H - y)} Td <${hex(s)}> Tj ET`);
    },
    linha(x1, y1, x2, y2, { cor = '#d1d5db', esp = 0.6 } = {}) { ops.push(`${rgb(cor)} RG ${esp} w ${n(x1)} ${n(H - y1)} m ${n(x2)} ${n(H - y2)} l S`); },
    caixa(x, y, w, h, { cor = '#f3f4f6' } = {}) { ops.push(`${rgb(cor)} rg ${n(x)} ${n(H - y - h)} ${n(w)} ${n(h)} re f`); },
    // Bytes do arquivo: catálogo, páginas, 2 fontes, cada página com seu conteúdo, informações (título)
    bytes() {
      const objs = [];
      const add = corpo => objs.push(corpo) && objs.length;
      add('<< /Type /Catalog /Pages 2 0 R >>');
      add(''); // páginas: preenchido depois de saber os ids
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const kids = paginas.map(p => {
        const conteudo = p.join('\n');
        const c = add(`<< /Length ${conteudo.length} >>\nstream\n${conteudo}\nendstream`);
        return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${c} 0 R >>`);
      });
      objs[1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
      const utf16 = [...titulo].map(ch => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('');
      const info = add(`<< /Title <feff${utf16}> /Producer (Hub) >>`);
      let s = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
      const pos = objs.map((o, i) => { const p = s.length; s += `${i + 1} 0 obj\n${o}\nendobj\n`; return p; });
      const xref = s.length;
      s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${pos.map(p => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
      s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return Uint8Array.from(s, ch => ch.charCodeAt(0));
    },
  };
  doc.novaPagina();
  return doc;
}

const CINZA = '#6b7280', TINTA = '#1f2937';
const ORIGEM = { airbnb: 'Airbnb', direto: 'Direta', booking: 'Booking', outro: 'Outra' };

export function pdfRelatorio(r, { hoje = today() } = {}) {
  const pdf = documento(`Relatório ${rotuloMes(r.mes)} — ${r.casa.nome}`);
  const cor = r.casa.cor || '#c2410c', larg = W - 2 * M;
  let y = 0;
  const garantir = alt => { if (y + alt > H - RODAPE) { pdf.novaPagina(); y = M; } };
  const secao = t => { garantir(60); y += 26; pdf.texto(M, y, t, { tam: 12, negrito: true }); y += 10; };
  function tabela(cols, linhas, { total } = {}) {
    const cab = () => {
      pdf.caixa(M, y, larg, 18);
      let x = M;
      for (const c of cols) { pdf.texto(c.dir ? x + c.w - 6 : x + 6, y + 12.5, c.t, { tam: 8, negrito: true, cor: CINZA, alinhar: c.dir ? 'dir' : 'esq' }); x += c.w; }
      y += 18;
    };
    garantir(36); cab();
    const linhaT = (l, negrito) => {
      if (y + 18 > H - RODAPE) { pdf.novaPagina(); y = M; cab(); }
      let x = M;
      cols.forEach((c, i) => { pdf.texto(c.dir ? x + c.w - 6 : x + 6, y + 12.5, cortar(l[i] ?? '', c.w - 12, 9, negrito), { tam: 9, negrito, alinhar: c.dir ? 'dir' : 'esq' }); x += c.w; });
      y += 18; pdf.linha(M, y, W - M, y);
    };
    linhas.forEach(l => linhaT(l, false));
    if (total) linhaT(total, true);
  }

  // Cabeçalho
  pdf.caixa(0, 0, W, 8, { cor });
  pdf.texto(M, 48, 'RELATÓRIO MENSAL DO PROPRIETÁRIO', { tam: 8, negrito: true, cor: CINZA });
  pdf.texto(M, 74, r.casa.nome, { tam: 22, negrito: true });
  pdf.texto(M, 92, `${r.casa.id} · Condomínio Pipa Natureza · ${rotuloMes(r.mes)}`, { tam: 10, cor: CINZA });
  if (r.dono.nome) {
    pdf.texto(W - M, 48, 'PROPRIETÁRIO', { tam: 8, negrito: true, cor: CINZA, alinhar: 'dir' });
    pdf.texto(W - M, 64, cortar(r.dono.nome, 200, 11, true), { tam: 11, negrito: true, alinhar: 'dir' });
  }
  pdf.texto(W - M, 92, 'Administração: Claudio Braga', { tam: 10, cor: CINZA, alinhar: 'dir' });

  // Quadros de resumo
  y = 112;
  const cards = [['Receita', brl2(r.receita)], ['Despesas', brl2(r.totalDespesas)],
    [r.comissaoPct ? `Comissão (${String(r.comissaoPct).replace('.', ',')}%)` : 'Comissão', brl2(r.comissao)],
    [r.repasse < 0 ? 'Saldo negativo' : 'A repassar', brl2(Math.abs(r.repasse))]];
  const cw = (larg - 3 * 10) / 4;
  cards.forEach(([t, v], i) => {
    const x = M + i * (cw + 10), destaque = i === 3;
    pdf.caixa(x, y, cw, 54, { cor: destaque ? cor : '#f3f4f6' });
    pdf.texto(x + 10, y + 18, t.toUpperCase(), { tam: 7.5, negrito: true, cor: destaque ? '#ffffff' : CINZA });
    pdf.texto(x + 10, y + 40, cortar(v, cw - 20, 14, true), { tam: 14, negrito: true, cor: destaque ? '#ffffff' : TINTA });
  });
  y += 54 + 22;
  pdf.texto(M, y, `Ocupação: ${r.noites} de ${r.dias} noites (${r.ocupacao}%) · ${r.reservas.length} ${r.reservas.length === 1 ? 'reserva' : 'reservas'} com entrada no mês`, { tam: 10 });

  secao('Reservas com entrada no mês');
  if (r.reservas.length) tabela(
    [{ t: 'Hóspede', w: 159.28 }, { t: 'Origem', w: 60 }, { t: 'Entrada', w: 70 }, { t: 'Saída', w: 70 }, { t: 'Noites', w: 50, dir: true }, { t: 'Valor', w: 90, dir: true }],
    r.reservas.map(b => [b.hospede, ORIGEM[b.origem] || b.origem, dataBr(b.checkin), dataBr(b.checkout), b.noites, b.valor == null ? '—' : brl2(b.valor)]),
    { total: ['Total', '', '', '', '', brl2(r.receita)] });
  else { y += 16; pdf.texto(M, y, 'Nenhuma reserva com entrada no mês.', { tam: 9, cor: CINZA }); }

  secao('Despesas da casa');
  if (r.despesas.length) tabela(
    [{ t: 'Data', w: 70 }, { t: 'Descrição', w: 339.28 }, { t: 'Valor', w: 90, dir: true }],
    r.despesas.map(d => [d.data ? dataBr(d.data) : '—', d.descricao, brl2(d.valor)]),
    { total: ['', 'Total', brl2(r.totalDespesas)] });
  else { y += 16; pdf.texto(M, y, 'Nenhuma despesa no mês.', { tam: 9, cor: CINZA }); }

  secao('Fechamento');
  const fech = [['Receita das reservas', brl2(r.receita)],
    ...(r.comissaoPct ? [[`(–) Comissão de administração (${String(r.comissaoPct).replace('.', ',')}%)`, brl2(r.comissao)]] : []),
    ['(–) Despesas da casa', brl2(r.totalDespesas)]];
  garantir(18 * (fech.length + 1) + 8);
  for (const [t, v] of fech) { y += 18; pdf.texto(M, y, t, { tam: 10 }); pdf.texto(W - M, y, v, { tam: 10, alinhar: 'dir' }); }
  y += 8; pdf.linha(M, y, W - M, y, { cor: TINTA, esp: 0.8 });
  y += 18;
  pdf.texto(M, y, r.repasse < 0 ? 'Saldo negativo do mês' : 'Valor a repassar', { tam: 11, negrito: true });
  pdf.texto(W - M, y, brl2(Math.abs(r.repasse)), { tam: 11, negrito: true, cor: r.repasse < 0 ? '#b91c1c' : TINTA, alinhar: 'dir' });

  secao('Próximas reservas (90 dias)');
  if (r.proximas.length) tabela(
    [{ t: 'Hóspede', w: 199.28 }, { t: 'Origem', w: 80 }, { t: 'Entrada', w: 80 }, { t: 'Saída', w: 80 }, { t: 'Noites', w: 60, dir: true }],
    r.proximas.map(b => [b.hospede, ORIGEM[b.origem] || b.origem, dataBr(b.checkin), dataBr(b.checkout), b.noites]));
  else { y += 16; pdf.texto(M, y, 'Nenhuma reserva confirmada ainda.', { tam: 9, cor: CINZA }); }

  // Rodapé em todas as páginas, depois de saber quantas são
  const total = pdf.paginas.length;
  for (let i = 0; i < total; i++) {
    pdf.naPagina(i);
    pdf.linha(M, H - 44, W - M, H - 44);
    pdf.texto(M, H - 30, `Gerado pelo Hub em ${dataBr(hoje)} · Receita pela data de entrada; reservas do Airbnb pelo valor repassado.`, { tam: 7.5, cor: CINZA });
    pdf.texto(W - M, H - 30, `${i + 1}/${total}`, { tam: 7.5, cor: CINZA, alinhar: 'dir' });
  }
  return pdf.bytes();
}
