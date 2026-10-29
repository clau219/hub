-- Compras programadas de cripto (ex.: Nubank, toda semana) → carteira cripto do Hub.
-- O extrato do banco só traz "Compra de criptomoedas" e o valor em reais. O plano diz qual moeda corresponde a cada
-- valor; a fin-sync (e a fin-classificar) transformam cada débito em uma compra na carteira, com a quantidade
-- estimada pela cotação do dia (_shared/cripto-recorrente.ts).
-- crypto_plano:       um item por moeda/valor da compra programada; vale a partir de `inicio` (débitos antes disso já
--                     estão no saldo lançado à mão, então não entram)
-- crypto_tx.fin_tx_id: o débito do banco que gerou a compra (nunca lança o mesmo débito duas vezes)
create table if not exists crypto_plano (
  id uuid primary key default gen_random_uuid(),
  coin_id text not null,
  simbolo text not null,
  nome text,
  valor numeric not null check (valor > 0),
  corretora text not null default 'Nubank',
  inicio date not null,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);
alter table crypto_tx add column if not exists fin_tx_id text unique;

alter table crypto_plano enable row level security;
drop policy if exists "dono" on crypto_plano;
create policy "dono" on crypto_plano for all to authenticated using (true) with check (true);
drop policy if exists so_dono on crypto_plano;
create policy so_dono on crypto_plano as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Plano informado em 28/10/2026: R$ 700 por semana no Nubank. O saldo do print é de 18/10, então vale a partir de 19/10.
insert into crypto_plano (coin_id, simbolo, nome, valor, inicio)
select * from (values ('bitcoin', 'BTC', 'Bitcoin', 250, date '2026-10-19'), ('aave', 'AAVE', 'Aave', 250, date '2026-10-19'),
                      ('ethereum', 'ETH', 'Ethereum', 100, date '2026-10-19'), ('uniswap', 'UNI', 'Uniswap', 100, date '2026-10-19')) v
where not exists (select 1 from crypto_plano);
