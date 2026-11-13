// ---------------------------------------------------------------
// Leave management
//   My leave   : balances, apply, cancel, history           (everyone)
//   Team leave : approvals, who's out, statistics, all leave (HR levels)
//   Policies   : leave types, entitlements, timezone         (Owner, System Admin)
// Rules (balance, overlaps, who may approve) are enforced in the database
// by hr_phase1_schema.sql; this file only shows and sends.
// ---------------------------------------------------------------
import {
  ctx, can, el, toast, friendly, fullName, badge, button, table, opts, openDialog,
  statusPill, makeTabs, todayStr, prettyDate,
} from "../../core/ui.js";

const LEAVE_SELECT =
  "id, employee_id, leave_type_id, start_date, end_date, hours, days, reason, cover_note, status, decision_note, created_at, " +
  "employee:employees(first_name, last_name, employee_no), type:leave_types(name, is_short)";

const num = (n) => String(+Number(n || 0).toFixed(2));
const sum = (list) => list.reduce((a, r) => a + Number(r.days), 0);
const rangeText = (r) => (r.start_date === r.end_date ? prettyDate(r.start_date) : `${prettyDate(r.start_date)} → ${prettyDate(r.end_date)}`);
const amountText = (r) => (r.hours ? `${num(r.hours)} h (${num(r.days)} d)` : `${num(r.days)} d`);

async function loadTypes() {
  const { data, error } = await ctx.sb.from("leave_types").select("*").order("name");
  if (error) throw error;
  return data;
}

function balances(types, reqs, year) {
  return types
    .filter((t) => t.active)
    .map((t) => {
      const inYear = reqs.filter((r) => r.leave_type_id === t.id && Number(r.start_date.slice(0, 4)) === year);
      const used = sum(inYear.filter((r) => r.status === "approved"));
      const pending = sum(inYear.filter((r) => r.status === "pending"));
      return { t, used, pending, left: t.annual_days == null ? null : Math.max(Number(t.annual_days) - used - pending, 0) };
    });
}

function decideDialog(r, approve, refresh) {
  openDialog({
    title: `${approve ? "Approve" : "Reject"} leave: ${fullName(r.employee)}`,
    intro: `${r.type?.name} · ${rangeText(r)} · ${amountText(r)}`,
    submitLabel: approve ? "Approve" : "Reject",
    fields: [{ name: "note", label: "Note to the employee (optional)", type: "textarea", maxlength: 500 }],
    onSubmit: async (v) => {
      const { error } = await ctx.sb.rpc("decide_leave", { req: r.id, approve, note: v.note });
      if (error) throw error;
      toast(approve ? "Leave approved." : "Leave rejected.", true);
      refresh();
    },
  });
}

function cancelDialog(r, refresh, byApprover) {
  openDialog({
    title: "Cancel leave",
    intro: `${byApprover ? fullName(r.employee) + " · " : ""}${r.type?.name} · ${rangeText(r)}`,
    submitLabel: "Cancel this leave",
    fields: byApprover ? [{ name: "note", label: "Reason (shown to the employee)", type: "textarea", maxlength: 500 }] : [],
    onSubmit: async (v) => {
      const { error } = await ctx.sb.rpc("cancel_leave", { req: r.id, note: v.note ?? null });
      if (error) throw error;
      toast("Leave cancelled.", true);
      refresh();
    },
  });
}

// =====================================================================
// My leave
// =====================================================================
async function renderMy(box, refresh) {
  const emp = ctx.access.employee_id;
  if (!emp) {
    box.append(el("p", { class: "notice", text: "Your account isn't linked to an employee record yet, so leave isn't available. See HR → My profile." }));
    return;
  }
  const [types, reqs] = await Promise.all([
    loadTypes(),
    ctx.sb.from("leave_requests").select(LEAVE_SELECT).eq("employee_id", emp).order("start_date", { ascending: false }).limit(300),
  ]);
  if (reqs.error) throw reqs.error;
  const year = Number(todayStr().slice(0, 4));

  box.append(
    el("h3", { text: `My leave balance ${year}` }),
    table(
      ["Leave type", "Entitlement", "Taken", "Pending", "Remaining"],
      balances(types, reqs.data, year).map(({ t, used, pending, left }) => [
        el("span", {}, t.name, " ", t.paid ? null : badge("Unpaid"), t.is_short ? badge("By hours", "info") : null),
        t.annual_days == null ? "Unlimited" : `${num(t.annual_days)} d`,
        `${num(used)} d`,
        pending ? badge(`${num(pending)} d`, "warn") : "—",
        left == null ? "—" : el("strong", { text: `${num(left)} d` }),
      ]),
      "No leave types are set up yet. Ask a System Admin to add them under Policies."
    ),
    button(
      "+ Apply for leave",
      () =>
        openDialog({
          title: "Apply for leave",
          submitLabel: "Submit",
          fields: [
            { name: "type", label: "Leave type", type: "select", required: true, options: opts(types.filter((t) => t.active), "id", "name") },
            { name: "start", label: "First day", type: "date", required: true, value: todayStr() },
            { name: "end", label: "Last day", type: "date", required: true, value: todayStr() },
            { name: "hours", label: "Hours (short leave only, 0.5 to 8)", type: "number", step: "0.5", min: "0.5", max: "8" },
            { name: "reason", label: "Reason", type: "textarea", maxlength: 1000 },
            { name: "cover", label: "Who covers for you? (optional)", maxlength: 300 },
          ],
          onSubmit: async (v) => {
            if (v.end < v.start) return "The last day can't be before the first day.";
            const { error } = await ctx.sb.rpc("apply_leave", {
              p_type: Number(v.type), p_start: v.start, p_end: v.end,
              p_hours: v.hours == null ? null : Number(v.hours),
              p_reason: v.reason || "", p_cover: v.cover,
            });
            if (error) throw error;
            toast("Leave request sent for approval.", true);
            refresh();
          },
        }),
      "btn btn-primary btn-inline"
    ),
    el("h3", { text: "My leave history" }),
    table(
      ["Dates", "Type", "Amount", "Status", "Reason", ""],
      reqs.data.map((r) => {
        const cancellable = r.status === "pending" || (r.status === "approved" && r.start_date > todayStr());
        return [
          rangeText(r),
          r.type?.name || "—",
          amountText(r),
          el("span", {}, statusPill(r.status), r.decision_note ? el("small", { class: "muted", text: " “" + r.decision_note + "”" }) : null),
          el("span", { class: "clip", text: r.reason || "—" }),
          cancellable ? button("Cancel", () => cancelDialog(r, refresh, false)) : "",
        ];
      }),
      "You haven't applied for any leave yet."
    )
  );
}

// =====================================================================
// Team leave (HR levels)
// =====================================================================
async function renderTeam(box, refresh) {
  const { data, error } = await ctx.sb
    .from("leave_requests")
    .select(LEAVE_SELECT)
    .order("start_date", { ascending: false })
    .limit(1000);
  if (error) throw error;

  const myEmp = ctx.access.employee_id;
  const today = todayStr();
  const year = Number(today.slice(0, 4));
  const horizon = todayStr(30);
  const approver = can("leave.approve");

  // 1. Waiting for approval
  const waiting = data.filter((r) => r.status === "pending" && r.employee_id !== myEmp);
  if (approver) {
    box.append(
      el("h3", { text: `Waiting for approval (${waiting.length})` }),
      table(
        ["Employee", "Type", "Dates", "Amount", "Reason", "Cover", ""],
        waiting.map((r) => [
          `${fullName(r.employee)} (${r.employee?.employee_no})`,
          r.type?.name || "—",
          rangeText(r),
          amountText(r),
          el("span", { class: "clip", text: r.reason || "—" }),
          r.cover_note || "—",
          el("span", { class: "row-actions" },
            button("Approve", () => decideDialog(r, true, refresh), "icon-btn good"),
            button("Reject", () => decideDialog(r, false, refresh), "icon-btn bad")),
        ]),
        "Nothing is waiting for approval."
      )
    );
  }

  // 2. Who is out now / in the next 30 days (approved leave)
  const upcoming = data
    .filter((r) => r.status === "approved" && r.end_date >= today && r.start_date <= horizon)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  box.append(
    el("h3", { class: "section", text: "Out now and in the next 30 days" }),
    table(
      ["Employee", "Dates", "Type", "Cover"],
      upcoming.map((r) => [
        el("span", {}, fullName(r.employee), r.start_date <= today ? badge("Out today", "warn") : null),
        rangeText(r), r.type?.name || "—", r.cover_note || "—",
      ]),
      "Nobody is on approved leave in this period."
    )
  );

  // 3. Statistics for this year
  const inYear = data.filter((r) => Number(r.start_date.slice(0, 4)) === year);
  const byEmp = new Map();
  for (const r of inYear) {
    const s = byEmp.get(r.employee_id) || { e: r.employee, approved: 0, pending: 0, count: 0 };
    if (r.status === "approved") { s.approved += Number(r.days); s.count++; }
    if (r.status === "pending") s.pending += Number(r.days);
    byEmp.set(r.employee_id, s);
  }
  const stats = [...byEmp.values()].filter((s) => s.approved || s.pending).sort((a, b) => b.approved - a.approved);
  box.append(
    el("h3", { class: "section", text: `Leave statistics ${year}` }),
    table(
      ["Employee", "Approved days", "Approved requests", "Pending days"],
      stats.map((s) => [fullName(s.e), `${num(s.approved)} d`, String(s.count), s.pending ? badge(`${num(s.pending)} d`, "warn") : "—"]),
      "No leave recorded this year."
    )
  );

  // 4. Everything, filterable
  const status = el("select", { class: "inline-select", "aria-label": "Filter by status" },
    ["all", "pending", "approved", "rejected", "cancelled"].map((v) => el("option", { value: v, text: v === "all" ? "All statuses" : v[0].toUpperCase() + v.slice(1) })));
  const search = el("input", { type: "search", class: "search inline", placeholder: "Search employee", maxlength: 100 });
  const list = el("div");
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = data
      .filter((r) => (status.value === "all" || r.status === status.value) && (!q || fullName(r.employee).toLowerCase().includes(q)))
      .slice(0, 300)
      .map((r) => [
        fullName(r.employee), r.type?.name || "—", rangeText(r), amountText(r),
        el("span", {}, statusPill(r.status), r.decision_note ? el("small", { class: "muted", text: " “" + r.decision_note + "”" }) : null),
        approver && (r.status === "pending" || r.status === "approved") ? button("Cancel", () => cancelDialog(r, refresh, true)) : "",
      ]);
    list.replaceChildren(table(["Employee", "Type", "Dates", "Amount", "Status", ""], rows, "No leave matches."));
  };
  status.addEventListener("change", draw);
  search.addEventListener("input", draw);
  box.append(el("h3", { class: "section" }, "All leave ", status, search), list);
  draw();
}

// =====================================================================
// Policies (Owner + System Admin)
// =====================================================================
async function renderPolicies(box, refresh) {
  const types = await loadTypes();

  box.append(
    el("h3", { class: "section" }, "Leave types ",
      button("+ Add", () =>
        openDialog({
          title: "Add leave type",
          fields: [
            { name: "name", label: "Name", required: true, maxlength: 100 },
            { name: "code", label: "Short code (a-z, 0-9, _)", required: true, maxlength: 40 },
            { name: "annual_days", label: "Days per year (empty = unlimited)", type: "number", step: "0.5", min: "0" },
            { name: "paid", label: "Paid leave", type: "checkbox", value: true },
            { name: "is_short", label: "Requested by hours on a single day (short leave)", type: "checkbox" },
          ],
          onSubmit: async (v) => {
            if (!/^[a-z0-9_]{2,40}$/.test(v.code)) return "Code: 2-40 characters, lowercase letters, numbers or _.";
            const { error } = await ctx.sb.from("leave_types").insert({
              code: v.code, name: v.name, paid: v.paid, is_short: v.is_short,
              annual_days: v.annual_days == null ? null : Number(v.annual_days),
            });
            if (error) throw error;
            refresh();
          },
        }))),
    table(
      ["Name", "Code", "Days per year", "Paid", "Type", "Status", ""],
      types.map((t) => [
        t.name, t.code, t.annual_days == null ? "Unlimited" : num(t.annual_days),
        t.paid ? "Yes" : "No", t.is_short ? "By hours" : "By days",
        badge(t.active ? "Active" : "Disabled", t.active ? "good" : ""),
        button("Edit", () =>
          openDialog({
            title: "Edit " + t.name,
            fields: [
              { name: "name", label: "Name", required: true, value: t.name, maxlength: 100 },
              { name: "annual_days", label: "Days per year (empty = unlimited)", type: "number", step: "0.5", min: "0", value: t.annual_days },
              { name: "paid", label: "Paid leave", type: "checkbox", value: t.paid },
              { name: "active", label: "Available to employees", type: "checkbox", value: t.active },
            ],
            onSubmit: async (v) => {
              const { error } = await ctx.sb.from("leave_types").update({
                name: v.name, paid: v.paid, active: v.active,
                annual_days: v.annual_days == null ? null : Number(v.annual_days),
              }).eq("id", t.id);
              if (error) throw error;
              refresh();
            },
          })),
      ]),
      "No leave types yet."
    ),
    el("p", { class: "muted", text: "Starter values were added for you; change them to match your company policy. Balances count pending and approved leave. Weekends are skipped; public holidays aren't modelled yet." }),

    el("h3", { class: "section" }, "Company timezone ",
      button("Change", () =>
        openDialog({
          title: "Company timezone",
          intro: "Decides which calendar day a clock-in belongs to. Use an IANA name such as Asia/Manila.",
          fields: [{ name: "tz", label: "Timezone", required: true, value: ctx.tz, maxlength: 60 }],
          onSubmit: async (v) => {
            const { error } = await ctx.sb.rpc("set_company_timezone", { tz: v.tz });
            if (error) throw error;
            ctx.tz = v.tz;
            toast("Timezone updated.", true);
            refresh();
          },
        }))),
    el("p", { text: ctx.tz })
  );
}

// =====================================================================
const tabs = makeTabs("leave-view", [
  { id: "my", label: "My leave", render: renderMy },
  { id: "team", label: "Team leave", show: () => can("leave.view_all"), render: renderTeam },
  { id: "policies", label: "Policies", show: () => can("hr.config"), render: renderPolicies },
]);

export const showLeave = (tab) => tabs.show(tab, false);
export const stopLeave = () => tabs.clear();
