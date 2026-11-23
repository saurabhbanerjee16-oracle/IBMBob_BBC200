import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearWardCache, lookupWard } from "../src/core/wards.js";
import { confirmComplaint, createDraft, getStatus, updateStatus } from "../src/core/pipeline.js";
import { readExifGps, storePhoto } from "../src/core/photos.js";
import { getComplaint, listComplaints, saveComplaint, updateComplaint } from "../src/core/store.js";
import { resolveRecipient } from "../src/core/contacts.js";
import { sendComplaintEmail } from "../src/core/email.js";
import { AppError } from "../src/core/errors.js";
import { analyzeImage } from "../src/core/vision.js";
import { draftText } from "../src/core/drafting.js";
import { jpegWithExif, makeTestEnv, sampleJpeg, WARDS_GEOJSON, writeJson, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  clearWardCache();
  env = await makeTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

async function photo(): Promise<string> {
  return (await storePhoto(env.config, await sampleJpeg())).name;
}

describe("photos", () => {
  it("strips EXIF (GPS, author) from the stored copy but reports GPS from the original", async () => {
    const original = await jpegWithExif();
    expect(await readExifGps(original)).not.toBeNull();
    const stored = await storePhoto(env.config, original);
    expect(stored.gps?.lat).toBeCloseTo(12.97, 1);
    const bytes = await readFile(path.join(env.config.photosDir, stored.name));
    expect(await readExifGps(bytes)).toBeNull();
    const meta = await sharp(bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(bytes.includes(Buffer.from("Secret Reporter"))).toBe(false);
    expect(stored.name).toMatch(/^[0-9a-f]{32}\.jpg$/);
  });
  it("rejects non-image bytes even if the client calls them images", async () => {
    await expect(storePhoto(env.config, Buffer.from("<html>not an image</html>"))).rejects.toMatchObject({ code: "validation" });
  });
  it("rejects empty files", async () => {
    await expect(storePhoto(env.config, new Uint8Array())).rejects.toMatchObject({ code: "validation" });
  });
});

describe("wards", () => {
  it("returns null when the GeoJSON is absent", async () => {
    expect(await lookupWard(env.config, 12.95, 77.55)).toBeNull();
  });
  it("matches wards and respects holes", async () => {
    await writeJson(env.config.wardsPath, WARDS_GEOJSON);
    expect(await lookupWard(env.config, 12.95, 77.55)).toEqual({ ward: "Ward A", zone: "Zone East" });
    expect(await lookupWard(env.config, 12.92, 77.65)).toEqual({ ward: "Ward B", zone: "Zone West" });
    expect(await lookupWard(env.config, 13.0, 77.7)).toBeNull(); // inside Ward B's hole
    expect(await lookupWard(env.config, 14, 78)).toBeNull();
  });
  it("fails loudly on a broken GeoJSON instead of guessing", async () => {
    await writeJson(env.config.wardsPath, { type: "Nope" });
    await expect(lookupWard(env.config, 12.95, 77.55)).rejects.toMatchObject({ code: "config" });
  });
});

describe("store", () => {
  it("validates before saving and round-trips", async () => {
    const { complaint } = await createDraft(env.config, { photos: [await photo()], lat: 12.95, lng: 77.55, reporter: { channel: "web", contact: null } });
    expect(await getComplaint(env.config, complaint.tracking_id)).toEqual(complaint);
    await expect(saveComplaint(env.config, { ...complaint, severity: "Huge" as never })).rejects.toMatchObject({ code: "validation" });
    await expect(saveComplaint(env.config, { ...complaint, tracking_id: "BBMP-1" })).rejects.toMatchObject({ code: "validation" });
  });
  it("returns null for unknown IDs and rejects malformed ones", async () => {
    expect(await getComplaint(env.config, "BBMP-0000000000")).toBeNull();
    await expect(getComplaint(env.config, "../../etc/passwd")).rejects.toBeInstanceOf(AppError);
  });
  it("does not lose updates or corrupt files under concurrent writes", async () => {
    const { complaint } = await createDraft(env.config, { photos: [await photo()], lat: 12.95, lng: 77.55, reporter: { channel: "web", contact: null } });
    await updateComplaint(env.config, complaint.tracking_id, (c) => ({ ...c, status: "submitted" }));
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateComplaint(env.config, complaint.tracking_id, (c) => ({
          ...c,
          status_history: [...c.status_history, { status: "submitted", at: new Date().toISOString(), note: `n${i}` }],
        })),
      ),
    );
    const final = await getComplaint(env.config, complaint.tracking_id);
    expect(final?.status_history.length).toBe(1 + N);
    const files = await readdir(env.config.complaintsDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("many concurrent submissions all produce valid, listable files", async () => {
    const name = await photo();
    await Promise.all(
      Array.from({ length: 20 }, () => createDraft(env.config, { photos: [name], lat: 12.95, lng: 77.55, reporter: { channel: "web", contact: null } })),
    );
    expect((await listComplaints(env.config)).length).toBe(20);
  });
});

describe("pipeline", () => {
  it("drafts with unknown ward when no GeoJSON, then accepts a user-chosen ward", async () => {
    const r = await createDraft(env.config, { photos: [await photo()], lat: 12.95, lng: 77.55, reporter: { channel: "web", contact: "a@b.c" } });
    expect(r.ward_resolved).toBe(false);
    expect(r.complaint.status).toBe("drafted");
    expect(r.complaint.needs_human_review).toBe(true);
    expect(r.complaint.text.kn.length).toBeGreaterThan(0);
    const ov = await createDraft(env.config, { photos: [await photo()], lat: 12.95, lng: 77.55, ward: "Ward X", zone: "Zone Y", reporter: { channel: "web", contact: null } });
    expect(ov.ward_source).toBe("user");
    expect(ov.complaint.location.ward).toBe("Ward X");
  });
  it("resolves the ward from GeoJSON, and a user override wins", async () => {
    await writeJson(env.config.wardsPath, WARDS_GEOJSON);
    const auto = await createDraft(env.config, { photos: [await photo()], lat: 12.95, lng: 77.55, reporter: { channel: "web", contact: null } });
    expect(auto.ward_source).toBe("geojson");
    expect(auto.complaint.location).toMatchObject({ ward: "Ward A", zone: "Zone East" });
    const ov = await createDraft(env.config, { photos: [await photo()], lat: 12.95, lng: 77.55, ward: "Ward B", reporter: { channel: "web", contact: null } });
    expect(ov.complaint.location.ward).toBe("Ward B");
  });
  it("rejects bad coordinates and missing photos", async () => {
    await expect(createDraft(env.config, { photos: [await photo()], lat: 95, lng: 0, reporter: { channel: "web", contact: null } })).rejects.toMatchObject({ code: "validation" });
    await expect(createDraft(env.config, { photos: [], lat: 12, lng: 77, reporter: { channel: "web", contact: null } })).rejects.toMatchObject({ code: "validation" });
  });
  it("confirm sends email to the outbox and marks submitted with history", async () => {
    const { complaint } = await createDraft(env.config, { photos: [await photo()], lat: 12.95, lng: 77.55, reporter: { channel: "web", contact: null } });
    const r = await confirmComplaint(env.config, complaint.tracking_id, { text: { en: "Edited English letter" } });
    expect(r.complaint.status).toBe("submitted");
    expect(r.complaint.text.en).toBe("Edited English letter");
    expect(r.complaint.needs_human_review).toBe(true);
    expect(r.complaint.status_history.map((h) => h.status)).toEqual(["drafted", "submitted"]);
    expect(r.email.recipient_source).toBe("demo");
    const raw = await readFile(r.email.outbox_file as string, "utf8");
    // Non-ASCII (Kannada) bodies are base64-encoded: decode each run of base64 lines before searching.
    const runs: string[] = [];
    let current: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(line)) current.push(line);
      else if (current.length) {
        runs.push(current.join(""));
        current = [];
      }
    }
    if (current.length) runs.push(current.join(""));
    const eml = raw + "\n" + runs.map((b) => Buffer.from(b, "base64").toString("utf8")).join("\n");
    expect(eml).toContain(complaint.tracking_id);
    expect(eml).toContain("Edited English letter");
    expect(r.escalation.configured).toBe(false);
    await expect(confirmComplaint(env.config, complaint.tracking_id)).rejects.toMatchObject({ code: "conflict" });
  });
  it("keeps status drafted when email cannot be sent (smtp with no recipient)", async () => {
    const smtp = await makeTestEnv({ EMAIL_TRANSPORT: "smtp", SMTP_HOST: "localhost", SMTP_FROM: "a@b.c" });
    try {
      const name = (await storePhoto(smtp.config, await sampleJpeg())).name;
      const { complaint } = await createDraft(smtp.config, { photos: [name], lat: 12.95, lng: 77.55, reporter: { channel: "web", contact: null } });
      await expect(confirmComplaint(smtp.config, complaint.tracking_id)).rejects.toMatchObject({ code: "config" });
      expect((await getComplaint(smtp.config, complaint.tracking_id))?.status).toBe("drafted");
    } finally {
      await smtp.cleanup();
    }
  });
  it("officer status updates append history and are limited to officer statuses", async () => {
    const { complaint } = await createDraft(env.config, { photos: [await photo()], lat: 12.95, lng: 77.55, reporter: { channel: "web", contact: null } });
    await expect(updateStatus(env.config, complaint.tracking_id, "acknowledged")).rejects.toMatchObject({ code: "conflict" });
    await confirmComplaint(env.config, complaint.tracking_id);
    await expect(updateStatus(env.config, complaint.tracking_id, "drafted")).rejects.toMatchObject({ code: "validation" });
    await expect(updateStatus(env.config, complaint.tracking_id, "bogus")).rejects.toMatchObject({ code: "validation" });
    const u = await updateStatus(env.config, complaint.tracking_id, "in_progress", "crew assigned");
    expect(u.status).toBe("in_progress");
    expect(u.status_history.at(-1)).toMatchObject({ status: "in_progress", note: "crew assigned" });
    expect((await getStatus(env.config, complaint.tracking_id)).status).toBe("in_progress");
  });
});

describe("contacts and email", () => {
  it("resolves ward -> zone -> default and never invents an address", async () => {
    await writeJson(env.config.contactsPath, {
      default: { email: "default@x.test" },
      zones: { Z1: { email: "zone@x.test" } },
      wards: { W1: { zone: "Z1", email: "ward@x.test" }, W2: { zone: "Z1", email: null }, W3: { zone: "Z9", email: null } },
    });
    expect(await resolveRecipient(env.config, "W1", "Z1")).toEqual({ email: "ward@x.test", source: "ward" });
    expect(await resolveRecipient(env.config, "W2", null)).toEqual({ email: "zone@x.test", source: "zone" });
    expect(await resolveRecipient(env.config, "W3", null)).toEqual({ email: "default@x.test", source: "default" });
    await writeJson(env.config.contactsPath, { default: { email: null }, zones: {}, wards: {} });
    expect(await resolveRecipient(env.config, "W1", "Z1")).toBeNull();
  });
  it("uses the configured ward address when present", async () => {
    await writeJson(env.config.contactsPath, { default: { email: null }, zones: {}, wards: { "Ward A": { zone: "Zone East", email: "wa@x.test" } } });
    const { complaint } = await createDraft(env.config, { photos: [await photo()], lat: 12.95, lng: 77.55, ward: "Ward A", reporter: { channel: "web", contact: null } });
    const r = await sendComplaintEmail(env.config, complaint);
    expect(r.recipient).toBe("wa@x.test");
    expect(r.recipient_source).toBe("ward");
  });
});

describe("vision and drafting", () => {
  it("mock vision is clearly labelled as not analysing the image", async () => {
    const r = await analyzeImage(env.config, "unused.jpg");
    expect(r.provider).toBe("mock");
    expect(r.description).toMatch(/no image analysis/i);
  });
  it("rejects non-road and low-confidence results from a real provider", async () => {
    const live = await makeTestEnv({ VISION_PROVIDER: "openai", VISION_API_KEY: "k", VISION_MODEL: "m" });
    try {
      const name = (await storePhoto(live.config, await sampleJpeg())).name;
      const file = path.join(live.config.photosDir, name);
      const reply = (obj: unknown) => async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
      const notRoad = await analyzeImage(live.config, file, reply({ issue_type: "not_a_road_issue", severity: "Low", confidence: 0.95, description: "a cat" }));
      expect(notRoad.acceptable).toBe(false);
      const unsure = await analyzeImage(live.config, file, reply({ issue_type: "pothole", severity: "High", confidence: 0.2, description: "blurry" }));
      expect(unsure.acceptable).toBe(false);
      const good = await analyzeImage(live.config, file, reply({ issue_type: "pothole", severity: "High", confidence: 0.9, description: "deep hole" }));
      expect(good).toMatchObject({ acceptable: true, severity: "High", provider: "openai" });
      await expect(analyzeImage(live.config, file, reply({ issue_type: "volcano", severity: "High", confidence: 0.9 }))).rejects.toMatchObject({ code: "upstream" });
      await expect(analyzeImage(live.config, file, async () => new Response("no", { status: 500 }))).rejects.toMatchObject({ code: "upstream" });
      // Draft is refused for a rejected photo.
      await expect(
        createDraft(live.config, { photos: [name], lat: 12.9, lng: 77.5, reporter: { channel: "web", contact: null } }, reply({ issue_type: "not_a_road_issue", severity: "Low", confidence: 0.9, description: "x" })),
      ).rejects.toMatchObject({ code: "validation", detail: "photo_rejected" });
    } finally {
      await live.cleanup();
    }
  });
  it("template text contains both languages and no reporter data", async () => {
    const t = await draftText(env.config, { issue_type: "pothole", severity: "High", description: "deep", lat: 12.9, lng: 77.5, address: "MG Road", ward: "Ward A", zone: null });
    expect(t.en).toContain("MG Road");
    expect(t.en).toContain("High");
    expect(/[\u0C80-\u0CFF]/.test(t.kn)).toBe(true);
  });
});
