-- Wallet top-ups and automatic AlphaPay payouts.
-- Apply after migration_v13.sql.
-- Historical saspay_* table and RPC names are retained for database compatibility.
-- The saspay provider value remains allowed for existing campaign records only.

create table if not exists public.wallet_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_ledger (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null check (amount <> 0),
  kind text not null check (kind in ('topup', 'campaign_spend', 'campaign_refund')),
  topup_id uuid,
  campaign_id bigint references public.campaigns(id) on delete set null,
  event_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists wallet_ledger_user_created_idx
  on public.wallet_ledger(user_id, created_at desc);

create table if not exists public.saspay_wallet_topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null check (amount between 500 and 1000000),
  currency text not null check (currency in ('XOF', 'XAF')),
  country text not null,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'review')),
  checkout_session_id text unique,
  checkout_url text,
  checkout_claimed_at timestamptz,
  provider_transaction_id text unique,
  credited_amount integer not null default 0 check (credited_amount >= 0),
  verified_net_amount numeric(12, 2),
  verified_currency text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saspay_wallet_topups_pending_idx
  on public.saspay_wallet_topups(created_at)
  where status = 'pending';

create index if not exists saspay_wallet_topups_review_idx
  on public.saspay_wallet_topups(created_at)
  where status = 'review';

alter table public.wallet_accounts enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.saspay_wallet_topups enable row level security;
revoke all on public.wallet_accounts, public.wallet_ledger, public.saspay_wallet_topups
  from anon, authenticated;

alter table public.campaigns
  add column if not exists wallet_used integer not null default 0;
alter table public.campaigns
  drop constraint if exists campaigns_wallet_used_check,
  add constraint campaigns_wallet_used_check check (wallet_used >= 0);
alter table public.campaigns
  drop constraint if exists campaigns_payment_provider_check,
  add constraint campaigns_payment_provider_check
    check (payment_provider is null or payment_provider in ('alphapay', 'saspay', 'wallet'));

create or replace function public.activate_campaign(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if exists (
    select 1 from public.campaigns
    where id = p_id
      and payment_provider in ('alphapay', 'saspay')
      and payment_status is distinct from 'paid'
  ) then raise exception 'Le paiement doit être confirmé avant activation'; end if;

  update public.campaigns
  set status = 'active',
      boost_until = case when boost_hours > 0 then now() + make_interval(hours => boost_hours) end
  where id = p_id and status = 'pending';
  if not found then raise exception 'Campagne introuvable ou déjà traitée'; end if;
end
$$;

revoke all on function public.activate_campaign(bigint) from public;
grant execute on function public.activate_campaign(bigint) to authenticated;

create or replace function public.my_wallet_balance()
returns integer
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce((
    select balance from public.wallet_accounts where user_id = auth.uid()
  ), 0)
$$;

revoke all on function public.my_wallet_balance() from public, anon;
grant execute on function public.my_wallet_balance() to authenticated;

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
declare
  total int;
  cr int := 0;
  cred int;
  wallet_balance int := 0;
  cash_used int := 0;
  cid bigint;
  st text := 'pending';
  media text := nullif(trim(p_media_url), '');
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_budget < 1000 then raise exception 'Budget minimum 1 000 F'; end if;
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

  total := p_budget + 500 + case when p_boost then 1000 else 0 end;
  perform 1 from public.profiles where id = auth.uid() for update;
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

  insert into public.campaigns(
    owner, title, type, content, media_url, budget, country, boost_hours,
    credit_used, wallet_used, status, payment_provider, payment_status,
    boost_until, starts_at, ends_at
  )
  values (
    auth.uid(),
    left(trim(p_title), 80),
    p_type,
    left(coalesce(p_content, ''), 500),
    media,
    p_budget,
    nullif(p_country, ''),
    case when p_boost then 48 else 0 end,
    cr,
    cash_used,
    st,
    case when cash_used > 0 then 'wallet' end,
    case when cash_used > 0 then 'paid' end,
    case when st = 'active' and p_boost then now() + interval '48 hours' end,
    case when p_starts is not null then p_starts::timestamp at time zone 'UTC' end,
    case when p_ends is not null then (p_ends + 1)::timestamp at time zone 'UTC' end
  )
  returning id into cid;
  if cash_used > 0 then
    insert into public.wallet_ledger(user_id, amount, kind, campaign_id, event_key)
    values (auth.uid(), -cash_used, 'campaign_spend', cid, 'campaign-spend:' || cid::text);
  end if;
  return cid;
end
$$;

revoke all on function public.create_campaign(text, text, text, text, int, text, boolean, boolean, date, date)
  from public, anon;
grant execute on function public.create_campaign(text, text, text, text, int, text, boolean, boolean, date, date)
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
    + case when c.boost_hours > 0 then 1000 else 0 end
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

create or replace function public.start_saspay_wallet_topup(p_amount integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_country text;
  v_iso text;
  v_currency text;
  topup public.saspay_wallet_topups%rowtype;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_amount < 500 or p_amount > 1000000 then
    raise exception 'La recharge doit être comprise entre 500 et 1 000 000 F';
  end if;

  select country into v_country
  from public.profiles
  where id = auth.uid()
  for update;
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

  select * into topup
  from public.saspay_wallet_topups
  where user_id = auth.uid() and amount = p_amount and status = 'pending'
  order by created_at desc
  limit 1
  for update;
  if found then
    return jsonb_build_object(
      'topup_id', topup.id,
      'amount', topup.amount,
      'currency', topup.currency,
      'country', topup.country,
      'status', topup.status,
      'checkout_session_id', topup.checkout_session_id,
      'checkout_url', topup.checkout_url
    );
  end if;

  insert into public.saspay_wallet_topups(user_id, amount, currency, country)
  values (auth.uid(), p_amount, v_currency, v_iso)
  returning * into topup;

  return jsonb_build_object(
    'topup_id', topup.id,
    'amount', topup.amount,
    'currency', topup.currency,
    'country', topup.country,
    'status', topup.status
  );
end
$$;

revoke all on function public.start_saspay_wallet_topup(integer) from public, anon;
grant execute on function public.start_saspay_wallet_topup(integer) to authenticated;

create or replace function public.claim_saspay_wallet_checkout(p_topup_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  topup public.saspay_wallet_topups%rowtype;
begin
  select * into topup
  from public.saspay_wallet_topups
  where id = p_topup_id and user_id = auth.uid()
  for update;
  if not found or topup.status <> 'pending' then
    raise exception 'Recharge introuvable ou déjà traitée';
  end if;
  if topup.checkout_session_id is not null then return false; end if;
  if topup.checkout_claimed_at > now() - interval '2 minutes' then return false; end if;

  update public.saspay_wallet_topups
  set checkout_claimed_at = now(), updated_at = now()
  where id = topup.id;
  return true;
end
$$;

revoke all on function public.claim_saspay_wallet_checkout(uuid) from public, anon;
grant execute on function public.claim_saspay_wallet_checkout(uuid) to authenticated;

create or replace function public.release_saspay_wallet_checkout(p_topup_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.saspay_wallet_topups
  set checkout_claimed_at = null, updated_at = now()
  where id = p_topup_id and user_id = auth.uid()
    and checkout_session_id is null and status = 'pending'
$$;

revoke all on function public.release_saspay_wallet_checkout(uuid) from public, anon;
grant execute on function public.release_saspay_wallet_checkout(uuid) to authenticated;

create or replace function public.complete_saspay_wallet_topup(
  p_topup_id uuid,
  p_provider_transaction_id text,
  p_status text,
  p_net_amount numeric,
  p_currency text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  topup public.saspay_wallet_topups%rowtype;
  v_credit integer;
begin
  select * into topup
  from public.saspay_wallet_topups
  where id = p_topup_id
  for update;
  if not found then raise exception 'Recharge introuvable'; end if;

  if topup.status = 'succeeded' then return topup.status; end if;
  if topup.status = 'review' or (topup.status = 'failed' and p_status <> 'SUCCESS') then
    return topup.status;
  end if;

  if p_status = 'FAILED' then
    update public.saspay_wallet_topups
    set status = 'failed',
        provider_transaction_id = p_provider_transaction_id,
        verified_net_amount = p_net_amount,
        verified_currency = p_currency,
        updated_at = now()
    where id = topup.id;
    return 'failed';
  end if;
  if p_status is distinct from 'SUCCESS' then return topup.status; end if;

  if p_currency is distinct from topup.currency
     or coalesce(p_net_amount, 0) < topup.amount then
    update public.saspay_wallet_topups
    set status = 'review',
        provider_transaction_id = p_provider_transaction_id,
        verified_net_amount = p_net_amount,
        verified_currency = p_currency,
        updated_at = now()
    where id = topup.id;
    return 'review';
  end if;

  v_credit := topup.amount;
  insert into public.wallet_accounts(user_id, balance)
  values (topup.user_id, v_credit)
  on conflict (user_id) do update
  set balance = public.wallet_accounts.balance + excluded.balance,
      updated_at = now();
  insert into public.wallet_ledger(user_id, amount, kind, topup_id, event_key)
  values (topup.user_id, v_credit, 'topup', topup.id, 'topup:' || topup.id::text)
  on conflict (event_key) do nothing;
  update public.saspay_wallet_topups
  set status = 'succeeded',
      credited_amount = v_credit,
      provider_transaction_id = p_provider_transaction_id,
      verified_net_amount = p_net_amount,
      verified_currency = p_currency,
      updated_at = now()
  where id = topup.id;
  return 'succeeded';
end
$$;

revoke all on function public.complete_saspay_wallet_topup(uuid, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.complete_saspay_wallet_topup(uuid, text, text, numeric, text)
  to service_role;

create or replace function public.expire_saspay_wallet_topup(p_topup_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.saspay_wallet_topups
  set status = 'failed', updated_at = now()
  where id = p_topup_id and status = 'pending';
end
$$;

revoke all on function public.expire_saspay_wallet_topup(uuid) from public, anon, authenticated;
grant execute on function public.expire_saspay_wallet_topup(uuid) to service_role;

create or replace function public.admin_wallet_topups_for_review()
returns table (
  id uuid,
  user_id uuid,
  amount integer,
  currency text,
  country text,
  provider_transaction_id text,
  verified_net_amount numeric,
  verified_currency text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select t.id, t.user_id, t.amount, t.currency, t.country,
      t.provider_transaction_id, t.verified_net_amount, t.verified_currency, t.created_at
    from public.saspay_wallet_topups t
    where t.status = 'review'
    order by t.created_at;
end
$$;

revoke all on function public.admin_wallet_topups_for_review() from public, anon;
grant execute on function public.admin_wallet_topups_for_review() to authenticated;

create or replace function public.admin_resolve_saspay_wallet_topup(p_topup_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  topup public.saspay_wallet_topups%rowtype;
  v_credit integer;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select * into topup
  from public.saspay_wallet_topups
  where id = p_topup_id and status = 'review'
  for update;
  if not found or topup.provider_transaction_id is null then
    raise exception 'Aucune recharge AlphaPay à vérifier';
  end if;
  if topup.verified_currency is distinct from topup.currency or topup.verified_net_amount is null then
    raise exception 'La devise reçue ne correspond pas à la recharge';
  end if;

  v_credit := least(topup.amount, floor(topup.verified_net_amount)::integer);
  if v_credit <= 0 then raise exception 'Le montant vérifié ne permet aucun crédit'; end if;

  insert into public.wallet_accounts(user_id, balance)
  values (topup.user_id, v_credit)
  on conflict (user_id) do update
  set balance = public.wallet_accounts.balance + excluded.balance,
      updated_at = now();
  insert into public.wallet_ledger(user_id, amount, kind, topup_id, event_key)
  values (topup.user_id, v_credit, 'topup', topup.id, 'topup:' || topup.id::text)
  on conflict (event_key) do nothing;
  update public.saspay_wallet_topups
  set status = 'succeeded', credited_amount = v_credit, updated_at = now()
  where id = topup.id;
  return v_credit;
end
$$;

revoke all on function public.admin_resolve_saspay_wallet_topup(uuid) from public, anon;
grant execute on function public.admin_resolve_saspay_wallet_topup(uuid) to authenticated;

drop function if exists public.request_withdrawal(integer, text, text, text, text);
create or replace function public.request_withdrawal(
  p_amount integer,
  p_operator text,
  p_country text,
  p_network text,
  p_phone text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  withdrawal_id bigint;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  perform 1 from public.profiles where id = auth.uid() for update;
  if needs_sms() and not (select phone_verified from public.profiles where id = auth.uid()) then
    raise exception 'Vérifiez votre numéro par SMS avant de retirer';
  end if;
  if p_amount < 500 then raise exception 'Minimum 500 F'; end if;
  if p_amount > my_balance() then raise exception 'Solde insuffisant'; end if;
  if p_country is null or p_network is null or p_phone is null
     or p_country !~ '^[A-Z]{2}$' or p_network !~ '^[a-z0-9_]{2,40}$'
     or p_phone !~ '^[+0-9][0-9 +()-]{5,24}$' then
    raise exception 'Coordonnées Mobile Money invalides';
  end if;
  insert into public.withdrawals(
    user_id, amount, operator, recipient_country, recipient_network, recipient_phone
  ) values (
    auth.uid(), p_amount, left(p_operator, 80), p_country, p_network, p_phone
  ) returning id into withdrawal_id;
  return withdrawal_id;
end
$$;

revoke all on function public.request_withdrawal(integer, text, text, text, text) from public, anon;
grant execute on function public.request_withdrawal(integer, text, text, text, text) to authenticated;

create or replace function public.my_balance()
returns integer
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((
    select sum(p.views + p.bonus)
    from public.proofs p
    where p.user_id = auth.uid() and p.status = 'approved'
  ), 0)::integer
  - coalesce((
    select sum(w.amount)
    from public.withdrawals w
    where w.user_id = auth.uid() and w.status <> 'failed'
  ), 0)::integer
$$;

create or replace function public.claim_saspay_payout(p_withdrawal_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.withdrawals%rowtype;
begin
  select * into w from public.withdrawals where id = p_withdrawal_id for update;
  if not found then raise exception 'Retrait introuvable'; end if;
  if auth.uid() is null or (w.user_id <> auth.uid() and not public.is_admin()) then
    raise exception 'forbidden';
  end if;
  if w.status not in ('pending', 'processing') then raise exception 'Retrait déjà traité'; end if;
  if w.status = 'pending' then
    update public.withdrawals
    set status = 'processing', saspay_idempotency_key = coalesce(saspay_idempotency_key, gen_random_uuid())
    where id = w.id
    returning * into w;
  end if;
  return jsonb_build_object(
    'id', w.id,
    'user_id', w.user_id,
    'amount', w.amount,
    'status', w.status,
    'country', w.recipient_country,
    'network', w.recipient_network,
    'phone', w.recipient_phone,
    'operator', w.operator,
    'provider_payout_id', w.saspay_payout_id,
    'idempotency_key', w.saspay_idempotency_key
  );
end
$$;

revoke all on function public.claim_saspay_payout(bigint) from public, anon;
grant execute on function public.claim_saspay_payout(bigint) to authenticated;

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

    if c.payment_provider is null and c.wallet_used = 0 and v_saspay = 0 then
      v_promo_refund := greatest(c.budget - c.spent, 0);
      v_cash_refund := 0;
    else
      v_fees := 500 + case when c.boost_hours > 0 then 1000 else 0 end;
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
    'fees', (select count(*) * 500 from public.campaigns where status <> 'pending')
      + (select count(*) * 1000 from public.campaigns where status <> 'pending' and boost_hours > 0),
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

create or replace function public.my_transactions(p_offset integer default 0)
returns table (
  transaction_id text,
  kind text,
  title text,
  amount integer,
  status text,
  occurred_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  with events as (
    select
      'proof:' || p.id::text || ':earning' as transaction_id,
      'earning'::text as kind,
      coalesce(c.title, 'Campaign #' || p.campaign_id::text) as title,
      p.views as amount,
      'approved'::text as status,
      p.created_at as occurred_at
    from public.proofs p
    left join public.campaigns c on c.id = p.campaign_id
    where p.user_id = auth.uid() and p.status = 'approved' and p.views > 0

    union all

    select
      'proof:' || p.id::text || ':level-bonus',
      'level_bonus'::text,
      coalesce(c.title, 'Campaign #' || p.campaign_id::text),
      p.bonus,
      'approved'::text,
      p.created_at
    from public.proofs p
    left join public.campaigns c on c.id = p.campaign_id
    where p.user_id = auth.uid() and p.status = 'approved' and p.bonus > 0

    union all

    select
      'proof:' || p.id::text || ':status',
      'proof_status'::text,
      coalesce(c.title, 'Campaign #' || p.campaign_id::text),
      0,
      p.status,
      p.created_at
    from public.proofs p
    left join public.campaigns c on c.id = p.campaign_id
    where p.user_id = auth.uid() and p.status in ('pending', 'rejected')

    union all

    select
      'referral:' || b.id::text,
      'referral_bonus'::text,
      b.level::text,
      b.amount,
      'credited'::text,
      b.created_at
    from public.bonuses b
    where b.user_id = auth.uid()

    union all

    select
      'daily:' || d.user_id::text || ':' || d.day::text,
      'daily_bonus'::text,
      null::text,
      d.bonus,
      'credited'::text,
      d.day::timestamptz
    from public.daily_claims d
    where d.user_id = auth.uid()

    union all

    select
      'promo:' || r.user_id::text,
      'promo_credit'::text,
      r.code,
      pc.credit,
      'credited'::text,
      r.created_at
    from public.promo_redemptions r
    join public.promo_codes pc on pc.code = r.code
    where r.user_id = auth.uid()

    union all

    select
      'campaign:' || c.id::text || ':credit-used',
      'credit_used'::text,
      c.title,
      -c.credit_used,
      'used'::text,
      c.created_at
    from public.campaigns c
    where c.owner = auth.uid() and c.credit_used > 0

    union all

    select
      'campaign:' || c.id::text || ':credit-refund',
      'credit_refund'::text,
      c.title,
      case
        when c.payment_provider is null and c.wallet_used = 0 then greatest(c.budget - c.spent, 0)
        else least(greatest(c.budget - c.spent, 0), greatest(
          c.credit_used - 500 - case when c.boost_hours > 0 then 1000 else 0 end, 0
        ))
      end,
      'refunded'::text,
      c.ends_at
    from public.campaigns c
    where c.owner = auth.uid()
      and c.status = 'done'
      and c.ends_at is not null
      and c.ends_at < now()
      and c.budget > c.spent
      and c.credit_used > 500 + case when c.boost_hours > 0 then 1000 else 0 end

    union all

    select
      'wallet:' || l.id::text,
      case l.kind
        when 'topup' then 'wallet_topup'
        when 'campaign_spend' then 'wallet_used'
        else 'wallet_refund'
      end,
      case l.kind
        when 'topup' then 'AlphaPay'
        when 'campaign_spend' then coalesce(c.title, 'Campaign #' || l.campaign_id::text)
        else coalesce(c.title, 'Campaign #' || l.campaign_id::text)
      end,
      l.amount,
      case l.kind when 'campaign_spend' then 'used' else 'credited' end,
      l.created_at
    from public.wallet_ledger l
    left join public.campaigns c on c.id = l.campaign_id
    where l.user_id = auth.uid()

    union all

    select
      'withdrawal:' || w.id::text,
      'withdrawal'::text,
      w.operator,
      -w.amount,
      w.status,
      w.created_at
    from public.withdrawals w
    where w.user_id = auth.uid()
  )
  select
    e.transaction_id,
    e.kind,
    e.title,
    e.amount,
    e.status,
    e.occurred_at
  from events e
  order by e.occurred_at desc nulls last, e.transaction_id desc
  offset greatest(coalesce(p_offset, 0), 0)
  limit 51;
$$;

revoke all on function public.my_transactions(integer) from public, anon;
grant execute on function public.my_transactions(integer) to authenticated;

notify pgrst, 'reload schema';
