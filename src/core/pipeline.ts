import type { Config } from "./config.js";
import { listConfiguredWards, zoneForWard } from "./contacts.js";
import { draftText } from "./drafting.js";
import { sendComplaintEmail, type EmailResult } from "./email.js";
import { AppError } from "./errors.js";
import { computeEscalation, escalationReport, loadEscalationLevels, type EscalationReport } from "./escalation.js";
import { newTrackingId } from "./ids.js";
import { reverseGeocode, type FetchLike } from "./maps.js";
import { getComplaint, saveComplaint, updateComplaint } from "./store.js";
import { OFFICER_STATUSES, type Complaint, type Status } from "./types.js";
import { analyzeImage, combineVision, type VisionResult } from "./vision.js";
import { listWards, lookupWard } from "./wards.js";
import { photoPath } from "./photos.js";

const MAX_TEXT_CHARS = 4000;
const MAX_FIELD_CHARS = 200;

export interface CreateDraftInput {
  /** Stored photo names (see `storePhoto`). */
  photos: string[];
  lat: number;
  lng: number;
  /** User-chosen ward/zone; wins over automatic lookup. */
  ward?: string | null;
  zone?: string | null;
  reporter: { channel: "whatsapp" | "web"; contact: string | null; name?: string | null };
}

export interface DraftResult {
  complaint: Complaint;
  vision: VisionResult;
  /** False when the ward was neither found nor supplied: the caller must ask the user to choose one. */
  ward_resolved: boolean;
  ward_source: "user" | "geojson" | "none";
}

function checkCoords(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new AppError("validation", "Latitude/longitude are not valid coordinates.");
  }
}

function cleanLabel(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  const v = value.trim();
  if (!v) return null;
  if (v.length > MAX_FIELD_CHARS) throw new AppError("validation", `${field} is too long.`);
  return v;
}

/** Vision -> geocode -> ward -> draft text -> save as `drafted`. Does not send anything. */
export async function createDraft(config: Config, input: CreateDraftInput, fetchFn: FetchLike = fetch): Promise<DraftResult> {
  checkCoords(input.lat, input.lng);
  if (input.photos.length === 0) throw new AppError("validation", "At least one photo is required.");

  const results: VisionResult[] = [];
  for (const name of input.photos) results.push(await analyzeImage(config, photoPath(config, name), fetchFn));
  const vision = combineVision(results);
  if (!vision.acceptable) throw new AppError("validation", vision.reject_reason ?? "Photo not accepted.", "photo_rejected");

  let address: string | null = null;
  try {
    address = await reverseGeocode(config, input.lat, input.lng, fetchFn);
  } catch (err) {
    // Address is a convenience; the pin itself is the source of truth. Continue without it.
    console.error("Reverse geocode failed:", err instanceof Error ? err.message : err);
  }

  let ward = cleanLabel(input.ward, "ward");
  let zone = cleanLabel(input.zone, "zone");
  let source: DraftResult["ward_source"] = ward ? "user" : "none";
  if (!ward) {
    const match = await lookupWard(config, input.lat, input.lng);
    if (match) {
      ward = match.ward;
      zone = zone ?? match.zone;
      source = "geojson";
    }
  }
  if (ward && !zone) zone = await zoneForWard(config, ward);

  const text = await draftText(config, {
    issue_type: vision.issue_type,
    severity: vision.severity,
    description: vision.description,
    lat: input.lat,
    lng: input.lng,
    address,
    ward,
    zone,
  });

  const now = new Date().toISOString();
  const complaint: Complaint = {
    tracking_id: newTrackingId(),
    reporter: {
      channel: input.reporter.channel,
      contact: cleanLabel(input.reporter.contact, "contact"),
      name: cleanLabel(input.reporter.name, "name"),
    },
    location: { lat: input.lat, lng: input.lng, address, ward, zone },
    photos: input.photos,
    issue_type: vision.issue_type,
    severity: vision.severity,
    text,
    needs_human_review: true,
    status: "drafted",
    status_history: [{ status: "drafted", at: now, note: null }],
    created_at: now,
    escalation: computeEscalation(now, await loadEscalationLevels(config)),
  };
  await saveComplaint(config, complaint);
  return { complaint, vision, ward_resolved: ward !== null, ward_source: source };
}

export interface ConfirmInput {
  /** Edited letter text; Kannada edits keep `needs_human_review` true. */
  text?: { en?: string; kn?: string };
  ward?: string | null;
  zone?: string | null;
}

export interface ConfirmResult {
  complaint: Complaint;
  email: EmailResult;
  escalation: EscalationReport;
}

function checkText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (!v) throw new AppError("validation", `${field} text cannot be empty.`);
  if (v.length > MAX_TEXT_CHARS) throw new AppError("validation", `${field} text is too long.`);
  return v;
}

/**
 * Apply the user's edits, email the complaint, then mark it `submitted`.
 * If sending fails, the record keeps its edits but stays `drafted`.
 */
export async function confirmComplaint(config: Config, id: string, input: ConfirmInput = {}): Promise<ConfirmResult> {
  const en = checkText(input.text?.en, "English");
  const kn = checkText(input.text?.kn, "Kannada");
  const ward = input.ward === undefined ? undefined : cleanLabel(input.ward, "ward");
  let zone = input.zone === undefined ? undefined : cleanLabel(input.zone, "zone");
  if (ward && zone === undefined) zone = await zoneForWard(config, ward);

  const edited = await updateComplaint(config, id, (c) => {
    if (c.status !== "drafted") throw new AppError("conflict", "This complaint has already been submitted.");
    return {
      ...c,
      text: { en: en ?? c.text.en, kn: kn ?? c.text.kn },
      needs_human_review: true,
      location: {
        ...c.location,
        ward: ward === undefined ? c.location.ward : ward,
        zone: zone === undefined ? c.location.zone : zone,
      },
    };
  });

  const email = await sendComplaintEmail(config, edited);
  const now = new Date().toISOString();
  const submitted = await updateComplaint(config, id, (c) => ({
    ...c,
    status: "submitted",
    status_history: [...c.status_history, { status: "submitted", at: now, note: null }],
  }));
  return { complaint: submitted, email, escalation: escalationReport(submitted.escalation) };
}

/** Officer status change. Only officer statuses are allowed; every change is appended to history. */
export async function updateStatus(config: Config, id: string, status: string, note?: string | null): Promise<Complaint> {
  if (!OFFICER_STATUSES.includes(status as Status)) {
    throw new AppError("validation", `Status must be one of: ${OFFICER_STATUSES.join(", ")}.`);
  }
  const cleanNote = note?.trim() ? note.trim() : null;
  if (cleanNote && cleanNote.length > 500) throw new AppError("validation", "Note must be 500 characters or fewer.");
  const now = new Date().toISOString();
  return updateComplaint(config, id, (c) => {
    if (c.status === "drafted") throw new AppError("conflict", "A draft that was never submitted cannot be updated by officers.");
    return { ...c, status: status as Status, status_history: [...c.status_history, { status: status as Status, at: now, note: cleanNote }] };
  });
}

export interface StatusReport {
  tracking_id: string;
  status: Status;
  escalation: EscalationReport;
}

export async function getStatus(config: Config, id: string): Promise<StatusReport> {
  const c = await getComplaint(config, id);
  if (!c) throw new AppError("not_found", "Complaint not found.");
  return { tracking_id: c.tracking_id, status: c.status, escalation: escalationReport(c.escalation) };
}

/** Ward choices for the selector: GeoJSON wards when present, else wards named in the contacts config. */
export async function wardChoices(config: Config): Promise<{ ward: string; zone: string | null }[]> {
  const fromGeo = await listWards(config);
  return fromGeo.length > 0 ? fromGeo : listConfiguredWards(config);
}
