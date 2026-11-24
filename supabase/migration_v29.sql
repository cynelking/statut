-- Replace the agency team roles with owner, manager, and reader permissions.

alter table public.agency_team_members
  drop constraint if exists agency_team_members_role_check;

update public.agency_team_members
set role = case role
  when 'admin' then 'manager'
  when 'member' then 'reader'
  else role
end;

alter table public.agency_team_members
  add constraint agency_team_members_role_check check (role in ('manager', 'reader'));

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
      and role = 'manager'
      and status = 'accepted'
  )
$$;

create or replace function public.has_agency_team_manager_advertiser_access(
  p_agency_id uuid,
  p_advertiser_id bigint
) returns boolean
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
      and m.role = 'manager'
      and m.status = 'accepted'
      and a.agency_id = p_agency_id
      and a.advertiser_id = p_advertiser_id
  )
$$;

revoke all on function public.has_agency_team_manager_advertiser_access(uuid, bigint) from public, anon;
grant execute on function public.has_agency_team_manager_advertiser_access(uuid, bigint) to authenticated;

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
  if p_role is null or p_role not in ('manager', 'reader') then raise exception 'Rôle d’équipe invalide'; end if;
  select * into v_agency from public.profiles where id = p_agency_id and role = 'agency';
  if not found or not public.can_manage_agency_team(p_agency_id) then
    raise exception 'Accès réservé au propriétaire ou à un gestionnaire de l’agence';
  end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Numéro WhatsApp invalide'; end if;

  select * into v_member from public.profiles
  where phone = v_phone and role in ('user', 'agency');
  if not found then raise exception 'Aucun compte StatutPay admissible pour ce numéro'; end if;
  if v_member.id = p_agency_id then raise exception 'Le propriétaire ne peut pas être invité comme membre'; end if;
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
  if p_role is null or p_role not in ('manager', 'reader') then raise exception 'Rôle d’équipe invalide'; end if;
  select * into v_agency from public.profiles where id = p_agency_id and role = 'agency';
  if not found or not public.can_manage_agency_team(p_agency_id) then
    raise exception 'Accès réservé au propriétaire ou à un gestionnaire de l’agence';
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
  if p_role is null or p_role not in ('manager', 'reader') then raise exception 'Rôle d’équipe invalide'; end if;
  select agency_id into v_agency_id from public.agency_team_members
  where id = p_team_member_id and status in ('pending', 'accepted')
  for update;
  if not found or not public.can_manage_agency_team(v_agency_id) then
    raise exception 'Membre introuvable ou action non autorisée';
  end if;
  update public.agency_team_members set role = p_role where id = p_team_member_id;
end
$$;

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
    or public.has_agency_team_manager_advertiser_access(v_agency_id, p_agency_advertiser_id)
  ) then raise exception 'Vous n’avez pas le droit de créer une campagne pour cet annonceur'; end if;

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

notify pgrst, 'reload schema';
