import { BENGALURU, api, badge, clear, el, escalationTimeline, formatDate, issueLabel, loadGoogleMaps, mountNav, photoGallery, postJson, severityBadge, showError, statusLabel } from "/common.js";

mountNav("officer");
const app = document.getElementById("app");
const state = { cfg: null, maps: null, complaints: [], selectedId: null };

function renderLogin(message) {
  clear(app);
  const error = el("div", { id: "login-error" });
  if (message) error.append(el("div", { class: "alert error", role: "alert", text: message }));
  const form = el(
    "form",
    { class: "card", style: "max-width:380px", novalidate: true },
    el("h1", { text: "Officer sign in" }),
    el("p", { class: "muted small", text: "This area is shared by BBMP officers using one credential, so actions are not attributed to individuals." }),
    el("label", { for: "u", text: "Username" }),
    el("input", { type: "text", id: "u", autocomplete: "username" }),
    el("label", { for: "p", text: "Password" }),
    el("input", { type: "password", id: "p", autocomplete: "current-password" }),
    error,
    el("button", { type: "submit", text: "Sign in" }),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await postJson("/api/officer/login", { username: form.querySelector("#u").value, password: form.querySelector("#p").value });
      await renderDashboard();
    } catch (err) {
      showError(error, err.message);
    }
  });
  app.append(form);
}

const FILTERS = [
  ["ward", "Ward", "text"],
  ["zone", "Zone", "text"],
  ["severity", "Severity", ["Low", "Medium", "High"]],
  ["issue_type", "Issue type", ["pothole", "other_road_damage", "not_a_road_issue"]],
  ["status", "Status", ["submitted", "acknowledged", "in_progress", "resolved", "rejected"]],
  ["channel", "Channel", ["web", "whatsapp"]],
  ["from", "From", "date"],
  ["to", "To", "date"],
];

async function renderDashboard() {
  clear(app);
  const filterBox = el("form", { class: "card" }, el("h2", { text: "Filters" }), el("div", { class: "row" }, FILTERS.map(([key, label, kind]) => el("div", {}, el("label", { for: `f-${key}`, text: label }), Array.isArray(kind) ? el("select", { id: `f-${key}` }, el("option", { value: "", text: "All" }), kind.map((v) => el("option", { value: v, text: v }))) : el("input", { type: kind, id: `f-${key}` })))), el("button", { type: "submit", text: "Apply" }));
  filterBox.addEventListener("submit", (e) => {
    e.preventDefault();
    load();
  });
  const mapBox = el("div", { id: "map", class: "map", role: "application", "aria-label": "Map of complaints" });
  app.append(
    el("div", { class: "row", style: "align-items:center" }, el("h1", { text: "Officer dashboard" }), el("button", { type: "button", class: "secondary", style: "flex:0 0 auto", text: "Sign out", onclick: async () => { await postJson("/api/officer/logout", {}).catch(() => {}); renderLogin(); } })),
    filterBox,
    mapBox,
    el("div", { id: "list" }),
    el("div", { id: "detail" }),
  );
  state.cfg = state.cfg ?? (await api("/api/config"));
  state.maps = await loadGoogleMaps(state.cfg.maps_browser_key);
  if (state.maps) {
    const { Map } = await state.maps.importLibrary("maps");
    const { AdvancedMarkerElement } = await state.maps.importLibrary("marker");
    state.AdvancedMarkerElement = AdvancedMarkerElement;
    state.map = new Map(mapBox, { center: BENGALURU, zoom: 11, mapId: "DEMO_MAP_ID", streetViewControl: false });
    state.markers = [];
  } else {
    mapBox.replaceWith(el("div", { class: "alert info", text: "Map unavailable (no Google Maps key configured). Use the list below." }));
    state.map = null;
  }
  await load();
}

async function load() {
  const q = new URLSearchParams();
  for (const [key] of FILTERS) {
    const v = document.getElementById(`f-${key}`)?.value.trim();
    if (v) q.set(key, v);
  }
  const list = document.getElementById("list");
  try {
    const data = await api(`/api/officer/complaints?${q}`);
    state.complaints = data.complaints;
    renderList(list, data);
    drawMarkers();
  } catch (err) {
    if (err.status === 401) return renderLogin("Your session has expired. Please sign in again.");
    showError(list, err.message);
  }
}

function drawMarkers() {
  if (!state.map) return;
  state.markers.forEach((m) => (m.map = null));
  state.markers = state.complaints.map((c) => {
    const dot = document.createElement("div");
    dot.style.cssText = `width:16px;height:16px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px #0004;background:${{ Low: "#1a7f4b", Medium: "#b26a00", High: "#b3261e" }[c.severity]}`;
    const m = new state.AdvancedMarkerElement({ map: state.map, position: { lat: c.location.lat, lng: c.location.lng }, content: dot, title: c.tracking_id });
    m.addListener("click", () => openDetail(c.tracking_id));
    return m;
  });
}

function renderList(container, data) {
  clear(container).append(
    el(
      "section",
      { class: "card" },
      el("h2", { text: `${data.total} complaint(s)${data.truncated ? " (showing the newest 500)" : ""}` }),
      data.complaints.length === 0
        ? el("p", { class: "muted", text: "No complaints match these filters." })
        : el("div", { style: "overflow-x:auto" }, el("table", {}, el("thead", {}, el("tr", {}, ["ID", "Reported", "Issue", "Severity", "Status", "Ward", "Channel"].map((h) => el("th", { text: h })))), el("tbody", {}, data.complaints.map((c) => el("tr", { class: "clickable", tabindex: "0", onclick: () => openDetail(c.tracking_id), onkeydown: (e) => { if (e.key === "Enter") openDetail(c.tracking_id); } }, el("td", { text: c.tracking_id }), el("td", { text: formatDate(c.created_at) }), el("td", { text: issueLabel(c.issue_type) }), el("td", {}, severityBadge(c.severity)), el("td", {}, badge(statusLabel(c.status), `st-${c.status}`)), el("td", { text: c.location.ward ?? "-" }), el("td", { text: c.reporter.channel })))))),
    ),
  );
}

async function openDetail(id) {
  const box = document.getElementById("detail");
  try {
    const c = await api(`/api/officer/complaints/${encodeURIComponent(id)}`);
    state.selectedId = id;
    const select = el("select", { id: "new-status" }, ["acknowledged", "in_progress", "resolved", "rejected"].map((s) => el("option", { value: s, text: statusLabel(s) })));
    const note = el("input", { type: "text", id: "note", maxlength: "500", placeholder: "Optional note (private to officers)" });
    const msg = el("div", { id: "update-msg" });
    const canUpdate = c.status !== "drafted";
    clear(box).append(
      el(
        "section",
        { class: "card" },
        el("h2", { text: `Complaint ${c.tracking_id}` }),
        el("dl", { class: "kv" }, el("dt", { text: "Status" }), el("dd", {}, badge(statusLabel(c.status), `st-${c.status}`)), el("dt", { text: "Issue / severity" }), el("dd", {}, `${issueLabel(c.issue_type)} `, severityBadge(c.severity)), el("dt", { text: "Location" }), el("dd", {}, `${c.location.lat}, ${c.location.lng}`, c.location.address ? ` - ${c.location.address}` : "", " ", el("a", { href: `https://www.google.com/maps/search/?api=1&query=${c.location.lat},${c.location.lng}`, target: "_blank", rel: "noopener", text: "Open in Google Maps" })), el("dt", { text: "Ward / zone" }), el("dd", { text: `${c.location.ward ?? "-"} / ${c.location.zone ?? "-"}` }), el("dt", { text: "Reporter" }), el("dd", { text: `${c.reporter.channel}: ${c.reporter.name ?? "(no name)"}, ${c.reporter.contact ?? "(no contact)"}` }), el("dt", { text: "Reported" }), el("dd", { text: formatDate(c.created_at) })),
        photoGallery(c.photos),
        el("div", { class: "cols" }, el("div", {}, el("h2", { text: "English" }), el("pre", { style: "white-space:pre-wrap;font:inherit", text: c.text.en })), el("div", {}, el("h2", { text: "ಕನ್ನಡ (needs human review)" }), el("pre", { style: "white-space:pre-wrap;font:inherit", text: c.text.kn }))),
        el("h2", { text: "Status history" }),
        el("ol", { class: "timeline" }, c.status_history.map((h) => el("li", {}, el("strong", { text: statusLabel(h.status) }), ` - ${formatDate(h.at)}`, h.note ? el("div", { class: "muted", text: h.note }) : null))),
        el("h2", { text: "Escalation" }),
        escalationTimeline(c.escalation),
        canUpdate
          ? el("form", { onsubmit: (e) => { e.preventDefault(); updateStatus(c.tracking_id, select.value, note.value, msg); } }, el("h2", { text: "Update status" }), el("div", { class: "row" }, el("div", {}, el("label", { for: "new-status", text: "New status" }), select), el("div", {}, el("label", { for: "note", text: "Note" }), note)), msg, el("button", { type: "submit", text: "Save status" }))
          : el("div", { class: "alert info", text: "This is an unconfirmed draft. Officers can update only submitted complaints." }),
      ),
    );
    box.scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    if (err.status === 401) return renderLogin("Your session has expired. Please sign in again.");
    showError(box, err.message);
  }
}

async function updateStatus(id, status, note, msg) {
  clear(msg);
  try {
    await postJson(`/api/officer/complaints/${encodeURIComponent(id)}/status`, { status, note }, "PATCH");
    await load();
    await openDetail(id);
    document.getElementById("update-msg")?.append(el("div", { class: "alert ok", text: "Status updated." }));
  } catch (err) {
    if (err.status === 401) return renderLogin("Your session has expired. Please sign in again.");
    showError(msg, err.message);
  }
}

async function main() {
  try {
    state.cfg = await api("/api/config");
    if (!state.cfg.officer_enabled) {
      return clear(app).append(el("div", { class: "alert error", text: "The officer area is not configured on this server. Set OFFICER_USERNAME, OFFICER_PASSWORD and SESSION_SECRET." }));
    }
    await api("/api/officer/session");
    await renderDashboard();
  } catch (err) {
    if (err.status === 401) renderLogin();
    else showError(app, err.message);
  }
}
main();
