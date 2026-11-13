// Approvals hub: everything waiting for YOUR decision, in one place.
// The approving itself happens where the request lives (Team leave, Team attendance, Requests);
// the database decides who may approve (and nobody approves their own request).
import { ctx, can, el, icon, navigate, makeTabs } from "../../core/ui.js";

function card(iconName, title, text, count, label, go) {
  return el("section", { class: "card approval-card" },
    el("div", { class: "card-head" }, el("span", { class: "tile" }, icon(iconName, 20)), el("h2", { text: title })),
    el("p", { class: "big-number", text: String(count) }),
    el("p", { class: "muted", text: text }),
    el("button", { type: "button", class: "btn btn-primary btn-inline", text: label, onclick: go })
  );
}

async function render(box) {
  const { data, error } = await ctx.sb.rpc("my_pending_work");
  if (error) throw error;
  const w = data?.[0] || {};
  const grid = el("div", { class: "grid-3" });
  if (can("leave.approve"))
    grid.append(card("calendar", "Leave", "Leave requests waiting for a decision.", Number(w.leave_pending || 0), "Review leave", () => navigate("leave", "team")));
  if (can("overtime.approve"))
    grid.append(card("clock", "Overtime", "Overtime requests waiting for a decision.", Number(w.overtime_pending || 0), "Review overtime", () => navigate("attendance", "team")));
  if (can("request.approve"))
    grid.append(card("doc", "HR & payroll requests", "Payroll, certificate and profile-update requests.", Number(w.requests_pending || 0), "Review requests", () => navigate("requests")));
  box.append(grid, el("p", { class: "muted", text: "You can't approve your own requests. Someone else with approval rights has to." }));
}

const tabs = makeTabs("approvals-view", [{ id: "hub", label: "Approvals", render }]);
export const showApprovals = () => tabs.show();
export const stopApprovals = () => tabs.clear();
