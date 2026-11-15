-- StatutPay v4 : à exécuter APRÈS schema.sql, migration_v2.sql et migration_v3.sql

-- 1) Vérification du numéro par SMS
alter table public.profiles add column if not exists phone_verified boolean not null default false;
create table if not exists public.app_settings(key text primary key, value text not null);
insert into public.app_settings(key,value) values('require_sms','false') on conflict do nothing;
alter table public.app_settings enable row level security;
drop policy if exists as_sel on public.app_settings;
create policy as_sel on public.app_settings for select to authenticated using (true);
drop policy if exists as_admin on public.app_settings;
create policy as_admin on public.app_settings for all to authenticated using (is_admin()) with check (is_admin());

create or replace function public.needs_sms() returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((select value='true' from app_settings where key='require_sms'), false) $$;

create or replace function public.sync_phone_verified() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.phone_confirmed_at is not null and new.phone is not null then
    update public.profiles set phone_verified=true
    where id=new.id and replace(phone,'+','')=replace(new.phone,'+','');
  end if;
  return new;
end $$;
drop trigger if exists on_auth_phone_verified on auth.users;
create trigger on_auth_phone_verified after update of phone, phone_confirmed_at on auth.users
  for each row execute function public.sync_phone_verified();

-- 2) Campagnes programmées
alter table public.campaigns add column if not exists starts_at timestamptz;
alter table public.campaigns add column if not exists ends_at timestamptz;

drop policy if exists pr_ins on public.proofs;
create policy pr_ins on public.proofs for insert to authenticated with check (
  user_id=auth.uid() and status='pending' and views=0 and bonus=0
  and exists(select 1 from campaigns c join profiles p on p.id=auth.uid()
    where c.id=campaign_id and c.status='active'
      and (c.country is null or c.country=p.country)
      and (c.starts_at is null or c.starts_at<=now())
      and (c.ends_at is null or c.ends_at>now())
      and (not needs_sms() or p.phone_verified)));

drop function if exists public.create_campaign(text,text,text,int,text,boolean,boolean);
create or replace function public.create_campaign(p_title text, p_type text, p_content text, p_budget int, p_country text, p_boost boolean, p_use_credit boolean, p_starts date, p_ends date) returns bigint language plpgsql security definer set search_path=public as $$
declare total int; cr int := 0; cred int; cid bigint; st text := 'pending';
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_budget < 1000 then raise exception 'Budget minimum 1 000 F'; end if;
  if length(trim(coalesce(p_title,''))) = 0 then raise exception 'Titre requis'; end if;
  if p_ends is not null and p_ends < current_date then raise exception 'La date de fin est passée'; end if;
  if p_starts is not null and p_ends is not null and p_ends < p_starts then raise exception 'La date de fin doit être après la date de début'; end if;
  total := p_budget + 500 + case when p_boost then 1000 else 0 end;
  perform 1 from profiles where id=auth.uid() for update;
  select credit into cred from profiles where id=auth.uid();
  if p_use_credit then cr := least(cred, total); end if;
  if cr > 0 then update profiles set credit = credit - cr where id=auth.uid(); end if;
  if cr >= total then st := 'active'; end if;
  insert into campaigns(owner,title,type,content,budget,country,boost_hours,credit_used,status,boost_until,starts_at,ends_at)
  values(auth.uid(), left(trim(p_title),80), p_type, left(coalesce(p_content,''),500), p_budget, nullif(p_country,''),
         case when p_boost then 48 else 0 end, cr, st,
         case when st='active' and p_boost then now() + interval '48 hours' end,
         case when p_starts is not null then p_starts::timestamp at time zone 'UTC' end,
         case when p_ends is not null then (p_ends + 1)::timestamp at time zone 'UTC' end)
  returning id into cid;
  return cid;
end $$;

-- Clôture des campagnes expirées : le budget non dépensé revient en crédit à l'annonceur
-- (seulement quand plus aucune preuve n'est en attente sur la campagne)
create or replace function public.expire_campaigns() returns int language plpgsql security definer set search_path=public as $$
declare n int;
begin
  with e as (
    update campaigns set status='done'
    where status='active' and ends_at is not null and ends_at < now()
      and not exists(select 1 from proofs where proofs.campaign_id=campaigns.id and proofs.status='pending')
    returning owner, budget, spent)
  update profiles p set credit = p.credit + s.refund
  from (select owner, sum(budget-spent) as refund from e group by owner) s
  where p.id = s.owner;
  get diagnostics n = row_count;
  return n;
end $$;

-- 3) Parrainage à plusieurs niveaux : 100 F / 30 F / 10 F ; Ambassadeur (10 filleuls actifs) : 150 F au niveau 1
alter table public.bonuses add column if not exists level int not null default 1;
alter table public.bonuses drop constraint if exists bonuses_source_user_id_key;
alter table public.bonuses drop constraint if exists bonuses_source_level_key;
alter table public.bonuses add constraint bonuses_source_level_key unique(source_user_id, level);

create or replace function public.review_proof(p_id bigint, p_views int, p_ok boolean) returns void language plpgsql security definer set search_path=public as $$
declare pr proofs; c campaigns; v int; lv record; b int;
        cur uuid; up uuid; lvl int := 1; amt int[] := array[100,30,10]; a int;
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
    cur := pr.user_id;
    while lvl <= 3 loop
      select referred_by into up from profiles where id=cur;
      exit when up is null;
      a := amt[lvl];
      if lvl=1 and (select count(*) from bonuses where user_id=up and level=1) >= 10 then a := 150; end if;
      insert into bonuses(user_id,source_user_id,amount,level) values(up, pr.user_id, a, lvl)
        on conflict (source_user_id, level) do nothing;
      cur := up; lvl := lvl + 1;
    end loop;
    insert into daily_claims(user_id,day,bonus)
      select pr.user_id, pr.created_at::date, 50
      where (select count(*) from proofs where user_id=pr.user_id and status='approved' and created_at::date=pr.created_at::date) >= 3
      on conflict do nothing;
  end if;
end $$;

drop function if exists public.my_referral_stats();
create or replace function public.my_referral_stats() returns table(invited int, a1 int, a2 int, a3 int, bonus int, amb boolean) language sql security definer stable set search_path=public as $$
  select (select count(*) from profiles where referred_by=auth.uid())::int,
         (select count(*) from bonuses where user_id=auth.uid() and level=1)::int,
         (select count(*) from bonuses where user_id=auth.uid() and level=2)::int,
         (select count(*) from bonuses where user_id=auth.uid() and level=3)::int,
         coalesce((select sum(amount) from bonuses where user_id=auth.uid()),0)::int,
         (select count(*) from bonuses where user_id=auth.uid() and level=1) >= 10 $$;

-- 4) Retrait : numéro vérifié si l'option est activée
create or replace function public.request_withdrawal(p_amount int, p_operator text) returns void language plpgsql security definer set search_path=public as $$
begin
  perform 1 from profiles where id=auth.uid() for update;
  if needs_sms() and not (select phone_verified from profiles where id=auth.uid()) then
    raise exception 'Vérifiez votre numéro par SMS avant de retirer';
  end if;
  if p_amount<500 then raise exception 'Minimum 500 F'; end if;
  if p_amount>my_balance() then raise exception 'Solde insuffisant'; end if;
  insert into withdrawals(user_id,amount,operator) values(auth.uid(),p_amount,p_operator);
end $$;
