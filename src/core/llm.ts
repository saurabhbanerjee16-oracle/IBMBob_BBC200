import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import type { FetchLike } from "./maps.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
}

/** Minimal OpenAI-compatible chat call that returns the parsed JSON object from the reply. */
export async function chatJson(
  config: Config,
  model: string | null,
  messages: ChatMessage[],
  fetchFn: FetchLike = fetch,
): Promise<unknown> {
  const { apiKey, baseUrl } = config.vision;
  if (!apiKey || !model) {
    throw new AppError("config", "VISION_API_KEY and a model name (VISION_MODEL / TEXT_MODEL) are required for this provider.");
  }
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, response_format: { type: "json_object" }, temperature: 0.2 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new AppError("upstream", "AI provider request failed.");
  }
  if (!res.ok) throw new AppError("upstream", `AI provider returned HTTP ${res.status}.`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new AppError("upstream", "AI provider returned an empty reply.");
  try {
    return JSON.parse(content);
  } catch {
    throw new AppError("upstream", "AI provider reply was not valid JSON.");
  }
}
