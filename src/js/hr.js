// ---------------------------------------------------------------
// HR section: my profile, HR requests, employee directory,
// HR setup (departments / positions / request types), audit log.
// What you SEE depends on your access level, but the real enforcement
// is in the database (hr_schema.sql). Hiding a button is convenience only.
// ---------------------------------------------------------------
import {
  ctx, can, el, toast, friendly, when, fullName, badge, button, table, opts, openDialog,
  statusPill, makeTabs, refreshAccess, ROLE_LABELS,
} from "./ui.js";

const ROLE_ORDER = ["owner", "system_admin", "admin_1", "admin_2", "admin_3", "employee"];
const STATUS_LABELS = { active: "Active", on_leave: "On leave", inactive: "Inactive" };

const EMP_SELECT = "*, department:departments(name), position:positions(title)";
const REQ_SELECT =
  "id, details, start_date, end_date, status, decision_note, decided_at, created_at, employee_id, " +
  "employee:employees(first_name, last_name, employee_no), type:request_types(label)";

async function loadLookups() {
  const sb = ctx.sb;
  const [d, p, t] = await Promise.all([
    sb.from("departments").select("id, name, active").order("name"),
    sb.from("positions").select("id, title, department_id, active").order("title"),
    sb.from("request_types").select("id, code, label, active").order("label"),
  ]);
  for (const r of [d, p, t]) if (r.error) throw r.error;
  return { departments: d.data, positions: p.data, types: t.data };
}

// =====================================================================
// My profile
// =====================================================================
async function renderProfile(box, refresh) {
  const { data, error } = await ctx.sb
    .from("employees")
    .select(EMP_SELECT)
    .eq("user_id", ctx.me.id)
    .maybeSingle();
  if (error) throw error;

  if (!data) {
    box.append(
      el("h3", { text: "Your HR record" }),
      el("p", {
        class: "notice",
        text:
          `Your account isn't linked to an employee record yet. Ask HR to add you using this work email: ${ctx.me.email || "(none)"}. ` +
          "It links automatically once the email matches and is verified.",
      }),
      button("Check again", async () => {
        await ctx.sb.rpc("claim_employee_record");
        await refreshAccess();
        refresh();
      })
    );
    return;
  }

  const row = (k, v) => [el("dt", { text: k }), el("dd", { text: v || "—" })];
  box.append(
    el("h3", { text: fullName(data) }),
    el(
      "dl",
      { class: "facts" },
      row("Employee no.", data.employee_no),
      row("Work email", data.work_email),
      row("Phone", data.phone),
      row("Department", data.department?.name),
      row("Position", data.position?.title),
      row("Hire date", data.hire_date),
      row("Status", STATUS_LABELS[data.status]),
      row("Access level", ROLE_LABELS[ctx.access.role])
    ),
    el("p", { class: "muted", text: "To change any of these, send a “Profile update request” from the Requests tab." })
  );
}

// =====================================================================
// General HR requests (payroll, certificates, profile updates, ...)
// =====================================================================
const datesText = (r) => (!r.start_date && !r.end_date ? "—" : `${r.start_date || "?"} → ${r.end_date || "?"}`);

async function renderRequests(box, refresh) {
  const sb = ctx.sb;
  const access = ctx.access;
  const lookups = await loadLookups();
  const { data, error } = await sb
    .from("requests")
    .select(REQ_SELECT)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;

  const mine = data.filter((r) => r.employee_id === access.employee_id);

  box.append(el("h3", { text: "My requests" }));
  if (access.employee_id) {
    box.append(
      button(
        "+ New request",
        () =>
          openDialog({
            title: "New request",
            submitLabel: "Submit",
            fields: [
              { name: "type_id", label: "Type", type: "select", required: true, options: opts(lookups.types.filter((t) => t.active), "id", "label") },
              { name: "details", label: "Details", type: "textarea" },
              { name: "start_date", label: "Start date (if it applies)", type: "date" },
              { name: "end_date", label: "End date (if it applies)", type: "date" },
            ],
            onSubmit: async (v) => {
              if (v.start_date && v.end_date && v.end_date < v.start_date) return "End date can't be before the start date.";
              const { error: e } = await sb.from("requests").insert({
                employee_id: access.employee_id,
                type_id: Number(v.type_id),
                details: v.details || "",
                start_date: v.start_date,
                end_date: v.end_date,
              });
              if (e) throw e;
              toast("Request sent.", true);
              refresh();
            },
          }),
        "btn btn-primary btn-inline"
      )
    );
  } else {
    box.append(el("p", { class: "notice", text: "You need a linked employee record (My profile tab) before you can send requests." }));
  }

  box.append(
    table(
      ["Type", "Details", "Dates", "Status", "Sent", ""],
      mine.map((r) => [
        r.type?.label || "—",
        el("span", { class: "clip", text: r.details || "—" }),
        datesText(r),
        el("span", {}, statusPill(r.status), r.decision_note ? el("small", { class: "muted", text: " “" + r.decision_note + "”" }) : null),
        when(r.created_at),
        r.status === "pending"
          ? button("Cancel", async () => {
              const { error: e } = await sb.rpc("cancel_request", { req: r.id });
              if (e) return toast(friendly(e));
              refresh();
            })
          : "",
      ]),
      "You haven't sent any requests yet."
    )
  );

  if (can("request.view_all")) {
    const approver = can("request.approve");
    const list = el("div");
    const filter = el(
      "select",
      { class: "inline-select", "aria-label": "Filter by status" },
      el("option", { value: "pending", text: "Pending" }),
      el("option", { value: "all", text: "All" }),
      el("option", { value: "approved", text: "Approved" }),
      el("option", { value: "rejected", text: "Rejected" })
    );
    const draw = () => {
      const f = filter.value;
      const rows = data.filter((r) => f === "all" || r.status === f);
      list.replaceChildren(
        table(
          ["Employee", "Type", "Details", "Dates", "Status", "Sent", ""],
          rows.map((r) => [
            r.employee ? `${fullName(r.employee)} (${r.employee.employee_no})` : "—",
            r.type?.label || "—",
            el("span", { class: "clip", text: r.details || "—" }),
            datesText(r),
            statusPill(r.status),
            when(r.created_at),
            approver && r.status === "pending" && r.employee_id !== access.employee_id
              ? el("span", { class: "row-actions" },
                  button("Approve", () => decide(r, true, refresh), "icon-btn good"),
                  button("Reject", () => decide(r, false, refresh), "icon-btn bad"))
              : "",
          ]),
          "Nothing here."
        )
      );
    };
    filter.addEventListener("change", draw);
    box.append(el("h3", { class: "section" }, "All employee requests ", filter), list);
    draw();
  }
}

function decide(r, approve, refresh) {
  openDialog({
    title: (approve ? "Approve" : "Reject") + " request",
    submitLabel: approve ? "Approve" : "Reject",
    fields: [{ name: "note", label: "Note to the employee (optional)", type: "textarea", maxlength: 500 }],
    onSubmit: async (v) => {
      const { error } = await ctx.sb.rpc("decide_request", { req: r.id, approve, note: v.note });
      if (error) throw error;
      toast(approve ? "Approved." : "Rejected.", true);
      refresh();
    },
  });
}

// =====================================================================
// Employees (directory, add, edit, access levels)
// =====================================================================
async function renderEmployees(box, refresh) {
  const sb = ctx.sb;
  const [emps, roles, lookups] = await Promise.all([
    sb.from("employees").select(EMP_SELECT).order("last_name").limit(1000),
    sb.from("staff_roles").select("user_id, role"),
    loadLookups(),
  ]);
  if (emps.error) throw emps.error;
  if (roles.error) throw roles.error;

  const roleOf = new Map(roles.data.map((r) => [r.user_id, r.role]));
  const canEdit = can("employee.update");
  const canAssign = can("role.assign");

  const formFields = (e = {}) => [
    { name: "first_name", label: "First name", required: true, value: e.first_name },
    { name: "last_name", label: "Last name", required: true, value: e.last_name },
    { name: "work_email", label: "Work email (they sign in with this)", type: "email", required: true, value: e.work_email },
    { name: "phone", label: "Phone", value: e.phone, maxlength: 40 },
    {
      name: "department_id", label: "Department", type: "select",
      value: e.department_id != null ? String(e.department_id) : "",
      options: opts(lookups.departments.filter((d) => d.active || d.id === e.department_id), "id", "name", "— none —"),
    },
    {
      name: "position_id", label: "Position", type: "select",
      value: e.position_id != null ? String(e.position_id) : "",
      options: opts(lookups.positions.filter((p) => p.active || p.id === e.position_id), "id", "title", "— none —"),
    },
    {
      name: "manager_id", label: "Manager", type: "select", value: e.manager_id || "",
      options: opts(
        emps.data.filter((x) => x.id !== e.id && x.status !== "inactive").map((x) => ({ id: x.id, name: fullName(x) })),
        "id", "name", "— none —"
      ),
    },
    { name: "hire_date", label: "Hire date", type: "date", value: e.hire_date },
    {
      name: "status", label: "Status", type: "select", value: e.status || "active",
      options: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
    },
  ];

  const toPayload = (v) => ({
    first_name: v.first_name, last_name: v.last_name, work_email: v.work_email, phone: v.phone,
    department_id: v.department_id ? Number(v.department_id) : null,
    position_id: v.position_id ? Number(v.position_id) : null,
    manager_id: v.manager_id || null, hire_date: v.hire_date, status: v.status,
  });

  if (can("employee.create")) {
    box.append(
      button(
        "+ Add employee",
        () =>
          openDialog({
            title: "Add employee",
            fields: formFields(),
            onSubmit: async (v) => {
              const { error } = await sb.from("employees").insert(toPayload(v));
              if (error) throw error;
              toast("Employee added.", true);
              refresh();
            },
          }),
        "btn btn-primary btn-inline"
      )
    );
  }

  const search = el("input", { type: "search", placeholder: "Search name, email or number", class: "search", maxlength: 100 });
  const list = el("div");
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = emps.data
      .filter((e) => !q || `${fullName(e)} ${e.work_email} ${e.employee_no}`.toLowerCase().includes(q))
      .map((e) => {
        const role = e.user_id ? roleOf.get(e.user_id) || "employee" : null;
        let levelCell;
        if (!e.user_id) levelCell = badge("Not signed up yet");
        else if (canAssign) {
          const select = el(
            "select",
            { class: "inline-select", "aria-label": "Access level" },
            ROLE_ORDER.map((r) => el("option", { value: r, text: ROLE_LABELS[r], selected: r === role }))
          );
          select.addEventListener("change", async () => {
            if (!confirm(`Change ${fullName(e)} to ${ROLE_LABELS[select.value]}?`)) {
              select.value = role;
              return;
            }
            const { error } = await sb.rpc("set_user_role", { target: e.user_id, new_role: select.value });
            if (error) {
              toast(friendly(error));
              select.value = role;
              return;
            }
            toast("Access level updated.", true);
            refresh();
          });
          levelCell = select;
        } else levelCell = badge(ROLE_LABELS[role], role === "employee" ? "" : "info");

        return [
          e.employee_no, fullName(e), e.work_email, e.department?.name || "—", e.position?.title || "—",
          badge(STATUS_LABELS[e.status], e.status === "active" ? "good" : e.status === "inactive" ? "bad" : "warn"),
          levelCell,
          canEdit
            ? button("Edit", () =>
                openDialog({
                  title: "Edit " + fullName(e),
                  fields: formFields(e),
                  onSubmit: async (v) => {
                    const { error } = await sb.from("employees").update(toPayload(v)).eq("id", e.id);
                    if (error) throw error;
                    toast("Saved.", true);
                    refresh();
                  },
                })
              )
            : "",
        ];
      });
    list.replaceChildren(table(["No.", "Name", "Email", "Department", "Position", "Status", "Access level", ""], rows, "No employees found."));
  };
  search.addEventListener("input", draw);
  box.append(search, list);
  draw();

  if (canAssign) {
    box.append(el("p", { class: "muted", text: "Access levels can only be set for people who have signed in. Only an Owner can change them, and there is always at least one Owner." }));
  }
}

// =====================================================================
// HR setup (Owner + System Admin)
// =====================================================================
async function renderSetup(box, refresh) {
  const sb = ctx.sb;
  const l = await loadLookups();
  const deptName = new Map(l.departments.map((d) => [d.id, d.name]));

  const toggle = (tbl, id, active) =>
    button(active ? "Disable" : "Enable", async () => {
      const { error } = await sb.from(tbl).update({ active: !active }).eq("id", id);
      if (error) return toast(friendly(error));
      refresh();
    });

  const section = (title, onAdd, headers, rows) =>
    box.append(el("h3", { class: "section" }, title + " ", button("+ Add", onAdd)), table(headers, rows, "Nothing yet."));

  section(
    "Departments",
    () => openDialog({
      title: "Add department",
      fields: [{ name: "name", label: "Name", required: true, maxlength: 100 }],
      onSubmit: async (v) => {
        const { error } = await sb.from("departments").insert({ name: v.name });
        if (error) throw error;
        refresh();
      },
    }),
    ["Name", "Status", ""],
    l.departments.map((d) => [d.name, badge(d.active ? "Active" : "Disabled", d.active ? "good" : ""), toggle("departments", d.id, d.active)])
  );

  section(
    "Positions",
    () => openDialog({
      title: "Add position",
      fields: [
        { name: "title", label: "Title", required: true, maxlength: 100 },
        { name: "department_id", label: "Department", type: "select", options: opts(l.departments.filter((d) => d.active), "id", "name", "— any —") },
      ],
      onSubmit: async (v) => {
        const { error } = await sb.from("positions").insert({ title: v.title, department_id: v.department_id ? Number(v.department_id) : null });
        if (error) throw error;
        refresh();
      },
    }),
    ["Title", "Department", "Status", ""],
    l.positions.map((p) => [p.title, deptName.get(p.department_id) || "—", badge(p.active ? "Active" : "Disabled", p.active ? "good" : ""), toggle("positions", p.id, p.active)])
  );

  section(
    "Request types",
    () => openDialog({
      title: "Add request type",
      fields: [
        { name: "label", label: "Name shown to employees", required: true, maxlength: 100 },
        { name: "code", label: "Short code (a-z, 0-9, _)", required: true, maxlength: 40 },
      ],
      onSubmit: async (v) => {
        if (!/^[a-z0-9_]{2,40}$/.test(v.code)) return "Code: 2-40 characters, lowercase letters, numbers or _.";
        const { error } = await sb.from("request_types").insert({ label: v.label, code: v.code });
        if (error) throw error;
        refresh();
      },
    }),
    ["Name", "Code", "Status", ""],
    l.types.map((t) => [t.label, t.code, badge(t.active ? "Active" : "Disabled", t.active ? "good" : ""), toggle("request_types", t.id, t.active)])
  );
  box.append(el("p", { class: "muted", text: "Tip: leave requests now have their own Leave section, so you can disable the generic “Leave request” type here." }));
}

// =====================================================================
// Audit log (Owner)
// =====================================================================
async function renderAudit(box) {
  const sb = ctx.sb;
  const [log, emps] = await Promise.all([
    sb.from("audit_log").select("id, user_id, event, details, created_at").order("created_at", { ascending: false }).limit(150),
    sb.from("employees").select("user_id, first_name, last_name").not("user_id", "is", null),
  ]);
  if (log.error) throw log.error;
  const names = new Map((emps.data || []).map((e) => [e.user_id, fullName(e)]));

  box.append(
    el("h3", { text: "Latest 150 events" }),
    table(
      ["When", "Who", "Event", "Details"],
      log.data.map((r) => [
        when(r.created_at),
        r.user_id ? names.get(r.user_id) || r.user_id.slice(0, 8) + "…" : "system",
        r.event,
        el("code", { class: "clip", text: JSON.stringify(r.details).slice(0, 300) }),
      ]),
      "No events yet."
    )
  );
}

// =====================================================================
const tabs = makeTabs("hr-view", [
  { id: "profile", label: "My profile", render: renderProfile },
  { id: "requests", label: "Requests", render: renderRequests },
  { id: "employees", label: "Employees", show: () => can("employee.view_all"), render: renderEmployees },
  { id: "setup", label: "HR setup", show: () => can("hr.config"), render: renderSetup },
  { id: "audit", label: "Audit log", show: () => can("audit.view"), render: renderAudit },
]);

export const showHr = () => tabs.show();
export const stopHr = () => tabs.clear();