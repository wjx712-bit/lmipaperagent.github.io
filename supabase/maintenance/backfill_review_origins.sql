-- Database-owner maintenance only. Supply lmi.confirmed_review_origins as a JSON
-- array of {user_id, expected_name, topic}; keep real identities out of Git.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $backfill$
declare
  assignments jsonb := current_setting('lmi.confirmed_review_origins')::jsonb;
  changes jsonb;
begin
  if jsonb_typeof(assignments) is distinct from 'array' or jsonb_array_length(assignments) = 0 then
    raise exception 'Provide a nonempty owner-confirmed assignment array';
  end if;
  create temporary table confirmed_origins on commit drop as
    select * from jsonb_to_recordset(assignments) as a(user_id uuid, expected_name text, topic text);
  if exists (select 1 from confirmed_origins group by user_id having count(*) <> 1) then
    raise exception 'Duplicate member assignment';
  end if;
  if exists (
    select 1 from confirmed_origins a left join public.profiles p on p.id = a.user_id
    where p.id is null or p.status <> 'approved' or a.expected_name is null
      or p.display_name is distinct from a.expected_name or a.topic is null
      or a.topic not in ('Liver metabolism / MASLD', 'Adipose tissue / adipocyte biology',
        'Inflammation / immune regulation', 'Aging / senescence',
        'Single-cell / spatial / atlas', 'Cell targeting / therapy', U&'\BBF8\BD84\B958', '__general__')
  ) then raise exception 'Unknown member, name mismatch, unapproved member or invalid topic'; end if;

  -- No concurrent writer can observe or use the brief maintenance trigger state.
  lock table public.paper_reviews in access exclusive mode;
  if (select count(*) from pg_trigger where tgrelid = 'public.paper_reviews'::regclass
      and tgname in ('preserve_review_origin', 'set_paper_reviews_updated_at') and tgenabled = 'O') <> 2 then
    raise exception 'Expected review protection triggers are not enabled';
  end if;
  create temporary table origin_backfill_before on commit drop as select * from public.paper_reviews;
  alter table public.paper_reviews disable trigger preserve_review_origin;
  alter table public.paper_reviews disable trigger set_paper_reviews_updated_at;
  with updated as (
    update public.paper_reviews r set review_topic = a.topic
    from confirmed_origins a where r.user_id = a.user_id and r.review_topic is null
    returning r.user_id, r.paper_id, r.review_topic
  ) select coalesce(jsonb_agg(to_jsonb(updated) order by user_id, paper_id), '[]'::jsonb)
    into changes from updated;
  alter table public.paper_reviews enable trigger preserve_review_origin;
  alter table public.paper_reviews enable trigger set_paper_reviews_updated_at;

  if exists (
    select 1 from origin_backfill_before b full join public.paper_reviews r using (user_id, paper_id)
    left join confirmed_origins a on a.user_id = b.user_id
    where (to_jsonb(b) - 'review_topic') is distinct from (to_jsonb(r) - 'review_topic')
      or r.review_topic is distinct from coalesce(b.review_topic, a.topic)
  ) then raise exception 'Review preservation check failed'; end if;
  if jsonb_array_length(changes) > 0 then
    insert into public.review_origin_backfill_log(source, assignments, changes)
      values ('lab_owner_confirmation', assignments, changes);
  end if;
end;
$backfill$;
commit;
