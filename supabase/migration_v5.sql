-- Désactive l'ancienne condition SMS pour les preuves et les retraits.
-- À exécuter après migration_v4.sql.
create or replace function public.needs_sms()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select false
$$;
