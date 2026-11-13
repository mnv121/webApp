-- =====================================================================
-- File attachments for chat (Supabase Storage)
-- Run AFTER schema.sql and chat_schema.sql.
-- Supabase dashboard > SQL Editor > New query > paste > Run. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. MESSAGE COLUMNS for an attached file
-- ---------------------------------------------------------------------
alter table public.messages
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_type text,
  add column if not exists attachment_size bigint;

-- A message can now be text, a file, or both.
-- (the original inline check on body is named messages_body_check)
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages drop constraint if exists messages_body_or_file;
alter table public.messages drop constraint if exists messages_attachment_valid;

alter table public.messages add constraint messages_body_or_file check (
  char_length(body) <= 2000
  and (char_length(btrim(body)) > 0 or attachment_path is not null)
);

-- The file must live inside THIS conversation's folder, with sane metadata.
alter table public.messages add constraint messages_attachment_valid check (
  attachment_path is null
  or (
    attachment_path like conversation_id::text || '/%'
    and char_length(attachment_path) <= 300
    and char_length(coalesce(attachment_name, '')) between 1 and 255
    and coalesce(attachment_size, 0) between 1 and 10485760
  )
);

-- ---------------------------------------------------------------------
-- 2. PRIVATE STORAGE BUCKET
--    private      = no public URLs; files are fetched with short-lived signed links
--    10 MB limit  = enforced by Supabase itself, not just by the browser
--    mime list    = no HTML/SVG/scripts, so an uploaded file can't run code
--    (Free plans have a global per-file cap too; 10 MB is within it.)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-files', 'chat-files', false, 10485760,
  array[
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'application/pdf',
    'text/plain', 'text/csv',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg',
    'video/mp4', 'video/webm'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------
-- 3. WHO MAY TOUCH A FILE: only members of the chat whose id is the
--    first folder in the file path ("<conversation_id>/<file>").
--    The CASE guards against paths that aren't valid UUIDs.
-- ---------------------------------------------------------------------
create or replace function public.can_access_chat_file(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when split_part(object_name, '/', 1)
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then public.is_member(split_part(object_name, '/', 1)::uuid)
    else false
  end;
$$;

revoke execute on function public.can_access_chat_file(text) from public, anon;
grant  execute on function public.can_access_chat_file(text) to authenticated;

drop policy if exists "chat-files: members upload" on storage.objects;
create policy "chat-files: members upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-files' and public.can_access_chat_file(name));

drop policy if exists "chat-files: members download" on storage.objects;
create policy "chat-files: members download"
  on storage.objects for select to authenticated
  using (bucket_id = 'chat-files' and public.can_access_chat_file(name));
-- No update/delete policies: uploaded files can't be replaced or removed by clients.

-- ---------------------------------------------------------------------
-- 4. CHAT LIST PREVIEW: show "📎 filename" when the last message is a file.
--    Same signature as before, so it can be replaced in place.
-- ---------------------------------------------------------------------
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
    coalesce(nullif(lm.body, ''), '📎 ' || lm.attachment_name),
    lm.created_at, lm.sender_id,
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
    select m.body, m.attachment_name, m.created_at, m.sender_id
    from public.messages m
    where m.conversation_id = c.id
    order by m.created_at desc
    limit 1
  ) lm on true
  where me.user_id = (select auth.uid())
  order by coalesce(lm.created_at, c.created_at) desc;
$$;

revoke execute on function public.my_conversations() from public, anon;
grant  execute on function public.my_conversations() to authenticated;
