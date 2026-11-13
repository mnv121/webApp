-- =====================================================================
-- Chat schema (Messenger-style) for Supabase
-- Run AFTER schema.sql. Supabase dashboard > SQL Editor > New query.
-- Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLES
--    conversations        one row per chat (1-to-1 now, groups later)
--    conversation_members who is in which chat (+ read marker)
--    messages             the messages themselves
-- ---------------------------------------------------------------------
create table if not exists public.conversations (
  id         uuid primary key default gen_random_uuid(),
  is_group   boolean not null default false,
  title      text check (char_length(title) <= 100),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id);

create table if not exists public.messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body            text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at      timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

-- ---------------------------------------------------------------------
-- 2. HELPER FUNCTIONS used by the security policies
--    (security definer avoids infinite recursion inside RLS policies)
-- ---------------------------------------------------------------------
create or replace function public.is_member(conv uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = conv and user_id = (select auth.uid())
  );
$$;

create or replace function public.shares_conversation(other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversation_members a
    join public.conversation_members b on a.conversation_id = b.conversation_id
    where a.user_id = (select auth.uid()) and b.user_id = other
  );
$$;

-- ---------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;

drop policy if exists "conversations: members read" on public.conversations;
create policy "conversations: members read"
  on public.conversations for select to authenticated
  using (public.is_member(id));

drop policy if exists "members: read same chat" on public.conversation_members;
create policy "members: read same chat"
  on public.conversation_members for select to authenticated
  using (public.is_member(conversation_id));

drop policy if exists "members: update own row" on public.conversation_members;
create policy "members: update own row"
  on public.conversation_members for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "messages: members read" on public.messages;
create policy "messages: members read"
  on public.messages for select to authenticated
  using (public.is_member(conversation_id));

drop policy if exists "messages: members send as self" on public.messages;
create policy "messages: members send as self"
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and public.is_member(conversation_id)
  );
-- No UPDATE/DELETE policy on messages: sent messages can't be altered by clients.
-- No INSERT policy on conversations/members: chats are created via start_dm() below.

-- People you share a chat with can see each other's profile (name, avatar).
drop policy if exists "profiles: read conversation partners" on public.profiles;
create policy "profiles: read conversation partners"
  on public.profiles for select to authenticated
  using (public.shares_conversation(id));

-- ---------------------------------------------------------------------
-- 4. PRIVILEGES (least privilege on top of RLS)
-- ---------------------------------------------------------------------
revoke all on public.conversations, public.conversation_members, public.messages
  from anon, authenticated;

grant select on public.conversations        to authenticated;
grant select on public.conversation_members to authenticated;
grant update (last_read_at) on public.conversation_members to authenticated;
grant select, insert on public.messages     to authenticated;

-- ---------------------------------------------------------------------
-- 5. FUNCTIONS CALLED FROM THE APP (supabase.rpc)
-- ---------------------------------------------------------------------

-- 5a. Find ONE user by exact username. (No browsing or listing of all users.)
create or replace function public.find_user_by_username(uname text)
returns table (id uuid, display_name text, username text, avatar_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.display_name, p.username, p.avatar_url
  from public.profiles p
  where (select auth.uid()) is not null
    and p.username = lower(btrim(uname))
    and p.id <> (select auth.uid())
  limit 1;
$$;

-- 5b. Start (or reuse) a 1-to-1 chat with another user. Returns the chat id.
create or replace function public.start_dm(other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me   uuid := (select auth.uid());
  conv uuid;
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  if other_user is null or other_user = me then
    raise exception 'Invalid user';
  end if;
  if not exists (select 1 from public.profiles where id = other_user) then
    raise exception 'User not found';
  end if;

  select c.id into conv
  from public.conversations c
  where not c.is_group
    and exists (select 1 from public.conversation_members m
                where m.conversation_id = c.id and m.user_id = me)
    and exists (select 1 from public.conversation_members m
                where m.conversation_id = c.id and m.user_id = other_user)
  limit 1;

  if conv is null then
    insert into public.conversations (is_group, created_by)
    values (false, me)
    returning id into conv;

    insert into public.conversation_members (conversation_id, user_id)
    values (conv, me), (conv, other_user);
  end if;

  return conv;
end;
$$;

-- 5c. Mark a chat as read (uses the server clock, so unread counts stay accurate)
create or replace function public.mark_conversation_read(conv uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.conversation_members
  set last_read_at = now()
  where conversation_id = conv and user_id = (select auth.uid());
$$;

-- 5d. Conversation list with the other person, last message and unread count.
--     security invoker = it obeys the RLS policies above.
create or replace function public.my_conversations()
returns table (
  conversation_id uuid,
  is_group        boolean,
  title           text,
  peer_id         uuid,
  peer_name       text,
  peer_username   text,
  peer_avatar     text,
  last_body       text,
  last_at         timestamptz,
  last_sender     uuid,
  unread          bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id, c.is_group, c.title,
    p.id, p.display_name, p.username, p.avatar_url,
    lm.body, lm.created_at, lm.sender_id,
    (select count(*) from public.messages m
      where m.conversation_id = c.id
        and m.sender_id <> me.user_id
        and m.created_at > me.last_read_at)
  from public.conversation_members me
  join public.conversations c on c.id = me.conversation_id
  left join lateral (
    select pm.user_id from public.conversation_members pm
    where pm.conversation_id = c.id and pm.user_id <> me.user_id
    limit 1
  ) other on true
  left join public.profiles p on p.id = other.user_id
  left join lateral (
    select m.body, m.created_at, m.sender_id from public.messages m
    where m.conversation_id = c.id
    order by m.created_at desc
    limit 1
  ) lm on true
  where me.user_id = (select auth.uid())
  order by coalesce(lm.created_at, c.created_at) desc;
$$;

-- Only signed-in users may call these
revoke execute on function public.is_member(uuid)               from public, anon;
revoke execute on function public.shares_conversation(uuid)     from public, anon;
revoke execute on function public.find_user_by_username(text)   from public, anon;
revoke execute on function public.start_dm(uuid)                from public, anon;
revoke execute on function public.mark_conversation_read(uuid)  from public, anon;
revoke execute on function public.my_conversations()            from public, anon;

grant execute on function public.is_member(uuid)               to authenticated;
grant execute on function public.shares_conversation(uuid)     to authenticated;
grant execute on function public.find_user_by_username(text)   to authenticated;
grant execute on function public.start_dm(uuid)                to authenticated;
grant execute on function public.mark_conversation_read(uuid)  to authenticated;
grant execute on function public.my_conversations()            to authenticated;

-- ---------------------------------------------------------------------
-- 6. REALTIME: push new messages to open browsers instantly.
--    Realtime respects the RLS policies, so people only receive
--    messages from chats they belong to.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
