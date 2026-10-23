-- Canal do dono: o Claudio manda mensagem do número pessoal para o WhatsApp das casas e o Hub trata como comando
-- (wa-webhook → _shared/dono.ts). Também manda o resumo do dia nesse número (função wa-dono, cron abaixo).
-- wa_settings.dono_wa: número pessoal (só dígitos, com 55). Vazio = canal desligado.
-- dono_msgs: a conversa com o dono (contexto para "o valor é 3800", "desfaz").
-- dono_acoes: tudo que o canal gravou, com o antes e o depois, para corrigir ou desfazer em até 24 h.
alter table wa_settings add column if not exists dono_wa text;
alter table wa_settings add column if not exists dono_resumo boolean not null default true;

create table if not exists dono_msgs (
  id uuid primary key default gen_random_uuid(),
  wamid text unique,
  direcao text not null check (direcao in ('in', 'out')),
  texto text,
  criado_em timestamptz not null default now()
);
create index if not exists dono_msgs_criado on dono_msgs (criado_em desc);

create table if not exists dono_acoes (
  id uuid primary key default gen_random_uuid(),
  acao text not null,              -- criar_oportunidade | registrar_pagamento | lancar_gasto | criar_tarefa | concluir_tarefa
  tabela text not null,            -- deals | tasks | fin_tx | contacts
  registro_id text not null,
  antes jsonb,                     -- linha antes da ação (nulo = a ação criou a linha)
  depois jsonb,
  resumo text,                     -- o recibo que foi para o WhatsApp
  extra jsonb,                     -- contato criado junto, etc.
  desfeita_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists dono_acoes_criado on dono_acoes (criado_em desc);

alter table dono_msgs enable row level security;
alter table dono_acoes enable row level security;
drop policy if exists dono on dono_msgs;
drop policy if exists dono on dono_acoes;
create policy dono on dono_msgs for all to authenticated using (true) with check (true);
create policy dono on dono_acoes for all to authenticated using (true) with check (true);
drop policy if exists so_dono on dono_msgs;
drop policy if exists so_dono on dono_acoes;
create policy so_dono on dono_msgs as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy so_dono on dono_acoes as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Resumo do dia no WhatsApp: 7h30 e 18h em Pipa (10h30 e 21h UTC)
select cron.unschedule('dono-resumo-manha') where exists (select 1 from cron.job where jobname = 'dono-resumo-manha');
select cron.unschedule('dono-resumo-noite') where exists (select 1 from cron.job where jobname = 'dono-resumo-noite');
select cron.schedule('dono-resumo-manha', '30 10 * * *', $$
  select net.http_post(
    url := 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1/wa-dono',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-hub-cron', (select value from app_secrets where key = 'cron_token')),
    body := '{"resumo":"manha"}'::jsonb,
    timeout_milliseconds := 30000)
$$);
select cron.schedule('dono-resumo-noite', '0 21 * * *', $$
  select net.http_post(
    url := 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1/wa-dono',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-hub-cron', (select value from app_secrets where key = 'cron_token')),
    body := '{"resumo":"noite"}'::jsonb,
    timeout_milliseconds := 30000)
$$);
