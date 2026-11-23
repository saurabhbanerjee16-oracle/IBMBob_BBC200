import { BENGALURU, api, badge, clear, el, formatDate, issueLabel, loadGoogleMaps, mountNav, severityBadge, showError, statusLabel } from "/common.js";

mountNav("map");
const summary = document.getElementById("summary");
const mapBox = document.getElementById("map");
const state = { maps: null, map: null, markers: [], info: null, cfg: null };

const PIN_COLOR = { Low: "#1a7f4b", Medium: "#b26a00", High: "#b3261e" };

function pinElement(sev) {
  const dot = document.createElement("div");
  dot.style.cssText = `width:16px;height:16px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px #0004;background:${PIN_COLOR[sev] ?? "#1f5fbf"}`;
  return dot;
}

function popup(p) {
  return el(
    "div",
    { style: "max-width:220px" },
    el("strong", { text: issueLabel(p.issue_type) }),
    el("div", {}, severityBadge(p.severity), " ", badge(statusLabel(p.status), `st-${p.status}`)),
    el("div", { class: "small", text: p.ward ?? "Ward not set" }),
    p.photos[0] ? el("img", { src: `/photos/${p.photos[0]}`, alt: "Complaint photo", style: "width:100%;margin-top:6px;border-radius:6px" }) : null,
    el("a", { href: `/track.html?id=${encodeURIComponent(p.tracking_id)}`, text: p.tracking_id }),
  );
}

function renderSummary(data) {
  clear(summary).append(
    el("h2", { text: `${data.total} complaint(s)` }),
    data.ward_counts.length === 0
      ? el("p", { class: "muted", text: "No complaints match these filters." })
      : el("table", {}, el("thead", {}, el("tr", {}, el("th", { text: "Ward" }), el("th", { text: "Complaints" }))), el("tbody", {}, data.ward_counts.map((w) => el("tr", {}, el("td", { text: w.ward }), el("td", { text: String(w.count) }))))),
  );
}

function renderList(data) {
  // Fallback when there is no map: list pins as a table.
  if (state.map) return;
  clear(mapBox).style.height = "auto";
  mapBox.className = "card";
  mapBox.append(
    el("div", { class: "alert info", text: "Map unavailable (no Google Maps key configured). Showing a list instead." }),
    data.pins.length === 0
      ? el("p", { class: "muted", text: "No complaints to show." })
      : el("table", {}, el("thead", {}, el("tr", {}, ["ID", "Issue", "Severity", "Status", "Ward", "Reported"].map((h) => el("th", { text: h })))), el("tbody", {}, data.pins.map((p) => el("tr", {}, el("td", {}, el("a", { href: `/track.html?id=${encodeURIComponent(p.tracking_id)}`, text: p.tracking_id })), el("td", { text: issueLabel(p.issue_type) }), el("td", {}, severityBadge(p.severity)), el("td", { text: statusLabel(p.status) }), el("td", { text: p.ward ?? "-" }), el("td", { text: formatDate(p.created_at) }))))),
  );
}

async function refresh() {
  const q = new URLSearchParams();
  for (const k of ["severity", "status"]) {
    const v = document.getElementById(k).value;
    if (v) q.set(k, v);
  }
  try {
    const data = await api(`/api/public/map?${q}`);
    renderSummary(data);
    if (state.map) {
      state.markers.forEach((m) => (m.map = null));
      state.markers = data.pins.map((p) => {
        const m = new state.AdvancedMarkerElement({ map: state.map, position: { lat: p.lat, lng: p.lng }, content: pinElement(p.severity), title: `${issueLabel(p.issue_type)} - ${p.severity}` });
        m.addListener("click", () => {
          state.info.setContent(popup(p));
          state.info.open({ map: state.map, anchor: m });
        });
        return m;
      });
    } else renderList(data);
  } catch (err) {
    showError(summary, err.message);
  }
}

async function main() {
  try {
    state.cfg = await api("/api/config");
    state.maps = await loadGoogleMaps(state.cfg.maps_browser_key);
    if (state.maps) {
      const { Map, InfoWindow } = await state.maps.importLibrary("maps");
      const { AdvancedMarkerElement } = await state.maps.importLibrary("marker");
      state.AdvancedMarkerElement = AdvancedMarkerElement;
      state.map = new Map(mapBox, { center: BENGALURU, zoom: 11, mapId: "DEMO_MAP_ID", streetViewControl: false });
      state.info = new InfoWindow();
    }
  } catch (err) {
    showError(summary, err.message);
  }
  document.getElementById("severity").addEventListener("change", refresh);
  document.getElementById("status").addEventListener("change", refresh);
  refresh();
}
main();
