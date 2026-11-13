// Small line-icon set drawn as SVG (24x24, stroke = currentColor).
// Built with createElementNS, never innerHTML.
const NS = "http://www.w3.org/2000/svg";

const PATHS = {
  home: ["M3 11.5 12 4l9 7.5", "M5 10v10h14V10", "M10 20v-6h4v6"],
  user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21c0-4 3.6-7 8-7s8 3 8 7"],
  users: ["M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M2.5 20c0-3.3 2.9-6 6.5-6s6.5 2.7 6.5 6", "M16 4.3a3.5 3.5 0 0 1 0 6.4", "M18 14.3c2.3.7 3.5 2.6 3.5 5.7"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  calendar: ["M4 6h16v14H4z", "M4 10h16", "M8 3v4", "M16 3v4"],
  check: ["M5 12.5 10 17.5 19 7"],
  checkCircle: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M8 12.5l3 3 5-6"],
  chat: ["M4 5h16v11H9l-5 4z"],
  bell: ["M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15z", "M10 21h4"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
  gear: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.3 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"],
  shield: ["M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", "M9 12l2 2 4-4"],
  briefcase: ["M4 8h16v11H4z", "M9 8V5h6v3", "M4 13h16"],
  doc: ["M6 3h9l4 4v14H6z", "M14 3v5h5", "M9 13h7", "M9 17h7"],
  money: ["M3 7h18v10H3z", "M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M6.5 10v.1", "M17.5 14v.1"],
  plus: ["M12 5v14", "M5 12h14"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  logout: ["M10 4H5v16h5", "M15 8l4 4-4 4", "M19 12H9"],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  arrow: ["M7 17 17 7", "M8 7h9v9"],
  sun: ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M12 2v2", "M12 20v2", "M2 12h2", "M20 12h2", "M5 5l1.4 1.4", "M17.6 17.6 19 19", "M5 19l1.4-1.4", "M17.6 6.4 19 5"],
  clip: ["M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7-7"],
  send: ["M4 12 20 4l-4 16-4-6z", "M12 14l8-10"],
  back: ["M15 5l-7 7 7 7"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  list: ["M9 6h11", "M9 12h11", "M9 18h11", "M4.5 6v.1", "M4.5 12v.1", "M4.5 18v.1"],
};

export function icon(name, size = 20) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of PATHS[name] || PATHS.doc) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

// Fills every <… data-icon="name" data-size="18"> that is still empty.
export function paintIcons(root = document) {
  for (const n of root.querySelectorAll("[data-icon]")) {
    if (n.firstChild) continue;
    n.append(icon(n.dataset.icon, Number(n.dataset.size) || 20));
  }
}
