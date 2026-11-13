-- =====================================================================
-- HR system + access levels for Supabase
-- Run AFTER schema.sql, chat_schema.sql and attachments_schema.sql.
-- Supabase dashboard > SQL Editor > New query > paste > Run.
-- Safe to re-run.
--
-- ACCESS LEVELS (one level per person, stored in staff_roles):
--   owner         everything
--   system_admin  creates/edits HR configuration (departments, positions,
--                 request types)
--   admin_1       view all, add + edit employees, approve/reject requests
--   admin_2       view all, add + edit employees
--   admin_3       view all, add (encode) employees only
--   employee      own profile + own requests only (the default for everyone)
--
-- Everything is enforced HERE, in the database (RLS + functions).
-- The screens in hr.js only hide buttons; they are not the security.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLES (created first; functions and policies come after)
-- ---------------------------------------------------------------------
do $$ begin
  create type public.hr_role as enum
    ('owner', 'system_admin', 'admin_1', 'admin_2', 'admin_3', 'employee');
exception when duplicate_object then null; end $$;

-- One level per user. Clients can read, never write (see set_user_role()).
create table if not exists public.staff_roles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       public.hr_role not null default 'employee',
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- What each level may do. Edit this table in the SQL editor to change policy.
create table if not exists public.role_permissions (
  role       public.hr_role not null,
  permission text not null,
  primary key (role, permission)
);

create table if not exists public.departments (
  id         bigint generated always as identity primary key,
  name       text not null unique check (char_length(btrim(name)) between 1 and 100),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.positions (
  id            bigint generated always as identity primary key,
  title         text not null check (char_length(btrim(title)) between 1 and 100),
  department_id bigint references public.departments (id) on delete set null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (title, department_id)
);

create table if not exists public.request_types (
  id         bigint generated always as identity primary key,
  code       text not null unique check (code ~ '^[a-z0-9_]{2,40}$'),
  label      text not null check (char_length(btrim(label)) between 1 and 100),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create sequence if not exists public.employee_no_seq;

-- The HR record. user_id is filled in when the person signs in with the same
-- (verified) email as work_email, see claim_employee_record().
create table if not exists public.employees (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users (id) on delete set null,
  employee_no   text not null unique
                default ('EMP-' || lpad(nextval('public.employee_no_seq')::text, 5, '0')),
  first_name    text not null check (char_length(btrim(first_name)) between 1 and 100),
  last_name     text not null check (char_length(btrim(last_name)) between 1 and 100),
  work_email    text not null check (char_length(work_email) <= 254
                                     and work_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone         text check (char_length(phone) <= 40),
  department_id bigint references public.departments (id) on delete set null,
  position_id   bigint references public.positions (id) on delete set null,
  manager_id    uuid references public.employees (id) on delete set null,
  hire_date     date,
  status        text not null default 'active' check (status in ('active', 'on_leave', 'inactive')),
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (manager_id is null or manager_id <> id)
);
create unique index if not exists employees_work_email_key on public.employees (lower(work_email));
create index if not exists employees_department_idx on public.employees (department_id);
create index if not exists employees_position_idx   on public.employees (position_id);
create index if not exists employees_manager_idx    on public.employees (manager_id);

create table if not exists public.requests (
  id            bigint generated always as identity primary key,
  employee_id   uuid not null references public.employees (id) on delete cascade,
  type_id       bigint not null references public.request_types (id),
  details       text not null default '' check (char_length(details) <= 2000),
  start_date    date,
  end_date      date,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by    uuid references auth.users (id) on delete set null,
  decided_at    timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  created_at    timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index if not exists requests_employee_idx on public.requests (employee_id, created_at desc);
create index if not exists requests_status_idx   on public.requests (status, created_at desc);
create index if not exists requests_type_idx     on public.requests (type_id);

-- ---------------------------------------------------------------------
-- 2. WHAT EACH LEVEL CAN DO (seed data; re-running never overwrites your edits)
-- ---------------------------------------------------------------------
insert into public.role_permissions (role, permission) values
  ('owner', 'employee.view_all'), ('owner', 'employee.create'), ('owner', 'employee.update'),
  ('owner', 'request.view_all'),  ('owner', 'request.approve'), ('owner', 'hr.config'),
  ('owner', 'role.assign'),       ('owner', 'audit.view'),
  ('system_admin', 'hr.config'),
  ('admin_1', 'employee.view_all'), ('admin_1', 'employee.create'), ('admin_1', 'employee.update'),
  ('admin_1', 'request.view_all'),  ('admin_1', 'request.approve'),
  ('admin_2', 'employee.view_all'), ('admin_2', 'employee.create'), ('admin_2', 'employee.update'),
  ('admin_2', 'request.view_all'),
  ('admin_3', 'employee.view_all'), ('admin_3', 'employee.create'), ('admin_3', 'request.view_all')
on conflict do nothing;

insert into public.request_types (code, label) values
  ('payroll',        'Payroll / payslip request'),
  ('leave',          'Leave request'),
  ('certificate',    'Employment certificate'),
  ('profile_update', 'Profile update request')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 3. HELPER FUNCTIONS (security definer so policies can use them safely)
-- ---------------------------------------------------------------------
create or replace function public.role_of(uid uuid)
returns public.hr_role
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select s.role from public.staff_roles s where s.user_id = uid),
    'employee'::public.hr_role);
$$;

create or replace function public.my_role()
returns public.hr_role
language sql stable security definer set search_path = ''
as $$
  select public.role_of((select auth.uid()));
$$;

create or replace function public.has_perm(p text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.my_role() = 'owner'
      or exists (select 1 from public.role_permissions rp
                 where rp.role = public.my_role() and rp.permission = p);
$$;

create or replace function public.my_employee_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select e.id from public.employees e where e.user_id = (select auth.uid());
$$;

-- Internal: write to the audit log. Not callable from the browser.
create or replace function public.log_event(ev text, det jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.audit_log (user_id, event, details)
  values ((select auth.uid()), ev, coalesce(det, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------
-- 4. TRIGGERS
-- ---------------------------------------------------------------------
create or replace function public.employees_touch()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

drop trigger if exists employees_touch on public.employees;
create trigger employees_touch
  before insert or update on public.employees
  for each row execute function public.employees_touch();

-- Every create/change of an HR record is written to the audit log.
create or replace function public.employees_audit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  diff jsonb;
begin
  if tg_op = 'INSERT' then
    perform public.log_event('employee.created',
      jsonb_build_object('employee_id', new.id, 'employee_no', new.employee_no));
  else
    select coalesce(jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value)),
                    '{}'::jsonb)
      into diff
    from jsonb_each(to_jsonb(new)) n
    join jsonb_each(to_jsonb(old)) o using (key)
    where n.value is distinct from o.value
      and n.key not in ('updated_at', 'updated_by');
    if diff <> '{}'::jsonb then
      perform public.log_event('employee.updated',
        jsonb_build_object('employee_id', new.id, 'changes', diff));
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists employees_audit on public.employees;
create trigger employees_audit
  after insert or update on public.employees
  for each row execute function public.employees_audit();

-- ---------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.staff_roles      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.departments      enable row level security;
alter table public.positions        enable row level security;
alter table public.request_types    enable row level security;
alter table public.employees        enable row level security;
alter table public.requests         enable row level security;

-- Levels: you see your own; HR viewers see everyone's. No client writes.
drop policy if exists "staff_roles: read" on public.staff_roles;
create policy "staff_roles: read" on public.staff_roles for select to authenticated
  using (user_id = (select auth.uid())
         or (select public.has_perm('employee.view_all'))
         or (select public.has_perm('role.assign')));

drop policy if exists "role_permissions: read" on public.role_permissions;
create policy "role_permissions: read" on public.role_permissions for select to authenticated
  using (true);

-- Configuration lists: everyone signed in can read (for dropdowns);
-- only hr.config (owner, system admin) can add or change.
drop policy if exists "departments: read" on public.departments;
drop policy if exists "departments: add" on public.departments;
drop policy if exists "departments: edit" on public.departments;
create policy "departments: read" on public.departments for select to authenticated using (true);
create policy "departments: add"  on public.departments for insert to authenticated
  with check ((select public.has_perm('hr.config')));
create policy "departments: edit" on public.departments for update to authenticated
  using ((select public.has_perm('hr.config'))) with check ((select public.has_perm('hr.config')));

drop policy if exists "positions: read" on public.positions;
drop policy if exists "positions: add" on public.positions;
drop policy if exists "positions: edit" on public.positions;
create policy "positions: read" on public.positions for select to authenticated using (true);
create policy "positions: add"  on public.positions for insert to authenticated
  with check ((select public.has_perm('hr.config')));
create policy "positions: edit" on public.positions for update to authenticated
  using ((select public.has_perm('hr.config'))) with check ((select public.has_perm('hr.config')));

drop policy if exists "request_types: read" on public.request_types;
drop policy if exists "request_types: add" on public.request_types;
drop policy if exists "request_types: edit" on public.request_types;
create policy "request_types: read" on public.request_types for select to authenticated using (true);
create policy "request_types: add"  on public.request_types for insert to authenticated
  with check ((select public.has_perm('hr.config')));
create policy "request_types: edit" on public.request_types for update to authenticated
  using ((select public.has_perm('hr.config'))) with check ((select public.has_perm('hr.config')));

-- Employees: you see your own record; HR levels see everyone.
-- Records of owners can only be edited by an owner.
drop policy if exists "employees: read" on public.employees;
drop policy if exists "employees: create" on public.employees;
drop policy if exists "employees: update" on public.employees;
create policy "employees: read" on public.employees for select to authenticated
  using (user_id = (select auth.uid()) or (select public.has_perm('employee.view_all')));
create policy "employees: create" on public.employees for insert to authenticated
  with check ((select public.has_perm('employee.create')));
create policy "employees: update" on public.employees for update to authenticated
  using ((select public.has_perm('employee.update'))
         and (public.role_of(user_id) <> 'owner' or (select public.my_role()) = 'owner'))
  with check ((select public.has_perm('employee.update'))
         and (public.role_of(user_id) <> 'owner' or (select public.my_role()) = 'owner'));

-- Requests: employees create and see their own; HR levels see all.
-- Approving/rejecting/cancelling goes through functions below (no direct UPDATE).
drop policy if exists "requests: read" on public.requests;
drop policy if exists "requests: create own" on public.requests;
create policy "requests: read" on public.requests for select to authenticated
  using (employee_id = (select public.my_employee_id())
         or (select public.has_perm('request.view_all')));
create policy "requests: create own" on public.requests for insert to authenticated
  with check (
    employee_id = (select public.my_employee_id())
    and status = 'pending'
    and exists (select 1 from public.request_types t where t.id = type_id and t.active)
    and exists (select 1 from public.employees e
                where e.id = employee_id and e.status <> 'inactive')
  );

-- Audit log: only people with audit.view (owner) can read it.
drop policy if exists "audit_log: read" on public.audit_log;
create policy "audit_log: read" on public.audit_log for select to authenticated
  using ((select public.has_perm('audit.view')));

-- ---------------------------------------------------------------------
-- 6. PRIVILEGES (least privilege on top of RLS; column lists matter)
-- ---------------------------------------------------------------------
revoke all on public.staff_roles, public.role_permissions, public.departments,
              public.positions, public.request_types, public.employees, public.requests
  from anon, authenticated;
revoke all on sequence public.employee_no_seq from anon, authenticated;
grant usage on sequence public.employee_no_seq to authenticated;

grant select on public.staff_roles, public.role_permissions, public.departments,
                public.positions, public.request_types, public.employees, public.requests
  to authenticated;
grant select on public.audit_log to authenticated;

grant insert (name)                                  on public.departments   to authenticated;
grant update (name, active)                          on public.departments   to authenticated;
grant insert (title, department_id)                  on public.positions     to authenticated;
grant update (title, department_id, active)          on public.positions     to authenticated;
grant insert (code, label)                           on public.request_types to authenticated;
grant update (label, active)                         on public.request_types to authenticated;

-- user_id, created_by etc. are NOT listed: the browser can never set them.
grant insert (first_name, last_name, work_email, phone, department_id, position_id,
              manager_id, hire_date, status)         on public.employees     to authenticated;
grant update (first_name, last_name, work_email, phone, department_id, position_id,
              manager_id, hire_date, status)         on public.employees     to authenticated;

grant insert (employee_id, type_id, details, start_date, end_date)
                                                     on public.requests      to authenticated;

-- ---------------------------------------------------------------------
-- 7. FUNCTIONS CALLED FROM THE APP (supabase.rpc)
-- ---------------------------------------------------------------------

-- 7a. Link the signed-in account to its HR record by VERIFIED email.
create or replace function public.claim_employee_record()
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me   uuid := (select auth.uid());
  mail text;
  emp  uuid;
begin
  if me is null then return null; end if;

  select e.id into emp from public.employees e where e.user_id = me;
  if emp is not null then return emp; end if;

  select lower(u.email) into mail
  from auth.users u
  where u.id = me and u.email_confirmed_at is not null;
  if mail is null then return null; end if;

  update public.employees
  set user_id = me
  where lower(work_email) = mail and user_id is null and status <> 'inactive'
  returning id into emp;

  return emp;
end;
$$;

-- 7b. What can I do? (the screens use this only to show/hide buttons)
create or replace function public.my_access()
returns table (role public.hr_role, permissions text[], employee_id uuid)
language sql stable security definer set search_path = ''
as $$
  select
    x.r,
    case when x.r = 'owner'
      then array(select distinct rp.permission from public.role_permissions rp order by 1)
      else array(select rp.permission from public.role_permissions rp where rp.role = x.r order by 1)
    end,
    public.my_employee_id()
  from (select public.my_role() as r) x;
$$;

-- 7c. Approve or reject a request. Nobody can decide their own request.
create or replace function public.decide_request(req bigint, approve boolean, note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r      public.requests;
  me     uuid := (select auth.uid());
  my_emp uuid := public.my_employee_id();
begin
  if not public.has_perm('request.approve') then
    raise exception 'Not allowed';
  end if;

  select * into r from public.requests where id = req for update;
  if not found then raise exception 'Request not found'; end if;
  if r.status <> 'pending' then raise exception 'This request is already %', r.status; end if;
  if r.employee_id = my_emp then raise exception 'You cannot decide your own request'; end if;

  update public.requests
  set status        = case when approve then 'approved' else 'rejected' end,
      decided_by    = me,
      decided_at    = now(),
      decision_note = left(nullif(btrim(note), ''), 500)
  where id = req;

  perform public.log_event(
    case when approve then 'request.approved' else 'request.rejected' end,
    jsonb_build_object('request_id', req, 'employee_id', r.employee_id));
end;
$$;

-- 7d. Cancel my own pending request.
create or replace function public.cancel_request(req bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  n int;
begin
  update public.requests
  set status = 'cancelled'
  where id = req
    and status = 'pending'
    and employee_id = public.my_employee_id();
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Nothing to cancel'; end if;
  perform public.log_event('request.cancelled', jsonb_build_object('request_id', req));
end;
$$;

-- 7e. Change someone's access level. Owner only. Keeps at least one owner.
create or replace function public.set_user_role(target uuid, new_role public.hr_role)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me       uuid := (select auth.uid());
  old_role public.hr_role;
begin
  if not public.has_perm('role.assign') then
    raise exception 'Not allowed';
  end if;
  if not exists (select 1 from auth.users where id = target) then
    raise exception 'User not found';
  end if;

  old_role := public.role_of(target);
  if old_role = 'owner' and new_role <> 'owner'
     and (select count(*) from public.staff_roles where role = 'owner') <= 1 then
    raise exception 'There must always be at least one owner';
  end if;

  insert into public.staff_roles (user_id, role, updated_by, updated_at)
  values (target, new_role, me, now())
  on conflict (user_id) do update
    set role = excluded.role, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  perform public.log_event('role.changed',
    jsonb_build_object('target', target, 'from', old_role, 'to', new_role));
end;
$$;

-- Lock down who can call what
revoke execute on function public.role_of(uuid)                          from public, anon;
revoke execute on function public.my_role()                              from public, anon;
revoke execute on function public.has_perm(text)                         from public, anon;
revoke execute on function public.my_employee_id()                       from public, anon;
revoke execute on function public.claim_employee_record()                from public, anon;
revoke execute on function public.my_access()                            from public, anon;
revoke execute on function public.decide_request(bigint, boolean, text) from public, anon;
revoke execute on function public.cancel_request(bigint)                 from public, anon;
revoke execute on function public.set_user_role(uuid, public.hr_role)    from public, anon;
revoke execute on function public.log_event(text, jsonb)                 from public, anon, authenticated;
revoke execute on function public.employees_touch()                      from public, anon, authenticated;
revoke execute on function public.employees_audit()                      from public, anon, authenticated;

grant execute on function public.role_of(uuid)                           to authenticated;
grant execute on function public.my_role()                               to authenticated;
grant execute on function public.has_perm(text)                          to authenticated;
grant execute on function public.my_employee_id()                        to authenticated;
grant execute on function public.claim_employee_record()                 to authenticated;
grant execute on function public.my_access()                             to authenticated;
grant execute on function public.decide_request(bigint, boolean, text)   to authenticated;
grant execute on function public.cancel_request(bigint)                  to authenticated;
grant execute on function public.set_user_role(uuid, public.hr_role)     to authenticated;

-- ---------------------------------------------------------------------
-- 8. REALTIME: lets the chat show "Seen" the moment the other person reads
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'conversation_members'
  ) then
    alter publication supabase_realtime add table public.conversation_members;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 9. MAKE YOURSELF THE OWNER (run once, after you have signed in once).
--    Replace the email with yours. Then everything else is done in the app.
-- ---------------------------------------------------------------------
-- insert into public.staff_roles (user_id, role)
-- select id, 'owner' from auth.users where email = 'you@example.com'
-- on conflict (user_id) do update set role = 'owner';
