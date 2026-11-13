-- =====================================================================
-- Secure starter schema for Supabase Auth
-- Run in: Supabase dashboard > SQL Editor > New query > paste > Run
-- Safe to re-run (uses IF NOT EXISTS / CREATE OR REPLACE where possible).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PROFILES: one row per user, auto-created at sign-up
--    (auth.users is managed by Supabase and not exposed to your app,
--     so app-visible user data lives in your own table.)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 100),
  username     text unique check (username ~ '^[a-z0-9_]{3,30}$'),
  avatar_url   text check (char_length(avatar_url) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. ROLES: stored in their OWN table that clients can never write to.
--    Never keep roles/permissions in user_metadata: users can edit it.
-- ---------------------------------------------------------------------
do $$ begin
  create type public.app_role as enum ('user', 'moderator', 'admin');
exception when duplicate_object then null; end $$;

create table if not exists public.user_roles (
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.app_role not null default 'user',
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- ---------------------------------------------------------------------
-- 3. AUDIT LOG: security events, readable only by your server/admin tools
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users (id) on delete set null,
  event      text not null,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. TRIGGERS
-- ---------------------------------------------------------------------

-- 4a. Create a profile + default role whenever someone signs up
--     (email/password, Google, Facebook all pass through auth.users).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name',
                  new.raw_user_meta_data ->> 'name'), 100),
    left(coalesce(new.raw_user_meta_data ->> 'avatar_url',
                  new.raw_user_meta_data ->> 'picture'), 500)
  )
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, role)
  values (new.id, 'user')
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4b. Keep updated_at current
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY (RLS): the real protection layer.
--    The anon key in your front-end is public by design; RLS is what
--    stops people from reading or changing other users' data.
--    RLS ON + no policy = nobody can access (secure by default).
-- ---------------------------------------------------------------------
alter table public.profiles   enable row level security;
alter table public.user_roles enable row level security;
alter table public.audit_log  enable row level security;

-- Profiles: users can read and edit only their own row.
drop policy if exists "profiles: read own"   on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;

create policy "profiles: read own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "profiles: update own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
-- No INSERT policy (the trigger creates rows) and no DELETE policy.

-- Roles: users can see their own roles but never change them.
drop policy if exists "user_roles: read own" on public.user_roles;
create policy "user_roles: read own"
  on public.user_roles for select
  to authenticated
  using ((select auth.uid()) = user_id);
-- No write policies: only the service_role (server-side) can grant roles.

-- Audit log: deliberately NO policies = invisible to all client requests.

-- ---------------------------------------------------------------------
-- 6. PRIVILEGES: least privilege on top of RLS (defense in depth)
-- ---------------------------------------------------------------------
revoke all on public.profiles   from anon, authenticated;
revoke all on public.user_roles from anon, authenticated;
revoke all on public.audit_log  from anon, authenticated;

grant select on public.profiles   to authenticated;
-- Only these columns can be edited from the browser:
grant update (display_name, username, avatar_url) on public.profiles to authenticated;
grant select on public.user_roles to authenticated;

-- ---------------------------------------------------------------------
-- 7. ROLE CHECK HELPER (use inside RLS policies for admin-only data)
-- ---------------------------------------------------------------------
create or replace function public.has_role(required public.app_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = required
  );
$$;

revoke execute on function public.has_role(public.app_role) from public, anon;
grant  execute on function public.has_role(public.app_role) to authenticated;

-- Lock down the trigger functions so they can't be called via the API
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at()  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. TEMPLATE: pattern for ANY table that holds user-owned data.
--    Copy this for notes, orders, posts, etc. (uncomment to try)
-- ---------------------------------------------------------------------
-- create table public.notes (
--   id         uuid primary key default gen_random_uuid(),
--   user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
--   body       text not null check (char_length(body) <= 5000),
--   created_at timestamptz not null default now()
-- );
-- create index on public.notes (user_id);
-- alter table public.notes enable row level security;
--
-- create policy "notes: owner full access" on public.notes
--   for all to authenticated
--   using  ((select auth.uid()) = user_id)
--   with check ((select auth.uid()) = user_id);
--
-- -- Admin-only read example using the helper above:
-- create policy "notes: admins can read all" on public.notes
--   for select to authenticated
--   using (public.has_role('admin'));

-- ---------------------------------------------------------------------
-- 9. MAKING YOURSELF AN ADMIN (run manually, once, after you sign up)
--    Replace the email with yours.
-- ---------------------------------------------------------------------
-- insert into public.user_roles (user_id, role)
-- select id, 'admin' from auth.users where email = 'you@example.com'
-- on conflict do nothing;
