-- Add agency accounts, advertiser links, and client-attributed campaigns.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('user', 'agency', 'admin'));

create or replace function public.set_agency_role_after_signup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.raw_user_meta_data ->> 'account_type' = 'agency' then
    update public.profiles set role = 'agency' where id = new.id;
  end if;
  return new;
end
$$;

revoke all on function public.set_agency_role_after_signup() from public, anon, authenticated;

drop trigger if exists zz_set_agency_role_after_profile_creation on auth.users;
create trigger zz_set_agency_role_after_profile_creation
after insert on auth.users
for each row execute function public.set_agency_role_after_signup();

create table if not exists public.agency_advertisers (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.profiles(id) on delete cascade,
  agency_name text not null,
  name text not null,
  phone text,
  linked_user_id uuid references public.profiles(id) on delete set null,
  status text not null check (status in ('managed', 'pending', 'linked', 'declined')),
  created_at timestamptz not null default now()
);

create unique index if not exists agency_advertisers_active_link_idx
  on public.agency_advertisers(agency_id, linked_user_id)
  where linked_user_id is not null and status in ('pending', 'linked');

create index if not exists agency_advertisers_invitee_idx
  on public.agency_advertisers(linked_user_id, status)
  where linked_user_id is not null;

alter table public.agency_advertisers enable row level security;
revoke all on public.agency_advertisers from public, anon, authenticated;
grant select on public.agency_advertisers to authenticated;
grant all on public.agency_advertisers to service_role;

drop policy if exists agency_advertisers_select on public.agency_advertisers;
create policy agency_advertisers_select
  on public.agency_advertisers for select to authenticated
  using (agency_id = auth.uid() or linked_user_id = auth.uid());

create or replace function public.create_agency_advertiser(p_name text, p_phone text default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agency public.profiles%rowtype;
  v_name text := left(trim(coalesce(p_name, '')), 100);
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  v_id bigint;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select * into v_agency from public.profiles where id = auth.uid();
  if not found or v_agency.role <> 'agency' then raise exception 'Accès réservé aux comptes agence'; end if;
  if v_name = '' then raise exception 'Le nom de l’annonceur est requis'; end if;
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Numéro WhatsApp invalide';
  end if;

  insert into public.agency_advertisers(agency_id, agency_name, name, phone, status)
  values (
    auth.uid(),
    coalesce(nullif(trim(v_agency.display_name), ''), v_agency.phone, 'Agence StatutPay'),
    v_name,
    v_phone,
    'managed'
  )
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function public.create_agency_advertiser(text, text) from public, anon;
grant execute on function public.create_agency_advertiser(text, text) to authenticated;

create or replace function public.invite_agency_advertiser(p_phone text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agency public.profiles%rowtype;
  v_advertiser public.profiles%rowtype;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_id bigint;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select * into v_agency from public.profiles where id = auth.uid();
  if not found or v_agency.role <> 'agency' then raise exception 'Accès réservé aux comptes agence'; end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Numéro WhatsApp invalide'; end if;

  select * into v_advertiser from public.profiles where phone = v_phone;
  if not found or v_advertiser.role <> 'user' then raise exception 'Aucun compte annonceur admissible pour ce numéro'; end if;
  if exists (
    select 1 from public.agency_advertisers
    where agency_id = auth.uid() and linked_user_id = v_advertiser.id
      and status in ('pending', 'linked')
  ) then
    raise exception 'Ce compte est déjà invité ou rattaché à votre agence';
  end if;

  update public.agency_advertisers
  set agency_name = coalesce(nullif(trim(v_agency.display_name), ''), v_agency.phone, 'Agence StatutPay'),
      name = coalesce(nullif(trim(v_advertiser.display_name), ''), v_advertiser.phone),
      phone = v_advertiser.phone,
      status = 'pending',
      created_at = now()
  where agency_id = auth.uid() and linked_user_id = v_advertiser.id and status = 'declined'
  returning id into v_id;

  if v_id is null then
    insert into public.agency_advertisers(
      agency_id, agency_name, name, phone, linked_user_id, status
    ) values (
      auth.uid(),
        coalesce(nullif(trim(v_agency.display_name), ''), v_agency.phone, 'Agence StatutPay'),
      coalesce(nullif(trim(v_advertiser.display_name), ''), v_advertiser.phone),
      v_advertiser.phone,
      v_advertiser.id,
      'pending'
    )
    returning id into v_id;
  end if;
  return v_id;
end
$$;

revoke all on function public.invite_agency_advertiser(text) from public, anon;
grant execute on function public.invite_agency_advertiser(text) to authenticated;

create or replace function public.respond_agency_invitation(p_invitation_id bigint, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_accept is null then raise exception 'Réponse d’invitation invalide'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'user') then
    raise exception 'Seul un compte annonceur peut répondre à cette invitation';
  end if;

  update public.agency_advertisers
  set status = case when p_accept then 'linked' else 'declined' end
  where id = p_invitation_id
    and linked_user_id = auth.uid()
    and status = 'pending';
  if not found then raise exception 'Invitation introuvable ou déjà traitée'; end if;
end
$$;

revoke all on function public.respond_agency_invitation(bigint, boolean) from public, anon;
grant execute on function public.respond_agency_invitation(bigint, boolean) to authenticated;

alter table public.campaigns
  add column if not exists agency_advertiser_id bigint
  references public.agency_advertisers(id) on delete set null;

create index if not exists campaigns_agency_advertiser_idx
  on public.campaigns(agency_advertiser_id, created_at desc)
  where agency_advertiser_id is not null;

create or replace function public.require_agency_campaign_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select role into v_role from public.profiles where id = new.owner;
  if v_role = 'agency' then
    if not exists (
      select 1 from public.agency_advertisers
      where id = new.agency_advertiser_id
        and agency_id = new.owner
        and status in ('managed', 'linked')
    ) then
      raise exception 'Chaque campagne agence doit être attribuée à un annonceur géré ou lié';
    end if;
    if tg_op = 'INSERT' and (
      new.status <> 'pending'
      or new.spent <> 0
      or coalesce(new.credit_used, 0) <> 0
      or coalesce(new.wallet_used, 0) <> 0
      or coalesce(new.admin_created, false)
      or new.payment_provider is not null
      or new.payment_status is not null
      or new.boost_hours not in (0, 24, 48, 168)
      or length(trim(coalesce(new.title, ''))) = 0
      or length(coalesce(new.title, '')) > 80
      or length(coalesce(new.content, '')) > 500
      or (new.type in ('img', 'vid') and new.media_url is null)
      or (new.type = 'txt' and new.media_url is not null)
      or (new.media_url is not null and (
        length(new.media_url) > 2048 or lower(left(new.media_url, 8)) <> 'https://'
      ))
      or (new.starts_at is not null and new.ends_at is not null and new.ends_at < new.starts_at)
    ) then
      raise exception 'Une campagne agence doit être en attente et payée séparément par AlphaPay';
    end if;
  elsif new.agency_advertiser_id is not null then
    raise exception 'Seuls les comptes agence peuvent attribuer une campagne à un annonceur';
  end if;
  return new;
end
$$;

revoke all on function public.require_agency_campaign_client() from public, anon, authenticated;

drop trigger if exists campaigns_require_agency_client on public.campaigns;
create trigger campaigns_require_agency_client
before insert or update of owner, agency_advertiser_id on public.campaigns
for each row execute function public.require_agency_campaign_client();

drop policy if exists pr_ins on public.proofs;
create policy pr_ins on public.proofs
for insert to authenticated
with check (
  user_id = auth.uid()
  and status = 'pending'
  and image_path is null
  and final_image_path is null
  and first_submitted_at is null
  and final_submitted_at is null
  and rejection_reason is null
  and views = 0
  and base_reward = 0
  and bonus = 0
  and posted_at between now() - interval '1 minute' and now() + interval '1 minute'
  and exists (
    select 1
    from public.campaigns c
    join public.profiles p on p.id = auth.uid()
    where c.id = campaign_id
      and c.owner <> auth.uid()
      and c.status = 'active'
      and c.budget - c.spent >= 3
      and (c.country is null or c.country is not distinct from p.country)
      and (c.starts_at is null or c.starts_at <= now())
      and (c.ends_at is null or c.ends_at > now())
      and not exists (
        select 1
        from public.agency_advertisers aa
        where aa.id = c.agency_advertiser_id
          and aa.linked_user_id = auth.uid()
          and aa.status = 'linked'
      )
  )
);

create or replace function public.create_agency_campaign(
  p_title text,
  p_type text,
  p_content text,
  p_media_url text,
  p_budget int,
  p_country text,
  p_boost_hours int,
  p_starts date,
  p_ends date,
  p_agency_advertiser_id bigint
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  cid bigint;
  media text := nullif(trim(p_media_url), '');
  agency_role text;
  advertiser_status text;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select role into agency_role from public.profiles where id = auth.uid() for update;
  if agency_role is distinct from 'agency' then raise exception 'Accès réservé aux comptes agence'; end if;
  if p_agency_advertiser_id is null then raise exception 'Sélectionnez un annonceur'; end if;

  select status into advertiser_status
  from public.agency_advertisers
  where id = p_agency_advertiser_id and agency_id = auth.uid()
  for update;
  if not found or advertiser_status not in ('managed', 'linked') then
    raise exception 'Annonceur introuvable ou invitation non acceptée';
  end if;

  if p_budget < 1000 then raise exception 'Budget minimum 1 000 F'; end if;
  if p_boost_hours is null or p_boost_hours not in (0, 24, 48, 168) then
    raise exception 'Durée du boost invalide';
  end if;
  if length(trim(coalesce(p_title, ''))) = 0 then raise exception 'Titre requis'; end if;
  if p_type not in ('img', 'vid', 'txt') then raise exception 'Format invalide'; end if;
  if p_type in ('img', 'vid') and media is null then raise exception 'Ajoutez un visuel'; end if;
  if p_type = 'txt' and media is not null then raise exception 'Un visuel ne peut pas être associé à une annonce texte'; end if;
  if media is not null and (length(media) > 2048 or lower(left(media, 8)) <> 'https://') then
    raise exception 'Lien multimédia invalide';
  end if;
  if p_ends is not null and p_ends < current_date then raise exception 'La date de fin est passée'; end if;
  if p_starts is not null and p_ends is not null and p_ends < p_starts then
    raise exception 'La date de fin doit être après la date de début';
  end if;

  insert into public.campaigns(
    owner, agency_advertiser_id, title, type, content, media_url, budget, country, boost_hours,
    credit_used, wallet_used, status, payment_provider, payment_status, starts_at, ends_at, admin_created
  ) values (
    auth.uid(), p_agency_advertiser_id, left(trim(p_title), 80), p_type,
    left(coalesce(p_content, ''), 500), media, p_budget, nullif(p_country, ''), p_boost_hours,
    0, 0, 'pending', null, null,
    case when p_starts is not null then p_starts::timestamp at time zone 'UTC' end,
    case when p_ends is not null then (p_ends + 1)::timestamp at time zone 'UTC' end,
    false
  )
  returning id into cid;
  return cid;
end
$$;

revoke all on function public.create_agency_campaign(text, text, text, text, int, text, int, date, date, bigint)
  from public, anon;
grant execute on function public.create_agency_campaign(text, text, text, text, int, text, int, date, date, bigint)
  to authenticated;

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
  if c.agency_advertiser_id is not null and exists (
    select 1 from public.agency_advertisers
    where id = c.agency_advertiser_id and linked_user_id = auth.uid() and status = 'linked'
  ) then
    raise exception 'Vous ne pouvez pas diffuser une campagne de votre annonceur';
  end if;
  if c.starts_at is not null and c.starts_at > now() then raise exception 'Cette campagne n’a pas encore commencé'; end if;
  if c.ends_at is not null and c.ends_at <= now() then raise exception 'Cette campagne est terminée'; end if;

  select country into v_country from public.profiles where id = auth.uid();
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

notify pgrst, 'reload schema';
