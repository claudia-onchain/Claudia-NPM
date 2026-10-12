// Function-calling definitions for model APIs, built from the same catalog as the MCP servers so they never drift.
//
//   toOpenAITools()      Chat Completions: [{ type: "function", function: { name, description, parameters } }]
//                        ({ api: "responses" } → Responses API: [{ type: "function", name, description, parameters, strict: false }])
//   toAnthropicTools()   Messages API: [{ name, description, input_schema }]
//   toGeminiTools()      generateContent: { functionDeclarations: [{ name, description, parameters }] } (OpenAPI subset)
//
// Executing the calls is up to you: call the matching Claudia endpoint, or point the model at the MCP server instead.
import { TOOLS } from "./catalog.js";
import type { JSONSchema, ToolDef } from "./types.js";

export type ToolFilter = (t: ToolDef) => boolean;

/** Default filter: tools that make sense without a local machine (data + trade). */
const online: ToolFilter = (t) => t.server !== "local";

function pick(f?: ToolFilter): ToolDef[] {
  return TOOLS.filter(f ?? online);
}

export function toOpenAITools(f?: ToolFilter, opts: { api?: "chat" | "responses" } = {}): unknown[] {
  return pick(f).map((t) =>
    opts.api === "responses"
      ? { type: "function", name: t.name, description: t.description, parameters: t.input, strict: false }
      : { type: "function", function: { name: t.name, description: t.description, parameters: t.input } },
  );
}

export function toAnthropicTools(f?: ToolFilter): unknown[] {
  return pick(f).map((t) => ({ name: t.name, description: t.description, input_schema: t.input }));
}

const GEMINI_KEYS = new Set(["type", "description", "enum", "properties", "required", "items", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "pattern", "format", "nullable", "default"]);

/** Gemini's `parameters` is an OpenAPI 3.0 subset: drop keywords it rejects and turn ["string","null"] into nullable. */
function geminiSchema(s: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!GEMINI_KEYS.has(k)) continue;
    if (k === "type" && Array.isArray(v)) {
      const t = v.filter((x) => x !== "null");
      out.type = t[0] ?? "string";
      if (t.length !== v.length) out.nullable = true;
    } else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, JSONSchema>).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    } else if (k === "items" && v && typeof v === "object") {
      out.items = geminiSchema(v as JSONSchema);
    } else out[k] = v;
  }
  return out;
}

export function toGeminiTools(f?: ToolFilter): { functionDeclarations: unknown[] } {
  return {
    functionDeclarations: pick(f).map((t) => {
      const params = geminiSchema(t.input);
      const empty = !params.properties || !Object.keys(params.properties as object).length;
      return { name: t.name, description: t.description, ...(empty ? {} : { parameters: params }) };
    }),
  };
}
