-- StatutPay v8: repair campaign columns required by the current RPC
alter table public.profiles add column if not exists credit int not null default 0;
alter table public.campaigns add column if not exists country text;
alter table public.campaigns add column if not exists boost_hours int not null default 0;
alter table public.campaigns add column if not exists boost_until timestamptz;
alter table public.campaigns add column if not exists credit_used int not null default 0;
alter table public.campaigns add column if not exists starts_at timestamptz;
alter table public.campaigns add column if not exists ends_at timestamptz;
alter table public.campaigns add column if not exists media_url text;