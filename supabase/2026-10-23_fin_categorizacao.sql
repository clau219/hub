-- Categorização automática dos lançamentos (Edge Functions fin-classificar e fin-sync; _shared/fin-classificar.ts).
-- origem_cat: de onde veio a categoria (manual | whatsapp | pluggy | regra | memoria | reserva | gig | airbnb | ia | pluggy_sem_ia);
--             nulo = pendente (ainda não passou pela categorização).
-- revisar:    a IA não teve certeza; aparece na fila "Para revisar" com as sugestões (até 2 opções).
-- ia_motivo:  por que a categoria foi escolhida (aparece ao passar o mouse).
alter table fin_tx add column if not exists origem_cat text;
alter table fin_tx add column if not exists revisar boolean not null default false;
alter table fin_tx add column if not exists sugestoes jsonb;
alter table fin_tx add column if not exists ia_motivo text;
create index if not exists fin_tx_pendente on fin_tx (data desc) where origem_cat is null and not manual;
create index if not exists fin_tx_revisar on fin_tx (data desc) where revisar;

-- O que já foi classificado à mão (ou veio do WhatsApp) não volta para a fila
update fin_tx set origem_cat = case when id like 'wa-%' then 'whatsapp' else 'manual' end where manual and origem_cat is null;
