#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { loadConfig, loadDotEnv } from "../core/config.js";
import { analyzeImage, combineVision } from "../core/vision.js";
import { resolveImageRef, safe } from "./util.js";

loadDotEnv();
const config = loadConfig();
const server = new McpServer({ name: "bbmp-vision", version: "0.1.0" });

server.registerTool(
  "analyze_image",
  {
    description:
      "Classify a road photo. Returns issue_type (pothole | other_road_damage | not_a_road_issue), severity (Low | Medium | High), " +
      "confidence 0-1, a description, and `acceptable` (false when the photo is not a road issue or confidence is too low; " +
      "then ask the user for a better photo using `reject_reason`). When provider is 'mock' no real analysis is done.",
    inputSchema: z.object({
      image: z.string().describe("Stored photo name, or a path to an image inside the uploads/ folder"),
    }),
  },
  safe(async ({ image }) => analyzeImage(config, resolveImageRef(config, image))),
);

server.registerTool(
  "analyze_images",
  {
    description: "Classify several photos of the same problem and return the most severe acceptable result.",
    inputSchema: z.object({ images: z.array(z.string()).min(1).max(5) }),
  },
  safe(async ({ images }) => {
    const results = [];
    for (const image of images) results.push(await analyzeImage(config, resolveImageRef(config, image)));
    return combineVision(results);
  }),
);

await server.connect(new StdioServerTransport());
console.error("bbmp-vision running on stdio");
