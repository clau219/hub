// Consulta disponibilidade e preço direto no Airbnb: o mesmo que um hóspede vê no anúncio.
// O número do anúncio sai do link iCal de cada casa (calendar_sources).
// Chamada pelo botão "Consultar Airbnb" em Aluguéis e, depois, pela resposta automática do WhatsApp.
// POST { checkin: "2026-11-17", checkout: "2026-11-20", adultos: 2, casas?: ["QS50"] }
// Não é API oficial: se o Airbnb mudar o site, devolve status "erro" e quem chamou não informa preço.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hub-cron' };
const API = 'https://www.airbnb.com.br/api/v3';
const KEY = 'd306zoyjsyarp7ifhu67rjxn52tv0t20'; // chave pública que o próprio site usa
// Hashes das consultas do site. Se mudarem, achar nos .js da página do anúncio (operationId de StaysPdpBookItQuery / PdpAvailabilityCalendar).
const H_PRECO = '8c9165db910115bff8003e61f847ed907c9c51509ba043fa0610853d7c4de080';
const H_CAL = '8f08e03c7bd16fcad3c92a3592c19a8b559a0d0855a84028d1163d4733ed9ade';
const BUSCA_ALT = 14; // procura datas livres até N dias antes/depois

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if (!(await autorizado(req, sb))) return json({ error: 'não autorizado' }, 401);

  let p: any;
  try { p = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }
  const { checkin, checkout } = p;
  const adultos = Math.max(1, Math.round(+p.adultos || 2));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin || '') || !/^\d{4}-\d{2}-\d{2}$/.test(checkout || '')) return json({ error: 'datas no formato AAAA-MM-DD' }, 400);
  const noites = dias(checkin, checkout);
  if (noites < 1) return json({ error: 'a saída precisa ser depois da entrada' }, 400);
  if (noites > 60) return json({ error: 'máximo de 60 noites' }, 400);

  const [{ data: props }, { data: fontes }] = await Promise.all([
    sb.from('properties').select('id,nome').order('nome'),
    sb.from('calendar_sources').select('property_id,url').not('property_id', 'is', null),
  ]);
  const anuncio: Record<string, string> = {};
  for (const f of fontes || []) {
    const m = String(f.url).match(/airbnb\.[^/]+\/calendar\/ical\/(\d+)/);
    if (m) anuncio[f.property_id] = m[1];
  }
  const alvo = (props || []).filter(c => anuncio[c.id] && (!p.casas?.length || p.casas.includes(c.id)));
  if (!alvo.length) return json({ error: 'nenhuma casa com link iCal do Airbnb cadastrado' }, 400);

  const casas = await Promise.all(alvo.map(c => consultarCasa(c, anuncio[c.id], checkin, checkout, adultos)));
  const r = { checkin, checkout, noites, adultos, casas };
  return json({ ...r, mensagem: mensagem(r) });
});

async function consultarCasa(c: { id: string; nome: string }, listing: string, ci: string, co: string, adultos: number) {
  const base = { id: c.id, nome: c.nome, airbnb_id: listing, link: `https://www.airbnb.com.br/rooms/${listing}?check_in=${ci}&check_out=${co}&adults=${adultos}` };
  try {
    const q = await cotar(listing, ci, co, adultos);
    if (q.livre) return { ...base, status: 'livre', ...q };
    // Indisponível: o calendário diz se é ocupação ou mínimo de noites, e acha a data livre mais próxima
    const cal = await calendario(listing, addDays(ci, -BUSCA_ALT), addDays(co, BUSCA_ALT));
    const minNoites = cal[ci]?.minNights || null;
    const noitesLivres = rangeDias(ci, co).every(d => cal[d]?.available);
    const status = q.motivo === 'GUEST' ? 'capacidade'
      : q.motivo === 'DATE' && noitesLivres && minNoites && dias(ci, co) < minNoites ? 'min_noites' : 'ocupada';
    if (status === 'capacidade') return { ...base, status, motivo: q.motivo };
    // Mínimo de noites: cota a estadia mínima a partir da mesma entrada; ocupada: mesma duração em outra data
    const alt = status === 'min_noites' ? { checkin: ci, checkout: addDays(ci, minNoites!) } : alternativa(cal, ci, co);
    let alternativaQ = null;
    if (alt) {
      const qa = await cotar(listing, alt.checkin, alt.checkout, adultos).catch(() => null);
      if (qa?.livre) alternativaQ = { ...alt, total: qa.total, diaria: qa.diaria };
    }
    return { ...base, status, motivo: q.motivo, min_noites: minNoites, alternativa: alternativaQ };
  } catch (e) {
    return { ...base, status: 'erro', erro: String((e as Error).message || e) };
  }
}

// Preço total para as datas (StaysPdpBookItQuery, o quadro "Reservar" do anúncio)
async function cotar(listing: string, ci: string, co: string, adultos: number) {
  const v = {
    id: btoa(`DemandStayListing:${listing}`), dateRange: { startDate: ci, endDate: co }, guestCounts: { numberOfAdults: adultos },
    includePdpMigrationBookItCalendarSheetFragment: false, includePdpMigrationBookItFloatingFooterFragment: false,
    includePdpMigrationBookItNavFragment: false, includePdpMigrationBookItSidebarFragment: false, includeGalleryBookItCtaFragment: true,
    includeOverviewMerchandisingTipsFragment: true, includeStaysPdpPriceHeatmapFragment: false,
    priceHeatmapDateRange: { startDate: ci, endDate: co }, selectedCancellationPolicyId: null, causeId: null, selectedGuestOptionId: null,
  };
  const j = await gql('StaysPdpBookItQuery', H_PRECO, v);
  const b = j?.data?.node?.pdpPresentation?.bookIt;
  if (!b?.availability) throw new Error('resposta do Airbnb mudou (preço)');
  if (!b.availability.isAvailable) return { livre: false, motivo: b.availability.unavailabilityReason as string };
  const itens = (b.productItemDetail?.explanationData?.priceDetails || []).flatMap((g: any) => g.items || []);
  const totalItem = itens.find((i: any) => /^total/i.test(i.description || ''));
  const total = reais(totalItem?.priceString);
  if (total == null) throw new Error('Airbnb não mostrou o total');
  const linhas = itens.filter((i: any) => i !== totalItem).map((i: any) => ({ descricao: i.description, valor: reais(i.priceString) }));
  const diaria = reais(itens.find((i: any) => /noites?\s*x/i.test(i.description || ''))?.description?.split(/x/i).pop()) ?? null;
  return { livre: true, total, diaria, linhas };
}

// Calendário do anúncio: { "2026-11-17": { available, availableForCheckin, availableForCheckout, minNights } }
async function calendario(listing: string, de: string, ate: string) {
  const [y, m] = de.split('-').map(Number);
  const count = (+ate.slice(0, 4) - y) * 12 + (+ate.slice(5, 7) - m) + 1;
  const j = await gql('PdpAvailabilityCalendar', H_CAL, { request: { count, listingId: listing, month: m, year: y } });
  const meses = j?.data?.merlin?.pdpAvailabilityCalendar?.calendarMonths;
  if (!meses) throw new Error('resposta do Airbnb mudou (calendário)');
  const cal: Record<string, any> = {};
  for (const mes of meses) for (const d of mes.days) cal[d.calendarDate] = d;
  return cal;
}

// Mesmo número de noites, começando o mais perto possível da data pedida (depois de hoje)
function alternativa(cal: Record<string, any>, ci: string, co: string) {
  const n = dias(ci, co), hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  for (let k = 1; k <= BUSCA_ALT; k++) for (const off of [k, -k]) {
    const ini = addDays(ci, off), fim = addDays(ini, n);
    if (ini <= hoje || !cal[ini]?.availableForCheckin || !cal[fim]?.availableForCheckout) continue;
    if (n < (cal[ini].minNights || 1)) continue;
    if (rangeDias(ini, fim).every(d => cal[d]?.available)) return { checkin: ini, checkout: fim };
  }
  return null;
}

async function gql(op: string, hash: string, variables: unknown) {
  const u = new URL(`${API}/${op}/${hash}`);
  u.searchParams.set('operationName', op); u.searchParams.set('locale', 'pt'); u.searchParams.set('currency', 'BRL');
  u.searchParams.set('variables', JSON.stringify(variables));
  u.searchParams.set('extensions', JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }));
  const r = await fetch(u, { headers: { 'X-Airbnb-API-Key': KEY, 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Airbnb respondeu ${r.status}`);
  const j = await r.json();
  if (j.errors?.length && !j.data) throw new Error('Airbnb recusou a consulta: ' + (j.errors[0].message || '').slice(0, 80));
  return j;
}

// ---------- texto pronto para o WhatsApp ----------
function mensagem(r: any) {
  const p = (n: number, s: string, pl: string) => `${n} ${n === 1 ? s : pl}`;
  const cab = `Para ${dm(r.checkin)} a ${dm(r.checkout)} (${p(r.noites, 'noite', 'noites')}, ${p(r.adultos, 'hóspede', 'hóspedes')}):`;
  const linhas = r.casas.filter((c: any) => c.status !== 'erro').map((c: any) => {
    if (c.status === 'livre') return `• ${c.nome}: disponível, ${moeda(c.total)} no total${c.diaria ? ` (${moeda(c.diaria)} por noite)` : ''}`;
    if (c.status === 'capacidade') return `• ${c.nome}: não comporta ${p(r.adultos, 'hóspede', 'hóspedes')}`;
    if (c.status === 'min_noites') return `• ${c.nome}: mínimo de ${c.min_noites} noites nessa data` +
      (c.alternativa ? `; de ${dm(c.alternativa.checkin)} a ${dm(c.alternativa.checkout)} fica ${moeda(c.alternativa.total)}` : '');
    const alt = c.alternativa ? `; livre de ${dm(c.alternativa.checkin)} a ${dm(c.alternativa.checkout)} por ${moeda(c.alternativa.total)}` : '';
    return `• ${c.nome}: ocupada nessas datas${alt}`;
  });
  if (!linhas.length) return null;
  const algumaLivre = r.casas.some((c: any) => c.status === 'livre' || c.alternativa);
  return [`Olá! ${cab}`, ...linhas, algumaLivre ? 'Quer que eu separe alguma delas para você?' : 'Se tiver flexibilidade nas datas, me avise que eu verifico outras opções.'].join('\n');
}

const reais = (s?: string | null) => {
  const m = String(s || '').match(/R\$\s*([\d.]+(?:,\d{1,2})?)/);
  return m ? +m[1].replace(/\./g, '').replace(',', '.') : null;
};
const moeda = (v: number) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
const rangeDias = (a: string, b: string) => Array.from({ length: dias(a, b) }, (_, i) => addDays(a, i));
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Usuário logado no Hub, o agendador (x-hub-cron) ou outra função do projeto (chave service role)
async function autorizado(req: Request, sb: any) {
  const cron = req.headers.get('x-hub-cron');
  if (cron) {
    const { data } = await sb.from('app_secrets').select('value').eq('key', 'cron_token').single();
    return !!data && data.value === cron;
  }
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (jwt && jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return true;
  if (!jwt || jwt.startsWith('sb_')) return false;
  const { data } = await sb.auth.getUser(jwt);
  return !!data?.user;
}
