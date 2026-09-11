-- Private provenance for owner-confirmed historical origin corrections.
begin;
create table if not exists public.review_origin_backfill_log (
  id uuid primary key default gen_random_uuid(),
  recorded_at timestamptz not null default now(),
  source text not null check (source = 'lab_owner_confirmation'),
  assignments jsonb not null check (jsonb_typeof(assignments) = 'array'),
  changes jsonb not null check (jsonb_typeof(changes) = 'array')
);
alter table public.review_origin_backfill_log enable row level security;
revoke all on public.review_origin_backfill_log from public, anon, authenticated;
grant select on public.review_origin_backfill_log to authenticated;
drop policy if exists "Admins read origin correction provenance" on public.review_origin_backfill_log;
create policy "Admins read origin correction provenance"
  on public.review_origin_backfill_log for select to authenticated
  using (public.is_lmi_admin());
comment on table public.review_origin_backfill_log is
  'Owner-confirmed historical paths, not browser-observed paths or future topic overrides. Never export to the public catalog.';
commit;
