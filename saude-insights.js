// Recomendações do dia (treino forte, leve ou descanso ativo) e insights da semana, a partir do Garmin.
// Regras simples e explicáveis: cada recomendação mostra o porquê. Sem rede: só lê os dados já carregados.
import { today, addDays, dow } from './util.js';

const FORCA = ['strength_training'];
const CORRIDA = ['running', 'treadmill_running', 'trail_running', 'track_running'];
const media = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const hm = seg => `${Math.floor(seg / 3600)}h${String(Math.round(seg % 3600 / 60)).padStart(2, '0')}`;
const n0 = v => Math.round(v).toLocaleString('pt-BR');
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const segunda = d => addDays(d, -((dow(d) + 6) % 7));

/**
 * daily: linhas de health_daily (qualquer ordem); acts: health_activities; gigs: datas 'AAAA-MM-DD' de gigs fechadas
 * Retorna { estado: 'forte'|'leve'|'descanso', titulo, texto, sugestao, motivos: [{txt, sinal}], semDados, cards: [{titulo, txt, tom}] }
 */
export function insights(daily, acts, gigs = [], hoje = today()) {
  const por = Object.fromEntries(daily.map(r => [r.dia, r]));
  const ontem = addDays(hoje, -1);
  const minA = a => (a.duracao_seg || 0) / 60;
  const actsDia = d => acts.filter(a => a.dia === d);
  const base = (campo, de, ate) => media(Array.from({ length: ate - de + 1 }, (_, i) => por[addDays(hoje, -(de + i))]?.[campo]));

  // Última leitura de recuperação: hoje (sono/VFC da noite passada ficam no dia em que você acorda) ou ontem
  const rec = [hoje, ontem].map(d => por[d]).find(r => r && (r.sono_seg || r.hrv_noite || r.fc_repouso || r.bb_max)) || null;
  const motivos = [];
  let pontos = 0;
  if (rec) {
    const hrvB = base('hrv_noite', 1, 30), rhrB = base('fc_repouso', 1, 30);
    if (rec.hrv_noite && hrvB) {
      const d = (rec.hrv_noite - hrvB) / hrvB;
      const p = d < -.15 ? -2 : d < -.07 ? -1 : d > .05 ? 1 : 0; pontos += p;
      motivos.push({ sinal: p, txt: `VFC ${rec.hrv_noite} ms, ${p > 0 ? 'acima' : p < 0 ? 'abaixo' : 'dentro'} da sua média (${n0(hrvB)})` });
    }
    if (rec.fc_repouso && rhrB) {
      const d = rec.fc_repouso - rhrB;
      const p = d >= 5 ? -2 : d >= 3 ? -1 : d <= -2 ? 1 : 0; pontos += p;
      motivos.push({ sinal: p, txt: `FC de repouso ${rec.fc_repouso} bpm${p < 0 ? `, ${n0(d)} acima do normal` : p > 0 ? ', abaixo do normal' : ', normal'}` });
    }
    if (rec.sono_seg) {
      const h = rec.sono_seg / 3600;
      const p = h < 5.5 ? -2 : h < 6.5 ? -1 : h >= 7.5 ? 1 : 0; pontos += p;
      motivos.push({ sinal: p, txt: `Sono de ${hm(rec.sono_seg)}${rec.sono_score ? ` (nota ${rec.sono_score})` : ''}` });
    }
    if (rec.bb_max != null) {
      const p = rec.bb_max < 40 ? -2 : rec.bb_max < 60 ? -1 : rec.bb_max >= 80 ? 1 : 0; pontos += p;
      motivos.push({ sinal: p, txt: `Body Battery chegou a ${rec.bb_max}` });
    }
  }
  // Carga recente: dois dias seguidos puxados pedem um dia mais leve
  const pesado = d => actsDia(d).some(a => minA(a) >= 60 || (CORRIDA.includes(a.tipo) && minA(a) >= 40) || (a.te_aerobico || 0) >= 3.5);
  if (pesado(ontem) && pesado(addDays(hoje, -2))) { pontos -= 1; motivos.push({ sinal: -1, txt: 'Dois dias seguidos de treino puxado' }); }
  if (gigs.includes(ontem)) { pontos -= 1; motivos.push({ sinal: -1, txt: 'Gig ontem à noite' }); }

  const ultimaAtiv = acts.map(a => a.dia).filter(d => d <= hoje).sort().at(-1);
  const diasParado = ultimaAtiv ? Math.round((Date.parse(hoje) - Date.parse(ultimaAtiv)) / 864e5) : null;
  const semana7 = acts.filter(a => a.dia > addDays(hoje, -7) && a.dia <= hoje);
  const forca7 = semana7.filter(a => FORCA.includes(a.tipo)).length;
  const corrida7 = semana7.filter(a => CORRIDA.includes(a.tipo)).length;
  const treinouHoje = actsDia(hoje).reduce((s, a) => s + minA(a), 0);

  const estado = pontos <= -3 ? 'descanso' : pontos <= -1 ? 'leve' : 'forte';
  let titulo, texto, sugestao;
  if (estado === 'descanso') {
    titulo = 'Dia de descanso ativo';
    texto = 'Seu corpo está pedindo recuperação, e recuperar também é treinar: é no descanso que o condicionamento sobe.';
    sugestao = 'Caminhada leve de 20 a 30 min, 10 min de alongamento ou mobilidade e a meta de dormir 8 h hoje. Amanhã você volta mais forte.';
  } else if (estado === 'leve') {
    titulo = 'Dia de treino leve';
    texto = 'Dá para se mexer, mas sem esgotar: um treino leve hoje deixa você pronto para puxar amanhã.';
    sugestao = corrida7 < 2
      ? 'Corrida bem leve (zona 2, dá para conversar) de 30 a 40 min, ou caminhada rápida de 45 min. Feche com 10 min de mobilidade.'
      : 'Força leve de 30 min (cargas médias, sem ir à falha) ou caminhada de 40 min. Feche com 10 min de mobilidade.';
  } else {
    titulo = rec ? 'Dia bom para treinar forte' : 'Bora treinar';
    texto = rec ? 'Sua recuperação está em dia. Aproveite: dias assim são os que mais fazem você evoluir.'
      : 'Sem dados de sono e recuperação recentes; a sugestão abaixo usa só os seus treinos.';
    sugestao = forca7 < 2
      ? `Força completa, de 45 a 60 min (pernas, costas, empurrar e core). ${plural(forca7, 'treino de força', 'treinos de força')} nos últimos 7 dias; o ideal são 2 a 3.`
      : corrida7 < 2
        ? 'Corrida com tiros: 10 min aquecendo, 6 tiros de 2 min forte com 2 min leve entre eles, e 10 min soltando. Melhor treino para subir o VO2máx.'
        : 'Treino longo e confortável: 50 a 70 min de corrida, pedal ou trilha em ritmo de conversa. É a base do condicionamento.';
  }
  if (treinouHoje >= 20) sugestao = `Você já treinou ${n0(treinouHoje)} min hoje. Agora é comer bem, beber água e dormir cedo. ${estado === 'forte' ? 'Se sobrar disposição, 10 min de mobilidade fecham o dia.' : ''}`;
  if (gigs.includes(hoje)) sugestao += ' Tem gig hoje: treine de manhã, no máximo 45 min, para chegar à noite com energia, e reforce a água.';
  if (diasParado != null && diasParado >= 3 && estado !== 'descanso' && treinouHoje < 20)
    texto = `Faz ${plural(diasParado, 'dia', 'dias')} sem registrar treino. Hoje é um ótimo dia para voltar: o primeiro passo é o que mais conta.`;

  // Cartões da semana
  const cards = [];
  const seg = segunda(hoje);
  const minSemana = acts.filter(a => a.dia >= seg && a.dia <= hoje).reduce((s, a) => s + minA(a), 0);
  let seq = 0;
  for (let s = addDays(seg, -7); ; s = addDays(s, -7)) {
    const m = acts.filter(a => a.dia >= s && a.dia <= addDays(s, 6)).reduce((t, a) => t + minA(a), 0);
    if (m >= 150) seq++; else break;
  }
  if (minSemana >= 150) cards.push({ tom: 'bom', titulo: 'Meta da semana batida', txt: `${n0(minSemana)} min de atividade desde segunda (a OMS recomenda 150).${seq ? ` São ${seq + 1} semanas seguidas na meta!` : ' Agora é manter o ritmo.'}` });
  else {
    const falta = 150 - minSemana, diasRest = 7 - ((dow(hoje) + 6) % 7);
    const n = Math.max(1, Math.min(diasRest, Math.ceil(falta / 40))), cada = n0(Math.max(15, falta / n));
    cards.push({ tom: 'meta', titulo: 'Meta da semana', txt: `${n0(minSemana)} de 150 min. Faltam ${n0(falta)} min: ${n === 1 ? `um treino de ~${cada} min${diasRest === 1 ? ' hoje' : ''} fecha.` : `${n} treinos de ~${cada} min fecham.`}${seq ? ` Você vem de ${plural(seq, 'semana', 'semanas')} na meta: não deixe a sequência cair!` : ''}` });
  }
  const pHoje = por[hoje];
  if (pHoje?.passos != null && pHoje.meta_passos) {
    const falta = pHoje.meta_passos - pHoje.passos;
    cards.push(falta > 0
      ? { tom: 'meta', titulo: 'Passos de hoje', txt: `Faltam ${n0(falta)} passos para a meta: uma caminhada de ~${n0(Math.max(5, falta / 110))} min resolve.` }
      : { tom: 'bom', titulo: 'Passos de hoje', txt: `Meta batida: ${n0(pHoje.passos)} passos. Cada passo extra conta.` });
  }
  const sono7 = media(Array.from({ length: 7 }, (_, i) => por[addDays(hoje, -i)]?.sono_seg));
  const noites7 = Array.from({ length: 7 }, (_, i) => por[addDays(hoje, -i)]?.sono_seg).filter(Boolean).length;
  if (sono7 && noites7 >= 3) cards.push(sono7 >= 7 * 3600
    ? { tom: 'bom', titulo: 'Sono em dia', txt: `Média de ${hm(sono7)} nos últimos 7 dias. Sono assim é o que mais ajuda na recuperação e no rendimento.` }
    : { tom: 'meta', titulo: 'Sono da semana', txt: `Média de ${hm(sono7)}. Deitar 30 min mais cedo já leva você às 7 h, e o treino rende mais.` });
  const forca28 = acts.filter(a => FORCA.includes(a.tipo) && a.dia > addDays(hoje, -28)).length;
  if (forca28) cards.push(forca28 >= 8
    ? { tom: 'bom', titulo: 'Constância na força', txt: `${forca28} treinos de força em 4 semanas, ${(forca28 / 4).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} por semana. Músculo é saúde a longo prazo: continue!` }
    : { tom: 'meta', titulo: 'Força', txt: `${forca28} treinos de força em 4 semanas. Chegar a 2 por semana protege articulações e metabolismo.` });
  // Tendências de longo prazo: só elogia o que melhorou (o resto aparece nos gráficos)
  const rhrAgora = base('fc_repouso', 0, 29), rhrAntes = base('fc_repouso', 60, 89);
  if (rhrAgora && rhrAntes && rhrAntes - rhrAgora >= 2) cards.push({ tom: 'bom', titulo: 'Coração mais eficiente', txt: `FC de repouso caiu de ${n0(rhrAntes)} para ${n0(rhrAgora)} bpm em relação a 2 meses atrás. Sinal claro de condicionamento.` });
  const vo2 = daily.filter(r => r.vo2max).sort((a, b) => a.dia.localeCompare(b.dia));
  if (vo2.length >= 2) {
    const ult = vo2.at(-1), ant = vo2.filter(r => r.dia <= addDays(ult.dia, -60)).at(-1);
    if (ant && +ult.vo2max > +ant.vo2max) cards.push({ tom: 'bom', titulo: 'VO2máx subindo', txt: `De ${(+ant.vo2max).toLocaleString('pt-BR')} para ${(+ult.vo2max).toLocaleString('pt-BR')}. Mais fôlego, mais anos de vida ativa.` });
  }

  return { estado, titulo, texto, sugestao, motivos, semDados: !rec, cards };
}
