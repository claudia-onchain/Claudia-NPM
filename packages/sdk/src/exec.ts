// Runs catalog tools for agent frameworks: read tools are answered locally with SDK calls (no MCP round trip), and
// anything else is forwarded to Claudia's online MCP server (/mcp/data or /mcp/trade), so the adapters keep working
// when the catalog grows. Money-moving tools online are non-custodial: they return a /confirm link the user signs.
import type { ClaudiaClient } from "./client.js";
import { ClaudiaConfigError } from "./errors.js";
import { McpHttpClient, mcpResultText, type McpHttpOptions } from "./mcp-http.js";
import type { ChainId, TokenPhase } from "./types.js";

/** The parts of a catalog `ToolDef` (`@useclaudia/sdk/tools`) the adapters need. */
export interface CatalogTool {
  name: string;
  title?: string;
  description: string;
  server?: "data" | "trade" | "local";
  input: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  scope?: string;
}

/** Loads the shared tool catalog (`@useclaudia/sdk/tools`). */
export async function loadCatalog(): Promise<CatalogTool[]> {
  try {
    const spec = "./tools/index.js"; // built from src/tools (the catalog shared with the MCP servers)
    const mod = (await import(/* @vite-ignore */ spec)) as { TOOLS?: CatalogTool[] };
    if (Array.isArray(mod.TOOLS)) return mod.TOOLS;
  } catch {
    /* fall through */
  }
  throw new ClaudiaConfigError("no_catalog", "The tool catalog (@useclaudia/sdk/tools) isn't available in this build. Pass `tools` explicitly.");
}

export type ToolArgs = Record<string, unknown>;
export type ToolHandler = (args: ToolArgs, client: ClaudiaClient) => Promise<unknown>;

const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const need = (v: unknown, what: string): string => {
  const x = s(v);
  if (!x) throw new ClaudiaConfigError("bad_input", `Missing "${what}"`);
  return x;
};
const tok = (a: ToolArgs) => need(a.coin ?? a.token ?? a.mint ?? a.key, "coin");
const chainOf = (a: ToolArgs) => (s(a.chain) as ChainId | undefined) ?? "sol";

/** Local SDK implementations of the read tools, keyed by every name they're known under. */
const HANDLERS: [string[], ToolHandler][] = [
  [["platform", "get_platform", "platform_config"], (_a, c) => c.platform(true)],
  [["home", "get_home", "home_feed"], (_a, c) => c.home()],
  [["board", "get_board", "live_board"], (a, c) => c.board(chainOf(a), s(a.phase) as TokenPhase | undefined, n(a.limit) ?? 20)],
  [["search", "search_tokens", "token_search", "search_coins"], async (a, c) => (s(a.q ?? a.query) ? c.search(need(a.q ?? a.query, "query"), n(a.limit)) : c.board("sol", s(a.phase) as TokenPhase | undefined, n(a.limit) ?? 20))],
  [["token", "get_token", "token_detail", "get_coin"], async (a, c) => {
    const t = await c.token(tok(a));
    return { ...t, recentTrades: t.recentTrades?.slice(0, 15), holdersList: t.holdersList?.slice(0, 15) };
  }],
  [["token_agent", "get_token_agent"], (a, c) => c.tokenAgent(tok(a))],
  [["ask", "ask_claudia", "token_ask"], (a, c) => c.ask(tok(a), need(a.question, "question"))],
  [["agents", "list_agents"], (a, c) => c.agents({ q: s(a.q ?? a.query), tier: s(a.tier) as never, category: s(a.category) as never, mode: s(a.mode) as never, sort: s(a.sort) as never, limit: n(a.limit), cursor: s(a.cursor) })],
  [["agent", "get_agent", "agent_profile"], async (a, c) => {
    const slug = need(a.slug ?? a.agent, "slug");
    const [agent, recent] = await Promise.all([c.agent(slug), c.agentMessages(slug, { limit: 10 }).catch(() => ({ data: [] }))]);
    return { agent, recent: recent.data };
  }],
  [["thread_rooms", "rooms", "list_rooms"], (_a, c) => c.rooms()],
  [["thread_read", "read_thread", "thread_messages", "room_messages"], async (a, c) => {
    const room = s(a.room);
    if (!room) return { rooms: await c.rooms() };
    const page = await c.messages(room, { limit: n(a.limit) ?? 20, after: s(a.after), before: s(a.before) });
    return { room, nextCursor: page.nextCursor ?? null, messages: page.data.map((m) => ({ id: m.id, at: m.createdAt, agent: `${m.agent.name} (@${m.agent.slug}, ${m.agent.tier})`, kind: m.kind, replyTo: m.replyTo ?? null, content: m.content })) };
  }],
  [["insights", "token_insights", "insights_token", "get_token_insights", "get_coin_insights"], (a, c) => c.insights.token(tok(a))],
  [["holders", "token_holders", "insights_holders", "get_holders"], async (a, c) => {
    const tag = s(a.tag);
    const r = await c.insights.holders(tok(a), { limit: tag ? 100 : n(a.limit) });
    return tag ? { ...r, data: r.data.filter((h) => h.tags.includes(tag as never)).slice(0, n(a.limit) ?? 100) } : r;
  }],
  [["traders", "token_traders", "insights_traders", "top_traders", "get_traders"], (a, c) => c.insights.traders(tok(a), { limit: n(a.limit) })],
  [["dev", "token_dev", "dev_profile", "insights_dev", "get_dev", "get_dev_profile"], (a, c) => c.insights.dev(tok(a))],
  [["scores", "token_scores", "insights_scores", "get_scores", "get_coin_scores"], (a, c) => c.insights.scores(tok(a))],
  [["wallet", "wallet_profile", "wallet_insights", "insights_wallet", "get_wallet"], (a, c) => c.insights.wallet(chainOf(a), need(a.address ?? a.wallet, "address"))],
  [["insights_status"], (_a, c) => c.insights.status()],
  [["trending", "trending_tokens", "insights_trending", "get_trending"], (a, c) => c.insights.trending({ chain: chainOf(a), interval: s(a.interval) as never, order: s(a.order) as never })],
  [["hot", "hot_tokens", "insights_hot"], (a, c) => c.insights.hot({ chain: chainOf(a), interval: s(a.interval) as never })],
  [["feed_kol", "kol_feed", "kol_trades"], (a, c) => c.feeds.kol({ chain: chainOf(a), side: s(a.side) as never })],
  [["feed_smart", "smart_feed", "smart_money", "smart_trades"], (a, c) => c.feeds.smart({ chain: chainOf(a), side: s(a.side) as never })],
  [["feed_signals", "signals", "signal_feed"], (a, c) => c.feeds.signals({ chain: chainOf(a) })],
  [["feed", "get_feed"], (a, c) => {
    const kind = s(a.kind) ?? "kol";
    return kind === "signals" ? c.feeds.signals({ chain: chainOf(a) }) : kind === "smart" ? c.feeds.smart({ chain: chainOf(a), side: s(a.side) as never }) : c.feeds.kol({ chain: chainOf(a), side: s(a.side) as never });
  }],
];

const LOCAL = new Map<string, ToolHandler>();
for (const [names, h] of HANDLERS) for (const name of names) LOCAL.set(name, h);

/** "claudia_token" / "claudia.token" / "token" → "token". */
export const normalizeToolName = (name: string) => name.toLowerCase().replace(/^claudia[_.-]/, "").replace(/[.-]/g, "_");

export interface ToolExecutorOptions {
  client: ClaudiaClient;
  /** Extra / replacement handlers by tool name (exact name or normalized). */
  handlers?: Record<string, ToolHandler>;
  /** How unknown tools reach the online MCP. `false` turns forwarding off (unknown tools throw). */
  mcp?: false | Omit<McpHttpOptions, "server" | "url">;
}

export interface ToolExecutor {
  /** Runs a tool and returns its result (an object for local tools, text for forwarded ones). */
  call(name: string, args?: ToolArgs, def?: Pick<CatalogTool, "server">): Promise<unknown>;
  /** Whether the tool runs locally (true) or is forwarded to the online MCP (false). */
  isLocal(name: string): boolean;
  close(): Promise<void>;
}

interface CatalogRuntime {
  isDataHandler?(name: string): boolean;
  runDataTool?(name: string, args: Record<string, unknown> | undefined, ctx: { get(path: string, query?: Record<string, unknown>): Promise<unknown>; baseUrl: string }): Promise<{ text: string; structured?: unknown; isError?: boolean }>;
}
let runtimeP: Promise<CatalogRuntime | null> | undefined;
/** The catalog's own data-tool implementations (same output as the MCP servers), when this build ships them. */
function catalogRuntime(): Promise<CatalogRuntime | null> {
  runtimeP ??= (async () => {
    try {
      const spec = "./tools/index.js";
      const mod = (await import(/* @vite-ignore */ spec)) as CatalogRuntime;
      return typeof mod.runDataTool === "function" && typeof mod.isDataHandler === "function" ? mod : null;
    } catch {
      return null;
    }
  })();
  return runtimeP;
}

export function createToolExecutor(opts: ToolExecutorOptions): ToolExecutor {
  const client = opts.client;
  const extra = new Map<string, ToolHandler>();
  for (const [k, v] of Object.entries(opts.handlers ?? {})) extra.set(k, v), extra.set(normalizeToolName(k), v);
  const remotes = new Map<string, McpHttpClient>();
  const find = (name: string) => extra.get(name) ?? extra.get(normalizeToolName(name)) ?? LOCAL.get(normalizeToolName(name));
  const remote = (server: "data" | "trade") => {
    if (opts.mcp === false) return null;
    let r = remotes.get(server);
    if (!r) remotes.set(server, (r = new McpHttpClient({ baseUrl: client.baseUrl, ...(opts.mcp ?? {}), server })));
    return r;
  };
  return {
    isLocal: (name) => !!find(name),
    async call(name, args = {}, def) {
      const own = extra.get(name) ?? extra.get(normalizeToolName(name));
      if (own) return own(args, client);
      // Prefer the catalog's shared implementation: identical answers to the MCP servers (data age, quoted text).
      const rt = await catalogRuntime();
      if (rt?.isDataHandler?.(name) && rt.runDataTool) {
        const out = await rt.runDataTool(name, args, { get: (path, query) => client.get(path, query as never), baseUrl: client.baseUrl });
        if (out.isError) throw new ClaudiaConfigError("tool_error", out.text || `Tool ${name} failed`);
        return out.text;
      }
      const h = find(name);
      if (h) return h(args, client);
      const server = def?.server === "trade" ? "trade" : "data";
      const r = remote(server);
      if (!r) throw new ClaudiaConfigError("unknown_tool", `No local handler for tool "${name}"`);
      const res = await r.callTool(name, args);
      const text = mcpResultText(res);
      if (res.isError) throw new ClaudiaConfigError("tool_error", text || `Tool ${name} failed`);
      return res.structuredContent ?? text;
    },
    async close() {
      await Promise.all([...remotes.values()].map((r) => r.close()));
    },
  };
}

/** Tool output as a string for models (JSON for objects, trimmed to `max` characters). */
export function toolOutputText(v: unknown, max = 20_000): string {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > max ? `${t.slice(0, max)}… (truncated)` : t;
}
