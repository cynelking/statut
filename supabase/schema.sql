-- StatutPay : à coller dans Supabase > SQL Editor > Run
create table public.profiles(
  id uuid primary key references auth.users on delete cascade,
  phone text unique not null, country text,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz default now());
create table public.campaigns(
  id bigint generated always as identity primary key,
  owner uuid not null references public.profiles(id),
  title text not null, type text not null check (type in ('img','vid','txt')),
  content text, budget int not null check (budget>=1000),
  spent int not null default 0,
  status text not null default 'pending' check (status in ('pending','active','done')),
  created_at timestamptz default now());
create table public.proofs(
  id bigint generated always as identity primary key,
  campaign_id bigint not null references public.campaigns(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  image_path text not null, views int not null default 0,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz default now(), unique(campaign_id,user_id));
create table public.withdrawals(
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id),
  amount int not null check (amount>=500), operator text not null,
  status text not null default 'pending' check (status in ('pending','paid')),
  created_at timestamptz default now());

create or replace function public.is_admin() returns boolean language sql security definer stable set search_path=public as
$$ select exists(select 1 from profiles where id=auth.uid() and role='admin') $$;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as
$$ begin insert into profiles(id,phone,country) values(new.id,new.raw_user_meta_data->>'phone',new.raw_user_meta_data->>'country'); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table profiles enable row level security;
alter table campaigns enable row level security;
alter table proofs enable row level security;
alter table withdrawals enable row level security;

create policy p_sel on profiles for select to authenticated using (id=auth.uid() or is_admin());
create policy c_sel on campaigns for select to authenticated using (status in ('active','done') or owner=auth.uid() or is_admin());
create policy c_ins on campaigns for insert to authenticated with check (owner=auth.uid() and status='pending' and spent=0);
create policy c_upd on campaigns for update to authenticated using (is_admin());
create policy pr_sel on proofs for select to authenticated using (user_id=auth.uid() or is_admin());
create policy pr_ins on proofs for insert to authenticated with check (user_id=auth.uid() and status='pending' and views=0
  and exists(select 1 from campaigns c where c.id=campaign_id and c.status='active'));
create policy w_sel on withdrawals for select to authenticated using (user_id=auth.uid() or is_admin());
create policy w_upd on withdrawals for update to authenticated using (is_admin());

create or replace function public.my_balance() returns int language sql security definer stable set search_path=public as
$$ select coalesce((select sum(views) from proofs where user_id=auth.uid() and status='approved'),0)
        - coalesce((select sum(amount) from withdrawals where user_id=auth.uid()),0) $$;

create or replace function public.request_withdrawal(p_amount int, p_operator text) returns void language plpgsql security definer set search_path=public as $$
begin
  perform 1 from profiles where id=auth.uid() for update;
  if p_amount<500 then raise exception 'Minimum 500 F'; end if;
  if p_amount>my_balance() then raise exception 'Solde insuffisant'; end if;
  insert into withdrawals(user_id,amount,operator) values(auth.uid(),p_amount,p_operator);
end $$;

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
end $$;

-- Stockage privé des captures d’écran
insert into storage.buckets(id,name,public) values('proofs','proofs',false) on conflict do nothing;
create policy s_ins on storage.objects for insert to authenticated with check (bucket_id='proofs' and (storage.foldername(name))[1]=auth.uid()::text);
create policy s_sel on storage.objects for select to authenticated using (bucket_id='proofs' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));

-- APRÈS que l’admin a créé son compte dans l’app (numéro +22896292039), exécutez :
-- update public.profiles set role='admin' where phone='+22896292039';
