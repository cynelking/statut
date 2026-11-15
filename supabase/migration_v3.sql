-- StatutPay v3 : à exécuter APRÈS schema.sql et migration_v2.sql

-- Profils : nom, avatar, crédit annonceur
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar text;
alter table public.profiles add column if not exists credit int not null default 0;

-- Campagnes : boost et crédit utilisé
alter table public.campaigns add column if not exists boost_hours int not null default 0;
alter table public.campaigns add column if not exists boost_until timestamptz;
alter table public.campaigns add column if not exists credit_used int not null default 0;
drop policy if exists c_ins on public.campaigns;  -- la création passe désormais par create_campaign()

-- Preuves : bonus de niveau
alter table public.proofs add column if not exists bonus int not null default 0;

-- Codes promo
create table if not exists public.promo_codes(
  code text primary key, credit int not null check (credit>0),
  max_uses int, uses int not null default 0, expires_at timestamptz,
  active boolean not null default true, created_at timestamptz default now());
create table if not exists public.promo_redemptions(
  user_id uuid primary key references public.profiles(id), code text not null, created_at timestamptz default now());
alter table public.promo_codes enable row level security;
alter table public.promo_redemptions enable row level security;
drop policy if exists pc_admin on public.promo_codes;
create policy pc_admin on public.promo_codes for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists pcr_sel on public.promo_redemptions;
create policy pcr_sel on public.promo_redemptions for select to authenticated using (user_id=auth.uid() or is_admin());

-- Défis quotidiens (3 preuves validées le même jour = +50 F)
create table if not exists public.daily_claims(
  user_id uuid not null references public.profiles(id), day date not null, bonus int not null,
  primary key(user_id,day));
alter table public.daily_claims enable row level security;
drop policy if exists dc_sel on public.daily_claims;
create policy dc_sel on public.daily_claims for select to authenticated using (user_id=auth.uid() or is_admin());

-- Avis
create table if not exists public.reviews(
  id bigint generated always as identity primary key,
  proof_id bigint not null references public.proofs(id) on delete cascade,
  from_user uuid not null references public.profiles(id), to_user uuid not null references public.profiles(id),
  dir text not null check (dir in ('pub_to_adv','adv_to_pub')),
  stars int not null check (stars between 1 and 5), comment text, created_at timestamptz default now(),
  unique(proof_id,from_user));
alter table public.reviews enable row level security;
drop policy if exists rv_sel on public.reviews;
create policy rv_sel on public.reviews for select to authenticated using (from_user=auth.uid() or to_user=auth.uid() or is_admin());

-- Niveaux : Bronze (0 %), Argent (+5 %), Or (+10 %)
create or replace function public.level_of(u uuid) returns table(lvl text, pct int, n_ok int, n_ko int) language plpgsql stable security definer set search_path=public as $$
declare a int; r int;
begin
  select count(*) filter (where status='approved'), count(*) filter (where status='rejected') into a, r from proofs where user_id=u;
  n_ok:=a; n_ko:=r;
  if a>=20 and a::numeric/(a+r)>=0.9 then lvl:='gold'; pct:=10;
  elsif a>=5 and a::numeric/(a+r)>=0.8 then lvl:='silver'; pct:=5;
  else lvl:='bronze'; pct:=0; end if;
  return next;
end $$;
create or replace function public.my_level() returns table(lvl text, pct int, n_ok int, n_ko int) language sql security definer stable set search_path=public as $$
  select * from level_of(auth.uid()) $$;

create or replace function public.my_balance() returns int language sql security definer stable set search_path=public as $$
  select coalesce((select sum(views+bonus) from proofs where user_id=auth.uid() and status='approved'),0)
       + coalesce((select sum(amount) from bonuses where user_id=auth.uid()),0)
       + coalesce((select sum(bonus) from daily_claims where user_id=auth.uid()),0)
       - coalesce((select sum(amount) from withdrawals where user_id=auth.uid()),0) $$;

create or replace function public.review_proof(p_id bigint, p_views int, p_ok boolean) returns void language plpgsql security definer set search_path=public as $$
declare pr proofs; c campaigns; v int; lv record; b int;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select * into pr from proofs where id=p_id and status='pending' for update;
  if not found then raise exception 'Preuve introuvable'; end if;
  if not p_ok then update proofs set status='rejected' where id=p_id; return; end if;
  select * into c from campaigns where id=pr.campaign_id for update;
  v := least(greatest(p_views,0), c.budget-c.spent);
  select * into lv from level_of(pr.user_id);
  b := floor(v * lv.pct / 100.0)::int;
  update proofs set status='approved', views=v, bonus=b where id=p_id;
  update campaigns set spent=spent+v, status=case when spent+v>=budget then 'done' else status end where id=c.id;
  if v>0 then
    insert into bonuses(user_id,source_user_id,amount)
      select referred_by, pr.user_id, 100 from profiles where id=pr.user_id and referred_by is not null
      on conflict (source_user_id) do nothing;
    insert into daily_claims(user_id,day,bonus)
      select pr.user_id, pr.created_at::date, 50
      where (select count(*) from proofs where user_id=pr.user_id and status='approved' and created_at::date=pr.created_at::date) >= 3
      on conflict do nothing;
  end if;
end $$;

-- Création de campagne (budget + 500 F + boost 1 000 F, moins le crédit)
create or replace function public.create_campaign(p_title text, p_type text, p_content text, p_budget int, p_country text, p_boost boolean, p_use_credit boolean) returns bigint language plpgsql security definer set search_path=public as $$
declare total int; cr int := 0; cred int; cid bigint; st text := 'pending';
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_budget < 1000 then raise exception 'Budget minimum 1 000 F'; end if;
  if length(trim(coalesce(p_title,''))) = 0 then raise exception 'Titre requis'; end if;
  total := p_budget + 500 + case when p_boost then 1000 else 0 end;
  perform 1 from profiles where id=auth.uid() for update;
  select credit into cred from profiles where id=auth.uid();
  if p_use_credit then cr := least(cred, total); end if;
  if cr > 0 then update profiles set credit = credit - cr where id=auth.uid(); end if;
  if cr >= total then st := 'active'; end if;
  insert into campaigns(owner,title,type,content,budget,country,boost_hours,credit_used,status,boost_until)
  values(auth.uid(), left(trim(p_title),80), p_type, left(coalesce(p_content,''),500), p_budget, nullif(p_country,''),
         case when p_boost then 48 else 0 end, cr, st,
         case when st='active' and p_boost then now() + interval '48 hours' end)
  returning id into cid;
  return cid;
end $$;

create or replace function public.activate_campaign(p_id bigint) returns void language plpgsql security definer set search_path=public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  update campaigns set status='active',
    boost_until = case when boost_hours>0 then now() + make_interval(hours => boost_hours) end
  where id=p_id and status='pending';
end $$;

create or replace function public.redeem_promo(p_code text) returns int language plpgsql security definer set search_path=public as $$
declare pc promo_codes;
begin
  select * into pc from promo_codes where code=upper(trim(p_code)) for update;
  if not found or not pc.active then raise exception 'Code invalide'; end if;
  if pc.expires_at is not null and pc.expires_at < now() then raise exception 'Code expiré'; end if;
  if pc.max_uses is not null and pc.uses >= pc.max_uses then raise exception 'Code épuisé'; end if;
  insert into promo_redemptions(user_id,code) values(auth.uid(), pc.code);
  update promo_codes set uses=uses+1 where code=pc.code;
  update profiles set credit = credit + pc.credit where id=auth.uid();
  return pc.credit;
exception when unique_violation then
  raise exception 'Vous avez déjà utilisé un code promo';
end $$;

-- Avis
create or replace function public.submit_review(p_proof bigint, p_stars int, p_comment text) returns void language plpgsql security definer set search_path=public as $$
declare pr proofs; c campaigns; d text; t uuid;
begin
  select * into pr from proofs where id=p_proof and status='approved';
  if not found then raise exception 'Preuve non validée'; end if;
  select * into c from campaigns where id=pr.campaign_id;
  if pr.user_id = c.owner then raise exception 'forbidden'; end if;
  if auth.uid() = pr.user_id then d:='pub_to_adv'; t:=c.owner;
  elsif auth.uid() = c.owner then d:='adv_to_pub'; t:=pr.user_id;
  else raise exception 'forbidden'; end if;
  insert into reviews(proof_id,from_user,to_user,dir,stars,comment) values(p_proof, auth.uid(), t, d, p_stars, left(coalesce(p_comment,''),300));
exception when unique_violation then
  raise exception 'Déjà noté';
end $$;

create or replace function public.ratings() returns table(uid uuid, dir text, score numeric, n int) language sql security definer stable set search_path=public as $$
  select to_user, dir, round(avg(stars),1), count(*)::int from reviews group by to_user, dir $$;

create or replace function public.adv_proofs() returns table(proof_id bigint, campaign_id bigint, label text, views int, reviewed boolean) language sql security definer stable set search_path=public as $$
  select pr.id, pr.campaign_id, coalesce(nullif(p.display_name,''), '•••' || right(p.phone,3)), pr.views,
         exists(select 1 from reviews r where r.proof_id=pr.id and r.from_user=auth.uid())
  from proofs pr join campaigns c on c.id=pr.campaign_id join profiles p on p.id=pr.user_id
  where c.owner=auth.uid() and pr.status='approved' order by pr.id desc $$;

-- Rapport par campagne
create or replace function public.campaign_report(p_id bigint) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare c campaigns; r jsonb;
begin
  select * into c from campaigns where id=p_id;
  if not found or (c.owner<>auth.uid() and not is_admin()) then raise exception 'forbidden'; end if;
  select jsonb_build_object('budget',c.budget,'spent',c.spent,
    'publishers',(select count(*) from proofs where campaign_id=p_id and status='approved'),
    'pending',(select count(*) from proofs where campaign_id=p_id and status='pending'),
    'rejected',(select count(*) from proofs where campaign_id=p_id and status='rejected'),
    'avg',(select coalesce(round(avg(views),0),0) from proofs where campaign_id=p_id and status='approved'),
    'series',(select coalesce(jsonb_agg(jsonb_build_object('d',to_char(d::date,'DD/MM'),
        'views',(select coalesce(sum(views),0) from proofs where campaign_id=p_id and status='approved' and created_at::date=d::date)) order by d),'[]'::jsonb)
      from generate_series((current_date-13)::timestamp, current_date::timestamp, interval '1 day') as d)) into r;
  return r;
end $$;

-- Profil (seuls nom et avatar sont modifiables)
create or replace function public.update_profile(p_name text, p_avatar text) returns void language sql security definer set search_path=public as $$
  update profiles set display_name=left(trim(coalesce(p_name,'')),24), avatar=left(coalesce(p_avatar,''),8) where id=auth.uid() $$;

create or replace function public.leaderboard() returns table(pos int, label text, views bigint, me boolean) language sql security definer stable set search_path=public as $$
  select (row_number() over (order by sum(pr.views) desc))::int, coalesce(nullif(p.display_name,''), '•••' || right(p.phone,3)), sum(pr.views)::bigint, p.id=auth.uid()
  from proofs pr join profiles p on p.id=pr.user_id
  where pr.status='approved' and pr.created_at >= date_trunc('month', now())
  group by p.id, p.phone, p.display_name order by 3 desc limit 10 $$;

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
    'fees',(select count(*)*500 from campaigns where status<>'pending') + (select count(*)*1000 from campaigns where status<>'pending' and boost_hours>0),
    'views',(select coalesce(sum(views),0) from proofs where status='approved'),
    'paid_out',(select coalesce(sum(amount),0) from withdrawals where status='paid'),
    'pending_wd',(select coalesce(sum(amount),0) from withdrawals where status='pending'),
    'bonus_total',(select coalesce(sum(amount),0) from bonuses),
    'promo_cost',(select coalesce(sum(credit_used),0) from campaigns),
    'perks',(select coalesce(sum(bonus),0) from proofs where status='approved') + (select coalesce(sum(bonus),0) from daily_claims),
    'boosted',(select count(*) from campaigns where boost_hours>0 and status<>'pending'),
    'balances',(select coalesce(sum(views+bonus),0) from proofs where status='approved') + (select coalesce(sum(amount),0) from bonuses)
               + (select coalesce(sum(bonus),0) from daily_claims) - (select coalesce(sum(amount),0) from withdrawals),
    'series',(select coalesce(jsonb_agg(jsonb_build_object('d',to_char(d::date,'DD/MM'),
        'users',(select count(*) from profiles where created_at::date=d::date),
        'views',(select coalesce(sum(views),0) from proofs where status='approved' and created_at::date=d::date)) order by d),'[]'::jsonb)
      from generate_series((current_date-13)::timestamp, current_date::timestamp, interval '1 day') as d)
  ) into r;
  return r;
end $$;

-- Exemple : un code de bienvenue de 1 500 F pour 100 annonceurs
-- insert into promo_codes(code,credit,max_uses) values('BIENVENUE',1500,100);
