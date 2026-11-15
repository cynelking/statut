-- StatutPay v9: admin activation and audited status changes
alter table public.proofs add column if not exists bonus int not null default 0;

create table if not exists public.admin_activity (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_phone text,
  target_type text not null check (target_type in ('campaign', 'proof', 'withdrawal')),
  target_id bigint not null,
  old_status text not null,
  new_status text not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_activity_created_at_idx
  on public.admin_activity(created_at desc);

alter table public.admin_activity enable row level security;
drop policy if exists admin_activity_select on public.admin_activity;
create policy admin_activity_select on public.admin_activity
  for select to authenticated using (public.is_admin());
revoke all on public.admin_activity from anon, authenticated;
grant select on public.admin_activity to authenticated;

create or replace function public.log_admin_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_phone text;
begin
  if new.status is distinct from old.status
     and v_actor is not null
     and public.is_admin() then
    select phone into v_phone from public.profiles where id = v_actor;
    insert into public.admin_activity(
      actor_id, actor_phone, target_type, target_id, old_status, new_status
    )
    values (
      v_actor, v_phone, tg_argv[0], new.id, old.status, new.status
    );
  end if;
  return new;
end
$$;

drop trigger if exists campaigns_admin_activity on public.campaigns;
create trigger campaigns_admin_activity
  after update of status on public.campaigns
  for each row execute function public.log_admin_activity('campaign');

drop trigger if exists proofs_admin_activity on public.proofs;
create trigger proofs_admin_activity
  after update of status on public.proofs
  for each row execute function public.log_admin_activity('proof');

drop trigger if exists withdrawals_admin_activity on public.withdrawals;
create trigger withdrawals_admin_activity
  after update of status on public.withdrawals
  for each row execute function public.log_admin_activity('withdrawal');

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
    'pending_wd', (select coalesce(sum(amount), 0) from public.withdrawals where status = 'pending'),
    'bonus_total', v_bonus_total,
    'promo_cost', (select coalesce(sum(credit_used), 0) from public.campaigns),
    'perks', (select coalesce(sum(bonus), 0) from public.proofs where status = 'approved') + v_daily_bonus,
    'boosted', (select count(*) from public.campaigns where boost_hours > 0 and status <> 'pending'),
    'balances', (select coalesce(sum(views + bonus), 0) from public.proofs where status = 'approved')
      + v_bonus_total + v_daily_bonus
      - (select coalesce(sum(amount), 0) from public.withdrawals),
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

create or replace function public.activate_campaign(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;

  update public.campaigns
  set status = 'active',
      boost_until = case when boost_hours > 0 then now() + make_interval(hours => boost_hours) end
  where id = p_id and status = 'pending';

  if not found then raise exception 'Campagne introuvable ou déjà traitée'; end if;
end
$$;

revoke all on function public.activate_campaign(bigint) from public;
grant execute on function public.activate_campaign(bigint) to authenticated;

notify pgrst, 'reload schema';
