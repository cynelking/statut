-- Require two WhatsApp status captures for new publisher submissions.
-- Apply after migration_v21.sql.

alter table public.proofs
  alter column image_path drop not null;

alter table public.proofs
  add column if not exists final_image_path text,
  add column if not exists posted_at timestamptz,
  add column if not exists first_submitted_at timestamptz,
  add column if not exists final_submitted_at timestamptz,
  add column if not exists rejection_reason text;

drop policy if exists pr_ins on public.proofs;

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
  if not found or c.status <> 'active' or c.spent >= c.budget then
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

create or replace function public.submit_proof_stage(
  p_proof_id bigint,
  p_stage text,
  p_image_path text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pr public.proofs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_prefix text;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_stage is null or p_stage not in ('h1', 'h23') then raise exception 'Étape de preuve invalide'; end if;
  if p_image_path is null or length(p_image_path) > 512 then raise exception 'Chemin de capture invalide'; end if;

  v_prefix := auth.uid()::text || '/' || p_proof_id::text || '-' || p_stage || '-';
  if left(p_image_path, length(v_prefix)) <> v_prefix then
    raise exception 'Cette capture ne vous appartient pas';
  end if;
  if not exists (
    select 1 from storage.objects
    where bucket_id = 'proofs' and name = p_image_path
  ) then
    raise exception 'Fichier de capture introuvable';
  end if;

  select * into pr
  from public.proofs
  where id = p_proof_id and user_id = auth.uid()
  for update;
  if not found or pr.status <> 'pending' or pr.posted_at is null then
    raise exception 'Preuve introuvable ou déjà terminée';
  end if;

  if p_stage = 'h1' then
    if v_now < pr.posted_at + interval '1 hour' or v_now >= pr.posted_at + interval '23 hours' then
      raise exception 'La capture H+1 doit être envoyée entre H+1 et H+23';
    end if;
    if pr.image_path is not null then
      if pr.image_path = p_image_path then return; end if;
      raise exception 'La capture H+1 a déjà été envoyée';
    end if;
    update public.proofs
    set image_path = p_image_path, first_submitted_at = v_now
    where id = p_proof_id;
    return;
  end if;

  if pr.image_path is null or pr.first_submitted_at is null then
    raise exception 'Envoyez d’abord la capture H+1';
  end if;
  if v_now < pr.posted_at + interval '23 hours' or v_now >= pr.posted_at + interval '24 hours' then
    raise exception 'La capture H+23 doit être envoyée entre H+23 et H+24';
  end if;
  if pr.final_image_path is not null then
    if pr.final_image_path = p_image_path then return; end if;
    raise exception 'La capture H+23 a déjà été envoyée';
  end if;
  update public.proofs
  set final_image_path = p_image_path, final_submitted_at = v_now
  where id = p_proof_id;
end
$$;

revoke all on function public.submit_proof_stage(bigint, text, text) from public, anon;
grant execute on function public.submit_proof_stage(bigint, text, text) to authenticated;

create or replace function public.expire_proofs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.proofs
  set status = 'rejected', rejection_reason = 'deadline'
  where status = 'pending'
    and posted_at is not null
    and posted_at + interval '24 hours' <= clock_timestamp()
    and final_image_path is null;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function public.expire_proofs() from public, anon;
grant execute on function public.expire_proofs() to authenticated, service_role;

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

  v := least(greatest(p_views, 0), greatest(c.budget - c.spent, 0));
  select * into lv from public.level_of(pr.user_id);
  b := floor(v * lv.pct / 100.0)::int;
  update public.proofs
  set status = 'approved', views = v, bonus = b, rejection_reason = null
  where id = p_id;
  update public.campaigns
  set spent = spent + v,
      status = case when spent + v >= budget then 'done' else status end
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

notify pgrst, 'reload schema';
