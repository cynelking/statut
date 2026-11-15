-- StatutPay v11: repair profile fields referenced by the auth trigger and profile editor
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar text;

notify pgrst, 'reload schema';
