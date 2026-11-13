// ---------------------------------------------------------------
// Home: clock in/out, leave balance, quick actions, request tracker,
// things waiting for me, and (HR levels) who is out today.
// Every widget only shows what the database already lets this person see.
// ---------------------------------------------------------------
import {
  ctx, can, el, icon, toast, friendly, fullName, badge, statusPill, button, makeTabs,
  todayStr, timeOf, navigate, prettyDate,
} from "../../core/ui.js";

let clockTimer = null;
const stopTimer = () => {
  clearInterval(clockTimer);
  clockTimer = null;
};

const num = (n) => String(+Number(n || 0).toFixed(2));

const TIPS = [
  "Clock in as soon as you start. Late is measured from your shift start plus the grace period.",
  "Need to leave early? Apply for short leave by the hour instead of a full day.",
  "Pending requests can still be cancelled. Approved ones need HR.",
  "Press Ctrl + K to jump to any page or action.",
  "Forgot to clock out? Ask HR for an adjustment and give a reason.",
];

function card(iconName, title, subtitle, ...kids) {
  return el(
    "section",
    { class: "card" },
    el("div", { class: "card-head" },
      el("span", { class: "tile" }, icon(iconName, 20)),
      el("div", {}, el("h2", { text: title }), subtitle ? el("p", { class: "muted", text: subtitle }) : null)
    ),
    ...kids
  );
}

function workRow(label, count, go, kind = "warn") {
  return el("button", { type: "button", class: "work-row", onclick: go },
    el("span", { text: label }), badge(String(count), count ? kind : ""));
}

function quick(iconName, label, go) {
  return el("button", { type: "button", class: "quick", onclick: go },
    el("span", { class: "tile" }, icon(iconName, 20)), el("span", { text: label }));
}

async function renderHome(box) {
  stopTimer();
  const sb = ctx.sb;
  const emp = ctx.access.employee_id;
  const today = todayStr();
  const year = Number(today.slice(0, 4));
  const none = { data: [], error: null };
  const recent = (table, cols) =>
    emp ? sb.from(table).select(cols).eq("employee_id", emp).order("created_at", { ascending: false }).limit(5) : none;

  const [shift, recs, types, leaves, work, myLeave, myOt, myReq, outToday] = await Promise.all([
    emp ? sb.from("employee_shifts").select("shift:shifts(name, start_time, end_time, grace_minutes)").eq("employee_id", emp).maybeSingle() : { data: null, error: null },
    emp ? sb.from("attendance_records").select("*").eq("employee_id", emp).eq("work_date", today).order("clock_in", { ascending: false }) : none,
    sb.from("leave_types").select("*").eq("active", true).order("name"),
    emp ? sb.from("leave_requests").select("leave_type_id, start_date, days, status").eq("employee_id", emp).in("status", ["pending", "approved"]) : none,
    sb.rpc("my_pending_work"),
    recent("leave_requests", "id, start_date, end_date, status, created_at, type:leave_types(name)"),
    recent("overtime_requests", "id, work_date, hours, status, created_at"),
    recent("requests", "id, status, created_at, type:request_types(label)"),
    can("leave.view_all")
      ? sb.from("leave_requests").select("start_date, end_date, hours, type:leave_types(name), employee:employees(first_name, last_name)").eq("status", "approved").lte("start_date", today).gte("end_date", today)
      : none,
  ]);
  for (const r of [shift, recs, types, leaves, work, myLeave, myOt, myReq, outToday]) if (r.error) throw r.error;

  const cols = [el("div", { class: "col" }), el("div", { class: "col" }), el("div", { class: "col" })];
  box.append(el("div", { class: "dash" }, ...cols));

  let leaveLeft = null;
  let todayLine = ["—", "No clock record yet"];

  if (!emp) {
    cols[0].append(
      card("user", "Welcome", null,
        el("p", { class: "notice", text: `Your account (${ctx.me.email}) isn't linked to an employee record yet. Ask HR to add you with this work email; it links automatically.` }))
    );
  }

  // ----- column 1: clock + leave balance
  if (emp) {
    const list = recs.data; // newest first
    const open = list.find((r) => !r.clock_out);
    const s = shift.data?.shift;
    const comment = el("input", { type: "text", placeholder: "Add a comment (optional)", maxlength: 300, "aria-label": "Comment" });
    const clock = el("span", { class: "big-clock" });
    const tick = () => {
      clock.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: ctx.tz });
    };
    tick();
    clockTimer = setInterval(tick, 1000);

    const btn = el("button", { type: "button", class: "btn btn-primary clock-btn", text: open ? "Clock out" : "Clock in" });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const { data, error } = await sb.rpc("clock_in_out", { note: comment.value.trim() || null });
      if (error) {
        btn.disabled = false;
        return toast(friendly(error));
      }
      toast(data?.action === "out" ? "Clocked out. See you soon!" : "Clocked in. Have a great day!", true);
      renderAgain();
    });

    const last = list[0];
    todayLine = open ? ["In", `Since ${timeOf(open.clock_in)}`] : last?.clock_out ? ["Out", `Left at ${timeOf(last.clock_out)}`] : ["—", "Not clocked in today"];
    cols[0].append(
      card("clock", "Clock in / out", "Record your in and out times",
        el("div", { class: "clock-box" },
          clock,
          el("p", { class: open ? "ok-text" : "muted", text: open ? `Clocked in since ${timeOf(open.clock_in)}` : last?.clock_out ? `Last clocked out at ${timeOf(last.clock_out)}` : "Not clocked in today" }),
          el("p", { class: "muted small", text: s ? `Shift ${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)} · ${s.name}` : "No shift assigned yet" })),
        comment,
        btn,
        el("div", { class: "card-foot" }, button("View attendance history", () => navigate("attendance"), "link-btn"))
      )
    );

    const rows = types.data
      .filter((t) => t.annual_days != null)
      .map((t) => {
        const used = leaves.data
          .filter((r) => r.leave_type_id === t.id && Number(r.start_date.slice(0, 4)) === year)
          .reduce((a, r) => a + Number(r.days), 0);
        return { t, left: Math.max(Number(t.annual_days) - used, 0) };
      });
    leaveLeft = rows.reduce((a, r) => a + r.left, 0);
    cols[0].append(
      card("calendar", "Leave balance", `Remaining for ${year}`,
        rows.length
          ? el("ul", { class: "balance-list" }, rows.map(({ t, left }) => {
              const pct = Number(t.annual_days) ? Math.round((left / Number(t.annual_days)) * 100) : 0;
              return el("li", {},
                el("div", { class: "bal-top" }, el("span", { text: t.name }), el("strong", { text: `${num(left)} / ${num(t.annual_days)} d` })),
                el("div", { class: "bar" }, el("i", { style: `width:${pct}%` })));
            }))
          : el("p", { class: "empty-state small", text: "No leave types set up yet." }),
        el("div", { class: "card-foot" }, button("Apply for leave", () => navigate("leave", "my"), "btn btn-primary btn-inline"))
      )
    );
  }

  // ----- column 2: quick actions, request tracker, tip
  cols[1].append(
    card("plus", "Quick actions", null,
      el("div", { class: "quick-grid" },
        quick("calendar", "Apply for leave", () => navigate("leave", "my")),
        quick("clock", "Request overtime", () => navigate("attendance", "my")),
        quick("doc", "New request", () => navigate("requests")),
        quick("chat", "Messages", () => navigate("chat"))))
  );

  const tracker = [
    ...myLeave.data.map((r) => ({ at: r.created_at, kind: "Leave", icon: "calendar", text: `${r.type?.name || "Leave"} · ${prettyDate(r.start_date)}`, status: r.status, go: () => navigate("leave", "my") })),
    ...myOt.data.map((r) => ({ at: r.created_at, kind: "Overtime", icon: "clock", text: `${num(r.hours)} h · ${prettyDate(r.work_date)}`, status: r.status, go: () => navigate("attendance", "my") })),
    ...myReq.data.map((r) => ({ at: r.created_at, kind: "Request", icon: "doc", text: r.type?.label || "HR request", status: r.status, go: () => navigate("requests") })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 6);
  cols[1].append(
    card("list", "Request tracker", "Your latest requests and their status",
      tracker.length
        ? el("ul", { class: "tracker" }, tracker.map((t) =>
            el("li", {}, el("button", { type: "button", class: "track-row", onclick: t.go },
              el("span", { class: "tile sm" }, icon(t.icon, 16)),
              el("span", { class: "track-text" }, el("strong", { text: t.kind }), el("small", { class: "muted", text: t.text })),
              statusPill(t.status)))))
        : el("p", { class: "empty-state small", text: "No requests yet." }))
  );

  const tip = TIPS[Number(today.slice(8)) % TIPS.length];
  cols[1].append(card("sun", "Tip of the day", null, el("p", { text: tip })));

  // ----- column 3: workflow items + out today
  const w = work.data?.[0] || {};
  const items = [];
  if (can("leave.approve")) items.push(workRow("Leave approvals", Number(w.leave_pending || 0), () => navigate("leave", "team")));
  if (can("overtime.approve")) items.push(workRow("Overtime approvals", Number(w.overtime_pending || 0), () => navigate("attendance", "team")));
  if (can("request.approve")) items.push(workRow("HR request approvals", Number(w.requests_pending || 0), () => navigate("requests")));
  const pend = (a) => a.filter((r) => r.status === "pending").length;
  cols[2].append(
    card("checkCircle", "My workflow items", items.length ? "Waiting for your decision, and your own pending requests" : "Your own pending requests",
      ...(items.length ? [el("h3", { text: "Awaiting my approval" }), ...items, el("h3", { text: "My requests" })] : []),
      workRow("My pending leave", pend(myLeave.data), () => navigate("leave", "my"), "info"),
      workRow("My pending overtime", pend(myOt.data), () => navigate("attendance", "my"), "info"),
      workRow("My pending HR requests", pend(myReq.data), () => navigate("requests"), "info"))
  );

  if (can("leave.view_all")) {
    cols[2].append(
      card("users", "Out today", "Approved leave covering today",
        outToday.data.length
          ? el("ul", { class: "balance-list plain" }, outToday.data.map((r) =>
              el("li", { class: "out-row" }, el("span", { text: fullName(r.employee) }), el("small", { class: "muted", text: r.hours ? `${num(r.hours)} h · ${r.type?.name}` : r.type?.name }))))
          : el("p", { class: "empty-state small", text: "Everyone is in today." }),
        el("div", { class: "card-foot" }, button("Team leave", () => navigate("leave", "team"), "link-btn")))
    );
  }

  // ----- pastel summary row on top
  const w2 = work.data?.[0] || {};
  const waiting = (can("leave.approve") ? Number(w2.leave_pending || 0) : 0) + (can("overtime.approve") ? Number(w2.overtime_pending || 0) : 0) + (can("request.approve") ? Number(w2.requests_pending || 0) : 0);
  const isApprover = can("leave.approve") || can("overtime.approve") || can("request.approve");
  const mine = pend(myLeave.data) + pend(myOt.data) + pend(myReq.data);
  const stat = (cls, iconName, label, value, note) =>
    el("div", { class: "stat-card " + cls },
      el("div", { class: "stat-top" }, el("span", { class: "stat-icon" }, icon(iconName, 22)), el("div", {}, el("small", { text: label }), el("strong", { text: value }))),
      el("p", { text: note }));
  box.insertBefore(
    el("div", { class: "stat-row" },
      stat("mint", "clock", "Today", todayLine[0], todayLine[1]),
      stat("sun", "calendar", "Leave left", leaveLeft == null ? "—" : `${num(leaveLeft)} d`, `Across all leave types in ${year}`),
      stat("lilac", "doc", "My pending", String(mine), mine ? "Waiting for a decision" : "Nothing waiting"),
      isApprover
        ? stat("sky", "checkCircle", "To approve", String(waiting), waiting ? "Waiting for your decision" : "All caught up")
        : stat("sky", "users", "Out today", can("leave.view_all") ? String(outToday.data.length) : "—", can("leave.view_all") ? "Approved leave today" : "Visible to HR only")),
    box.firstChild
  );
}

let renderAgain = () => {};
const tabs = makeTabs("home-view", [{ id: "home", label: "Home", render: renderHome }]);
renderAgain = () => tabs.show();

export const showHome = () => tabs.show();
export const stopHome = () => {
  stopTimer();
  tabs.clear();
};
