// ---------------------------------------------------------------
// App shell: dark side menu, top bar (title, search, bell, account),
// and switching between sections. Which sections appear depends on
// the person's access level (the database still enforces everything).
// ---------------------------------------------------------------
import { ctx, $, can, el, icon, paintIcons, onAccessChange, ROLE_LABELS } from "../core/ui.js";
import { showHome, stopHome } from "../modules/home/dashboard.js";
import { showLeave, stopLeave } from "../modules/leave/leave.js";
import { showAttendance, stopAttendance } from "../modules/attendance/attendance.js";
import { showHr, stopHr } from "../modules/hr/hr.js";
import { showApprovals, stopApprovals } from "../modules/approvals/approvals.js";
import { openChat } from "../modules/chat/chat.js";
import { initSearch } from "./search.js";
import { initAccountMenu, loadWho, whoAmI } from "./profile-menu.js";
import { initBell, startBell, stopBell } from "./notifications.js";
import { closeAllPopovers } from "./popover.js";

// One entry per menu item. `open(tab)` fills its view.
const SECTIONS = [
  { id: "home", label: "Home", icon: "home", view: "home-view", open: () => showHome() },
  { id: "profile", label: "My Profile", icon: "user", view: "hr-view", open: () => showHr("profile", true) },
  { id: "attendance", label: "Attendance", icon: "clock", view: "attendance-view", open: (t) => showAttendance(t) },
  { id: "leave", label: "Leave", icon: "calendar", view: "leave-view", open: (t) => showLeave(t) },
  { id: "requests", label: "Requests", icon: "doc", view: "hr-view", open: () => showHr("requests", true) },
  {
    id: "approvals", label: "Approvals", icon: "checkCircle", view: "approvals-view",
    visible: () => can("leave.approve") || can("overtime.approve") || can("request.approve"),
    open: () => showApprovals(),
  },
  { id: "employees", label: "Employees", icon: "users", view: "hr-view", visible: () => can("employee.view_all"), open: () => showHr("employees", true) },
  { id: "hrconfig", label: "HR Configuration", icon: "briefcase", view: "hr-view", visible: () => can("hr.config"), open: () => showHr("setup", true) },
  { id: "settings", label: "System Settings", icon: "gear", view: "hr-view", visible: () => can("audit.view") || can("role.assign"), open: () => showHr("audit", true) },
];
const VIEWS = [...new Set(SECTIONS.map((s) => s.view))];

let current = "home";
let started = false;

export const visibleSections = () => (ctx.access ? SECTIONS.filter((s) => !s.visible || s.visible()) : []);

function buildNav() {
  $("nav-list").replaceChildren(
    ...visibleSections().map((s) =>
      el(
        "button",
        {
          type: "button",
          class: "nav-item" + (s.id === current ? " active" : ""),
          "data-section": s.id,
          title: s.label,
          "aria-current": s.id === current ? "page" : null,
          onclick: () => showSection(s.id),
        },
        icon(s.icon, 20),
        el("span", { class: "nav-label", text: s.label })
      )
    )
  );
  const role = $("role-badge");
  role.textContent = ctx.access ? ROLE_LABELS[ctx.access.role] || "Employee" : "";
  role.classList.toggle("hidden", !ctx.access);
}

function showSection(id, tab) {
  if (id === "chat") return openChat();
  const s = visibleSections().find((x) => x.id === id) || SECTIONS[0];
  current = s.id;
  closeAllPopovers();
  for (const v of VIEWS) $(v).classList.toggle("hidden", v !== s.view);
  buildNav();
  $("page-title").textContent = s.label;
  const first = whoAmI().name.split(" ")[0];
  $("greeting").textContent = first ? `Welcome back, ${first}` : "Welcome back";
  $("main-scroll").scrollTop = 0;
  if (started) s.open(tab);
}

export function initShell() {
  paintIcons();
  initAccountMenu();
  initBell();
  initSearch({ getSections: visibleSections });

  window.addEventListener("navigate", (e) => {
    const d = e.detail;
    showSection(typeof d === "string" ? d : d?.section, d?.tab);
  });

  // role changed while signed in: rebuild the menu; leave a page you can no longer open
  onAccessChange(() => {
    if (!started) return;
    if (!visibleSections().some((s) => s.id === current)) current = "home";
    buildNav();
  });
}

// Called once the access level has loaded.
export async function startShell() {
  if (started) return; // token refreshes must not reload the page you're on
  started = true;
  buildNav();
  startBell();
  showSection(current);
  await loadWho(); // fills in your name / position without blocking the page
  $("greeting").textContent = `Welcome back, ${whoAmI().name.split(" ")[0] || ""}`.trim();
}

export function stopShell() {
  started = false;
  current = "home";
  stopBell();
  stopHome();
  stopLeave();
  stopAttendance();
  stopHr();
  stopApprovals();
  $("nav-list")?.replaceChildren();
  for (const v of VIEWS) $(v).classList.toggle("hidden", v !== "home-view");
  closeAllPopovers();
}
