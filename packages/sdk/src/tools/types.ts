// Types for Claudia's tool catalog: one definition per tool, shared by the local MCP server (@useclaudia/mcp), the
// online MCP server on useclaudia.xyz (a generated copy lives in DexPumpzip/shared/mcpCatalog.ts) and the
// function-calling converters (OpenAI, Anthropic, Gemini).

/** A JSON Schema (2020-12 subset: the keywords every MCP client and model provider understands). */
export type JSONSchema = {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null" | ("string" | "number" | "integer" | "boolean" | "array" | "object" | "null")[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: (string | number | boolean)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  additionalProperties?: boolean | JSONSchema;
  [k: string]: unknown;
};

/** Which server exposes the tool: the read-only Data server, the Trade server, or only the local stdio/HTTP server. */
export type ToolServer = "data" | "trade" | "local";

/** OAuth scopes on useclaudia.xyz (online) plus the local-only capability groups. */
export type ToolScope = "read" | "thread:write" | "trade:quote" | "trade:prepare" | "launch" | "media" | "social";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  /** snake_case, stable: never rename a published tool. */
  name: string;
  title: string;
  /** Short, for the model. */
  description: string;
  server: ToolServer;
  input: JSONSchema;
  output?: JSONSchema;
  annotations: ToolAnnotations;
  scope?: ToolScope;
  /** MCP Apps UI resource rendered for this tool's result (e.g. "ui://claudia/coin-card"). */
  ui?: string;
  /** The tool acts for a signed-in user (online: needs a Bearer token even though it only reads). */
  needsUser?: boolean;
  /** Ask the user before every call, even in auto-approve modes (emitted as `_meta["anthropic/requiresUserInteraction"]`). */
  requiresUserInteraction?: boolean;
}

export interface PromptArg {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  args: PromptArg[];
  /** User message with {{arg}} placeholders; `{{#arg}}…{{/arg}}` keeps a block only when the arg is set. */
  template: string;
  /** Servers that offer the prompt. */
  servers: ToolServer[];
}

export interface ResourceDef {
  /** A fixed URI ("claudia://watchlist") or an RFC 6570 level-1 template ("claudia://token/{mint}"). */
  uri: string;
  template: boolean;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  servers: ToolServer[];
  needsUser?: boolean;
}

export interface UiResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  /** MCP Apps HTML profile. */
  mimeType: "text/html;profile=mcp-app";
  html: string;
  servers: ToolServer[];
}
