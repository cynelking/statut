-- StatutPay v17: lower the minimum withdrawal amount to 200 F.
-- Run after migration_v16.sql.

create or replace function public.request_withdrawal(
  p_amount integer,
  p_operator text,
  p_country text,
  p_network text,
  p_phone text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  withdrawal_id bigint;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  perform 1 from public.profiles where id = auth.uid() for update;
  if needs_sms() and not (select phone_verified from public.profiles where id = auth.uid()) then
    raise exception 'Vérifiez votre numéro par SMS avant de retirer';
  end if;
  if p_amount < 200 then raise exception 'Minimum 200 F'; end if;
  if p_amount > my_balance() then raise exception 'Solde insuffisant'; end if;
  if p_country is null or p_network is null or p_phone is null
     or p_country !~ '^[A-Z]{2}$' or p_network !~ '^[a-z0-9_]{2,40}$'
     or p_phone !~ '^[+0-9][0-9 +()-]{5,24}$' then
    raise exception 'Coordonnées Mobile Money invalides';
  end if;
  insert into public.withdrawals(
    user_id, amount, operator, recipient_country, recipient_network, recipient_phone
  ) values (
    auth.uid(), p_amount, left(p_operator, 80), p_country, p_network, p_phone
  ) returning id into withdrawal_id;
  return withdrawal_id;
end
$$;

revoke all on function public.request_withdrawal(integer, text, text, text, text) from public, anon;
grant execute on function public.request_withdrawal(integer, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
