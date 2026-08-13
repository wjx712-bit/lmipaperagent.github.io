-- LMI Paper Agent authentication, approval, and private review storage.
-- The first administrator is bootstrapped from the verified Google email below.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  avatar_url text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'blocked')),
  role text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.paper_reviews (
  user_id uuid not null references public.profiles(id) on delete cascade,
  paper_id text not null,
  doi text,
  score smallint not null check (score between 1 and 5),
  note text not null default '' check (char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, paper_id)
);

create index if not exists paper_reviews_paper_id_idx on public.paper_reviews(paper_id);
create index if not exists paper_reviews_updated_at_idx on public.paper_reviews(updated_at desc);
create index if not exists profiles_status_idx on public.profiles(status);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  is_bootstrap_admin boolean := lower(coalesce(new.email, '')) = 'wjx712@gmail.com';
begin
  insert into public.profiles as existing_profile (
    id,
    email,
    display_name,
    avatar_url,
    status,
    role,
    approved_at
  ) values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    case when is_bootstrap_admin then 'approved' else 'pending' end,
    case when is_bootstrap_admin then 'admin' else 'member' end,
    case when is_bootstrap_admin then now() else null end
  )
  on conflict (id) do update set
    email = excluded.email,
    display_name = coalesce(excluded.display_name, existing_profile.display_name),
    avatar_url = coalesce(excluded.avatar_url, existing_profile.avatar_url);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute procedure public.handle_new_user();

-- Backfill profiles if users signed in before this migration was installed.
insert into public.profiles (id, email, display_name, avatar_url, status, role, approved_at)
select
  id,
  coalesce(email, ''),
  coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name'),
  coalesce(raw_user_meta_data ->> 'avatar_url', raw_user_meta_data ->> 'picture'),
  case when lower(coalesce(email, '')) = 'wjx712@gmail.com' then 'approved' else 'pending' end,
  case when lower(coalesce(email, '')) = 'wjx712@gmail.com' then 'admin' else 'member' end,
  case when lower(coalesce(email, '')) = 'wjx712@gmail.com' then now() else null end
from auth.users
on conflict (id) do nothing;

create or replace function public.is_lmi_admin()
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and status = 'approved'
      and role = 'admin'
  );
$$;

create or replace function public.set_review_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_paper_reviews_updated_at on public.paper_reviews;
create trigger set_paper_reviews_updated_at
  before update on public.paper_reviews
  for each row execute procedure public.set_review_updated_at();

alter table public.profiles enable row level security;
alter table public.paper_reviews enable row level security;

drop policy if exists "Users read own profile; admins read all" on public.profiles;
create policy "Users read own profile; admins read all"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_lmi_admin());

drop policy if exists "Users read own reviews; admins read all" on public.paper_reviews;
create policy "Users read own reviews; admins read all"
  on public.paper_reviews for select
  to authenticated
  using (user_id = auth.uid() or public.is_lmi_admin());

drop policy if exists "Approved users create own reviews" on public.paper_reviews;
create policy "Approved users create own reviews"
  on public.paper_reviews for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and status = 'approved'
    )
  );

drop policy if exists "Approved users update own reviews" on public.paper_reviews;
create policy "Approved users update own reviews"
  on public.paper_reviews for update
  to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and status = 'approved'
    )
  );

drop policy if exists "Approved users delete own reviews" on public.paper_reviews;
create policy "Approved users delete own reviews"
  on public.paper_reviews for delete
  to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and status = 'approved'
    )
  );

create or replace function public.admin_set_member_status(target_user uuid, new_status text)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  if not public.is_lmi_admin() then
    raise exception 'Administrator access required';
  end if;
  if new_status not in ('approved', 'blocked') then
    raise exception 'Invalid member status';
  end if;
  if exists (select 1 from public.profiles where id = target_user and role = 'admin') then
    raise exception 'The administrator account cannot be changed here';
  end if;

  update public.profiles
  set
    status = new_status,
    approved_at = case when new_status = 'approved' then now() else null end,
    approved_by = case when new_status = 'approved' then auth.uid() else null end
  where id = target_user;

  if not found then
    raise exception 'Member not found';
  end if;
end;
$$;

revoke all on public.profiles from anon;
revoke all on public.paper_reviews from anon;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.paper_reviews to authenticated;
revoke all on function public.admin_set_member_status(uuid, text) from public;
grant execute on function public.admin_set_member_status(uuid, text) to authenticated;
grant execute on function public.is_lmi_admin() to authenticated;
