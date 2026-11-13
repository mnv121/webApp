-- =====================================================================
-- HR phase 1: Leave management, Attendance, Overtime, Shifts
-- Run AFTER hr_schema.sql. Supabase > SQL Editor > New query > Run.
-- Safe to re-run.
--
-- WHO CAN DO WHAT (added to the access levels from hr_schema.sql):
--   everyone (linked employee)  apply/cancel own leave, clock in/out,
--                               apply for overtime, see own records
--   leave.view_all              owner, admin 1-3   see all leave + stats
--   leave.approve               owner, admin 1     approve/reject/cancel leave
--   attendance.view_all         owner, admin 1-3   see all attendance
--   attendance.edit             owner, admin 1-2   manual entries, adjustments,
--                                                  assign shifts
--   overtime.approve            owner, admin 1     approve/reject overtime
--   hr.config                   owner, system admin  leave policies, shifts,
--                                                  company timezone
-- Nobody can approve or edit their OWN leave/overtime/attendance.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------
create table if not exists public.hr_settings (
  key   text primary key,
  value text not null
);
insert into public.hr_settings (key, value) values ('timezone', 'Asia/Manila')
on conflict (key) do nothing;

create table if not exists public.leave_types (
  id          bigint generated always as identity primary key,
  code        text not null unique check (code ~ '^[a-z0-9_]{2,40}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 100),
  annual_days numeric(5,1) check (annual_days is null or annual_days >= 0), -- null = unlimited
  paid        boolean not null default true,
  is_short    boolean not null default false,  -- requested by hours on a single day
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.leave_requests (
  id            bigint generated always as identity primary key,
  employee_id   uuid not null references public.employees (id) on delete cascade,
  leave_type_id bigint not null references public.leave_types (id),
  start_date    date not null,
  end_date      date not null,
  hours         numeric(4,2) check (hours is null or (hours >= 0.5 and hours <= 8)),
  days          numeric(5,2) not null check (days > 0),
  reason        text not null default '' check (char_length(reason) <= 1000),
  cover_note    text check (char_length(cover_note) <= 300),
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by    uuid references auth.users (id) on delete set null,
  decided_at    timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  created_at    timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists leave_requests_emp_idx    on public.leave_requests (employee_id, start_date desc);
create index if not exists leave_requests_status_idx on public.leave_requests (status, start_date);
create index if not exists leave_requests_type_idx   on public.leave_requests (leave_type_id);

create table if not exists public.shifts (
  id               bigint generated always as identity primary key,
  name             text not null unique check (char_length(btrim(name)) between 1 and 100),
  start_time       time not null,
  end_time         time not null,
  grace_minutes    int not null default 10 check (grace_minutes between 0 and 120),
  rounding_minutes int not null default 0 check (rounding_minutes in (0, 5, 10, 15, 30)),
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

create table if not exists public.employee_shifts (
  employee_id uuid primary key references public.employees (id) on delete cascade,
  shift_id    bigint not null references public.shifts (id),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);
create index if not exists employee_shifts_shift_idx on public.employee_shifts (shift_id);

create table if not exists public.attendance_records (
  id          bigint generated always as identity primary key,
  employee_id uuid not null references public.employees (id) on delete cascade,
  work_date   date not null,
  clock_in    timestamptz not null,
  clock_out   timestamptz,
  in_comment  text check (char_length(in_comment) <= 300),
  out_comment text check (char_length(out_comment) <= 300),
  source      text not null default 'clock' check (source in ('clock', 'manual')),
  edited_by   uuid references auth.users (id) on delete set null,
  edited_at   timestamptz,
  created_at  timestamptz not null default now(),
  check (clock_out is null or clock_out > clock_in)
);
create index if not exists attendance_emp_date_idx  on public.attendance_records (employee_id, work_date desc);
create index if not exists attendance_date_idx      on public.attendance_records (work_date);

create table if not exists public.overtime_requests (
  id            bigint generated always as identity primary key,
  employee_id   uuid not null references public.employees (id) on delete cascade,
  work_date     date not null,
  hours         numeric(4,2) not null check (hours > 0 and hours <= 16),
  reason        text not null default '' check (char_length(reason) <= 500),
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by    uuid references auth.users (id) on delete set null,
  decided_at    timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  created_at    timestamptz not null default now()
);
create unique index if not exists overtime_one_open_per_day
  on public.overtime_requests (employee_id, work_date) where status in ('pending', 'approved');
create index if not exists overtime_status_idx on public.overtime_requests (status, work_date);

-- ---------------------------------------------------------------------
-- 2. SEED DATA (starter values: edit them in the app under Policies)
-- ---------------------------------------------------------------------
insert into public.role_permissions (role, permission) values
  ('owner', 'leave.view_all'),      ('owner', 'leave.approve'),
  ('owner', 'attendance.view_all'), ('owner', 'attendance.edit'), ('owner', 'overtime.approve'),
  ('admin_1', 'leave.view_all'),      ('admin_1', 'leave.approve'),
  ('admin_1', 'attendance.view_all'), ('admin_1', 'attendance.edit'), ('admin_1', 'overtime.approve'),
  ('admin_2', 'leave.view_all'),      ('admin_2', 'attendance.view_all'), ('admin_2', 'attendance.edit'),
  ('admin_3', 'leave.view_all'),      ('admin_3', 'attendance.view_all')
on conflict do nothing;

insert into public.leave_types (code, name, annual_days, paid, is_short) values
  ('annual',    'Annual leave',        15,   true,  false),
  ('sick',      'Sick leave',          10,   true,  false),
  ('emergency', 'Emergency leave',      3,   true,  false),
  ('unpaid',    'Unpaid leave',      null,   false, false),
  ('short',     'Short leave (hours)', 5,    true,  true)
on conflict (code) do nothing;

insert into public.shifts (name, start_time, end_time, grace_minutes, rounding_minutes) values
  ('Day shift 08:00-17:00', '08:00', '17:00', 10, 0)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- 3. HELPER FUNCTIONS
-- ---------------------------------------------------------------------
create or replace function public.company_tz()
returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce((select s.value from public.hr_settings s where s.key = 'timezone'), 'UTC');
$$;

create or replace function public.company_today()
returns date
language sql stable security definer set search_path = ''
as $$
  select (now() at time zone public.company_tz())::date;
$$;

-- Mon-Fri days between two dates (inclusive). Public holidays are not modelled yet.
create or replace function public.business_days(a date, b date)
returns int
language sql immutable set search_path = ''
as $$
  select count(*)::int
  from generate_series(a, b, interval '1 day') d
  where extract(isodow from d) < 6;
$$;

-- ---------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY + PRIVILEGES
-- ---------------------------------------------------------------------
alter table public.hr_settings        enable row level security;
alter table public.leave_types        enable row level security;
alter table public.leave_requests     enable row level security;
alter table public.shifts             enable row level security;
alter table public.employee_shifts    enable row level security;
alter table public.attendance_records enable row level security;
alter table public.overtime_requests  enable row level security;

drop policy if exists "hr_settings: read" on public.hr_settings;
create policy "hr_settings: read" on public.hr_settings for select to authenticated using (true);

drop policy if exists "leave_types: read" on public.leave_types;
drop policy if exists "leave_types: add"  on public.leave_types;
drop policy if exists "leave_types: edit" on public.leave_types;
create policy "leave_types: read" on public.leave_types for select to authenticated using (true);
create policy "leave_types: add"  on public.leave_types for insert to authenticated
  with check ((select public.has_perm('hr.config')));
create policy "leave_types: edit" on public.leave_types for update to authenticated
  using ((select public.has_perm('hr.config'))) with check ((select public.has_perm('hr.config')));

drop policy if exists "shifts: read" on public.shifts;
drop policy if exists "shifts: add"  on public.shifts;
drop policy if exists "shifts: edit" on public.shifts;
create policy "shifts: read" on public.shifts for select to authenticated using (true);
create policy "shifts: add"  on public.shifts for insert to authenticated
  with check ((select public.has_perm('hr.config')));
create policy "shifts: edit" on public.shifts for update to authenticated
  using ((select public.has_perm('hr.config'))) with check ((select public.has_perm('hr.config')));

drop policy if exists "leave_requests: read" on public.leave_requests;
create policy "leave_requests: read" on public.leave_requests for select to authenticated
  using (employee_id = (select public.my_employee_id())
         or (select public.has_perm('leave.view_all')));

drop policy if exists "employee_shifts: read" on public.employee_shifts;
create policy "employee_shifts: read" on public.employee_shifts for select to authenticated
  using (employee_id = (select public.my_employee_id())
         or (select public.has_perm('attendance.view_all')));

drop policy if exists "attendance: read" on public.attendance_records;
create policy "attendance: read" on public.attendance_records for select to authenticated
  using (employee_id = (select public.my_employee_id())
         or (select public.has_perm('attendance.view_all')));

drop policy if exists "overtime: read"   on public.overtime_requests;
drop policy if exists "overtime: create" on public.overtime_requests;
create policy "overtime: read" on public.overtime_requests for select to authenticated
  using (employee_id = (select public.my_employee_id())
         or (select public.has_perm('attendance.view_all')));
create policy "overtime: create" on public.overtime_requests for insert to authenticated
  with check (
    employee_id = (select public.my_employee_id())
    and status = 'pending'
    and exists (select 1 from public.employees e where e.id = employee_id and e.status <> 'inactive')
  );

revoke all on public.hr_settings, public.leave_types, public.leave_requests, public.shifts,
              public.employee_shifts, public.attendance_records, public.overtime_requests
  from anon, authenticated;

grant select on public.hr_settings, public.leave_types, public.leave_requests, public.shifts,
                public.employee_shifts, public.attendance_records, public.overtime_requests
  to authenticated;

grant insert (code, name, annual_days, paid, is_short)  on public.leave_types to authenticated;
grant update (name, annual_days, paid, active)          on public.leave_types to authenticated;
grant insert (name, start_time, end_time, grace_minutes, rounding_minutes) on public.shifts to authenticated;
grant update (name, start_time, end_time, grace_minutes, rounding_minutes, active)
                                                        on public.shifts to authenticated;
grant insert (employee_id, work_date, hours, reason)    on public.overtime_requests to authenticated;

-- ---------------------------------------------------------------------
-- 5. LEAVE FUNCTIONS
-- ---------------------------------------------------------------------

-- Apply for leave. Checks policy, overlap and balance (pending + approved count).
create or replace function public.apply_leave(
  p_type bigint, p_start date, p_end date,
  p_hours numeric default null, p_reason text default '', p_cover text default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  emp  uuid := public.my_employee_id();
  lt   public.leave_types;
  d    numeric;
  used numeric;
  new_id bigint;
begin
  if emp is null then raise exception 'Your account is not linked to an employee record'; end if;
  if not exists (select 1 from public.employees where id = emp and status <> 'inactive') then
    raise exception 'Inactive employees cannot apply for leave';
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Choose a valid start and end date';
  end if;
  if p_end - p_start > 365 then raise exception 'Leave cannot be longer than a year'; end if;

  select * into lt from public.leave_types where id = p_type and active;
  if not found then raise exception 'That leave type is not available'; end if;

  if lt.is_short then
    if p_start <> p_end then raise exception 'Short leave must be on a single day'; end if;
    if p_hours is null or p_hours < 0.5 or p_hours > 8 then
      raise exception 'Short leave must be between 0.5 and 8 hours';
    end if;
    d := round(p_hours / 8.0, 2);
  else
    d := public.business_days(p_start, p_end);
    if d < 1 then raise exception 'That range has no working days (weekends only)'; end if;
    p_hours := null;
  end if;

  perform pg_advisory_xact_lock(hashtext(emp::text));

  if exists (select 1 from public.leave_requests r
             where r.employee_id = emp and r.status in ('pending', 'approved')
               and daterange(r.start_date, r.end_date, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception 'You already have leave on some of those dates';
  end if;

  if lt.annual_days is not null then
    select coalesce(sum(r.days), 0) into used
    from public.leave_requests r
    where r.employee_id = emp and r.leave_type_id = lt.id
      and r.status in ('pending', 'approved')
      and extract(year from r.start_date) = extract(year from p_start);
    if used + d > lt.annual_days then
      raise exception 'Not enough % balance: % day(s) left, you asked for %',
        lt.name, greatest(lt.annual_days - used, 0), d;
    end if;
  end if;

  insert into public.leave_requests
    (employee_id, leave_type_id, start_date, end_date, hours, days, reason, cover_note)
  values
    (emp, lt.id, p_start, p_end, p_hours, d, left(coalesce(p_reason, ''), 1000),
     left(nullif(btrim(p_cover), ''), 300))
  returning id into new_id;

  perform public.log_event('leave.applied',
    jsonb_build_object('leave_id', new_id, 'employee_id', emp, 'days', d));
  return new_id;
end;
$$;

create or replace function public.decide_leave(req bigint, approve boolean, note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.leave_requests;
begin
  if not public.has_perm('leave.approve') then raise exception 'Not allowed'; end if;
  select * into r from public.leave_requests where id = req for update;
  if not found then raise exception 'Leave request not found'; end if;
  if r.status <> 'pending' then raise exception 'This request is already %', r.status; end if;
  if r.employee_id = public.my_employee_id() then
    raise exception 'You cannot decide your own leave request';
  end if;

  update public.leave_requests
  set status = case when approve then 'approved' else 'rejected' end,
      decided_by = (select auth.uid()), decided_at = now(),
      decision_note = left(nullif(btrim(note), ''), 500)
  where id = req;

  perform public.log_event(case when approve then 'leave.approved' else 'leave.rejected' end,
    jsonb_build_object('leave_id', req, 'employee_id', r.employee_id));
end;
$$;

-- Employees cancel their own pending leave (or approved leave that has not started).
-- Approvers (leave.approve) can cancel anyone's pending/approved leave.
create or replace function public.cancel_leave(req bigint, note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r      public.leave_requests;
  mine   boolean;
  admin_ boolean := public.has_perm('leave.approve');
begin
  select * into r from public.leave_requests where id = req for update;
  if not found then raise exception 'Leave request not found'; end if;
  mine := r.employee_id = public.my_employee_id();

  if not (mine or admin_) then raise exception 'Not allowed'; end if;
  if r.status not in ('pending', 'approved') then raise exception 'This request is already %', r.status; end if;
  if mine and not admin_ and r.status = 'approved' and r.start_date <= public.company_today() then
    raise exception 'Approved leave that has started can only be cancelled by an approver';
  end if;

  update public.leave_requests
  set status = 'cancelled', decided_by = (select auth.uid()), decided_at = now(),
      decision_note = left(nullif(btrim(note), ''), 500)
  where id = req;

  perform public.log_event('leave.cancelled',
    jsonb_build_object('leave_id', req, 'employee_id', r.employee_id, 'by_approver', admin_ and not mine));
end;
$$;

-- ---------------------------------------------------------------------
-- 6. ATTENDANCE FUNCTIONS
-- ---------------------------------------------------------------------

-- One button: clocks in when nothing is open, clocks out when a record is open.
-- Uses the SERVER clock, so the browser's time can't be faked.
create or replace function public.clock_in_out(note text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  emp uuid := public.my_employee_id();
  rec public.attendance_records;
  c   text := left(nullif(btrim(note), ''), 300);
begin
  if emp is null then raise exception 'Your account is not linked to an employee record'; end if;
  if not exists (select 1 from public.employees where id = emp and status <> 'inactive') then
    raise exception 'Inactive employees cannot clock in';
  end if;

  perform pg_advisory_xact_lock(hashtext(emp::text));

  select * into rec from public.attendance_records
  where employee_id = emp and clock_out is null and clock_in > now() - interval '20 hours'
  order by clock_in desc limit 1 for update;

  if found then
    if now() - rec.clock_in < interval '5 seconds' then
      raise exception 'Please wait a moment before clocking out';
    end if;
    update public.attendance_records set clock_out = now(), out_comment = c where id = rec.id;
    return jsonb_build_object('action', 'out', 'at', now());
  end if;

  insert into public.attendance_records (employee_id, work_date, clock_in, in_comment)
  values (emp, public.company_today(), now(), c);
  return jsonb_build_object('action', 'in', 'at', now());
end;
$$;

-- Manual entry (rec is null) or adjustment of an existing record. A reason is required
-- and everything is written to the audit log. Nobody can edit their own attendance.
create or replace function public.adjust_attendance(
  emp uuid, rec bigint, p_in timestamptz, p_out timestamptz, reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  before_row public.attendance_records;
begin
  if not public.has_perm('attendance.edit') then raise exception 'Not allowed'; end if;
  if emp = public.my_employee_id() then raise exception 'You cannot edit your own attendance'; end if;
  if char_length(btrim(coalesce(reason, ''))) < 3 then raise exception 'Please give a reason'; end if;
  if p_in is null then raise exception 'Clock-in time is required'; end if;
  if p_out is not null and p_out <= p_in then raise exception 'Clock-out must be after clock-in'; end if;
  if not exists (select 1 from public.employees where id = emp) then raise exception 'Employee not found'; end if;

  if rec is null then
    insert into public.attendance_records
      (employee_id, work_date, clock_in, clock_out, in_comment, source, edited_by, edited_at)
    values
      (emp, (p_in at time zone public.company_tz())::date, p_in, p_out,
       left(reason, 300), 'manual', (select auth.uid()), now());
    perform public.log_event('attendance.manual_entry',
      jsonb_build_object('employee_id', emp, 'in', p_in, 'out', p_out, 'reason', reason));
  else
    select * into before_row from public.attendance_records where id = rec and employee_id = emp for update;
    if not found then raise exception 'Attendance record not found'; end if;
    update public.attendance_records
    set clock_in = p_in, clock_out = p_out,
        work_date = (p_in at time zone public.company_tz())::date,
        source = 'manual', edited_by = (select auth.uid()), edited_at = now()
    where id = rec;
    perform public.log_event('attendance.adjusted',
      jsonb_build_object('employee_id', emp, 'record_id', rec,
        'from', jsonb_build_object('in', before_row.clock_in, 'out', before_row.clock_out),
        'to',   jsonb_build_object('in', p_in, 'out', p_out), 'reason', reason));
  end if;
end;
$$;

-- Put an employee on a shift (or take them off with shift = null).
create or replace function public.assign_shift(emp uuid, shift bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_perm('attendance.edit') then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.employees where id = emp) then raise exception 'Employee not found'; end if;

  if shift is null then
    delete from public.employee_shifts where employee_id = emp;
  else
    if not exists (select 1 from public.shifts where id = shift and active) then
      raise exception 'That shift is not available';
    end if;
    insert into public.employee_shifts (employee_id, shift_id, updated_by, updated_at)
    values (emp, shift, (select auth.uid()), now())
    on conflict (employee_id) do update
      set shift_id = excluded.shift_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end if;
  perform public.log_event('shift.assigned', jsonb_build_object('employee_id', emp, 'shift_id', shift));
end;
$$;

create or replace function public.decide_overtime(req bigint, approve boolean, note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.overtime_requests;
begin
  if not public.has_perm('overtime.approve') then raise exception 'Not allowed'; end if;
  select * into r from public.overtime_requests where id = req for update;
  if not found then raise exception 'Overtime request not found'; end if;
  if r.status <> 'pending' then raise exception 'This request is already %', r.status; end if;
  if r.employee_id = public.my_employee_id() then
    raise exception 'You cannot decide your own overtime request';
  end if;

  update public.overtime_requests
  set status = case when approve then 'approved' else 'rejected' end,
      decided_by = (select auth.uid()), decided_at = now(),
      decision_note = left(nullif(btrim(note), ''), 500)
  where id = req;

  perform public.log_event(case when approve then 'overtime.approved' else 'overtime.rejected' end,
    jsonb_build_object('overtime_id', req, 'employee_id', r.employee_id));
end;
$$;

create or replace function public.cancel_overtime(req bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  n int;
begin
  update public.overtime_requests set status = 'cancelled'
  where id = req and status = 'pending' and employee_id = public.my_employee_id();
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Nothing to cancel'; end if;
  perform public.log_event('overtime.cancelled', jsonb_build_object('overtime_id', req));
end;
$$;

-- Company timezone (used to decide which calendar day a clock-in belongs to).
create or replace function public.set_company_timezone(tz text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_perm('hr.config') then raise exception 'Not allowed'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = tz) then
    raise exception 'Unknown timezone: %', tz;
  end if;
  insert into public.hr_settings (key, value) values ('timezone', tz)
  on conflict (key) do update set value = excluded.value;
  perform public.log_event('settings.timezone', jsonb_build_object('timezone', tz));
end;
$$;

-- ---------------------------------------------------------------------
-- 7. REPORT FUNCTIONS (security invoker: they only return what RLS allows,
--    so an employee gets their own row and HR levels get everyone)
-- ---------------------------------------------------------------------
create or replace function public.attendance_summary(p_from date, p_to date)
returns table (
  employee_id       uuid,
  employee_no       text,
  employee_name     text,
  days_present      bigint,
  late_days         bigint,
  worked_minutes    bigint,
  missing_clock_out bigint,
  overtime_hours    numeric
)
language sql stable security invoker set search_path = ''
as $$
  with daily as (
    select r.employee_id, r.work_date,
           min(r.clock_in) as first_in,
           coalesce(sum(case when r.clock_out is not null
                        then extract(epoch from r.clock_out - r.clock_in) / 60 else 0 end), 0) as mins,
           bool_or(r.clock_out is null) as open_rec
    from public.attendance_records r
    where r.work_date between p_from and p_to
    group by r.employee_id, r.work_date
  )
  select
    e.id, e.employee_no, e.first_name || ' ' || e.last_name,
    count(d.work_date),
    count(*) filter (where s.id is not null and d.first_in is not null
      and (d.first_in at time zone public.company_tz())::time
          > s.start_time + make_interval(mins => s.grace_minutes)),
    coalesce(sum(case when s.rounding_minutes > 0
                 then round(d.mins / s.rounding_minutes) * s.rounding_minutes
                 else round(d.mins) end), 0)::bigint,
    count(*) filter (where d.open_rec),
    coalesce((select sum(o.hours) from public.overtime_requests o
              where o.employee_id = e.id and o.status = 'approved'
                and o.work_date between p_from and p_to), 0)
  from public.employees e
  left join daily d on d.employee_id = e.id
  left join public.employee_shifts es on es.employee_id = e.id
  left join public.shifts s on s.id = es.shift_id
  where e.status <> 'inactive'
  group by e.id, e.employee_no, e.first_name, e.last_name
  order by e.last_name, e.first_name;
$$;

-- How many things are waiting for ME to approve (for the dashboard)
create or replace function public.my_pending_work()
returns table (leave_pending bigint, overtime_pending bigint, requests_pending bigint)
language sql stable security invoker set search_path = ''
as $$
  select
    case when public.has_perm('leave.approve') then
      (select count(*) from public.leave_requests r where r.status = 'pending'
         and r.employee_id is distinct from public.my_employee_id()) else 0 end,
    case when public.has_perm('overtime.approve') then
      (select count(*) from public.overtime_requests o where o.status = 'pending'
         and o.employee_id is distinct from public.my_employee_id()) else 0 end,
    case when public.has_perm('request.approve') then
      (select count(*) from public.requests q where q.status = 'pending'
         and q.employee_id is distinct from public.my_employee_id()) else 0 end;
$$;

-- ---------------------------------------------------------------------
-- 8. WHO MAY CALL WHAT
-- ---------------------------------------------------------------------
revoke execute on function public.company_tz()                                   from public, anon;
revoke execute on function public.company_today()                                from public, anon;
revoke execute on function public.business_days(date, date)                      from public, anon;
revoke execute on function public.apply_leave(bigint, date, date, numeric, text, text) from public, anon;
revoke execute on function public.decide_leave(bigint, boolean, text)            from public, anon;
revoke execute on function public.cancel_leave(bigint, text)                     from public, anon;
revoke execute on function public.clock_in_out(text)                             from public, anon;
revoke execute on function public.adjust_attendance(uuid, bigint, timestamptz, timestamptz, text) from public, anon;
revoke execute on function public.assign_shift(uuid, bigint)                     from public, anon;
revoke execute on function public.decide_overtime(bigint, boolean, text)         from public, anon;
revoke execute on function public.cancel_overtime(bigint)                        from public, anon;
revoke execute on function public.set_company_timezone(text)                     from public, anon;
revoke execute on function public.attendance_summary(date, date)                 from public, anon;
revoke execute on function public.my_pending_work()                              from public, anon;

grant execute on function public.company_tz()                                    to authenticated;
grant execute on function public.company_today()                                 to authenticated;
grant execute on function public.business_days(date, date)                       to authenticated;
grant execute on function public.apply_leave(bigint, date, date, numeric, text, text) to authenticated;
grant execute on function public.decide_leave(bigint, boolean, text)             to authenticated;
grant execute on function public.cancel_leave(bigint, text)                      to authenticated;
grant execute on function public.clock_in_out(text)                              to authenticated;
grant execute on function public.adjust_attendance(uuid, bigint, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.assign_shift(uuid, bigint)                      to authenticated;
grant execute on function public.decide_overtime(bigint, boolean, text)          to authenticated;
grant execute on function public.cancel_overtime(bigint)                         to authenticated;
grant execute on function public.set_company_timezone(text)                      to authenticated;
grant execute on function public.attendance_summary(date, date)                  to authenticated;
grant execute on function public.my_pending_work()                               to authenticated;
