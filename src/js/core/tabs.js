// Tabs inside a view: <div data-nav></div><div data-body></div>
// Each tab: { id, label, show?: () => boolean, render: async (box, refresh) => void }
// show(id)        -> open that tab (all visible tabs get a tab bar)
// show(id, true)  -> "solo": open only that tab, no tab bar (used when the side menu
//                    already names the page, e.g. Employees or HR Configuration)
import { $, ctx } from "./state.js";
import { el } from "./dom.js";
import { friendly } from "./errors.js";

export function makeTabs(viewId, tabs) {
  const view = $(viewId);
  const nav = view.querySelector("[data-nav]");
  const body = view.querySelector("[data-body]");
  let current = null;
  let solo = false;
  let token = 0;

  async function show(id, onlyThis) {
    if (typeof onlyThis === "boolean") solo = onlyThis;
    const visible = tabs.filter((t) => !t.show || t.show());
    const t = visible.find((x) => x.id === (id || current)) || (solo ? null : visible[0]);
    if (!t) {
      nav?.replaceChildren();
      nav?.classList.add("hidden");
      body.replaceChildren(el("p", { class: "empty-state", text: "You don't have access to this page." }));
      return;
    }
    current = t.id;
    const mine = ++token;
    if (nav) {
      const shown = solo ? [] : visible;
      nav.replaceChildren(
        ...shown.map((x) =>
          el("button", {
            type: "button",
            class: "tab" + (x.id === current ? " active" : ""),
            text: x.label,
            onclick: () => show(x.id),
          })
        )
      );
      nav.classList.toggle("hidden", shown.length < 2);
    }
    body.replaceChildren(el("p", { class: "muted loading", text: "Loading…" }));
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
      solo = false;
      nav?.replaceChildren();
      body.replaceChildren();
    },
  };
}
