import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { photoPath } from "./photos.js";
import { resolveRecipient, type Recipient } from "./contacts.js";
import type { Complaint } from "./types.js";

export interface EmailResult {
  recipient: string;
  recipient_source: Recipient["source"];
  transport: "outbox" | "smtp";
  /** Outbox mode: path of the written .eml file. */
  outbox_file: string | null;
}

function buildMessage(config: Config, complaint: Complaint, to: string) {
  const loc = complaint.location;
  const subject = `[${complaint.tracking_id}] ${complaint.severity} severity ${complaint.issue_type.replace(/_/g, " ")}${loc.ward ? ` - ${loc.ward}` : ""}`;
  const text = [
    complaint.text.en,
    "",
    "-----",
    `Tracking ID: ${complaint.tracking_id}`,
    `Location: ${loc.lat}, ${loc.lng} (https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng})`,
    "",
    complaint.text.kn,
    "",
    "Note: the Kannada text is machine-generated and has not been reviewed by a person.",
  ].join("\n");
  return {
    from: config.email.smtp.from ?? "bbmp-complaints@bbmp-demo.invalid",
    to,
    subject,
    text,
    attachments: [
      {
        filename: `${complaint.tracking_id}.json`,
        content: JSON.stringify(complaint, null, 2),
        contentType: "application/json",
      },
      ...complaint.photos.map((name) => ({ filename: name, path: photoPath(config, name) })),
    ],
  };
}

/**
 * Send (or, in demo `outbox` mode, write to disk) the complaint email.
 * Throws if no recipient is configured and the transport is smtp, so the caller keeps status `drafted`.
 */
export async function sendComplaintEmail(config: Config, complaint: Complaint): Promise<EmailResult> {
  const { transport } = config.email;
  let recipient = await resolveRecipient(config, complaint.location.ward, complaint.location.zone);
  if (!recipient) {
    if (transport === "outbox") recipient = { email: config.email.demoRecipient, source: "demo" };
    else throw new AppError("config", "No BBMP recipient email is configured for this ward or zone, so the complaint was not sent.");
  }
  const message = buildMessage(config, complaint, recipient.email);

  if (transport === "outbox") {
    const mailer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    const info = await mailer.sendMail(message);
    await mkdir(config.outboxDir, { recursive: true });
    const file = path.join(config.outboxDir, `${complaint.tracking_id}.eml`);
    await writeFile(file, info.message as Buffer);
    return { recipient: recipient.email, recipient_source: recipient.source, transport, outbox_file: file };
  }

  const { host, port, user, password } = config.email.smtp;
  if (!host || !config.email.smtp.from) throw new AppError("config", "SMTP_HOST and SMTP_FROM must be set when EMAIL_TRANSPORT=smtp.");
  const mailer = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && password ? { user, pass: password } : undefined,
  });
  try {
    await mailer.sendMail(message);
  } catch (err) {
    console.error("SMTP send failed:", err instanceof Error ? err.message : err);
    throw new AppError("upstream", "The email could not be sent.");
  }
  return { recipient: recipient.email, recipient_source: recipient.source, transport, outbox_file: null };
}
