-- =====================================================================
-- 06  Username + email sign-up, sign in with username OR email
-- Safe to run more than once. Run after 01-05.
-- =====================================================================

-- 1. New accounts: save the username they chose at sign-up.
--    (If it is invalid or already taken, the account is still created without one;
--     they can pick another in the chat window.)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uname text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  dname text := left(coalesce(new.raw_user_meta_data ->> 'full_name',
                              new.raw_user_meta_data ->> 'name'), 100);
  pic   text := left(coalesce(new.raw_user_meta_data ->> 'avatar_url',
                              new.raw_user_meta_data ->> 'picture'), 500);
begin
  if uname !~ '^[a-z0-9_]{3,30}$' then
    uname := null;
  end if;

  begin
    insert into public.profiles (id, display_name, username, avatar_url)
    values (new.id, dname, uname, pic)
    on conflict (id) do nothing;
  exception when unique_violation then
    insert into public.profiles (id, display_name, avatar_url)
    values (new.id, dname, pic)
    on conflict (id) do nothing;
  end;

  insert into public.user_roles (user_id, role)
  values (new.id, 'user')
  on conflict do nothing;

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- 2. "Is this username free?" for the sign-up form (true / false only).
create or replace function public.username_available(uname text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select uname ~ '^[a-z0-9_]{3,30}$'
     and not exists (select 1 from public.profiles p where p.username = lower(btrim(uname)));
$$;

-- 3. Sign in with a username: turn it into the account's email.
--    An email passes straight through. Unknown usernames return null.
--    NOTE: this lets anyone who knows a username learn that account's email.
--    That is the cost of username login; remove this function to go back to email-only.
create or replace function public.login_email(identifier text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when position('@' in btrim(identifier)) > 0 then btrim(identifier)
    else (
      select u.email::text
      from public.profiles p
      join auth.users u on u.id = p.id
      where p.username = lower(btrim(identifier))
      limit 1
    )
  end;
$$;

revoke execute on function public.username_available(text) from public;
revoke execute on function public.login_email(text)        from public;
grant  execute on function public.username_available(text) to anon, authenticated;
grant  execute on function public.login_email(text)        to anon, authenticated;
