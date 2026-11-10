-- WhatsApp PESSOAL do Claudio (só leitura): o leitor (programa à parte, A:\Usuário\HUB\wa-leitor, conectado como
-- "aparelho conectado") manda as mensagens para a função wp-ingest; a função wp-resumo lê o dia, resume por
-- categoria e aponta o que está ficando para trás (wp_alertas). Aba "WhatsApp pessoal" (v-pessoal.js).
-- Nada daqui envia mensagem a ninguém.
--
-- wp_chats:     uma linha por conversa (individual ou grupo). Grupos só têm mensagens guardadas quando
--               acompanhar = true (escolhido na aba) ou quando alguém te marca / responde a você.
--               ignorar = true tira a conversa do resumo (ex.: o número das casas, onde você manda comandos ao robô).
-- wp_mensagens: texto das mensagens (mídia só como tipo + legenda; áudio transcrito). Apagadas após 60 dias.
-- wp_resumos:   cada varredura (7h e 21h): manchete + categorias, guardado em jsonb.
-- wp_alertas:   "não deixe passar": aberto → feito / ignorado (na aba ou pela própria IA quando vê que foi resolvido).
-- Estado do leitor (conectado, QR code para ler, último sinal) em app_config 'wp_status'.

create table if not exists wp_chats (
  id text primary key,                 -- jid: 5584...@s.whatsapp.net, ...@g.us ou ...@lid
  nome text,
  grupo boolean not null default false,
  acompanhar boolean not null default false,
  ignorar boolean not null default false,
  ultima_msg_em timestamptz,
  atualizado_em timestamptz not null default now()
);

create table if not exists wp_mensagens (
  chat_id text not null,
  id text not null,                    -- id da mensagem no WhatsApp (único dentro da conversa)
  de_mim boolean not null default false,
  autor text,                          -- nome de quem escreveu (grupos) ou o nome do perfil
  tipo text not null default 'texto',  -- texto, audio, imagem, video, documento, figurinha, localizacao, contato, enquete…
  texto text,
  segundos int,                        -- duração do áudio
  menciona_me boolean not null default false,
  responde_a_mim boolean not null default false,
  cita text,                           -- trecho da mensagem respondida
  enviado_em timestamptz not null,
  criado_em timestamptz not null default now(),
  primary key (chat_id, id)
);
create index if not exists wp_mensagens_enviado on wp_mensagens (enviado_em desc);

create table if not exists wp_resumos (
  id uuid primary key default gen_random_uuid(),
  periodo text not null,               -- manha | noite | agora
  de timestamptz not null,
  ate timestamptz not null,
  conteudo jsonb not null,             -- {manchete, categorias:[{categoria,resumo,conversas:[{chat_id,nome,resumo}]}], avisos:[]}
  mensagens int not null default 0,
  modelo text,
  uso jsonb,
  criado_em timestamptz not null default now()
);
create index if not exists wp_resumos_criado on wp_resumos (criado_em desc);

create table if not exists wp_alertas (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  nome text,
  tipo text not null,                  -- sem_resposta, promessa_sua, pedido_para_voce, prazo, dinheiro, compromisso, outro
  urgencia text not null default 'media',
  titulo text not null,
  detalhe text,
  prazo date,
  status text not null default 'aberto', -- aberto | feito | ignorado
  resumo_id uuid references wp_resumos(id) on delete set null,
  visto_em timestamptz not null default now(), -- última varredura que ainda via o assunto pendente
  criado_em timestamptz not null default now(),
  resolvido_em timestamptz,
  resolvido_por text                   -- voce | ia | automatico
);
create index if not exists wp_alertas_abertos on wp_alertas (status, criado_em desc);

do $$
declare t text;
begin
  foreach t in array array['wp_chats', 'wp_mensagens', 'wp_resumos', 'wp_alertas'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "dono" on public.%I', t);
    execute format('create policy "dono" on public.%I for all to authenticated using (true) with check (true)', t);
    execute format('drop policy if exists so_dono on public.%I', t);
    execute format('create policy so_dono on public.%I as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- Varredura às 7h e às 21h de Pipa (UTC−3)
select cron.unschedule('wp-resumo-manha') where exists (select 1 from cron.job where jobname = 'wp-resumo-manha');
select cron.schedule('wp-resumo-manha', '0 10 * * *', $$
  select net.http_post(
    url := 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1/wp-resumo',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-hub-cron', (select value from app_secrets where key = 'cron_token')),
    body := '{"periodo":"manha"}'::jsonb,
    timeout_milliseconds := 150000)
$$);
select cron.unschedule('wp-resumo-noite') where exists (select 1 from cron.job where jobname = 'wp-resumo-noite');
select cron.schedule('wp-resumo-noite', '0 0 * * *', $$
  select net.http_post(
    url := 'https://ovcetvmvbeskgonjruvq.supabase.co/functions/v1/wp-resumo',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-hub-cron', (select value from app_secrets where key = 'cron_token')),
    body := '{"periodo":"noite"}'::jsonb,
    timeout_milliseconds := 150000)
$$);

-- O token do leitor (app_secrets 'wp_leitor_token') NÃO fica aqui (repositório público):
-- está em A:\Usuário\HUB\wa-leitor\token.sql, junto do .env do leitor.
