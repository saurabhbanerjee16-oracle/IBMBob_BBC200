import { randomBytes } from "node:crypto";

// Crockford base32 (no I, L, O, U). 256 is divisible by 32, so `byte & 31` is unbiased.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TRACKING_ID_RE = /^BBMP-[0-9A-HJKMNP-TV-Z]{10}$/;
const PHOTO_NAME_RE = /^[0-9a-f]{32}\.jpg$/;

/** Random, unguessable tracking ID: 10 base32 characters = 50 bits of randomness. */
export function newTrackingId(): string {
  const bytes = randomBytes(10);
  let out = "BBMP-";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

export function isTrackingId(value: unknown): value is string {
  return typeof value === "string" && TRACKING_ID_RE.test(value);
}

/** Random photo file name that is not derived from any complaint or reporter data. */
export function newPhotoName(): string {
  return `${randomBytes(16).toString("hex")}.jpg`;
}

export function isPhotoName(value: unknown): value is string {
  return typeof value === "string" && PHOTO_NAME_RE.test(value);
}
