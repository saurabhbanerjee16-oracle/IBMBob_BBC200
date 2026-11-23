import { describe, expect, it } from "vitest";
import { isPhotoName, isTrackingId, newPhotoName, newTrackingId } from "../src/core/ids.js";
import { computeEscalation, escalationReport } from "../src/core/escalation.js";
import { toPublic, toPublicPin, wardCounts } from "../src/core/publicView.js";
import { pointInRing } from "../src/core/wards.js";
import type { Complaint } from "../src/core/types.js";

describe("ids", () => {
  it("generates unique, well-formed tracking IDs", () => {
    const ids = new Set(Array.from({ length: 2000 }, newTrackingId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(isTrackingId(id)).toBe(true);
  });
  it("rejects malformed IDs (including path traversal)", () => {
    for (const bad of ["", "BBMP-1", "bbmp-0123456789", "../etc/passwd", "BBMP-0123456789.json", "BBMP-ILOU000000"]) {
      expect(isTrackingId(bad)).toBe(false);
    }
  });
  it("generates random photo names and validates them", () => {
    const n = newPhotoName();
    expect(isPhotoName(n)).toBe(true);
    expect(isPhotoName("../x.jpg")).toBe(false);
    expect(isPhotoName("abc.jpg")).toBe(false);
  });
});

describe("escalation", () => {
  const created = "2026-01-01T00:00:00.000Z";
  it("leaves due null when days are not configured", () => {
    const steps = computeEscalation(created, [
      { level: "ward_engineer", days: null },
      { level: "zone", days: null },
    ]);
    expect(steps.every((s) => s.due === null)).toBe(true);
    const report = escalationReport(steps, new Date("2026-02-01"));
    expect(report.configured).toBe(false);
    expect(report.message).toMatch(/not configured/i);
  });
  it("computes due dates when days are set", () => {
    const steps = computeEscalation(created, [
      { level: "ward_engineer", days: 3 },
      { level: "zone", days: 7 },
      { level: "commissioner", days: null },
    ]);
    expect(steps[0]?.due).toBe("2026-01-04T00:00:00.000Z");
    expect(steps[1]?.due).toBe("2026-01-08T00:00:00.000Z");
    expect(steps[2]?.due).toBeNull();
  });
  it("reports current level and next due without claiming BBMP acted", () => {
    const steps = computeEscalation(created, [
      { level: "ward_engineer", days: 3 },
      { level: "zone", days: 7 },
      { level: "commissioner", days: 14 },
    ]);
    const r = escalationReport(steps, new Date("2026-01-05T00:00:00Z"));
    expect(r.current_level).toBe("ward_engineer");
    expect(r.next_due?.level).toBe("zone");
    expect(r.message).toMatch(/does not mean BBMP has acted/);
    const before = escalationReport(steps, new Date("2026-01-02T00:00:00Z"));
    expect(before.current_level).toBeNull();
    const after = escalationReport(steps, new Date("2026-03-01T00:00:00Z"));
    expect(after.current_level).toBe("commissioner");
    expect(after.next_due).toBeNull();
  });
});

describe("pointInRing", () => {
  const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  it("detects inside and outside", () => {
    expect(pointInRing(5, 5, square)).toBe(true);
    expect(pointInRing(15, 5, square)).toBe(false);
    expect(pointInRing(-1, -1, square)).toBe(false);
  });
});

function sample(): Complaint {
  return {
    tracking_id: "BBMP-0123456789",
    reporter: { channel: "web", contact: "secret@example.com", name: "Secret Name" },
    location: { lat: 12.971599, lng: 77.594566, address: "1 Private Rd", ward: "Ward A", zone: "Zone East" },
    photos: ["0123456789abcdef0123456789abcdef.jpg"],
    issue_type: "pothole",
    severity: "High",
    text: { en: "private letter text", kn: "ಖಾಸಗಿ" },
    needs_human_review: true,
    status: "submitted",
    status_history: [{ status: "submitted", at: "2026-01-01T00:00:00.000Z", note: "internal officer note" }],
    created_at: "2026-01-01T00:00:00.000Z",
    escalation: [{ level: "ward_engineer", days: null, due: null }],
  };
}

describe("public projection", () => {
  it("never leaks reporter data, address, text or officer notes", () => {
    const json = JSON.stringify(toPublic(sample()));
    for (const secret of ["secret@example.com", "Secret Name", "1 Private Rd", "private letter text", "internal officer note", "reporter", "contact"]) {
      expect(json).not.toContain(secret);
    }
    expect(JSON.parse(json).photos).toEqual(["0123456789abcdef0123456789abcdef.jpg"]);
  });
  it("coarsens public pin coordinates", () => {
    const pin = toPublicPin(sample());
    expect(pin.lat).toBe(12.972);
    expect(pin.lng).toBe(77.595);
  });
  it("counts complaints per ward", () => {
    const a = sample();
    const b = { ...sample(), location: { ...sample().location, ward: null } };
    expect(wardCounts([a, a, b])).toEqual([
      { ward: "Ward A", count: 2 },
      { ward: "Unknown", count: 1 },
    ]);
  });
});
