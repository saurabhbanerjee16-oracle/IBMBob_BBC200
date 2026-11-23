import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";

interface ContactsFile {
  default?: { email?: string | null };
  zones?: Record<string, { email?: string | null }>;
  wards?: Record<string, { zone?: string | null; email?: string | null }>;
}

export interface Recipient {
  email: string;
  source: "ward" | "zone" | "default" | "demo";
}

/** Lookup order: ward -> zone -> default. Returns null when nothing is configured (never invents an address). */
export async function resolveRecipient(
  config: Config,
  ward: string | null,
  zone: string | null,
): Promise<Recipient | null> {
  const contacts = JSON.parse(await readFile(config.contactsPath, "utf8")) as ContactsFile;
  const wardEntry = ward ? contacts.wards?.[ward] : undefined;
  if (wardEntry?.email) return { email: wardEntry.email, source: "ward" };
  const zoneKey = zone ?? wardEntry?.zone ?? null;
  const zoneEntry = zoneKey ? contacts.zones?.[zoneKey] : undefined;
  if (zoneEntry?.email) return { email: zoneEntry.email, source: "zone" };
  if (contacts.default?.email) return { email: contacts.default.email, source: "default" };
  return null;
}

/** Zone for a ward as listed in contacts config, if any. */
export async function zoneForWard(config: Config, ward: string): Promise<string | null> {
  const contacts = JSON.parse(await readFile(config.contactsPath, "utf8")) as ContactsFile;
  return contacts.wards?.[ward]?.zone ?? null;
}

/** Ward and zone names known to config; used to populate the ward selector when no GeoJSON exists. */
export async function listConfiguredWards(config: Config): Promise<{ ward: string; zone: string | null }[]> {
  const contacts = JSON.parse(await readFile(config.contactsPath, "utf8")) as ContactsFile;
  return Object.entries(contacts.wards ?? {})
    .filter(([name]) => !name.startsWith("EXAMPLE_"))
    .map(([ward, v]) => ({ ward, zone: v.zone ?? null }));
}
