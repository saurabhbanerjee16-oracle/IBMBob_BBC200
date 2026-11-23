import { api, badge, clear, el, escalationTimeline, formatDate, issueLabel, mountNav, photoGallery, severityBadge, showError, statusLabel } from "/common.js";

mountNav("track");
const result = document.getElementById("result");
const input = document.getElementById("id");

function render(c) {
  clear(result).append(
    el(
      "section",
      { class: "card" },
      el("div", { class: "tracking-id", text: c.tracking_id }),
      el("dl", { class: "kv" }, el("dt", { text: "Status" }), el("dd", {}, badge(statusLabel(c.status), `st-${c.status}`)), el("dt", { text: "Issue type" }), el("dd", { text: issueLabel(c.issue_type) }), el("dt", { text: "Severity" }), el("dd", {}, severityBadge(c.severity)), el("dt", { text: "Ward / zone" }), el("dd", { text: c.ward ? `${c.ward}${c.zone ? ` / ${c.zone}` : ""}` : "Not set" }), el("dt", { text: "Reported" }), el("dd", { text: formatDate(c.created_at) })),
      c.photos.length ? el("h2", { text: "Photos" }) : null,
      c.photos.length ? photoGallery(c.photos) : null,
    ),
    el("section", { class: "card" }, el("h2", { text: "Status history" }), el("ol", { class: "timeline" }, c.status_history.map((h) => el("li", {}, el("strong", { text: statusLabel(h.status) }), el("div", { class: "muted", text: formatDate(h.at) }))))),
    el("section", { class: "card" }, el("h2", { text: "Escalation timeline" }), escalationTimeline(c.escalation), el("p", { class: "muted small", text: "Due dates are an internal reminder schedule. They do not mean BBMP has acted on this complaint." })),
  );
}

async function lookup(raw) {
  const id = raw.trim().toUpperCase();
  if (!id) return showError(result, "Please enter a tracking ID.");
  clear(result).append(el("p", { class: "muted", text: "Looking up..." }));
  try {
    render(await api(`/api/track/${encodeURIComponent(id)}`));
    history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
  } catch (err) {
    showError(result, err.status === 404 ? "No complaint found for that tracking ID. Check the ID and try again." : err.message);
  }
}

document.getElementById("form").addEventListener("submit", (e) => {
  e.preventDefault();
  lookup(input.value);
});
const preset = new URLSearchParams(location.search).get("id");
if (preset) {
  input.value = preset;
  lookup(preset);
}
