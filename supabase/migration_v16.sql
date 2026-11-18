-- StatutPay v16: idempotent push notifications for campaigns that become available.
-- Run after migration_v15.sql.

create table if not exists public.campaign_push_notifications (
  campaign_id bigint primary key references public.campaigns(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'cancelled')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text
);

alter table public.campaign_push_notifications enable row level security;
revoke all on public.campaign_push_notifications from public, anon, authenticated;
grant all on public.campaign_push_notifications to service_role;

create or replace function public.enqueue_campaign_push_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' and tg_op = 'INSERT' then
    insert into public.campaign_push_notifications(campaign_id, available_at)
    values (new.id, greatest(coalesce(new.starts_at, now()), now()))
    on conflict (campaign_id) do update
    set available_at = excluded.available_at
    where public.campaign_push_notifications.status = 'pending';
  elsif new.status = 'active' and (
    old.status is distinct from new.status
    or old.starts_at is distinct from new.starts_at
  ) then
    insert into public.campaign_push_notifications(campaign_id, available_at)
    values (new.id, greatest(coalesce(new.starts_at, now()), now()))
    on conflict (campaign_id) do update
    set available_at = excluded.available_at
    where public.campaign_push_notifications.status = 'pending';
  end if;
  return new;
end
$$;

drop trigger if exists campaigns_enqueue_push_notification on public.campaigns;
create trigger campaigns_enqueue_push_notification
after insert or update of status, starts_at on public.campaigns
for each row execute function public.enqueue_campaign_push_notification();
