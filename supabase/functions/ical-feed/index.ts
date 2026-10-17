// Publica os calendários do Hub em formato iCal, para assinar no Google Agenda.
//   ?cal=alugueis&token=...  → Airbnb + reservas diretas das 3 casas
//   ?cal=dj&token=...        → gigs do pipeline (fechadas, realizadas e pagas)
//   ?cal=diretas&casa=QS39&token=... → só o que NÃO veio do Airbnb (reservas diretas, Booking, bloqueios do Hub) de uma casa,
//                                      para importar no calendário do anúncio e o Airbnb bloquear essas datas sozinho
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

Deno.serve(async req => {
  const u = new URL(req.url);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: tk } = await sb.from('app_config').select('value').eq('key', 'feed_token').single();
  if (!tk || u.searchParams.get('token') !== tk.value) return new Response('Não autorizado', { status: 401 });
  const cal = u.searchParams.get('cal') || 'alugueis';
  const stamp = fmtUtc(new Date().toISOString());
  const evs: string[] = [];

  if (cal === 'alugueis') {
    const [{ data: props }, { data: bks }] = await Promise.all([
      sb.from('properties').select('*'),
      sb.from('bookings').select('*').neq('status', 'cancelada').gte('checkout', new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)),
    ]);
    const nome = (id: string) => props?.find(p => p.id === id)?.nome || id;
    for (const b of bks || []) {
      const titulo = b.status === 'bloqueio' ? `${nome(b.property_id)}: bloqueado` : `${nome(b.property_id)}: ${b.hospede || 'reserva'} (${b.origem})`;
      evs.push(vevent(`bk-${b.id}`, stamp, titulo, `DTSTART;VALUE=DATE:${b.checkin.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${b.checkout.replace(/-/g, '')}`, b.notas));
    }
  } else if (cal === 'diretas') {
    const casa = u.searchParams.get('casa');
    if (!casa) return new Response('informe ?casa=', { status: 400 });
    const { data: bks } = await sb.from('bookings').select('id,checkin,checkout,status,origem,hospede')
      .eq('property_id', casa).neq('status', 'cancelada').or('origem.is.null,origem.neq.airbnb')
      .gte('checkout', new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10));
    // Título para reconhecer no Airbnb: origem + primeiro nome ("Direta: Marina (Hub)"). Sobrenome e documento não saem do Hub.
    const ORIGEM: Record<string, string> = { direto: 'Direta', booking: 'Booking', outro: 'Reserva' };
    for (const b of bks || []) {
      const nome = String(b.hospede || '').trim().split(/\s+/)[0];
      const titulo = b.status === 'bloqueio' ? 'Bloqueio (Hub)' : `${ORIGEM[b.origem] || 'Reserva'}${nome ? ': ' + nome : ''} (Hub)`;
      evs.push(vevent(`dir-${b.id}`, stamp, titulo, `DTSTART;VALUE=DATE:${b.checkin.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${b.checkout.replace(/-/g, '')}`));
    }
  } else if (cal === 'dj') {
    const { data: deals } = await sb.from('deals').select('*, contacts(nome)').eq('negocio', 'dj').in('etapa', ['fechado', 'realizado', 'pago']).not('data_evento', 'is', null);
    for (const d of deals || []) {
      const titulo = `DJ CLAU: ${d.contacts?.nome || d.titulo}`;
      if (d.hora_inicio) {
        const ini = new Date(`${d.data_evento}T${d.hora_inicio}-03:00`);
        let fim = d.hora_fim ? new Date(`${d.data_evento}T${d.hora_fim}-03:00`) : new Date(ini.getTime() + 4 * 3600e3);
        if (fim <= ini) fim = new Date(fim.getTime() + 864e5); // termina depois da meia-noite
        evs.push(vevent(`deal-${d.id}`, stamp, titulo, `DTSTART:${fmtUtc(ini.toISOString())}`, `DTEND:${fmtUtc(fim.toISOString())}`, d.notas, d.local));
      } else {
        const fim = new Date(new Date(d.data_evento + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
        evs.push(vevent(`deal-${d.id}`, stamp, titulo, `DTSTART;VALUE=DATE:${d.data_evento.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${fim.replace(/-/g, '')}`, d.notas, d.local));
      }
    }
  }

  const nomeCal = cal === 'dj' ? 'Hub: Gigs DJ' : cal === 'diretas' ? 'Hub: reservas diretas' : 'Hub: Aluguéis';
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hub//PT-BR', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${nomeCal}`, 'X-WR-TIMEZONE:America/Sao_Paulo', ...evs, 'END:VCALENDAR'].join('\r\n');
  return new Response(body, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=900' } });
});

const fmtUtc = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
function vevent(uid: string, stamp: string, summary: string, dtstart: string, dtend: string, desc?: string | null, loc?: string | null) {
  return ['BEGIN:VEVENT', `UID:${uid}@hub`, `DTSTAMP:${stamp}`, dtstart, dtend, `SUMMARY:${esc(summary)}`,
    ...(desc ? [`DESCRIPTION:${esc(desc)}`] : []), ...(loc ? [`LOCATION:${esc(loc)}`] : []), 'END:VEVENT'].join('\r\n');
}
