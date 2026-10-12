// One door for every network call. With dryRun the request is recorded (secrets → "***") and a
// mock answer comes back so multi-step flows (upload → post) can still show every step.
import { ClaudiaSocialError } from "./errors.js";
import type { DryRunRequest } from "./types.js";

export type MultipartPart =
  | { name: string; value: string }
  | { name: string; file: { bytes: Uint8Array; mime: string; filename: string } };

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  multipart?: MultipartPart[];
  raw?: { bytes: Uint8Array; mime: string };
  /** Values to hide anywhere they appear (URL paths like Telegram's bot<token>, bodies). */
  secrets?: (string | undefined | null)[];
  /** Dry-run answer. */
  mock?: unknown;
  mockHeaders?: Record<string, string>;
  mockStatus?: number;
  label?: string;
  network?: string;
  /** What a dry run shows as the body (e.g. the fields of a hand-built multipart body). */
  display?: unknown;
  /** Statuses treated as success (default 200–299). */
  ok?: (status: number) => boolean;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json: any;
  text: string;
  dryRun: boolean;
}

const SENSITIVE_HEADER = /^(authorization|x-api-key|api-key|apikey|cookie|x-auth-token|x-access-token|proxy-authorization)$/i;
const SENSITIVE_FIELD =
  /^(password|secret|client_secret|clientSecret|token|access_token|accessToken|refresh_token|refreshToken|refreshJwt|accessJwt|code_verifier|code|api_key|apiKey|signer_uuid|nsec|private_key|app_password|bot_token|fb_exchange_token|ig_exchange_token|th_exchange_token|assertion)$/;

export class Transport {
  readonly dryRun: boolean;
  readonly requests: DryRunRequest[] = [];
  private fetchImpl: typeof fetch;

  constructor(opts: { fetch?: typeof fetch; dryRun?: boolean } = {}) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.dryRun = !!opts.dryRun;
  }

  /** A transport that shares the fetch but records instead of sending. */
  dry(): Transport {
    return new Transport({ fetch: this.fetchImpl, dryRun: true });
  }

  /** Record a non-HTTP step (WebSocket send) in the dry-run log. */
  note(entry: DryRunRequest, secrets: (string | undefined | null)[] = []): void {
    const s = secrets.filter((x): x is string => !!x && x.length >= 4);
    this.requests.push({ ...entry, url: scrub(entry.url, s), body: redactDeep(entry.body, s) });
  }

  describe(req: HttpRequest): DryRunRequest {
    const secrets = (req.secrets ?? []).filter((x): x is string => !!x && x.length >= 4);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (SENSITIVE_HEADER.test(k)) {
        const m = /^(Bearer|Bot|Basic|Apikey|OAuth|Token)\s+/i.exec(v);
        headers[k] = m ? `${m[1]} ***` : "***";
      } else headers[k] = scrub(v, secrets);
    }
    let body: unknown;
    if (req.json !== undefined) {
      headers["Content-Type"] ??= "application/json";
      body = redactDeep(req.json, secrets);
    } else if (req.form) {
      headers["Content-Type"] ??= "application/x-www-form-urlencoded";
      body = redactDeep(req.form, secrets);
    } else if (req.multipart) {
      headers["Content-Type"] ??= "multipart/form-data";
      body = {
        multipart: req.multipart.map((p) =>
          "file" in p
            ? { name: p.name, file: { filename: p.file.filename, mime: p.file.mime, bytes: p.file.bytes.byteLength } }
            : { name: p.name, value: redactDeep(tryJson(p.value), secrets) },
        ),
      };
    } else if (req.raw) {
      headers["Content-Type"] ??= req.raw.mime;
      body = `<${req.raw.bytes.byteLength} bytes ${req.raw.mime}>`;
    }
    if (req.display !== undefined) body = redactDeep(req.display, secrets);
    const out: DryRunRequest = { method: req.method, url: scrub(redactUrl(req.url), secrets), headers };
    if (body !== undefined) out.body = body;
    if (req.label) out.label = req.label;
    return out;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    if (this.dryRun) {
      this.requests.push(this.describe(req));
      const mock = req.mock ?? {};
      return {
        status: req.mockStatus ?? 200,
        headers: lower(req.mockHeaders ?? {}),
        json: mock,
        text: typeof mock === "string" ? mock : JSON.stringify(mock),
        dryRun: true,
      };
    }
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let body: BodyInit | undefined;
    if (req.json !== undefined) {
      headers["Content-Type"] ??= "application/json";
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers["Content-Type"] ??= "application/x-www-form-urlencoded";
      body = new URLSearchParams(req.form).toString();
    } else if (req.multipart) {
      const fd = new FormData();
      for (const p of req.multipart) {
        if ("file" in p) fd.append(p.name, new Blob([p.file.bytes as unknown as ArrayBuffer], { type: p.file.mime }), p.file.filename);
        else fd.append(p.name, p.value);
      }
      body = fd;
    } else if (req.raw) {
      headers["Content-Type"] ??= req.raw.mime;
      body = req.raw.bytes as unknown as BodyInit;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(req.url, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
      });
    } catch (e) {
      const secrets = (req.secrets ?? []).filter((x): x is string => !!x && x.length >= 4);
      throw new ClaudiaSocialError("provider_error", `Could not reach ${hostOf(req.url)}: ${scrub(e instanceof Error ? e.message : String(e), secrets)}`, {
        hint: "Check the connection and try again. If this was a post, check the account first: it may already be live.",
        network: req.network,
        uncertain: req.method !== "GET",
      });
    }
    const text = await res.text().catch(() => "");
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    const hdrs: Record<string, string> = {};
    res.headers.forEach((v, k) => (hdrs[k.toLowerCase()] = v));
    const ok = req.ok ? req.ok(res.status) : res.status >= 200 && res.status < 300;
    if (!ok) throw httpError(req, res.status, hdrs, json, text);
    return { status: res.status, headers: hdrs, json: json ?? {}, text, dryRun: false };
  }
}

function httpError(req: HttpRequest, status: number, headers: Record<string, string>, json: any, text: string): ClaudiaSocialError {
  const secrets = (req.secrets ?? []).filter((x): x is string => !!x && x.length >= 4);
  const msg = scrub(providerMessage(json) ?? text.slice(0, 300), secrets) || `HTTP ${status}`;
  const where = hostOf(req.url);
  if (status === 429) {
    let retryAfterMs: number | undefined;
    const ra = headers["retry-after"];
    if (ra) retryAfterMs = /^\d+$/.test(ra) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now());
    const reset = headers["x-rate-limit-reset"] ?? headers["x-ratelimit-reset"];
    if (!retryAfterMs && reset && /^\d+$/.test(reset)) {
      const n = Number(reset);
      retryAfterMs = n > 1e9 ? Math.max(0, n * 1000 - Date.now()) : n * 1000;
    }
    return new ClaudiaSocialError("rate_limited", `${where} says slow down: ${msg}`, {
      status,
      retryAfterMs,
      network: req.network,
      hint: "Wait and try again later; Claudia does not retry posts on her own.",
    });
  }
  if (status === 401) {
    return new ClaudiaSocialError("expired", `${where} rejected the credentials: ${msg}`, {
      status,
      network: req.network,
      hint: "Reconnect this account (the token expired, was revoked, or the key is wrong).",
    });
  }
  if (status === 402) {
    return new ClaudiaSocialError("over_budget", `${where} needs payment or credits: ${msg}`, {
      status,
      network: req.network,
      hint: "Add credits to your own developer account, or turn this network off.",
    });
  }
  return new ClaudiaSocialError("provider_error", `${where} answered ${status}: ${msg}`, {
    status,
    network: req.network,
    hint: status === 403 ? "The app may lack a permission/scope, or the network refused this content." : undefined,
  });
}

function providerMessage(j: any): string | undefined {
  if (!j || typeof j !== "object") return undefined;
  const parts = [
    j.detail,
    j.title,
    j.error_description,
    typeof j.error === "string" ? j.error : j.error?.message,
    j.message,
    j.description,
    Array.isArray(j.errors) ? j.errors.map((e: any) => e?.message ?? e?.detail ?? JSON.stringify(e)).join("; ") : undefined,
  ].filter((x) => typeof x === "string" && x);
  return parts.length ? [...new Set(parts)].join(" — ").slice(0, 400) : undefined;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the network";
  }
}

function lower(h: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v;
  return o;
}

function tryJson(v: string): unknown {
  if (!/^[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Hides credential-looking query params (access_token=, key=, …). */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(access_token|key|api_key|token|client_secret|code|code_verifier|refresh_token|fb_exchange_token|ig_exchange_token|th_exchange_token)$/i.test(k)) {
        u.searchParams.set(k, "***");
      }
    }
    return u.toString().replace(/%2A%2A%2A/g, "***");
  } catch {
    return url;
  }
}

export function scrub(s: string, secrets: string[]): string {
  let out = s;
  for (const x of secrets) if (x) out = out.split(x).join("***");
  return out;
}

export function redactDeep(v: unknown, secrets: string[]): unknown {
  if (typeof v === "string") return scrub(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, secrets));
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = SENSITIVE_FIELD.test(k) && typeof x === "string" ? "***" : redactDeep(x, secrets);
    return o;
  }
  return v;
}
