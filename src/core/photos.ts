import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import exifr from "exifr";
import sharp from "sharp";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { isPhotoName, newPhotoName } from "./ids.js";
import { atomicWriteFile } from "./store.js";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_PHOTOS = 5;
const MAX_EDGE_PX = 2000;

export interface StoredPhoto {
  /** Random file name, e.g. `<32 hex>.jpg`. */
  name: string;
  /** GPS from the original EXIF, read before it was stripped. Null when absent. */
  gps: { lat: number; lng: number } | null;
}

/** Read GPS from the original upload (before stripping). Returns null if unavailable. */
export async function readExifGps(bytes: Uint8Array): Promise<{ lat: number; lng: number } | null> {
  try {
    const gps = await exifr.gps(bytes);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      return { lat: gps.latitude, lng: gps.longitude };
    }
  } catch {
    // Unreadable EXIF is treated as no GPS.
  }
  return null;
}

/**
 * Validate that the bytes are a real image (by content, not by client-supplied type), strip all metadata,
 * normalise orientation, downscale, and store as JPEG under a random name. sharp drops EXIF/GPS unless
 * `withMetadata` is called, so the stored copy is safe to serve publicly.
 */
export async function storePhoto(config: Config, bytes: Uint8Array): Promise<StoredPhoto> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new AppError("validation", `Each photo must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  }
  const gps = await readExifGps(bytes);
  let out: Buffer;
  try {
    const meta = await sharp(bytes).metadata();
    if (!meta.format || !["jpeg", "png", "webp", "heif"].includes(meta.format)) {
      throw new AppError("validation", "Photos must be JPEG, PNG, WebP or HEIC images.");
    }
    out = await sharp(bytes)
      .rotate()
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("validation", "That file could not be read as an image.");
  }
  await mkdir(config.photosDir, { recursive: true });
  const name = newPhotoName();
  await atomicWriteFile(path.join(config.photosDir, name), out);
  return { name, gps };
}

/** Absolute path for a stored photo name; rejects anything that is not a generated name (no path traversal). */
export function photoPath(config: Config, name: string): string {
  if (!isPhotoName(name)) throw new AppError("validation", "Invalid photo name.");
  return path.join(config.photosDir, name);
}

export async function readPhoto(config: Config, name: string): Promise<Buffer> {
  try {
    return await readFile(photoPath(config, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("not_found", "Photo not found.");
    throw err;
  }
}
