-- Tela Saúde (dados do Garmin). Rode uma vez.
-- health_daily:      um registro por dia (passos, sono, VFC, Body Battery, estresse…)
-- health_activities: atividades (corrida, caminhada, academia…), uma por atividade do Garmin
-- habits.auto:       regra para o hábito ser marcado sozinho pelo Garmin (ex.: "passos>=8000", "atividade>=30", "sono>=7")
-- app_config 'garmin_status': quando o script do PC sincronizou pela última vez

create table if not exists health_daily (
  dia date primary key,
  passos int,
  meta_passos int,
  distancia_m numeric,
  calorias int,
  calorias_ativas int,
  min_moderados int,
  min_intensos int,
  andares int,
  fc_repouso int,
  fc_max int,
  estresse_medio int,
  bb_max int,
  bb_min int,
  sono_seg int,
  sono_profundo_seg int,
  sono_leve_seg int,
  sono_rem_seg int,
  sono_acordado_seg int,
  sono_score int,
  sono_inicio timestamptz,
  sono_fim timestamptz,
  hrv_noite int,
  hrv_semana int,
  hrv_status text,
  prontidao int,
  vo2max numeric,
  peso_kg numeric,
  spo2_medio int,
  respiracao numeric,
  fonte text,
  atualizado_em timestamptz not null default now()
);

create table if not exists health_activities (
  id bigint primary key,            -- activityId do Garmin
  inicio timestamptz not null,
  dia date not null,                -- dia local do início
  tipo text,
  nome text,
  duracao_seg int,
  distancia_m numeric,
  calorias int,
  fc_media int,
  fc_max int,
  elevacao_m numeric,
  carga numeric,
  te_aerobico numeric,
  passos int,
  fonte text,
  atualizado_em timestamptz not null default now()
);
create index if not exists health_activities_dia on health_activities (dia);

alter table habits add column if not exists auto text;

alter table health_daily enable row level security;
alter table health_activities enable row level security;
drop policy if exists "dono" on health_daily;
drop policy if exists "dono" on health_activities;
create policy "dono" on health_daily for all to authenticated using (true) with check (true);
create policy "dono" on health_activities for all to authenticated using (true) with check (true);
