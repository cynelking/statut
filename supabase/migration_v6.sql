-- StatutPay v6 : médias pour les campagnes (à exécuter après migration_v5.sql)
alter table public.campaigns add column if not exists media_url text;

-- Reprend les anciens liens d'image/vidéo enregistrés dans content.
update public.campaigns
set media_url = content, content = null
where type in ('img', 'vid')
  and media_url is null
  and content ~* '^https?://[^[:space:]]+$';

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'campaign-media',
  'campaign-media',
  true,
  20971520,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']
)
on conflict (id) do nothing;

drop policy if exists campaign_media_ins on storage.objects;
create policy campaign_media_ins on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'campaign-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists campaign_media_del on storage.objects;
create policy campaign_media_del on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'campaign-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop function if exists public.create_campaign(text, text, text, int, text, boolean, boolean, date, date);
create or replace function public.create_campaign(
  p_title text,
  p_type text,
  p_content text,
  p_media_url text,
  p_budget int,
  p_country text,
  p_boost boolean,
  p_use_credit boolean,
  p_starts date,
  p_ends date
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  total int;
  cr int := 0;
  cred int;
  cid bigint;
  st text := 'pending';
  media text := nullif(trim(p_media_url), '');
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_budget < 1000 then raise exception 'Budget minimum 1 000 F'; end if;
  if length(trim(coalesce(p_title, ''))) = 0 then raise exception 'Titre requis'; end if;
  if p_type not in ('img', 'vid', 'txt') then raise exception 'Format invalide'; end if;
  if p_type in ('img', 'vid') and media is null then raise exception 'Ajoutez un visuel'; end if;
  if p_type = 'txt' and media is not null then raise exception 'Un visuel ne peut pas être associé à une annonce texte'; end if;
  if media is not null and (
    length(media) > 2048
    or lower(left(media, 8)) <> 'https://'
  ) then raise exception 'Lien multimédia invalide'; end if;
  if p_ends is not null and p_ends < current_date then raise exception 'La date de fin est passée'; end if;
  if p_starts is not null and p_ends is not null and p_ends < p_starts then raise exception 'La date de fin doit être après la date de début'; end if;

  total := p_budget + 500 + case when p_boost then 1000 else 0 end;
  perform 1 from profiles where id = auth.uid() for update;
  select credit into cred from profiles where id = auth.uid();
  if p_use_credit then cr := least(cred, total); end if;
  if cr > 0 then update profiles set credit = credit - cr where id = auth.uid(); end if;
  if cr >= total then st := 'active'; end if;

  insert into campaigns(owner, title, type, content, media_url, budget, country, boost_hours, credit_used, status, boost_until, starts_at, ends_at)
  values (
    auth.uid(),
    left(trim(p_title), 80),
    p_type,
    left(coalesce(p_content, ''), 500),
    media,
    p_budget,
    nullif(p_country, ''),
    case when p_boost then 48 else 0 end,
    cr,
    st,
    case when st = 'active' and p_boost then now() + interval '48 hours' end,
    case when p_starts is not null then p_starts::timestamp at time zone 'UTC' end,
    case when p_ends is not null then (p_ends + 1)::timestamp at time zone 'UTC' end
  )
  returning id into cid;
  return cid;
end
$$;
