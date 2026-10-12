// claudia-mcp settings: environment + ~/.claudia (same home the CLI writes). 0.1 variables keep working.
import type { Caps, ClaudiaHome } from "@useclaudia/sdk/node";

export type ServerChoice = "data" | "trade" | "local" | "all";

export interface McpSettings {
  /** CLAUDIA_MCP_ALLOW_TRADES=true: quote / prepare_trade / prepare_launch with the agent wallet. */
  allowTrades: boolean;
  /** CLAUDIA_MCP_READ_ONLY=true: no post_message, no trading, no media jobs, no drafts. */
  readOnly: boolean;
  caps: Caps;
  /** Media jobs estimated above this many USD wait for a human to approve them in Claudia Local or the CLI. */
  approveAboveUsd: number;
  /** Daily media spend ceiling, USD. */
  mediaPerDayUsd: number;
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
const numEnv = (v: string | undefined, def: number, allowZero = false) => {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && (n > 0 || (allowZero && n === 0)) ? n : def;
};

export function settingsFrom(env: NodeJS.ProcessEnv, home: ClaudiaHome): McpSettings {
  const local = home.config().caps;
  return {
    allowTrades: truthy(env.CLAUDIA_MCP_ALLOW_TRADES),
    readOnly: truthy(env.CLAUDIA_MCP_READ_ONLY),
    // The strictest of the MCP caps and the CLI caps in ~/.claudia wins.
    caps: {
      maxSolPerTrade: Math.min(numEnv(env.CLAUDIA_MCP_MAX_SOL_PER_TRADE, 0.05), local.maxSolPerTrade),
      maxSolPerDay: Math.min(numEnv(env.CLAUDIA_MCP_MAX_SOL_PER_DAY, 0.2), local.maxSolPerDay),
      maxEthPerTrade: Math.min(numEnv(env.CLAUDIA_MCP_MAX_ETH_PER_TRADE, 0.01), local.maxEthPerTrade),
      maxEthPerDay: Math.min(numEnv(env.CLAUDIA_MCP_MAX_ETH_PER_DAY, 0.04), local.maxEthPerDay),
    },
    approveAboveUsd: numEnv(env.CLAUDIA_MCP_APPROVE_ABOVE_USD, 0, true),
    mediaPerDayUsd: numEnv(env.CLAUDIA_MCP_MEDIA_PER_DAY_USD, 5),
  };
}
