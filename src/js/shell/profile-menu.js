// Avatar button + account popup: who you are, My profile, Change password, Sign out.
import { ctx, $, ROLE_LABELS, el, avatar, icon, openDialog, toast, navigate, fullName } from "../core/ui.js";
import { passwordProblem, authError } from "../auth/auth.js";
import { popover, closeAllPopovers } from "./popover.js";

let who = { name: "", email: "", url: "", position: "", empNo: "" };

export function openPasswordDialog() {
  openDialog({
    title: "Change password",
    intro: "Choose a new password for your account (at least 8 characters).",
    submitLabel: "Update password",
    fields: [
      { name: "pw", label: "New password", type: "password", required: true, maxlength: 72 },
      { name: "pw2", label: "Confirm new password", type: "password", required: true, maxlength: 72 },
    ],
    onSubmit: async (v) => {
      const problem = passwordProblem(v.pw, v.pw2);
      if (problem) return problem;
      const { error } = await ctx.sb.auth.updateUser({ password: v.pw });
      if (error) return authError(error);
      toast("Password updated.", true);
    },
  });
}

function paint() {
  const btn = $("avatar-btn");
  const pop = $("account-pop");
  btn.replaceChildren(ctx.me ? avatar(who.name, who.url, "avatar-sm") : "");
  btn.setAttribute("aria-label", "Account menu for " + (who.name || "you"));

  const item = (iconName, label, fn, cls = "") =>
    el("button", { type: "button", class: "pop-item " + cls, onclick: () => { closeAllPopovers(); fn(); } },
      icon(iconName, 18), el("span", { text: label }));

  pop.replaceChildren(
    el("div", { class: "pop-head" },
      avatar(who.name, who.url, "avatar-lg"),
      el("div", { class: "pop-who" },
        el("strong", { text: who.name || "Welcome" }),
        el("small", { text: who.position || who.email }),
        el("span", { class: "pill info", text: ROLE_LABELS[ctx.access?.role] || "Employee" }),
        who.empNo ? el("small", { class: "muted", text: "Employee no. " + who.empNo }) : null
      )
    ),
    item("user", "My profile", () => navigate("profile")),
    item("lock", "Change password", openPasswordDialog),
    el("hr"),
    item("logout", "Sign out", () => $("logout-btn").click(), "danger")
  );
}

// Loads name / position from the HR record (falls back to the login's name).
export async function loadWho() {
  const meta = ctx.me?.user_metadata || {};
  who = {
    name: meta.full_name || meta.name || ctx.me?.email || "",
    email: ctx.me?.email || "",
    url: meta.avatar_url || meta.picture || "",
    position: "",
    empNo: "",
  };
  paint();
  const emp = ctx.access?.employee_id;
  if (!emp) return;
  const { data } = await ctx.sb
    .from("employees")
    .select("first_name, last_name, employee_no, position:positions(title)")
    .eq("id", emp)
    .maybeSingle();
  if (data && ctx.me) {
    who.name = fullName(data);
    who.position = data.position?.title || "";
    who.empNo = data.employee_no || "";
    paint();
  }
}

export const whoAmI = () => who;

export function initAccountMenu() {
  popover($("avatar-btn"), $("account-pop"));
}
