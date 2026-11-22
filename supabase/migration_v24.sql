-- Pay publishers 3 F per approved campaign view.
-- Apply after migration_v23.sql.

alter table public.proofs
  add column if not exists base_reward integer not null default 0;

update public.proofs
set base_reward = views
where status = 'approved' and base_reward = 0;

create or replace function public.start_proof(p_campaign_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns%rowtype;
  v_country text;
  v_proof_id bigint;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;

  select * into c
  from public.campaigns
  where id = p_campaign_id
  for update;
  if not found or c.status <> 'active' or c.budget - c.spent < 3 then
    raise exception 'Cette campagne n’est plus disponible';
  end if;
  if c.owner = auth.uid() then raise exception 'Vous ne pouvez pas diffuser votre propre campagne'; end if;
  if c.starts_at is not null and c.starts_at > now() then raise exception 'Cette campagne n’a pas encore commencé'; end if;
  if c.ends_at is not null and c.ends_at <= now() then raise exception 'Cette campagne est terminée'; end if;

  select country into v_country
  from public.profiles
  where id = auth.uid();
  if c.country is not null and c.country is distinct from v_country then
    raise exception 'Cette campagne ne cible pas votre pays';
  end if;

  insert into public.proofs(campaign_id, user_id, image_path, status, views, posted_at)
  values (c.id, auth.uid(), null, 'pending', 0, clock_timestamp())
  returning id into v_proof_id;
  return v_proof_id;
exception
  when unique_violation then
    raise exception 'Vous avez déjà commencé cette campagne';
end
$$;

revoke all on function public.start_proof(bigint) from public, anon;
grant execute on function public.start_proof(bigint) to authenticated;

create or replace function public.review_proof(p_id bigint, p_views int, p_ok boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pr public.proofs%rowtype;
  c public.campaigns%rowtype;
  v int;
  lv record;
  b int;
  cur uuid;
  up uuid;
  lvl int := 1;
  amt int[] := array[100, 30, 10];
  a int;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select * into pr from public.proofs where id = p_id and status = 'pending' for update;
  if not found or pr.image_path is null then raise exception 'Preuve introuvable'; end if;
  if pr.posted_at is not null and (
    pr.first_submitted_at is null
    or pr.first_submitted_at < pr.posted_at + interval '1 hour'
    or pr.first_submitted_at >= pr.posted_at + interval '23 hours'
    or pr.final_image_path is null
    or pr.final_submitted_at is null
    or pr.final_submitted_at < pr.posted_at + interval '23 hours'
    or pr.final_submitted_at >= pr.posted_at + interval '24 hours'
  ) then
    raise exception 'Les captures H+1 et H+23 sont obligatoires pour valider cette preuve';
  end if;

  select * into c from public.campaigns where id = pr.campaign_id for update;
  if not p_ok then
    update public.proofs set status = 'rejected', rejection_reason = 'admin' where id = p_id;
    return;
  end if;

  v := least(greatest(p_views, 0), greatest((c.budget - c.spent) / 3, 0));
  select * into lv from public.level_of(pr.user_id);
  b := floor(v * 3 * lv.pct / 100.0)::int;
  update public.proofs
  set status = 'approved', views = v, base_reward = v * 3, bonus = b, rejection_reason = null
  where id = p_id;
  update public.campaigns
  set spent = spent + v * 3,
      status = case when budget - (spent + v * 3) < 3 then 'done' else status end
  where id = c.id;

  if v > 0 then
    cur := pr.user_id;
    while lvl <= 3 loop
      select referred_by into up from public.profiles where id = cur;
      exit when up is null;
      a := amt[lvl];
      if lvl = 1 and (select count(*) from public.bonuses where user_id = up and level = 1) >= 10 then
        a := 150;
      end if;
      insert into public.bonuses(user_id, source_user_id, amount, level)
      values (up, pr.user_id, a, lvl)
      on conflict (source_user_id, level) do nothing;
      cur := up;
      lvl := lvl + 1;
    end loop;

    insert into public.daily_claims(user_id, day, bonus)
    select pr.user_id, pr.created_at::date, 50
    where (
      select count(*) from public.proofs
      where user_id = pr.user_id and status = 'approved' and created_at::date = pr.created_at::date
    ) >= 3
    on conflict do nothing;
  end if;
end
$$;

revoke all on function public.review_proof(bigint, int, boolean) from public, anon;
grant execute on function public.review_proof(bigint, int, boolean) to authenticated;

create or replace function public.my_balance()
returns integer
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((
    select sum(p.base_reward + p.bonus)
    from public.proofs p
    where p.user_id = auth.uid() and p.status = 'approved'
  ), 0)::integer
  - coalesce((
    select sum(w.amount)
    from public.withdrawals w
    where w.user_id = auth.uid() and w.status <> 'failed'
  ), 0)::integer
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
    'balances', (select coalesce(sum(base_reward + bonus), 0) from public.proofs where status = 'approved')
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
