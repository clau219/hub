-- WhatsApp das casas → Hub (função wa-webhook).
-- wa_contacts: uma linha por número que conversou com o WhatsApp de atendimento.
-- wa_messages: todas as mensagens (recebidas, enviadas pelo robô e enviadas por você no app Business).
-- wa_settings: chave liga/desliga do robô (tela Ajustes).

create table if not exists wa_contacts (
  wa_id text primary key,                         -- número no formato do WhatsApp: 5584999990000
  nome text,                                      -- nome do perfil no WhatsApp
  contato_id uuid references contacts(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,   -- oportunidade aberta desta conversa
  bot_pausado boolean not null default false,     -- robô quieto só com esta pessoa
  ultima_entrada timestamptz,
  ultima_manual timestamptz,                      -- última mensagem que você mandou à mão
  created_at timestamptz not null default now()
);

create table if not exists wa_messages (
  id uuid primary key default gen_random_uuid(),
  wamid text unique,                              -- id da mensagem no WhatsApp (evita duplicar reentregas)
  wa_id text not null references wa_contacts(wa_id) on delete cascade,
  deal_id uuid references deals(id) on delete set null,
  direcao text not null check (direcao in ('in', 'out')),
  autor text not null check (autor in ('cliente', 'robo', 'claudio')),
  tipo text not null default 'text',
  texto text,
  extracao jsonb,                                 -- o que a IA entendeu (casa, datas, hóspedes)
  cotacao jsonb,                                  -- resposta da airbnb-quote usada pelo robô
  enviado_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists wa_messages_wa_id_idx on wa_messages (wa_id, enviado_em desc);
create index if not exists wa_messages_deal_idx on wa_messages (deal_id, enviado_em);

create table if not exists wa_settings (
  id int primary key default 1 check (id = 1),
  bot_ativo boolean not null default true,
  horas_silencio int not null default 12,         -- depois de você responder à mão, o robô fica quieto por N horas
  max_respostas_dia int not null default 4,       -- limite de respostas automáticas por conversa por dia
  updated_at timestamptz not null default now()
);
insert into wa_settings (id) values (1) on conflict (id) do nothing;

alter table wa_contacts enable row level security;
alter table wa_messages enable row level security;
alter table wa_settings enable row level security;
drop policy if exists dono on wa_contacts;
drop policy if exists dono on wa_messages;
drop policy if exists dono on wa_settings;
create policy dono on wa_contacts for all to authenticated using (true) with check (true);
create policy dono on wa_messages for all to authenticated using (true) with check (true);
create policy dono on wa_settings for all to authenticated using (true) with check (true);
