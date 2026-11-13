// Names, dates and times. Company-timezone aware (ctx.tz comes from hr_settings).
import { ctx } from "./state.js";

export const fullName = (e) => (e ? `${e.first_name} ${e.last_name}` : "—");

export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.charAt(0) || "?";
  const b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (a + b).toUpperCase();
}

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
