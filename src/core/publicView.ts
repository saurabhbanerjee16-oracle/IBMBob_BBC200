import type { Complaint, EscalationStep, IssueType, Severity, Status } from "./types.js";

/** Pin precision on the public map is an open item in the plan. Default: coarse (3 decimals, about 110 m). */
export const PUBLIC_COORD_DECIMALS = 3;

export interface PublicComplaint {
  tracking_id: string;
  status: Status;
  severity: Severity;
  issue_type: IssueType;
  ward: string | null;
  zone: string | null;
  created_at: string;
  escalation: EscalationStep[];
  /** Status changes without officer notes. */
  status_history: { status: Status; at: string }[];
  /** Photo file names; served from /photos/<name> (EXIF already stripped, names random). */
  photos: string[];
}

export interface PublicMapPin extends PublicComplaint {
  lat: number;
  lng: number;
}

function round(n: number): number {
  const f = 10 ** PUBLIC_COORD_DECIMALS;
  return Math.round(n * f) / f;
}

/**
 * Public projection (allow-list, not deny-list): reporter, contact, name, address, exact coordinates,
 * complaint text and officer notes are never copied, so new private fields cannot leak by default.
 */
export function toPublic(c: Complaint): PublicComplaint {
  return {
    tracking_id: c.tracking_id,
    status: c.status,
    severity: c.severity,
    issue_type: c.issue_type,
    ward: c.location.ward,
    zone: c.location.zone,
    created_at: c.created_at,
    escalation: c.escalation.map((s) => ({ level: s.level, days: s.days, due: s.due })),
    status_history: c.status_history.map((h) => ({ status: h.status, at: h.at })),
    photos: [...c.photos],
  };
}

export function toPublicPin(c: Complaint): PublicMapPin {
  return { ...toPublic(c), lat: round(c.location.lat), lng: round(c.location.lng) };
}

/** Unconfirmed drafts are never public. */
export function isPublic(c: Complaint): boolean {
  return c.status !== "drafted";
}

export interface WardCount {
  ward: string;
  count: number;
}

export function wardCounts(complaints: Complaint[]): WardCount[] {
  const counts = new Map<string, number>();
  for (const c of complaints) {
    const ward = c.location.ward ?? "Unknown";
    counts.set(ward, (counts.get(ward) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([ward, count]) => ({ ward, count }))
    .sort((a, b) => b.count - a.count || a.ward.localeCompare(b.ward));
}
