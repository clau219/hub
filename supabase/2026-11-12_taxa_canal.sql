-- Taxa do canal de cada reserva (comissão do Airbnb, Booking, Decolar...). bookings.valor passa a ser o valor TOTAL
-- da reserva (o que o hóspede pagou, como vem no e-mail da Stays); valor − taxa_canal = o que fica para a casa.
-- Vazio = não informado (ex.: valor lançado pelo repasse do banco, que já é líquido). Usado no relatório dos donos.
alter table bookings add column if not exists taxa_canal numeric(12,2);
