-- Activate campaigns as soon as AlphaPay confirms a successful payment.
-- AlphaPay's net amount can be lower than the billed amount because of provider fees.

create or replace function public.complete_saspay_campaign_payment(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_status text,
  p_net_amount numeric,
  p_currency text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  payment public.saspay_campaign_payments%rowtype;
begin
  select * into payment
  from public.saspay_campaign_payments
  where id = p_payment_id
  for update;
  if not found then raise exception 'Paiement introuvable'; end if;

  if payment.status = 'succeeded' then return payment.status; end if;
  if payment.status = 'failed' then return payment.status; end if;
  if payment.status = 'review' and p_status <> 'SUCCESS' then return payment.status; end if;

  if p_status = 'FAILED' then
    update public.saspay_campaign_payments
    set status = 'failed', provider_transaction_id = p_provider_transaction_id,
        updated_at = now()
    where id = payment.id;
    update public.campaigns set payment_status = 'failed' where id = payment.campaign_id;
    return 'failed';
  end if;
  if p_status <> 'SUCCESS' then return payment.status; end if;

  if p_currency is distinct from payment.currency then
    update public.saspay_campaign_payments
    set status = 'review', provider_transaction_id = p_provider_transaction_id,
        updated_at = now()
    where id = payment.id;
    update public.campaigns set payment_status = 'review' where id = payment.campaign_id;
    return 'review';
  end if;

  update public.saspay_campaign_payments
  set status = 'succeeded', provider_transaction_id = p_provider_transaction_id,
      updated_at = now()
  where id = payment.id;

  update public.campaigns
  set payment_status = 'paid',
      status = case when status = 'pending' then 'active' else status end,
      boost_until = case when boost_hours > 0 and status = 'pending'
        then now() + make_interval(hours => boost_hours) else boost_until end
  where id = payment.campaign_id;
  return 'succeeded';
end
$$;

revoke all on function public.complete_saspay_campaign_payment(uuid, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.complete_saspay_campaign_payment(uuid, text, text, numeric, text)
  to service_role;

notify pgrst, 'reload schema';
