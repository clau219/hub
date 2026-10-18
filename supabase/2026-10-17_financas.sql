-- Tela Finanças (Open Finance via Meu Pluggy). Rode uma vez.
-- fin_items:  conexões do Meu Pluggy (Item ID copiado do dashboard da Pluggy); uma por banco
-- fin_contas: contas e cartões que vêm de cada conexão
-- fin_tx:     lançamentos (valor < 0 = saída, > 0 = entrada); categoria/negócio/casa ajustáveis no Hub
-- fin_regras: "descrição contém X" → categoria/negócio/casa; aplicadas pelo fin-sync nos lançamentos novos
-- app_config 'fin_status': quando o fin-sync rodou pela última vez e o que trouxe

create table if not exists fin_items (
  id text primary key,              -- itemId da Pluggy
  nome text,
  status text,
  erro text,
  sincronizado_em timestamptz,      -- última vez que a Pluggy atualizou o banco
  lido_em timestamptz,              -- última vez que o Hub leu
  criado_em timestamptz not null default now()
);

create table if not exists fin_contas (
  id text primary key,              -- accountId da Pluggy
  item_id text references fin_items(id) on delete cascade,
  tipo text,                        -- BANK | CREDIT
  subtipo text,                     -- CHECKING_ACCOUNT | SAVINGS_ACCOUNT | CREDIT_CARD
  nome text,
  apelido text,                     -- nome escolhido no Hub
  numero text,
  saldo numeric,                    -- conta: saldo; cartão: fatura em aberto
  limite numeric,
  limite_disp numeric,
  fecha date,
  vence date,
  oculta boolean not null default false,
  atualizado_em timestamptz not null default now()
);

create table if not exists fin_tx (
  id text primary key,              -- transactionId da Pluggy
  conta_id text references fin_contas(id) on delete cascade,
  data date not null,
  descricao text,
  valor numeric not null,
  status text,                      -- POSTED | PENDING
  cat_pluggy text,
  categoria text,
  negocio text,                     -- chaves de AREAS (util.js): pessoal | dj | alugueis | consultoria | casa | flores
  casa text,                        -- properties.id (QS39, QS40, QS50)
  contraparte text,
  parcela text,                     -- "3/10"
  manual boolean not null default false, -- categoria escolhida à mão: o sync não mexe
  atualizado_em timestamptz not null default now()
);
create index if not exists fin_tx_data on fin_tx (data);
create index if not exists fin_tx_conta on fin_tx (conta_id, data);

create table if not exists fin_regras (
  id uuid primary key default gen_random_uuid(),
  contem text not null,             -- trecho da descrição/contraparte, sem diferenciar maiúsculas
  categoria text,
  negocio text,
  casa text,
  criado_em timestamptz not null default now()
);

alter table fin_items enable row level security;
alter table fin_contas enable row level security;
alter table fin_tx enable row level security;
alter table fin_regras enable row level security;
drop policy if exists "dono" on fin_items;
drop policy if exists "dono" on fin_contas;
drop policy if exists "dono" on fin_tx;
drop policy if exists "dono" on fin_regras;
create policy "dono" on fin_items for all to authenticated using (true) with check (true);
create policy "dono" on fin_contas for all to authenticated using (true) with check (true);
create policy "dono" on fin_tx for all to authenticated using (true) with check (true);
create policy "dono" on fin_regras for all to authenticated using (true) with check (true);
-- Política restritiva so_dono (igual a 2026-10-14_rls_dono.sql): só a conta do Claudio
drop policy if exists so_dono on fin_items;
drop policy if exists so_dono on fin_contas;
drop policy if exists so_dono on fin_tx;
drop policy if exists so_dono on fin_regras;
create policy so_dono on fin_items as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy so_dono on fin_contas as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy so_dono on fin_tx as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy so_dono on fin_regras as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Sincronização 2x por dia (a Pluggy atualiza o Meu Pluggy a cada 24 h)
select cron.schedule('fin-sync', '15 10,21 * * *', $$
  select net.http_post(
    url := 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1/fin-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-hub-cron', (select value from app_secrets where key = 'cron_token')),
    body := '{}'::jsonb)
$$);
