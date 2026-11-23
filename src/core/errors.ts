export type ErrorCode =
  | "validation"
  | "not_found"
  | "conflict"
  | "config"
  | "upstream"
  | "unauthorized"
  | "rate_limited";

const HTTP_STATUS: Record<ErrorCode, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  config: 500,
  upstream: 502,
  unauthorized: 401,
  rate_limited: 429,
};

/** Error with a stable machine-readable code and a message safe to show to the caller. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** Optional machine-readable detail, e.g. which field the client should fix. */
  readonly detail?: string;

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.detail = detail;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
