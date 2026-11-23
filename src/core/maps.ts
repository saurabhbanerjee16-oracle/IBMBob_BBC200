import type { Config } from "./config.js";
import { AppError } from "./errors.js";

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

export interface GeocodeResult {
  lat: number;
  lng: number;
  address: string;
}

interface GoogleResponse {
  status: string;
  error_message?: string;
  results?: { formatted_address: string; geometry: { location: { lat: number; lng: number } } }[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function callGeocode(config: Config, params: Record<string, string>, fetchFn: FetchLike): Promise<GoogleResponse> {
  const url = new URL(GEOCODE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", config.googleMapsServerKey as string);
  let res: Response;
  try {
    res = await fetchFn(url.toString(), { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new AppError("upstream", "Google Maps geocoding request failed.");
  }
  if (!res.ok) throw new AppError("upstream", `Google Maps geocoding returned HTTP ${res.status}.`);
  const body = (await res.json()) as GoogleResponse;
  if (body.status !== "OK" && body.status !== "ZERO_RESULTS") {
    // The message is logged server-side only; it may mention key restrictions.
    console.error("Google geocode error:", body.status, body.error_message ?? "");
    throw new AppError("upstream", `Google Maps geocoding failed (${body.status}).`);
  }
  return body;
}

/** Address for a coordinate, or null when no key is configured or nothing is found. */
export async function reverseGeocode(
  config: Config,
  lat: number,
  lng: number,
  fetchFn: FetchLike = fetch,
): Promise<string | null> {
  if (!config.googleMapsServerKey) return null;
  const body = await callGeocode(config, { latlng: `${lat},${lng}` }, fetchFn);
  return body.results?.[0]?.formatted_address ?? null;
}

/** Forward geocode, biased to Bengaluru. Throws `config` error without a key (caller cannot proceed without it). */
export async function geocode(config: Config, query: string, fetchFn: FetchLike = fetch): Promise<GeocodeResult | null> {
  if (!config.googleMapsServerKey) {
    throw new AppError("config", "GOOGLE_MAPS_API_KEY is not set, so addresses cannot be geocoded.");
  }
  const body = await callGeocode(config, { address: query, components: "administrative_area:Karnataka|country:IN" }, fetchFn);
  const hit = body.results?.[0];
  if (!hit) return null;
  return { lat: hit.geometry.location.lat, lng: hit.geometry.location.lng, address: hit.formatted_address };
}

/** Plain Google Maps link; needs no API key. */
export function mapLink(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
