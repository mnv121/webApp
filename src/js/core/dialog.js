// Modal dialog with a small form.
// fields: [{ name, label, type: text|email|date|time|datetime-local|number|select|textarea|checkbox,
//            required, options, value, maxlength, step, min, max }]
import { $ } from "./state.js";
import { el } from "./dom.js";
import { friendly } from "./errors.js";

export function openDialog({ title, intro, fields, submitLabel = "Save", onSubmit }) {
  const dlg = $("app-dialog");
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
  const cancel = el("button", { type: "button", class: "btn btn-ghost", text: "Cancel", onclick: () => dlg.close() });
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
