#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { loadConfig, loadDotEnv } from "../core/config.js";
import { zoneForWard } from "../core/contacts.js";
import { geocode, mapLink, reverseGeocode } from "../core/maps.js";
import { wardChoices } from "../core/pipeline.js";
import { lookupWard } from "../core/wards.js";
import { safe } from "./util.js";

loadDotEnv();
const config = loadConfig();
const server = new McpServer({ name: "bbmp-maps", version: "0.1.0" });

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

server.registerTool(
  "reverse_geocode",
  {
    description: "Address for a latitude/longitude via Google Maps. Returns { address: null } when no API key is configured or nothing is found.",
    inputSchema: z.object({ lat, lng }),
  },
  safe(async (a) => ({ address: await reverseGeocode(config, a.lat, a.lng) })),
);

server.registerTool(
  "geocode",
  {
    description: "Coordinates for a typed address (biased to Karnataka, India). Needs GOOGLE_MAPS_API_KEY. Returns null when nothing is found.",
    inputSchema: z.object({ query: z.string().min(3).max(300) }),
  },
  safe(async ({ query }) => geocode(config, query)),
);

server.registerTool(
  "lookup_ward",
  {
    description:
      "BBMP ward and zone containing a point, from data/bbmp-wards.geojson. Returns { ward: null, zone: null, resolved: false } " +
      "when the file is missing or no ward matches: in that case ask the user to choose or confirm the ward (see list_wards).",
    inputSchema: z.object({ lat, lng }),
  },
  safe(async (a) => {
    const match = await lookupWard(config, a.lat, a.lng);
    return match ? { ...match, resolved: true } : { ward: null, zone: null, resolved: false };
  }),
);

server.registerTool(
  "list_wards",
  {
    description: "Known ward names (and zones) for presenting a choice to the user. Empty when no ward data is configured.",
    inputSchema: z.object({}),
  },
  safe(async () => ({ wards: await wardChoices(config) })),
);

server.registerTool(
  "zone_for_ward",
  {
    description: "Zone configured for a ward in config/bbmp-contacts.json, or null.",
    inputSchema: z.object({ ward: z.string().min(1).max(200) }),
  },
  safe(async ({ ward }) => ({ zone: await zoneForWard(config, ward) })),
);

server.registerTool(
  "map_link",
  {
    description: "Google Maps link for a coordinate, for use in replies. Needs no API key.",
    inputSchema: z.object({ lat, lng }),
  },
  safe(async (a) => ({ url: mapLink(a.lat, a.lng) })),
);

await server.connect(new StdioServerTransport());
console.error("bbmp-maps running on stdio");
