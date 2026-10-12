export type SocialErrorCode =
  | "no_key"
  | "rate_limited"
  | "over_budget"
  | "needs_approval"
  | "provider_error"
  | "unsupported"
  | "expired"
  | "blocked"
  | "invalid";

/** Everything @useclaudia/social throws on purpose. `hint` is a plain-English next step. */
export class ClaudiaSocialError extends Error {
  readonly code: SocialErrorCode;
  readonly hint?: string;
  readonly retryAfterMs?: number;
  /** HTTP status from the network, when there was one. */
  readonly status?: number;
  /** Network the error came from. */
  readonly network?: string;
  /** The request may have reached the network before the connection dropped (it may be live). */
  readonly uncertain?: boolean;
  constructor(
    code: SocialErrorCode,
    message: string,
    opts: { hint?: string; retryAfterMs?: number; status?: number; network?: string; uncertain?: boolean } = {},
  ) {
    super(message);
    this.name = "ClaudiaSocialError";
    this.code = code;
    this.hint = opts.hint;
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
    this.network = opts.network;
    this.uncertain = opts.uncertain;
  }
}

export function isSocialError(e: unknown): e is ClaudiaSocialError {
  return e instanceof ClaudiaSocialError;
}

export function errorText(e: unknown): string {
  if (e instanceof ClaudiaSocialError) return e.hint ? `${e.message} (${e.hint})` : e.message;
  return e instanceof Error ? e.message : String(e);
}
