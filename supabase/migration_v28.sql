-- Add agency team memberships, advertiser assignments, and team invitations.

create table if not exists public.agency_team_members (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.profiles(id) on delete cascade,
  agency_name text not null,
  user_id uuid references public.profiles(id) on delete set null,
  member_name text,
  member_phone text,
  role text not null check (role in ('admin', 'member')),
  status text not null check (status in ('pending', 'accepted', 'declined', 'revoked')),
  invite_token uuid unique,
  invited_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz
);

create unique index if not exists agency_team_members_active_user_idx
  on public.agency_team_members(agency_id, user_id)
  where user_id is not null and status in ('pending', 'accepted');

create index if not exists agency_team_members_user_status_idx
  on public.agency_team_members(user_id, status)
  where user_id is not null;

create table if not exists public.agency_team_advertiser_access (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.profiles(id) on delete cascade,
  team_member_id bigint not null references public.agency_team_members(id) on delete cascade,
  advertiser_id bigint not null references public.agency_advertisers(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (team_member_id, advertiser_id)
);

create index if not exists agency_team_access_advertiser_idx
  on public.agency_team_advertiser_access(agency_id, advertiser_id);

alter table public.agency_team_members enable row level security;
alter table public.agency_team_advertiser_access enable row level security;
revoke all on public.agency_team_members from public, anon, authenticated;
revoke all on public.agency_team_advertiser_access from public, anon, authenticated;
grant select on public.agency_team_members to authenticated;
grant select on public.agency_team_advertiser_access to authenticated;
grant all on public.agency_team_members to service_role;
grant all on public.agency_team_advertiser_access to service_role;

create or replace function public.is_agency_team_admin(p_agency_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.agency_team_members
    where agency_id = p_agency_id
      and user_id = auth.uid()
      and role = 'admin'
      and status = 'accepted'
  )
$$;

create or replace function public.has_agency_advertiser_access(p_agency_id uuid, p_advertiser_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.agency_team_members m
    join public.agency_team_advertiser_access a on a.team_member_id = m.id
    where m.agency_id = p_agency_id
      and m.user_id = auth.uid()
      and m.status = 'accepted'
      and a.agency_id = p_agency_id
      and a.advertiser_id = p_advertiser_id
  )
$$;

create or replace function public.can_manage_agency_team(p_agency_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_agency_id = auth.uid() or public.is_agency_team_admin(p_agency_id)
$$;

revoke all on function public.is_agency_team_admin(uuid) from public, anon;
revoke all on function public.has_agency_advertiser_access(uuid, bigint) from public, anon;
revoke all on function public.can_manage_agency_team(uuid) from public, anon;
grant execute on function public.is_agency_team_admin(uuid) to authenticated;
grant execute on function public.has_agency_advertiser_access(uuid, bigint) to authenticated;
grant execute on function public.can_manage_agency_team(uuid) to authenticated;

drop policy if exists agency_team_members_select on public.agency_team_members;
create policy agency_team_members_select on public.agency_team_members
for select to authenticated
using (
  agency_id = auth.uid()
  or user_id = auth.uid()
  or public.is_agency_team_admin(agency_id)
);

drop policy if exists agency_team_access_select on public.agency_team_advertiser_access;
create policy agency_team_access_select on public.agency_team_advertiser_access
for select to authenticated
using (
  agency_id = auth.uid()
  or public.has_agency_advertiser_access(agency_id, advertiser_id)
);

drop policy if exists agency_advertisers_select on public.agency_advertisers;
create policy agency_advertisers_select on public.agency_advertisers
for select to authenticated
using (
  agency_id = auth.uid()
  or linked_user_id = auth.uid()
  or public.has_agency_advertiser_access(agency_id, id)
);

drop policy if exists c_sel on public.campaigns;
create policy c_sel on public.campaigns
for select to authenticated
using (
  status in ('active', 'done')
  or owner = auth.uid()
  or public.is_admin()
  or (agency_advertiser_id is not null and public.has_agency_advertiser_access(owner, agency_advertiser_id))
);

create or replace function public.invite_agency_team_member_by_phone(p_agency_id uuid, p_phone text, p_role text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agency public.profiles%rowtype;
  v_member public.profiles%rowtype;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_id bigint;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_role not in ('admin', 'member') then raise exception 'Rôle d’équipe invalide'; end if;
  select * into v_agency from public.profiles where id = p_agency_id and role = 'agency';
  if not found or not public.can_manage_agency_team(p_agency_id) then
    raise exception 'Accès réservé au propriétaire ou à un admin de l’agence';
  end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Numéro WhatsApp invalide'; end if;

  select * into v_member from public.profiles
  where phone = v_phone and role in ('user', 'agency');
  if not found then raise exception 'Aucun compte StatutPay admissible pour ce numéro'; end if;
  if v_member.id = auth.uid() then raise exception 'Le propriétaire ne peut pas être invité comme membre'; end if;
  if exists (
    select 1 from public.agency_team_members
    where agency_id = p_agency_id and user_id = v_member.id
      and status in ('pending', 'accepted') and expires_at > now()
  ) then raise exception 'Ce compte est déjà invité ou membre de l’équipe'; end if;

  update public.agency_team_members
  set agency_name = coalesce(nullif(trim(v_agency.display_name), ''), v_agency.phone, 'Agence StatutPay'),
      member_name = coalesce(nullif(trim(v_member.display_name), ''), v_member.phone),
      member_phone = v_member.phone,
      role = p_role,
      status = 'pending',
      invited_by = auth.uid(),
      invite_token = null,
      created_at = now(),
      expires_at = now() + interval '7 days',
      accepted_at = null
  where agency_id = p_agency_id and user_id = v_member.id
    and (status in ('declined', 'revoked') or (status = 'pending' and expires_at <= now()))
  returning id into v_id;

  if v_id is null then
    insert into public.agency_team_members(
      agency_id, agency_name, user_id, member_name, member_phone, role, status, invited_by
    ) values (
      p_agency_id,
      coalesce(nullif(trim(v_agency.display_name), ''), v_agency.phone, 'Agence StatutPay'),
      v_member.id,
      coalesce(nullif(trim(v_member.display_name), ''), v_member.phone),
      v_member.phone,
      p_role,
      'pending',
      auth.uid()
    )
    returning id into v_id;
  end if;
  return v_id;
end
$$;

revoke all on function public.invite_agency_team_member_by_phone(uuid, text, text) from public, anon;
grant execute on function public.invite_agency_team_member_by_phone(uuid, text, text) to authenticated;

create or replace function public.create_agency_team_invite_link(p_agency_id uuid, p_role text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agency public.profiles%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_role not in ('admin', 'member') then raise exception 'Rôle d’équipe invalide'; end if;
  select * into v_agency from public.profiles where id = p_agency_id and role = 'agency';
  if not found or not public.can_manage_agency_team(p_agency_id) then
    raise exception 'Accès réservé au propriétaire ou à un admin de l’agence';
  end if;

  insert into public.agency_team_members(
    agency_id, agency_name, role, status, invite_token, invited_by
  ) values (
    p_agency_id,
    coalesce(nullif(trim(v_agency.display_name), ''), v_agency.phone, 'Agence StatutPay'),
    p_role,
    'pending',
    v_token,
    auth.uid()
  );
  return v_token;
end
$$;

revoke all on function public.create_agency_team_invite_link(uuid, text) from public, anon;
grant execute on function public.create_agency_team_invite_link(uuid, text) to authenticated;

create or replace function public.respond_agency_team_invitation(p_invitation_id bigint, p_accept boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agency_id uuid;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_accept is null then raise exception 'Réponse d’invitation invalide'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('user', 'agency')) then
    raise exception 'Ce compte ne peut pas rejoindre une équipe';
  end if;

  update public.agency_team_members
  set status = case when p_accept then 'accepted' else 'declined' end,
      accepted_at = case when p_accept then now() else null end
  where id = p_invitation_id
    and user_id = auth.uid()
    and status = 'pending'
    and expires_at > now()
  returning agency_id into v_agency_id;
  if not found then raise exception 'Invitation introuvable ou expirée'; end if;
  return v_agency_id;
end
$$;

revoke all on function public.respond_agency_team_invitation(bigint, boolean) from public, anon;
grant execute on function public.respond_agency_team_invitation(bigint, boolean) to authenticated;

create or replace function public.accept_agency_team_invitation_by_token(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation public.agency_team_members%rowtype;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('user', 'agency')) then
    raise exception 'Ce compte ne peut pas rejoindre une équipe';
  end if;

  select * into v_invitation
  from public.agency_team_members
  where invite_token = p_token and status = 'pending' and expires_at > now()
  for update;
  if not found then raise exception 'Lien d’invitation introuvable ou expiré'; end if;
  if v_invitation.agency_id = auth.uid() then raise exception 'Vous ne pouvez pas rejoindre votre propre agence'; end if;
  update public.agency_team_members
  set status = 'revoked', invite_token = null, expires_at = now()
  where agency_id = v_invitation.agency_id and user_id = auth.uid()
    and status = 'pending' and expires_at <= now();
  if exists (
    select 1 from public.agency_team_members
    where agency_id = v_invitation.agency_id and user_id = auth.uid()
      and status in ('pending', 'accepted') and expires_at > now()
  ) then raise exception 'Ce compte est déjà invité ou membre de cette équipe'; end if;

  update public.agency_team_members
  set user_id = auth.uid(),
      member_name = coalesce(nullif(trim((select display_name from public.profiles where id = auth.uid())), ''),
        (select phone from public.profiles where id = auth.uid())),
      member_phone = (select phone from public.profiles where id = auth.uid()),
      invite_token = null,
      status = 'accepted',
      accepted_at = now()
  where id = v_invitation.id;
  return v_invitation.agency_id;
end
$$;

revoke all on function public.accept_agency_team_invitation_by_token(uuid) from public, anon;
grant execute on function public.accept_agency_team_invitation_by_token(uuid) to authenticated;

create or replace function public.remove_agency_team_member(p_team_member_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agency_id uuid;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select agency_id into v_agency_id
  from public.agency_team_members
  where id = p_team_member_id and status in ('pending', 'accepted')
  for update;
  if not found or not public.can_manage_agency_team(v_agency_id) then
    raise exception 'Membre introuvable ou action non autorisée';
  end if;

  update public.agency_team_members
  set status = 'revoked', invite_token = null, expires_at = now()
  where id = p_team_member_id;
  delete from public.agency_team_advertiser_access where team_member_id = p_team_member_id;
end
$$;

revoke all on function public.remove_agency_team_member(bigint) from public, anon;
grant execute on function public.remove_agency_team_member(bigint) to authenticated;

create or replace function public.set_agency_team_member_role(p_team_member_id bigint, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agency_id uuid;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_role not in ('admin', 'member') then raise exception 'Rôle d’équipe invalide'; end if;
  select agency_id into v_agency_id from public.agency_team_members
  where id = p_team_member_id and status in ('pending', 'accepted')
  for update;
  if not found or not public.can_manage_agency_team(v_agency_id) then
    raise exception 'Membre introuvable ou action non autorisée';
  end if;
  update public.agency_team_members set role = p_role where id = p_team_member_id;
end
$$;

revoke all on function public.set_agency_team_member_role(bigint, text) from public, anon;
grant execute on function public.set_agency_team_member_role(bigint, text) to authenticated;

create or replace function public.set_agency_team_member_advertisers(
  p_team_member_id bigint,
  p_advertiser_ids bigint[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[] := coalesce(p_advertiser_ids, array[]::bigint[]);
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'agency') then
    raise exception 'Seul le propriétaire de l’agence peut attribuer des annonceurs';
  end if;
  if not exists (
    select 1 from public.agency_team_members
    where id = p_team_member_id and agency_id = auth.uid() and status = 'accepted'
  ) then raise exception 'Membre introuvable ou invitation non acceptée'; end if;
  if exists (
    select requested.id
    from unnest(v_ids) as requested(id)
    except
    select id from public.agency_advertisers
    where agency_id = auth.uid() and status in ('managed', 'linked')
  ) then raise exception 'Un ou plusieurs annonceurs ne sont pas gérés par cette agence'; end if;

  delete from public.agency_team_advertiser_access where team_member_id = p_team_member_id;
  insert into public.agency_team_advertiser_access(agency_id, team_member_id, advertiser_id)
  select auth.uid(), p_team_member_id, requested.id
  from (select distinct id from unnest(v_ids) as values_list(id)) requested;
end
$$;

revoke all on function public.set_agency_team_member_advertisers(bigint, bigint[]) from public, anon;
grant execute on function public.set_agency_team_member_advertisers(bigint, bigint[]) to authenticated;

alter table public.campaigns
  add column if not exists created_by uuid references public.profiles(id) on delete set null;

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
  v_agency_id uuid;
  v_client_status text;
  v_profile_role text;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select status, agency_id into v_client_status, v_agency_id
  from public.agency_advertisers
  where id = p_agency_advertiser_id
  for update;
  if not found or v_client_status not in ('managed', 'linked') then
    raise exception 'Annonceur introuvable ou invitation non acceptée';
  end if;

  select role into v_profile_role from public.profiles where id = auth.uid();
  if not (
    (auth.uid() = v_agency_id and v_profile_role = 'agency')
    or public.has_agency_advertiser_access(v_agency_id, p_agency_advertiser_id)
  ) then raise exception 'Vous n’avez pas accès à cet annonceur'; end if;

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
    owner, created_by, agency_advertiser_id, title, type, content, media_url, budget, country, boost_hours,
    credit_used, wallet_used, status, payment_provider, payment_status, starts_at, ends_at, admin_created
  ) values (
    v_agency_id, auth.uid(), p_agency_advertiser_id, left(trim(p_title), 80), p_type,
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

create or replace function public.agency_team_campaign_report(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c public.campaigns%rowtype;
  result jsonb;
begin
  select * into c from public.campaigns where id = p_id;
  if not found or c.agency_advertiser_id is null
      or not public.has_agency_advertiser_access(c.owner, c.agency_advertiser_id) then
    raise exception 'Campagne introuvable ou accès refusé';
  end if;

  select jsonb_build_object(
    'budget', c.budget,
    'spent', c.spent,
    'publishers', (select count(distinct user_id) from public.proofs where campaign_id = c.id and status = 'approved'),
    'pending', (select count(*) from public.proofs where campaign_id = c.id and status = 'pending'),
    'rejected', (select count(*) from public.proofs where campaign_id = c.id and status = 'rejected'),
    'avg', (select coalesce(avg(views), 0)::integer from public.proofs where campaign_id = c.id and status = 'approved'),
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object('d', d, 'views', views) order by day), '[]'::jsonb)
      from (
        select date_trunc('day', created_at) as day,
          to_char(date_trunc('day', created_at), 'DD/MM') as d,
          sum(views)::integer as views
        from public.proofs
        where campaign_id = c.id and status = 'approved'
        group by date_trunc('day', created_at)
      ) daily_views
    )
  ) into result;
  return result;
end
$$;

revoke all on function public.agency_team_campaign_report(bigint) from public, anon;
grant execute on function public.agency_team_campaign_report(bigint) to authenticated;

notify pgrst, 'reload schema';
