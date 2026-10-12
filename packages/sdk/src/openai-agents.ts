// @useclaudia/sdk/openai-agents — Claudia tools for the OpenAI Agents SDK (@openai/agents; checked against 0.19).
//
//   import { Agent, run } from "@openai/agents";
//   import { claudiaTools } from "@useclaudia/sdk/openai-agents";
//   const agent = new Agent({ name: "scout", instructions: "…", tools: await claudiaTools() });
//   await run(agent, "What are KOLs buying right now?");
//
// Or use hostedMcpTool / MCPServerStreamableHttp with https://useclaudia.xyz/mcp/data (see README).
import { isReadOnly, prepare, peer, type AdapterOptions } from "./adapter-common.js";

interface OaModule {
  tool: (def: { name: string; description: string; parameters: unknown; strict: boolean; needsApproval?: boolean; execute: (input: unknown) => Promise<string> }) => unknown;
}

export interface OpenAIAgentsToolsOptions extends AdapterOptions {
  /** Pass `{ tool }` from "@openai/agents" yourself. */
  agents?: OaModule;
}

/** Function tools (non-strict JSON Schema). Tools that change something ask for approval (`needsApproval`). */
export async function claudiaTools(opts: OpenAIAgentsToolsOptions = {}): Promise<unknown[]> {
  const oa = opts.agents ?? (await peer<OaModule>("@openai/agents", "@openai/agents"));
  const p = await prepare(opts);
  return p.defs.map((def) =>
    oa.tool({ name: def.name, description: def.description, parameters: def.input, strict: false, needsApproval: !isReadOnly(def), execute: (input) => p.run(def, input) }),
  );
}

export type { AdapterOptions };
