import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { chatJson } from "./llm.js";
import type { FetchLike } from "./maps.js";
import { ISSUE_TYPES, SEVERITIES, type IssueType, type Severity } from "./types.js";

export interface VisionResult {
  issue_type: IssueType;
  severity: Severity;
  confidence: number;
  description: string;
  provider: "mock" | "openai";
  /** True when the result is usable: a road issue with enough confidence. */
  acceptable: boolean;
  /** Reason shown to the user when not acceptable. */
  reject_reason: string | null;
}

// Severity rubric (size, depth, traffic risk) is still an open item in the plan; this is a proposed default.
export const VISION_PROMPT = `You examine a photo of a road in India for a municipal complaint.
Classify it and reply with ONLY a JSON object:
{"issue_type": "pothole" | "other_road_damage" | "not_a_road_issue",
 "severity": "Low" | "Medium" | "High",
 "confidence": number between 0 and 1,
 "description": one or two factual sentences about what is visible}
Rules:
- "pothole": a hole or cavity in the road surface. "other_road_damage": cracks, broken edges, sunken manholes, etc.
- "not_a_road_issue": the photo does not show a damaged road (or is unclear). Use severity "Low".
- Severity: Low = small and shallow, little traffic risk. Medium = roughly tyre-sized or clearly uncomfortable to drive over.
  High = large or deep, in a live traffic lane, or likely to cause a crash or vehicle damage.
- Describe only what is visible. Do not guess locations. Be honest about low confidence.`;

function finalize(partial: Omit<VisionResult, "acceptable" | "reject_reason">, minConfidence: number): VisionResult {
  let reject_reason: string | null = null;
  if (partial.issue_type === "not_a_road_issue") {
    reject_reason = "The photo does not appear to show a road problem. Please send a clearer photo of the damaged road.";
  } else if (partial.confidence < minConfidence) {
    reject_reason = "The photo is too unclear to classify confidently. Please send a closer, well-lit photo.";
  }
  return { ...partial, acceptable: reject_reason === null, reject_reason };
}

function parseVision(raw: unknown): { issue_type: IssueType; severity: Severity; confidence: number; description: string } {
  const o = raw as Record<string, unknown>;
  const issue_type = o?.issue_type;
  const severity = o?.severity;
  const confidence = o?.confidence;
  const description = o?.description;
  if (!ISSUE_TYPES.includes(issue_type as IssueType)) throw new AppError("upstream", "Vision reply had an invalid issue_type.");
  if (!SEVERITIES.includes(severity as Severity)) throw new AppError("upstream", "Vision reply had an invalid severity.");
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    throw new AppError("upstream", "Vision reply had an invalid confidence.");
  }
  return {
    issue_type: issue_type as IssueType,
    severity: severity as Severity,
    confidence,
    description: typeof description === "string" ? description.slice(0, 500) : "",
  };
}

/**
 * Classify a stored photo (JPEG bytes).
 * `mock` provider performs NO image analysis: it returns a fixed pothole/Medium result so the demo flow can run
 * offline. Its output is labelled as such in `description` and `provider`.
 */
export async function analyzeImage(
  config: Config,
  imagePath: string,
  fetchFn: FetchLike = fetch,
): Promise<VisionResult> {
  const { provider, minConfidence } = config.vision;
  if (provider === "mock") {
    return finalize(
      {
        issue_type: "pothole",
        severity: "Medium",
        confidence: 0.9,
        description: "DEMO MODE: no image analysis was performed; this is a placeholder classification.",
        provider: "mock",
      },
      minConfidence,
    );
  }
  const bytes = await readFile(imagePath);
  const dataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  const raw = await chatJson(
    config,
    config.vision.model,
    [
      { role: "system", content: VISION_PROMPT },
      { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] },
    ],
    fetchFn,
  );
  return finalize({ ...parseVision(raw), provider: "openai" }, minConfidence);
}

/** Merge results from several photos of one complaint: the most severe acceptable result wins. */
export function combineVision(results: VisionResult[]): VisionResult {
  if (results.length === 0) throw new AppError("validation", "At least one photo is required.");
  const good = results.filter((r) => r.acceptable);
  if (good.length === 0) return results.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
  const rank = (s: Severity): number => SEVERITIES.indexOf(s);
  return good.reduce((a, b) => (rank(b.severity) > rank(a.severity) ? b : a));
}
