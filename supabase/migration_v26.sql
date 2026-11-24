-- Store push ownership and schedule proof-window reminders.

create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  country text
);

alter table public.push_subscriptions
  add column if not exists user_id uuid references public.profiles(id) on delete cascade;

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant all on public.push_subscriptions to service_role;

create table if not exists public.proof_reminder_notifications (
  id bigint generated always as identity primary key,
  proof_id bigint not null references public.proofs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  stage text not null check (stage in ('h1', 'h23')),
  remind_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'cancelled')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  unique (proof_id, stage)
);

alter table public.proof_reminder_notifications enable row level security;
revoke all on public.proof_reminder_notifications from public, anon, authenticated;
grant all on public.proof_reminder_notifications to service_role;

create index if not exists proof_reminder_notifications_due_idx
  on public.proof_reminder_notifications(status, remind_at);

create or replace function public.enqueue_proof_reminders()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if new.status <> 'pending' or new.posted_at is null then
    update public.proof_reminder_notifications
    set status = 'cancelled', locked_at = null
    where proof_id = new.id and status in ('pending', 'sending');
    return new;
  end if;

  if new.image_path is null then
    if new.posted_at + interval '22 hours 45 minutes' > v_now then
      insert into public.proof_reminder_notifications(proof_id, user_id, stage, remind_at)
      values (new.id, new.user_id, 'h1', new.posted_at + interval '22 hours 45 minutes')
      on conflict (proof_id, stage) do update
      set user_id = excluded.user_id, remind_at = excluded.remind_at,
          status = 'pending', locked_at = null, last_error = null
      where public.proof_reminder_notifications.status in ('pending', 'cancelled');
    end if;
  else
    update public.proof_reminder_notifications
    set status = 'cancelled', locked_at = null
    where proof_id = new.id and stage = 'h1' and status in ('pending', 'sending');
  end if;

  if new.image_path is not null and new.final_image_path is null then
    if new.posted_at + interval '23 hours 45 minutes' > v_now then
      insert into public.proof_reminder_notifications(proof_id, user_id, stage, remind_at)
      values (new.id, new.user_id, 'h23', new.posted_at + interval '23 hours 45 minutes')
      on conflict (proof_id, stage) do update
      set user_id = excluded.user_id, remind_at = excluded.remind_at,
          status = 'pending', locked_at = null, last_error = null
      where public.proof_reminder_notifications.status in ('pending', 'cancelled');
    end if;
  else
    update public.proof_reminder_notifications
    set status = 'cancelled', locked_at = null
    where proof_id = new.id and stage = 'h23' and status in ('pending', 'sending');
  end if;

  return new;
end
$$;

drop trigger if exists proofs_enqueue_reminders on public.proofs;
create trigger proofs_enqueue_reminders
after insert or update of status, posted_at, image_path, final_image_path
on public.proofs
for each row execute function public.enqueue_proof_reminders();

insert into public.proof_reminder_notifications(proof_id, user_id, stage, remind_at)
select p.id, p.user_id, 'h1', p.posted_at + interval '22 hours 45 minutes'
from public.proofs p
where p.status = 'pending'
  and p.posted_at is not null
  and p.image_path is null
  and p.posted_at + interval '22 hours 45 minutes' > now()
on conflict (proof_id, stage) do nothing;

insert into public.proof_reminder_notifications(proof_id, user_id, stage, remind_at)
select p.id, p.user_id, 'h23', p.posted_at + interval '23 hours 45 minutes'
from public.proofs p
where p.status = 'pending'
  and p.posted_at is not null
  and p.image_path is not null
  and p.final_image_path is null
  and p.posted_at + interval '23 hours 45 minutes' > now()
on conflict (proof_id, stage) do nothing;
