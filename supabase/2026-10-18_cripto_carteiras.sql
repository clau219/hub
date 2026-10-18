-- Carteiras de autocustódia (OneKey, Rabby…) lidas pela blockchain, só com o endereço público. Rode uma vez.
-- cripto_carteiras: endereços cadastrados (rede btc ou evm)
-- cripto_saldos:    o que a função cripto-carteiras encontrou em cada rede (quantidade; o preço vem da CoinGecko na tela)
create table if not exists cripto_carteiras (
  id uuid primary key default gen_random_uuid(),
  nome text,
  rede text not null check (rede in ('btc', 'evm')),
  endereco text not null unique,
  lido_em timestamptz,
  erro text,
  criado_em timestamptz not null default now()
);
create table if not exists cripto_saldos (
  carteira_id uuid not null references cripto_carteiras(id) on delete cascade,
  chain text not null,              -- bitcoin | ethereum | base | arbitrum | optimism | polygon | bsc | avalanche…
  token text not null,              -- 'native' ou o contrato (minúsculo)
  simbolo text,
  nome text,
  coin_id text,                     -- id da CoinGecko (junta com as compras da tela Cripto)
  quantidade numeric not null,
  preco_usd numeric,                -- preço informado pelo indexador, quando não há coin_id
  atualizado_em timestamptz not null default now(),
  primary key (carteira_id, chain, token)
);
do $$
declare t text;
begin
  foreach t in array array['cripto_carteiras', 'cripto_saldos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "dono" on %I', t);
    execute format('create policy "dono" on %I for all to authenticated using (true) with check (true)', t);
    execute format('drop policy if exists so_dono on %I', t);
    execute format('create policy so_dono on %I as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- Leitura 2x por dia (junto com o fin-sync)
select cron.schedule('cripto-carteiras', '20 10,21 * * *', $$
  select net.http_post(
    url := 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1/cripto-carteiras',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-hub-cron', (select value from app_secrets where key = 'cron_token')),
    body := '{}'::jsonb)
$$);
-- Para desfazer: select cron.unschedule('cripto-carteiras'); drop table cripto_saldos; drop table cripto_carteiras;
