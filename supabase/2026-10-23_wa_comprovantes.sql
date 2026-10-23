-- Robô do WhatsApp: comprovantes de Pix do sinal lidos pela IA. Guarda todos (válidos ou não) para o Claudio
-- conferir, e o ID E2E único impede que o mesmo comprovante confirme duas reservas.
create table if not exists wa_comprovantes (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null,
  deal_id uuid references deals(id) on delete set null,
  booking_id uuid references bookings(id) on delete set null,
  e2e text,
  valor numeric,
  status text not null check (status in ('valido', 'invalido')),
  motivo text,
  leitura jsonb,          -- o que a IA leu: valor, recebedor, chave, data/hora, E2E, pagador
  sinal jsonb,            -- o que era esperado: casa, datas, total, sinal, desde
  criado_em timestamptz not null default now()
);
create unique index if not exists wa_comprovantes_e2e_valido on wa_comprovantes (upper(e2e)) where e2e is not null and status = 'valido';
alter table wa_comprovantes enable row level security;
drop policy if exists dono on wa_comprovantes;
create policy dono on wa_comprovantes for all to authenticated using (true) with check (true);
