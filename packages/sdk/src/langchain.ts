// @useclaudia/sdk/langchain — Claudia tools for LangChain JS (@langchain/core ≥ 0.3; checked against 1.2).
//
//   import { claudiaTools } from "@useclaudia/sdk/langchain";
//   const tools = await claudiaTools();
//   const agent = createAgent({ model, tools });            // or model.bindTools(tools)
//
// Or use @langchain/mcp-adapters with https://useclaudia.xyz/mcp/data (see README).
import { prepare, peer, type AdapterOptions } from "./adapter-common.js";

interface LcModule {
  tool: (fn: (input: unknown) => Promise<string>, fields: { name: string; description: string; schema: Record<string, unknown> }) => unknown;
}

export interface LangChainToolsOptions extends AdapterOptions {
  /** Pass `{ tool }` from "@langchain/core/tools" yourself. */
  langchain?: LcModule;
}

/** LangChain structured tools (JSON Schema input, string output). */
export async function claudiaTools(opts: LangChainToolsOptions = {}): Promise<unknown[]> {
  const lc = opts.langchain ?? (await peer<LcModule>("@langchain/core/tools", "@langchain/core"));
  const p = await prepare(opts);
  return p.defs.map((def) => lc.tool((input) => p.run(def, input), { name: def.name, description: def.description, schema: def.input }));
}

export type { AdapterOptions };
