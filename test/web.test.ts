import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/web/app.js";
import { clearWardCache } from "../src/core/wards.js";
import { jpegWithExif, makeTestEnv, sampleJpeg, WARDS_GEOJSON, writeJson, type TestEnv } from "./helpers.js";

let env: TestEnv;
let server: Server;
let base: string;

async function start(extra: Record<string, string> = {}): Promise<void> {
  clearWardCache();
  env = await makeTestEnv(extra);
  server = createApp(env.config).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  await start();
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await env.cleanup();
});

async function submitDraft(fields: Record<string, string> = {}, bytes?: Buffer): Promise<Response> {
  const form = new FormData();
  form.append("photos", new Blob([new Uint8Array(bytes ?? (await sampleJpeg()))], { type: "image/jpeg" }), "p.jpg");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(`${base}/api/drafts`, { method: "POST", body: form });
}

async function createSubmitted(fields: Record<string, string> = {}): Promise<{ id: string; photo: string }> {
  const draft = await (await submitDraft({ lat: "12.95", lng: "77.55", contact: "secret@example.com", name: "Secret Name", ...fields })).json();
  const res = await fetch(`${base}/api/complaints/${draft.tracking_id}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ photos_public_ack: true }),
  });
  expect(res.status).toBe(200);
  return { id: draft.tracking_id, photo: draft.photos[0] };
}

async function login(password = "correct horse battery"): Promise<Response> {
  return fetch(`${base}/api/officer/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "officer", password }),
  });
}

async function officerCookie(): Promise<string> {
  const res = await login();
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

describe("citizen flow", () => {
  it("draft -> confirm -> public tracking, end to end", async () => {
    const res = await submitDraft({ lat: "12.95", lng: "77.55", contact: "a@b.c" });
    expect(res.status).toBe(201);
    const draft = await res.json();
    expect(draft.status).toBe("drafted");
    expect(draft.needs_human_review).toBe(true);
    expect(draft.text.en.length).toBeGreaterThan(0);
    expect(draft.text.kn.length).toBeGreaterThan(0);
    expect(draft.vision_provider).toBe("mock");

    const confirm = await fetch(`${base}/api/complaints/${draft.tracking_id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ photos_public_ack: true, ward: "Ward Z" }),
    });
    expect(confirm.status).toBe(200);
    const done = await confirm.json();
    expect(done.status).toBe("submitted");
    expect(done.ward).toBe("Ward Z");
    expect(done.escalation_report.configured).toBe(false);

    const track = await (await fetch(`${base}/api/track/${draft.tracking_id}`)).json();
    expect(track).toMatchObject({ status: "submitted", severity: "Medium", issue_type: "pothole", ward: "Ward Z" });
  });

  it("refuses to confirm without the public-photo acknowledgement", async () => {
    const draft = await (await submitDraft({ lat: "12.95", lng: "77.55" })).json();
    const res = await fetch(`${base}/api/complaints/${draft.tracking_id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.detail).toBe("photos_public_ack_required");
  });

  it("requires a location unless the photo carries EXIF GPS", async () => {
    const none = await submitDraft({});
    expect(none.status).toBe(400);
    expect((await none.json()).error.detail).toBe("location_required");
    const withGps = await submitDraft({}, await jpegWithExif());
    expect(withGps.status).toBe(201);
    expect((await withGps.json()).location.lat).toBeCloseTo(12.97, 1);
  });

  it("validates input: no photo, bad coordinates, non-image, oversize", async () => {
    const empty = await fetch(`${base}/api/drafts`, { method: "POST", body: new FormData() });
    expect(empty.status).toBe(400);
    expect((await submitDraft({ lat: "abc", lng: "77" })).status).toBe(400);
    expect((await submitDraft({ lat: "95", lng: "77" })).status).toBe(400);
    expect((await submitDraft({ lat: "12", lng: "77" }, Buffer.from("not an image at all"))).status).toBe(400);
    const big = await submitDraft({ lat: "12", lng: "77" }, Buffer.alloc(9 * 1024 * 1024, 1));
    expect(big.status).toBe(400);
  });

  it("auto-fills the ward from GeoJSON", async () => {
    await writeJson(env.config.wardsPath, WARDS_GEOJSON);
    const draft = await (await submitDraft({ lat: "12.95", lng: "77.55" })).json();
    expect(draft.ward_resolved).toBe(true);
    expect(draft.location).toMatchObject({ ward: "Ward A", zone: "Zone East" });
  });

  it("rate limits draft submissions per IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await submitDraft({ lat: "12.95", lng: "77.55" })).status);
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

describe("public privacy", () => {
  it("tracking page and public map never expose reporter data, text, address or exact pin", async () => {
    const { id, photo } = await createSubmitted();
    const track = await (await fetch(`${base}/api/track/${id}`)).text();
    const map = await (await fetch(`${base}/api/public/map`)).text();
    for (const body of [track, map]) {
      for (const secret of ["secret@example.com", "Secret Name", "reporter", "contact", "needs_human_review", "Dear", "à²®à²¾à²¨à³à²¯à²°à³‡"]) {
        expect(body).not.toContain(secret);
      }
    }
    expect(JSON.parse(track).photos).toEqual([photo]);
    const pin = JSON.parse(map).pins[0];
    expect(pin.lat).toBe(12.95);
    expect(pin.photos).toEqual([photo]);
    expect(JSON.parse(map).ward_counts).toEqual([{ ward: "Unknown", count: 1 }]);
  });

  it("public map filters by severity and status", async () => {
    await createSubmitted();
    expect((await (await fetch(`${base}/api/public/map?severity=High`)).json()).total).toBe(0);
    expect((await (await fetch(`${base}/api/public/map?severity=Medium&status=submitted`)).json()).total).toBe(1);
  });

  it("unconfirmed drafts are hidden from tracking and the map; unknown and malformed IDs look identical", async () => {
    const draft = await (await submitDraft({ lat: "12.95", lng: "77.55" })).json();
    const results = await Promise.all(
      [draft.tracking_id, "BBMP-0000000000", "garbage", "../../etc/passwd"].map(async (id) => {
        const r = await fetch(`${base}/api/track/${encodeURIComponent(id)}`);
        return { status: r.status, body: await r.text() };
      }),
    );
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]?.status).toBe(404);
    expect((await (await fetch(`${base}/api/public/map`)).json()).total).toBe(0);
  });

  it("serves photos without EXIF and rejects non-generated names", async () => {
    const draft = await (await submitDraft({ lat: "12.95", lng: "77.55" }, await jpegWithExif())).json();
    const res = await fetch(`${base}/photos/${draft.photos[0]}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer()).includes(Buffer.from("Secret Reporter"))).toBe(false);
    for (const bad of ["..%2F..%2Fpackage.json", "abc.jpg", "0123456789abcdef0123456789abcdef.png"]) {
      expect((await fetch(`${base}/photos/${bad}`)).status).toBe(404);
    }
    expect((await fetch(`${base}/photos/00000000000000000000000000000000.jpg`)).status).toBe(404);
  });

  it("sets security headers and hides the framework", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("/api/config exposes the browser key but never server secrets", async () => {
    const cfg = await (await fetch(`${base}/api/config`)).text();
    expect(cfg).not.toContain("correct horse");
    expect(cfg).not.toContain("x".repeat(40));
    expect(JSON.parse(cfg).officer_enabled).toBe(true);
  });
});

describe("officer area", () => {
  it("protects every officer endpoint when not signed in", async () => {
    const { id } = await createSubmitted();
    const calls: [string, RequestInit?][] = [
      ["/api/officer/session"],
      ["/api/officer/complaints"],
      [`/api/officer/complaints/${id}`],
      [`/api/officer/complaints/${id}/status`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }) }],
    ];
    for (const [url, init] of calls) expect((await fetch(base + url, init)).status).toBe(401);
    const forged = await fetch(`${base}/api/officer/complaints`, { headers: { cookie: "officer_session=abc.def" } });
    expect(forged.status).toBe(401);
  });

  it("rejects wrong credentials and sets a hardened cookie on success", async () => {
    expect((await login("wrong")).status).toBe(401);
    const ok = await login();
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("sets the Secure flag when COOKIE_SECURE is not false", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await env.cleanup();
    await start({ COOKIE_SECURE: "true" });
    expect((await login()).headers.get("set-cookie")).toContain("Secure");
  });

  it("rate limits failed logins, then blocks even the right password until the window passes", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login("bad")).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await login()).status).toBe(429);
  });

  it("lists, filters, shows detail, and updates status with history visible on tracking", async () => {
    const { id } = await createSubmitted({ ward: "Ward Q" });
    const cookie = await officerCookie();
    const h = { cookie };

    const list = await (await fetch(`${base}/api/officer/complaints?ward=Ward%20Q&severity=Medium&status=submitted&channel=web`, { headers: h })).json();
    expect(list.total).toBe(1);
    expect(list.complaints[0].reporter.contact).toBe("secret@example.com"); // officers do see contact
    expect((await (await fetch(`${base}/api/officer/complaints?ward=Nope`, { headers: h })).json()).total).toBe(0);
    expect((await fetch(`${base}/api/officer/complaints?from=garbage`, { headers: h })).status).toBe(400);
    const today = new Date().toISOString().slice(0, 10);
    expect((await (await fetch(`${base}/api/officer/complaints?from=${today}&to=${today}`, { headers: h })).json()).total).toBe(1);

    const detail = await (await fetch(`${base}/api/officer/complaints/${id}`, { headers: h })).json();
    expect(detail.text.en.length).toBeGreaterThan(0);

    const patch = (body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${base}/api/officer/complaints/${id}/status`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json", ...extra },
        body: JSON.stringify(body),
      });
    expect((await patch({ status: "bogus" })).status).toBe(400);
    expect((await patch({ status: "drafted" })).status).toBe(400);
    expect((await patch({ status: "resolved", note: "x".repeat(501) })).status).toBe(400);
    const upd = await patch({ status: "in_progress", note: "crew assigned" });
    expect(upd.status).toBe(200);

    const track = await (await fetch(`${base}/api/track/${id}`)).json();
    expect(track.status).toBe("in_progress");
    expect(track.status_history.map((x: { status: string }) => x.status)).toEqual(["drafted", "submitted", "in_progress"]);
    expect(JSON.stringify(track)).not.toContain("crew assigned"); // officer notes stay private
  });

  it("refuses cross-origin state changes (CSRF defence)", async () => {
    const { id } = await createSubmitted();
    const cookie = await officerCookie();
    const res = await fetch(`${base}/api/officer/complaints/${id}/status`, {
      method: "PATCH",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(res.status).toBe(401);
    const loginRes = await fetch(`${base}/api/officer/login`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ username: "officer", password: "correct horse battery" }),
    });
    expect(loginRes.status).toBe(401);
  });

  it("stays disabled when the officer credential or a long session secret is missing", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await env.cleanup();
    await start({ OFFICER_PASSWORD: "", SESSION_SECRET: "short" });
    expect((await login()).status).toBe(500);
    expect((await fetch(`${base}/api/officer/complaints`)).status).toBe(500);
    expect((await (await fetch(`${base}/api/config`)).json()).officer_enabled).toBe(false);
  });

  it("logout clears the cookie", async () => {
    const res = await fetch(`${base}/api/officer/logout`, { method: "POST" });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("robustness", () => {
  it("returns JSON errors for bad JSON and unknown endpoints", async () => {
    const bad = await fetch(`${base}/api/officer/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it("handles concurrent submissions without corrupting files", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const f = new FormData();
        f.append("photos", new Blob([new Uint8Array(await sampleJpeg())], { type: "image/jpeg" }), "p.jpg");
        f.append("lat", "12.95");
        f.append("lng", "77.55");
        return fetch(`${base}/api/drafts`, { method: "POST", body: f });
      }),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = await Promise.all(results.map(async (r) => (await r.json()).tracking_id as string));
    expect(new Set(ids).size).toBe(8);
  });
});
