-- StatutPay v2 : à exécuter APRÈS schema.sql (Supabase > SQL Editor > Run)

-- 1) Parrainage et ciblage par pays
alter table public.profiles add column if not exists ref_code text unique;
alter table public.profiles add column if not exists referred_by uuid references public.profiles(id);
update public.profiles set ref_code = substr(md5(id::text || random()::text), 1, 8) where ref_code is null;
alter table public.profiles alter column ref_code set default substr(md5(random()::text || clock_timestamp()::text), 1, 8);
alter table public.campaigns add column if not exists country text;  -- null = tous les pays

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
declare ref uuid;
begin
  select id into ref from profiles where ref_code = lower(new.raw_user_meta_data->>'ref') limit 1;
  insert into profiles(id,phone,country,referred_by)
  values(new.id,new.raw_user_meta_data->>'phone',new.raw_user_meta_data->>'country',ref);
  return new;
end $$;

-- 2) Bonus de parrainage (100 F, versé une seule fois par filleul)
create table if not exists public.bonuses(
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id),
  source_user_id uuid not null unique references public.profiles(id),
  amount int not null,
  created_at timestamptz default now());
alter table public.bonuses enable row level security;
drop policy if exists b_sel on public.bonuses;
create policy b_sel on public.bonuses for select to authenticated using (user_id=auth.uid() or is_admin());

create or replace function public.my_balance() returns int language sql security definer stable set search_path=public as $$
  select coalesce((select sum(views) from proofs where user_id=auth.uid() and status='approved'),0)
       + coalesce((select sum(amount) from bonuses where user_id=auth.uid()),0)
       - coalesce((select sum(amount) from withdrawals where user_id=auth.uid()),0) $$;

create or replace function public.review_proof(p_id bigint, p_views int, p_ok boolean) returns void language plpgsql security definer set search_path=public as $$
declare pr proofs; c campaigns; v int;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select * into pr from proofs where id=p_id and status='pending' for update;
  if not found then raise exception 'Preuve introuvable'; end if;
  if not p_ok then update proofs set status='rejected' where id=p_id; return; end if;
  select * into c from campaigns where id=pr.campaign_id for update;
  v := least(greatest(p_views,0), c.budget-c.spent);
  update proofs set status='approved', views=v where id=p_id;
  update campaigns set spent=spent+v, status=case when spent+v>=budget then 'done' else status end where id=c.id;
  if v>0 then
    insert into bonuses(user_id,source_user_id,amount)
    select referred_by, pr.user_id, 100 from profiles where id=pr.user_id and referred_by is not null
    on conflict (source_user_id) do nothing;
  end if;
end $$;

create or replace function public.my_referral_stats() returns table(invited int, bonus int) language sql security definer stable set search_path=public as $$
  select (select count(*) from profiles where referred_by=auth.uid())::int,
         coalesce((select sum(amount) from bonuses where user_id=auth.uid()),0)::int $$;

-- 3) Favoris
create table if not exists public.favorites(
  user_id uuid not null default auth.uid() references public.profiles(id),
  campaign_id bigint not null references public.campaigns(id) on delete cascade,
  primary key(user_id,campaign_id));
alter table public.favorites enable row level security;
drop policy if exists f_all on public.favorites;
create policy f_all on public.favorites for all to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());

-- 4) Classement du mois (numéros masqués)
create or replace function public.leaderboard() returns table(pos int, label text, views bigint, me boolean) language sql security definer stable set search_path=public as $$
  select (row_number() over (order by sum(pr.views) desc))::int, '•••' || right(p.phone,3), sum(pr.views)::bigint, p.id=auth.uid()
  from proofs pr join profiles p on p.id=pr.user_id
  where pr.status='approved' and pr.created_at >= date_trunc('month', now())
  group by p.id, p.phone order by 3 desc limit 10 $$;

-- 5) Notifications push : abonnements
create table if not exists public.push_subscriptions(
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles(id),
  endpoint text unique not null, p256dh text not null, auth text not null,
  country text, created_at timestamptz default now());
alter table public.push_subscriptions enable row level security;
drop policy if exists ps_all on public.push_subscriptions;
create policy ps_all on public.push_subscriptions for all to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());

-- 6) Ciblage par pays : un diffuseur ne peut soumettre que les annonces de son pays (ou sans ciblage)
drop policy if exists pr_ins on public.proofs;
create policy pr_ins on public.proofs for insert to authenticated with check (
  user_id=auth.uid() and status='pending' and views=0
  and exists(select 1 from campaigns c join profiles p on p.id=auth.uid()
             where c.id=campaign_id and c.status='active' and (c.country is null or c.country=p.country)));

-- 7) Tableau de bord admin
create or replace function public.admin_stats() returns jsonb language plpgsql security definer set search_path=public as $$
declare r jsonb;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'users',(select count(*) from profiles),
    'users7',(select count(*) from profiles where created_at > now() - interval '7 days'),
    'ca',(select count(*) from campaigns where status='active'),
    'cp',(select count(*) from campaigns where status='pending'),
    'cd',(select count(*) from campaigns where status='done'),
    'fees',(select count(*)*500 from campaigns where status<>'pending'),
    'views',(select coalesce(sum(views),0) from proofs where status='approved'),
    'paid_out',(select coalesce(sum(amount),0) from withdrawals where status='paid'),
    'pending_wd',(select coalesce(sum(amount),0) from withdrawals where status='pending'),
    'bonus_total',(select coalesce(sum(amount),0) from bonuses),
    'balances',(select coalesce(sum(views),0) from proofs where status='approved') + (select coalesce(sum(amount),0) from bonuses) - (select coalesce(sum(amount),0) from withdrawals),
    'series',(select coalesce(jsonb_agg(jsonb_build_object('d',to_char(d::date,'DD/MM'),
        'users',(select count(*) from profiles where created_at::date=d::date),
        'views',(select coalesce(sum(views),0) from proofs where status='approved' and created_at::date=d::date)) order by d),'[]'::jsonb)
      from generate_series((current_date-13)::timestamp, current_date::timestamp, interval '1 day') as d)
  ) into r;
  return r;
end $$;
