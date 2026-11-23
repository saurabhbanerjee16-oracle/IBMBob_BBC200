import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { chatJson } from "./llm.js";
import type { FetchLike } from "./maps.js";
import type { IssueType, Severity } from "./types.js";

export interface DraftInput {
  issue_type: IssueType;
  severity: Severity;
  description: string;
  lat: number;
  lng: number;
  address: string | null;
  ward: string | null;
  zone: string | null;
}

export interface DraftText {
  en: string;
  kn: string;
}

const ISSUE_EN: Record<IssueType, string> = {
  pothole: "a pothole",
  other_road_damage: "road damage",
  not_a_road_issue: "a road issue",
};
const ISSUE_KN: Record<IssueType, string> = {
  pothole: "ರಸ್ತೆಯ ಗುಂಡಿ",
  other_road_damage: "ರಸ್ತೆ ಹಾನಿ",
  not_a_road_issue: "ರಸ್ತೆ ಸಮಸ್ಯೆ",
};
const SEVERITY_KN: Record<Severity, string> = { Low: "ಕಡಿಮೆ", Medium: "ಮಧ್ಯಮ", High: "ಹೆಚ್ಚು" };

function place(input: DraftInput, lang: "en" | "kn"): string {
  const coords = `${input.lat.toFixed(5)}, ${input.lng.toFixed(5)}`;
  const addr = input.address ?? (lang === "en" ? "the location marked on the map" : "ನಕ್ಷೆಯಲ್ಲಿ ಗುರುತಿಸಿದ ಸ್ಥಳ");
  const ward = input.ward ? (lang === "en" ? `, Ward: ${input.ward}` : `, ವಾರ್ಡ್: ${input.ward}`) : "";
  const zone = input.zone ? (lang === "en" ? `, Zone: ${input.zone}` : `, ವಲಯ: ${input.zone}`) : "";
  return `${addr}${ward}${zone} (${coords})`;
}

/** Deterministic text used when TEXT_PROVIDER=template (no network). Kannada is a fixed template, still flagged for review. */
export function templateText(input: DraftInput): DraftText {
  const en = [
    `Subject: Request to repair ${ISSUE_EN[input.issue_type]} on the road`,
    "",
    "Sir/Madam,",
    "",
    `I would like to report ${ISSUE_EN[input.issue_type]} at ${place(input, "en")}. Assessed severity: ${input.severity}.`,
    input.description ? `Observation: ${input.description}` : "",
    "Photographs are attached. Please inspect the spot and have it repaired at the earliest.",
    "",
    "Yours faithfully,",
    "A concerned citizen",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
  const kn = [
    `ವಿಷಯ: ರಸ್ತೆಯಲ್ಲಿನ ${ISSUE_KN[input.issue_type]} ದುರಸ್ತಿಗೆ ಮನವಿ`,
    "",
    "ಮಾನ್ಯರೇ,",
    "",
    `${place(input, "kn")} ಬಳಿ ${ISSUE_KN[input.issue_type]} ಇರುವುದನ್ನು ತಮ್ಮ ಗಮನಕ್ಕೆ ತರುತ್ತಿದ್ದೇನೆ. ತೀವ್ರತೆ: ${SEVERITY_KN[input.severity]}.`,
    "ಛಾಯಾಚಿತ್ರಗಳನ್ನು ಲಗತ್ತಿಸಲಾಗಿದೆ. ದಯವಿಟ್ಟು ಸ್ಥಳವನ್ನು ಪರಿಶೀಲಿಸಿ ಆದಷ್ಟು ಬೇಗ ದುರಸ್ತಿ ಮಾಡಿಸಬೇಕೆಂದು ಕೋರುತ್ತೇನೆ.",
    "",
    "ವಂದನೆಗಳೊಂದಿಗೆ,",
    "ಒಬ್ಬ ಜಾಗೃತ ನಾಗರಿಕ",
  ].join("\n");
  return { en, kn };
}

const TEXT_PROMPT = `You write short, polite formal complaint letters to the Bruhat Bengaluru Mahanagara Palike (BBMP) about road defects.
Reply with ONLY a JSON object: {"en": string, "kn": string}.
"en" is the letter in English; "kn" is the same letter in Kannada (Kannada script).
Use only the facts given. Do not invent names, phone numbers, dates, officer names, or deadlines. Keep each under 150 words.
Include a subject line, the location, the severity, and a request to inspect and repair. Mention that photographs are attached.`;

/** Draft EN + KN text. Never includes reporter name or contact. */
export async function draftText(config: Config, input: DraftInput, fetchFn: FetchLike = fetch): Promise<DraftText> {
  if (config.text.provider === "template") return templateText(input);
  const facts = {
    issue_type: input.issue_type,
    severity: input.severity,
    observation: input.description,
    address: input.address,
    ward: input.ward,
    zone: input.zone,
    latitude: input.lat,
    longitude: input.lng,
  };
  const raw = (await chatJson(
    config,
    config.text.model,
    [
      { role: "system", content: TEXT_PROMPT },
      { role: "user", content: JSON.stringify(facts) },
    ],
    fetchFn,
  )) as { en?: unknown; kn?: unknown };
  if (typeof raw.en !== "string" || !raw.en.trim() || typeof raw.kn !== "string" || !raw.kn.trim()) {
    throw new AppError("upstream", "Text provider did not return both English and Kannada text.");
  }
  return { en: raw.en.trim(), kn: raw.kn.trim() };
}
