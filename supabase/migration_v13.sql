-- SasPay checkout and payout integration.
-- Apply after migration_v12.sql.

alter table public.campaigns
  add column if not exists payment_provider text,
  add column if not exists payment_status text;

alter table public.campaigns
  drop constraint if exists campaigns_payment_provider_check,
  add constraint campaigns_payment_provider_check
    check (payment_provider is null or payment_provider = 'saspay');

alter table public.campaigns
  drop constraint if exists campaigns_payment_status_check,
  add constraint campaigns_payment_status_check
    check (payment_status is null or payment_status in ('pending', 'paid', 'failed', 'review'));

create table if not exists public.saspay_campaign_payments (
  id uuid primary key default gen_random_uuid(),
  campaign_id bigint not null references public.campaigns(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null check (amount > 0),
  currency text not null check (currency in ('XOF', 'XAF')),
  country text not null,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'review')),
  checkout_session_id text unique,
  checkout_url text,
  checkout_claimed_at timestamptz,
  provider_transaction_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saspay_campaign_payments_pending_idx
  on public.saspay_campaign_payments(created_at)
  where status = 'pending';

create unique index if not exists saspay_campaign_payments_campaign_open_idx
  on public.saspay_campaign_payments(campaign_id)
  where status in ('pending', 'succeeded', 'review');

alter table public.saspay_campaign_payments enable row level security;
revoke all on public.saspay_campaign_payments from anon, authenticated;

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
  if v_iso is null then raise exception 'Pays du profil non pris en charge par SasPay'; end if;
  v_currency := case when v_iso in ('CM', 'GA', 'TD', 'CG', 'CF', 'GQ') then 'XAF' else 'XOF' end;
  v_amount := c.budget + 500
    + case when c.boost_hours > 0 then 1000 else 0 end
    - c.credit_used;
  if v_amount <= 0 then raise exception 'Aucun paiement SasPay n’est nécessaire'; end if;

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
  set payment_provider = 'saspay',
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

create or replace function public.claim_saspay_checkout(p_payment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  payment public.saspay_campaign_payments%rowtype;
begin
  select * into payment
  from public.saspay_campaign_payments
  where id = p_payment_id and user_id = auth.uid()
  for update;
  if not found or payment.status <> 'pending' then
    raise exception 'Paiement introuvable ou déjà traité';
  end if;
  if payment.checkout_session_id is not null then return false; end if;
  if payment.checkout_claimed_at > now() - interval '2 minutes' then return false; end if;

  update public.saspay_campaign_payments
  set checkout_claimed_at = now(), updated_at = now()
  where id = payment.id;
  return true;
end
$$;

revoke all on function public.claim_saspay_checkout(uuid) from public, anon;
grant execute on function public.claim_saspay_checkout(uuid) to authenticated;

create or replace function public.release_saspay_checkout(p_payment_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.saspay_campaign_payments
  set checkout_claimed_at = null, updated_at = now()
  where id = p_payment_id and user_id = auth.uid()
    and checkout_session_id is null and status = 'pending'
$$;

revoke all on function public.release_saspay_checkout(uuid) from public, anon;
grant execute on function public.release_saspay_checkout(uuid) to authenticated;

create or replace function public.complete_saspay_campaign_payment(
  p_payment_id uuid,
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
  payment public.saspay_campaign_payments%rowtype;
begin
  select * into payment
  from public.saspay_campaign_payments
  where id = p_payment_id
  for update;
  if not found then raise exception 'Paiement introuvable'; end if;

  if payment.status = 'succeeded' then return payment.status; end if;
  if payment.status in ('failed', 'review') then return payment.status; end if;

  if p_status = 'FAILED' then
    update public.saspay_campaign_payments
    set status = 'failed', provider_transaction_id = p_provider_transaction_id,
        updated_at = now()
    where id = payment.id;
    update public.campaigns set payment_status = 'failed' where id = payment.campaign_id;
    return 'failed';
  end if;
  if p_status <> 'SUCCESS' then return payment.status; end if;

  if p_currency <> payment.currency or p_net_amount < payment.amount then
    update public.saspay_campaign_payments
    set status = 'review', provider_transaction_id = p_provider_transaction_id,
        updated_at = now()
    where id = payment.id;
    update public.campaigns set payment_status = 'review' where id = payment.campaign_id;
    return 'review';
  end if;

  update public.saspay_campaign_payments
  set status = 'succeeded', provider_transaction_id = p_provider_transaction_id,
      updated_at = now()
  where id = payment.id;

  update public.campaigns
  set payment_status = 'paid',
      status = case when status = 'pending' then 'active' else status end,
      boost_until = case when boost_hours > 0 and status = 'pending'
        then now() + make_interval(hours => boost_hours) else boost_until end
  where id = payment.campaign_id;
  return 'succeeded';
end
$$;

revoke all on function public.complete_saspay_campaign_payment(uuid, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.complete_saspay_campaign_payment(uuid, text, text, numeric, text) to service_role;

create or replace function public.expire_saspay_campaign_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  payment public.saspay_campaign_payments%rowtype;
begin
  update public.saspay_campaign_payments
  set status = 'failed', updated_at = now()
  where id = p_payment_id and status = 'pending'
  returning * into payment;
  if found then
    update public.campaigns set payment_status = 'failed' where id = payment.campaign_id;
  end if;
end
$$;

revoke all on function public.expire_saspay_campaign_payment(uuid) from public, anon, authenticated;
grant execute on function public.expire_saspay_campaign_payment(uuid) to service_role;

alter table public.withdrawals
  add column if not exists recipient_country text,
  add column if not exists recipient_network text,
  add column if not exists recipient_phone text,
  add column if not exists saspay_idempotency_key uuid,
  add column if not exists saspay_payout_id text;

alter table public.withdrawals
  drop constraint if exists withdrawals_status_check,
  add constraint withdrawals_status_check
    check (status in ('pending', 'processing', 'paid', 'failed'));

create unique index if not exists withdrawals_saspay_payout_id_idx
  on public.withdrawals(saspay_payout_id)
  where saspay_payout_id is not null;

drop function if exists public.request_withdrawal(integer, text);
create or replace function public.request_withdrawal(
  p_amount integer,
  p_operator text,
  p_country text,
  p_network text,
  p_phone text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
  );
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
  select coalesce((select sum(views + bonus) from public.proofs where user_id = auth.uid() and status = 'approved'), 0)
       + coalesce((select sum(amount) from public.bonuses where user_id = auth.uid()), 0)
       + coalesce((select sum(bonus) from public.daily_claims where user_id = auth.uid()), 0)
       - coalesce((select sum(amount) from public.withdrawals where user_id = auth.uid() and status <> 'failed'), 0)
$$;

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
      + v_bonus_total + v_daily_bonus
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

revoke all on function public.admin_stats() from public;
grant execute on function public.admin_stats() to authenticated;

create or replace function public.claim_saspay_payout(p_withdrawal_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.withdrawals%rowtype;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select * into w from public.withdrawals where id = p_withdrawal_id for update;
  if not found then raise exception 'Retrait introuvable'; end if;
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

create or replace function public.complete_saspay_payout(p_provider_payout_id text, p_status text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.withdrawals%rowtype;
begin
  select * into w from public.withdrawals
  where saspay_payout_id = p_provider_payout_id
  for update;
  if not found then raise exception 'Payout SasPay introuvable'; end if;
  if p_status = 'SUCCESS' then
    update public.withdrawals set status = 'paid'
    where id = w.id and status in ('pending', 'processing');
    return 'paid';
  elsif p_status = 'FAILED' then
    update public.withdrawals set status = 'failed'
    where id = w.id and status in ('pending', 'processing');
    return 'failed';
  elsif p_status = 'PENDING' then
    update public.withdrawals set status = 'processing'
    where id = w.id and status = 'pending';
    return 'processing';
  end if;
  raise exception 'Statut SasPay invalide';
end
$$;

revoke all on function public.complete_saspay_payout(text, text) from public, anon, authenticated;
grant execute on function public.complete_saspay_payout(text, text) to service_role;

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
    where id = p_id and payment_provider = 'saspay' and payment_status <> 'paid'
  ) then raise exception 'Le paiement SasPay doit être confirmé avant activation'; end if;

  update public.campaigns
  set status = 'active',
      boost_until = case when boost_hours > 0 then now() + make_interval(hours => boost_hours) end
  where id = p_id and status = 'pending';
  if not found then raise exception 'Campagne introuvable ou déjà traitée'; end if;
end
$$;

revoke all on function public.activate_campaign(bigint) from public;
grant execute on function public.activate_campaign(bigint) to authenticated;

create or replace function public.admin_resolve_saspay_payment_review(p_campaign_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  payment public.saspay_campaign_payments%rowtype;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select * into payment
  from public.saspay_campaign_payments
  where campaign_id = p_campaign_id and status = 'review'
  for update;
  if not found or payment.provider_transaction_id is null then
    raise exception 'Aucun paiement SasPay à vérifier pour cette campagne';
  end if;

  update public.saspay_campaign_payments
  set status = 'succeeded', updated_at = now()
  where id = payment.id;
  update public.campaigns
  set payment_status = 'paid',
      status = case when status = 'pending' then 'active' else status end,
      boost_until = case when boost_hours > 0 and status = 'pending'
        then now() + make_interval(hours => boost_hours) else boost_until end
  where id = p_campaign_id;
end
$$;

revoke all on function public.admin_resolve_saspay_payment_review(bigint) from public, anon;
grant execute on function public.admin_resolve_saspay_payment_review(bigint) to authenticated;

notify pgrst, 'reload schema';
