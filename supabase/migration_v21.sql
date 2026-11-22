-- Add configurable campaign boosts: 24 h, 48 h, or 7 days.
-- Apply after migration_v20.sql.

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

drop function if exists public.create_campaign(text, text, text, text, int, text, boolean, boolean, date, date);

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
  if p_starts is not null and p_ends is not null and p_ends < p_starts then raise exception 'La date de fin doit être après la date de début'; end if;

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

create or replace function public.start_saspay_campaign_payment(p_campaign_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns%rowtype;
  payment public.saspay_campaign_payments%rowtype;
  v_country text;
  v_iso text;
  v_currency text;
  v_amount integer;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;

  select * into c
  from public.campaigns
  where id = p_campaign_id and owner = auth.uid()
  for update;
  if not found then raise exception 'Campagne introuvable'; end if;
  if c.admin_created then raise exception 'Cette campagne administrateur est gratuite'; end if;
  if c.status <> 'pending' then raise exception 'Cette campagne ne peut plus être payée'; end if;

  select country into v_country from public.profiles where id = auth.uid();
  v_iso := case v_country
    when 'Togo' then 'TG'
    when 'Bénin' then 'BJ'
    when 'Côte d’Ivoire' then 'CI'
    when 'Sénégal' then 'SN'
    when 'Burkina Faso' then 'BF'
    when 'Mali' then 'ML'
    when 'Niger' then 'NE'
    when 'Cameroun' then 'CM'
    when 'Gabon' then 'GA'
    when 'Tchad' then 'TD'
    when 'Congo' then 'CG'
    when 'Guinée-Bissau' then 'GW'
    when 'République centrafricaine' then 'CF'
    when 'Guinée équatoriale' then 'GQ'
    else null
  end;
  if v_iso is null then raise exception 'Pays du profil non pris en charge par AlphaPay'; end if;
  v_currency := case when v_iso in ('CM', 'GA', 'TD', 'CG', 'CF', 'GQ') then 'XAF' else 'XOF' end;
  v_amount := c.budget + 500
    + public.campaign_boost_fee(c.boost_hours)
    - c.credit_used - c.wallet_used;
  if v_amount <= 0 then raise exception 'Aucun paiement AlphaPay n’est nécessaire'; end if;

  select * into payment
  from public.saspay_campaign_payments
  where campaign_id = c.id and status in ('pending', 'succeeded', 'review')
  limit 1
  for update;

  if not found then
    insert into public.saspay_campaign_payments(
      campaign_id, user_id, amount, currency, country
    ) values (
      c.id, auth.uid(), v_amount, v_currency, v_iso
    ) returning * into payment;
  elsif payment.amount <> v_amount or payment.currency <> v_currency then
    raise exception 'Le montant de la campagne a changé; contactez le support';
  end if;

  update public.campaigns
  set payment_provider = 'alphapay',
      payment_status = payment.status
  where id = c.id;

  return jsonb_build_object(
    'payment_id', payment.id,
    'amount', payment.amount,
    'currency', payment.currency,
    'country', payment.country,
    'status', payment.status,
    'checkout_session_id', payment.checkout_session_id,
    'checkout_url', payment.checkout_url
  );
end
$$;

revoke all on function public.start_saspay_campaign_payment(bigint) from public, anon;
grant execute on function public.start_saspay_campaign_payment(bigint) to authenticated;

create or replace function public.expire_campaigns()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns%rowtype;
  v_saspay integer;
  v_fees integer;
  v_promo_budget integer;
  v_wallet_budget integer;
  v_saspay_budget integer;
  v_remaining integer;
  v_promo_refund integer;
  v_wallet_refund integer;
  v_saspay_refund integer;
  v_cash_refund integer;
  n integer := 0;
begin
  for c in
    select *
    from public.campaigns campaign
    where campaign.status = 'active' and campaign.ends_at is not null and campaign.ends_at < now()
      and not exists (
        select 1 from public.proofs
        where proofs.campaign_id = campaign.id and proofs.status = 'pending'
      )
    for update of campaign skip locked
  loop
    select coalesce(sum(amount), 0)::integer into v_saspay
    from public.saspay_campaign_payments
    where campaign_id = c.id and status = 'succeeded';

    if c.admin_created then
      v_promo_refund := 0;
      v_cash_refund := 0;
    elsif c.payment_provider is null and c.wallet_used = 0 and v_saspay = 0 then
      v_promo_refund := greatest(c.budget - c.spent, 0);
      v_cash_refund := 0;
    else
      v_fees := 500 + public.campaign_boost_fee(c.boost_hours);
      v_promo_budget := greatest(c.credit_used - v_fees, 0);
      v_fees := greatest(v_fees - c.credit_used, 0);
      v_wallet_budget := greatest(c.wallet_used - v_fees, 0);
      v_fees := greatest(v_fees - c.wallet_used, 0);
      v_saspay_budget := greatest(v_saspay - v_fees, 0);
      v_remaining := greatest(c.budget - c.spent, 0);

      v_promo_refund := least(v_remaining, v_promo_budget);
      v_remaining := v_remaining - v_promo_refund;
      v_wallet_refund := least(v_remaining, v_wallet_budget);
      v_remaining := v_remaining - v_wallet_refund;
      v_saspay_refund := least(v_remaining, v_saspay_budget);
      v_cash_refund := v_wallet_refund + v_saspay_refund;
    end if;

    update public.campaigns set status = 'done' where id = c.id;
    if v_promo_refund > 0 then
      update public.profiles set credit = credit + v_promo_refund where id = c.owner;
    end if;
    if v_cash_refund > 0 then
      insert into public.wallet_accounts(user_id, balance)
      values (c.owner, v_cash_refund)
      on conflict (user_id) do update
      set balance = public.wallet_accounts.balance + excluded.balance,
          updated_at = now();
      insert into public.wallet_ledger(user_id, amount, kind, campaign_id, event_key)
      values (c.owner, v_cash_refund, 'campaign_refund', c.id, 'campaign-refund:' || c.id::text)
      on conflict (event_key) do nothing;
    end if;
    n := n + 1;
  end loop;
  return n;
end
$$;

revoke all on function public.expire_campaigns() from public, anon;
grant execute on function public.expire_campaigns() to authenticated, service_role;

create or replace function public.admin_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r jsonb;
  v_bonus_total numeric := 0;
  v_daily_bonus numeric := 0;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;

  if to_regclass('public.bonuses') is not null then
    execute 'select coalesce(sum(amount), 0) from public.bonuses' into v_bonus_total;
  end if;
  if to_regclass('public.daily_claims') is not null then
    execute 'select coalesce(sum(bonus), 0) from public.daily_claims' into v_daily_bonus;
  end if;

  select jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'users7', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'ca', (select count(*) from public.campaigns where status = 'active'),
    'cp', (select count(*) from public.campaigns where status = 'pending'),
    'cd', (select count(*) from public.campaigns where status = 'done'),
    'fees', (select count(*) * 500 from public.campaigns where status <> 'pending' and not admin_created)
      + (select coalesce(sum(public.campaign_boost_fee(boost_hours)), 0)
         from public.campaigns where status <> 'pending' and not admin_created),
    'views', (select coalesce(sum(views), 0) from public.proofs where status = 'approved'),
    'paid_out', (select coalesce(sum(amount), 0) from public.withdrawals where status = 'paid'),
    'pending_wd', (select coalesce(sum(amount), 0) from public.withdrawals where status in ('pending', 'processing')),
    'bonus_total', v_bonus_total,
    'promo_cost', (select coalesce(sum(credit_used), 0) from public.campaigns),
    'perks', (select coalesce(sum(bonus), 0) from public.proofs where status = 'approved') + v_daily_bonus,
    'boosted', (select count(*) from public.campaigns where boost_hours > 0 and status <> 'pending'),
    'balances', (select coalesce(sum(views + bonus), 0) from public.proofs where status = 'approved')
      - (select coalesce(sum(amount), 0) from public.withdrawals where status <> 'failed'),
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'd', to_char(d::date, 'DD/MM'),
        'users', (select count(*) from public.profiles where created_at::date = d::date),
        'views', (select coalesce(sum(views), 0) from public.proofs
          where status = 'approved' and created_at::date = d::date)
      ) order by d), '[]'::jsonb)
      from generate_series((current_date - 13)::timestamp, current_date::timestamp, interval '1 day') as d
    )
  ) into r;
  return r;
end
$$;

notify pgrst, 'reload schema';
