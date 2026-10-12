// A minimal MCP client over Streamable HTTP (JSON-RPC 2.0 over POST; answers come back as JSON or as an SSE stream).
// Enough to list and call tools on Claudia's online servers — https://useclaudia.xyz/mcp/data (read-only, no sign-in
// needed) and /mcp/trade (OAuth). For a full client use the official MCP SDK; most agent frameworks can also point
// at these URLs directly.
import { ClaudiaApiError, ClaudiaNetworkError } from "./errors.js";
import { DEFAULT_BASE_URL, SDK_VERSION, type FetchLike } from "./http.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpCallResult {
  content: ({ type: "text"; text: string } | { type: string; [k: string]: unknown })[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpHttpOptions {
  /** Full server URL, or `server` + base URL. Default https://useclaudia.xyz/mcp/data. */
  url?: string;
  server?: "data" | "trade";
  baseUrl?: string;
  /** OAuth access token (needed for /mcp/trade and write tools). A function is called before each request. */
  token?: string | (() => Promise<string | null | undefined> | string | null | undefined);
  fetch?: FetchLike;
  timeoutMs?: number;
  clientName?: string;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpHttpClient {
  readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly opts: McpHttpOptions;
  private sessionId?: string;
  private protocol = MCP_PROTOCOL_VERSION;
  private initP?: Promise<void>;
  private nextId = 1;

  constructor(opts: McpHttpOptions = {}) {
    this.opts = opts;
    const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.url = opts.url ?? `${base}/mcp/${opts.server ?? "data"}`;
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error("No fetch available: use Node ≥ 18.17 or pass `fetch`");
    this.fetchImpl = f.bind(globalThis) as FetchLike;
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    if (this.initP) h["mcp-protocol-version"] = this.protocol;
    const t = typeof this.opts.token === "function" ? await this.opts.token() : this.opts.token;
    if (t) h.authorization = `Bearer ${t}`;
    return h;
  }

  private async post(body: Record<string, unknown>): Promise<RpcResponse | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 30_000);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(this.url, { method: "POST", headers: await this.headers(), body: JSON.stringify(body), signal: ctl.signal });
      text = await res.text();
    } catch (e) {
      throw new ClaudiaNetworkError(ctl.signal.aborted ? `MCP ${String(body.method)} timed out` : `Can't reach ${this.url}: ${(e as Error).message}`, { timeout: ctl.signal.aborted, cause: e });
    } finally {
      clearTimeout(timer);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 202 || (!text && res.ok)) return null;
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string; error_description?: string };
        msg = (typeof j.error === "object" ? j.error?.message : j.error_description ?? j.message ?? j.error) ?? msg;
      } catch {
        /* not JSON */
      }
      throw new ClaudiaApiError({ status: res.status, code: res.status === 401 ? "unauthorized" : `http_${res.status}`, message: `MCP ${String(body.method)}: ${msg}`, body: text.slice(0, 300), method: "POST", path: new URL(this.url).pathname });
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json") && !ct.includes("event-stream")) {
      throw new ClaudiaApiError({ status: 404, code: "not_mcp", message: `${this.url} isn't an MCP endpoint (answered ${ct.split(";")[0] || "without a content type"})`, body: text.slice(0, 200), method: "POST", path: new URL(this.url).pathname });
    }
    const messages: RpcResponse[] = [];
    if (ct.includes("text/event-stream")) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          messages.push(JSON.parse(data) as RpcResponse);
        } catch {
          /* skip */
        }
      }
    } else {
      const j = JSON.parse(text) as RpcResponse | RpcResponse[];
      messages.push(...(Array.isArray(j) ? j : [j]));
    }
    return messages.find((m) => m.id === body.id) ?? messages[messages.length - 1] ?? null;
  }

  private async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const r = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    if (!r) throw new ClaudiaApiError({ status: 502, code: "bad_response", message: `MCP ${method}: empty answer`, method: "POST", path: new URL(this.url).pathname });
    if (r.error) throw new ClaudiaApiError({ status: 400, code: `mcp_${r.error.code}`, message: `MCP ${method}: ${r.error.message}`, body: r.error.data, method: "POST", path: new URL(this.url).pathname });
    return r.result as T;
  }

  /** initialize + notifications/initialized (done once, automatically). */
  connect(): Promise<void> {
    this.initP ??= (async () => {
      const r = await this.rpc<{ protocolVersion?: string }>("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.opts.clientName ?? "useclaudia-sdk", version: SDK_VERSION },
      });
      if (r?.protocolVersion) this.protocol = r.protocolVersion;
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    })().catch((e) => {
      this.initP = undefined;
      throw e;
    });
    return this.initP;
  }

  async listTools(): Promise<McpTool[]> {
    await this.connect();
    const out: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.rpc<{ tools: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {});
      out.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    await this.connect();
    return this.rpc<McpCallResult>("tools/call", { name, arguments: args });
  }

  /** Ends the session (DELETE), best effort. */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.fetchImpl(this.url, { method: "DELETE", headers: await this.headers() });
    } catch {
      /* ignore */
    }
    this.sessionId = undefined;
    this.initP = undefined;
  }
}

/** The text of a tool result (all text parts joined), or its structured content as JSON. */
export function mcpResultText(r: McpCallResult): string {
  const text = r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => c.text)
    .join("\n");
  if (text) return text;
  return r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : "";
}
