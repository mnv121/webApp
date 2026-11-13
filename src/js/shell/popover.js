// Small dropdowns (bell, account). Only one is open at a time;
// they close on outside click or Escape.
const closers = [];
const closeAll = () => closers.forEach((fn) => fn());

document.addEventListener("click", (e) => {
  if (!e.target.closest(".pop-wrap")) closeAll();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAll();
});

export function popover(button, panel, onOpen) {
  const close = () => {
    panel.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
  };
  closers.push(close);
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!panel.classList.contains("hidden")) return close();
    closeAll();
    await onOpen?.();
    panel.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
  });
  return { close };
}

export { closeAll as closeAllPopovers };
