import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { isTrackingId } from "./ids.js";
import type { Complaint } from "./types.js";
import { validateComplaint } from "./validate.js";

// Serialises read-modify-write cycles per tracking ID within this process.
// Atomic rename protects readers from torn files; this lock protects writers from lost updates.
// It does NOT coordinate separate processes (web server + MCP server): a known limit of JSON-file storage.
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(id, tail);
  try {
    return await run;
  } finally {
    if (locks.get(id) === tail) locks.delete(id);
  }
}

function complaintPath(config: Config, id: string): string {
  if (!isTrackingId(id)) throw new AppError("validation", "Invalid tracking ID format.");
  return path.join(config.complaintsDir, `${id}.json`);
}

/** Write via temp file + rename so readers never observe a partial file. */
export async function atomicWriteFile(target: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data);
    // Windows can briefly refuse to replace a file that a reader has open; retry a few times.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, target);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 5 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw err;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function saveComplaint(config: Config, complaint: Complaint): Promise<void> {
  const valid = await validateComplaint(config, complaint);
  const target = complaintPath(config, valid.tracking_id);
  await withLock(valid.tracking_id, () => atomicWriteFile(target, JSON.stringify(valid, null, 2) + "\n"));
}

async function readComplaintFile(config: Config, id: string): Promise<Complaint | null> {
  try {
    const raw = await readFile(complaintPath(config, id), "utf8");
    return JSON.parse(raw) as Complaint;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function getComplaint(config: Config, id: string): Promise<Complaint | null> {
  return readComplaintFile(config, id);
}

/** Atomic read-modify-write. `mutate` returns the new record; the result is validated before saving. */
export async function updateComplaint(
  config: Config,
  id: string,
  mutate: (current: Complaint) => Complaint | Promise<Complaint>,
): Promise<Complaint> {
  const target = complaintPath(config, id);
  return withLock(id, async () => {
    const current = await readComplaintFile(config, id);
    if (!current) throw new AppError("not_found", "Complaint not found.");
    const next = await validateComplaint(config, await mutate(current));
    if (next.tracking_id !== id) throw new AppError("validation", "tracking_id cannot change.");
    await atomicWriteFile(target, JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}

/** Reads every file; fine for demo volumes only. Files that fail to parse are skipped and reported on stderr. */
export async function listComplaints(config: Config): Promise<Complaint[]> {
  let names: string[];
  try {
    names = await readdir(config.complaintsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Complaint[] = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || !isTrackingId(id)) continue;
    try {
      const c = await readComplaintFile(config, id);
      if (c) out.push(c);
    } catch (err) {
      console.error(`Skipping unreadable complaint file ${name}:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
