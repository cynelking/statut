-- StatutPay v7: idempotent repair for missing credit columns
alter table public.profiles add column if not exists credit int not null default 0;
alter table public.campaigns add column if not exists credit_used int not null default 0;
