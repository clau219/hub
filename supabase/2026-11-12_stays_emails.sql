-- Avisos de reserva da Stays por e-mail (Configurações › E-mails › Reserva › "Atualizações de reserva para seu
-- time" → claudiorsbraga@gmail.com). Um Apps Script no Gmail repassa cada e-mail de noreply@stays.net para a
-- função stays-email, que guarda aqui uma linha por reserva (código da Stays) e completa a reserva do Hub que tem
-- "Stays <código>" nas notas (o ical-sync grava assim): valor, nome, contato, hóspedes e canal. O iCal da Stays
-- só traz as datas; o e-mail costuma chegar antes da reserva aparecer no Hub, por isso fica guardado até casar.
-- O token do script fica em app_secrets 'stays_email_token' (gravado à parte, fora do git).

create table if not exists stays_emails (
  codigo text primary key,              -- código da reserva na Stays (YY01J)
  status text,                          -- reservado, cancelado, pré-reserva, contrato, deletado (como vem no e-mail)
  hospede text,
  contatos text,
  pessoas int,
  checkin date,
  checkout date,
  noites int,
  valor numeric(12,2),                  -- Valor Total da Reserva
  acomodacao text,                      -- nome do anúncio na Stays
  casa text,                            -- id da casa no Hub (QS39...), deduzido da acomodação
  canal text,                           -- Canal de Venda (Airbnb, Decolar, Booking...; vazio = manual)
  comissao numeric(12,2),               -- Comissão do Canal
  assunto text,
  msg_id text,                          -- id da mensagem no Gmail (o script não manda a mesma duas vezes)
  recebido_em timestamptz not null,     -- data do e-mail (vale o mais recente)
  booking_id uuid,                      -- reserva do Hub que recebeu os dados
  valor_aplicado numeric(12,2),         -- último valor gravado na reserva (se você mudou à mão depois, não sobrescreve)
  hospede_aplicado text,
  aplicado_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists stays_emails_pendentes on stays_emails (aplicado_em) where booking_id is null;

alter table public.stays_emails enable row level security;
drop policy if exists "dono" on public.stays_emails;
create policy "dono" on public.stays_emails for all to authenticated using (true) with check (true);
drop policy if exists so_dono on public.stays_emails;
create policy so_dono on public.stays_emails as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner());
