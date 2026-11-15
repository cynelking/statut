-- StatutPay v12: expose a private, read-only transaction history for the current user
create or replace function public.my_transactions(p_offset integer default 0)
returns table (
  transaction_id text,
  kind text,
  title text,
  amount integer,
  status text,
  occurred_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  with events as (
    select
      'proof:' || p.id::text || ':earning' as transaction_id,
      'earning'::text as kind,
      coalesce(c.title, 'Campaign #' || p.campaign_id::text) as title,
      p.views as amount,
      'approved'::text as status,
      p.created_at as occurred_at
    from public.proofs p
    left join public.campaigns c on c.id = p.campaign_id
    where p.user_id = auth.uid() and p.status = 'approved' and p.views > 0

    union all

    select
      'proof:' || p.id::text || ':level-bonus',
      'level_bonus'::text,
      coalesce(c.title, 'Campaign #' || p.campaign_id::text),
      p.bonus,
      'approved'::text,
      p.created_at
    from public.proofs p
    left join public.campaigns c on c.id = p.campaign_id
    where p.user_id = auth.uid() and p.status = 'approved' and p.bonus > 0

    union all

    select
      'proof:' || p.id::text || ':status',
      'proof_status'::text,
      coalesce(c.title, 'Campaign #' || p.campaign_id::text),
      0,
      p.status,
      p.created_at
    from public.proofs p
    left join public.campaigns c on c.id = p.campaign_id
    where p.user_id = auth.uid() and p.status in ('pending', 'rejected')

    union all

    select
      'referral:' || b.id::text,
      'referral_bonus'::text,
      b.level::text,
      b.amount,
      'credited'::text,
      b.created_at
    from public.bonuses b
    where b.user_id = auth.uid()

    union all

    select
      'daily:' || d.user_id::text || ':' || d.day::text,
      'daily_bonus'::text,
      null::text,
      d.bonus,
      'credited'::text,
      d.day::timestamptz
    from public.daily_claims d
    where d.user_id = auth.uid()

    union all

    select
      'promo:' || r.user_id::text,
      'promo_credit'::text,
      r.code,
      pc.credit,
      'credited'::text,
      r.created_at
    from public.promo_redemptions r
    join public.promo_codes pc on pc.code = r.code
    where r.user_id = auth.uid()

    union all

    select
      'campaign:' || c.id::text || ':credit-used',
      'credit_used'::text,
      c.title,
      -c.credit_used,
      'used'::text,
      c.created_at
    from public.campaigns c
    where c.owner = auth.uid() and c.credit_used > 0

    union all

    select
      'campaign:' || c.id::text || ':credit-refund',
      'credit_refund'::text,
      c.title,
      c.budget - c.spent,
      'refunded'::text,
      c.ends_at
    from public.campaigns c
    where c.owner = auth.uid()
      and c.status = 'done'
      and c.ends_at is not null
      and c.ends_at < now()
      and c.budget > c.spent

    union all

    select
      'withdrawal:' || w.id::text,
      'withdrawal'::text,
      w.operator,
      -w.amount,
      w.status,
      w.created_at
    from public.withdrawals w
    where w.user_id = auth.uid()
  )
  select
    e.transaction_id,
    e.kind,
    e.title,
    e.amount,
    e.status,
    e.occurred_at
  from events e
  order by e.occurred_at desc nulls last, e.transaction_id desc
  offset greatest(coalesce(p_offset, 0), 0)
  limit 51;
$$;

revoke all on function public.my_transactions(integer) from public, anon;
grant execute on function public.my_transactions(integer) to authenticated;

notify pgrst, 'reload schema';
