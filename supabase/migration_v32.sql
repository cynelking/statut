-- Publish campaign budget and spend changes for live client updates.

do $$
declare
  v_publishes_all_tables boolean;
begin
  select puballtables into v_publishes_all_tables
  from pg_publication
  where pubname = 'supabase_realtime';

  if v_publishes_all_tables is null then
    raise exception 'La publication supabase_realtime est introuvable';
  end if;

  if not v_publishes_all_tables and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'campaigns'
  ) then
    execute 'alter publication supabase_realtime add table public.campaigns';
  end if;
end
$$;
