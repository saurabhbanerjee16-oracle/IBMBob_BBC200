import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { ESCALATION_LEVELS, type EscalationLevel, type EscalationStep } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface RawLevel {
  level: unknown;
  days: unknown;
}

/** Read `config/escalation.json` and return validated `{level, days}` rows, in file order. */
export async function loadEscalationLevels(config: Config): Promise<{ level: EscalationLevel; days: number | null }[]> {
  const parsed = JSON.parse(await readFile(config.escalationPath, "utf8")) as { levels?: RawLevel[] };
  if (!Array.isArray(parsed.levels)) throw new AppError("config", "config/escalation.json must contain a 'levels' array.");
  return parsed.levels.map((row) => {
    if (!ESCALATION_LEVELS.includes(row.level as EscalationLevel)) {
      throw new AppError("config", `Unknown escalation level in config: ${String(row.level)}`);
    }
    if (row.days !== null && !(Number.isInteger(row.days) && (row.days as number) >= 0)) {
      throw new AppError("config", `Escalation days for ${String(row.level)} must be null or a non-negative integer.`);
    }
    return { level: row.level as EscalationLevel, days: row.days as number | null };
  });
}

/** `due = created_at + days` only when days is set; otherwise `due = null` ("not configured"). */
export function computeEscalation(
  createdAt: string,
  levels: { level: EscalationLevel; days: number | null }[],
): EscalationStep[] {
  const base = Date.parse(createdAt);
  if (Number.isNaN(base)) throw new AppError("validation", "created_at is not a valid date-time.");
  return levels.map(({ level, days }) => ({
    level,
    days,
    due: days === null ? null : new Date(base + days * DAY_MS).toISOString(),
  }));
}

export interface EscalationReport {
  configured: boolean;
  /** Highest level whose due date has passed; null if none has passed or nothing is configured. */
  current_level: EscalationLevel | null;
  next_due: { level: EscalationLevel; due: string } | null;
  message: string;
}

/** Report escalation position. Never claims BBMP has acted. */
export function escalationReport(steps: EscalationStep[], now: Date = new Date()): EscalationReport {
  const configured = steps.filter((s) => s.due !== null);
  if (configured.length === 0) {
    return {
      configured: false,
      current_level: null,
      next_due: null,
      message: "Escalation days are not configured, so no due dates can be shown.",
    };
  }
  const passed = configured.filter((s) => Date.parse(s.due as string) <= now.getTime());
  const upcoming = configured.find((s) => Date.parse(s.due as string) > now.getTime());
  const current = passed.length ? (passed[passed.length - 1] as EscalationStep).level : null;
  return {
    configured: true,
    current_level: current,
    next_due: upcoming ? { level: upcoming.level, due: upcoming.due as string } : null,
    message: upcoming
      ? `Next escalation: ${upcoming.level} due ${upcoming.due}. This does not mean BBMP has acted.`
      : "All configured escalation dates have passed. This does not mean BBMP has acted.",
  };
}
