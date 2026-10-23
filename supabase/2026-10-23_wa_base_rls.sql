-- Informações das casas (aba WhatsApp > Informações das casas): o Hub grava app_config 'wa_base' com o login.
-- app_config é só leitura para o login (o resto é escrito pelas funções com service role); esta política libera
-- inserir/alterar apenas a chave 'wa_base'. A política restritiva so_dono (is_owner()) continua valendo.
drop policy if exists wa_base_gravar on app_config;
drop policy if exists wa_base_alterar on app_config;
create policy wa_base_gravar on app_config for insert to authenticated with check (key = 'wa_base');
create policy wa_base_alterar on app_config for update to authenticated using (key = 'wa_base') with check (key = 'wa_base');
