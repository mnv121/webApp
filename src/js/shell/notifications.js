// Bell: things waiting for you (approvals) + unread chat messages.
import { ctx, can, $, el, icon, navigate } from "../core/ui.js";
import { popover, closeAllPopovers } from "./popover.js";

let pending = { leave: 0, overtime: 0, requests: 0 };
let unread = 0;
let timer = null;

function paint() {
  const rows = [];
  const add = (label, n, go) => n > 0 && rows.push({ label, n, go });
  if (can("leave.approve")) add("Leave requests to approve", pending.leave, () => navigate("leave", "team"));
  if (can("overtime.approve")) add("Overtime requests to approve", pending.overtime, () => navigate("attendance", "team"));
  if (can("request.approve")) add("HR requests to approve", pending.requests, () => navigate("requests"));
  add("Unread messages", unread, () => navigate("chat"));

  const total = rows.reduce((a, r) => a + r.n, 0);
  const count = $("bell-count");
  count.textContent = total > 99 ? "99+" : String(total);
  count.classList.toggle("hidden", total === 0);

  $("bell-pop").replaceChildren(
    el("div", { class: "pop-title", text: "Notifications" }),
    rows.length
      ? rows.map((r) =>
          el("button", { type: "button", class: "pop-item", onclick: () => { closeAllPopovers(); r.go(); } },
            icon("bell", 18), el("span", { text: r.label }), el("span", { class: "pill warn", text: String(r.n) }))
        )
      : el("p", { class: "empty-state small", text: "You're all caught up." })
  );
}

export async function refreshBell() {
  if (!ctx.sb || !ctx.access) return;
  const { data } = await ctx.sb.rpc("my_pending_work");
  const w = data?.[0] || {};
  pending = {
    leave: Number(w.leave_pending || 0),
    overtime: Number(w.overtime_pending || 0),
    requests: Number(w.requests_pending || 0),
  };
  paint();
}

export function startBell() {
  stopBell();
  refreshBell();
  timer = setInterval(refreshBell, 60000);
}
export function stopBell() {
  clearInterval(timer);
  timer = null;
  pending = { leave: 0, overtime: 0, requests: 0 };
  unread = 0;
  if ($("bell-pop")) paint();
}

export function initBell() {
  popover($("bell-btn"), $("bell-pop"), refreshBell);
  // chat.js announces its unread total whenever it changes
  window.addEventListener("chat:unread", (e) => {
    unread = Number(e.detail) || 0;
    paint();
  });
  paint();
}
