-- Restore campaign creation RPC compatibility for deployments that still send p_boost
-- and deployments that use p_boost_hours.
-- Apply after migration_v22.sql.

drop function if exists public.create_campaign(text, text, text, text, int, text, boolean, boolean, date, date);
drop function if exists public.create_campaign(text, text, text, text, int, text, int, boolean, date, date);

create or replace function public.campaign_boost_fee(p_boost_hours integer)
returns integer
language sql
immutable
parallel safe
as $$
  select case p_boost_hours
    when 24 then 500
    when 48 then 1000
    when 168 then 3500
    else 0
  end
$$;

revoke all on function public.campaign_boost_fee(integer) from public, anon, authenticated;

create or replace function public.create_campaign(
  p_title text,
  p_type text,
  p_content text,
  p_media_url text,
  p_budget int,
  p_country text,
  p_boost_hours int,
  p_use_credit boolean,
  p_starts date,
  p_ends date
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  total int;
  cr int := 0;
  cred int;
  wallet_balance int := 0;
  cash_used int := 0;
  cid bigint;
  st text := 'pending';
  is_admin_campaign boolean := public.is_admin();
  media text := nullif(trim(p_media_url), '');
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_budget < 1000 then raise exception 'Budget minimum 1 000 F'; end if;
  if p_boost_hours is null or p_boost_hours not in (0, 24, 48, 168) then
    raise exception 'Durée du boost invalide';
  end if;
  if length(trim(coalesce(p_title, ''))) = 0 then raise exception 'Titre requis'; end if;
  if p_type not in ('img', 'vid', 'txt') then raise exception 'Format invalide'; end if;
  if p_type in ('img', 'vid') and media is null then raise exception 'Ajoutez un visuel'; end if;
  if p_type = 'txt' and media is not null then raise exception 'Un visuel ne peut pas être associé à une annonce texte'; end if;
  if media is not null and (
    length(media) > 2048
    or lower(left(media, 8)) <> 'https://'
  ) then raise exception 'Lien multimédia invalide'; end if;
  if p_ends is not null and p_ends < current_date then raise exception 'La date de fin est passée'; end if;
  if p_starts is not null and p_ends is not null and p_ends < p_starts then
    raise exception 'La date de fin doit être après la date de début';
  end if;

  total := case when is_admin_campaign then 0
    else p_budget + 500 + public.campaign_boost_fee(p_boost_hours) end;
  perform 1 from public.profiles where id = auth.uid() for update;

  if not is_admin_campaign then
    select coalesce(credit, 0) into cred from public.profiles where id = auth.uid();
    if p_use_credit then cr := least(cred, total); end if;
    if cr > 0 then
      update public.profiles set credit = credit - cr where id = auth.uid();
    end if;

    if total > cr then
      select balance into wallet_balance
      from public.wallet_accounts
      where user_id = auth.uid()
      for update;
      wallet_balance := coalesce(wallet_balance, 0);
      if wallet_balance >= total - cr then
        cash_used := total - cr;
        update public.wallet_accounts
        set balance = balance - cash_used, updated_at = now()
        where user_id = auth.uid();
      end if;
    end if;
    if cr + cash_used >= total then st := 'active'; end if;
  else
    st := 'active';
  end if;

  insert into public.campaigns(
    owner, title, type, content, media_url, budget, country, boost_hours,
    credit_used, wallet_used, status, payment_provider, payment_status,
    boost_until, starts_at, ends_at, admin_created
  )
  values (
    auth.uid(),
    left(trim(p_title), 80),
    p_type,
    left(coalesce(p_content, ''), 500),
    media,
    p_budget,
    nullif(p_country, ''),
    p_boost_hours,
    cr,
    cash_used,
    st,
    case when cash_used > 0 then 'wallet' end,
    case when cash_used > 0 then 'paid' end,
    case when st = 'active' and p_boost_hours > 0
      then now() + make_interval(hours => p_boost_hours) end,
    case when p_starts is not null then p_starts::timestamp at time zone 'UTC' end,
    case when p_ends is not null then (p_ends + 1)::timestamp at time zone 'UTC' end,
    is_admin_campaign
  )
  returning id into cid;

  if cash_used > 0 then
    insert into public.wallet_ledger(user_id, amount, kind, campaign_id, event_key)
    values (auth.uid(), -cash_used, 'campaign_spend', cid, 'campaign-spend:' || cid::text);
  end if;
  return cid;
end
$$;

revoke all on function public.create_campaign(text, text, text, text, int, text, int, boolean, date, date)
  from public, anon;
grant execute on function public.create_campaign(text, text, text, text, int, text, int, boolean, date, date)
  to authenticated;

create or replace function public.create_campaign(
  p_title text,
  p_type text,
  p_content text,
  p_media_url text,
  p_budget int,
  p_country text,
  p_boost boolean,
  p_use_credit boolean,
  p_starts date,
  p_ends date
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.create_campaign(
    p_title,
    p_type,
    p_content,
    p_media_url,
    p_budget,
    p_country,
    case when coalesce(p_boost, false) then 48 else 0 end,
    p_use_credit,
    p_starts,
    p_ends
  );
end
$$;

revoke all on function public.create_campaign(text, text, text, text, int, text, boolean, boolean, date, date)
  from public, anon;
grant execute on function public.create_campaign(text, text, text, text, int, text, boolean, boolean, date, date)
  to authenticated;

notify pgrst, 'reload schema';
