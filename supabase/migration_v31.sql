-- Allow campaign owners to add funds and agency team members to request an increase.

create table if not exists public.campaign_budget_increase_requests (
  id bigint generated always as identity primary key,
  campaign_id bigint not null references public.campaigns(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  amount integer not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index if not exists campaign_budget_increase_one_pending_idx
  on public.campaign_budget_increase_requests(campaign_id)
  where status = 'pending';

alter table public.campaign_budget_increase_requests enable row level security;
revoke all on public.campaign_budget_increase_requests from public, anon, authenticated;
grant select on public.campaign_budget_increase_requests to authenticated;

drop policy if exists campaign_budget_increase_request_select on public.campaign_budget_increase_requests;
create policy campaign_budget_increase_request_select
on public.campaign_budget_increase_requests
for select to authenticated
using (
  requested_by = auth.uid()
  or public.is_admin()
  or exists (
    select 1
    from public.campaigns c
    where c.id = campaign_id
      and (
        c.owner = auth.uid()
        or (
          c.agency_advertiser_id is not null
          and public.has_agency_advertiser_access(c.owner, c.agency_advertiser_id)
        )
      )
  )
);

alter table public.saspay_campaign_payments
  add column if not exists purpose text not null default 'campaign',
  add column if not exists budget_increase_amount integer not null default 0,
  add column if not exists budget_increase_credit_used integer not null default 0,
  add column if not exists budget_increase_wallet_used integer not null default 0,
  add column if not exists budget_increase_request_id bigint
    references public.campaign_budget_increase_requests(id) on delete set null,
  add column if not exists budget_increase_applied boolean not null default false,
  add column if not exists budget_increase_refunded boolean not null default false;

alter table public.saspay_campaign_payments
  drop constraint if exists saspay_campaign_payments_purpose_check,
  add constraint saspay_campaign_payments_purpose_check
    check (purpose in ('campaign', 'budget_increase')),
  drop constraint if exists saspay_campaign_payments_budget_increase_amount_check,
  add constraint saspay_campaign_payments_budget_increase_amount_check
    check (budget_increase_amount >= 0),
  drop constraint if exists saspay_campaign_payments_budget_increase_credit_check,
  add constraint saspay_campaign_payments_budget_increase_credit_check
    check (budget_increase_credit_used >= 0),
  drop constraint if exists saspay_campaign_payments_budget_increase_wallet_check,
  add constraint saspay_campaign_payments_budget_increase_wallet_check
    check (budget_increase_wallet_used >= 0);

drop index if exists public.saspay_campaign_payments_campaign_open_idx;
create unique index saspay_campaign_payments_campaign_open_idx
  on public.saspay_campaign_payments(campaign_id)
  where status in ('pending', 'review');

create or replace function public.request_campaign_budget_increase(
  p_campaign_id bigint,
  p_amount integer
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns%rowtype;
  v_request_id bigint;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000000 then
    raise exception 'Le montant doit être compris entre 1 et 1 000 000 F';
  end if;

  select * into c
  from public.campaigns
  where id = p_campaign_id
  for update;
  if not found
      or c.owner = auth.uid()
      or c.agency_advertiser_id is null
      or c.admin_created
      or c.status not in ('active', 'paused')
      or (c.ends_at is not null and c.ends_at <= clock_timestamp())
      or c.budget::bigint + p_amount > 2147483647
      or not public.has_agency_advertiser_access(c.owner, c.agency_advertiser_id) then
    raise exception 'Campagne introuvable ou demande non autorisée';
  end if;
  if exists (
    select 1 from public.campaign_budget_increase_requests
    where campaign_id = c.id and status = 'pending'
  ) then raise exception 'Une demande d’augmentation est déjà en attente'; end if;

  insert into public.campaign_budget_increase_requests(campaign_id, requested_by, amount)
  values (c.id, auth.uid(), p_amount)
  returning id into v_request_id;
  return v_request_id;
end
$$;

revoke all on function public.request_campaign_budget_increase(bigint, integer) from public, anon;
grant execute on function public.request_campaign_budget_increase(bigint, integer) to authenticated;

create or replace function public.start_campaign_budget_increase_payment(
  p_campaign_id bigint,
  p_amount integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns%rowtype;
  payment public.saspay_campaign_payments%rowtype;
  v_profile_role text;
  v_country text;
  v_iso text;
  v_currency text;
  v_credit_balance integer := 0;
  v_wallet_balance integer := 0;
  v_credit_used integer := 0;
  v_wallet_used integer := 0;
  v_amount_due integer;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000000 then
    raise exception 'Le montant doit être compris entre 1 et 1 000 000 F';
  end if;

  select * into c
  from public.campaigns
  where id = p_campaign_id and owner = auth.uid()
  for update;
  if not found
      or c.admin_created
      or c.status not in ('active', 'paused')
      or (c.ends_at is not null and c.ends_at <= clock_timestamp()) then
    raise exception 'Campagne introuvable ou non admissible à une augmentation';
  end if;
  if c.budget::bigint + p_amount > 2147483647 then
    raise exception 'Le budget maximal de la campagne est dépassé';
  end if;

  select * into payment
  from public.saspay_campaign_payments
  where campaign_id = c.id and status in ('pending', 'review')
  for update;
  if found then
    if payment.purpose <> 'budget_increase'
        or payment.budget_increase_request_id is not null
        or payment.budget_increase_amount <> p_amount then
      raise exception 'Un autre paiement est déjà en cours pour cette campagne';
    end if;
    return jsonb_build_object(
      'payment_id', payment.id, 'amount', payment.amount, 'currency', payment.currency,
      'country', payment.country, 'status', payment.status,
      'checkout_session_id', payment.checkout_session_id, 'checkout_url', payment.checkout_url
    );
  end if;

  select role, country into v_profile_role, v_country
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

  v_amount_due := p_amount;
  if v_profile_role <> 'agency' then
    select coalesce(credit, 0) into v_credit_balance
    from public.profiles where id = auth.uid();
    v_credit_used := least(v_credit_balance, v_amount_due);
    v_amount_due := v_amount_due - v_credit_used;

    if v_amount_due > 0 then
      select balance into v_wallet_balance
      from public.wallet_accounts
      where user_id = auth.uid()
      for update;
      if coalesce(v_wallet_balance, 0) >= v_amount_due then
        v_wallet_used := v_amount_due;
        v_amount_due := 0;
      end if;
    end if;
  end if;

  if v_amount_due = 0 then
    if v_credit_used > 0 then
      update public.profiles set credit = credit - v_credit_used where id = auth.uid();
    end if;
    if v_wallet_used > 0 then
      update public.wallet_accounts
      set balance = balance - v_wallet_used, updated_at = now()
      where user_id = auth.uid();
    end if;
    update public.campaigns
    set budget = budget + p_amount,
        credit_used = credit_used + v_credit_used,
        wallet_used = wallet_used + v_wallet_used
    where id = c.id;
    if v_wallet_used > 0 then
      insert into public.wallet_ledger(user_id, amount, kind, campaign_id, event_key)
      values (auth.uid(), -v_wallet_used, 'campaign_spend', c.id,
        'campaign-budget-increase:' || gen_random_uuid()::text);
    end if;
    return jsonb_build_object('status', 'succeeded', 'amount', p_amount);
  end if;

  if v_credit_used > 0 then
    update public.profiles set credit = credit - v_credit_used where id = auth.uid();
  end if;
  if v_wallet_used > 0 then
    update public.wallet_accounts
    set balance = balance - v_wallet_used, updated_at = now()
    where user_id = auth.uid();
  end if;

  insert into public.saspay_campaign_payments(
    campaign_id, user_id, amount, currency, country, purpose,
    budget_increase_amount, budget_increase_credit_used, budget_increase_wallet_used
  ) values (
    c.id, auth.uid(), v_amount_due, v_currency, v_iso, 'budget_increase',
    p_amount, v_credit_used, v_wallet_used
  )
  returning * into payment;

  if v_wallet_used > 0 then
    insert into public.wallet_ledger(user_id, amount, kind, campaign_id, event_key)
    values (auth.uid(), -v_wallet_used, 'campaign_spend', c.id,
      'campaign-budget-increase-spend:' || payment.id::text);
  end if;

  return jsonb_build_object(
    'payment_id', payment.id, 'amount', payment.amount, 'currency', payment.currency,
    'country', payment.country, 'status', payment.status,
    'checkout_session_id', payment.checkout_session_id, 'checkout_url', payment.checkout_url
  );
end
$$;

revoke all on function public.start_campaign_budget_increase_payment(bigint, integer) from public, anon;
grant execute on function public.start_campaign_budget_increase_payment(bigint, integer) to authenticated;

create or replace function public.start_campaign_budget_increase_request_payment(p_request_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.campaign_budget_increase_requests%rowtype;
  c public.campaigns%rowtype;
  payment public.saspay_campaign_payments%rowtype;
  v_country text;
  v_iso text;
  v_currency text;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;

  select * into r
  from public.campaign_budget_increase_requests
  where id = p_request_id and status = 'pending'
  for update;
  if not found then raise exception 'Demande introuvable ou déjà traitée'; end if;

  select * into c
  from public.campaigns
  where id = r.campaign_id and owner = auth.uid()
  for update;
  if not found then raise exception 'Campagne introuvable ou non autorisée'; end if;
  if c.admin_created
      or c.status not in ('active', 'paused')
      or (c.ends_at is not null and c.ends_at <= clock_timestamp())
      or c.budget::bigint + r.amount > 2147483647 then
    update public.campaign_budget_increase_requests
    set status = 'cancelled', resolved_at = now()
    where id = r.id;
    return jsonb_build_object('status', 'cancelled');
  end if;

  select * into payment
  from public.saspay_campaign_payments
  where campaign_id = c.id and status in ('pending', 'review')
  for update;
  if found then
    if payment.purpose <> 'budget_increase'
        or payment.budget_increase_request_id <> r.id
        or payment.budget_increase_amount <> r.amount then
      raise exception 'Un autre paiement est déjà en cours pour cette campagne';
    end if;
    return jsonb_build_object(
      'payment_id', payment.id, 'amount', payment.amount, 'currency', payment.currency,
      'country', payment.country, 'status', payment.status,
      'checkout_session_id', payment.checkout_session_id, 'checkout_url', payment.checkout_url
    );
  end if;

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

  insert into public.saspay_campaign_payments(
    campaign_id, user_id, amount, currency, country, purpose,
    budget_increase_amount, budget_increase_request_id
  ) values (
    c.id, auth.uid(), r.amount, v_currency, v_iso, 'budget_increase',
    r.amount, r.id
  )
  returning * into payment;

  return jsonb_build_object(
    'payment_id', payment.id, 'amount', payment.amount, 'currency', payment.currency,
    'country', payment.country, 'status', payment.status,
    'checkout_session_id', payment.checkout_session_id, 'checkout_url', payment.checkout_url
  );
end
$$;

revoke all on function public.start_campaign_budget_increase_request_payment(bigint) from public, anon;
grant execute on function public.start_campaign_budget_increase_request_payment(bigint) to authenticated;

create or replace function public.reject_campaign_budget_increase_request(p_request_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.campaign_budget_increase_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;

  select * into r
  from public.campaign_budget_increase_requests
  where id = p_request_id and status = 'pending'
  for update;
  if not found then raise exception 'Demande introuvable ou déjà traitée'; end if;

  if not exists (
    select 1 from public.campaigns c
    join public.profiles p on p.id = c.owner
    where c.id = r.campaign_id and c.owner = auth.uid() and p.role = 'agency'
  ) then raise exception 'Seul le propriétaire de l’agence peut refuser cette demande'; end if;
  if exists (
    select 1 from public.saspay_campaign_payments
    where budget_increase_request_id = r.id and status in ('pending', 'review')
  ) then raise exception 'Un paiement est déjà en cours pour cette demande'; end if;

  update public.campaign_budget_increase_requests
  set status = 'rejected', resolved_at = now()
  where id = r.id;
end
$$;

revoke all on function public.reject_campaign_budget_increase_request(bigint) from public, anon;
grant execute on function public.reject_campaign_budget_increase_request(bigint) to authenticated;

create or replace function public.refund_campaign_budget_increase(p_payment_id uuid, p_refund_payment_amount boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  payment public.saspay_campaign_payments%rowtype;
  v_wallet_refund integer;
begin
  select * into payment
  from public.saspay_campaign_payments
  where id = p_payment_id
  for update;
  if not found or payment.purpose <> 'budget_increase' or payment.budget_increase_refunded then return; end if;

  if payment.budget_increase_credit_used > 0 then
    update public.profiles
    set credit = credit + payment.budget_increase_credit_used
    where id = payment.user_id;
  end if;

  v_wallet_refund := payment.budget_increase_wallet_used
    + case when p_refund_payment_amount then payment.amount else 0 end;
  if v_wallet_refund > 0 then
    insert into public.wallet_accounts(user_id, balance)
    values (payment.user_id, v_wallet_refund)
    on conflict (user_id) do update
    set balance = public.wallet_accounts.balance + excluded.balance,
        updated_at = now();
    insert into public.wallet_ledger(user_id, amount, kind, campaign_id, event_key)
    values (
      payment.user_id, v_wallet_refund, 'campaign_refund', payment.campaign_id,
      'campaign-budget-increase-refund:' || payment.id::text
    )
    on conflict (event_key) do nothing;
  end if;

  update public.saspay_campaign_payments
  set budget_increase_refunded = true, updated_at = now()
  where id = payment.id;
end
$$;

revoke all on function public.refund_campaign_budget_increase(uuid, boolean) from public, anon, authenticated;

create or replace function public.apply_campaign_budget_increase(p_payment_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  payment public.saspay_campaign_payments%rowtype;
  c public.campaigns%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into payment
  from public.saspay_campaign_payments
  where id = p_payment_id
  for update;
  if not found or payment.purpose <> 'budget_increase' or payment.status <> 'succeeded' then
    raise exception 'Paiement d’augmentation introuvable';
  end if;
  if payment.budget_increase_refunded then return 'refunded'; end if;
  if payment.budget_increase_applied then return 'succeeded'; end if;

  select * into c from public.campaigns where id = payment.campaign_id for update;
  if not found then raise exception 'Campagne introuvable'; end if;

  if c.budget::bigint + payment.budget_increase_amount <= 2147483647
      and (c.ends_at is null or c.ends_at > v_now)
      and c.status in ('active', 'paused') then
    update public.campaigns
    set budget = budget + payment.budget_increase_amount,
        credit_used = credit_used + payment.budget_increase_credit_used,
        wallet_used = wallet_used + payment.budget_increase_wallet_used,
        payment_status = case when payment_status = 'review' then 'paid' else payment_status end
    where id = c.id;
    update public.saspay_campaign_payments
    set budget_increase_applied = true, updated_at = now()
    where id = payment.id;
    if payment.budget_increase_request_id is not null then
      update public.campaign_budget_increase_requests
      set status = 'paid', resolved_at = now()
      where id = payment.budget_increase_request_id and status = 'pending';
    end if;
    return 'succeeded';
  end if;

  perform public.refund_campaign_budget_increase(payment.id, true);
  if payment.budget_increase_request_id is not null then
    update public.campaign_budget_increase_requests
    set status = 'cancelled', resolved_at = now()
    where id = payment.budget_increase_request_id and status = 'pending';
  end if;
  return 'refunded';
end
$$;

revoke all on function public.apply_campaign_budget_increase(uuid) from public, anon, authenticated;

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
  if payment.status = 'succeeded' then
    if payment.purpose = 'budget_increase' then
      return public.apply_campaign_budget_increase(payment.id);
    end if;
    return payment.status;
  end if;
  if payment.status = 'failed' then return payment.status; end if;
  if payment.status = 'review' and p_status <> 'SUCCESS' then return payment.status; end if;

  if p_status = 'FAILED' then
    update public.saspay_campaign_payments
    set status = 'failed', provider_transaction_id = p_provider_transaction_id, updated_at = now()
    where id = payment.id;
    if payment.purpose = 'budget_increase' then
      perform public.refund_campaign_budget_increase(payment.id, false);
    else
      update public.campaigns set payment_status = 'failed' where id = payment.campaign_id;
    end if;
    return 'failed';
  end if;
  if p_status <> 'SUCCESS' then return payment.status; end if;

  if p_currency is distinct from payment.currency then
    update public.saspay_campaign_payments
    set status = 'review', provider_transaction_id = p_provider_transaction_id, updated_at = now()
    where id = payment.id;
    update public.campaigns set payment_status = 'review' where id = payment.campaign_id;
    return 'review';
  end if;

  update public.saspay_campaign_payments
  set status = 'succeeded', provider_transaction_id = p_provider_transaction_id, updated_at = now()
  where id = payment.id;
  if payment.purpose = 'budget_increase' then
    return public.apply_campaign_budget_increase(payment.id);
  end if;

  update public.campaigns
  set payment_status = 'paid',
      status = case when status = 'pending' then 'active' else status end,
      boost_until = case when boost_hours > 0 and status = 'pending'
        then now() + make_interval(hours => boost_hours) else boost_until end
  where id = payment.campaign_id;
  return 'succeeded';
end
$$;

revoke all on function public.complete_saspay_campaign_payment(uuid, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.complete_saspay_campaign_payment(uuid, text, text, numeric, text)
  to service_role;

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
    if payment.purpose = 'budget_increase' then
      perform public.refund_campaign_budget_increase(payment.id, false);
    else
      update public.campaigns set payment_status = 'failed' where id = payment.campaign_id;
    end if;
  end if;
end
$$;

revoke all on function public.expire_saspay_campaign_payment(uuid) from public, anon, authenticated;
grant execute on function public.expire_saspay_campaign_payment(uuid) to service_role;

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
    raise exception 'Aucun paiement AlphaPay à vérifier pour cette campagne';
  end if;

  update public.saspay_campaign_payments
  set status = 'succeeded', updated_at = now()
  where id = payment.id;
  if payment.purpose = 'budget_increase' then
    perform public.apply_campaign_budget_increase(payment.id);
  else
    update public.campaigns
    set payment_status = 'paid',
        status = case when status = 'pending' then 'active' else status end,
        boost_until = case when boost_hours > 0 and status = 'pending'
          then now() + make_interval(hours => boost_hours) else boost_until end
    where id = p_campaign_id;
  end if;
end
$$;

revoke all on function public.admin_resolve_saspay_payment_review(bigint) from public, anon;
grant execute on function public.admin_resolve_saspay_payment_review(bigint) to authenticated;

notify pgrst, 'reload schema';
