-- Add optional expiration for announcements pinned to the top of the feed.
alter table public.announcements
  add column pinned_until timestamptz;

create index announcements_pinned_until_idx
  on public.announcements (pinned_until)
  where pinned_until is not null;

notify pgrst, 'reload schema';
