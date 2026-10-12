export type MediaErrorCode =
  | "no_key"
  | "rate_limited"
  | "over_budget"
  | "needs_approval"
  | "provider_error"
  | "unsupported"
  | "expired"
  | "blocked"
  | "invalid";

/** Everything @useclaudia/media throws on purpose. `hint` is a plain-English next step. */
export class ClaudiaMediaError extends Error {
  readonly code: MediaErrorCode;
  readonly hint?: string;
  readonly retryAfterMs?: number;
  /** HTTP status from the provider, when there was one. */
  readonly status?: number;
  constructor(code: MediaErrorCode, message: string, opts: { hint?: string; retryAfterMs?: number; status?: number } = {}) {
    super(message);
    this.name = "ClaudiaMediaError";
    this.code = code;
    this.hint = opts.hint;
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
  }
}

export function isMediaError(e: unknown): e is ClaudiaMediaError {
  return e instanceof ClaudiaMediaError;
}

export function toJobError(e: unknown): { code: string; message: string; hint?: string } {
  if (e instanceof ClaudiaMediaError) return { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  const message = e instanceof Error ? e.message : String(e);
  return { code: "provider_error", message };
}
