// DOM builder and small components. All text goes in with textContent (never innerHTML).
import { $ } from "./state.js";
import { initials } from "./format.js";

// el("div", {class: "x", onclick: fn}, child, "text")
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

// ----- toast -----
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

// ----- screens: auth | app | recovery -----
export const showScreen = (name) => {
  document.body.dataset.screen = name;
};

// ----- small components -----
export const badge = (text, kind = "") => el("span", { class: "pill " + kind, text });
export const button = (label, onclick, cls = "icon-btn") => el("button", { type: "button", class: cls, text: label, onclick });

export function statusPill(s) {
  const kind = { pending: "warn", approved: "good", rejected: "bad", cancelled: "" }[s] || "";
  return badge(s.charAt(0).toUpperCase() + s.slice(1), kind);
}

// Round picture, or initials when there is no https picture URL.
export function avatar(name, url, cls = "avatar-md") {
  if (typeof url === "string" && url.startsWith("https://")) {
    const img = el("img", { class: cls, alt: "", referrerpolicy: "no-referrer" });
    img.src = url;
    return img;
  }
  return el("span", { class: cls + " initials", text: initials(name) });
}

export function table(headers, rows, emptyText) {
  if (!rows.length) return el("p", { class: "empty-state", text: emptyText });
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
