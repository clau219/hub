-- Investimentos do Open Finance (Meu Pluggy): uma linha por aplicação (CDB/RDB, caixinha, fundo, Tesouro, ações…). Rode uma vez.
create table if not exists fin_invest (
  id text primary key,              -- investmentId da Pluggy
  item_id text references fin_items(id) on delete cascade,
  nome text,
  tipo text,                        -- FIXED_INCOME | MUTUAL_FUND | SECURITY | EQUITY | ETF | COE | OTHER
  subtipo text,                     -- CDB, LCI, LCA, TREASURY, RETIREMENT…
  emissor text,
  saldo numeric,                    -- valor atual (bruto)
  aplicado numeric,                 -- valor original investido
  rendimento numeric,               -- lucro informado pela instituição
  liquido numeric,                  -- valor de resgate (líquido de IR/IOF), quando vier
  taxa numeric,
  taxa_tipo text,                   -- CDI, IPCA, SELIC…
  taxa_fixa numeric,                -- % ao ano prefixado
  rend_12m numeric,
  vence date,
  data date,                        -- data do saldo
  status text,                      -- ACTIVE | PENDING | TOTAL_WITHDRAWAL
  oculta boolean not null default false,
  atualizado_em timestamptz not null default now()
);
alter table fin_invest enable row level security;
drop policy if exists "dono" on fin_invest;
create policy "dono" on fin_invest for all to authenticated using (true) with check (true);
drop policy if exists so_dono on fin_invest;
create policy so_dono on fin_invest as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner());
