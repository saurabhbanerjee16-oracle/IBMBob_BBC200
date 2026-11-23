# BBMP Pothole Complaint Agent

A citizen sends a pothole photo on WhatsApp or through a website. The system classifies it, resolves the
BBMP ward, drafts a complaint in English and Kannada, emails it to a configured BBMP address after the
citizen confirms, and returns a tracking ID, severity, issue type and escalation timeline. The website adds a
public tracking page, a public map and an officer dashboard.

Design docs are in [`docs/`](docs/README.md). Status of each part is in [`pothole-complaint-plan.md`](pothole-complaint-plan.md).

## What is real and what is demo

| Part | Demo default | Real mode |
|---|---|---|
| Photo analysis | `VISION_PROVIDER=mock`: **no image analysis**, always returns "pothole / Medium" and says so | `openai`: any OpenAI-compatible vision chat API |
| Complaint text | `TEXT_PROVIDER=template`: fixed EN + KN template | `openai`: LLM-written EN + KN |
| Email | `EMAIL_TRANSPORT=outbox`: writes `outbox/<id>.eml`, sends nothing | `smtp` |
| Maps | No key: map pages fall back to lat/lng entry and a list; addresses stay empty | `GOOGLE_MAPS_API_KEY` (server) + `GOOGLE_MAPS_BROWSER_KEY` |
| Ward lookup | No GeoJSON: user picks the ward | Provide `data/bbmp-wards.geojson` |
| BBMP addresses | None configured (never invented) | Fill `config/bbmp-contacts.json` |
| Escalation days | `null` = "not configured" (never invented) | Fill `config/escalation.json` |

**Not verified:** nothing here has been run against live Google, WhatsApp, SMTP or AI services, or in a real
browser. Kannada text is machine-generated and unreviewed. See "Known limits".

## Quick start (local demo)

Requires Node 22.10+.

```bash
npm install
cp .env.example .env        # then edit .env, see below
npm run build
npm test                    # 66+ tests; needs the build first (MCP tests run dist/)
npm run start:web           # http://localhost:8787
```

Minimum `.env` for a local demo over plain HTTP:

```
OFFICER_USERNAME=officer
OFFICER_PASSWORD=choose-something-long
SESSION_SECRET=<random string, 32+ chars>
COOKIE_SECURE=false          # plain-HTTP localhost only; keep true behind HTTPS
```

Pages: `/` report, `/track.html`, `/map.html`, `/officer.html`.
Without those officer variables the officer area stays disabled and says why.

## Layout

```
src/core/      shared logic used by BOTH the web backend and the MCP servers
src/web/       Express app, session, rate limit
src/mcp/       thin MCP servers (vision, maps, complaints, whatsapp)
src/whatsapp/  WhatsApp Cloud API client + webhook helpers
web/public/    static pages (ES modules, no framework, no innerHTML)
schema/ config/ data/   contract and config; complaints/ holds one JSON per complaint
test/          vitest suites
```

## Register the MCP servers in Bob

After `npm run build`, add to your Bob `mcp.json` (use absolute paths; Bob does not expand `${VAR}`):

```json
{
  "mcpServers": {
    "bbmp-vision":     { "command": "node", "args": ["C:/IBMBob_BBC200/dist/mcp/vision.js"] },
    "bbmp-maps":       { "command": "node", "args": ["C:/IBMBob_BBC200/dist/mcp/maps.js"] },
    "bbmp-complaints": { "command": "node", "args": ["C:/IBMBob_BBC200/dist/mcp/complaints.js"] },
    "bbmp-whatsapp":   { "command": "node", "args": ["C:/IBMBob_BBC200/dist/mcp/whatsapp.js"] }
  }
}
```

The servers read the project `.env` themselves, so keys stay out of `mcp.json`. They log to stderr only.
The skill that drives them is `.bob/skills/pothole-complaint/SKILL.md`.

## WhatsApp setup (unverified)

Needs a Meta business account and the WhatsApp Cloud API. The webhook must be reachable over public HTTPS
(for example a tunnel in development). Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`; point Meta's webhook at `https://<host>/webhook`
(port `WHATSAPP_WEBHOOK_PORT`). Without `WHATSAPP_APP_SECRET` every webhook POST is refused.
The webhook lives inside the MCP server process, so messages are queued in memory and lost on restart.
Free-form replies only work inside WhatsApp's 24-hour window.

## Security notes

- Tracking IDs are random (50 bits). Unknown, malformed and unconfirmed-draft IDs return the same 404.
- Public pages use an allow-list projection: status, severity, issue type, ward, escalation, photos.
  Reporter name/contact, address, letter text, officer notes and exact coordinates are never included
  (map pins are rounded to about 110 m).
- Uploads are decoded and re-encoded, which drops EXIF/GPS; stored under random names; max 5 photos, 8 MB each.
- Officer login: one shared credential from env, constant-time compare, 5 failures per IP / 15 min plus a
  global cap, HMAC-signed HttpOnly SameSite=Strict cookie (Secure unless `COOKIE_SECURE=false`),
  same-origin check on state changes. **Serve over HTTPS.** Behind a proxy set `TRUST_PROXY=<hops>` or
  rate limits will key on the proxy's address.
- Pages build the DOM with `textContent` only and ship a strict Content-Security-Policy.

## Known limits

- **Storage:** JSON files. The in-process lock stops lost updates inside one process only; the web server and
  the complaints MCP server are separate processes and can still race on the same file. Lists read every file.
  Demo volumes only. Hosting must keep `complaints/` and `complaints/photos/` on persistent disk.
- **Sessions** are stateless: logout clears the cookie but a stolen cookie works until it expires (8 h).
  One shared officer login means no per-officer audit trail. Rate limits are in memory and reset on restart.
- **Photos are public** and may show faces or number plates. They are not blurred. The submit page warns
  and requires an acknowledgement.
- **Email** to BBMP is best effort. No BBMP API is used and no delivery confirmation exists.
- Decisions made by the implementer and not confirmed: web stack, the four officer statuses, coarse public
  pins, officer dashboard cannot send email, severity rubric in `src/core/vision.ts`.
- Open: ward GeoJSON source, BBMP email addresses, escalation day values, photo blurring, real Kannada review.

## Scripts

`npm run build` | `npm run typecheck` | `npm test` | `npm run start:web` | `npm run start:mcp:<vision|maps|complaints|whatsapp>`
