import path from "node:path";
import type { Config } from "../core/config.js";
import { AppError, errorMessage } from "../core/errors.js";
import { isPhotoName } from "../core/ids.js";
import { photoPath } from "../core/photos.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Recoverable failure: the agent sees the message and can correct itself. Never includes stack traces. */
export function fail(err: unknown): ToolResult {
  const message = err instanceof AppError ? err.message : errorMessage(err);
  if (!(err instanceof AppError)) console.error("MCP tool error:", err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap a handler so thrown errors become `isError` results instead of crashing the server. */
export function safe<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function uploadsDir(config: Config): string {
  return path.join(config.root, "uploads");
}

/**
 * Resolve an image reference from an agent to a readable local path.
 * Accepts a stored photo name, or a file inside `uploads/` (e.g. downloaded WhatsApp media).
 * Anything else is refused so a tool call cannot read arbitrary files.
 */
export function resolveImageRef(config: Config, ref: string): string {
  if (isPhotoName(ref)) return photoPath(config, ref);
  const base = uploadsDir(config);
  const full = path.resolve(config.root, ref);
  const rel = path.relative(base, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AppError("validation", "Image must be a stored photo name or a file inside the uploads/ folder.");
  }
  return full;
}
