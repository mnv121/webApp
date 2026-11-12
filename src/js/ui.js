// ---------------------------------------------------------------
// Shared helpers for the HR screens (Home, Leave, Attendance, HR):
// session + access level, DOM builder, tables, dialogs, tabs, toasts,
// and timezone-aware date helpers.
// All text goes in with textContent (never innerHTML).
// ---------------------------------------------------------------

export const ctx = { sb: null, me: null, access: null, tz: "UTC" };

export const $ = (id) => document.getElementById(id);
export const can = (perm) => !!ctx.access?.permissions?.includes(perm);

export const ROLE_LABELS = {
  owner: "Owner",
  system_admin: "System Admin",
  admin_1: "Admin Level 1",
  admin_2: "Admin Level 2",
  admin_3: "Admin Level 3",
  employee: "Employee",
};

// ----- DOM builder: el("div", {class: "x", onclick: fn}, child, "text") -----
export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  node.append(...kids.flat().filter((x) => x != null && x !== false));
  return node;
}

// ----- messages -----
let toastTimer = null;
export function toast(text, ok = false) {
  const t = $("toast");
  if (!t) return;
  clearTimeout(toastTimer);
  t.textContent = text || "";
  t.classList.toggle("ok", ok);
  t.classList.toggle("hidden", !text);
  if (text) toastTimer = setTimeout(() => t.classList.add("hidden"), ok ? 3000 : 6000);
}

export function friendly(err) {
  if (!err) return "";
  const msg = err.message || "";
  if (err.code === "23505") return "That already exists (duplicate email, name, code or date).";
  if (err.code === "42501" || /row-level security|permission denied|^Not allowed/i.test(msg))
    return "You don't have permission to do that.";
  if (err.code === "23514") return "One of the values isn't valid. Check the fields and try again.";
  if (err.code === "42883" || err.code === "42P01" || err.code === "PGRST202" || err.code === "PGRST205")
    return "This part isn't set up yet. Run the latest SQL files in Supabase, then reload. (" + msg + ")";
  return msg || "Something went wrong.";
}

// ----- formatting -----
export const fullName = (e) => (e ? `${e.first_name} ${e.last_name}` : "—");

export function when(iso) {
  return iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: ctx.tz }) : "—";
}
export function timeOf(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: ctx.tz }) : "—";
}
// "YYYY-MM-DD" for today in the company timezone
export function todayStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: ctx.tz });
}
export function prettyDate(ymd) {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], { dateStyle: "medium", timeZone: "UTC" });
}
export function hoursText(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// datetime-local strings are wall-clock times IN THE COMPANY TIMEZONE
function tzOffsetMs(ms, tz) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
      .formatToParts(new Date(whole))
      .map((x) => [x.type, x.value])
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}
export function zonedToIso(local, tz = ctx.tz) {
  if (!local) return null;
  const [d, t] = local.split("T");
  const [y, m, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, da, h, mi);
  let utc = wall;
  for (let i = 0; i < 2; i++) utc = wall - tzOffsetMs(utc, tz);
  return new Date(utc).toISOString();
}
export function isoToZoned(iso, tz = ctx.tz) {
  if (!iso) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// ----- small components -----
export const badge = (text, kind = "") => el("span", { class: "pill " + kind, text });
export const button = (label, onclick, cls = "icon-btn") =>
  el("button", { type: "button", class: cls, text: label, onclick });

export function statusPill(s) {
  const kind = { pending: "warn", approved: "good", rejected: "bad", cancelled: "" }[s] || "";
  return badge(s.charAt(0).toUpperCase() + s.slice(1), kind);
}

export function table(headers, rows, emptyText) {
  if (!rows.length) return el("p", { class: "muted", text: emptyText });
  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      { class: "grid" },
      el("thead", {}, el("tr", {}, headers.map((h) => el("th", { text: h })))),
      el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, c)))))
    )
  );
}

export const opts = (list, valueKey, labelKey, blank) => [
  ...(blank ? [{ value: "", label: blank }] : []),
  ...list.map((x) => ({ value: String(x[valueKey]), label: x[labelKey] })),
];

// ----- dialog with a small form -----
// fields: [{ name, label, type: text|email|date|time|datetime-local|number|select|textarea|checkbox,
//            required, options, value, maxlength, step, min, max }]
export function openDialog({ title, intro, fields, submitLabel = "Save", onSubmit }) {
  const dlg = $("hr-dialog");
  const inputs = {};
  const status = el("p", { class: "status", role: "alert" });
  const form = el("form", { novalidate: true });
  if (intro) form.append(el("p", { class: "muted", text: intro }));

  for (const f of fields) {
    let input;
    if (f.type === "select") {
      input = el("select", { name: f.name }, (f.options || []).map((o) => el("option", { value: o.value, text: o.label })));
    } else if (f.type === "textarea") {
      input = el("textarea", { name: f.name, rows: 3, maxlength: f.maxlength || 2000 });
    } else if (f.type === "checkbox") {
      input = el("input", { type: "checkbox", name: f.name });
    } else {
      input = el("input", {
        type: f.type || "text", name: f.name, maxlength: f.maxlength || 200,
        step: f.step, min: f.min, max: f.max,
      });
    }
    if (f.type === "checkbox") input.checked = !!f.value;
    else if (f.value != null) input.value = f.value;
    inputs[f.name] = input;
    form.append(
      f.type === "checkbox"
        ? el("label", { class: "check" }, input, " " + f.label)
        : el("label", {}, f.label + (f.required ? " *" : ""), input)
    );
  }

  const submit = el("button", { type: "submit", class: "btn btn-primary", text: submitLabel });
  const cancel = el("button", { type: "button", class: "btn btn-logout", text: "Cancel", onclick: () => dlg.close() });
  form.append(status, el("div", { class: "dialog-actions" }, cancel, submit));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of fields) {
      const input = inputs[f.name];
      if (f.type === "checkbox") values[f.name] = input.checked;
      else {
        const v = input.value.trim();
        if (f.required && !v) {
          status.textContent = `${f.label} is required.`;
          return;
        }
        values[f.name] = v === "" ? null : v;
      }
    }
    submit.disabled = true;
    status.textContent = "";
    try {
      const problem = await onSubmit(values);
      if (problem) {
        status.textContent = problem;
        return;
      }
      dlg.close();
    } catch (err) {
      console.error(err);
      status.textContent = friendly(err);
    } finally {
      submit.disabled = false;
    }
  });

  dlg.replaceChildren(el("h2", { text: title }), form);
  dlg.showModal();
  form.querySelector("input, select, textarea")?.focus();
}

// ----- tabs inside a view: <div data-nav></div><div data-body></div> -----
// Each tab: { id, label, show?: () => boolean, render: async (box, refresh) => void }
export function makeTabs(viewId, tabs) {
  const view = $(viewId);
  const nav = view.querySelector("[data-nav]");
  const body = view.querySelector("[data-body]");
  let current = null;
  let token = 0;

  async function show(id) {
    const visible = tabs.filter((t) => !t.show || t.show());
    const t = visible.find((x) => x.id === (id || current)) || visible[0];
    if (!t) return;
    current = t.id;
    const mine = ++token;
    if (nav) {
      nav.replaceChildren(
        ...visible.map((x) =>
          el("button", {
            type: "button",
            class: "tab" + (x.id === current ? " active" : ""),
            text: x.label,
            onclick: () => show(x.id),
          })
        )
      );
      nav.classList.toggle("hidden", visible.length < 2);
    }
    body.replaceChildren(el("p", { class: "muted", text: "Loading…" }));
    const box = el("div");
    try {
      await t.render(box, () => show());
    } catch (err) {
      console.error(err);
      box.replaceChildren(el("p", { class: "status", text: friendly(err) }));
    }
    if (mine !== token || !ctx.access) return; // navigated away or signed out meanwhile
    body.replaceChildren(box);
  }

  return {
    show,
    clear() {
      token++;
      current = null;
      nav?.replaceChildren();
      body.replaceChildren();
    },
  };
}

// ----- session / access level -----
function paintRoleBadge() {
  const b = $("role-badge");
  if (!b) return;
  b.textContent = ctx.access ? ROLE_LABELS[ctx.access.role] || "Employee" : "";
  b.classList.toggle("hidden", !ctx.access);
}

export async function refreshAccess() {
  const { data, error } = await ctx.sb.rpc("my_access");
  if (error) throw error;
  ctx.access = data?.[0] || { role: "employee", permissions: [], employee_id: null };
  paintRoleBadge();
}

export async function initSession(sb, user) {
  if (ctx.me?.id === user.id && ctx.access) return; // already running for this user
  ctx.sb = sb;
  ctx.me = user;
  ctx.access = null;
  await sb.rpc("claim_employee_record"); // links this login to its HR record by verified email
  const [{ data: tz }] = await Promise.all([sb.rpc("company_tz"), refreshAccess()]).catch((e) => {
    throw e;
  });
  if (ctx.me !== user) return; // signed out while loading
  if (typeof tz === "string" && tz) ctx.tz = tz;
}

export function clearSession() {
  ctx.sb = null;
  ctx.me = null;
  ctx.access = null;
  ctx.tz = "UTC";
  $("hr-dialog")?.close();
  paintRoleBadge();
  toast("");
}

// Screens ask the shell to switch section without importing it.
export const navigate = (section) => window.dispatchEvent(new CustomEvent("navigate", { detail: section }));