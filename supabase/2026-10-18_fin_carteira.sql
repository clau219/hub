-- Carteira de investimentos (painel novo da aba Finanças). Rode uma vez. Só ACRESCENTA: nada existente muda.
-- fin_invest ganha colunas para ativos manuais e para ajustes do usuário (classe, ticker, liquidez):
--   fonte 'pluggy' (vem do banco; o fin-sync atualiza saldo/quantidade/preço) ou 'manual' (cadastrado no Hub).
--   classe: vazio = automática pelo tipo/subtipo da Pluggy; preenchida = escolha do usuário (vale para os dois).
-- fin_inv_mov:      aportes, resgates, proventos e impostos por ativo (do banco ou lançados à mão)
-- fin_snap:         foto diária de contas e faturas (gráfico de evolução do patrimônio)
-- fin_invest_hist:  foto diária do valor de cada investimento (evolução por classe e gráfico de cada ativo)

alter table fin_invest add column if not exists fonte text not null default 'pluggy';
alter table fin_invest add column if not exists classe text;
alter table fin_invest add column if not exists ticker text;
alter table fin_invest add column if not exists quantidade numeric;
alter table fin_invest add column if not exists preco_medio numeric;
alter table fin_invest add column if not exists preco_atual numeric;
alter table fin_invest add column if not exists liquidez text;   -- 'diaria' | 'vencimento' | 'D+N' (vazio = automática)
alter table fin_invest add column if not exists obs text;

create table if not exists fin_inv_mov (
  id text primary key default gen_random_uuid()::text,  -- do banco: 'p-<id da Pluggy>'
  invest_id text references fin_invest(id) on delete cascade,
  data date not null,
  tipo text not null,               -- aporte | resgate | provento | imposto | transferencia
  subtipo text,                     -- provento: dividendo | jcp | rendimento | juros
  valor numeric not null,           -- sempre positivo; o tipo diz o sentido
  quantidade numeric,
  descricao text,
  fonte text not null default 'manual',
  criado_em timestamptz not null default now()
);
create index if not exists fin_inv_mov_data on fin_inv_mov (data);
create index if not exists fin_inv_mov_inv on fin_inv_mov (invest_id, data);

create table if not exists fin_snap (
  dia date primary key,
  contas numeric,                   -- saldo das contas (fora as ocultas)
  faturas numeric,                  -- faturas em aberto
  atualizado_em timestamptz not null default now()
);

create table if not exists fin_invest_hist (
  invest_id text not null,          -- sem FK: o histórico fica mesmo se o ativo sair
  dia date not null,
  saldo numeric,
  aplicado numeric,
  primary key (invest_id, dia)
);
create index if not exists fin_invest_hist_dia on fin_invest_hist (dia);

do $$
declare t text;
begin
  foreach t in array array['fin_inv_mov', 'fin_snap', 'fin_invest_hist'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "dono" on %I', t);
    execute format('create policy "dono" on %I for all to authenticated using (true) with check (true)', t);
    execute format('drop policy if exists so_dono on %I', t);
    execute format('create policy so_dono on %I as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- Para desfazer (os dados antigos de fin_invest continuam intactos):
-- drop table if exists fin_invest_hist; drop table if exists fin_snap; drop table if exists fin_inv_mov;
-- delete from fin_invest where fonte = 'manual';
-- alter table fin_invest drop column if exists fonte, drop column if exists classe, drop column if exists ticker,
--   drop column if exists quantidade, drop column if exists preco_medio, drop column if exists preco_atual,
--   drop column if exists liquidez, drop column if exists obs;
