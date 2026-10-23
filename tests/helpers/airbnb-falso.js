// Airbnb falso (API do site usada pela airbnb-quote): preço por noite + R$ 100 de limpeza, datas ocupadas,
// mínimo de noites e lotação por anúncio. Também calcula o total esperado, para o teste conferir o que o robô disse.
import { simular } from './rede.js';

export const ANUNCIO = { QS39: '45895549', QS40: '1315796557769332463', QS50: '28283599' };
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
export const noites = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const range = (a, b) => Array.from({ length: noites(a, b) }, (_, i) => addDays(a, i));
const brl = v => v.toLocaleString('pt-BR');

// casas: { QS40: { diaria, lotacao, ocupados: [dias], minNoites } }; falha: ids de casa que respondem 500
export function airbnbFalso({ casas = {}, falha = [] } = {}) {
  const por = Object.fromEntries(Object.entries(ANUNCIO).map(([casa, id]) => [id, { diaria: 400, ...casas[casa] }]));
  const falhas = falha.map(c => ANUNCIO[c]);
  const estado = { consultas: [] };
  simular(/airbnb\.com\.br\/api\/v3\/StaysPdpBookItQuery\//, req => {
    const v = JSON.parse(new URL(req.url).searchParams.get('variables'));
    const id = atob(v.id).split(':')[1], { startDate: ci, endDate: co } = v.dateRange, n = noites(ci, co), c = por[id];
    estado.consultas.push({ id, ci, co, adultos: v.guestCounts.numberOfAdults });
    if (falhas.includes(id)) return { status: 500 };
    const nao = motivo => ({ data: { node: { pdpPresentation: { bookIt: { availability: { isAvailable: false, unavailabilityReason: motivo } } } } } });
    if (c.lotacao && v.guestCounts.numberOfAdults > c.lotacao) return nao('GUEST');
    if (range(ci, co).some(d => (c.ocupados || []).includes(d)) || n < (c.minNoites || 1)) return nao('DATE');
    const total = n * c.diaria + 100;
    return { data: { node: { pdpPresentation: { bookIt: { availability: { isAvailable: true }, productItemDetail: { explanationData: { priceDetails: [{ items: [
      { description: `${n} noites x R$ ${brl(c.diaria)}`, priceString: `R$ ${brl(n * c.diaria)}` },
      { description: 'Taxa de limpeza', priceString: 'R$ 100' },
      { description: 'Total (BRL)', priceString: `R$ ${brl(total)}` },
    ] }] } } } } } } };
  });
  simular(/airbnb\.com\.br\/api\/v3\/PdpAvailabilityCalendar\//, req => {
    const { request: r } = JSON.parse(new URL(req.url).searchParams.get('variables'));
    const c = por[r.listingId];
    const meses = Array.from({ length: r.count }, (_, k) => {
      const ini = new Date(Date.UTC(r.year, r.month - 1 + k, 1)).toISOString().slice(0, 10), fim = new Date(Date.UTC(r.year, r.month + k, 1)).toISOString().slice(0, 10);
      return { days: range(ini, fim).map(d => {
        const livre = !(c.ocupados || []).includes(d);
        return { calendarDate: d, available: livre, availableForCheckin: livre, availableForCheckout: true, minNights: c.minNoites || 1 };
      }) };
    });
    return { data: { merlin: { pdpAvailabilityCalendar: { calendarMonths: meses } } } };
  });
  // Total que o Airbnb cobraria (para conferir a resposta do robô)
  estado.total = (casa, ci, co) => noites(ci, co) * por[ANUNCIO[casa]].diaria + 100;
  return estado;
}
export const calendarSources = () => Object.entries(ANUNCIO).map(([casa, id], i) => ({ id: 'src' + i, property_id: casa, url: `https://www.airbnb.com.br/calendar/ical/${id}.ics?s=x` }));
