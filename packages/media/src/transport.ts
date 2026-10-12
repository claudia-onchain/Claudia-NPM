// Every provider call goes through one transport. With dryRun it returns the exact request it would send
// (secret headers and query params replaced with "***") instead of sending it.
import { ClaudiaMediaError } from "./errors.js";
import type { DryRunRequest } from "./types.js";

export type FormPart =
  | { name: string; value: string }
  | { name: string; filename: string; mime: string; data: Uint8Array };

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** JSON body (sent with Content-Type: application/json). */
  json?: unknown;
  /** multipart/form-data body. */
  form?: FormPart[];
  /** How to read a 2xx response. Default "json". */
  expect?: "json" | "bytes" | "text";
  /** Extra header names to redact (Authorization, x-goog-api-key, xi-api-key, X-Api-Key are always redacted). */
  secrets?: string[];
  /** Query parameter names to redact (`key` is always redacted). */
  secretQuery?: string[];
  /** Provider name for error messages. */
  label?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  json?: any;
  bytes?: Uint8Array;
  text?: string;
}

export interface DryRunResult {
  dryRun: true;
  request: DryRunRequest;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse | DryRunResult>;

const ALWAYS_SECRET = ["authorization", "x-goog-api-key", "xi-api-key", "x-api-key", "api-key", "x-key", "proxy-authorization"];
const ALWAYS_SECRET_QUERY = ["key", "api_key", "token"];

/** The request as it would go on the wire, with secrets replaced by "***". */
export function redactRequest(req: HttpRequest): DryRunRequest {
  const secret = new Set([...ALWAYS_SECRET, ...(req.secrets ?? []).map((s) => s.toLowerCase())]);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(wireHeaders(req))) headers[k] = secret.has(k.toLowerCase()) ? "***" : v;
  let url = req.url;
  try {
    const u = new URL(req.url);
    const sq = new Set([...ALWAYS_SECRET_QUERY, ...(req.secretQuery ?? [])]);
    let touched = false;
    for (const name of [...u.searchParams.keys()]) {
      if (sq.has(name)) {
        u.searchParams.set(name, "***");
        touched = true;
      }
    }
    if (touched) url = u.toString().replace(/%2A%2A%2A/g, "***");
  } catch {
    // not a URL we can parse; leave as is
  }
  const out: DryRunRequest = { method: req.method, url, headers };
  if (req.json !== undefined) out.body = req.json;
  else if (req.form) {
    const body: Record<string, unknown> = {};
    for (const p of req.form) {
      const v = "data" in p ? `<file ${p.filename}, ${p.data.byteLength} bytes, ${p.mime}>` : p.value;
      if (body[p.name] === undefined) body[p.name] = v;
      else body[p.name] = ([] as unknown[]).concat(body[p.name], v);
    }
    out.body = body;
  }
  return out;
}

function wireHeaders(req: HttpRequest): Record<string, string> {
  const h: Record<string, string> = { ...(req.headers ?? {}) };
  if (req.json !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["Content-Type"] = "application/json";
  if (req.form) h["Content-Type"] = "multipart/form-data";
  return h;
}

export function retryAfterMs(h: Record<string, string>): number | undefined {
  const v = h["retry-after"];
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function providerMessage(body: unknown, text: string): string {
  if (body && typeof body === "object") {
    const b = body as any;
    const m =
      b.error?.message ?? b.detail?.message ?? b.detail?.[0]?.msg ?? (typeof b.detail === "string" ? b.detail : undefined) ??
      b.message ?? b.error_message ?? (typeof b.error === "string" ? b.error : undefined) ?? b.msg;
    if (typeof m === "string" && m) return m;
  }
  return text.slice(0, 300) || "no details";
}

export function createTransport(opts: { fetch?: typeof fetch; dryRun?: boolean } = {}): Transport {
  return async (req: HttpRequest) => {
    if (opts.dryRun) return { dryRun: true, request: redactRequest(req) };
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new ClaudiaMediaError("unsupported", "No fetch available", { hint: "Use Node.js 18.17 or newer, or pass `fetch`." });
    const headers = wireHeaders(req);
    let body: BodyInit | undefined;
    if (req.json !== undefined) body = JSON.stringify(req.json);
    else if (req.form) {
      delete headers["Content-Type"]; // fetch sets the boundary
      const fd = new FormData();
      for (const p of req.form) {
        if ("data" in p) fd.append(p.name, new Blob([new Uint8Array(p.data)], { type: p.mime }), p.filename);
        else fd.append(p.name, p.value);
      }
      body = fd;
    }
    const label = req.label ?? new URL(req.url).host;
    let res: Response;
    try {
      res = await f(req.url, {
        method: req.method,
        headers,
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
      });
    } catch (e) {
      throw new ClaudiaMediaError("provider_error", `${label}: request failed (${(e as Error)?.message ?? e})`, {
        hint: "Check the network connection; the job will be retried.",
        retryAfterMs: 15_000,
      });
    }
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const msg = `${label} ${res.status}: ${providerMessage(parsed, text)}`;
      if (res.status === 429)
        throw new ClaudiaMediaError("rate_limited", msg, {
          status: 429,
          retryAfterMs: retryAfterMs(h) ?? 30_000,
          hint: "The provider is rate limiting this key. The job will retry after the wait; or lower concurrency.",
        });
      if (res.status === 401 || res.status === 403)
        throw new ClaudiaMediaError("provider_error", msg, {
          status: res.status,
          hint: `The ${label} key was refused. Check it is correct, has billing enabled and has access to this model.`,
        });
      if (res.status === 402)
        throw new ClaudiaMediaError("over_budget", msg, { status: 402, hint: `Your ${label} account is out of credit. Top it up on the provider's site.` });
      if (res.status === 404 || res.status === 410)
        throw new ClaudiaMediaError("expired", msg, { status: res.status, hint: "The provider no longer has this resource (it may have expired or been deleted)." });
      if (res.status === 400 || res.status === 422)
        throw new ClaudiaMediaError("invalid", msg, { status: res.status, hint: "The provider rejected the request. Check the prompt, size, duration and refs for this model." });
      throw new ClaudiaMediaError("provider_error", msg, {
        status: res.status,
        retryAfterMs: res.status >= 500 ? retryAfterMs(h) ?? 20_000 : undefined,
        hint: res.status >= 500 ? "The provider had a problem. The job will be retried." : undefined,
      });
    }
    const out: HttpResponse = { status: res.status, url: res.url || req.url, headers: h };
    const expect = req.expect ?? "json";
    if (expect === "bytes") out.bytes = new Uint8Array(await res.arrayBuffer());
    else if (expect === "text") out.text = await res.text();
    else {
      const text = await res.text();
      try {
        out.json = text ? JSON.parse(text) : {};
      } catch {
        throw new ClaudiaMediaError("provider_error", `${label}: expected JSON, got: ${text.slice(0, 200)}`);
      }
    }
    return out;
  };
}

export function isDry(r: HttpResponse | DryRunResult): r is DryRunResult {
  return (r as DryRunResult).dryRun === true;
}
