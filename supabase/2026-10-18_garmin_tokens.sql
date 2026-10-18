-- Acesso (tokens) do Garmin para a sincronização na nuvem (GitHub Actions).
-- RLS ligado e SEM políticas: só a chave de serviço lê e grava; o site (anon/authenticated) não vê.
create table if not exists garmin_tokens (
  id int primary key default 1 check (id = 1),
  tokens text not null,
  atualizado_em timestamptz not null default now()
);
alter table garmin_tokens enable row level security;
