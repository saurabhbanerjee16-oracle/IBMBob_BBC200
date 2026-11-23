import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebhookApp } from "../src/mcp/whatsapp.js";
import { WhatsAppClient, extractMessages, toInbound, verifySignature, type InboundMessage } from "../src/whatsapp/client.js";
import { makeTestEnv, sampleJpeg, type TestEnv } from "./helpers.js";

const SECRET = "app-secret";
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

describe("whatsapp helpers", () => {
  it("verifies signatures and rejects tampering or missing headers", () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySignature(SECRET, body, sign('{"a":1}'))).toBe(true);
    expect(verifySignature(SECRET, body, sign('{"a":2}'))).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
    expect(verifySignature(SECRET, body, "sha256=zz")).toBe(false);
    expect(verifySignature(SECRET, body, "md5=abc")).toBe(false);
  });

  it("extracts and normalises text, image and location messages; ignores junk", () => {
    const payload = {
      entry: [{ changes: [{ value: { messages: [
        { id: "1", from: "919900000000", timestamp: "1700000000", type: "text", text: { body: "hi" } },
        { id: "2", from: "919900000000", type: "image", image: { id: "m1", caption: "pothole" } },
        { id: "3", from: "919900000000", type: "location", location: { latitude: 12.9, longitude: 77.5, name: "Spot" } },
        { id: "4", from: "919900000000", type: "sticker" },
        { from: "no-id" },
      ] } }] }],
    };
    const raw = extractMessages(payload);
    const msgs = raw.map((m) => toInbound(m, [])).filter((m): m is InboundMessage => m !== null);
    expect(msgs.map((m) => m.type)).toEqual(["text", "image", "location", "other"]);
    expect(msgs[0]?.received_at).toBe("2023-11-14T22:13:20.000Z");
    expect(msgs[2]?.location).toEqual({ lat: 12.9, lng: 77.5, name: "Spot", address: null });
    expect(extractMessages(null)).toEqual([]);
    expect(extractMessages({ entry: "x" })).toEqual([]);
  });
});

describe("whatsapp client (mocked Graph API)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeTestEnv({ WHATSAPP_ACCESS_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "123" });
  });
  afterEach(async () => env.cleanup());

  it("downloads media to uploads/whatsapp under a random name", async () => {
    const jpeg = await sampleJpeg();
    const calls: string[] = [];
    const client = new WhatsAppClient(env.config, async (url, init) => {
      calls.push(String(url));
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      if (String(url).includes("graph.facebook.com")) return new Response(JSON.stringify({ url: "https://cdn.example/file" }));
      return new Response(new Uint8Array(jpeg));
    });
    const rel = await client.downloadMedia("m1");
    expect(rel).toMatch(/^uploads\/whatsapp\/[0-9a-f]{32}\.bin$/);
    expect((await readFile(path.join(env.dir, rel))).equals(jpeg)).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("sends text and location with the right payload; surfaces API failures without leaking details", async () => {
    let sent: Record<string, unknown> = {};
    const client = new WhatsAppClient(env.config, async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }));
    });
    expect(await client.sendText("919900000000", "hello")).toEqual({ message_id: "wamid.1" });
    expect(sent).toMatchObject({ messaging_product: "whatsapp", to: "919900000000", type: "text", text: { body: "hello" } });
    await client.sendLocation("919900000000", 12.9, 77.5, "Pothole");
    expect(sent).toMatchObject({ type: "location", location: { latitude: 12.9, longitude: 77.5, name: "Pothole" } });

    const failing = new WhatsAppClient(env.config, async () => new Response("secret upstream detail", { status: 401 }));
    await expect(failing.sendText("919900000000", "x")).rejects.toThrow(/HTTP 401/);
    await expect(failing.sendText("919900000000", "x")).rejects.not.toThrow(/secret upstream detail/);
  });

  it("refuses to send without credentials", async () => {
    const bare = await makeTestEnv();
    try {
      await expect(new WhatsAppClient(bare.config).sendText("919900000000", "x")).rejects.toMatchObject({ code: "config" });
    } finally {
      await bare.cleanup();
    }
  });
});

describe("whatsapp webhook", () => {
  let env: TestEnv;
  let server: Server;
  let base: string;
  let queue: InboundMessage[];

  beforeEach(async () => {
    env = await makeTestEnv({ WHATSAPP_VERIFY_TOKEN: "verify-me", WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "123" });
    queue = [];
    const jpeg = await sampleJpeg();
    const client = new WhatsAppClient(env.config, async (url) =>
      String(url).includes("graph.facebook.com") ? new Response(JSON.stringify({ url: "https://cdn.example/f" })) : new Response(new Uint8Array(jpeg)),
    );
    server = createWebhookApp(env.config, client, queue).listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await env.cleanup();
  });

  it("answers the subscription handshake only with the right token", async () => {
    const good = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
    expect(good.status).toBe(200);
    expect(await good.text()).toBe("42");
    expect((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)).status).toBe(403);
    expect((await fetch(`${base}/webhook`)).status).toBe(403);
  });

  it("rejects unsigned and wrongly signed posts, accepts signed ones and queues them once", async () => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "w1", from: "919900000000", timestamp: "1700000000", type: "image", image: { id: "m1" } }] } }] }] });
    expect((await fetch(`${base}/webhook`, { method: "POST", body })).status).toBe(403);
    expect((await fetch(`${base}/webhook`, { method: "POST", body, headers: { "x-hub-signature-256": sign("other") } })).status).toBe(403);
    expect(queue).toHaveLength(0);

    const headers = { "x-hub-signature-256": sign(body), "content-type": "application/json" };
    expect((await fetch(`${base}/webhook`, { method: "POST", body, headers })).status).toBe(200);
    for (let i = 0; i < 50 && queue.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(queue).toHaveLength(1);
    expect(queue[0]?.media_paths[0]).toMatch(/^uploads\/whatsapp\/.+\.bin$/);

    await fetch(`${base}/webhook`, { method: "POST", body, headers }); // redelivery
    await new Promise((r) => setTimeout(r, 150));
    expect(queue).toHaveLength(1);
  });

  it("returns 400 for a signed but non-JSON body", async () => {
    const body = "not json";
    expect((await fetch(`${base}/webhook`, { method: "POST", body, headers: { "x-hub-signature-256": sign(body) } })).status).toBe(400);
  });

  it("refuses all posts when no app secret is configured", async () => {
    const open = await makeTestEnv({ WHATSAPP_VERIFY_TOKEN: "v" });
    const s = createWebhookApp(open.config, new WhatsAppClient(open.config), []).listen(0, "127.0.0.1");
    await new Promise<void>((r) => s.once("listening", r));
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/webhook`;
      expect((await fetch(url, { method: "POST", body: "{}", headers: { "x-hub-signature-256": sign("{}") } })).status).toBe(403);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
      await open.cleanup();
    }
  });
});
