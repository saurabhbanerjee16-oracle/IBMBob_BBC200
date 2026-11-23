/* Shared helpers for all pages. No innerHTML anywhere: all user/server text goes through textContent. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const err = new Error(body?.error?.message ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.detail = body?.error?.detail ?? null;
    throw err;
  }
  return body;
}

export function postJson(path, data, method = "POST") {
  return api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
}

const STATUS_LABEL = {
  drafted: "Drafted",
  submitted: "Submitted",
  acknowledged: "Acknowledged",
  in_progress: "In progress",
  resolved: "Resolved",
  rejected: "Rejected",
};
const LEVEL_LABEL = { ward_engineer: "Ward engineer", zone: "Zone", commissioner: "Commissioner" };
const ISSUE_LABEL = { pothole: "Pothole", other_road_damage: "Other road damage", not_a_road_issue: "Not a road issue" };

export const statusLabel = (s) => STATUS_LABEL[s] ?? s;
export const levelLabel = (l) => LEVEL_LABEL[l] ?? l;
export const issueLabel = (t) => ISSUE_LABEL[t] ?? t;

export function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function badge(text, kind) {
  return el("span", { class: `badge ${kind}`, text });
}

export function severityBadge(sev) {
  return badge(sev, `sev-${String(sev).toLowerCase()}`);
}

/** Escalation timeline; days null is shown as "not configured", never as a made-up number. */
export function escalationTimeline(steps) {
  return el(
    "ol",
    { class: "timeline" },
    steps.map((s) =>
      el(
        "li",
        {},
        el("strong", { text: levelLabel(s.level) }),
        " - ",
        s.days === null ? el("span", { class: "muted", text: "not configured" }) : `after ${s.days} day(s)`,
        s.due ? el("div", { class: "muted", text: `Due ${formatDate(s.due)}` }) : null,
      ),
    ),
  );
}

export function photoGallery(names) {
  return el(
    "div",
    { class: "photos" },
    names.map((n) => el("a", { href: `/photos/${n}`, target: "_blank", rel: "noopener" }, el("img", { src: `/photos/${n}`, alt: "Complaint photo", loading: "lazy" }))),
  );
}

export function showError(container, message) {
  clear(container).append(el("div", { class: "alert error", role: "alert", text: message }));
}

export function nav(active) {
  const links = [
    ["/", "Report a pothole", "report"],
    ["/track.html", "Track a complaint", "track"],
    ["/map.html", "Public map", "map"],
    ["/officer.html", "Officer login", "officer"],
  ];
  return el(
    "header",
    { class: "site" },
    el("div", { class: "wrap bar" }, el("a", { class: "brand", href: "/", text: "BBMP Pothole Complaints" }), el("nav", {}, links.map(([href, label, key]) => el("a", { href, class: key === active ? "active" : "", text: label })))),
  );
}

export function mountNav(active) {
  document.body.prepend(nav(active));
}

let mapsPromise = null;
/** Load the Google Maps JS API once. Resolves to null when no browser key is configured. */
export function loadGoogleMaps(key) {
  if (!key) return Promise.resolve(null);
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve) => {
    window.__mapsReady = () => resolve(window.google.maps);
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__mapsReady&loading=async`;
    s.async = true;
    s.onerror = () => resolve(null);
    document.head.append(s);
  });
  return mapsPromise;
}

export const BENGALURU = { lat: 12.9716, lng: 77.5946 };
