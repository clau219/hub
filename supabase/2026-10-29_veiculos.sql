-- Veículos autorizados na portaria, junto com os hóspedes (rode uma vez no SQL Editor do Supabase).
-- veiculos: [{"modelo":"Honda HRV","placa":"TZX3D00"}, ...]
alter table bookings add column if not exists veiculos jsonb not null default '[]'::jsonb;
