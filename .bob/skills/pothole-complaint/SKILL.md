---
name: pothole-complaint
description: Use when a citizen sends a pothole or road-damage photo (via WhatsApp) and wants a BBMP complaint drafted in English and Kannada, with geo tag, ward, severity, tracking ID and escalation timeline.
---

# Pothole Complaint (BBMP, Bengaluru)

Turn a photo + location into a structured complaint (English + Kannada, JSON), email it to the configured
BBMP ward/zone address after the user confirms, and return a tracking ID, severity, issue type and
escalation timeline.

Tools come from four MCP servers (see `README.md` for registration): `bbmp-whatsapp`, `bbmp-vision`,
`bbmp-maps`, `bbmp-complaints`. The website uses the same code through `src/core/`, not through these tools.

## Rules

- Never invent BBMP SLA days, email addresses or ward data. They come only from `config/escalation.json`,
  `config/bbmp-contacts.json` and `data/bbmp-wards.geojson`. A blank value is reported as "not configured".
- Kannada text is machine-generated. `needs_human_review` is always `true`; tell the user the Kannada
  has not been checked by a person.
- Never call `confirm_and_send_complaint` until the user has explicitly confirmed the draft.
- Never claim BBMP has acted on a complaint unless the user says so.
- Never repeat one user's contact details to another user. `get_complaint` returns the reporter's contact.
- Complaint photos become public on the website tracking page and public map. Tell the user before they confirm.
- If a provider reports `mock` (demo mode), say so: no real photo analysis was performed.
- Ask questions through the WhatsApp reply tool (`send_message`) when running in the WhatsApp channel,
  otherwise `ask_followup_question`.

## Steps

1. **Receive input.** `bbmp-whatsapp.get_incoming_messages` returns messages with `media_paths` (photos) and
   `location` (a shared pin). If there is a photo but no pin, call `bbmp-complaints.extract_photo_gps` on it.
   If there is still no location, ask the user to share a pin or type an address. For a typed address call
   `bbmp-maps.geocode`; if it returns null or a config error, ask for a pin instead.
2. **Create the draft.** Call `bbmp-complaints.create_draft_complaint` with `images` (the `media_paths`),
   `lat`, `lng`, `reporter_contact` (the sender's number) and `channel: "whatsapp"`. It classifies the photo,
   reverse-geocodes, resolves the ward, writes both texts and saves a `drafted` complaint. It does not email.
   - If it fails saying the photo is not a road issue or is unclear, ask for a closer, well-lit photo and stop.
     Do not draft anyway.
   - Optionally call `bbmp-vision.analyze_image` first to check a photo before drafting.
3. **Resolve the ward.** If `ward_resolved` is `false`, call `bbmp-maps.list_wards` and ask the user to choose
   or type the ward. If the list is empty, ask them to type it or say "skip". Always show the resolved
   address and ward and let the user override them. Pass the final choice as `ward` in step 5.
   Optionally send `bbmp-maps.map_link` so the user can check the spot.
4. **Show the draft.** Send the English text, issue type, severity, address, ward and the escalation timeline.
   Note that the Kannada text needs human review and that photos will be public. Ask: confirm, or what to change.
5. **Dispatch.** Only after an explicit yes, call `bbmp-complaints.confirm_and_send_complaint` with
   `tracking_id` and any edits (`text_en`, `text_kn`, `ward`, `zone`).
   - If it fails because no BBMP recipient is configured, tell the user the complaint is saved but was not
     sent, and that the address is not configured. The status stays `drafted`.
   - If `email_transport` is `outbox`, say it was written to the local demo outbox, not sent to BBMP.
6. **Reply with tracking info** using `send_message`: tracking ID, issue type, severity, ward/zone, and each
   escalation step as its `days` or "not configured" (with the due date when set). Mention the tracking
   page `/track.html?id=<tracking_id>` if the website is deployed.

## Status and escalation

When the user asks for status, call `bbmp-complaints.get_complaint_status` with the tracking ID. It returns the
status (`drafted`, `submitted`, `acknowledged`, `in_progress`, `resolved`, `rejected`) and an escalation report:
`configured`, `current_level`, `next_due`. Report `message` as given. If `configured` is false, say
"not configured".

## Result shape (from `create_draft_complaint`)

```json
{
  "tracking_id": "BBMP-XXXXXXXXXX",
  "issue_type": "pothole",
  "severity": "High",
  "vision": { "confidence": 0.9, "description": "...", "provider": "openai" },
  "location": { "lat": 0, "lng": 0, "address": "...", "ward": null, "zone": null },
  "ward_resolved": false,
  "ward_source": "none",
  "text": { "en": "...", "kn": "..." },
  "needs_human_review": true,
  "escalation": [
    { "level": "ward_engineer", "days": null, "due": null },
    { "level": "zone", "days": null, "due": null },
    { "level": "commissioner", "days": null, "due": null }
  ],
  "status": "drafted"
}
```
