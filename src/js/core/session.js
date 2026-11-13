// Session + access level, and the tiny "navigate" bus between sections.
import { ctx, $ } from "./state.js";
import { toast } from "./dom.js";

const listeners = new Set();
// Called whenever ctx.access changes (login, logout, role change) so the menu can rebuild.
export const onAccessChange = (fn) => listeners.add(fn);
const announce = () => listeners.forEach((fn) => fn());

export async function refreshAccess() {
  const { data, error } = await ctx.sb.rpc("my_access");
  if (error) throw error;
  ctx.access = data?.[0] || { role: "employee", permissions: [], employee_id: null };
  announce();
}

export async function initSession(sb, user) {
  if (ctx.me?.id === user.id && ctx.access) return; // already running for this user
  ctx.sb = sb;
  ctx.me = user;
  ctx.access = null;
  await sb.rpc("claim_employee_record"); // links this login to its HR record by verified email
  const [{ data: tz }] = await Promise.all([sb.rpc("company_tz"), refreshAccess()]);
  if (ctx.me !== user) return; // signed out while loading
  if (typeof tz === "string" && tz) ctx.tz = tz;
}

export function clearSession() {
  ctx.sb = null;
  ctx.me = null;
  ctx.access = null;
  ctx.tz = "UTC";
  $("app-dialog")?.close();
  announce();
  toast("");
}

// Screens ask the shell to switch section without importing it.
export const navigate = (section, tab) =>
  window.dispatchEvent(new CustomEvent("navigate", { detail: { section, tab } }));
