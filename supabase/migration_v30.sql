-- Pause campaigns without consuming their remaining schedule or boost time.

alter table public.campaigns
  add column if not exists paused_at timestamptz;

alter table public.campaigns
  drop constraint if exists campaigns_status_check;

alter table public.campaigns
  add constraint campaigns_status_check
  check (status in ('pending', 'active', 'paused', 'done'));

create or replace function public.set_campaign_paused(p_campaign_id bigint, p_paused boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns%rowtype;
  v_now timestamptz;
  v_pause_duration interval;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_paused is null then raise exception 'Action de pause invalide'; end if;

  select * into c
  from public.campaigns
  where id = p_campaign_id
  for update;
  if not found then raise exception 'Campagne introuvable'; end if;

  if c.owner <> auth.uid()
      and not public.is_admin()
      and not (
        c.agency_advertiser_id is not null
        and public.has_agency_team_manager_advertiser_access(c.owner, c.agency_advertiser_id)
      ) then
    raise exception 'Vous n’avez pas le droit de gérer cette campagne';
  end if;

  v_now := clock_timestamp();
  if p_paused then
    if c.status <> 'active' then raise exception 'Seule une campagne active peut être mise en pause'; end if;
    update public.campaigns
    set status = 'paused', paused_at = v_now
    where id = c.id;
  else
    if c.status <> 'paused' or c.paused_at is null then
      raise exception 'Cette campagne n’est pas en pause';
    end if;
    v_pause_duration := greatest(v_now - c.paused_at, interval '0 seconds');
    update public.campaigns
    set status = 'active',
        ends_at = case when ends_at is null then null else ends_at + v_pause_duration end,
        boost_until = case when boost_until is null then null else boost_until + v_pause_duration end,
        paused_at = null
    where id = c.id;
  end if;
end
$$;

revoke all on function public.set_campaign_paused(bigint, boolean) from public, anon;
grant execute on function public.set_campaign_paused(bigint, boolean) to authenticated;

notify pgrst, 'reload schema';
