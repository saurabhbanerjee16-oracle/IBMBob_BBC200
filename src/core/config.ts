import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  root: string;
  complaintsDir: string;
  photosDir: string;
  outboxDir: string;
  inboxDir: string;
  schemaPath: string;
  escalationPath: string;
  contactsPath: string;
  wardsPath: string;
  wardNameProperty: string | null;
  wardZoneProperty: string | null;
  googleMapsServerKey: string | null;
  googleMapsBrowserKey: string | null;
  vision: {
    provider: "mock" | "openai";
    apiKey: string | null;
    model: string | null;
    baseUrl: string;
    minConfidence: number;
  };
  text: { provider: "template" | "openai"; model: string | null };
  email: {
    transport: "outbox" | "smtp";
    demoRecipient: string;
    smtp: { host: string | null; port: number; user: string | null; password: string | null; from: string | null };
  };
  whatsapp: {
    accessToken: string | null;
    phoneNumberId: string | null;
    verifyToken: string | null;
    appSecret: string | null;
    graphVersion: string;
    webhookPort: number;
  };
  web: {
    port: number;
    officerUsername: string | null;
    officerPassword: string | null;
    sessionSecret: string | null;
    cookieSecure: boolean;
    /** Number of reverse-proxy hops to trust for client IP (rate limiting). 0 = none. */
    trustProxy: number;
  };
}

/** Project root. Works from both `src/core` and the compiled `dist/core`. */
export function defaultRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Load `.env` from the project root into process.env (existing variables win). */
export function loadDotEnv(root: string = defaultRoot()): void {
  const file = path.join(root, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

function str(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], fallback: T): T {
  const v = str(env, key);
  if (v === null) return fallback;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")} (got "${v}")`);
  }
  return v as T;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = str(env, key);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number (got "${v}")`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root: string = defaultRoot()): Config {
  const complaintsDir = path.join(root, "complaints");
  return {
    root,
    complaintsDir,
    photosDir: path.join(complaintsDir, "photos"),
    outboxDir: path.join(root, "outbox"),
    inboxDir: path.join(root, "uploads", "whatsapp"),
    schemaPath: path.join(root, "schema", "complaint.schema.json"),
    escalationPath: path.join(root, "config", "escalation.json"),
    contactsPath: path.join(root, "config", "bbmp-contacts.json"),
    wardsPath: path.resolve(root, str(env, "WARDS_GEOJSON") ?? "data/bbmp-wards.geojson"),
    wardNameProperty: str(env, "WARD_NAME_PROPERTY"),
    wardZoneProperty: str(env, "WARD_ZONE_PROPERTY"),
    googleMapsServerKey: str(env, "GOOGLE_MAPS_API_KEY"),
    googleMapsBrowserKey: str(env, "GOOGLE_MAPS_BROWSER_KEY"),
    vision: {
      provider: oneOf(env, "VISION_PROVIDER", ["mock", "openai"], "mock"),
      apiKey: str(env, "VISION_API_KEY"),
      model: str(env, "VISION_MODEL"),
      baseUrl: (str(env, "VISION_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      minConfidence: num(env, "VISION_MIN_CONFIDENCE", 0.5),
    },
    text: {
      provider: oneOf(env, "TEXT_PROVIDER", ["template", "openai"], "template"),
      model: str(env, "TEXT_MODEL") ?? str(env, "VISION_MODEL"),
    },
    email: {
      transport: oneOf(env, "EMAIL_TRANSPORT", ["outbox", "smtp"], "outbox"),
      demoRecipient: str(env, "DEMO_RECIPIENT") ?? "outbox@bbmp-demo.invalid",
      smtp: {
        host: str(env, "SMTP_HOST"),
        port: num(env, "SMTP_PORT", 587),
        user: str(env, "SMTP_USER"),
        password: str(env, "SMTP_PASSWORD"),
        from: str(env, "SMTP_FROM"),
      },
    },
    whatsapp: {
      accessToken: str(env, "WHATSAPP_ACCESS_TOKEN"),
      phoneNumberId: str(env, "WHATSAPP_PHONE_NUMBER_ID"),
      verifyToken: str(env, "WHATSAPP_VERIFY_TOKEN"),
      appSecret: str(env, "WHATSAPP_APP_SECRET"),
      graphVersion: str(env, "WHATSAPP_GRAPH_VERSION") ?? "v21.0",
      webhookPort: num(env, "WHATSAPP_WEBHOOK_PORT", 8788),
    },
    web: {
      port: num(env, "PORT", 8787),
      officerUsername: str(env, "OFFICER_USERNAME"),
      officerPassword: str(env, "OFFICER_PASSWORD"),
      sessionSecret: str(env, "SESSION_SECRET"),
      cookieSecure: str(env, "COOKIE_SECURE") !== "false",
      trustProxy: num(env, "TRUST_PROXY", 0),
    },
  };
}
