#!/usr/bin/env node
import express from "express";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { loadConfig, loadDotEnv, type Config } from "../core/config.js";
import { safeEqual } from "../web/session.js";
import { WhatsAppClient, extractMessages, toInbound, verifySignature, type InboundMessage } from "../whatsapp/client.js";
import { safe } from "./util.js";

const MAX_QUEUE = 200;

/** Inbound webhook. Without WHATSAPP_APP_SECRET every POST is refused (secure by default). */
export function createWebhookApp(config: Config, client: WhatsAppClient, queue: InboundMessage[]): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/webhook", (req, res) => {
    const { verifyToken } = config.whatsapp;
    const token = typeof req.query["hub.verify_token"] === "string" ? req.query["hub.verify_token"] : "";
    if (verifyToken && req.query["hub.mode"] === "subscribe" && safeEqual(token, verifyToken)) {
      res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    } else res.sendStatus(403);
  });

  app.post("/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const { appSecret } = config.whatsapp;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!appSecret || !verifySignature(appSecret, raw, req.header("x-hub-signature-256"))) {
      res.sendStatus(403);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.sendStatus(400);
      return;
    }
    res.sendStatus(200); // acknowledge fast; Meta retries on slow replies
    for (const msg of extractMessages(payload)) {
      void (async () => {
        try {
          const media = msg.type === "image" && msg.image?.id ? [await client.downloadMedia(msg.image.id)] : [];
          const inbound = toInbound(msg, media);
          if (!inbound) return;
          if (queue.some((m) => m.id === inbound.id)) return; // Meta may redeliver
          queue.push(inbound);
          while (queue.length > MAX_QUEUE) queue.shift();
        } catch (err) {
          console.error("Failed to process inbound WhatsApp message:", err instanceof Error ? err.message : err);
        }
      })();
    }
  });
  return app;
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const client = new WhatsAppClient(config);
  const queue: InboundMessage[] = [];

  if (config.whatsapp.verifyToken && config.whatsapp.appSecret) {
    createWebhookApp(config, client, queue).listen(config.whatsapp.webhookPort, () =>
      console.error(`WhatsApp webhook listening on :${config.whatsapp.webhookPort}/webhook (must be exposed over public HTTPS)`),
    );
  } else {
    console.error("WhatsApp webhook NOT started: set WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET. Send tools still work if the access token is set.");
  }

  const server = new McpServer({ name: "bbmp-whatsapp", version: "0.1.0" });

  server.registerTool(
    "get_incoming_messages",
    {
      description:
        "Messages received on the WhatsApp number (text, image, location pin). Image messages include `media_paths` usable as `images` in create_draft_complaint. " +
        "Pass `since` (ISO time of the newest message already handled) to get only newer ones.",
      inputSchema: z.object({ since: z.string().optional() }),
    },
    safe(async ({ since }) => {
      const cutoff = since ? Date.parse(since) : null;
      if (cutoff !== null && Number.isNaN(cutoff)) throw new Error("`since` must be an ISO date-time.");
      return { messages: queue.filter((m) => cutoff === null || Date.parse(m.received_at) > cutoff) };
    }),
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a WhatsApp text message. Free-form text only works inside WhatsApp's 24-hour customer-service window after the user last wrote.",
      inputSchema: z.object({ to: z.string().regex(/^\d{8,15}$/, "digits only, with country code"), text: z.string().min(1).max(4000) }),
    },
    safe(async ({ to, text }) => ({ ok: true, ...(await client.sendText(to, text)) })),
  );

  server.registerTool(
    "send_location",
    {
      description: "Send a WhatsApp location pin.",
      inputSchema: z.object({
        to: z.string().regex(/^\d{8,15}$/, "digits only, with country code"),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        label: z.string().max(100).optional(),
      }),
    },
    safe(async ({ to, lat, lng, label }) => ({ ok: true, ...(await client.sendLocation(to, lat, lng, label)) })),
  );

  await server.connect(new StdioServerTransport());
  console.error("bbmp-whatsapp running on stdio");
}

// Only start when run directly, so tests can import createWebhookApp.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
