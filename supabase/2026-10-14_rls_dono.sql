-- Fase 0: amarra todas as tabelas ao login do Claudio.
-- As políticas atuais ("authenticated, using true") liberam tudo para QUALQUER conta logada;
-- hoje é seguro só porque o cadastro está desligado. Esta política RESTRITIVA soma uma
-- condição extra (AND) às existentes: não apaga nada e é desfeita com o bloco do fim.
-- As Edge Functions usam a service role e não são afetadas.

create or replace function public.is_owner() returns boolean
language sql stable as
$$ select coalesce(auth.jwt() ->> 'email', '') = 'claudiobrg@me.com' $$;

do $$
declare t text;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  loop
    execute format('drop policy if exists so_dono on public.%I', t);
    execute format('create policy so_dono on public.%I as restrictive for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- Conferência: deve listar uma linha "so_dono" por tabela
select tablename, policyname, permissive from pg_policies where schemaname = 'public' and policyname = 'so_dono' order by 1;

-- Para desfazer:
-- do $$ declare t text; begin for t in select tablename from pg_policies where schemaname='public' and policyname='so_dono' loop
--   execute format('drop policy so_dono on public.%I', t); end loop; end $$;
