-- Configure user-opted-in automatic withdrawals and their AlphaPay payouts.

alter table public.withdrawals
  add column if not exists automatic boolean not null default false,
  add column if not exists fee integer not null default 0,
  add column if not exists payout_amount integer;

update public.withdrawals
set payout_amount = amount
where payout_amount is null;

alter table public.withdrawals
  alter column payout_amount set not null,
  alter column payout_amount set default 0,
  drop constraint if exists withdrawals_fee_check,
  add constraint withdrawals_fee_check check (fee >= 0),
  drop constraint if exists withdrawals_payout_amount_check,
  add constraint withdrawals_payout_amount_check check (payout_amount >= 0);

alter table public.withdrawals
  drop constraint if exists withdrawals_amount_breakdown_check,
  add constraint withdrawals_amount_breakdown_check
    check (amount = fee + payout_amount);

create or replace function public.set_withdrawal_fee()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.fee := case
    when new.amount < 200 then 0
    when new.amount < 1000 then 50
    when new.amount < 5000 then 100
    else 0
  end;
  new.payout_amount := greatest(0, new.amount - new.fee);
  return new;
end
$$;

drop trigger if exists withdrawals_set_fee on public.withdrawals;
create trigger withdrawals_set_fee
before insert or update of amount on public.withdrawals
for each row execute function public.set_withdrawal_fee();

create table if not exists public.withdrawal_auto_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  enabled boolean not null default false,
  amount integer not null check (amount >= 200),
  operator text not null,
  recipient_country text not null check (recipient_country ~ '^[A-Z]{2}$'),
  recipient_network text not null check (recipient_network ~ '^[a-z0-9_]{2,40}$'),
  recipient_phone text not null check (recipient_phone ~ '^[+0-9][0-9 +()-]{5,24}$'),
  last_error text,
  updated_at timestamptz not null default now()
);

alter table public.withdrawal_auto_settings enable row level security;
revoke all on public.withdrawal_auto_settings from public, anon, authenticated;
grant select on public.withdrawal_auto_settings to authenticated;
grant all on public.withdrawal_auto_settings to service_role;

drop policy if exists withdrawal_auto_settings_select on public.withdrawal_auto_settings;
create policy withdrawal_auto_settings_select
on public.withdrawal_auto_settings
for select to authenticated
using (user_id = auth.uid());

create or replace function public.save_withdrawal_auto_settings(
  p_enabled boolean,
  p_amount integer,
  p_operator text,
  p_country text,
  p_network text,
  p_phone text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone_verified boolean;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_enabled is null then raise exception 'État du retrait automatique invalide'; end if;

  if not p_enabled then
    update public.withdrawal_auto_settings
    set enabled = false, last_error = null, updated_at = now()
    where user_id = auth.uid();
    return;
  end if;

  if p_amount is null or p_amount < 200 then raise exception 'Le montant automatique minimum est de 200 F'; end if;
  if p_operator is null or length(trim(p_operator)) = 0
      or p_country is null or p_country !~ '^[A-Z]{2}$'
      or p_network is null or p_network !~ '^[a-z0-9_]{2,40}$'
      or p_phone is null or p_phone !~ '^[+0-9][0-9 +()-]{5,24}$' then
    raise exception 'Coordonnées Mobile Money invalides';
  end if;

  select phone_verified into v_phone_verified
  from public.profiles
  where id = auth.uid()
  for update;
  if not found then raise exception 'Profil introuvable'; end if;
  if needs_sms() and not coalesce(v_phone_verified, false) then
    raise exception 'Vérifiez votre numéro par SMS avant d’activer les retraits automatiques';
  end if;

  insert into public.withdrawal_auto_settings(
    user_id, enabled, amount, operator, recipient_country, recipient_network, recipient_phone, last_error, updated_at
  ) values (
    auth.uid(), true, p_amount, left(trim(p_operator), 80), p_country, p_network, trim(p_phone), null, now()
  )
  on conflict (user_id) do update
  set enabled = true,
      amount = excluded.amount,
      operator = excluded.operator,
      recipient_country = excluded.recipient_country,
      recipient_network = excluded.recipient_network,
      recipient_phone = excluded.recipient_phone,
      last_error = null,
      updated_at = now();
end
$$;

revoke all on function public.save_withdrawal_auto_settings(boolean, integer, text, text, text, text)
  from public, anon;
grant execute on function public.save_withdrawal_auto_settings(boolean, integer, text, text, text, text)
  to authenticated;

create or replace function public.claim_due_auto_withdrawals()
returns table(withdrawal_id bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_setting public.withdrawal_auto_settings%rowtype;
  v_pending record;
  v_phone_verified boolean;
  v_balance integer;
  v_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;

  for v_pending in
    select id
    from public.withdrawals
    where automatic and status in ('pending', 'processing')
    order by created_at, id
    limit 20
  loop
    withdrawal_id := v_pending.id;
    v_count := v_count + 1;
    return next;
  end loop;

  if v_count >= 20 then return; end if;

  for v_setting in
    select *
    from public.withdrawal_auto_settings
    where enabled
    order by updated_at, user_id
    limit 20 - v_count
    for update skip locked
  loop
    perform 1 from public.profiles where id = v_setting.user_id for update;
    if not found then continue; end if;

    if exists (
      select 1 from public.withdrawals
      where user_id = v_setting.user_id and status in ('pending', 'processing')
    ) then
      continue;
    end if;

    select phone_verified into v_phone_verified
    from public.profiles where id = v_setting.user_id;
    if needs_sms() and not coalesce(v_phone_verified, false) then
      update public.withdrawal_auto_settings
      set enabled = false,
          last_error = 'Vérification SMS requise pour les retraits automatiques.',
          updated_at = now()
      where user_id = v_setting.user_id;
      continue;
    end if;

    select (
      coalesce((
        select sum(p.base_reward + p.bonus)
        from public.proofs p
        where p.user_id = v_setting.user_id and p.status = 'approved'
      ), 0)
      - coalesce((
        select sum(w.amount)
        from public.withdrawals w
        where w.user_id = v_setting.user_id and w.status <> 'failed'
      ), 0)
    )::integer into v_balance;

    if v_balance < v_setting.amount then continue; end if;

    insert into public.withdrawals(
      user_id, amount, operator, status, recipient_country, recipient_network, recipient_phone, automatic
    ) values (
      v_setting.user_id,
      v_setting.amount,
      v_setting.operator,
      'pending',
      v_setting.recipient_country,
      v_setting.recipient_network,
      v_setting.recipient_phone,
      true
    )
    returning id into withdrawal_id;
    v_count := v_count + 1;
    return next;
    if v_count >= 20 then return; end if;
  end loop;
end
$$;

revoke all on function public.claim_due_auto_withdrawals() from public, anon, authenticated;
grant execute on function public.claim_due_auto_withdrawals() to service_role;

create or replace function public.claim_auto_saspay_payout(p_withdrawal_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.withdrawals%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
  select * into w
  from public.withdrawals
  where id = p_withdrawal_id and automatic
  for update;
  if not found then raise exception 'Retrait automatique introuvable'; end if;
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
    'fee', w.fee,
    'payout_amount', w.payout_amount,
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

revoke all on function public.claim_auto_saspay_payout(bigint) from public, anon, authenticated;
grant execute on function public.claim_auto_saspay_payout(bigint) to service_role;

create or replace function public.fail_auto_saspay_payout(p_withdrawal_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.withdrawals%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
  select * into w
  from public.withdrawals
  where id = p_withdrawal_id and automatic
  for update;
  if not found or w.saspay_payout_id is not null then return; end if;

  update public.withdrawals
  set status = 'failed', updated_at = now()
  where id = w.id and status in ('pending', 'processing');
  update public.withdrawal_auto_settings
  set enabled = false,
      last_error = 'Le payout automatique a échoué. Vérifiez le réseau et le numéro avant de le réactiver.',
      updated_at = now()
  where user_id = w.user_id;
end
$$;

revoke all on function public.fail_auto_saspay_payout(bigint) from public, anon, authenticated;
grant execute on function public.fail_auto_saspay_payout(bigint) to service_role;

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
    'fee', w.fee,
    'payout_amount', w.payout_amount,
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
    if w.automatic then
      update public.withdrawal_auto_settings
      set enabled = false,
          last_error = 'Le payout automatique a échoué. Vérifiez le réseau et le numéro avant de le réactiver.',
          updated_at = now()
      where user_id = w.user_id;
    end if;
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

notify pgrst, 'reload schema';
