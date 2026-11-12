-- Leitura dos calendários (função ical-sync) a cada 15 min em vez de 1 h: as reservas do Airbnb/Decolar que
-- chegam pela Stays aparecem no Hub mais rápido, e a conferência Hub × Stays (reserva direta que não chegou,
-- bloqueio preso) avisa ~40 min depois do problema. Mesmo comando do job antigo, só muda o horário.
select cron.unschedule('hub-ical-sync') where exists (select 1 from cron.job where jobname = 'hub-ical-sync');
select cron.schedule('hub-ical-sync', '5,20,35,50 * * * *', $$
  select net.http_post(url := 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1/ical-sync',
    headers := jsonb_build_object('Content-Type','application/json','x-hub-cron',(select value from public.app_secrets where key='cron_token')),
    body := '{}'::jsonb);
$$);
