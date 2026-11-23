#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { loadConfig, loadDotEnv } from "../core/config.js";
import { AppError } from "../core/errors.js";
import { isTrackingId } from "../core/ids.js";
import { confirmComplaint, createDraft, getStatus } from "../core/pipeline.js";
import { readExifGps, storePhoto } from "../core/photos.js";
import { getComplaint } from "../core/store.js";
import { resolveImageRef, safe } from "./util.js";

loadDotEnv();
const config = loadConfig();
const server = new McpServer({ name: "bbmp-complaints", version: "0.1.0" });

const trackingId = z.string().refine(isTrackingId, "Tracking IDs look like BBMP-XXXXXXXXXX");

server.registerTool(
  "create_draft_complaint",
  {
    description:
      "Run the full drafting pipeline: classify the photo(s), geocode, resolve the ward, write English + Kannada text, and save a `drafted` complaint. " +
      "Nothing is emailed. Fails with a user-facing message when the photo is not a road issue or is too unclear (ask for a better photo). " +
      "If `ward_resolved` is false in the result, ask the user to choose a ward, then pass it to confirm_and_send_complaint. " +
      "Kannada text is machine-generated: needs_human_review is always true. Show the English text and wait for the user's confirmation before sending.",
    inputSchema: z.object({
      images: z.array(z.string()).min(1).max(5).describe("Photo files: stored photo names or files inside uploads/"),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      ward: z.string().max(200).optional().describe("Ward chosen or confirmed by the user; overrides lookup"),
      zone: z.string().max(200).optional(),
      reporter_contact: z.string().max(100).optional().describe("WhatsApp number or email of the reporter; never made public"),
      reporter_name: z.string().max(100).optional(),
      channel: z.enum(["whatsapp", "web"]).default("whatsapp"),
    }),
  },
  safe(async (a) => {
    const stored: string[] = [];
    for (const ref of a.images) {
      const path = resolveImageRef(config, ref);
      stored.push((await storePhoto(config, await readFile(path))).name);
    }
    const r = await createDraft(config, {
      photos: stored,
      lat: a.lat,
      lng: a.lng,
      ward: a.ward,
      zone: a.zone,
      reporter: { channel: a.channel, contact: a.reporter_contact ?? null, name: a.reporter_name ?? null },
    });
    return {
      tracking_id: r.complaint.tracking_id,
      issue_type: r.complaint.issue_type,
      severity: r.complaint.severity,
      vision: { confidence: r.vision.confidence, description: r.vision.description, provider: r.vision.provider },
      location: r.complaint.location,
      ward_resolved: r.ward_resolved,
      ward_source: r.ward_source,
      text: r.complaint.text,
      needs_human_review: r.complaint.needs_human_review,
      escalation: r.complaint.escalation,
      status: r.complaint.status,
    };
  }),
);

server.registerTool(
  "confirm_and_send_complaint",
  {
    description:
      "Email a drafted complaint to the configured BBMP ward/zone address and mark it `submitted`. Call ONLY after the user has confirmed the draft. " +
      "Optional edits to the text or ward are applied first. If no recipient is configured the complaint stays `drafted` and an error explains why.",
    inputSchema: z.object({
      tracking_id: trackingId,
      text_en: z.string().max(4000).optional(),
      text_kn: z.string().max(4000).optional(),
      ward: z.string().max(200).optional(),
      zone: z.string().max(200).optional(),
    }),
  },
  safe(async (a) => {
    const r = await confirmComplaint(config, a.tracking_id, {
      text: { en: a.text_en, kn: a.text_kn },
      ward: a.ward,
      zone: a.zone,
    });
    return {
      tracking_id: r.complaint.tracking_id,
      status: r.complaint.status,
      issue_type: r.complaint.issue_type,
      severity: r.complaint.severity,
      ward: r.complaint.location.ward,
      zone: r.complaint.location.zone,
      emailed_to_source: r.email.recipient_source,
      email_transport: r.email.transport,
      escalation: r.complaint.escalation,
      escalation_report: r.escalation,
    };
  }),
);

server.registerTool(
  "get_complaint_status",
  {
    description:
      "Current status and escalation position for a tracking ID. Escalation days that are not configured are reported as 'not configured'. " +
      "Never claim BBMP has acted unless the user says so.",
    inputSchema: z.object({ tracking_id: trackingId }),
  },
  safe(async ({ tracking_id }) => getStatus(config, tracking_id)),
);

server.registerTool(
  "get_complaint",
  {
    description: "Full complaint record for a tracking ID (includes reporter contact: do not repeat it to other users).",
    inputSchema: z.object({ tracking_id: trackingId }),
  },
  safe(async ({ tracking_id }) => {
    const c = await getComplaint(config, tracking_id);
    if (!c) throw new AppError("not_found", "Complaint not found.");
    return c;
  }),
);

server.registerTool(
  "extract_photo_gps",
  {
    description: "Read GPS coordinates from a photo's EXIF data (for WhatsApp photos sent without a location pin). Returns { gps: null } when absent.",
    inputSchema: z.object({ image: z.string() }),
  },
  safe(async ({ image }) => ({ gps: await readExifGps(await readFile(resolveImageRef(config, image))) })),
);

await server.connect(new StdioServerTransport());
console.error("bbmp-complaints running on stdio");
