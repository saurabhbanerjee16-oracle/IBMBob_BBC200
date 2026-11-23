import { readFile, stat } from "node:fs/promises";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";

type Position = [number, number];
type Ring = Position[];
interface WardShape {
  name: string;
  zone: string | null;
  /** Each polygon is [outerRing, ...holes]. */
  polygons: Ring[][];
}

export interface WardMatch {
  ward: string;
  zone: string | null;
}

// Common property names across ward datasets; WARD_NAME_PROPERTY / WARD_ZONE_PROPERTY override these.
const NAME_KEYS = ["ward_name", "WARD_NAME", "Ward_Name", "name", "NAME", "KGISWardName"];
const ZONE_KEYS = ["zone", "ZONE", "zone_name", "ZONE_NAME", "Zone"];

let cache: { key: string; shapes: WardShape[] } | null = null;

function pick(props: Record<string, unknown>, preferred: string | null, fallbacks: string[]): string | null {
  const keys = preferred ? [preferred] : fallbacks;
  for (const k of keys) {
    const v = props[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

function toRing(raw: unknown): Ring {
  if (!Array.isArray(raw)) throw new AppError("config", "Ward GeoJSON has a malformed ring.");
  return raw.map((p) => {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number") {
      throw new AppError("config", "Ward GeoJSON has a malformed coordinate.");
    }
    return [p[0], p[1]] as Position;
  });
}

function parseShapes(config: Config, geojson: unknown): WardShape[] {
  const fc = geojson as { type?: string; features?: unknown[] };
  if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    throw new AppError("config", "Ward GeoJSON must be a FeatureCollection.");
  }
  const shapes: WardShape[] = [];
  for (const f of fc.features) {
    const feature = f as {
      properties?: Record<string, unknown>;
      geometry?: { type?: string; coordinates?: unknown };
    };
    const geom = feature.geometry;
    if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) continue;
    const props = feature.properties ?? {};
    const name = pick(props, config.wardNameProperty, NAME_KEYS);
    if (!name) {
      throw new AppError("config", "A ward feature has no name. Set WARD_NAME_PROPERTY to the right property.");
    }
    const polys = (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates) as unknown[];
    shapes.push({
      name,
      zone: pick(props, config.wardZoneProperty, ZONE_KEYS),
      polygons: polys.map((p) => (p as unknown[]).map(toRing)),
    });
  }
  return shapes;
}

async function loadShapes(config: Config): Promise<WardShape[] | null> {
  let mtime: number;
  try {
    mtime = (await stat(config.wardsPath)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const key = `${config.wardsPath}:${mtime}:${config.wardNameProperty}:${config.wardZoneProperty}`;
  if (cache?.key === key) return cache.shapes;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(config.wardsPath, "utf8"));
  } catch {
    throw new AppError("config", "Ward GeoJSON file is not valid JSON.");
  }
  const shapes = parseShapes(config, raw);
  cache = { key, shapes };
  return shapes;
}

/** Ray casting. Points exactly on an edge may fall either way, which is acceptable for ward lookup. */
export function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as Position;
    const [xj, yj] = ring[j] as Position;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lng: number, lat: number, rings: Ring[]): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !pointInRing(lng, lat, outer)) return false;
  return !holes.some((h) => pointInRing(lng, lat, h));
}

/** Returns null when the GeoJSON is absent or no ward contains the point (caller asks the user). */
export async function lookupWard(config: Config, lat: number, lng: number): Promise<WardMatch | null> {
  const shapes = await loadShapes(config);
  if (!shapes) return null;
  for (const s of shapes) {
    if (s.polygons.some((p) => inPolygon(lng, lat, p))) return { ward: s.name, zone: s.zone };
  }
  return null;
}

/** All ward names from the GeoJSON, for the ward selector. Empty when the file is absent. */
export async function listWards(config: Config): Promise<WardMatch[]> {
  const shapes = await loadShapes(config);
  if (!shapes) return [];
  return shapes.map((s) => ({ ward: s.name, zone: s.zone })).sort((a, b) => a.ward.localeCompare(b.ward, undefined, { numeric: true }));
}

/** Test hook. */
export function clearWardCache(): void {
  cache = null;
}
