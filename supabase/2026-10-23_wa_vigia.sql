-- Vigia do WhatsApp das casas a cada 5 min (função wa-vigia): avisa por push quando a Z-API desconecta
-- e quando alguém está há 20+ min esperando resposta. Estado em app_config ('zapi_status', 'wa_avisados').
select cron.unschedule('wa-vigia') where exists (select 1 from cron.job where jobname = 'wa-vigia');
select cron.schedule('wa-vigia', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1/wa-vigia',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-hub-cron', (select value from app_secrets where key = 'cron_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
$$);
