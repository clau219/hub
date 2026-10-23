-- Robô do WhatsApp: o que o cliente já informou na conversa (casa, datas, hóspedes), para perguntar só o que falta
-- e juntar tudo quando ele responder. Ex.: {"casa":"QS40","checkin":"2026-11-17","checkout":null,"noites":null,
-- "hospedes":4,"datas_exatas":true,"em":"2026-10-23T12:00:00Z"}. Vale por 7 dias ("em").
alter table wa_contacts add column if not exists pedido jsonb;
