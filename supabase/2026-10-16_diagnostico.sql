-- Diagnóstico do Hub (rodada 2). SÓ LEITURA: nenhuma linha é alterada.
-- Rode: supabase db query --linked --project-ref ovcetvmvbeskgonjruvq -f 2026-10-16_diagnostico.sql
-- e cole o resultado na conversa.

-- 1) Tamanho das tabelas que o Hub carrega inteiras. Acima de 1000, o carregamento atual perde linhas sem avisar.
select 'contacts' tabela, count(*) linhas from contacts union all
select 'deals', count(*) from deals union all
select 'tasks', count(*) from tasks union all
select 'bookings', count(*) from bookings union all
select 'events', count(*) from events union all
select 'habit_logs', count(*) from habit_logs union all
select 'crypto_snap', count(*) from crypto_snap union all
select 'crypto_tx', count(*) from crypto_tx union all
select 'quotes', count(*) from quotes union all
select 'wa_messages', count(*) from wa_messages
order by 2 desc;

-- 2) Segurança: tabelas sem RLS e tabelas sem a política so_dono (o script de 14/10 precisa ser rodado de novo depois de criar tabelas)
select c.relname as tabela, c.relrowsecurity as rls_ligado,
  exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.policyname = 'so_dono') as tem_so_dono
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 3, 1;

-- 3) Oportunidades abertas SEM próxima ação (não aparecem no Escapando nem no Hoje)
select id, titulo, negocio, etapa, valor, updated_at::date
from deals
where etapa in ('lead', 'orcamento', 'negociacao', 'fechado', 'realizado')
  and (proxima_acao is null or trim(proxima_acao) = '' or data_proxima_acao is null);

-- 4) Reservas sobrepostas na mesma casa (risco de reserva dupla; o Hub não alerta)
select a.property_id as casa, a.origem as origem_a, a.hospede as hospede_a, a.checkin as in_a, a.checkout as out_a,
       b.origem as origem_b, b.hospede as hospede_b, b.checkin as in_b, b.checkout as out_b
from bookings a join bookings b
  on a.property_id = b.property_id and a.id < b.id
 and a.status in ('confirmada', 'bloqueio') and b.status in ('confirmada', 'bloqueio')
 and not (a.status = 'bloqueio' and b.status = 'bloqueio')
 and a.checkin < b.checkout and b.checkin < a.checkout
where a.checkout >= current_date;

-- 5) Reservas futuras canceladas (se aparecerem muitas da mesma casa juntas, foi o leitor do Airbnb recebendo um calendário vazio)
select property_id as casa, origem, count(*) as canceladas, min(checkin) as primeira, max(checkin) as ultima
from bookings where status = 'cancelada' and checkout >= current_date
group by 1, 2;

-- 6) Contatos duplicados: mesmo telefone (últimos 10 dígitos) ou mesmo nome
select 'telefone' as por, right(regexp_replace(telefone, '\D', '', 'g'), 10) as chave, count(*) as qtd, string_agg(nome, ' | ') as nomes
from contacts where coalesce(telefone, '') <> ''
group by 2 having count(*) > 1
union all
select 'nome', lower(trim(nome)), count(*), string_agg(coalesce(telefone, '(sem tel.)'), ' | ')
from contacts group by 2 having count(*) > 1;

-- 7) Aluguel fechado no Pipeline sem reserva correspondente (a casa pode estar livre no Airbnb)
select d.titulo, d.etapa, d.data_evento, d.local
from deals d
where d.negocio = 'aluguel' and d.etapa in ('fechado', 'realizado', 'pago') and d.data_evento >= current_date
  and not exists (select 1 from bookings b where b.status = 'confirmada' and b.checkin = d.data_evento);

-- 8) Leads do WhatsApp parados há mais de 14 dias (candidatos a "perdido: parou de responder")
select d.titulo, d.etapa, d.proxima_acao, d.data_proxima_acao, w.ultima_entrada::date
from deals d join wa_contacts w on w.deal_id = d.id
where d.etapa in ('lead', 'orcamento') and w.ultima_entrada < now() - interval '14 days';

-- 9) Eventos duplicados na agenda (mesmo título e mesmo início)
select titulo, inicio, count(*) from events group by 1, 2 having count(*) > 1;

-- 10) Tarefas abertas sem área e sem prazo (não aparecem na Caixa de entrada do Hoje)
select titulo, created_at::date from tasks where not coalesce(feito, false) and area is null and prazo is null;
