// ---------------------------------------------------------------
// Home dashboard: clock in/out, leave balances, things waiting for me,
// and (for HR levels) who is out today. Every widget only shows what
// the database already lets this person see.
// ---------------------------------------------------------------
import {
  ctx, can, el, toast, friendly, fullName, badge, button, makeTabs, todayStr, timeOf, navigate, prettyDate,
} from "./ui.js";

let clockTimer = null;
const stopTimer = () => {
  clearInterval(clockTimer);
  clockTimer = null;
};

const num = (n) => String(+Number(n || 0).toFixed(2));

function widget(title, subtitle, ...kids) {
  return el(
    "section",
    { class: "widget" },
    el("h2", { text: title }),
    subtitle ? el("p", { class: "muted", text: subtitle }) : null,
    ...kids
  );
}

function workRow(label, count, section, kind = "warn") {
  return el(
    "button",
    { type: "button", class: "work-row", onclick: () => navigate(section) },
    el("span", { text: label }),
    badge(String(count), count ? kind : "")
  );
}

function greeting(name) {
  const hour = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: ctx.tz })) % 24;
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${part}, ${name}`;
}

async function renderHome(box) {
  stopTimer();
  const sb = ctx.sb;
  const access = ctx.access;
  const emp = access.employee_id;
  const today = todayStr();
  const year = Number(today.slice(0, 4));
  const none = { data: [], error: null };
  const mineOnly = (table) => (emp ? sb.from(table).select("id").eq("employee_id", emp).eq("status", "pending") : none);

  const [me, shift, recs, types, leaves, work, myLeave, myOt, myReq, outToday] = await Promise.all([
    emp ? sb.from("employees").select("first_name, last_name").eq("id", emp).maybeSingle() : { data: null, error: null },
    emp ? sb.from("employee_shifts").select("shift:shifts(name, start_time, end_time, grace_minutes)").eq("employee_id", emp).maybeSingle() : { data: null, error: null },
    emp ? sb.from("attendance_records").select("*").eq("employee_id", emp).eq("work_date", today).order("clock_in", { ascending: false }) : none,
    sb.from("leave_types").select("*").eq("active", true).order("name"),
    emp ? sb.from("leave_requests").select("leave_type_id, start_date, days, status").eq("employee_id", emp).in("status", ["pending", "approved"]) : none,
    sb.rpc("my_pending_work"),
    mineOnly("leave_requests"),
    mineOnly("overtime_requests"),
    mineOnly("requests"),
    can("leave.view_all")
      ? sb.from("leave_requests").select("start_date, end_date, hours, type:leave_types(name), employee:employees(first_name, last_name)").eq("status", "approved").lte("start_date", today).gte("end_date", today)
      : none,
  ]);
  for (const r of [me, shift, recs, types, leaves, work, myLeave, myOt, myReq, outToday]) if (r.error) throw r.error;

  const firstName = me.data?.first_name || ctx.me.user_metadata?.full_name?.split(" ")[0] || "there";
  box.append(
    el("div", { class: "welcome" }, el("h1", { text: greeting(firstName) }), el("p", { class: "muted", text: prettyDate(today) + " · " + ctx.tz }))
  );
  const grid = el("div", { class: "widgets" });
  box.append(grid);

  if (!emp) {
    grid.append(
      widget("Welcome", null, el("p", { class: "notice", text: `Your account (${ctx.me.email}) isn't linked to an employee record yet. Ask HR to add you with this work email; it links automatically.` }))
    );
  }

  // ----- Clock in / out
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
      renderHomeAgain();
    });

    const last = list[0];
    grid.append(
      widget(
        "Clock in / out", "Make a record of your in/out times",
        el("p", {}, el("strong", { text: "Shift: " }), s ? `${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)} (${s.name})` : "none assigned yet"),
        el("p", { class: open ? "ok-text" : "muted", text: open ? `Clocked in since ${timeOf(open.clock_in)}` : last?.clock_out ? `Last clocked out at ${timeOf(last.clock_out)}` : "Not clocked in today" }),
        comment,
        el("div", { class: "clock-row" }, clock, btn),
        el("div", { class: "widget-foot" }, button("History", () => navigate("attendance")))
      )
    );

    // ----- Leave balances
    const rows = types.data
      .filter((t) => t.annual_days != null)
      .map((t) => {
        const used = leaves.data
          .filter((r) => r.leave_type_id === t.id && Number(r.start_date.slice(0, 4)) === year)
          .reduce((a, r) => a + Number(r.days), 0);
        return { t, left: Math.max(Number(t.annual_days) - used, 0) };
      });
    grid.append(
      widget(
        "My leave balance", `Remaining for ${year}`,
        rows.length
          ? el("ul", { class: "balance-list" }, rows.map(({ t, left }) => el("li", {}, el("span", { text: t.name }), el("strong", { text: `${num(left)} / ${num(t.annual_days)} d` }))))
          : el("p", { class: "muted", text: "No leave types set up yet." }),
        el("div", { class: "widget-foot" }, button("Apply for leave", () => navigate("leave"), "btn btn-primary btn-inline"))
      )
    );
  }

  // ----- Waiting for me / my pending requests
  const w = work.data?.[0] || {};
  const items = [];
  if (can("leave.approve")) items.push(workRow("Leave approvals", Number(w.leave_pending || 0), "leave"));
  if (can("overtime.approve")) items.push(workRow("Overtime approvals", Number(w.overtime_pending || 0), "attendance"));
  if (can("request.approve")) items.push(workRow("HR request approvals", Number(w.requests_pending || 0), "hr"));
  const mine = [
    workRow("My pending leave", myLeave.data.length, "leave", "info"),
    workRow("My pending overtime", myOt.data.length, "attendance", "info"),
    workRow("My pending HR requests", myReq.data.length, "hr", "info"),
  ];
  grid.append(
    widget(
      "My workflow items", items.length ? "Waiting for your approval, and your own pending requests" : "Your own pending requests",
      ...(items.length ? [el("h3", { text: "Awaiting my approval" }), ...items, el("h3", { text: "My requests" })] : []),
      ...mine
    )
  );

  // ----- Out today (HR levels)
  if (can("leave.view_all")) {
    grid.append(
      widget(
        "Out today", "Approved leave covering today",
        outToday.data.length
          ? el("ul", { class: "balance-list" }, outToday.data.map((r) => el("li", {}, el("span", { text: fullName(r.employee) }), el("small", { class: "muted", text: r.hours ? `${num(r.hours)} h · ${r.type?.name}` : r.type?.name }))))
          : el("p", { class: "muted", text: "Everyone is in today." }),
        el("div", { class: "widget-foot" }, button("Team leave", () => navigate("leave")))
      )
    );
  }
}

let renderHomeAgain = () => {};
const tabs = makeTabs("home-view", [{ id: "home", label: "Home", render: renderHome }]);
renderHomeAgain = () => tabs.show();

export const showHome = () => tabs.show();
export const stopHome = () => {
  stopTimer();
  tabs.clear();
};