-- Share only anonymous completion metadata. Private review RLS stays unchanged.
begin;

alter table public.paper_reviews add column if not exists review_topic text
  check (review_topic in (
    'Liver metabolism / MASLD', 'Adipose tissue / adipocyte biology',
    'Inflammation / immune regulation', 'Aging / senescence',
    'Single-cell / spatial / atlas', 'Cell targeting / therapy',
    U&'\BBF8\BD84\B958', '__general__'
  ));

create or replace function public.preserve_review_origin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id or new.paper_id is distinct from old.paper_id then
    raise exception 'Review identity cannot be changed';
  end if;
  -- Includes legacy NULL origins; revisiting a paper is not a second independent review.
  new.review_topic := old.review_topic;
  return new;
end;
$$;
revoke all on function public.preserve_review_origin() from public, anon, authenticated;
drop trigger if exists preserve_review_origin on public.paper_reviews;
create trigger preserve_review_origin before update on public.paper_reviews
  for each row execute function public.preserve_review_origin();

create or replace function public.review_completion(requested_paper_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  result jsonb;
begin
  if caller is null or not exists (
    select 1 from public.profiles where id = caller and status = 'approved'
  ) then
    raise exception 'Approved membership required' using errcode = '42501';
  end if;
  if requested_paper_ids is null or cardinality(requested_paper_ids) > 10000 then
    raise exception 'Request up to 10000 paper IDs' using errcode = '22023';
  end if;

  -- One JSON value avoids PostgREST's result-row cap and uses one database snapshot.
  select coalesce(jsonb_agg(to_jsonb(summary) order by summary.paper_id), '[]'::jsonb)
  into result
  from (
    select r.paper_id,
      coalesce(array_agg(distinct r.review_topic order by r.review_topic)
        filter (where r.review_topic is not null), array[]::text[]) as topics,
      coalesce(array_agg(distinct r.review_topic order by r.review_topic)
        filter (where r.user_id <> caller and r.review_topic is not null), array[]::text[]) as other_topics,
      bool_or(r.user_id <> caller and r.review_topic is null) as other_unattributed
    from public.paper_reviews r
    where r.paper_id = any(requested_paper_ids)
    group by r.paper_id
  ) summary;
  return jsonb_build_object('version', 1, 'papers', result);
end;
$$;
revoke all on function public.review_completion(text[]) from public, anon;
grant execute on function public.review_completion(text[]) to authenticated;
comment on column public.paper_reviews.review_topic is
  'Immutable first-review navigation context, not a topic-specific score. NULL means not recorded; __general__ means explicitly reviewed from the general list.';
notify pgrst, 'reload schema';
commit;
