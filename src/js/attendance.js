// ---------------------------------------------------------------
// Attendance management
//   My attendance   : month summary, my records, overtime requests (everyone)
//   Team attendance : summaries, records, manual entries/adjustments,
//                     overtime approvals                            (HR levels)
//   Shifts          : shift rules (Owner, System Admin) and
//                     who works which shift (Admin 1-2, Owner)
// Clocking uses the server clock; rounding and grace rules are applied by
// the database report (hr_phase1_schema.sql).
// ---------------------------------------------------------------
import {
  ctx, can, el, toast, friendly, fullName, badge, button, table, opts, openDialog, statusPill,
  makeTabs, todayStr, prettyDate, timeOf, hoursText, zonedToIso, isoToZoned,
} from "./ui.js";

const num = (n) => String(+Number(n || 0).toFixed(2));
const monthStart = () => todayStr().slice(0, 8) + "01";
const mins = (r) => (r.clock_out ? (new Date(r.clock_out) - new Date(r.clock_in)) / 60000 : null);

function statCard(label, value, hint) {
  return el("div", { class: "stat" }, el("div", { class: "stat-value", text: value }), el("div", { class: "stat-label", text: label }), hint ? el("small", { class: "muted", text: hint }) : null);
}

function recordRows(list, editFor) {
  return list.map((r) => [
    prettyDate(r.work_date),
    timeOf(r.clock_in),
    r.clock_out ? timeOf(r.clock_out) : badge("Still clocked in", "warn"),
    r.clock_out ? hoursText(mins(r)) : "—",
    el("span", { class: "clip", text: [r.in_comment, r.out_comment].filter(Boolean).join(" / ") || "—" }),
    r.source === "manual" ? badge("Manual", "info") : "Clock",
    editFor ? editFor(r) : "",
  ]);
}

// =====================================================================
// My attendance
// =====================================================================
async function renderMy(box, refresh) {
  const emp = ctx.access.employee_id;
  if (!emp) {
    box.append(el("p", { class: "notice", text: "Your account isn't linked to an employee record yet, so attendance isn't available. See HR → My profile." }));
    return;
  }
  const sb = ctx.sb;
  const [recs, sum, ot] = await Promise.all([
    sb.from("attendance_records").select("*").eq("employee_id", emp).gte("work_date", todayStr(-45)).order("clock_in", { ascending: false }).limit(200),
    sb.rpc("attendance_summary", { p_from: monthStart(), p_to: todayStr() }),
    sb.from("overtime_requests").select("*").eq("employee_id", emp).order("work_date", { ascending: false }).limit(60),
  ]);
  for (const r of [recs, sum, ot]) if (r.error) throw r.error;
  const me = (sum.data || []).find((s) => s.employee_id === emp) || {};

  box.append(
    el("h3", { text: "This month" }),
    el("div", { class: "stats" },
      statCard("Days present", String(me.days_present ?? 0)),
      statCard("Late arrivals", String(me.late_days ?? 0), "after the shift grace period"),
      statCard("Hours worked", hoursText(me.worked_minutes)),
      statCard("Approved overtime", `${num(me.overtime_hours)} h`)
    ),
    el("p", { class: "muted", text: "Clock in and out from the Home page." }),
    el("h3", { class: "section", text: "My records (last 45 days)" }),
    table(["Date", "In", "Out", "Worked", "Comments", "Source", ""], recordRows(recs.data), "No attendance records yet.")
  );

  box.append(
    el("h3", { class: "section" }, "My overtime ",
      button("+ Apply for overtime", () =>
        openDialog({
          title: "Apply for overtime",
          submitLabel: "Submit",
          fields: [
            { name: "work_date", label: "Date worked", type: "date", required: true, value: todayStr() },
            { name: "hours", label: "Hours (0.25 to 16)", type: "number", step: "0.25", min: "0.25", max: "16", required: true },
            { name: "reason", label: "Reason", type: "textarea", maxlength: 500 },
          ],
          onSubmit: async (v) => {
            const { error } = await sb.from("overtime_requests").insert({
              employee_id: emp, work_date: v.work_date, hours: Number(v.hours), reason: v.reason || "",
            });
            if (error) {
              if (error.code === "23505") return "You already have an open overtime request for that date.";
              throw error;
            }
            toast("Overtime request sent.", true);
            refresh();
          },
        }))),
    table(
      ["Date", "Hours", "Reason", "Status", ""],
      ot.data.map((o) => [
        prettyDate(o.work_date), num(o.hours), el("span", { class: "clip", text: o.reason || "—" }),
        el("span", {}, statusPill(o.status), o.decision_note ? el("small", { class: "muted", text: " “" + o.decision_note + "”" }) : null),
        o.status === "pending"
          ? button("Cancel", async () => {
              const { error } = await sb.rpc("cancel_overtime", { req: o.id });
              if (error) return toast(friendly(error));
              refresh();
            })
          : "",
      ]),
      "No overtime requests."
    )
  );
}

// =====================================================================
// Team attendance
// =====================================================================
const team = { from: null, to: null, emp: null }; // remembered between refreshes

function adjustDialog(employee, rec, refresh) {
  openDialog({
    title: (rec ? "Adjust attendance: " : "Manual entry: ") + fullName(employee),
    intro: `Times are in the company timezone (${ctx.tz}). Every change is written to the audit log.`,
    fields: [
      { name: "in", label: "Clock in", type: "datetime-local", required: true, value: rec ? isoToZoned(rec.clock_in) : `${todayStr()}T08:00` },
      { name: "out", label: "Clock out (empty = still in)", type: "datetime-local", value: rec ? isoToZoned(rec.clock_out) : "" },
      { name: "reason", label: "Reason", required: true, maxlength: 300 },
    ],
    onSubmit: async (v) => {
      const inIso = zonedToIso(v.in);
      const outIso = v.out ? zonedToIso(v.out) : null;
      if (outIso && outIso <= inIso) return "Clock out must be after clock in.";
      const { error } = await ctx.sb.rpc("adjust_attendance", {
        emp: employee.id, rec: rec ? rec.id : null, p_in: inIso, p_out: outIso, reason: v.reason,
      });
      if (error) throw error;
      toast("Attendance saved.", true);
      refresh();
    },
  });
}

function overtimeDecision(o, approve, refresh) {
  openDialog({
    title: `${approve ? "Approve" : "Reject"} overtime: ${fullName(o.employee)}`,
    intro: `${prettyDate(o.work_date)} · ${num(o.hours)} h`,
    submitLabel: approve ? "Approve" : "Reject",
    fields: [{ name: "note", label: "Note (optional)", type: "textarea", maxlength: 500 }],
    onSubmit: async (v) => {
      const { error } = await ctx.sb.rpc("decide_overtime", { req: o.id, approve, note: v.note });
      if (error) throw error;
      toast(approve ? "Overtime approved." : "Overtime rejected.", true);
      refresh();
    },
  });
}

async function renderTeam(box, refresh) {
  const sb = ctx.sb;
  team.from ||= monthStart();
  team.to ||= todayStr();

  const [sum, pendingOt] = await Promise.all([
    sb.rpc("attendance_summary", { p_from: team.from, p_to: team.to }),
    sb.from("overtime_requests").select("*, employee:employees(first_name, last_name)").eq("status", "pending").order("work_date"),
  ]);
  if (sum.error) throw sum.error;
  if (pendingOt.error) throw pendingOt.error;

  // date range
  const from = el("input", { type: "date", value: team.from, "aria-label": "From" });
  const to = el("input", { type: "date", value: team.to, "aria-label": "To" });
  box.append(
    el("div", { class: "filters" },
      el("label", {}, "From ", from), el("label", {}, "To ", to),
      button("Show", () => {
        if (!from.value || !to.value || to.value < from.value) return toast("Choose a valid date range.");
        team.from = from.value;
        team.to = to.value;
        team.emp = null;
        refresh();
      }, "btn btn-primary btn-inline"))
  );

  // summary
  box.append(
    el("h3", { text: "Attendance summary" }),
    table(
      ["Employee", "Days present", "Late", "Hours worked", "No clock-out", "Approved OT", ""],
      sum.data.map((s) => [
        `${s.employee_name} (${s.employee_no})`,
        String(s.days_present),
        s.late_days ? badge(String(s.late_days), "warn") : "0",
        hoursText(s.worked_minutes),
        s.missing_clock_out ? badge(String(s.missing_clock_out), "bad") : "0",
        `${num(s.overtime_hours)} h`,
        button("Records", () => { team.emp = s.employee_id; refresh(); }),
      ]),
      "No employees."
    )
  );

  // overtime approvals
  if (can("overtime.approve")) {
    const myEmp = ctx.access.employee_id;
    const waiting = pendingOt.data.filter((o) => o.employee_id !== myEmp);
    box.append(
      el("h3", { class: "section", text: `Overtime waiting for approval (${waiting.length})` }),
      table(
        ["Employee", "Date", "Hours", "Reason", ""],
        waiting.map((o) => [
          fullName(o.employee), prettyDate(o.work_date), num(o.hours), el("span", { class: "clip", text: o.reason || "—" }),
          el("span", { class: "row-actions" },
            button("Approve", () => overtimeDecision(o, true, refresh), "icon-btn good"),
            button("Reject", () => overtimeDecision(o, false, refresh), "icon-btn bad")),
        ]),
        "No overtime is waiting."
      )
    );
  }

  // one employee's records
  if (team.emp) {
    const s = sum.data.find((x) => x.employee_id === team.emp);
    const { data: recs, error } = await sb
      .from("attendance_records").select("*").eq("employee_id", team.emp)
      .gte("work_date", team.from).lte("work_date", team.to).order("clock_in", { ascending: false }).limit(300);
    if (error) throw error;
    const person = { id: team.emp, first_name: (s?.employee_name || "").split(" ")[0], last_name: (s?.employee_name || "").split(" ").slice(1).join(" ") };
    const canEdit = can("attendance.edit") && team.emp !== ctx.access.employee_id;
    box.append(
      el("h3", { class: "section" }, `Records: ${s?.employee_name || ""} `,
        canEdit ? button("+ Manual entry", () => adjustDialog(person, null, refresh)) : null,
        button("Close", () => { team.emp = null; refresh(); })),
      table(["Date", "In", "Out", "Worked", "Comments", "Source", ""], recordRows(recs, canEdit ? (r) => button("Adjust", () => adjustDialog(person, r, refresh)) : null), "No records in this range.")
    );
    if (can("attendance.edit") && !canEdit) box.append(el("p", { class: "muted", text: "You can't edit your own attendance; ask another admin." }));
  }
}

// =====================================================================
// Shifts
// =====================================================================
const ROUNDING = [0, 5, 10, 15, 30];

function shiftFields(s = {}) {
  return [
    { name: "name", label: "Name", required: true, value: s.name, maxlength: 100 },
    { name: "start", label: "Starts", type: "time", required: true, value: (s.start_time || "08:00").slice(0, 5) },
    { name: "end", label: "Ends", type: "time", required: true, value: (s.end_time || "17:00").slice(0, 5) },
    { name: "grace", label: "Grace period before “late” (minutes)", type: "number", min: "0", max: "120", required: true, value: s.grace_minutes ?? 10 },
    {
      name: "rounding", label: "Round worked time to", type: "select", value: String(s.rounding_minutes ?? 0),
      options: ROUNDING.map((m) => ({ value: String(m), label: m === 0 ? "No rounding" : `${m} minutes` })),
    },
  ];
}

async function renderShifts(box, refresh) {
  const sb = ctx.sb;
  const [shifts, emps, assigned] = await Promise.all([
    sb.from("shifts").select("*").order("start_time"),
    can("attendance.edit") ? sb.from("employees").select("id, first_name, last_name, employee_no, status").order("last_name") : { data: [] },
    can("attendance.edit") ? sb.from("employee_shifts").select("employee_id, shift_id") : { data: [] },
  ]);
  for (const r of [shifts, emps, assigned]) if (r.error) throw r.error;

  if (can("hr.config")) {
    box.append(
      el("h3", { class: "section" }, "Shift rules ",
        button("+ Add", () =>
          openDialog({
            title: "Add shift",
            fields: shiftFields(),
            onSubmit: async (v) => {
              const { error } = await sb.from("shifts").insert({
                name: v.name, start_time: v.start, end_time: v.end,
                grace_minutes: Number(v.grace), rounding_minutes: Number(v.rounding),
              });
              if (error) throw error;
              refresh();
            },
          }))),
      table(
        ["Name", "Hours", "Grace", "Rounding", "Status", ""],
        shifts.data.map((s) => [
          s.name, `${s.start_time.slice(0, 5)} – ${s.end_time.slice(0, 5)}`, `${s.grace_minutes} min`,
          s.rounding_minutes ? `${s.rounding_minutes} min` : "None",
          badge(s.active ? "Active" : "Disabled", s.active ? "good" : ""),
          el("span", { class: "row-actions" },
            button("Edit", () =>
              openDialog({
                title: "Edit shift",
                fields: shiftFields(s),
                onSubmit: async (v) => {
                  const { error } = await sb.from("shifts").update({
                    name: v.name, start_time: v.start, end_time: v.end,
                    grace_minutes: Number(v.grace), rounding_minutes: Number(v.rounding),
                  }).eq("id", s.id);
                  if (error) throw error;
                  refresh();
                },
              })),
            button(s.active ? "Disable" : "Enable", async () => {
              const { error } = await sb.from("shifts").update({ active: !s.active }).eq("id", s.id);
              if (error) return toast(friendly(error));
              refresh();
            })),
        ]),
        "No shifts yet."
      )
    );
  }

  if (can("attendance.edit")) {
    const current = new Map(assigned.data.map((a) => [a.employee_id, a.shift_id]));
    const active = shifts.data.filter((s) => s.active);
    box.append(
      el("h3", { class: "section", text: "Who works which shift" }),
      table(
        ["Employee", "Shift"],
        emps.data.filter((e) => e.status !== "inactive").map((e) => {
          const select = el("select", { class: "inline-select", "aria-label": "Shift for " + fullName(e) },
            [{ value: "", label: "— none —" }, ...opts(active, "id", "name")].map((o) => el("option", { value: o.value, text: o.label, selected: String(current.get(e.id) ?? "") === o.value })));
          select.addEventListener("change", async () => {
            const { error } = await sb.rpc("assign_shift", { emp: e.id, shift: select.value ? Number(select.value) : null });
            if (error) {
              toast(friendly(error));
              select.value = String(current.get(e.id) ?? "");
              return;
            }
            current.set(e.id, select.value ? Number(select.value) : undefined);
            toast("Shift saved.", true);
          });
          return [`${fullName(e)} (${e.employee_no})`, select];
        }),
        "No employees."
      )
    );
  }
}

// =====================================================================
const tabs = makeTabs("attendance-view", [
  { id: "my", label: "My attendance", render: renderMy },
  { id: "team", label: "Team attendance", show: () => can("attendance.view_all"), render: renderTeam },
  { id: "shifts", label: "Shifts", show: () => can("hr.config") || can("attendance.edit"), render: renderShifts },
]);

export const showAttendance = () => tabs.show();
export const stopAttendance = () => {
  team.from = team.to = team.emp = null;
  tabs.clear();
};