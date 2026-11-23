import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import type { Config } from "../core/config.js";
import { AppError } from "../core/errors.js";
import { isPhotoName, isTrackingId } from "../core/ids.js";
import { confirmComplaint, createDraft, updateStatus, wardChoices } from "../core/pipeline.js";
import { MAX_PHOTOS, MAX_UPLOAD_BYTES, readPhoto, storePhoto } from "../core/photos.js";
import { isPublic, toPublic, toPublicPin, wardCounts } from "../core/publicView.js";
import { getComplaint, listComplaints } from "../core/store.js";
import { ISSUE_TYPES, OFFICER_STATUSES, SEVERITIES, type Complaint } from "../core/types.js";
import type { FetchLike } from "../core/maps.js";
import { RateLimiter } from "./rateLimit.js";
import {
  MIN_SECRET_LENGTH,
  SESSION_COOKIE,
  clearedSessionCookie,
  createSessionToken,
  parseCookies,
  safeEqual,
  sessionCookie,
  verifySessionToken,
} from "./session.js";

export interface AppDeps {
  fetchFn?: FetchLike;
}

const NOT_FOUND_MESSAGE = "No complaint found for that tracking ID.";
const MAX_OFFICER_RESULTS = 500;

function csp(): string {
  return [
    "default-src 'self'",
    // Google Maps JS API needs several Google hosts plus blob workers (see Google's CSP guidance).
    "script-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.ggpht.com https://*.googleusercontent.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' https://*.googleapis.com https://*.google.com https://*.gstatic.com",
    "worker-src blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

function field(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = body?.[key];
  return typeof v === "string" ? v : undefined;
}

function parseCoordinate(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function officerConfigured(config: Config): boolean {
  const w = config.web;
  return !!(w.officerUsername && w.officerPassword && w.sessionSecret && w.sessionSecret.length >= MIN_SECRET_LENGTH);
}

export function createApp(config: Config, deps: AppDeps = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.web.trustProxy);

  const draftLimiter = new RateLimiter(10, 60 * 60 * 1000);
  const trackLimiter = new RateLimiter(60, 60 * 1000);
  const loginFailuresByIp = new RateLimiter(5, 15 * 60 * 1000);
  const loginFailuresGlobal = new RateLimiter(100, 15 * 60 * 1000);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_PHOTOS, fields: 10, fieldSize: 1024 },
  });

  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", csp());
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
    next();
  });

  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "50kb" }));

  // ---------- public: config and reference data ----------

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/config", async (_req, res) => {
    res.json({
      maps_browser_key: config.googleMapsBrowserKey,
      max_photos: MAX_PHOTOS,
      max_photo_mb: MAX_UPLOAD_BYTES / 1024 / 1024,
      demo_vision: config.vision.provider === "mock",
      officer_enabled: officerConfigured(config),
      issue_types: ISSUE_TYPES,
      severities: SEVERITIES,
      officer_statuses: OFFICER_STATUSES,
    });
  });

  app.get("/api/wards", async (_req, res) => {
    res.json({ wards: await wardChoices(config) });
  });

  // ---------- public: photos ----------

  app.get("/photos/:name", async (req, res) => {
    const name = String(req.params.name);
    if (!isPhotoName(name)) throw new AppError("not_found", "Photo not found.");
    const bytes = await readPhoto(config, name);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.send(bytes);
  });

  // ---------- public: citizen submission ----------

  app.post("/api/drafts", upload.array("photos", MAX_PHOTOS), async (req, res) => {
    const ip = req.ip ?? "unknown";
    if (!draftLimiter.hit(ip)) {
      res.setHeader("Retry-After", String(draftLimiter.retryAfterSeconds(ip)));
      throw new AppError("rate_limited", "Too many submissions from this address. Please try again later.");
    }
    const files = (req.files ?? []) as Express.Multer.File[];
    if (files.length === 0) throw new AppError("validation", "Please upload at least one photo.", "photos_required");

    const stored = [];
    for (const f of files) stored.push(await storePhoto(config, f.buffer));

    let lat = parseCoordinate(field(req.body, "lat"));
    let lng = parseCoordinate(field(req.body, "lng"));
    if ((lat !== null && Number.isNaN(lat)) || (lng !== null && Number.isNaN(lng))) {
      throw new AppError("validation", "Latitude and longitude must be numbers.", "bad_coordinates");
    }
    if (lat === null || lng === null) {
      const exif = stored.find((p) => p.gps)?.gps;
      if (!exif) throw new AppError("validation", "Please drop a pin on the map or enter a location.", "location_required");
      lat = exif.lat;
      lng = exif.lng;
    }

    const result = await createDraft(
      config,
      {
        photos: stored.map((p) => p.name),
        lat,
        lng,
        ward: field(req.body, "ward"),
        zone: field(req.body, "zone"),
        reporter: { channel: "web", contact: field(req.body, "contact") ?? null, name: field(req.body, "name") ?? null },
      },
      deps.fetchFn,
    );
    const c = result.complaint;
    res.status(201).json({
      tracking_id: c.tracking_id,
      issue_type: c.issue_type,
      severity: c.severity,
      confidence: result.vision.confidence,
      vision_description: result.vision.description,
      vision_provider: result.vision.provider,
      location: c.location,
      photos: c.photos,
      text: c.text,
      needs_human_review: c.needs_human_review,
      status: c.status,
      ward_resolved: result.ward_resolved,
      ward_source: result.ward_source,
      escalation: c.escalation,
    });
  });

  app.post("/api/complaints/:id/confirm", async (req, res) => {
    const id = String(req.params.id);
    if (!isTrackingId(id)) throw new AppError("not_found", "Draft not found.");
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.photos_public_ack !== true) {
      throw new AppError("validation", "You must acknowledge that your photos will be publicly visible.", "photos_public_ack_required");
    }
    const existing = await getComplaint(config, id);
    if (!existing) throw new AppError("not_found", "Draft not found.");
    const text = body.text as { en?: unknown; kn?: unknown } | undefined;
    const result = await confirmComplaint(
      config,
      id,
      {
        text: {
          en: typeof text?.en === "string" ? text.en : undefined,
          kn: typeof text?.kn === "string" ? text.kn : undefined,
        },
        ward: typeof body.ward === "string" ? body.ward : undefined,
        zone: typeof body.zone === "string" ? body.zone : undefined,
      },
    );
    res.json({
      tracking_id: result.complaint.tracking_id,
      status: result.complaint.status,
      issue_type: result.complaint.issue_type,
      severity: result.complaint.severity,
      ward: result.complaint.location.ward,
      zone: result.complaint.location.zone,
      escalation: result.complaint.escalation,
      escalation_report: result.escalation,
      emailed: true,
      demo_outbox: result.email.transport === "outbox",
    });
  });

  // ---------- public: tracking and map ----------

  app.get("/api/track/:id", (req, res, next) => {
    const ip = req.ip ?? "unknown";
    if (!trackLimiter.hit(ip)) {
      res.setHeader("Retry-After", String(trackLimiter.retryAfterSeconds(ip)));
      return next(new AppError("rate_limited", "Too many lookups. Please wait a moment."));
    }
    const id = String(req.params.id).trim().toUpperCase();
    // Malformed, unknown and unsubmitted-draft IDs all return the same answer.
    getComplaint(config, isTrackingId(id) ? id : "BBMP-0000000000")
      .then((c) => {
        if (!c || !isPublic(c)) throw new AppError("not_found", NOT_FOUND_MESSAGE);
        res.json(toPublic(c));
      })
      .catch(next);
  });

  app.get("/api/public/map", async (req, res) => {
    const severity = typeof req.query.severity === "string" ? req.query.severity : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const all = (await listComplaints(config)).filter(isPublic);
    const filtered = all.filter((c) => (!severity || c.severity === severity) && (!status || c.status === status));
    res.json({
      pins: filtered.map(toPublicPin),
      ward_counts: wardCounts(filtered),
      total: filtered.length,
      coordinates_precision: "coarse (about 110 m)",
    });
  });

  // ---------- officer ----------

  const requireOfficer = (req: Request, _res: Response, next: NextFunction): void => {
    if (!officerConfigured(config)) return next(new AppError("config", "The officer area is not configured on this server."));
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!verifySessionToken(config.web.sessionSecret as string, token)) {
      return next(new AppError("unauthorized", "Please sign in."));
    }
    next();
  };

  /** Cookie auth needs CSRF defence: SameSite=Strict plus a same-origin check on state-changing requests. */
  const sameOrigin = (req: Request, _res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin) {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {
        /* malformed origin is rejected below */
      }
      if (host !== req.headers.host) return next(new AppError("unauthorized", "Cross-origin request refused."));
    }
    next();
  };

  app.post("/api/officer/login", sameOrigin, (req, res) => {
    if (!officerConfigured(config)) throw new AppError("config", "The officer area is not configured on this server.");
    const ip = req.ip ?? "unknown";
    if (loginFailuresByIp.isLimited(ip) || loginFailuresGlobal.isLimited("*")) {
      res.setHeader("Retry-After", String(loginFailuresByIp.retryAfterSeconds(ip)));
      throw new AppError("rate_limited", "Too many failed sign-in attempts. Please try again later.");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    // Evaluate both comparisons so timing does not reveal which one failed.
    const userOk = safeEqual(username, config.web.officerUsername as string);
    const passOk = safeEqual(password, config.web.officerPassword as string);
    if (!(userOk && passOk)) {
      loginFailuresByIp.hit(ip);
      loginFailuresGlobal.hit("*");
      throw new AppError("unauthorized", "Incorrect username or password.");
    }
    loginFailuresByIp.reset(ip);
    res.setHeader("Set-Cookie", sessionCookie(createSessionToken(config.web.sessionSecret as string), config.web.cookieSecure));
    res.json({ ok: true });
  });

  app.post("/api/officer/logout", sameOrigin, (_req, res) => {
    res.setHeader("Set-Cookie", clearedSessionCookie(config.web.cookieSecure));
    res.json({ ok: true });
  });

  app.get("/api/officer/session", requireOfficer, (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/officer/complaints", requireOfficer, async (req, res) => {
    const q = req.query;
    const s = (k: string): string | undefined => (typeof q[k] === "string" && q[k] !== "" ? (q[k] as string) : undefined);
    const from = s("from") ? Date.parse(s("from") as string) : null;
    // `to` is a date; include that whole day.
    const to = s("to") ? Date.parse(s("to") as string) + 24 * 60 * 60 * 1000 : null;
    if ((from !== null && Number.isNaN(from)) || (to !== null && Number.isNaN(to))) {
      throw new AppError("validation", "from/to must be dates like 2026-01-31.");
    }
    const matches = (c: Complaint): boolean =>
      (!s("ward") || c.location.ward === s("ward")) &&
      (!s("zone") || c.location.zone === s("zone")) &&
      (!s("severity") || c.severity === s("severity")) &&
      (!s("issue_type") || c.issue_type === s("issue_type")) &&
      (!s("status") || c.status === s("status")) &&
      (!s("channel") || c.reporter.channel === s("channel")) &&
      (from === null || Date.parse(c.created_at) >= from) &&
      (to === null || Date.parse(c.created_at) < to);
    const all = (await listComplaints(config)).filter(matches).sort((a, b) => b.created_at.localeCompare(a.created_at));
    res.json({ total: all.length, truncated: all.length > MAX_OFFICER_RESULTS, complaints: all.slice(0, MAX_OFFICER_RESULTS) });
  });

  app.get("/api/officer/complaints/:id", requireOfficer, async (req, res) => {
    const id = String(req.params.id);
    if (!isTrackingId(id)) throw new AppError("not_found", "Complaint not found.");
    const c = await getComplaint(config, id);
    if (!c) throw new AppError("not_found", "Complaint not found.");
    res.json(c);
  });

  app.patch("/api/officer/complaints/:id/status", sameOrigin, requireOfficer, async (req, res) => {
    const id = String(req.params.id);
    if (!isTrackingId(id)) throw new AppError("not_found", "Complaint not found.");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = await updateStatus(
      config,
      id,
      typeof body.status === "string" ? body.status : "",
      typeof body.note === "string" ? body.note : null,
    );
    res.json(updated);
  });

  app.use("/api", (_req, _res, next) => next(new AppError("not_found", "Unknown API endpoint.")));

  // ---------- static pages ----------

  app.use(
    express.static(path.join(config.root, "web", "public"), {
      extensions: ["html"],
      setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
    }),
  );

  // ---------- errors ----------

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.httpStatus).json({ error: { code: err.code, message: err.message, detail: err.detail ?? null } });
      return;
    }
    if (err instanceof multer.MulterError) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? `Each photo must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller.`
          : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
            ? `You can upload up to ${MAX_PHOTOS} photos.`
            : "The upload could not be processed.";
      res.status(400).json({ error: { code: "validation", message, detail: err.code } });
      return;
    }
    if ((err as { type?: string })?.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "validation", message: "Request body is not valid JSON.", detail: null } });
      return;
    }
    console.error("Unhandled error:", err);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong. Please try again.", detail: null } });
  });

  return app;
}
