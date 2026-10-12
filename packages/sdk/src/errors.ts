/** Base class for everything the SDK throws on purpose. */
export class ClaudiaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ClaudiaError";
    this.code = code;
  }
}

/**
 * The server answered with an error (`{ "error": "<code>", "message": "<human text>" }`).
 * `retryAfter` is in seconds (from `Retry-After` or the body's `retryAfterSec`) when the server gave one.
 */
export class ClaudiaApiError extends ClaudiaError {
  readonly status: number;
  readonly retryAfter?: number;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
  constructor(init: { status: number; code: string; message: string; retryAfter?: number; body?: unknown; method: string; path: string }) {
    super(init.code, init.message);
    this.name = "ClaudiaApiError";
    this.status = init.status;
    this.retryAfter = init.retryAfter;
    this.body = init.body;
    this.method = init.method;
    this.path = init.path;
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/** The request never got an answer: DNS, connection refused, TLS, or the timeout fired. */
export class ClaudiaNetworkError extends ClaudiaError {
  readonly cause?: unknown;
  constructor(message: string, opts: { timeout?: boolean; cause?: unknown } = {}) {
    super(opts.timeout ? "timeout" : "network", message);
    this.name = "ClaudiaNetworkError";
    this.cause = opts.cause;
  }
}

/** Something about the input or local setup is wrong (no API key, bad secret key, missing signer…). */
export class ClaudiaConfigError extends ClaudiaError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ClaudiaConfigError";
  }
}

/** A Solana transaction could not be signed, sent or confirmed. */
export class ClaudiaTxError extends ClaudiaError {
  readonly signature?: string;
  readonly logs?: string[];
  constructor(code: string, message: string, opts: { signature?: string; logs?: string[] } = {}) {
    super(code, message);
    this.name = "ClaudiaTxError";
    this.signature = opts.signature;
    this.logs = opts.logs;
  }
}

/** Parses `Retry-After` (seconds or an HTTP date) into seconds. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const s = header.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Math.ceil(Number(s)));
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, Math.ceil((t - now) / 1000));
  return undefined;
}
