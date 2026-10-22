-- Pagamentos das oportunidades (sinal, parcelas, saldo): [{data, valor, forma}]
alter table deals add column if not exists pagamentos jsonb not null default '[]'::jsonb;
