import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../core/config.js";
import { AppError } from "../core/errors.js";
import type { FetchLike } from "../core/maps.js";
import { MAX_UPLOAD_BYTES } from "../core/photos.js";

/*
 * WhatsApp Business Cloud API client. Written from the public Graph API shapes (webhook payload, media fetch,
 * /messages send). It has NOT been run against a real WhatsApp business account: verify with a test number.
 */

export interface InboundMessage {
  id: string;
  from: string;
  received_at: string;
  type: "text" | "image" | "location" | "other";
  text: string | null;
  /** Files saved under uploads/whatsapp/ (relative to project root). */
  media_paths: string[];
  location: { lat: number; lng: number; name: string | null; address: string | null } | null;
}

/** Verify `X-Hub-Signature-256: sha256=<hex>` against the raw request body. */
export function verifySignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice("sha256=".length), "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface RawMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
}

/** Flatten a webhook POST body into raw messages. Unknown shapes yield an empty list (never throws). */
export function extractMessages(payload: unknown): RawMessage[] {
  const out: RawMessage[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } })?.value?.messages;
      if (Array.isArray(messages)) out.push(...(messages as RawMessage[]));
    }
  }
  return out;
}

export function toInbound(raw: RawMessage, mediaPaths: string[]): InboundMessage | null {
  if (!raw.id || !raw.from) return null;
  const ts = Number(raw.timestamp);
  const received_at = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString();
  const base = { id: raw.id, from: raw.from, received_at, media_paths: mediaPaths };
  if (raw.type === "text") return { ...base, type: "text", text: raw.text?.body ?? null, location: null };
  if (raw.type === "image") return { ...base, type: "image", text: raw.image?.caption ?? null, location: null };
  if (raw.type === "location" && typeof raw.location?.latitude === "number" && typeof raw.location.longitude === "number") {
    return {
      ...base,
      type: "location",
      text: null,
      location: { lat: raw.location.latitude, lng: raw.location.longitude, name: raw.location.name ?? null, address: raw.location.address ?? null },
    };
  }
  return { ...base, type: "other", text: null, location: null };
}

export class WhatsAppClient {
  constructor(
    private readonly config: Config,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  private creds(): { token: string; phoneId: string } {
    const { accessToken, phoneNumberId } = this.config.whatsapp;
    if (!accessToken || !phoneNumberId) {
      throw new AppError("config", "WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be set to use WhatsApp.");
    }
    return { token: accessToken, phoneId: phoneNumberId };
  }

  private graph(pathPart: string): string {
    return `https://graph.facebook.com/${this.config.whatsapp.graphVersion}/${pathPart}`;
  }

  /** Download media by ID into uploads/whatsapp/ under a random name. Returns the project-relative path. */
  async downloadMedia(mediaId: string): Promise<string> {
    const { token } = this.creds();
    const headers = { authorization: `Bearer ${token}` };
    const metaRes = await this.fetchFn(this.graph(encodeURIComponent(mediaId)), { headers, signal: AbortSignal.timeout(15_000) });
    if (!metaRes.ok) throw new AppError("upstream", `WhatsApp media lookup failed (HTTP ${metaRes.status}).`);
    const meta = (await metaRes.json()) as { url?: string };
    if (!meta.url) throw new AppError("upstream", "WhatsApp media lookup returned no URL.");
    const fileRes = await this.fetchFn(meta.url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!fileRes.ok) throw new AppError("upstream", `WhatsApp media download failed (HTTP ${fileRes.status}).`);
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new AppError("validation", "Downloaded media is empty or too large.");
    }
    await mkdir(this.config.inboxDir, { recursive: true });
    const file = path.join(this.config.inboxDir, `${randomBytes(16).toString("hex")}.bin`);
    await writeFile(file, bytes);
    return path.relative(this.config.root, file).split(path.sep).join("/");
  }

  private async post(body: Record<string, unknown>): Promise<{ message_id: string | null }> {
    const { token, phoneId } = this.creds();
    const res = await this.fetchFn(this.graph(`${encodeURIComponent(phoneId)}/messages`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error("WhatsApp send failed:", res.status, await res.text().catch(() => ""));
      throw new AppError("upstream", `WhatsApp send failed (HTTP ${res.status}).`);
    }
    const json = (await res.json()) as { messages?: { id?: string }[] };
    return { message_id: json.messages?.[0]?.id ?? null };
  }

  sendText(to: string, text: string): Promise<{ message_id: string | null }> {
    return this.post({ to, type: "text", text: { body: text, preview_url: false } });
  }

  sendLocation(to: string, lat: number, lng: number, label?: string): Promise<{ message_id: string | null }> {
    return this.post({ to, type: "location", location: { latitude: lat, longitude: lng, ...(label ? { name: label } : {}) } });
  }
}
