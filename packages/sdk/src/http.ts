// Shared HTTP core: JSON in/out, timeouts, typed errors, 429 handling that honours Retry-After.
import { ClaudiaApiError, ClaudiaNetworkError, parseRetryAfter } from "./errors.js";

export const DEFAULT_BASE_URL = "https://useclaudia.xyz";
export const SDK_VERSION = "0.3.0";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** Default https://useclaudia.xyz. */
  baseUrl?: string;
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  /** How many times a 429 is retried automatically (only when the wait is short). Default 2. */
  maxRetries?: number;
  /** Longest Retry-After the SDK will sleep through on its own. Longer waits throw `ClaudiaApiError` (status 429). Default 15 s. */
  maxRetryWaitMs?: number;
  userAgent?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body (serialised once; the exact bytes are what gets signed). */
  body?: unknown;
  /** Multipart body (uploads). */
  form?: FormData;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Turn automatic 429 retries off for this call. */
  noRetry?: boolean;
  /** Called before every attempt with the final path (incl. query) and the raw body, to add auth headers. */
  sign?: (pathWithQuery: string, rawBody: string) => Promise<Record<string, string>>;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildQuery(query: RequestOptions["query"]): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export class HttpCore {
  readonly baseUrl: string;
  protected readonly fetchImpl: FetchLike;
  protected readonly timeoutMs: number;
  protected readonly maxRetries: number;
  protected readonly maxRetryWaitMs: number;
  protected readonly extraHeaders: Record<string, string>;
  protected readonly userAgent: string;
  /** Cookies set by the server (only used by the owner/session client). */
  protected cookies = new Map<string, string>();
  protected keepCookies = false;

  constructor(opts: HttpOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error("No fetch available: use Node ≥ 18.17 or pass `fetch`");
    this.fetchImpl = f.bind(globalThis) as FetchLike;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 15_000;
    this.extraHeaders = opts.headers ?? {};
    this.userAgent = opts.userAgent ?? `useclaudia-sdk/${SDK_VERSION}`;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const u = new URL(url);
    // Exactly what goes on the wire (and what the server sees as req.originalUrl).
    const pathWithQuery = `${u.pathname}${u.search}`;
    const raw = opts.body === undefined ? "" : JSON.stringify(opts.body);
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { accept: "application/json", ...this.extraHeaders, ...(opts.headers ?? {}) };
      if (typeof window === "undefined") headers["user-agent"] = this.userAgent;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      if (this.keepCookies && this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      if (opts.sign) Object.assign(headers, await opts.sign(pathWithQuery, raw));

      const ctl = new AbortController();
      const ms = opts.timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => ctl.abort(), ms);
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, { method, headers, body: opts.form ?? (opts.body === undefined ? undefined : raw), signal: ctl.signal });
        text = await res.text();
      } catch (e) {
        const timedOut = ctl.signal.aborted;
        // A pooled keep-alive socket the server already closed: safe to retry a GET once on a fresh connection.
        const code = (e as { cause?: { code?: string } }).cause?.code ?? "";
        if (!timedOut && method === "GET" && attempt === 0 && /ECONNRESET|EPIPE|UND_ERR_SOCKET|ECONNABORTED/.test(code)) {
          clearTimeout(timer);
          continue;
        }
        throw new ClaudiaNetworkError(
          timedOut ? `${method} ${path} timed out after ${Math.round(ms / 1000)} s` : `Can't reach ${this.baseUrl}: ${(e as Error).message}${(e as { cause?: { code?: string } }).cause?.code ? ` (${(e as { cause: { code: string } }).cause.code})` : ""}`,
          { timeout: timedOut, cause: e },
        );
      } finally {
        clearTimeout(timer);
      }
      if (this.keepCookies) this.storeCookies(res.headers);

      let data: unknown = undefined;
      let parsed = false;
      if (text) {
        try {
          data = JSON.parse(text);
          parsed = true;
        } catch {
          data = text;
        }
      } else parsed = true;

      if (res.ok) {
        if (!parsed) {
          throw new ClaudiaApiError({
            status: res.status,
            code: "bad_response",
            message: `${method} ${path} returned non-JSON (is ${this.baseUrl} a Claudia server?)`,
            body: text.slice(0, 300),
            method,
            path: pathWithQuery,
          });
        }
        return { status: res.status, data: data as T, headers: res.headers };
      }

      const body = (parsed && data && typeof data === "object" ? data : {}) as { error?: string; message?: string; retryAfterSec?: number };
      const retryAfter = parseRetryAfter(res.headers.get("retry-after")) ?? (typeof body.retryAfterSec === "number" ? body.retryAfterSec : undefined);
      const err = new ClaudiaApiError({
        status: res.status,
        code: body.error ?? (res.status === 429 ? "rate_limited" : `http_${res.status}`),
        message: body.message ?? (parsed ? `HTTP ${res.status}` : `HTTP ${res.status}: ${String(text).slice(0, 160)}`),
        retryAfter,
        body: data,
        method,
        path: pathWithQuery,
      });
      if (res.status === 429 && !opts.noRetry && attempt < this.maxRetries) {
        const waitMs = retryAfter !== undefined ? retryAfter * 1000 : Math.min(8_000, 1_000 * 2 ** attempt);
        if (waitMs <= this.maxRetryWaitMs) {
          await sleep(Math.max(250, waitMs));
          continue;
        }
      }
      throw err;
    }
  }

  private storeCookies(h: Headers) {
    const list = (h as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? (h.get("set-cookie") ? [h.get("set-cookie")!] : []);
    for (const c of list) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      if (i <= 0) continue;
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (/max-age=0/i.test(c) || !v) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
}
