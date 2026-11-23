# Pothole Complaint Agent (BBMP) - Plan

## Top-Level Overview

**Goal:** A Bob skill backed by MCP servers that lets a citizen send a pothole photo on
WhatsApp **or through a website** and receive a drafted BBMP complaint (English + Kannada, JSON) with geo tag,
ward, severity, issue type, tracking ID and escalation timeline. The website also gives a
public tracking page, a public complaints map and an officer dashboard.

**Revision note:** The first version of this plan was WhatsApp only. The user then asked for a
website; sub-tasks 8-12 and the website rows below were added. Sub-tasks 1-7 are unchanged
except where noted.

**Decisions confirmed with the user**

| Topic | Decision |
|---|---|
| Runtime | Bob-style skill (`SKILL.md`) + MCP servers (vision, Google Maps, WhatsApp), running in the Bob/IBM agent runtime |
| Channel | WhatsApp and website (revised). Both feed the same drafting pipeline |
| Website features | (1) Tracking page: look up by tracking ID, shows status, severity, issue type, escalation timeline. (2) Citizen page: upload photos, pick location on a Google Map (pin + ward selection), see drafted EN and KN complaint, confirm. (3) Public map of all complaints with ward-wise counts. (4) Officer dashboard: list, filter, map complaints and update status; needs login |
| Public fields | Status, severity, issue type, ward, escalation timeline and photos are public on the tracking page and public map. Reporter contact and name are never public |
| Storage | JSON files in `complaints/` stay the source of truth; the website reads and writes them. Acceptable for a demo; known limits: no scaling, limited search and dashboard, concurrent-write risk |
| Web stack | Open. Decided at the start of sub-task 8 |
| Officer login | Single shared username and password from environment variables |
| Submission to BBMP | Draft + email the JSON to a configurable BBMP ward/zone address. No BBMP API is assumed (none verified) |
| Ward/zone | Use ward GeoJSON when present; otherwise Google Maps geocoding + user confirmation. User can pick/override ward |
| Severity | 3 tiers: Low / Medium / High, from vision output |
| Escalation | Steps: ward engineer -> zone -> commissioner. Day values left blank until the user fills them. Tracking and escalation computed locally |
| Kannada | LLM-generated, always flagged `needs_human_review` |

**Non-goals (v1):** direct BBMP/Sahaaya API integration, invented SLA
figures, real-time status from BBMP, human translation workflow, a database, per-officer
accounts or roles.

**Approach:** One skill orchestrates the WhatsApp flow; each external capability is a small MCP
server so it can be built and tested independently. The website backend runs outside the Bob
agent and cannot call MCP tools, so the vision, maps, drafting and email logic must live in
shared modules that both the MCP servers and the web backend call (sub-task 8). Complaint state is
stored as local JSON files (one per tracking ID).

**Website design constraints (derived from the decisions above)**

- The tracking ID is the only access control on the tracking page, so it must be unguessable (random, not sequential).
- Public view (confirmed): the tracking page and public map show status, severity, issue type, ward, escalation timeline and **photos**. They must not expose reporter contact or name. Exact vs coarse pin location on the public map is still open.
- Because photos are public, photos can show faces or vehicle number plates, and are viewable by anyone who has the tracking ID (tracking page) or by anyone (public map). Photo file names must be random (not derived from sequential IDs), and the public-view projection must not leak the reporter's name or contact via photo file names or image metadata (strip EXIF, including GPS, from served copies). Whether to blur faces/plates is not decided.
- The citizen page and WhatsApp flow produce the same complaint record; only `reporter.channel` differs.
- Officer status updates need status values beyond `drafted` and `submitted` (proposed: `acknowledged`, `in_progress`, `resolved`, `rejected`; to be confirmed).
- Officer login is one shared credential, so there is no per-officer audit trail. Serve it over HTTPS, rate-limit login attempts.
- Concurrent writes to one JSON file need atomic write (temp file + rename) at minimum.

**Flow**

1. WhatsApp message with photo and location arrives (WhatsApp MCP).
2. Vision MCP returns issue type, severity, confidence.
3. Maps MCP reverse-geocodes; ward lookup via GeoJSON, fallback to user confirmation.
4. Agent drafts the EN + KN complaint JSON.
5. User confirms; the email tool sends it to the ward/zone address.
6. Agent replies with tracking ID, severity, issue type and escalation timeline.

## Open Items (need user input before or during implementation)

- Which vision AI service/model is used (not specified). Sub-task 2 assumes a pluggable provider.
- Source of the BBMP ward GeoJSON file (no verified source yet) and the ward/zone email addresses.
- WhatsApp access method (e.g. WhatsApp Business Cloud API needs a public webhook and
  business account; to be verified in implementation).
- Issue-type list. Proposed starting set: `pothole`, `other_road_damage`, `not_a_road_issue`.
- Email transport (SMTP account or provider).
- Web stack and hosting (decided at start of sub-task 8). Hosting must keep the `complaints/` folder on persistent disk.
- Public fields: confirmed as status, severity, issue type, ward, escalation timeline and photos (no reporter contact or name). Still open: exact or coarse pin location on the public map; whether to blur faces and number plates in public photos; whether the citizen is told on the page that photos will be public.
- Final list of status values for officer updates.
- Whether the officer dashboard may also trigger email dispatch or only update status.

## Sub-Tasks

### 1. Project scaffolding, schema and config

- **Intent:** Define the shared contract (complaint JSON, config files) so all other pieces build against it.
- **Expected Outcomes:** Schema and config files exist; blank escalation days are explicit, not guessed.
- **Todo List:**
  1. Create `schema/complaint.schema.json` (tracking_id, reporter, location {lat,lng,address,ward,zone}, photos, issue_type, severity, text.en, text.kn, needs_human_review, status, created_at, escalation).
  2. Create `config/escalation.json` with levels ward_engineer, zone, commissioner and `days: null`.
  3. Create `config/bbmp-contacts.json` (ward/zone -> email) with placeholders.
  4. Create `data/` placeholder for `bbmp-wards.geojson` and `complaints/` for output.
  5. Create an `.env.example` for API keys (no secrets committed).
- **Relevant Context:** Workspace was empty at planning time; draft skill at `.bob/skills/pothole-complaint/SKILL.md`.
- **Status:** [x] done
- **Completion Notes (for later sub-tasks):**
  - Created: `schema/complaint.schema.json`, `config/escalation.json`, `config/bbmp-contacts.json`, `data/README.md`, `complaints/.gitkeep`, `.env.example`. All three JSON files parse (checked with `ConvertFrom-Json`).
  - Schema (draft 2020-12, `additionalProperties: false`): all top-level fields required. `reporter` = `{channel: "whatsapp", contact, name?}`. `location.address/ward/zone` are nullable (null until resolved/confirmed). `issue_type` enum = `pothole | other_road_damage | not_a_road_issue` (still an open item). `severity` enum = `Low | Medium | High`. `status` enum = `drafted | submitted` (extend in sub-task 6 if more states are needed). `photos` is a non-empty array of file-reference strings. `escalation[]` items = `{level, days: int|null, due: date-time|null}`. `tracking_id` format is left to sub-task 5.
  - `config/escalation.json` shape: `{ "levels": [ {level, days: null} x3 ] }` (order ward_engineer, zone, commissioner). Sub-task 6 should copy these into `complaint.escalation` and compute `due = created_at + days` only when `days` is not null.
  - `config/bbmp-contacts.json` shape: `{ "default": {email}, "zones": { <zone>: {email} }, "wards": { <ward>: {zone, email} } }`, with only `EXAMPLE_*` placeholder keys and `email: null`. Suggested lookup order: ward -> zone -> default; if all null, ask the user. Keys should match ward/zone names in `data/bbmp-wards.geojson` once the source is chosen.
  - `.env.example` keys: `GOOGLE_MAPS_API_KEY`; `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`; `VISION_PROVIDER`, `VISION_API_KEY`, `VISION_MODEL`; `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`. WhatsApp and vision names are placeholders until those providers are confirmed.
  - For sub-task 2: the vision tool output must map to the schema's `issue_type` and `severity` enums. No `.gitignore` was created; add one that ignores `.env` and `complaints/*.json` when the project is put under git.

### 2. Vision MCP server

- **Intent:** Classify the photo into issue type and severity.
- **Expected Outcomes:** Tool accepts an image and returns `issue_type`, `severity` (Low/Medium/High), `confidence`, `description`; rejects non-road images.
- **Todo List:**
  1. Confirm the vision provider with the user.
  2. Scaffold the MCP server (follow the `build-mcp-server` skill).
  3. Implement `analyze_image` with a prompt that maps findings to the 3-tier severity.
  4. Test with sample pothole and non-pothole images.
  5. Register the server in the Bob MCP config (`configure-mcp` skill).
- **Relevant Context:** Severity criteria (size, depth, traffic risk) to be agreed with the user.
- **Status:** [~] built and tested with the mock provider and mocked HTTP; NOT tested against a real vision provider or real photos. Code: `src/core/vision.ts`, `src/mcp/vision.ts`. Provider is an OpenAI-compatible chat API (`VISION_PROVIDER=openai`), chosen as a pluggable default, not confirmed with the user. Not yet registered in Bob MCP config (see README).

### 3. Maps and ward-resolution MCP server

- **Intent:** Turn coordinates into an address and a BBMP ward/zone, with a fallback.
- **Expected Outcomes:** Tools for reverse geocode, forward geocode, and ward lookup (point-in-polygon on GeoJSON); clean "ward unknown" result that triggers user confirmation.
- **Todo List:**
  1. Scaffold MCP server; wire the Google Maps Geocoding API key from env.
  2. Implement `reverse_geocode` and `geocode`.
  3. Implement `lookup_ward` against `data/bbmp-wards.geojson` (return null if file missing or no match).
  4. Implement a Maps link/static map for highlighting the location in the reply.
  5. Test with known Bengaluru coordinates and with the GeoJSON absent.
- **Relevant Context:** Ward GeoJSON source is an open item.
- **Status:** [~] built; ward lookup tested with a synthetic GeoJSON (holes, absent file, malformed file). Google geocoding is NOT tested against the live API. Real BBMP ward GeoJSON still not supplied. Code: `src/core/maps.ts`, `src/core/wards.ts`, `src/mcp/maps.ts`.

### 4. WhatsApp MCP server

- **Intent:** Receive photos/location pins from users and send replies.
- **Expected Outcomes:** Inbound image + location are available to the agent; the agent can send text, location and confirmation prompts.
- **Todo List:**
  1. Confirm WhatsApp access method and account setup with the user.
  2. Scaffold MCP server with inbound webhook handler and outbound send tool.
  3. Download and store incoming media under a local folder; extract EXIF GPS when no pin is shared.
  4. Implement tools: `get_incoming_messages`, `send_message`, `send_location`.
  5. Test with a real WhatsApp test number.
- **Relevant Context:** Requires a publicly reachable webhook (to be verified).
- **Status:** [~] built against the public WhatsApp Cloud API shapes; signature check, webhook handshake, media download and sends are tested with mocks only. NOT tested with a real WhatsApp business account. Code: `src/whatsapp/client.ts`, `src/mcp/whatsapp.ts`.

### 5. Complaint drafting (EN + KN JSON)

- **Intent:** Produce the complaint file combining vision, location and ward data.
- **Expected Outcomes:** A valid `complaints/<tracking_id>.json` with English and Kannada text, photo references, geo tag, `needs_human_review: true`.
- **Todo List:**
  1. Define tracking ID format.
  2. Add a template/prompt for the English and Kannada complaint text.
  3. Add schema validation before saving.
  4. Test on sample inputs; have a Kannada reader spot-check the output.
- **Relevant Context:** Kannada is LLM-generated and unverified.
- **Status:** [~] built and tested. Tracking ID = `BBMP-` + 10 Crockford base32 chars (50 bits random). Default text is a fixed template (`TEXT_PROVIDER=template`); `openai` mode generates EN+KN with an LLM. Kannada has NOT been reviewed by a Kannada reader. Code: `src/core/drafting.ts`, `src/core/pipeline.ts`.

### 6. Email dispatch, tracking and escalation

- **Intent:** Send the complaint and return tracking and escalation info.
- **Expected Outcomes:** Email sent to the ward/zone contact after user confirmation; status recorded; escalation due dates computed when days are set, "not configured" otherwise; status query works.
- **Todo List:**
  1. Confirm email transport; implement a send-email tool (or MCP server) with JSON + photos attached.
  2. Implement escalation calculation from `config/escalation.json`.
  3. Implement status lookup by tracking ID.
  4. Test with blank and filled escalation days.
- **Relevant Context:** Escalation days are intentionally blank until the user supplies them.
- **Status:** [~] built and tested. Escalation, status lookup and the demo `outbox` email (writes `.eml`) are verified. SMTP sending is NOT tested against a real server. Escalation days are still blank by design. Code: `src/core/email.ts`, `src/core/escalation.ts`.

### 7. Finalize skill and end-to-end test

- **Intent:** Align `SKILL.md` with the real MCP tool names and verify the full flow.
- **Expected Outcomes:** Skill activates on a pothole photo and completes steps 1-6 of the flow; ward override and no-GeoJSON fallback both work.
- **Todo List:**
  1. Replace proposed tool names in the draft `SKILL.md` with the real ones.
  2. Run end-to-end tests: valid photo, non-road photo, no location, no GeoJSON, user ward override.
  3. Document setup (env vars, MCP registration, webhook) in a README.
- **Relevant Context:** Draft at `.bob/skills/pothole-complaint/SKILL.md`; new skills appear in the next task.
- **Status:** [~] `SKILL.md` aligned with the real tool names and README written. The skill has NOT been run end to end inside a Bob agent session with a real WhatsApp number. Automated tests cover each tool over stdio.

## Website Sub-Tasks (added in revision)

Order note: sub-task 8 needs the logic from sub-tasks 2, 3, 5 and 6 to be callable as plain
modules. If those are built first as MCP-only code, refactor them into shared modules in
sub-task 8. Sub-tasks 9-11 depend on 8 and are independent of each other.

### 8. Web stack decision, shared modules and backend API

- **Intent:** Pick the stack and expose the pipeline (vision, maps, drafting, email, tracking) to the website without depending on Bob MCP tools at runtime.
- **Expected Outcomes:** Stack and hosting chosen and recorded in this plan; shared modules used by both the MCP servers and the web backend; backend endpoints exist for submit, draft, confirm, lookup, list and status update; photo upload stored locally; complaint file writes are atomic; unguessable tracking IDs; schema `status` enum extended.
- **Todo List:**
  1. Ask the user for the web stack and hosting (must keep `complaints/` on persistent disk). Record the answer here.
  2. Extend `status` in `schema/complaint.schema.json` with the officer values once confirmed (proposed: `acknowledged`, `in_progress`, `resolved`, `rejected`), and update `docs/LLD.md`.
  3. Extract vision, maps/ward, drafting, email and escalation logic into shared modules; keep the MCP servers as thin wrappers.
  4. Define backend endpoints: create draft from photos + pin, get draft, confirm and send, get complaint by tracking ID (public view), list/filter complaints (officer), update status (officer).
  5. Add a public-view projection that includes status, severity, issue type, ward, escalation and photos, and omits reporter contact and name. Serve public copies of photos with EXIF/GPS stripped and random file names.
  6. Implement atomic write for complaint files (temp file + rename).
  7. Add backend env vars to `.env.example` (officer username/password, session secret, Maps browser key if separate).
- **Relevant Context:** `schema/complaint.schema.json`, `config/*.json`, sub-tasks 2, 3, 5, 6. Reporter channel enum currently only allows `whatsapp`; add `web` and a contact field suited to web users (to be confirmed).
- **Status:** [~] built. **Stack decision (made by the implementer, not confirmed with the user):** TypeScript on Node 22, Express 5, static HTML + ES modules (no framework, no build step for the front end), one process serving API and pages. Hosting not decided; it must keep `complaints/` on persistent disk. Schema `status` extended with `acknowledged`, `in_progress`, `resolved`, `rejected` (proposed values, not confirmed). `reporter.channel` now allows `web`; `reporter.contact` is nullable.

### 9. Citizen submission page

- **Intent:** Let a citizen file a complaint from the browser.
- **Expected Outcomes:** User uploads one or more photos, drops a pin on a Google Map, selects or confirms the ward (auto-suggested from GeoJSON when available), sees the drafted English and Kannada text with the `needs human review` flag, and confirms. The page then shows tracking ID, issue type, severity and escalation timeline.
- **Todo List:**
  1. Photo upload with size/type limits and preview.
  2. Google Map with draggable pin; geolocate-me button; reverse-geocoded address shown.
  3. Ward selector populated from the ward list; pre-filled from `lookup_ward`.
  4. Draft preview (EN and KN) with edit before confirm.
  5. Confirm action calls the backend and shows the result.
  6. Restrict the Maps browser key by HTTP referrer.
- **Relevant Context:** Reuses the same drafting pipeline as WhatsApp. Reporter contact for web users is an open item (email or phone, optional?).
- **Status:** [~] built (`web/public/index.html`, `report.js`). Pin placement, geolocate, ward selector, editable EN/KN preview, public-photo acknowledgement and tracking result are implemented. NOT tested in a real browser or with a live Google Maps key; without a key the page falls back to manual latitude/longitude entry. Reporter contact for web users is optional and never public.

### 10. Tracking page and public map

- **Intent:** Let anyone check a complaint by tracking ID and see complaint density by ward.
- **Expected Outcomes:** Tracking page shows status, severity, issue type, ward, escalation timeline (due dates, or "not configured") and the complaint photos. Public map shows complaint pins, photos and ward-wise counts, without reporter contact or name.
- **Todo List:**
  1. Tracking lookup form and result view using the public-view projection.
  2. Show "not configured" when escalation days are null; do not state that BBMP acted.
  3. Public map with pins (coarse or exact location to be confirmed), photo thumbnails and ward counts, with filters by severity and status.
  4. Handle unknown ID without revealing whether similar IDs exist.
- **Relevant Context:** Public fields confirmed (see Decisions); pin precision and photo blurring still open. Citizen page (sub-task 9) must tell users their photos will be public before they confirm.
- **Status:** [~] built (`track.html`, `map.html`). Public view is an allow-list projection, tested for leaks. Pin precision defaulted to coarse (3 decimals, about 110 m) and photos are NOT blurred (both still open). NOT tested in a real browser or with a live Maps key; without a key the map falls back to a list.

### 11. Officer dashboard and login

- **Intent:** Give officers a protected view to list, filter, map and update complaints.
- **Expected Outcomes:** Login with the single shared credential from env vars; list with filters (ward, zone, severity, issue type, status, date); map view; detail view including photos and both texts; status update with timestamp.
- **Todo List:**
  1. Login and session handling; HTTPS only; rate-limit failed attempts.
  2. Protect all officer endpoints and pages.
  3. List and filter view over the JSON files (note: reads all files; fine for demo volumes).
  4. Map view of complaints.
  5. Detail view and status update; append a status history entry to the record (schema change if needed).
  6. Decide with the user whether the dashboard can also trigger email dispatch.
- **Relevant Context:** Shared credential means no per-officer audit trail; document this limitation.
- **Status:** [~] built (`officer.html`, `officer.js`). Shared credential from env, HMAC-signed cookie session (HttpOnly, SameSite=Strict, Secure by default), login rate limit, same-origin check on state changes, filters, map, detail and status update with history. Dashboard does NOT trigger email dispatch (decision defaulted to status updates only; not confirmed). NOT tested in a real browser.

### 12. Website end-to-end test and documentation

- **Intent:** Verify the web flows and bring the docs in line.
- **Expected Outcomes:** Web and WhatsApp complaints both appear in the dashboard and tracking page; private fields never appear on public pages; docs updated.
- **Todo List:**
  1. Test: web submission end to end; tracking lookup (valid and invalid ID); public map shows no private data; officer login success and failure; status update visible on the tracking page; concurrent submissions do not corrupt files.
  2. Test the no-GeoJSON fallback and ward override in the browser.
  3. Update `docs/HLD.md`, `docs/LLD.md`, `docs/README.md` and `docs/skills.md` to include the website, storage limits and the new status values.
  4. Document setup and deployment, including HTTPS and persistent storage.
- **Relevant Context:** `docs/` folder; draft docs currently describe a WhatsApp-only system.
- **Status:** [~] automated tests cover web submission, tracking (valid, invalid, unconfirmed), public-map privacy, officer login success and failure, status update visible on tracking, and concurrent submissions (66 tests). Browser-level tests were NOT run. Docs updated; see `README.md`.
