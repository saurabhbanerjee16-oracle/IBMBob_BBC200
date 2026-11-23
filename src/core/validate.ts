import { readFile } from "node:fs/promises";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import type { Complaint } from "./types.js";

const cache = new Map<string, ValidateFunction>();

async function getValidator(schemaPath: string): Promise<ValidateFunction> {
  const cached = cache.get(schemaPath);
  if (cached) return cached;
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);
  cache.set(schemaPath, validate);
  return validate;
}

/** Validate against `schema/complaint.schema.json`; throws `AppError("validation")` naming the bad fields. */
export async function validateComplaint(config: Config, value: unknown): Promise<Complaint> {
  const validate = await getValidator(config.schemaPath);
  if (!validate(value)) {
    const problems = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`)
      .join("; ");
    throw new AppError("validation", `Complaint failed schema validation: ${problems}`, problems);
  }
  return value as Complaint;
}
