import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultRoot } from "../src/core/config.js";
import { sampleJpeg } from "./helpers.js";

/**
 * Speaks raw newline-delimited JSON-RPC to the compiled servers over stdio, so these tests
 * exercise the real transport and tool registration. Requires `npm run build` first (the
 * `pretest` hook is not used so a stale build is a visible failure, not a silent pass).
 */
class StdioClient {
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, (v: any) => void>();
  private proc;
  stderr = "";

  constructor(script: string, cwd: string, env: Record<string, string>) {
    this.proc = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
      }
    });
    this.proc.stderr.on("data", (d: Buffer) => (this.stderr += d.toString("utf8")));
  }

  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout on ${method}\n${this.stderr}`)), 15000);
      this.pending.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async init(): Promise<void> {
    const res = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    if (res.error) throw new Error(JSON.stringify(res.error));
    this.notify("notifications/initialized");
  }

  async call(name: string, args: unknown): Promise<{ isError: boolean; text: string; json: any }> {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res.error) throw new Error(JSON.stringify(res.error));
    const text: string = res.result.content[0].text;
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain-text error */
    }
    return { isError: !!res.result.isError, text, json };
  }

  async tools(): Promise<string[]> {
    return (await this.request("tools/list")).result.tools.map((t: { name: string }) => t.name);
  }

  close(): void {
    this.proc.kill();
  }
}

let dir: string;
const env = (): Record<string, string> => ({ VISION_PROVIDER: "mock", TEXT_PROVIDER: "template", EMAIL_TRANSPORT: "outbox" });

beforeAll(async () => {
  // The servers resolve the project root from their own location, so run a copy of the build in a temp project.
  dir = await mkdtemp(path.join(os.tmpdir(), "bbmp-mcp-"));
  const real = defaultRoot();
  await cp(path.join(real, "schema"), path.join(dir, "schema"), { recursive: true });
  await cp(path.join(real, "config"), path.join(dir, "config"), { recursive: true });
  await cp(path.join(real, "dist"), path.join(dir, "dist"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  // Reuse the real node_modules via a junction so imports resolve.
  await symlink(path.join(real, "node_modules"), path.join(dir, "node_modules"), "junction");
  await mkdir(path.join(dir, "uploads"), { recursive: true });
  await writeFile(path.join(dir, "uploads", "pothole.jpg"), await sampleJpeg());
  await writeFile(path.join(dir, "secret.txt"), "do not read");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const script = (f: string) => path.join(dir, "dist", "mcp", f);

describe("MCP servers over stdio", () => {
  it("vision: lists tools, analyses an uploads/ image, refuses paths outside uploads/", async () => {
    const c = new StdioClient(script("vision.js"), dir, env());
    try {
      await c.init();
      expect(await c.tools()).toEqual(expect.arrayContaining(["analyze_image", "analyze_images"]));
      const ok = await c.call("analyze_image", { image: "uploads/pothole.jpg" });
      expect(ok.isError).toBe(false);
      expect(ok.json).toMatchObject({ issue_type: "pothole", provider: "mock", acceptable: true });
      expect(ok.json.description).toMatch(/no image analysis/i);
      for (const bad of ["secret.txt", "../secret.txt", path.join(dir, "secret.txt"), "uploads/../secret.txt"]) {
        const r = await c.call("analyze_image", { image: bad });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/uploads/);
      }
    } finally {
      c.close();
    }
  }, 30000);

  it("maps: ward lookup reports unresolved without GeoJSON; geocode without key is a clear error", async () => {
    const c = new StdioClient(script("maps.js"), dir, env());
    try {
      await c.init();
      expect(await c.tools()).toEqual(expect.arrayContaining(["reverse_geocode", "geocode", "lookup_ward", "list_wards", "zone_for_ward", "map_link"]));
      expect((await c.call("lookup_ward", { lat: 12.97, lng: 77.59 })).json).toEqual({ ward: null, zone: null, resolved: false });
      expect((await c.call("reverse_geocode", { lat: 12.97, lng: 77.59 })).json).toEqual({ address: null });
      const g = await c.call("geocode", { query: "MG Road Bengaluru" });
      expect(g.isError).toBe(true);
      expect(g.text).toMatch(/GOOGLE_MAPS_API_KEY/);
      expect((await c.call("map_link", { lat: 12.97, lng: 77.59 })).json.url).toContain("12.97,77.59");
      const bad = await c.request("tools/call", { name: "lookup_ward", arguments: { lat: 200, lng: 0 } });
      expect(bad.error || bad.result?.isError).toBeTruthy();
    } finally {
      c.close();
    }
  }, 30000);

  it("complaints: draft -> status -> confirm -> status, with errors for bad IDs", async () => {
    const c = new StdioClient(script("complaints.js"), dir, env());
    try {
      await c.init();
      expect(await c.tools()).toEqual(expect.arrayContaining(["create_draft_complaint", "confirm_and_send_complaint", "get_complaint_status", "get_complaint", "extract_photo_gps"]));
      const draft = await c.call("create_draft_complaint", { images: ["uploads/pothole.jpg"], lat: 12.95, lng: 77.55, reporter_contact: "919900000000" });
      expect(draft.isError).toBe(false);
      expect(draft.json).toMatchObject({ status: "drafted", ward_resolved: false, needs_human_review: true });
      const id = draft.json.tracking_id as string;
      expect(id).toMatch(/^BBMP-[0-9A-HJKMNP-TV-Z]{10}$/);

      const before = await c.call("get_complaint_status", { tracking_id: id });
      expect(before.json).toMatchObject({ status: "drafted", escalation: { configured: false } });

      const sent = await c.call("confirm_and_send_complaint", { tracking_id: id, ward: "Ward Z" });
      expect(sent.isError).toBe(false);
      expect(sent.json).toMatchObject({ status: "submitted", ward: "Ward Z", email_transport: "outbox" });
      expect((await c.call("get_complaint_status", { tracking_id: id })).json.status).toBe("submitted");

      const again = await c.call("confirm_and_send_complaint", { tracking_id: id });
      expect(again.isError).toBe(true);
      expect(again.text).toMatch(/already been submitted/);

      expect((await c.call("get_complaint", { tracking_id: "BBMP-0000000000" })).isError).toBe(true);
      const malformed = await c.request("tools/call", { name: "get_complaint_status", arguments: { tracking_id: "../../x" } });
      expect(malformed.error || malformed.result?.isError).toBeTruthy();
      expect((await c.call("create_draft_complaint", { images: ["secret.txt"], lat: 12, lng: 77 })).isError).toBe(true);
    } finally {
      c.close();
    }
  }, 60000);

  it("whatsapp: starts without credentials, explains why the webhook is off, and refuses to send", async () => {
    const c = new StdioClient(script("whatsapp.js"), dir, env());
    try {
      await c.init();
      expect(await c.tools()).toEqual(expect.arrayContaining(["get_incoming_messages", "send_message", "send_location"]));
      expect(c.stderr).toMatch(/webhook NOT started/);
      expect((await c.call("get_incoming_messages", {})).json).toEqual({ messages: [] });
      const send = await c.call("send_message", { to: "919900000000", text: "hi" });
      expect(send.isError).toBe(true);
      expect(send.text).toMatch(/WHATSAPP_ACCESS_TOKEN/);
    } finally {
      c.close();
    }
  }, 30000);
});
