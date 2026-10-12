// @useclaudia/sdk/ai — Claudia tools for the Vercel AI SDK (`ai` v5+; checked against v7).
//
//   import { generateText, isStepCount } from "ai";
//   import { claudiaTools } from "@useclaudia/sdk/ai";
//   const tools = await claudiaTools();
//   await generateText({ model, tools, stopWhen: isStepCount(8), prompt: "Is sol:<mint> safe? Check holders and dev." });
//
// Or skip this and point the AI SDK's MCP client at https://useclaudia.xyz/mcp/data (see README).
import { prepare, peer, type AdapterOptions } from "./adapter-common.js";

interface AiModule {
  tool: (def: { description?: string; inputSchema: unknown; execute: (input: unknown, opts: unknown) => Promise<unknown> }) => unknown;
  jsonSchema: (schema: Record<string, unknown>) => unknown;
}

export interface AiToolsOptions extends AdapterOptions {
  /** Pass `{ tool, jsonSchema }` from "ai" yourself (bundlers / no dynamic import). */
  ai?: AiModule;
}

/** An object of AI SDK tools keyed by name, ready for generateText / streamText / Agent. */
export async function claudiaTools(opts: AiToolsOptions = {}): Promise<Record<string, unknown>> {
  const ai = opts.ai ?? (await peer<AiModule>("ai", "ai"));
  const p = await prepare(opts);
  const out: Record<string, unknown> = {};
  for (const def of p.defs) {
    out[def.name] = ai.tool({ description: def.description, inputSchema: ai.jsonSchema(def.input), execute: (input) => p.run(def, input) });
  }
  return out;
}

export type { AdapterOptions };
