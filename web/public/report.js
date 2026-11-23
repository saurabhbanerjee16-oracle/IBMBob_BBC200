import { BENGALURU, api, clear, el, escalationTimeline, issueLabel, loadGoogleMaps, mountNav, photoGallery, postJson, severityBadge, showError } from "/common.js";

mountNav("report");
const app = document.getElementById("app");
const state = { cfg: null, wards: [], files: [], pin: null, map: null, marker: null, geocoder: null };

function setPin(lat, lng, pan = true) {
  state.pin = { lat, lng };
  document.getElementById("lat").value = lat.toFixed(6);
  document.getElementById("lng").value = lng.toFixed(6);
  if (state.marker) {
    state.marker.position = { lat, lng };
    if (pan) state.map.panTo({ lat, lng });
  }
  document.getElementById("pin-note").textContent = `Pin set at ${lat.toFixed(5)}, ${lng.toFixed(5)}.`;
}

async function initMap(container) {
  const maps = await loadGoogleMaps(state.cfg.maps_browser_key);
  if (!maps) {
    container.replaceWith(el("div", { class: "alert info", text: "Map unavailable (no Google Maps key configured). Enter latitude and longitude below, or use the location button." }));
    return;
  }
  const { Map } = await maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await maps.importLibrary("marker");
  state.map = new Map(container, { center: BENGALURU, zoom: 12, mapId: "DEMO_MAP_ID", streetViewControl: false });
  state.marker = new AdvancedMarkerElement({ map: state.map, position: BENGALURU, gmpDraggable: true, title: "Drag to the pothole" });
  state.marker.addListener("dragend", () => {
    const p = state.marker.position;
    setPin(typeof p.lat === "function" ? p.lat() : p.lat, typeof p.lng === "function" ? p.lng() : p.lng, false);
  });
  state.map.addListener("click", (e) => setPin(e.latLng.lat(), e.latLng.lng()));
}

function renderForm() {
  clear(app);
  const fileInput = el("input", { type: "file", id: "photos", accept: "image/jpeg,image/png,image/webp,image/heic", multiple: true });
  const previews = el("div", { class: "previews", "aria-live": "polite" });
  fileInput.addEventListener("change", () => {
    const chosen = [...fileInput.files];
    if (chosen.length > state.cfg.max_photos) {
      showFormError(`You can upload up to ${state.cfg.max_photos} photos.`);
      fileInput.value = "";
      return;
    }
    const tooBig = chosen.find((f) => f.size > state.cfg.max_photo_mb * 1024 * 1024);
    if (tooBig) {
      showFormError(`"${tooBig.name}" is larger than ${state.cfg.max_photo_mb} MB.`);
      fileInput.value = "";
      return;
    }
    showFormError(null);
    state.files = chosen;
    clear(previews);
    for (const f of chosen) {
      const url = URL.createObjectURL(f);
      previews.append(el("figure", {}, el("img", { src: url, alt: `Preview of ${f.name}`, onload: () => URL.revokeObjectURL(url) })));
    }
  });

  const wardSelect = el("select", { id: "ward" }, el("option", { value: "", text: "Detect automatically / not sure" }), state.wards.map((w) => el("option", { value: w.ward, text: w.zone ? `${w.ward} (${w.zone})` : w.ward })));
  const errorBox = el("div", { id: "form-error" });
  const submit = el("button", { type: "submit", id: "submit", text: "Create draft complaint" });
  const mapBox = el("div", { id: "map", role: "application", "aria-label": "Map: click or drag the pin to the pothole" });

  const geoBtn = el("button", {
    type: "button",
    class: "secondary",
    text: "Use my current location",
    onclick: () => {
      if (!navigator.geolocation) return showFormError("Your browser does not support location.");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          showFormError(null);
          setPin(pos.coords.latitude, pos.coords.longitude);
          state.map?.setZoom(17);
        },
        () => showFormError("Could not get your location. Click the map or type the coordinates instead."),
        { enableHighAccuracy: true, timeout: 10000 },
      );
    },
  });

  const form = el(
    "form",
    { class: "card", novalidate: true },
    el("h2", { text: "1. Photos" }),
    el("label", { for: "photos", text: `Photos of the damage (up to ${state.cfg.max_photos}, ${state.cfg.max_photo_mb} MB each)` }),
    fileInput,
    previews,
    el("div", { class: "alert warn", text: "Your complaint photos will be shown publicly on the tracking page and public map. Avoid including people's faces or vehicle number plates where you can." }),
    el("h2", { text: "2. Location" }),
    el("p", { class: "muted small", text: "Click the map or drag the pin to the exact spot. If you skip this, we will try the GPS location stored in the photo." }),
    mapBox,
    el("p", { class: "muted small", id: "pin-note", text: "No pin set yet." }),
    geoBtn,
    el("div", { class: "row" }, el("div", {}, el("label", { for: "lat", text: "Latitude" }), el("input", { type: "number", step: "any", id: "lat", min: "-90", max: "90" })), el("div", {}, el("label", { for: "lng", text: "Longitude" }), el("input", { type: "number", step: "any", id: "lng", min: "-180", max: "180" }))),
    el("label", { for: "ward", text: "Ward (optional - you can change it later)" }),
    wardSelect,
    el("h2", { text: "3. Contact (optional)" }),
    el("p", { class: "muted small", text: "Never shown publicly. Only BBMP officers using this system can see it." }),
    el("div", { class: "row" }, el("div", {}, el("label", { for: "name", text: "Your name" }), el("input", { type: "text", id: "name", maxlength: "100", autocomplete: "name" })), el("div", {}, el("label", { for: "contact", text: "Email or phone" }), el("input", { type: "text", id: "contact", maxlength: "100", autocomplete: "email" }))),
    errorBox,
    submit,
  );
  form.addEventListener("submit", onSubmitDraft);
  form.querySelector("#lat").addEventListener("change", syncPinFromInputs);
  form.querySelector("#lng").addEventListener("change", syncPinFromInputs);
  app.append(form);
  initMap(mapBox).catch(() => {});
}

function showFormError(msg) {
  const box = document.getElementById("form-error");
  if (!box) return;
  clear(box);
  if (msg) box.append(el("div", { class: "alert error", role: "alert", text: msg }));
}

function syncPinFromInputs() {
  const lat = Number(document.getElementById("lat").value);
  const lng = Number(document.getElementById("lng").value);
  if (document.getElementById("lat").value !== "" && document.getElementById("lng").value !== "" && Number.isFinite(lat) && Number.isFinite(lng)) setPin(lat, lng);
}

async function onSubmitDraft(ev) {
  ev.preventDefault();
  showFormError(null);
  if (state.files.length === 0) return showFormError("Please choose at least one photo.");
  const submit = document.getElementById("submit");
  submit.disabled = true;
  submit.textContent = "Analysing photo and drafting...";
  const fd = new FormData();
  for (const f of state.files) fd.append("photos", f);
  for (const k of ["lat", "lng", "ward", "name", "contact"]) {
    const v = document.getElementById(k).value.trim();
    if (v) fd.append(k, v);
  }
  try {
    const draft = await api("/api/drafts", { method: "POST", body: fd });
    renderDraft(draft);
  } catch (err) {
    showFormError(err.message);
    submit.disabled = false;
    submit.textContent = "Create draft complaint";
  }
}

function renderDraft(d) {
  clear(app);
  const en = el("textarea", { id: "text-en", lang: "en", maxlength: "4000" });
  en.value = d.text.en;
  const kn = el("textarea", { id: "text-kn", lang: "kn", maxlength: "4000" });
  kn.value = d.text.kn;
  const wardSelect = el("select", { id: "confirm-ward" }, el("option", { value: "", text: d.location.ward ? `Keep: ${d.location.ward}` : "Not set" }), state.wards.map((w) => el("option", { value: w.ward, text: w.zone ? `${w.ward} (${w.zone})` : w.ward })));
  const ack = el("input", { type: "checkbox", id: "ack" });
  const errorBox = el("div", { id: "confirm-error" });
  const confirmBtn = el("button", { type: "button", id: "confirm", text: "Confirm and send to BBMP" });
  confirmBtn.addEventListener("click", () => onConfirm(d, { en, kn, wardSelect, ack, errorBox, confirmBtn }));

  app.append(
    el(
      "section",
      { class: "card" },
      el("h2", { text: "Review your draft" }),
      d.vision_provider === "mock" ? el("div", { class: "alert warn", text: "Demo mode: the photo was NOT analysed by AI. The issue type and severity below are placeholders." }) : null,
      el("dl", { class: "kv" }, el("dt", { text: "Issue type" }), el("dd", { text: issueLabel(d.issue_type) }), el("dt", { text: "Severity" }), el("dd", {}, severityBadge(d.severity)), el("dt", { text: "Address" }), el("dd", { text: d.location.address ?? "Not available (pin coordinates will be used)" }), el("dt", { text: "Ward / zone" }), el("dd", { text: d.location.ward ? `${d.location.ward}${d.location.zone ? ` / ${d.location.zone}` : ""}` : "Not resolved - please choose a ward below" })),
      photoGallery(d.photos),
      !d.ward_resolved ? el("div", { class: "alert info", text: "We could not work out the ward from the pin. Please pick it below if you know it." }) : null,
      el("label", { for: "confirm-ward", text: "Ward" }),
      wardSelect,
    ),
    el("section", { class: "card" }, el("h2", { text: "Complaint text (you can edit)" }), el("div", { class: "alert warn", text: "Needs human review: the Kannada text is machine-generated and has not been checked by a person." }), el("div", { class: "cols" }, el("div", {}, el("label", { for: "text-en", text: "English" }), en), el("div", {}, el("label", { for: "text-kn", text: "ಕನ್ನಡ (Kannada)" }), kn))),
    el("section", { class: "card" }, el("h2", { text: "Escalation timeline" }), escalationTimeline(d.escalation)),
    el("section", { class: "card" }, el("label", { class: "checkline", for: "ack" }, ack, el("span", { text: "I understand that my photos will be publicly visible on the tracking page and public map." })), errorBox, el("div", { class: "row" }, confirmBtn, el("button", { type: "button", class: "secondary", text: "Start over", onclick: renderForm }))),
  );
  window.scrollTo({ top: 0 });
}

async function onConfirm(d, ui) {
  clear(ui.errorBox);
  if (!ui.ack.checked) return ui.errorBox.append(el("div", { class: "alert error", role: "alert", text: "Please tick the box to confirm your photos may be shown publicly." }));
  ui.confirmBtn.disabled = true;
  try {
    const res = await postJson(`/api/complaints/${d.tracking_id}/confirm`, {
      photos_public_ack: true,
      text: { en: ui.en.value, kn: ui.kn.value },
      ward: ui.wardSelect.value || undefined,
    });
    renderDone(res);
  } catch (err) {
    showError(ui.errorBox, err.message);
    ui.confirmBtn.disabled = false;
  }
}

function renderDone(r) {
  clear(app);
  app.append(
    el(
      "section",
      { class: "card" },
      el("div", { class: "alert ok", text: r.demo_outbox ? "Complaint recorded. Demo mode: the email was written to the local outbox, not sent to BBMP." : "Complaint sent to BBMP." }),
      el("p", { text: "Your tracking ID:" }),
      el("div", { class: "tracking-id", text: r.tracking_id }),
      el("p", { class: "muted small", text: "Save this ID. Anyone with it can view the public status of this complaint." }),
      el("dl", { class: "kv" }, el("dt", { text: "Issue type" }), el("dd", { text: issueLabel(r.issue_type) }), el("dt", { text: "Severity" }), el("dd", {}, severityBadge(r.severity)), el("dt", { text: "Ward / zone" }), el("dd", { text: r.ward ? `${r.ward}${r.zone ? ` / ${r.zone}` : ""}` : "Not set" })),
      el("h2", { text: "Escalation timeline" }),
      escalationTimeline(r.escalation),
      el("p", { class: "muted small", text: r.escalation_report.message }),
      el("a", { class: "btn", href: `/track.html?id=${encodeURIComponent(r.tracking_id)}`, text: "Track this complaint" }),
    ),
  );
  window.scrollTo({ top: 0 });
}

async function main() {
  try {
    [state.cfg, { wards: state.wards }] = await Promise.all([api("/api/config"), api("/api/wards")]);
    if (state.cfg.demo_vision) document.getElementById("demo-banner").append(el("div", { class: "alert warn", text: "Demo mode: photo analysis is simulated (VISION_PROVIDER=mock)." }));
    renderForm();
  } catch (err) {
    showError(app, `Could not load the page: ${err.message}`);
  }
}
main();
