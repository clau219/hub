-- Sincronização do Garmin de hora em hora, das 7h às 23h (Brasília = UTC-3), pela função garmin-sync.
-- Substitui o GitHub Actions (clau219/hub-garmin), cujo agendamento atrasava ou pulava rodadas.
select cron.unschedule('garmin-sync') where exists (select 1 from cron.job where jobname = 'garmin-sync');
select cron.schedule('garmin-sync', '10 0-2,10-23 * * *', $$
  select net.http_post(
    url := 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1/garmin-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-hub-cron', (select value from app_secrets where key = 'cron_token')),
    body := '{"dias":2}'::jsonb,
    timeout_milliseconds := 120000)
$$);
