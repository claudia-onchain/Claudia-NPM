// Shared plumbing for the framework adapters (@useclaudia/sdk/ai, /langchain, /openai-agents).
import { ClaudiaClient, type ClaudiaClientOptions } from "./client.js";
import { ClaudiaConfigError } from "./errors.js";
import { createToolExecutor, loadCatalog, toolOutputText, type CatalogTool, type ToolExecutor, type ToolExecutorOptions } from "./exec.js";

export interface AdapterOptions {
  /** A client to use (default: a new public client, or one built from `clientOptions`). */
  client?: ClaudiaClient;
  clientOptions?: ClaudiaClientOptions;
  /** Tool definitions (default: the catalog from `@useclaudia/sdk/tools`). */
  tools?: CatalogTool[];
  /** Pick tools. Default: read-only tools of the data server. */
  filter?: (t: CatalogTool) => boolean;
  /** Include tools that change something (post, prepare trade/launch). They're forwarded to the online MCP and need an OAuth token. Default false. */
  includeWrites?: boolean;
  /** Extra / replacement handlers, or how unknown tools reach the online MCP (see createToolExecutor). */
  handlers?: ToolExecutorOptions["handlers"];
  mcp?: ToolExecutorOptions["mcp"];
  /** Max characters of tool output handed back to the model (default 20 000). */
  maxOutputChars?: number;
}

export interface PreparedTools {
  defs: CatalogTool[];
  executor: ToolExecutor;
  run: (def: CatalogTool, args: unknown) => Promise<string>;
}

export const isReadOnly = (t: CatalogTool) => t.annotations?.readOnlyHint !== false;

export async function prepare(opts: AdapterOptions): Promise<PreparedTools> {
  const client = opts.client ?? new ClaudiaClient(opts.clientOptions);
  const all = opts.tools ?? (await loadCatalog());
  const filter = opts.filter ?? ((t: CatalogTool) => t.server !== "local" && (opts.includeWrites || isReadOnly(t)));
  const defs = all.filter(filter);
  const executor = createToolExecutor({ client, handlers: opts.handlers, mcp: opts.mcp });
  const max = opts.maxOutputChars ?? 20_000;
  return {
    defs,
    executor,
    run: async (def, args) => toolOutputText(await executor.call(def.name, (args ?? {}) as Record<string, unknown>, def), max),
  };
}

/** Dynamic import of an optional peer dependency with a clear message when it's missing. */
export async function peer<T>(name: string, install: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ name)) as T;
  } catch (e) {
    throw new ClaudiaConfigError("missing_peer", `This adapter needs ${install} (npm i ${install}). ${(e as Error).message.split("\n")[0]}`);
  }
}
