import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { loadConfig, defaultRoot, type Config } from "../src/core/config.js";

export interface TestEnv {
  config: Config;
  dir: string;
  cleanup: () => Promise<void>;
}

/** Isolated project root in a temp dir: copies schema + config, uses mock vision, template text, outbox email. */
export async function makeTestEnv(extraEnv: Record<string, string> = {}): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bbmp-test-"));
  const real = defaultRoot();
  await cp(path.join(real, "schema"), path.join(dir, "schema"), { recursive: true });
  await cp(path.join(real, "config"), path.join(dir, "config"), { recursive: true });
  await mkdir(path.join(dir, "data"), { recursive: true });
  const config = loadConfig(
    {
      VISION_PROVIDER: "mock",
      TEXT_PROVIDER: "template",
      EMAIL_TRANSPORT: "outbox",
      OFFICER_USERNAME: "officer",
      OFFICER_PASSWORD: "correct horse battery",
      SESSION_SECRET: "x".repeat(40),
      COOKIE_SECURE: "false",
      ...extraEnv,
    },
    dir,
  );
  return { config, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

/** A small valid JPEG with a visible pattern so decoding is real. */
export async function sampleJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .jpeg()
    .toBuffer();
}

/** JPEG carrying EXIF GPS and an author tag, to prove stripping. */
export async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .withExif({
      IFD0: { Artist: "Secret Reporter" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 58/1 12/1", GPSLongitudeRef: "E", GPSLongitude: "77/1 35/1 24/1" },
    })
    .jpeg()
    .toBuffer();
}

/** Two square wards around Bengaluru for lookup tests. */
export const WARDS_GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { ward_name: "Ward A", zone: "Zone East" },
      geometry: { type: "Polygon", coordinates: [[[77.5, 12.9], [77.6, 12.9], [77.6, 13.0], [77.5, 13.0], [77.5, 12.9]]] },
    },
    {
      type: "Feature",
      properties: { ward_name: "Ward B", zone: "Zone West" },
      geometry: {
        type: "Polygon",
        // Outer square with a hole in the middle.
        coordinates: [
          [[77.6, 12.9], [77.8, 12.9], [77.8, 13.1], [77.6, 13.1], [77.6, 12.9]],
          [[77.68, 12.98], [77.72, 12.98], [77.72, 13.02], [77.68, 13.02], [77.68, 12.98]],
        ],
      },
    },
  ],
};
