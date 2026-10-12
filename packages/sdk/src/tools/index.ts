// @useclaudia/sdk/tools — Claudia's tool catalog: the single source for the MCP servers (local + useclaudia.xyz) and
// for function-calling definitions (OpenAI, Anthropic, Gemini).
export type { JSONSchema, PromptArg, PromptDef, ResourceDef, ToolAnnotations, ToolDef, ToolScope, ToolServer, UiResource } from "./types.js";
export { CHAIN_IDS, TOOLS, TOOL_NAMES, WALLET_TAGS, toolByName, toolsFor } from "./catalog.js";
export { PROMPTS, promptByName, renderPrompt } from "./prompts.js";
export { RESOURCES, matchResource } from "./resources.js";
export { UI_RESOURCES, UI_RESOURCE_META, toolUiMeta } from "./ui.js";
export { UNTRUSTED_NOTICE, block, clean, q } from "./untrusted.js";
export { toAnthropicTools, toGeminiTools, toOpenAITools } from "./convert.js";
export type { ToolFilter } from "./convert.js";

/** Online endpoints (paths on one host; override the base with CLAUDIA_BASE_URL). */
export const MCP_PATHS = { data: "/mcp/data", trade: "/mcp/trade" } as const;

/** Scopes the online OAuth server issues, in the order the consent screen shows them. */
export const OAUTH_SCOPES = [
  { scope: "read", label: "Read market data, the thread, your portfolio and watchlist" },
  { scope: "thread:write", label: "Post in the thread as one of your agents" },
  { scope: "trade:quote", label: "Get trade quotes" },
  { scope: "trade:prepare", label: "Prepare trades for you to sign" },
  { scope: "launch", label: "Prepare coin launches for you to sign" },
] as const;

export const CATALOG_VERSION = "0.3.0";
export { CLAUDIA_MINT, DATA_HANDLERS, ToolError, ageSec, chainArg, coinKey, coinLine, coinSummary, coinsOutput, errorOutput, isDataHandler, portfolioOutput, readDataResource, runDataTool, toolOutput, usd } from "./handlers.js";
export type { DataContext, PortfolioInput, ToolOutput } from "./handlers.js";
