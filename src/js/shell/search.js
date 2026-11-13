// "Search any action" (Ctrl/Cmd + K): jump to a page or start a common task.
// Only offers what this person's access level allows.
import { $, el, icon, navigate, can } from "../core/ui.js";
import { openPasswordDialog } from "./profile-menu.js";

function actions(sections) {
  const go = sections.map((s) => ({ label: "Go to " + s.label, hint: "Page", icon: s.icon, run: () => navigate(s.id) }));
  const tasks = [
    { label: "Clock in / out", hint: "Action", icon: "clock", run: () => navigate("home") },
    { label: "Apply for leave", hint: "Action", icon: "calendar", run: () => navigate("leave", "my") },
    { label: "Request overtime", hint: "Action", icon: "clock", run: () => navigate("attendance", "my") },
    { label: "New HR or payroll request", hint: "Action", icon: "doc", run: () => navigate("requests") },
    { label: "Open messages", hint: "Chat", icon: "chat", run: () => navigate("chat") },
    { label: "Change password", hint: "Account", icon: "lock", run: openPasswordDialog },
  ];
  if (can("employee.create")) tasks.push({ label: "Add or find an employee", hint: "Action", icon: "users", run: () => navigate("employees") });
  if (can("leave.view_all")) tasks.push({ label: "Who is out today", hint: "Action", icon: "calendar", run: () => navigate("leave", "team") });
  return [...tasks, ...go];
}

export function initSearch({ getSections }) {
  const dlg = $("palette");
  const input = $("palette-input");
  const list = $("palette-list");
  let items = [];
  let idx = 0;

  const draw = () => {
    list.replaceChildren(
      ...(items.length
        ? items.map((a, i) =>
            el("li", {},
              el("button", {
                type: "button",
                class: "pop-item" + (i === idx ? " active" : ""),
                onclick: () => choose(i),
              }, icon(a.icon, 18), el("span", { text: a.label }), el("small", { class: "muted", text: a.hint })))
          )
        : [el("li", { class: "empty-state small", text: "Nothing matches." })])
    );
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };

  const filter = () => {
    const q = input.value.trim().toLowerCase();
    items = actions(getSections()).filter((a) => !q || a.label.toLowerCase().includes(q));
    idx = 0;
    draw();
  };

  function choose(i) {
    const a = items[i];
    if (!a) return;
    dlg.close();
    a.run();
  }

  function open() {
    if (dlg.open || !getSections().length) return;
    input.value = "";
    filter();
    dlg.showModal();
    input.focus();
  }

  input.addEventListener("input", filter);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { idx = Math.min(idx + 1, items.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { idx = Math.max(idx - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter") { choose(idx); e.preventDefault(); }
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  $("search-btn").addEventListener("click", open);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && document.body.dataset.screen === "app") {
      e.preventDefault();
      open();
    }
  });
}
