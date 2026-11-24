-- Add private support conversations for users and administrators.

create table if not exists public.support_tickets (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  subject text not null check (length(btrim(subject)) between 4 and 120),
  status text not null default 'open' check (status in ('open', 'answered', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_tickets_user_updated_idx
  on public.support_tickets(user_id, updated_at desc);
create index if not exists support_tickets_status_updated_idx
  on public.support_tickets(status, updated_at desc);

create table if not exists public.support_ticket_messages (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.support_tickets(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  sender_is_admin boolean not null default false,
  message text not null check (length(btrim(message)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists support_ticket_messages_ticket_created_idx
  on public.support_ticket_messages(ticket_id, created_at, id);

alter table public.support_tickets enable row level security;
alter table public.support_ticket_messages enable row level security;
revoke all on public.support_tickets from public, anon, authenticated;
revoke all on public.support_ticket_messages from public, anon, authenticated;
grant select on public.support_tickets to authenticated;
grant select on public.support_ticket_messages to authenticated;
grant all on public.support_tickets to service_role;
grant all on public.support_ticket_messages to service_role;

drop policy if exists support_tickets_select on public.support_tickets;
create policy support_tickets_select
on public.support_tickets
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists support_ticket_messages_select on public.support_ticket_messages;
create policy support_ticket_messages_select
on public.support_ticket_messages
for select to authenticated
using (
  exists (
    select 1
    from public.support_tickets t
    where t.id = ticket_id
      and (t.user_id = auth.uid() or public.is_admin())
  )
);

create or replace function public.create_support_ticket(p_subject text, p_message text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket_id bigint;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_subject is null or length(btrim(p_subject)) not between 4 and 120 then
    raise exception 'Le sujet doit contenir entre 4 et 120 caractères';
  end if;
  if p_message is null or length(btrim(p_message)) not between 1 and 4000 then
    raise exception 'Le message doit contenir entre 1 et 4 000 caractères';
  end if;

  insert into public.support_tickets(user_id, subject)
  values (auth.uid(), btrim(p_subject))
  returning id into v_ticket_id;

  insert into public.support_ticket_messages(ticket_id, sender_id, sender_is_admin, message)
  values (v_ticket_id, auth.uid(), public.is_admin(), btrim(p_message));

  return v_ticket_id;
end
$$;

create or replace function public.reply_support_ticket(p_ticket_id bigint, p_message text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.support_tickets%rowtype;
  v_is_admin boolean;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if p_message is null or length(btrim(p_message)) not between 1 and 4000 then
    raise exception 'Le message doit contenir entre 1 et 4 000 caractères';
  end if;

  v_is_admin := public.is_admin();
  select * into v_ticket
  from public.support_tickets
  where id = p_ticket_id
  for update;
  if not found then raise exception 'Ticket introuvable'; end if;
  if v_ticket.user_id <> auth.uid() and not v_is_admin then raise exception 'forbidden'; end if;
  if v_ticket.status = 'closed' then raise exception 'Ce ticket est fermé'; end if;

  insert into public.support_ticket_messages(ticket_id, sender_id, sender_is_admin, message)
  values (v_ticket.id, auth.uid(), v_is_admin, btrim(p_message));

  update public.support_tickets
  set status = case when v_is_admin then 'answered' else 'open' end,
      updated_at = now()
  where id = v_ticket.id;
end
$$;

create or replace function public.set_support_ticket_status(p_ticket_id bigint, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'forbidden'; end if;
  if p_status is null or p_status not in ('open', 'answered', 'closed') then
    raise exception 'Statut de ticket invalide';
  end if;

  update public.support_tickets
  set status = p_status, updated_at = now()
  where id = p_ticket_id;
  if not found then raise exception 'Ticket introuvable'; end if;
end
$$;

revoke all on function public.create_support_ticket(text, text) from public, anon;
revoke all on function public.reply_support_ticket(bigint, text) from public, anon;
revoke all on function public.set_support_ticket_status(bigint, text) from public, anon;
grant execute on function public.create_support_ticket(text, text) to authenticated;
grant execute on function public.reply_support_ticket(bigint, text) to authenticated;
grant execute on function public.set_support_ticket_status(bigint, text) to authenticated;

notify pgrst, 'reload schema';
