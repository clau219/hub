-- Canal do dono, fase 2: lembrete com hora no WhatsApp e proposta lida de foto/PDF esperando o "sim".
-- tasks.lembrete_em: quando avisar no WhatsApp do dono; lembrete_enviado_em: já avisou (nulo = pendente).
-- wa_settings.dono_pendente: o que a IA leu de um comprovante/boleto e propôs registrar ({comando, resumo, em}).
alter table tasks add column if not exists lembrete_em timestamptz;
alter table tasks add column if not exists lembrete_enviado_em timestamptz;
create index if not exists tasks_lembrete on tasks (lembrete_em) where lembrete_enviado_em is null and feito = false;
alter table wa_settings add column if not exists dono_pendente jsonb;

-- Lembretes vencidos saem a cada minuto (função wa-dono)
select cron.unschedule('dono-lembretes') where exists (select 1 from cron.job where jobname = 'dono-lembretes');
select cron.schedule('dono-lembretes', '* * * * *', $$
  select net.http_post(
    url := 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1/wa-dono',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-hub-cron', (select value from app_secrets where key = 'cron_token')),
    body := '{"lembretes":true}'::jsonb,
    timeout_milliseconds := 30000)
$$);
